// ═══════════════════════════════════════════════════════════
// NIFTY Trader — Cloud Engine v3
// Runs on Oracle VM as a systemd service.
// Handles BOTH manual trades (from 942 app) AND fully
// automated multi-slot strategies (from Auto Strategy module).
// Phone only needed for morning token push — then switch off.
//
// Port: 8081  (Caddy routes /engine/* → localhost:8081)
//
// MANUAL TRADE ENDPOINTS:
//   POST /engine/token       — push Upstox token from app
//   POST /engine/arm         — arm a manual strategy
//   GET  /engine/status      — poll live trade status
//   POST /engine/disarm      — cancel armed strategy
//   POST /engine/squareoff   — manual square off
//
// AUTO STRATEGY ENDPOINTS:
//   POST /engine/slots       — push all strategy slots from app
//   GET  /engine/slots/status— poll all slot statuses
//   POST /engine/slots/clear — clear slots and cancel timers
//   GET  /engine/testbalance — debug: test balance API response
// ═══════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');
const fs    = require('fs');

const PORT        = 8081;
const UPSTOX_HOST = 'api.upstox.com';
const STATE_FILE  = '/home/ubuntu/engine-state.json';
const SLOTS_FILE  = '/home/ubuntu/engine-slots.json';
const BT_LOG_FILE = '/home/ubuntu/bt-logs.json';   // daily BT simulation results

// ── Manual trade state ───────────────────────────────────
const ST = {
  token: null, armed: false,
  status: 'idle',  // idle armed ready placed live exiting done error
  config: null, instr: null,
  entryPrice: null, slLevel: null, tgtLevel: null,
  spotPrice: null, optionPrice: null, pnl: null,
  entryOrderId: null, exitOrderId: null, log: [],
  _entryTimer: null, _exitTimer: null, _monitorIvl: null,
};

// ── Auto-strategy slot state ─────────────────────────────
let AUTO_SLOTS   = [];           // slot definitions from app
const SLOT_STATUS = {};          // slotId → 'waiting'|'checking'|'placed'|'skipped'|'error'|'passed'
const SLOT_TIMERS = {};          // slotId → setTimeout handle

// ══════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ══════════════════════════════════════════════════════════
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      status: ST.status, armed: ST.armed, config: ST.config, instr: ST.instr,
      entryPrice: ST.entryPrice, slLevel: ST.slLevel, tgtLevel: ST.tgtLevel,
      entryOrderId: ST.entryOrderId, exitOrderId: ST.exitOrderId,
      optionPrice: ST.optionPrice, spotPrice: ST.spotPrice, pnl: ST.pnl,
      exitTs: ST.config?.exitTs || null, log: ST.log.slice(0, 50),
    }));
  } catch(e) { console.error('saveState:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(ST, saved);
    lg(`📂 Trade state loaded: ${ST.status}`, 'i');
    if (ST.status === 'live' && ST.instr?.key) {
      lg('📂 Active trade restored — resuming monitor', 's');
      startMonitor();
      const msExit = (saved.exitTs || 0) - Date.now();
      if (msExit > 0) {
        ST._exitTimer = setTimeout(async () => {
          if (ST.status === 'live') { lg('⏰ Auto-exit (restored)', 'w'); await doSquareOff('Auto-exit'); }
        }, msExit);
        lg(`⏱ Exit timer restored (${Math.floor(msExit/1000)}s)`, 'i');
      } else if (saved.exitTs) {
        lg('⚠️ Exit time already passed — squaring off now', 'w');
        doSquareOff('Auto-exit (recovered)');
      }
    } else if (ST.status === 'live' && !ST.instr?.key) {
      lg('⚠️ Trade was live but instrument lost — marking error. Check Upstox!', 'e');
      ST.status = 'error';
    }
  } catch(e) { console.error('loadState:', e.message); }
}

function clearStateFile() { try { fs.unlinkSync(STATE_FILE); } catch(_) {} }

function saveSlots() {
  try { fs.writeFileSync(SLOTS_FILE, JSON.stringify(AUTO_SLOTS)); } catch(e) {}
}

function loadSlots() {
  try {
    if (!fs.existsSync(SLOTS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
    if (Array.isArray(saved) && saved.length) {
      AUTO_SLOTS = saved;
      lg(`📂 ${AUTO_SLOTS.length} auto-strategy slot(s) restored`, 'i');
      scheduleAllSlots();
    }
  } catch(e) { console.error('loadSlots:', e.message); }
}

// ══════════════════════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════════════════════
function lg(msg, type = 'i') {
  // Store IST time (UTC+5:30) so logs are readable without conversion
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const t = now.toUTCString().slice(17, 25); // HH:MM:SS from UTC representation of IST
  ST.log.unshift({ t, msg, type });
  if (ST.log.length > 150) ST.log.pop();
  console.log(`[${t} IST][${type}] ${msg}`);
}

// ══════════════════════════════════════════════════════════
// UPSTOX API  (direct — VM IP is whitelisted)
// ══════════════════════════════════════════════════════════
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function upstox(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const hdrs = {
      'Accept': 'application/json',
      'Api-Version': '2.0',
      'Authorization': `Bearer ${ST.token}`,
    };
    const bs = body ? JSON.stringify(body) : null;
    if (bs) { hdrs['Content-Type'] = 'application/json'; hdrs['Content-Length'] = Buffer.byteLength(bs); }
    const req = https.request({ hostname: UPSTOX_HOST, port: 443, path, method, headers: hdrs }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400)
            reject(new Error(json?.errors?.[0]?.message || json?.message || `HTTP ${res.statusCode}`));
          else resolve(json);
        } catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    if (bs) req.write(bs);
    req.end();
  });
}

// ── BT log persistence ───────────────────────────────────
function saveBtLogs(logs) {
  try { fs.writeFileSync(BT_LOG_FILE, JSON.stringify(logs, null, 2)); } catch(e) { lg('BT log save failed: ' + e.message, 'e'); }
}
function loadBtLogs() {
  try {
    if (!fs.existsSync(BT_LOG_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(BT_LOG_FILE, 'utf8'));
    // 90-day retention
    const cutoff = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    for (const d of Object.keys(data)) { if (d < cutoff) delete data[d]; }
    return data;
  } catch(_) { return {}; }
}

// ── BT: fetch 1-min candles for a date ──────────────────
async function btGetCandles(dateStr) {
  const d    = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const to   = d.toISOString().slice(0, 10);
  const key  = 'NSE_INDEX%7CNifty%2050';
  const path = `/v2/historical-candle/${key}/1minute/${to}/${dateStr}`;
  const resp = await upstox(path);
  const raw  = resp?.data?.candles || [];
  return raw.map(row => {
    const ist = new Date(new Date(row[0]).getTime() + 5.5*3600000);
    return {
      time:  `${String(ist.getUTCHours()).padStart(2,'0')}:${String(ist.getUTCMinutes()).padStart(2,'0')}`,
      open:row[1], high:row[2], low:row[3], close:row[4]
    };
  }).sort((a,b) => a.time.localeCompare(b.time));
}

// ── BT: compute SMA/EMA from candle array ───────────────
function btCalcIndicator(name, closes) {
  const m = name.match(/^(sma|ema)(\d+)$/);
  if (!m || !closes.length) return null;
  const period = parseInt(m[2]);
  const win    = closes.slice(-period);
  if (m[1] === 'sma') return win.reduce((a,b)=>a+b,0)/win.length;
  const k=2/(period+1); let e=win[0];
  for (let i=1;i<win.length;i++) e=win[i]*k+e*(1-k);
  return e;
}

// ── BT: simulate a single slot on candle array ──────────
function btSimSlot(slot, candles) {
  const entryHHMM = slot.entryTime.slice(0,5);
  const exitHHMM  = slot.exitTime.slice(0,5);
  const sortedTimes = candles.map(c=>c.time);
  const candleMap   = {};
  candles.forEach(c => { candleMap[c.time] = c; });

  // Evaluate condition sets
  let direction = null;
  for (const cs of (slot.conditionSets||[])) {
    if (!cs.enabled) continue;
    let allPass = true;
    for (const cond of (cs.conditions||[])) {
      if (!cond.enabled) continue;
      const lt = cond.leftTime.slice(0,5);
      const lc = candleMap[lt];
      if (!lc) { allPass=false; break; }
      const lv = lc[cond.leftField] || lc.close;
      let rv;
      if (cond.rightType === 'candle') {
        const rc = candleMap[cond.rightTime.slice(0,5)];
        if (!rc) { allPass=false; break; }
        rv = (rc[cond.rightField]||rc.close) + (cond.offsetPts||0);
      } else if (cond.rightType === 'indicator') {
        const cls = candles.filter(c=>c.time<=lt).map(c=>c.close);
        const raw = btCalcIndicator(cond.rightField, cls);
        if (raw === null) { allPass=false; break; }
        rv = raw + (cond.offsetPts||0);
      } else {
        rv = (cond.rightValue||0) + (cond.offsetPts||0);
      }
      const op = cond.op;
      const pass = op==='>'?lv>rv:op==='<'?lv<rv:op==='>='?lv>=rv:op==='<='?lv<=rv:false;
      if (!pass) { allPass=false; break; }
    }
    if (allPass && cs.direction) { direction=cs.direction; break; }
  }

  if (!direction) return { fired:false, slot:slot.name, entryTime:entryHHMM, direction:null, result:'PASS', pnl_pts:0, reason:'No signal' };

  const ec = candleMap[entryHHMM];
  if (!ec) return { fired:false, slot:slot.name, entryTime:entryHHMM, direction, result:'NO_DATA', pnl_pts:0, reason:'No candle at entry' };

  const ep      = ec.open;
  const isLong  = direction === 'CE';
  const tpTgt   = ep + (isLong ?  10 : -10);
  const slTgt   = ep + (isLong ? -10 :  10);
  const optTP   = slot.tgt || 5;
  const optSL   = slot.sl  || 5;
  const window  = candles.filter(c => c.time >= entryHHMM && c.time <= exitHHMM);

  let result='TIMEOUT', exitPrice=null, exitTime=exitHHMM, pnl_pts=0, reason='';
  for (const c of window.slice(1)) {
    if (isLong) {
      if (c.low  <= slTgt) { result='SL'; exitPrice=slTgt; exitTime=c.time; pnl_pts=-optSL; reason=`SL@${slTgt.toFixed(0)}`; break; }
      if (c.high >= tpTgt) { result='TP'; exitPrice=tpTgt; exitTime=c.time; pnl_pts=+optTP; reason=`TP@${tpTgt.toFixed(0)}`; break; }
    } else {
      if (c.high >= slTgt) { result='SL'; exitPrice=slTgt; exitTime=c.time; pnl_pts=-optSL; reason=`SL@${slTgt.toFixed(0)}`; break; }
      if (c.low  <= tpTgt) { result='TP'; exitPrice=tpTgt; exitTime=c.time; pnl_pts=+optTP; reason=`TP@${tpTgt.toFixed(0)}`; break; }
    }
  }
  if (result==='TIMEOUT') {
    const lc  = window[window.length-1];
    exitPrice = lc?.close || ep;
    const mv  = isLong ? (exitPrice-ep) : (ep-exitPrice);
    pnl_pts   = Math.max(mv*0.5, -optSL);
    reason    = `Timeout@${exitPrice.toFixed(0)}`;
  }
  return { fired:true, slot:slot.name, direction, entryTime:entryHHMM,
           entryPrice:ep.toFixed(2), exitTime, exitPrice:exitPrice?.toFixed(2),
           result, pnl_pts:parseFloat(pnl_pts.toFixed(2)), reason };
}

// ── BT: run full simulation for a date ──────────────────
async function btRunForDate(dateStr) {
  if (!ST.token) throw new Error('No Upstox token');
  const candles = await btGetCandles(dateStr);
  if (!candles.length) throw new Error(`No candles for ${dateStr}`);
  const slots   = AUTO_SLOTS.length ? AUTO_SLOTS : [];  // use pushed slots
  const results = slots.map(s => btSimSlot(s, candles));
  const fired   = results.filter(r => r.fired);
  const wins    = fired.filter(r => r.result === 'TP').length;
  const totPnl  = fired.reduce((s,r) => s+r.pnl_pts, 0);
  return {
    date: dateStr, candles: candles.length, slots: results,
    summary: { totalPnl: parseFloat(totPnl.toFixed(2)), fired: fired.length,
               wins, wr: fired.length > 0 ? Math.round(wins/fired.length*100) : 0 }
  };
}

// ── BT: daily auto-run scheduler (fires at 15:32 IST) ───
function btScheduleDailyRun() {
  setInterval(async () => {
    if (!ST.token) return;
    const now  = new Date(Date.now() + 5.5*3600000);
    const hhmm = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
    if (hhmm !== '15:32') return;
    const dateStr = now.toISOString().slice(0,10);
    const logs    = loadBtLogs();
    if (logs[dateStr]) return;  // already ran today
    try {
      lg(`BT: auto-running simulation for ${dateStr}`, 'i');
      const result = await btRunForDate(dateStr);
      logs[dateStr] = result;
      saveBtLogs(logs);
      lg(`BT: simulation done — ${result.summary.fired} slots fired, P&L ${result.summary.totalPnl > 0 ? '+' : ''}${result.summary.totalPnl} pts`, 's');
    } catch(e) {
      lg(`BT: auto-run failed — ${e.message}`, 'e');
    }
  }, 60000);  // check every 60 seconds
}
// ══════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Convert IST time string "HH:MM:SS" → absolute UTC Unix timestamp
// VM runs in UTC — must treat all time strings as IST (UTC+5:30)
function timeStrToTs(timeStr) {
  const [h, m, s] = (timeStr || '').split(':').map(Number);
  const IST_MS = 5.5 * 60 * 60 * 1000;          // IST offset = UTC+5:30
  const nowIst  = new Date(Date.now() + IST_MS); // today's date in IST coordinates
  // Build: today's IST date at h:m:s IST, then subtract offset to get UTC ms
  return Date.UTC(
    nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(),
    h, m, s || 0
  ) - IST_MS;
}

// ══════════════════════════════════════════════════════════
// MARKET DATA
// ══════════════════════════════════════════════════════════
async function getNiftySpot() {
  const d = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
  const ltp = Object.values(d?.data || {})[0]?.last_price;
  if (!ltp) throw new Error('NIFTY spot unavailable');
  return parseFloat(ltp);
}

// Single batched call for spot + option LTP — avoids rate limiting
async function getSpotAndOptLTP(optInstrKey) {
  const keys = 'NSE_INDEX%7CNifty%2050,' + encodeURIComponent(optInstrKey);
  const d = await upstox(`/v2/market-quote/ltp?instrument_key=${keys}`);
  let spot = 0, optLTP = 0;
  for (const [k, v] of Object.entries(d?.data || {})) {
    if (k.startsWith('NSE_INDEX')) spot   = parseFloat(v?.last_price) || 0;
    else                           optLTP = parseFloat(v?.last_price) || 0;
  }
  return { spot, optLTP };
}

async function getLiveExpiry() {
  const key = encodeURIComponent('NSE_INDEX|Nifty 50');
  try {
    const d = await upstox(`/v2/option/chain?instrument_key=${key}`);
    const expiries = d?.data?.expiry_list || d?.data?.expiryList;
    if (Array.isArray(expiries) && expiries.length) {
      const today = localDateStr(new Date());
      const nearest = expiries.filter(e => e >= today).sort()[0];
      if (nearest) { lg(`📅 Expiry: ${nearest}`, 'i'); return nearest; }
    }
  } catch(_) {}
  const now = new Date(), day = now.getDay();
  const isTuOpen = day === 2 && (now.getHours() * 60 + now.getMinutes()) < 15 * 60 + 30;
  const ahead = isTuOpen ? 0 : ((2 - day + 7) % 7 || 7);
  const candidates = [];
  for (let i = 0; i <= 5; i++) {
    const d = new Date(now); d.setDate(now.getDate() + ahead - i);
    if (d.getDay() !== 0) candidates.push(localDateStr(d));
  }
  lg(`📅 Scanning: ${candidates.slice(0,3).join(', ')}`, 'i');
  for (const expiry of candidates) {
    try {
      const d = await upstox(`/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`);
      if (Array.isArray(d?.data) && d.data.length > 0) {
        lg(`📅 Confirmed: ${expiry} (${d.data.length} strikes)`, 's'); return expiry;
      }
    } catch(_) {}
  }
  return candidates[0];
}

async function findInstrument(expiry, strike, type) {
  const key = encodeURIComponent('NSE_INDEX|Nifty 50');
  const d = await upstox(`/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`);
  const chain = d?.data;
  if (!Array.isArray(chain) || !chain.length) throw new Error('Chain empty for ' + expiry);
  const row = chain.find(r => Math.round(r.strike_price) === strike);
  if (!row) throw new Error(`Strike ${strike} not found`);
  const side = type === 'CE' ? row.call_options : row.put_options;
  if (!side?.instrument_key) throw new Error(`${type} key missing`);
  return { key: side.instrument_key, ltp: parseFloat(side?.market_data?.ltp) || 0 };
}

// ══════════════════════════════════════════════════════════
// BALANCE (for auto-lots)
// ══════════════════════════════════════════════════════════
async function getAvailableFunds() {
  for (const ep of ['/v2/user/get-funds-and-margin', '/v2/user/get-funds-and-margin?segment=SEC']) {
    try {
      const d = await upstox(ep);
      const eq = d?.data?.equity || d?.data;
      const f = parseFloat(eq?.available_margin ?? eq?.available_cash ?? eq?.net ?? 0);
      if (f > 0) { lg(`💰 Balance: ₹${f.toFixed(0)}`, 's'); return f; }
    } catch(e) { lg(`Balance ${ep.split('?')[0]}: ${e.message}`, 'w'); }
  }
  throw new Error('Balance unavailable');
}

// ══════════════════════════════════════════════════════════
// ORDERS
// ══════════════════════════════════════════════════════════
// Upstox freeze limit is 1800 shares, but orders must be in whole lots.
// NIFTY lot = 65, so max per order = floor(1800/65)*65 = 27*65 = 1755
// BN lot = 30, so max per order = floor(1800/30)*30 = 60*30 = 1800
function getFreezeQty(instrKey, lotSize) {
  const UPSTOX_FREEZE = 1800;
  const ls = lotSize || 65;
  // Round down to nearest whole lot
  return Math.floor(UPSTOX_FREEZE / ls) * ls;
}

async function placeMarket(instrKey, txn, qty, productType, lotSize) {
  // productType: 'I' = MIS (intraday), 'D' = NRML (delivery/overnight)
  const product = productType === 'D' ? 'D' : 'I';
  const freeze  = getFreezeQty(instrKey, lotSize);

  // Split into chunks if qty exceeds freeze limit
  if (qty > freeze) {
    lg(`⚡ Order slicing: ${qty} qty > ${freeze} freeze limit — splitting into chunks`, 'w');
    const chunks = [];
    let remaining = qty;
    while (remaining > 0) {
      chunks.push(Math.min(remaining, freeze));
      remaining -= freeze;
    }
    lg(`⚡ Placing ${chunks.length} sliced orders: ${chunks.join(' + ')} = ${qty}`, 'i');
    const orderIds = [];
    for (const chunk of chunks) {
      const d = await upstox('/v2/order/place', 'POST', {
        quantity: chunk, product: product, validity: 'DAY', price: 0,
        tag: 'nifty_cloud', instrument_token: instrKey,
        order_type: 'MARKET', transaction_type: txn,
        disclosed_quantity: 0, trigger_price: 0, is_amo: false
      });
      const id = d?.data?.order_id;
      if (!id) throw new Error(`Slice order failed (chunk ${chunk})`);
      orderIds.push(id);
      lg(`⚡ Slice placed: ${id} (${chunk} qty)`, 'i');
      await sleep(500);
    }
    return orderIds[0];
  }

  // Normal single order
  const d = await upstox('/v2/order/place', 'POST', {
    quantity: qty, product: product, validity: 'DAY', price: 0,
    tag: 'nifty_cloud', instrument_token: instrKey,
    order_type: 'MARKET', transaction_type: txn,
    disclosed_quantity: 0, trigger_price: 0, is_amo: false
  });
  const id = d?.data?.order_id;
  if (!id) throw new Error('No order_id returned');
  return id;
}

async function waitFill(orderId, retries = 15) {
  for (let i = 0; i < retries; i++) {
    await sleep(3000);
    try {
      const d = await upstox(`/v2/order/details?order_id=${orderId}`);
      const o = d?.data;
      lg(`Order ${orderId}: ${o?.status}`, 'i');
      if (o?.status === 'complete') return parseFloat(o.average_price) || 0;
      if (['rejected','cancelled'].includes(o?.status))
        throw new Error(`Order ${o.status}: ${o.status_message || ''}`);
    } catch(e) { if (i === retries - 1) throw e; }
  }
  throw new Error('Not filled in 45s');
}

// ══════════════════════════════════════════════════════════
// MANUAL TRADE ENGINE
// ══════════════════════════════════════════════════════════
function clearTimers() {
  clearTimeout(ST._entryTimer); clearTimeout(ST._exitTimer);
  clearInterval(ST._monitorIvl);
  ST._entryTimer = ST._exitTimer = ST._monitorIvl = null;
}

async function onEntry() {
  if (!ST.armed || ST.status !== 'armed') return;
  lg('🚀 Entry — fetching market data…', 'i');
  ST.status = 'ready';
  const cfg = ST.config;
  try {
    const spot = await getNiftySpot();
    ST.spotPrice = spot;
    const atm    = Math.round(spot / cfg.step) * cfg.step;
    const strike = cfg.dir === 'CE' ? atm + cfg.otm * cfg.step : atm - cfg.otm * cfg.step;
    const expiry = await getLiveExpiry();
    lg(`Spot: ${spot.toFixed(2)} | ATM: ${atm} | Strike: ${strike}${cfg.dir} | Expiry: ${expiry}`, 'i');
    const { key, ltp } = await findInstrument(expiry, strike, cfg.dir);
    ST.instr = { key, strike, type: cfg.dir, expiry };
    ST.optionPrice = ltp;
    // Auto-lots
    if (cfg.autoLots) {
      try {
        const funds      = await getAvailableFunds();
        const pct        = cfg.deployPct || 90;
        const deployable = funds * pct / 100;
        const floor      = cfg.floorPremium || 0;
        // Use floor premium if set AND actual ltp is below floor
        const effectivePx = (floor > 0 && ltp < floor) ? floor : ltp;
        const costPerLot  = effectivePx * cfg.lotSize;
        if (costPerLot > 0) {
          const calcLots = Math.max(1, Math.floor(deployable / costPerLot));
          ST.config.lots = calcLots;
          if (floor > 0 && ltp < floor) {
            lg(`💰 Floor premium active: actual ₹${ltp} < floor ₹${floor} → using ₹${floor} for sizing`, 'w');
            lg(`💰 Deploy ${pct}%: ₹${deployable.toFixed(0)} ÷ (₹${floor}×${cfg.lotSize}) → ${calcLots} lot(s)`, 's');
          } else {
            lg(`💰 Deploy ${pct}%: ₹${deployable.toFixed(0)} | Cost/lot: ₹${costPerLot.toFixed(0)} → ${calcLots} lot(s)`, 's');
          }
        }
      } catch(e) { lg(`⚠️ Auto-lots failed: ${e.message} — using manual: ${cfg.lots} lot(s)`, 'w'); }
    }
    const qty = ST.config.lots * cfg.lotSize;
    ST.status = 'placed';
    const prodType = cfg.productType || 'I';  // D=NRML, I=MIS
    lg(`📤 BUY MARKET — ${strike}${cfg.dir} × ${qty} [${prodType==='D'?'NRML':'MIS'}]`, 'i');
    const orderId = await placeMarket(key, 'BUY', qty, prodType, cfg.lotSize);
    ST.entryOrderId = orderId;
    lg(`✅ Order placed: ${orderId}`, 's');
    const fillPx = await waitFill(orderId);
    ST.entryPrice = fillPx;
    ST.slLevel    = fillPx - cfg.sl;
    ST.tgtLevel   = fillPx + cfg.tgt;
    ST.status     = 'live';
    lg(`✅ Filled @ ₹${fillPx} | SL: ₹${ST.slLevel.toFixed(2)} | TGT: ₹${ST.tgtLevel.toFixed(2)}`, 's');
    saveState();
    startMonitor();
  } catch(e) {
    lg(`❌ Entry error: ${e.message}`, 'e');
    ST.status = 'error';
  }
}

function startMonitor() {
  clearInterval(ST._monitorIvl);
  ST._monitorIvl = setInterval(monitorTick, 1000); // 1s — batched LTP call = 60/min
  monitorTick();
}

async function monitorTick() {
  if (ST.status !== 'live') { clearInterval(ST._monitorIvl); return; }
  if (!ST.instr?.key) {
    lg('⚠️ Instrument lost — stopping monitor. Check Upstox!', 'e');
    clearInterval(ST._monitorIvl); ST.status = 'error'; return;
  }
  try {
    const { spot, optLTP } = await getSpotAndOptLTP(ST.instr.key);
    ST.spotPrice   = spot;
    ST.optionPrice = optLTP;
    if (ST.entryPrice !== null)
      ST.pnl = (optLTP - ST.entryPrice) * ST.config.lots * ST.config.lotSize;
    saveState();
    if (ST.entryPrice !== null) {
      if (optLTP <= ST.slLevel) {
        lg(`🛑 SL HIT — ₹${optLTP} ≤ ₹${ST.slLevel.toFixed(2)}`, 'e');
        await doSquareOff('SL hit');
      } else if (optLTP >= ST.tgtLevel) {
        lg(`🎯 TGT HIT — ₹${optLTP} ≥ ₹${ST.tgtLevel.toFixed(2)}`, 's');
        await doSquareOff('Target hit');
      }
    }
  } catch(e) { lg(`Monitor: ${e.message}`, 'w'); }
}

async function doSquareOff(reason) {
  if (!ST.instr) { lg('Nothing to square off', 'w'); return; }
  clearInterval(ST._monitorIvl);
  clearTimeout(ST._exitTimer);   // ← cancel exit timer to prevent double-sell
  ST._exitTimer = null;
  ST.status = 'exiting';
  const qty = ST.config.lots * ST.config.lotSize;
  try {
    const prodType = ST.config.productType || 'I';
    lg(`📤 Square off (${reason}) — SELL ${qty} [${prodType==='D'?'NRML':'MIS'}]`, 'i');
    const orderId = await placeMarket(ST.instr.key, 'SELL', qty, prodType, ST.config.lotSize);
    ST.exitOrderId = orderId;
    ST.status = 'done';
    ST.armed  = false;
    clearStateFile();  // clear immediately so restart doesn't re-trigger
    const sign = (ST.pnl || 0) >= 0 ? '+' : '';
    lg(`🏁 Trade closed. P&L: ${sign}₹${ST.pnl?.toFixed(0) || '?'}`, 's');
    clearStateFile();
  } catch(e) {
    lg(`❌ Square off FAILED: ${e.message}`, 'e');
    lg('⚠️ Manually square off in Upstox!', 'e');
    ST.status = 'live';
    startMonitor();
  }
}

// ══════════════════════════════════════════════════════════
// AUTO-STRATEGY ENGINE
// ══════════════════════════════════════════════════════════

// Candle field extractor
function fieldOf(c, f) {
  if (!c) return null;
  const { o, h, l, cl } = c;
  switch(f) {
    case 'open':      return o;
    case 'high':      return h;
    case 'low':       return l;
    case 'close':     return cl;
    case 'range':     return h - l;
    case 'body':      return Math.abs(cl - o);
    case 'mid':       return (h + l) / 2;
    case 'upperwick': return h - Math.max(o, cl);
    case 'lowerwick': return Math.min(o, cl) - l;
    default:          return null;
  }
}

function evalOp(l, op, r) {
  switch(op) {
    case '>':  return l > r;
    case '<':  return l < r;
    case '>=': return l >= r;
    case '<=': return l <= r;
    case '==': return Math.abs(l - r) < 0.5;
    default:   return false;
  }
}

// Indicator value (120-period SMA / EMA on close), computed from intraday candles
// Compute SMA/EMA for any period from candle map up to refTime.
// Returns null only if fewer than 2 candles available.
function indicatorValue(candleMap, refTime, name) {
  const closes = Object.keys(candleMap)
    .filter(t => t <= refTime)
    .sort()
    .map(t => candleMap[t].cl);
  if (closes.length < 2) return null;

  // Parse indicator name: sma20, sma50, sma120, ema20, ema50, ema120
  const m = name.match(/^(sma|ema)(\d+)$/);
  if (!m) return null;

  const type   = m[1];           // 'sma' or 'ema'
  const period = parseInt(m[2]); // 20, 50, 120 etc.
  const win    = closes.slice(-period);

  if (type === 'sma') {
    return win.reduce((a, b) => a + b, 0) / win.length;
  } else {
    const k = 2 / (period + 1);
    let ema = win[0];
    for (let i = 1; i < win.length; i++) ema = win[i] * k + ema * (1 - k);
    return ema;
  }
}

function evalCondition(cond, candleMap) {
  const lc = candleMap[cond.leftTime];
  if (!lc) return { result: null, reason: `No candle at ${cond.leftTime}` };
  const lv = fieldOf(lc, cond.leftField);
  let rv;
  if (cond.rightType === 'value') {
    rv = parseFloat(cond.rightValue || 0);
  } else if (cond.rightType === 'indicator') {
    rv = indicatorValue(candleMap, cond.leftTime, cond.rightField);
    if (rv === null) return { result: null, reason: `Indicator ${cond.rightField} not ready` };
  } else {
    const rc = candleMap[cond.rightTime];
    if (!rc) return { result: null, reason: `No candle at ${cond.rightTime}` };
    rv = fieldOf(rc, cond.rightField);
    if (rv === null) return { result: null, reason: 'Invalid right field' };
  }
  rv += parseFloat(cond.offsetPts || 0);
  return { result: evalOp(lv, cond.op, rv), lv, rv };
}

function evalConditionSet(set, candleMap) {
  const results = (set.conditions || []).filter(c => c.enabled).map(c => evalCondition(c, candleMap));
  if (!results.length) return false;
  return set.logic === 'ALL'
    ? results.every(r => r.result === true)
    : results.some(r => r.result === true);
}

// Returns first satisfied set → { trade, direction, setName } or { trade:false }
function evalSlotDirection(slot, candleMap) {
  for (const set of (slot.conditionSets || [])) {
    if (!set.enabled) continue;
    const pass = evalConditionSet(set, candleMap);
    if (pass) return { trade: true, direction: set.direction, setName: set.name || '?' };
  }
  return { trade: false };
}

// Fetch intraday 1-minute candles → map HH:MM → { o, h, l, cl }
async function fetchCandleMap() {
  const d = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%2050/1minute');
  const map = {};
  for (const row of (d?.data?.candles || [])) {
    // Convert timestamp to IST HH:MM
    // Upstox may return IST (+05:30) or UTC (+00:00) — handle both
    const ts  = String(row[0]);
    let hh, mm;
    // Try IST format: ...T09:15:00+05:30
    const istMatch = ts.match(/T(\d{2}):(\d{2}):\d{2}\+05:30/);
    if (istMatch) {
      hh = istMatch[1]; mm = istMatch[2];
    } else {
      // UTC format: convert to IST by adding 5h30m
      const dt  = new Date(ts);
      const ist = new Date(dt.getTime() + 5.5 * 3600000);
      hh = String(ist.getUTCHours()).padStart(2, '0');
      mm = String(ist.getUTCMinutes()).padStart(2, '0');
    }
    map[`${hh}:${mm}`] = { o: row[1], h: row[2], l: row[3], cl: row[4] };
  }
  return map;
}

// Clear all auto-slot timers
function clearAllSlotTimers() {
  Object.values(SLOT_TIMERS).forEach(t => clearTimeout(t));
  Object.keys(SLOT_TIMERS).forEach(k => delete SLOT_TIMERS[k]);
  Object.keys(SLOT_STATUS).forEach(k => delete SLOT_STATUS[k]);
}

// Schedule a single slot
function scheduleSlot(slot) {
  if (!slot.enabled) return;

  // Don't re-schedule a slot that already placed or errored this session
  const existingStatus = SLOT_STATUS[slot.id];
  if (existingStatus === 'placed' || existingStatus === 'error') {
    lg(`[Auto] "${slot.name}": already ${existingStatus} — skipping re-schedule`, 'i');
    return;
  }

  // ── Day-of-week filter ──────────────────────────────────────
  // dayFilter: [0=Mon,1=Tue,2=Wed,3=Thu,4=Fri] — slot fires only on these days
  // Converts to JS getUTCDay: Mon=1,Tue=2,Wed=3,Thu=4,Fri=5
  if (slot.dayFilter && slot.dayFilter.length > 0) {
    const ist = new Date(Date.now() + 5.5*3600000);
    const jsDay = ist.getUTCDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri
    const slotDow = jsDay === 0 ? -1 : jsDay - 1; // convert to 0=Mon..4=Fri
    if (!slot.dayFilter.includes(slotDow)) {
      lg(`[Auto] "${slot.name}": day filter — not active today`, 'i');
      SLOT_STATUS[slot.id] = 'passed';
      return;
    }
  }

  // ── Expiry day check ────────────────────────────────────────
  // skipOnExpiry: true → skip this slot on NF expiry days
  // NF expiry is permanently TUESDAY (since Sep 1 2025)
  if (slot.skipOnExpiry) {
    const ist = new Date(Date.now() + 5.5*3600000);
    const dow = ist.getUTCDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
    if (dow === 2) {  // Tuesday = NF expiry day
      lg(`[Auto] "${slot.name}": skipOnExpiry — skipping (Tuesday expiry day)`, 'w');
      SLOT_STATUS[slot.id] = 'passed';
      return;
    }
  }

  const entryTs = timeStrToTs(slot.entryTime);
  const ms = entryTs - Date.now();
  if (ms < -60000) { // more than 1 min past — skip
    lg(`[Auto] "${slot.name}": entry ${slot.entryTime} already passed`, 'w');
    SLOT_STATUS[slot.id] = 'passed';
    return;
  }
  const fireMs = Math.max(ms, 500);
  SLOT_STATUS[slot.id] = 'waiting';
  SLOT_TIMERS[slot.id] = setTimeout(() => executeAutoSlot(slot), fireMs);
  lg(`[Auto] "${slot.name}": scheduled at ${slot.entryTime} (${Math.floor(fireMs/1000)}s)`, 'i');
}

// Schedule all stored slots
function scheduleAllSlots() {
  clearAllSlotTimers();
  for (const slot of AUTO_SLOTS) scheduleSlot(slot);
  lg(`[Auto] ${AUTO_SLOTS.filter(s=>s.enabled).length} slot(s) scheduled`, 'i');
}

// Execute one slot at entry time
async function executeAutoSlot(slot) {
  // Guard: don't re-run a slot that already placed this session
  if (SLOT_STATUS[slot.id] === 'placed') {
    lg(`[Auto] "${slot.name}": already placed — ignoring re-trigger`, 'i');
    return;
  }

  lg(`[Auto] "${slot.name}": ⏱ entry time — fetching candles…`, 'i');
  SLOT_STATUS[slot.id] = 'checking';
  try {
    const candleMap = await fetchCandleMap();
    const keys = Object.keys(candleMap).sort();
    lg(`[Auto] "${slot.name}": ${keys.length} candles (${keys[0]}→${keys[keys.length-1]})`, 'i');

    // Log each set result
    for (const set of (slot.conditionSets || []).filter(s => s.enabled)) {
      const conds = (set.conditions || []).filter(c => c.enabled);
      const results = conds.map(c => ({ ...evalCondition(c, candleMap), cond: c }));
      const pass = set.logic === 'ALL'
        ? results.every(r => r.result === true)
        : results.some(r => r.result === true);
      lg(`[Auto] "${slot.name}"/"${set.name||'?'}" (${set.logic}): `
         + results.map(r => r.result ? '✅' : r.result === null ? '⚪' : '❌').join(' ')
         + ` → ${pass ? 'PASS → BUY '+set.direction : 'FAIL'}`, pass ? 's' : 'i');
    }

    const { trade, direction, setName } = evalSlotDirection(slot, candleMap);

    if (!trade) {
      lg(`[Auto] "${slot.name}": 🚫 No set satisfied — skip`, 'e');
      SLOT_STATUS[slot.id] = 'skipped';
      return;
    }

    lg(`[Auto] "${slot.name}": ✅ "${setName}" → BUY ${direction}`, 's');

    // Check if engine is already in a trade
    if (['live', 'placed', 'placing', 'exiting'].includes(ST.status)) {
      lg(`[Auto] "${slot.name}": ⚠️ engine busy (${ST.status}) — slot skipped`, 'w');
      SLOT_STATUS[slot.id] = 'skipped';
      return;
    }

    SLOT_STATUS[slot.id] = 'placing';
    await armFromAutoSlot(slot, direction);
    SLOT_STATUS[slot.id] = 'placed';

  } catch(e) {
    lg(`[Auto] "${slot.name}": ❌ ${e.message}`, 'e');
    SLOT_STATUS[slot.id] = 'error';
  }
}

// Arm the main trade engine from an auto-slot result
async function armFromAutoSlot(slot, direction) {
  clearTimers();

  const exitTs = timeStrToTs(slot.exitTime);

  const config = {
    dir: direction,
    otm: slot.otm, step: slot.step,
    sl: slot.sl, tgt: slot.tgt,
    lots: slot.lots, lotSize: slot.lotSize,
    autoLots: slot.autoLots || false,
    deployPct: slot.deployPct || 90,
    floorPremium: slot.floorPremium || 0,
    exitTs,
  };

  Object.assign(ST, {
    armed: true, status: 'armed', config,
    instr: null, entryPrice: null, slLevel: null, tgtLevel: null,
    pnl: null, entryOrderId: null, exitOrderId: null,
  });

  lg(`[Auto] Armed → BUY ${direction} | SL:${slot.sl} TGT:${slot.tgt} | Entry in 2s`, 's');

  // Fire entry after 2s buffer
  ST._entryTimer = setTimeout(onEntry, 2000);

  // Schedule auto-exit
  const msExit = exitTs - Date.now();
  if (msExit > 0) {
    ST._exitTimer = setTimeout(async () => {
      if (ST.status === 'live') { lg('⏰ Auto-exit time', 'w'); await doSquareOff('Auto-exit'); }
    }, msExit);
    lg(`⏱ Auto-exit in ${Math.floor(msExit/1000)}s`, 'i');
  }
}

// ══════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let body = '';
  if (req.method === 'POST') {
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    try { body = JSON.parse(body); } catch(_) { body = {}; }
  }
  const ok  = (d, code = 200) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  // ── GET /engine/token ───────────────────────────────────
  // Returns current token (for use in download scripts)
  if (p === '/engine/token' && req.method === 'GET') {
    if (!ST.token) return ok({ ok: false, error: 'No token — connect to Upstox first' });
    return ok({ ok: true, token: ST.token });
  }

  // ── POST /engine/token ──────────────────────────────────
  if (p === '/engine/token' && req.method === 'POST') {
    if (!body.token) return ok({ ok: false, error: 'No token' }, 400);
    ST.token = body.token;
    lg('🔑 Token received', 's');
    return ok({ ok: true });
  }

  // ── POST /engine/arm (manual) ───────────────────────────
  if (p === '/engine/arm' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    if (!body.dir) return ok({ ok: false, error: 'No direction' }, 400);
    clearTimers();
    Object.assign(ST, {
      armed: true, status: 'armed', config: body,
      instr: null, entryPrice: null, slLevel: null, tgtLevel: null,
      pnl: null, entryOrderId: null, exitOrderId: null, log: [],
    });
    const msEntry = (body.entryTs || 0) - Date.now();
    if (msEntry <= 0) {
      lg('⚡ Entry time passed — firing now', 'w');
      setTimeout(onEntry, 500);
    } else {
      ST._entryTimer = setTimeout(onEntry, msEntry);
      lg(`⏱ Entry in ${Math.floor(msEntry/1000)}s`, 'i');
      // Background spot refresh while waiting
      const spotRefresh = setInterval(async () => {
        if (!ST.armed || ST.status !== 'armed') { clearInterval(spotRefresh); return; }
        try { ST.spotPrice = await getNiftySpot(); } catch(_) {}
      }, 5000);
    }
    const msExit = (body.exitTs || 0) - Date.now();
    if (msExit > 0) {
      ST._exitTimer = setTimeout(async () => {
        if (ST.status === 'live') { lg('⏰ Auto-exit', 'w'); await doSquareOff('Auto-exit'); }
      }, msExit);
      lg(`⏱ Auto-exit in ${Math.floor(msExit/1000)}s`, 'i');
    }
    return ok({ ok: true });
  }

  // ── GET /engine/status ──────────────────────────────────
  if (p === '/engine/status' && req.method === 'GET') {
    return ok({
      ok: true, status: ST.status, armed: ST.armed,
      spotPrice: ST.spotPrice, optionPrice: ST.optionPrice,
      entryPrice: ST.entryPrice, slLevel: ST.slLevel, tgtLevel: ST.tgtLevel,
      pnl: ST.pnl, instr: ST.instr, config: ST.config,
      entryOrderId: ST.entryOrderId, log: ST.log.slice(0, 50),
    });
  }

  // ── POST /engine/disarm ─────────────────────────────────
  if (p === '/engine/disarm' && req.method === 'POST') {
    clearTimers(); ST.armed = false; ST.status = 'idle';
    lg('Strategy disarmed', 'w');
    return ok({ ok: true });
  }

  // ── POST /engine/squareoff ──────────────────────────────
  if (p === '/engine/squareoff' && req.method === 'POST') {
    if (!['live','exiting'].includes(ST.status))
      return ok({ ok: false, error: `Not in trade (${ST.status})` });
    doSquareOff('Manual').catch(e => lg(`Squareoff: ${e.message}`, 'e'));
    return ok({ ok: true });
  }

  // ── POST /engine/slots ──────────────────────────────────
  if (p === '/engine/slots' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'Push token first' }, 400);
    if (!Array.isArray(body.slots)) return ok({ ok: false, error: 'Expected { slots: [] }' }, 400);
    AUTO_SLOTS = body.slots;
    saveSlots();
    scheduleAllSlots();
    const enabled = AUTO_SLOTS.filter(s => s.enabled).length;
    lg(`📋 ${AUTO_SLOTS.length} slot(s) received (${enabled} enabled) — timers set`, 's');
    return ok({ ok: true, scheduled: enabled });
  }

  // ── GET /engine/slots/status ────────────────────────────
  if (p === '/engine/slots/status' && req.method === 'GET') {
    return ok({
      ok: true,
      slots: AUTO_SLOTS.map(s => ({
        id: s.id, name: s.name, enabled: s.enabled,
        entryTime: s.entryTime, exitTime: s.exitTime,
        status: SLOT_STATUS[s.id] || 'idle',
        sets: (s.conditionSets || []).length,
      })),
      engineStatus: ST.status,
    });
  }

  // ── POST /engine/slots/clear ────────────────────────────
  if (p === '/engine/slots/clear' && req.method === 'POST') {
    clearAllSlotTimers();
    AUTO_SLOTS = [];
    saveSlots();
    lg('All auto-strategy slots cleared', 'w');
    return ok({ ok: true });
  }

  // ── GET /engine/testbalance (debug) ─────────────────────
  if (p === '/engine/testbalance' && req.method === 'GET') {
    if (!ST.token) return ok({ error: 'No token' });
    const results = {};
    for (const ep of ['/v2/user/get-funds-and-margin', '/v2/user/get-funds-and-margin?segment=SEC']) {
      try { results[ep] = (await upstox(ep))?.data; } catch(e) { results[ep] = { error: e.message }; }
    }
    return ok({ ok: true, results });
  }

  // ── GET /engine/bt/logs ─────────────────────────────────
  if (p === '/engine/bt/logs' && req.method === 'GET') {
    const logs = loadBtLogs();
    return ok({ ok: true, logs });
  }

  // ── POST /engine/bt/logs ────────────────────────────────
  // App pushes its locally-computed BT results to VM for persistence
  if (p === '/engine/bt/logs' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);   // { date, slots, summary, candles }
        const logs = loadBtLogs();
        if (incoming.date) {
          logs[incoming.date] = incoming;
          saveBtLogs(logs);
          lg(`BT: stored results for ${incoming.date} from app`, 'i');
          return ok({ ok: true });
        }
        ok({ error: 'Missing date' }, 400);
      } catch(e) { ok({ error: e.message }, 400); }
    });
    return;
  }

  // ── GET /engine/bt/run?date=YYYY-MM-DD ──────────────────
  // Manually trigger a simulation for a specific date
  if (p.startsWith('/engine/bt/run') && req.method === 'GET') {
    const dateStr = new URL('http://x' + req.url).searchParams.get('date');
    if (!dateStr) return ok({ error: 'Missing date param' }, 400);
    if (!ST.token) return ok({ error: 'No token — push token first' }, 400);
    btRunForDate(dateStr).then(result => {
      const logs = loadBtLogs();
      logs[dateStr] = result;
      saveBtLogs(logs);
      lg(`BT: manual run for ${dateStr} done — P&L ${result.summary.totalPnl > 0 ? '+' : ''}${result.summary.totalPnl} pts`, 's');
      ok({ ok: true, result });
    }).catch(e => ok({ ok: false, error: e.message }));
    return;
  }

  // ── GET /engine/candles?date=YYYY-MM-DD ─────────────────
  // Download 1-min NIFTY candles for a date as CSV
  if (p.startsWith('/engine/candles') && req.method === 'GET') {
    if (!ST.token) return ok({ error: 'No token' }, 400);
    const params = new URL('http://x' + req.url).searchParams;
    const dateStr = params.get('date');
    const key = 'NSE_INDEX%7CNifty%2050';
    let upstoxPath;
    if (dateStr) {
      // Historical: to_date must be day AFTER the target date
      const d = new Date(dateStr + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      const to = d.toISOString().slice(0, 10);
      upstoxPath = `/v2/historical-candle/${key}/1minute/${to}/${dateStr}`;
      lg(`Candle download: historical ${dateStr} (to=${to})`, 'i');
    } else {
      upstoxPath = `/v2/historical-candle/intraday/${key}/1minute`;
      lg(`Candle download: intraday`, 'i');
    }
    upstox(upstoxPath).then(data => {
      const candles = (data?.data?.candles || []).slice().reverse(); // oldest first
      if (!candles.length) {
        lg(`Candle download: no data returned for ${dateStr||'today'}`, 'w');
        res.writeHead(200, { 'Content-Type':'text/csv', 'Access-Control-Allow-Origin':'*' });
        return res.end('timestamp,open,high,low,close,volume\n');
      }
      const rows = ['timestamp,open,high,low,close,volume'];
      candles.forEach(c => {
        const ist = new Date(new Date(c[0]).getTime() + 5.5 * 3600000);
        const ts  = ist.toISOString().replace('T', ' ').slice(0, 16);
        rows.push(`${ts},${c[1]},${c[2]},${c[3]},${c[4]},${c[5] || 0}`);
      });
      const csv   = rows.join('\n');
      const label = dateStr || new Date(Date.now() + 5.5*3600000).toISOString().slice(0,10);
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="nifty_${label}.csv"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(csv);
      lg(`Candle export: ${candles.length} candles for ${label}`, 's');
    }).catch(e => {
      lg(`Candle export error: ${e.message}`, 'e');
      ok({ error: e.message }, 500);
    });
    return;
  }

  // ── GET /engine/test/all ────────────────────────────────
  // Dry-run ALL slots on current live candles, return full detail
  if (p === '/engine/test/all' && req.method === 'GET') {
    if (!ST.token) return ok({ error: 'No token — connect to Upstox first' }, 400);
    try {
      const slots     = AUTO_SLOTS;  // already in memory — no need to call loadSlots()
      if (!slots || !slots.length) return ok({ ok:false, error:'No slots loaded on VM — push SR slots first' });
      const candleMap = await fetchCandleMap();
      const times     = Object.keys(candleMap).sort();
      const now       = times[times.length-1] || '??:??';

      const results = [];
      for (const slot of slots) {
        if (!slot.enabled) continue;
        const slotLog = [];
        const say = (msg, tag='i') => slotLog.push({ msg, tag });

        let firedSet = null;
        for (const cs of (slot.conditionSets || [])) {
          if (!cs.enabled) continue;
          let setPass = true;
          const condResults = [];
          for (const cond of (cs.conditions || [])) {
            if (!cond.enabled) continue;
            const lc = candleMap[cond.leftTime];
            if (!lc) {
              condResults.push({ pass:false, msg:`No candle at ${cond.leftTime}` });
              setPass = false; continue;
            }
            const lv = fieldOf(lc, cond.leftField);
            let rv, rvDesc;
            if (cond.rightType === 'indicator') {
              const raw = indicatorValue(candleMap, cond.leftTime, cond.rightField);
              if (raw === null) {
                condResults.push({ pass:false, msg:`${cond.rightField} null at ${cond.leftTime}` });
                setPass = false; continue;
              }
              rv = raw + parseFloat(cond.offsetPts || 0);
              rvDesc = `${cond.rightField}=${raw.toFixed(2)}+${cond.offsetPts||0}=${rv.toFixed(2)}`;
            } else if (cond.rightType === 'candle') {
              const rc = candleMap[cond.rightTime];
              if (!rc) {
                condResults.push({ pass:false, msg:`No candle at ${cond.rightTime}` });
                setPass = false; continue;
              }
              rv = fieldOf(rc, cond.rightField) + parseFloat(cond.offsetPts || 0);
              rvDesc = `${cond.rightTime}.${cond.rightField}+${cond.offsetPts||0}=${rv.toFixed(2)}`;
            } else {
              rv = parseFloat(cond.rightValue || 0) + parseFloat(cond.offsetPts || 0);
              rvDesc = `${rv}`;
            }
            const pass = evalOp(lv, cond.op, rv);
            condResults.push({ pass, msg:`${cond.leftTime}.${cond.leftField}=${lv.toFixed(2)} ${cond.op} ${rvDesc}` });
            if (!pass) setPass = false;
          }
          if (setPass && !firedSet) firedSet = cs;
          slotLog.push({ set: cs.name, dir: cs.direction, pass: setPass, conds: condResults });
        }
        results.push({
          name:     slot.name,
          entry:    slot.entryTime,
          exit:     slot.exitTime,
          fired:    !!firedSet,
          direction:firedSet?.direction || null,
          sets:     slotLog,
        });
      }
      return ok({ ok:true, candles:times.length, latestCandle:now, results });
    } catch(e) {
      return ok({ ok:false, error:e.message });
    }
  }

  // ── GET /engine/test/slot?name=0946-CE-SR ──────────────
  // Dry-run: fetches live candles, evaluates slot conditions,
  // returns step-by-step logs without placing any order
  if (p.startsWith('/engine/test/slot') && req.method === 'GET') {
    const slotName = new URL('http://x' + req.url).searchParams.get('name');
    if (!slotName) return ok({ error: 'Missing ?name= param' }, 400);
    if (!ST.token)  return ok({ error: 'No token — connect to Upstox first' }, 400);

    const log = [];
    const say = (msg, tag='i') => { log.push({ msg, tag, ts: istNow() }); lg(`[TEST] ${msg}`, tag); };

    try {
      // 1. Load slots from memory
      const slots = AUTO_SLOTS;
      if (!slots || !slots.length) return ok({ ok:false, error:'No slots loaded on VM — push SR slots first', log:[] });
      const slot  = slots.find(s => s.name === slotName || s.id === slotName);
      if (!slot) {
        return ok({ ok:false, error:`Slot "${slotName}" not found in engine-slots.json`,
                    available: slots.map(s=>s.name) });
      }
      say(`Found slot: ${slot.name} | entry=${slot.entryTime} exit=${slot.exitTime}`);
      say(`OTM=${slot.otm} step=${slot.step} SL=${slot.sl} TGT=${slot.tgt} enabled=${slot.enabled}`);

      // 2. Fetch candles
      say('Fetching intraday candles...');
      const candleMap = await fetchCandleMap();
      const times = Object.keys(candleMap).sort();
      say(`Candles loaded: ${times.length} candles (${times[0]} → ${times[times.length-1]})`);

      // 3. Evaluate each condition set
      let firedSet = null;
      for (const cs of (slot.conditionSets || [])) {
        if (!cs.enabled) { say(`Set "${cs.name}": DISABLED — skip`); continue; }
        say(`Evaluating set: "${cs.name}" (${cs.logic}/${cs.direction})`);

        let setPass = true;
        for (const cond of (cs.conditions || [])) {
          if (!cond.enabled) { say(`  Cond: DISABLED — skip`); continue; }

          const lc = candleMap[cond.leftTime];
          if (!lc) {
            say(`  Cond: ❌ No candle at leftTime=${cond.leftTime}`, 'e');
            setPass = false; continue;
          }
          const lv = fieldOf(lc, cond.leftField);

          let rv, rvDesc;
          if (cond.rightType === 'indicator') {
            const raw = indicatorValue(candleMap, cond.leftTime, cond.rightField);
            if (raw === null) {
              say(`  Cond: ❌ indicatorValue(${cond.rightField}) returned null at ${cond.leftTime}`, 'e');
              setPass = false; continue;
            }
            rv = raw + parseFloat(cond.offsetPts || 0);
            rvDesc = `${cond.rightField}=${raw.toFixed(2)} + offset=${cond.offsetPts||0} = ${rv.toFixed(2)}`;
          } else if (cond.rightType === 'candle') {
            const rc = candleMap[cond.rightTime];
            if (!rc) {
              say(`  Cond: ❌ No candle at rightTime=${cond.rightTime}`, 'e');
              setPass = false; continue;
            }
            const base = fieldOf(rc, cond.rightField);
            rv = base + parseFloat(cond.offsetPts || 0);
            rvDesc = `${cond.rightTime}.${cond.rightField}=${base.toFixed(2)} + offset=${cond.offsetPts||0} = ${rv.toFixed(2)}`;
          } else {
            rv = parseFloat(cond.rightValue || 0) + parseFloat(cond.offsetPts || 0);
            rvDesc = `value=${rv}`;
          }

          const result = evalOp(lv, cond.op, rv);
          const sym = result ? '✅' : '❌';
          say(`  Cond: ${sym} ${cond.leftTime}.${cond.leftField}=${lv.toFixed(2)} ${cond.op} ${rvDesc} → ${result?'PASS':'FAIL'}`);
          if (!result) setPass = false;
        }

        say(`  Set result: ${setPass ? `✅ ALL PASS → BUY ${cs.direction}` : '❌ FAIL'}`);
        if (setPass && !firedSet) firedSet = cs;
      }

      // 4. Summary
      if (firedSet) {
        say(`🔥 SIGNAL: BUY ${firedSet.direction} — would place order if this were live`, 's');
        // 5. Instrument lookup (dry run — don't place order)
        say('Checking instrument availability (dry run)...');
        try {
          const spot   = await getNiftySpot();
          const atm    = Math.round(spot / slot.step) * slot.step;
          const otm    = slot.otm || 1;
          const strike = firedSet.direction === 'CE' ? atm + otm*slot.step : atm - otm*slot.step;
          say(`Spot=${spot.toFixed(2)} ATM=${atm} Strike=${strike}${firedSet.direction} OTM=${otm}`);
          const expiry = await getLiveExpiry();
          say(`Expiry: ${expiry}`);
          const { key, ltp } = await findInstrument(expiry, strike, firedSet.direction);
          say(`✅ Instrument found: ${key} LTP=${ltp}`, 's');
          say(`WOULD PLACE: BUY ${strike}${firedSet.direction} @ ~${ltp} | SL=${slot.sl}opt TGT=${slot.tgt}opt`, 's');
        } catch(ie) {
          say(`❌ Instrument lookup failed: ${ie.message}`, 'e');
        }
      } else {
        say('⛔ NO SIGNAL — no condition set satisfied', 'w');
      }

      return ok({ ok: true, slot: slot.name, signal: firedSet?.direction || null, log });
    } catch(e) {
      say(`❌ Test failed: ${e.message}`, 'e');
      return ok({ ok: false, error: e.message, log });
    }
  }

  ok({ error: 'Unknown endpoint' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  lg(`Cloud engine v3 started on port ${PORT}`, 's');
  loadState();
  loadSlots();
  btScheduleDailyRun();
  lg('BT daily scheduler started (fires at 15:32 IST)', 'i');
});
