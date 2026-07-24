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
const SE_STATE_FILE    = '/home/ubuntu/engine-se-state.json';    // straddle: today's position/trades/log
const SE_DEFAULTS_FILE = '/home/ubuntu/engine-se-defaults.json'; // straddle: persisted default params (survives across days)
const SE_BN_STATE_FILE    = '/home/ubuntu/engine-se-bn-state.json';
const SE_BN_DEFAULTS_FILE = '/home/ubuntu/engine-se-bn-defaults.json';

// ── Manual trade state ───────────────────────────────────
const ST = {
  token: null, armed: false,
  status: 'idle',  // idle armed ready placed live exiting done error
  config: null, instr: null,
  entryPrice: null, slLevel: null, tgtLevel: null,
  spotPrice: null, optionPrice: null, pnl: null,
  entryOrderId: null, exitOrderId: null, log: [],
  _entryTimer: null, _exitTimer: null, _monitorIvl: null,
  srActive: false,        // OFF by default — mirrors straddle being ON by default
  srActiveDateStr: null,  // IST date this srActive value applies to; resets to false on a new day
};

// Resets SR back to its default (off) at the start of each new IST trading
// day, regardless of what it was left at yesterday. Called at boot and on
// every token push, same pattern as the straddle engine's day boundary.
function srResetIfNewDay() {
  const today = seTodayStr();
  if (ST.srActiveDateStr !== today) {
    ST.srActive = false;
    ST.srActiveDateStr = today;
    saveState();
  }
}

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
      token: ST.token,
      status: ST.status, armed: ST.armed, config: ST.config, instr: ST.instr,
      entryPrice: ST.entryPrice, slLevel: ST.slLevel, tgtLevel: ST.tgtLevel,
      entryOrderId: ST.entryOrderId, exitOrderId: ST.exitOrderId,
      optionPrice: ST.optionPrice, spotPrice: ST.spotPrice, pnl: ST.pnl,
      exitTs: ST.config?.exitTs || null, log: ST.log.slice(0, 50),
      srActive: ST.srActive, srActiveDateStr: ST.srActiveDateStr,
    }));
  } catch(e) { console.error('saveState:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(ST, saved);
    srResetIfNewDay();   // SR resets to off if this restore is from a previous day
    lg(`📂 Trade state loaded: ${ST.status} | SR active: ${ST.srActive}`, 'i');
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
// ── AUTO-START TICK COLLECTOR ────────────────────────────────
const { execSync: _execSync, spawn: _spawn } = require('child_process');
const _fs2 = require('fs');
const _path2 = require('path');

function autoStartTickCollector() {
  try {
    const collectorPath = _path2.join(process.env.HOME || '/home/ubuntu', 'tick-collector.js');
    if (!_fs2.existsSync(collectorPath)) {
      lg('[Tick] tick-collector.js not on VM — skipping', 'i');
      return;
    }
    // Market hours check: only block if it's AFTER 15:31 (market closed for day)
    // If before market open, collector waits internally until 09:14
    const ist  = new Date(Date.now() + 5.5 * 3600000);
    const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (hhmm > 15 * 60 + 32) {
      lg('[Tick] Market closed for today — collector not started', 'i');
      return;
    }
    // Already running?
    try {
      const pid = _execSync("pgrep -f 'tick-collector.js'", { encoding: 'utf8' }).trim();
      if (pid) { lg('[Tick] Collector already running PID=' + pid, 'i'); return; }
    } catch(_) {}
    // Launch detached
    const child = _spawn('node', [collectorPath], {
      detached: true, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    lg('[Tick] ✅ Tick collector started PID=' + child.pid, 's');
  } catch(e) {
    lg('[Tick] Auto-start failed: ' + e.message, 'w');
  }
}

// MARKET DATA
// ══════════════════════════════════════════════════════════
// Instrument keys
const INST_KEYS = {
  NF: 'NSE_INDEX|Nifty 50',
  BN: 'NSE_INDEX|Nifty Bank',
};

// NSE freeze limits (per single order, must be whole lots)
// NIFTY lot=65: floor(1800/65)*65 = 1755
// BN lot=30:    floor(900/30)*30  = 900
const FREEZE = { NF: 1755, BN: 900 };

function getInstKey(inst) {
  return INST_KEYS[inst] || INST_KEYS.NF;
}

// Detect instrument from slot name or config
// BN slots have name starting with 'BN' or lotSize=30
function detectInst(cfg) {
  if (!cfg) return 'NF';
  if (cfg.inst) return cfg.inst;
  if (cfg.lotSize === 30) return 'BN';
  if (cfg.name && cfg.name.startsWith('BN')) return 'BN';
  return 'NF';
}

async function getSpot(inst) {
  const key = encodeURIComponent(getInstKey(inst));
  const d = await upstox(`/v2/market-quote/ltp?instrument_key=${key}`);
  const ltp = Object.values(d?.data || {})[0]?.last_price;
  if (!ltp) throw new Error(`${inst} spot unavailable`);
  return parseFloat(ltp);
}

// Legacy alias
async function getNiftySpot() { return getSpot('NF'); }

async function getSpotAndOptLTP(optInstrKey, inst) {
  const idxKey = encodeURIComponent(getInstKey(inst || 'NF'));
  const keys   = idxKey + ',' + encodeURIComponent(optInstrKey);
  const d = await upstox(`/v2/market-quote/ltp?instrument_key=${keys}`);
  let spot = 0, optLTP = 0;
  for (const [k, v] of Object.entries(d?.data || {})) {
    if (k.startsWith('NSE_INDEX')) spot   = parseFloat(v?.last_price) || 0;
    else                           optLTP = parseFloat(v?.last_price) || 0;
  }
  return { spot, optLTP };
}

// Compute Bank Nifty monthly expiry = last Tuesday of current month
// If that Tuesday has passed, use next month's last Tuesday
function getBNExpiry() {
  const now  = new Date(Date.now() + 5.5*3600000); // IST
  const year = now.getUTCFullYear();
  const mon  = now.getUTCMonth(); // 0-indexed

  function lastTuesdayOfMonth(y, m) {
    // Last day of month
    const last = new Date(Date.UTC(y, m+1, 0));
    // Walk back to Tuesday (day 2)
    const dow  = last.getUTCDay();
    const diff = (dow >= 2) ? dow - 2 : dow + 5;
    last.setUTCDate(last.getUTCDate() - diff);
    return last.toISOString().slice(0,10);
  }

  const thisMonthExpiry = lastTuesdayOfMonth(year, mon);
  const todayStr = now.toISOString().slice(0,10);

  // If today is past this month's expiry, use next month
  if (todayStr > thisMonthExpiry) {
    const nextMon = mon === 11 ? 0 : mon + 1;
    const nextYear = mon === 11 ? year + 1 : year;
    return lastTuesdayOfMonth(nextYear, nextMon);
  }
  return thisMonthExpiry;
}

async function getLiveExpiry(inst) {
  // BN: compute monthly expiry directly (API requires expiry_date parameter)
  if (inst === 'BN') {
    const expiry = getBNExpiry();
    lg(`📅 BN monthly expiry: ${expiry}`, 'i');
    return expiry;
  }

  // NF: weekly Tuesday expiry — fetch from API
  const key = encodeURIComponent(getInstKey('NF'));
  try {
    const d = await upstox(`/v2/option/chain?instrument_key=${key}`);
    const expiries = d?.data?.expiry_list || d?.data?.expiryList;
    if (Array.isArray(expiries) && expiries.length) {
      const today = localDateStr(new Date());
      const nearest = expiries.filter(e => e >= today).sort()[0];
      if (nearest) { lg(`📅 NF expiry: ${nearest}`, 'i'); return nearest; }
    }
  } catch(_) {}
  // Fallback: compute next Tuesday
  const now = new Date(), day = now.getDay();
  const isTuOpen = day === 2 && (now.getHours() * 60 + now.getMinutes()) < 15 * 60 + 30;
  const ahead = isTuOpen ? 0 : ((2 - day + 7) % 7 || 7);
  const candidates = [];
  for (let i = 0; i <= 5; i++) {
    const d = new Date(now); d.setDate(now.getDate() + ahead - i);
    if (d.getDay() !== 0) candidates.push(localDateStr(d));
  }
  lg(`📅 NF scanning: ${candidates.slice(0,3).join(', ')}`, 'i');
  for (const expiry of candidates) {
    try {
      const d = await upstox(`/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`);
      if (Array.isArray(d?.data) && d.data.length > 0) {
        lg(`📅 NF confirmed: ${expiry} (${d.data.length} strikes)`, 's');
        return expiry;
      }
    } catch(_) {}
  }
  return candidates[0];
}

async function findInstrument(expiry, strike, type, inst) {
  const key = encodeURIComponent(getInstKey(inst || 'NF'));
  const d = await upstox(`/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`);
  const chain = d?.data;
  if (!Array.isArray(chain) || !chain.length) throw new Error('Chain empty for ' + expiry);
  const row = chain.find(r => Math.round(r.strike_price) === strike);
  if (!row) throw new Error(`Strike ${strike} not found in ${inst||'NF'} chain`);
  const side = type === 'CE' ? row.call_options : row.put_options;
  if (!side?.instrument_key) throw new Error(`${type} key missing`);
  return { key: side.instrument_key, ltp: parseFloat(side?.market_data?.ltp) || 0 };
}

// ══════════════════════════════════════════════════════════
// STRADDLE ENGINE — runs independently on VM
// ══════════════════════════════════════════════════════════
// Hardcoded factory defaults — used only until SE_DEFAULTS_FILE exists.
// Once the app calls POST /engine/straddle/defaults these are superseded
// on disk and survive VM restarts + day rollovers.
const SE_FACTORY_DEFAULTS = {
  tp: 8, sl: 4, volThr: 1.0, lots: 6, autoLots: true, deployPct: 95, floorPrem: 50,
  trendPts: 10, trendOffsetMin: 2,   // trend filter: |spot - open[x-trendOffsetMin]| >= trendPts. trendPts:0 disables it.
  exitOffsetMin: 4,   // hard time-exit at second 57 of candle (x + exitOffsetMin), x = the signal-check candle
};

const SE = {
  active:      false,   // master on/off (whether the loop is currently armed to trade)
  tp:          SE_FACTORY_DEFAULTS.tp,
  sl:          SE_FACTORY_DEFAULTS.sl,
  volThr:      SE_FACTORY_DEFAULTS.volThr,
  lots:        SE_FACTORY_DEFAULTS.lots,
  autoLots:    SE_FACTORY_DEFAULTS.autoLots,
  deployPct:   SE_FACTORY_DEFAULTS.deployPct,
  floorPrem:   SE_FACTORY_DEFAULTS.floorPrem,
  trendPts:       SE_FACTORY_DEFAULTS.trendPts,
  trendOffsetMin: SE_FACTORY_DEFAULTS.trendOffsetMin,
  exitOffsetMin:  SE_FACTORY_DEFAULTS.exitOffsetMin,
  checkTimer:  null,    // setInterval for minute checks
  monTimer:    null,    // setInterval for position monitor (500ms)
  position:    null,    // active position {ceKey,peKey,entrySpot,ceClosed,peClosed,lots,tp,sl,exitDeadlineTs}
  trades:      [],      // today's completed trades
  log:         [],      // today's engine log lines
  dateStr:     null,    // IST date (YYYY-MM-DD) this trades/log belong to
  stoppedToday: false,  // true once user explicitly hits OFF — blocks auto-start for the rest of THIS date only
};

// IST calendar date as YYYY-MM-DD — the day boundary used for log/trade resets
function seTodayStr() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}

// ── Persist today's position/trades/log so a VM restart doesn't lose them ──
function seSaveState() {
  try {
    fs.writeFileSync(SE_STATE_FILE, JSON.stringify({
      active: SE.active, dateStr: SE.dateStr, stoppedToday: SE.stoppedToday,
      tp: SE.tp, sl: SE.sl, volThr: SE.volThr, lots: SE.lots,
      autoLots: SE.autoLots, deployPct: SE.deployPct, floorPrem: SE.floorPrem,
      trendPts: SE.trendPts, trendOffsetMin: SE.trendOffsetMin, exitOffsetMin: SE.exitOffsetMin,
      position: SE.position, trades: SE.trades, log: SE.log,
    }));
  } catch(e) { console.error('seSaveState:', e.message); }
}

// ── Restore on boot. Same IST date → resume trades/log/position/active-scanning
//    as-is. Different (or missing) date → fresh day, keep params only.
function seLoadState() {
  const today = seTodayStr();
  try {
    if (fs.existsSync(SE_STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SE_STATE_FILE, 'utf8'));
      Object.assign(SE, {
        tp: saved.tp ?? SE.tp, sl: saved.sl ?? SE.sl, volThr: saved.volThr ?? SE.volThr,
        lots: saved.lots ?? SE.lots, autoLots: saved.autoLots ?? SE.autoLots,
        deployPct: saved.deployPct ?? SE.deployPct, floorPrem: saved.floorPrem ?? SE.floorPrem,
        trendPts: saved.trendPts ?? SE.trendPts, trendOffsetMin: saved.trendOffsetMin ?? SE.trendOffsetMin,
        exitOffsetMin: saved.exitOffsetMin ?? SE.exitOffsetMin,
      });
      if (saved.dateStr === today) {
        SE.dateStr      = today;
        SE.stoppedToday = !!saved.stoppedToday;
        SE.trades       = Array.isArray(saved.trades) ? saved.trades : [];
        SE.log          = Array.isArray(saved.log) ? saved.log : [];
        SE.position     = saved.position || null;
        lg(`📂 [Straddle] Same-day state restored: ${SE.trades.length} trade(s), position ${SE.position ? 'OPEN' : 'none'}, wasActive=${!!saved.active}`, 'i');
        if (saved.active && !SE.stoppedToday) {
          SE.active = true;
          seScheduleNextCheck();   // resume minute-boundary scanning regardless of position
          if (SE.position) {
            // A position was live at crash time — resume monitoring it too.
            seStartMonitor();
            const msLeft = (SE.position.exitDeadlineTs || 0) - Date.now();
            if (msLeft > 0) {
              setTimeout(() => seTimeExit(), msLeft);
              lg(`⏱ [Straddle] Exit timer restored (${Math.floor(msLeft/1000)}s)`, 'i');
            } else {
              lg('⚠️ [Straddle] Exit time already passed during downtime — closing now', 'w');
              seTimeExit();
            }
          }
        }
      } else {
        // New day — fresh trades/log, but remember params.
        SE.dateStr = today; SE.stoppedToday = false; SE.trades = []; SE.log = []; SE.position = null;
      }
    } else {
      SE.dateStr = today;
    }
  } catch(e) {
    console.error('seLoadState:', e.message);
    SE.dateStr = today;
  }
}

// ── Persisted default params (separate from today's state — these are the
//    baseline used every morning / every restart until the app pushes new ones) ──
function seSaveDefaults(d) {
  try { fs.writeFileSync(SE_DEFAULTS_FILE, JSON.stringify(d)); } catch(e) { console.error('seSaveDefaults:', e.message); }
}
function seLoadDefaults() {
  try {
    if (fs.existsSync(SE_DEFAULTS_FILE)) return { ...SE_FACTORY_DEFAULTS, ...JSON.parse(fs.readFileSync(SE_DEFAULTS_FILE, 'utf8')) };
  } catch(e) { console.error('seLoadDefaults:', e.message); }
  return { ...SE_FACTORY_DEFAULTS };
}

function seLg(msg, type='i') {
  const ts  = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'});
  const line = `[${ts}] ${msg}`;
  SE.log.unshift(line);
  if (SE.log.length > 3000) SE.log.pop();  // generous full-trading-day cap, resets to [] on day rollover
  lg(`[Straddle] ${msg}`, type);
  seSaveState();
}

function seIsMarket() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm >= 9 * 60 + 20 && hhmm <= 15 * 60 + 25;
}

function seStart(params = {}) {
  const today = seTodayStr();
  if (SE.dateStr !== today) { SE.dateStr = today; SE.trades = []; SE.log = []; SE.position = null; }
  SE.stoppedToday = false;   // explicit (or auto) start always clears today's manual-stop flag
  if (SE.active) { seLg('Already active', 'w'); return; }
  Object.assign(SE, {
    active: true,
    tp:        params.tp        || SE.tp,
    sl:        params.sl        || SE.sl,
    volThr:    params.volThr    || SE.volThr,
    lots:      params.lots      || SE.lots,
    autoLots:  params.autoLots  !== undefined ? params.autoLots : SE.autoLots,
    deployPct: params.deployPct || SE.deployPct,
    floorPrem: params.floorPrem || SE.floorPrem,
    trendPts:       params.trendPts       ?? SE.trendPts,
    trendOffsetMin: params.trendOffsetMin ?? SE.trendOffsetMin,
    exitOffsetMin:  params.exitOffsetMin  ?? SE.exitOffsetMin,
  });
  // Enforce mutual exclusion here (not just in the HTTP route) so this also
  // applies on auto-start via token push, not only a manual toggle press.
  // Only one of NIFTY straddle / BankNifty straddle / SR runs at a time.
  if (ST.srActive) {
    ST.srActive = false;
    lg('SR deactivated — straddle engine started', 'w');
  }
  if (SE_BN.active) {
    seBnStop('NIFTY straddle activated');
  }
  if (SM.active) {
    smStop('NIFTY straddle activated');
  }
  if (SM_BN.active) {
    smBnStop('NIFTY straddle activated');
  }
  saveState();
  seLg(`Straddle engine started — TP=${SE.tp}pt SL=${SE.sl}pt Vol≥${SE.volThr}×`, 's');
  seScheduleNextCheck();
}

function seStop(reason = 'Manual') {
  SE.active = false;
  SE.stoppedToday = true;   // blocks auto-resume (token re-push, VM restart) for the REST OF TODAY only
  if (SE.checkTimer) { clearTimeout(SE.checkTimer); SE.checkTimer = null; }
  if (SE.monTimer)   { clearInterval(SE.monTimer);  SE.monTimer   = null; }
  seLg(`Straddle engine stopped (${reason})`, 'w');
  // Note: SR is NOT auto-reactivated here anymore — SR is off by default now,
  // same as straddle used to require an explicit ON. If you want SR running,
  // turn it on explicitly from the SR tab.
}

// NIFTY straddle is now opt-in every day, same treatment as SR and
// BankNifty straddle — it no longer auto-starts on token push. SMA-NIFTY
// is the one always-on-by-default engine now; see smAutoStartIfNeeded().
// This only rolls the day boundary over (fresh trades/log, active reset to
// off) for the case where the VM stays up overnight without restarting.
function seResetIfNewDay() {
  const today = seTodayStr();
  if (SE.dateStr !== today) {
    SE.dateStr = today; SE.trades = []; SE.log = [];
    SE.position = null; SE.stoppedToday = false; SE.active = false;
    seSaveState();
  }
}

function seScheduleNextCheck() {
  if (!SE.active) return;
  // Fire at second 50 of each minute
  const now  = new Date();
  const secs = now.getSeconds();
  const ms   = now.getMilliseconds();
  const msTo50 = secs < 50
    ? (50 - secs) * 1000 - ms
    : (60 - secs + 50) * 1000 - ms;
  SE.checkTimer = setTimeout(async () => {
    if (SE.active) {
      await seCheck();
      seScheduleNextCheck();
    }
  }, msTo50);
}

async function seCheck() {
  if (!SE.active || SE.position) return;
  if (!ST.token) { seLg('No token — skip', 'w'); return; }
  if (!seIsMarket()) { seLg('Outside market hours', 'i'); return; }

  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = `${ist.getUTCHours()}:${String(ist.getUTCMinutes()).padStart(2,'0')}:${String(ist.getUTCSeconds()).padStart(2,'0')}`;
  seLg(`Signal check at ${hhmm}`);

  try {
    // 1. Get NIFTY spot + prev candle range
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
    if (!spot) { seLg('Spot unavailable', 'w'); return; }
    seLg(`NIFTY spot: ${spot}`);

    // 1b. Trend filter — only proceed to the (expensive, 9-call) volume check
    // if spot has also moved trendPts away from the open of the candle
    // trendOffsetMin minutes ago. Selects for "there's a trend right now",
    // not just a volume blip. trendPts:0 disables this gate entirely.
    //
    // "x-2" means: this check is evaluating minute X (right now, at :50
    // seconds past its start) — the reference is the OPEN of minute X-2,
    // i.e. two minutes before the start of the CURRENT minute, not two
    // minutes before "now". Matched by actual candle timestamp, not by
    // array position, so this can't silently drift if the API's ordering
    // or inclusion of the still-forming candle ever changes.
    if (SE.trendPts > 0) {
      const td = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%2050/1minute');
      const tcandles = td?.data?.candles || [];
      const xStartMs  = Math.floor(Date.now() / 60000) * 60000;         // start of minute X (IST and UTC minute boundaries coincide — 5:30 offset is a whole number of minutes)
      const targetMs  = xStartMs - SE.trendOffsetMin * 60000;            // start of minute X-trendOffsetMin
      let refCandle = null, refTs = null;
      for (const cnd of tcandles) {
        const cndMs = new Date(cnd[0]).getTime();
        if (Math.abs(cndMs - targetMs) < 30000) { refCandle = cnd; refTs = cnd[0]; break; }  // 30s tolerance for candle-boundary rounding
      }
      if (!refCandle) { seLg(`Trend filter: no candle found for x-${SE.trendOffsetMin} (need more history, or market just opened) — skip`, 'w'); return; }
      const refOpen = parseFloat(refCandle[1]);
      const trendMove = spot - refOpen;
      seLg(`Trend check: spot ${spot} vs open ${SE.trendOffsetMin}min ago [${refTs}] = ${refOpen} → ${trendMove>=0?'+':''}${trendMove.toFixed(1)}pts (need ±${SE.trendPts})`);
      if (Math.abs(trendMove) < SE.trendPts) {
        seLg(`Trend ${Math.abs(trendMove).toFixed(1)} < ${SE.trendPts} — no signal`);
        return;
      }
      seLg(`✅ Trend confirmed: ${trendMove>=0?'+':''}${trendMove.toFixed(1)}pts vs ${SE.trendOffsetMin}min ago`, 's');
    }

    // 2. Get weighted vol ratio across 9 stocks
    const STOCKS = [
      ['HDFCBANK',   'NSE_EQ%7CINE040A01034', 0.130],
      ['RELIANCE',   'NSE_EQ%7CINE002A01018', 0.090],
      ['ICICIBANK',  'NSE_EQ%7CINE090A01021', 0.080],
      ['INFY',       'NSE_EQ%7CINE009A01021', 0.060],
      ['TCS',        'NSE_EQ%7CINE467B01029', 0.050],
      ['LT',         'NSE_EQ%7CINE018A01030', 0.040],
      ['AXISBANK',   'NSE_EQ%7CINE238A01034', 0.040],
      ['HINDUNILVR', 'NSE_EQ%7CINE030A01027', 0.030],
      ['SBIN',       'NSE_EQ%7CINE062A01020', 0.030],
    ];
    let wVol = 0, totalW = 0;
    const stockDetails = [];
    for (const [sym, key, w] of STOCKS) {
      try {
        const cd = await upstox(`/v2/historical-candle/intraday/${key}/1minute`);
        const candles = (cd?.data?.candles || []).reverse();
        if (candles.length < 2) continue;
        const curVol = parseFloat(candles[candles.length-1][5]) || 0;
        const prior  = candles.slice(Math.max(0, candles.length-121), candles.length-1);
        const avgVol = prior.length > 0
          ? prior.reduce((s,c) => s + (parseFloat(c[5])||0), 0) / prior.length : 0;
        const ratio  = avgVol > 0 ? curVol / avgVol : 1;
        wVol += ratio * w; totalW += w;
        stockDetails.push(`${sym} ${ratio.toFixed(2)}×`);
        await sleep(120); // rate limit
      } catch(_) {}
    }
    const wvr = totalW > 0 ? wVol / totalW : 0;
    seLg(`Weighted vol ratio: ${wvr.toFixed(2)}× | threshold: ${SE.volThr}×`);

    if (wvr < SE.volThr) { seLg(`Vol ${wvr.toFixed(2)} < ${SE.volThr} — no signal`); return; }
    seLg(`✅ VOL SURGE: ${wvr.toFixed(2)}× — entering straddle at next minute open!`, 's');
    seLg(`   Per-stock: ${stockDetails.join(', ')}`, 'i');

    // 3. Schedule entry at next minute open (~second 0)
    const now2 = new Date();
    const msToNext = (60 - now2.getSeconds()) * 1000 - now2.getMilliseconds() + 200;
    setTimeout(() => seEnter(spot), msToNext);
    seLg(`Entry in ${(msToNext/1000).toFixed(1)}s`, 'i');

  } catch(e) { seLg('Check error: ' + e.message, 'e'); }
}

// Patches a confirmed fill price wherever the order actually lives right
// now — the live position, or (if it already closed by the time the fill
// confirmation comes back) the archived trade in SE.trades. Decoupled from
// timing on purpose: fill confirmation can take several seconds and must
// never block entry/exit/monitoring.
function seRecordFill(oid, field, price) {
  if (price == null) return;
  if (SE.position && (SE.position.ceOid === oid || SE.position.peOid === oid)) {
    SE.position[field] = price;
  }
  const t = SE.trades.find(x => x.ceOid === oid || x.peOid === oid);
  if (t) t[field] = price;
  seSaveState();
}

async function seEnter(signalSpot) {
  if (!SE.active || SE.position) return;
  try {
    seLg('Placing straddle...', 'w');
    // Fresh spot at entry
    const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price) || signalSpot;
    const atm  = Math.round(spot / 50) * 50;

    // Auto-lots
    let calcLots = SE.lots;
    if (SE.autoLots) {
      try {
        const funds      = await getAvailableFunds();
        const deployable = funds * SE.deployPct / 100;
        const expiry2    = await getLiveExpiry('NF');
        const ce2        = await findInstrument(expiry2, atm, 'CE', 'NF');
        const pe2        = await findInstrument(expiry2, atm, 'PE', 'NF');
        const effCe      = (SE.floorPrem > 0 && ce2.ltp < SE.floorPrem) ? SE.floorPrem : ce2.ltp;
        const effPe      = (SE.floorPrem > 0 && pe2.ltp < SE.floorPrem) ? SE.floorPrem : pe2.ltp;
        const costPerLot = (effCe + effPe) * 65;
        if (costPerLot > 0) {
          calcLots = Math.max(1, Math.floor(deployable / costPerLot));
          seLg(`💰 Balance ₹${funds.toFixed(0)} | ${SE.deployPct}% → ₹${deployable.toFixed(0)} | cost/lot ₹${costPerLot.toFixed(0)} → ${calcLots} lots`, 's');
        }
      } catch(e) { seLg('Auto-lots failed: ' + e.message + ' — using ' + calcLots, 'w'); }
    }

    const expiry = await getLiveExpiry('NF');
    const ce     = await findInstrument(expiry, atm, 'CE', 'NF');
    const pe     = await findInstrument(expiry, atm, 'PE', 'NF');
    const qty    = calcLots * 65;

    seLg(`📐 Quoted premiums before order: CE ₹${ce.ltp} | PE ₹${pe.ltp}`, 'i');

    const ceOid = await placeMarket(ce.key, 'BUY', qty, 'D', 65);
    await sleep(400);
    const peOid = await placeMarket(pe.key, 'BUY', qty, 'D', 65);

    // Time exit: second 57 of candle (x + exitOffsetMin), x = the signal
    // candle this entry came from — stored as an ABSOLUTE timestamp (not
    // just a setTimeout) so a VM restart mid-position can recompute the
    // remaining wait correctly instead of losing the deadline.
    const now3 = new Date();
    const extraMin = Math.max(0, SE.exitOffsetMin - 2);   // exitOffsetMin=2 reproduces the original timing exactly
    const msOut = (60 - now3.getSeconds() + 57) % 60 * 1000 + 60000 + 200 + extraMin * 60000;
    const exitDeadlineTs = Date.now() + msOut;

    SE.position = {
      ceKey: ce.key, peKey: pe.key,
      entrySpot: spot, entryTime: new Date().toISOString(),
      lots: calcLots, tp: SE.tp, sl: SE.sl,
      ceClosed: false, peClosed: false,
      ceOid, peOid, exitDeadlineTs,
      ceQuotedPrice: ce.ltp, peQuotedPrice: pe.ltp,   // pre-order LTP (indicative)
      ceEntryPrice: null, peEntryPrice: null,         // filled in below once confirmed
      ceExitPrice: null, peExitPrice: null,
    };
    seLg(`✅ ENTERED: ${atm}CE (order ${ceOid}) + ${atm}PE (order ${peOid}) × ${calcLots} lots @ spot ${spot}`, 's');
    seLg(`TP: spot ±${SE.tp}pts | SL: spot ±${SE.sl}pts`, 'i');

    // Confirm ACTUAL fill prices from the broker, in the background — this
    // must not delay seStartMonitor()/the exit timer below, since the whole
    // strategy depends on watching the position within milliseconds of entry.
    (async () => {
      const [ceFill, peFill] = await Promise.all([
        waitFill(ceOid).catch(e => { seLg(`CE fill confirm failed: ${e.message}`, 'w'); return null; }),
        waitFill(peOid).catch(e => { seLg(`PE fill confirm failed: ${e.message}`, 'w'); return null; }),
      ]);
      seRecordFill(ceOid, 'ceEntryPrice', ceFill);
      seRecordFill(peOid, 'peEntryPrice', peFill);
      seLg(`📋 Entry fills confirmed: CE ₹${ceFill ?? '?'} | PE ₹${peFill ?? '?'}`, 'i');
    })();

    // Start 500ms monitor
    seStartMonitor();
    setTimeout(() => seTimeExit(), msOut);
    seLg(`Time exit in ${(msOut/1000).toFixed(0)}s`, 'i');

  } catch(e) { seLg('Entry error: ' + e.message, 'e'); }
}

function seStartMonitor() {
  if (SE.monTimer) clearInterval(SE.monTimer);
  SE.monTimer = setInterval(async () => {
    if (!SE.position) { clearInterval(SE.monTimer); SE.monTimer = null; return; }
    if (SE.position.ceClosed && SE.position.peClosed) {
      clearInterval(SE.monTimer); SE.monTimer = null;
      seClosePosition(); return;
    }
    try {
      const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
      const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
      if (!spot) return;
      const entry  = SE.position.entrySpot;
      const upMove = spot - entry;
      const dnMove = entry - spot;
      const tp = SE.position.tp, sl = SE.position.sl;
      // CE leg
      if (!SE.position.ceClosed) {
        if (upMove >= tp) {
          seLg(`🎯 CE TP! spot=${spot} (+${upMove.toFixed(1)}pt)`, 's');
          await seCloseLeg('CE', 'TP', spot);
        } else if (dnMove >= sl) {
          seLg(`⛔ CE SL! spot=${spot} (-${dnMove.toFixed(1)}pt)`, 'e');
          await seCloseLeg('CE', 'SL', spot);
        }
      }
      // PE leg
      if (!SE.position.peClosed) {
        if (dnMove >= tp) {
          seLg(`🎯 PE TP! spot=${spot} (-${dnMove.toFixed(1)}pt)`, 's');
          await seCloseLeg('PE', 'TP', spot);
        } else if (upMove >= sl) {
          seLg(`⛔ PE SL! spot=${spot} (+${upMove.toFixed(1)}pt)`, 'e');
          await seCloseLeg('PE', 'SL', spot);
        }
      }
    } catch(_) {}
  }, 500);
}

async function seCloseLeg(leg, reason, closeSpot) {
  if (!SE.position) return;
  const key = leg === 'CE' ? SE.position.ceKey : SE.position.peKey;
  try {
    const qty    = SE.position.lots * 65;
    const oid    = await placeMarket(key, 'SELL', qty, 'D', 65);
    const tp     = SE.position.tp;
    const sl     = SE.position.sl;
    const DELTA  = 0.5;
    const LOT    = 65;
    // P&L per lot in option pts then rupees
    // TP hit → gained tp×delta opt pts | SL hit → lost sl×delta opt pts
    // Time exit → use actual spot move
    let optPnlPts;
    if (reason === 'TP') {
      optPnlPts = tp * DELTA;
    } else if (reason === 'SL') {
      optPnlPts = -(sl * DELTA);
    } else {
      // Time exit — estimate from spot move
      const entry = SE.position.entrySpot;
      const move  = leg === 'CE' ? (closeSpot - entry) : (entry - closeSpot);
      optPnlPts = Math.max(-(sl * DELTA), Math.min(tp * DELTA, move * DELTA));
    }
    const pnlRs = optPnlPts * LOT * SE.position.lots;

    if (leg === 'CE') {
      SE.position.ceClosed    = true;
      SE.position.ceReason    = reason || 'TIME';
      SE.position.cePnlPts    = optPnlPts;
      SE.position.cePnlRs     = pnlRs;
      SE.position.ceCloseSpot = closeSpot;
    } else {
      SE.position.peClosed    = true;
      SE.position.peReason    = reason || 'TIME';
      SE.position.pePnlPts    = optPnlPts;
      SE.position.pePnlRs     = pnlRs;
      SE.position.peCloseSpot = closeSpot;
    }
    seLg(`${leg} closed (${reason||'TIME'}): order ${oid} | P&L (est): ${optPnlPts > 0 ? '+' : ''}${optPnlPts.toFixed(2)} opt pts = ₹${pnlRs > 0 ? '+' : ''}${pnlRs.toFixed(0)}`, reason==='TP'?'s':'w');

    // Confirm the ACTUAL sell fill price in the background — doesn't block
    // seClosePosition()/the next scan, which must stay fast.
    (async () => {
      try {
        const fill = await waitFill(oid);
        seRecordFill(oid, leg === 'CE' ? 'ceExitPrice' : 'peExitPrice', fill);
        seLg(`📋 ${leg} exit fill confirmed: ₹${fill}`, 'i');
      } catch(e) { seLg(`${leg} exit fill confirm failed: ${e.message}`, 'w'); }
    })();
  } catch(e) { seLg(`${leg} close error: ${e.message}`, 'e'); }
}

async function seTimeExit() {
  if (!SE.position) return;
  seLg('⏱ Time exit — closing open legs', 'w');
  const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050').catch(()=>null);
  const spot = sd ? parseFloat(Object.values(sd?.data||{})[0]?.last_price) : SE.position.entrySpot;
  if (!SE.position.ceClosed) await seCloseLeg('CE', 'TIME', spot);
  await sleep(400);
  if (!SE.position.peClosed) await seCloseLeg('PE', 'TIME', spot);
  setTimeout(() => seClosePosition(), 1500);
}

function seClosePosition() {
  if (!SE.position) return;
  const cePnl   = SE.position.cePnlRs || 0;
  const pePnl   = SE.position.pePnlRs || 0;
  const totalRs = cePnl + pePnl - 100; // deduct ₹100 txcost
  const totalPts= (SE.position.cePnlPts||0) + (SE.position.pePnlPts||0);
  SE.position.totalPnlRs  = totalRs;
  SE.position.totalPnlPts = totalPts;
  seLg(`Trade P&L: CE${cePnl>=0?'+':''}₹${cePnl.toFixed(0)} + PE${pePnl>=0?'+':''}₹${pePnl.toFixed(0)} - ₹100 txcost = ${totalRs>=0?'+':''}₹${totalRs.toFixed(0)}`, totalRs>=0?'s':'e');
  SE.trades.unshift({ ...SE.position, closeTime: new Date().toISOString() });
  if (SE.trades.length > 300) SE.trades.pop();
  SE.position = null;
  if (SE.monTimer) { clearInterval(SE.monTimer); SE.monTimer = null; }
  seLg(`Position closed. Trades today: ${SE.trades.length}`, 's');
}

// ══════════════════════════════════════════════════════════
// BANKNIFTY STRADDLE ENGINE — separate parallel instance, same
// logic as the NIFTY straddle engine above, with lot size 30 and
// monthly-only expiry instead of 65 and weekly.
// ══════════════════════════════════════════════════════════
const SE_BN_FACTORY_DEFAULTS = {
  tp: 8, sl: 4, volThr: 1.0, lots: 6, autoLots: true, deployPct: 95, floorPrem: 50,
  trendPts: 10, trendOffsetMin: 2,   // trend filter: |spot - open[x-trendOffsetMin]| >= trendPts. trendPts:0 disables it.
  exitOffsetMin: 4,   // hard time-exit at second 57 of candle (x + exitOffsetMin), x = the signal-check candle
};

const SE_BN = {
  active:      false,   // master on/off (whether the loop is currently armed to trade)
  tp:          SE_BN_FACTORY_DEFAULTS.tp,
  sl:          SE_BN_FACTORY_DEFAULTS.sl,
  volThr:      SE_BN_FACTORY_DEFAULTS.volThr,
  lots:        SE_BN_FACTORY_DEFAULTS.lots,
  autoLots:    SE_BN_FACTORY_DEFAULTS.autoLots,
  deployPct:   SE_BN_FACTORY_DEFAULTS.deployPct,
  floorPrem:   SE_BN_FACTORY_DEFAULTS.floorPrem,
  trendPts:       SE_BN_FACTORY_DEFAULTS.trendPts,
  trendOffsetMin: SE_BN_FACTORY_DEFAULTS.trendOffsetMin,
  exitOffsetMin:  SE_BN_FACTORY_DEFAULTS.exitOffsetMin,
  checkTimer:  null,    // setInterval for minute checks
  monTimer:    null,    // setInterval for position monitor (500ms)
  position:    null,    // active position {ceKey,peKey,entrySpot,ceClosed,peClosed,lots,tp,sl,exitDeadlineTs}
  trades:      [],      // today's completed trades
  log:         [],      // today's engine log lines
  dateStr:     null,    // IST date (YYYY-MM-DD) this trades/log belong to
  stoppedToday: false,  // true once user explicitly hits OFF — blocks auto-start for the rest of THIS date only
};

// IST calendar date as YYYY-MM-DD — the day boundary used for log/trade resets
// ── Persist today's position/trades/log so a VM restart doesn't lose them ──
function seBnSaveState() {
  try {
    fs.writeFileSync(SE_BN_STATE_FILE, JSON.stringify({
      active: SE_BN.active, dateStr: SE_BN.dateStr, stoppedToday: SE_BN.stoppedToday,
      tp: SE_BN.tp, sl: SE_BN.sl, volThr: SE_BN.volThr, lots: SE_BN.lots,
      autoLots: SE_BN.autoLots, deployPct: SE_BN.deployPct, floorPrem: SE_BN.floorPrem,
      trendPts: SE_BN.trendPts, trendOffsetMin: SE_BN.trendOffsetMin, exitOffsetMin: SE_BN.exitOffsetMin,
      position: SE_BN.position, trades: SE_BN.trades, log: SE_BN.log,
    }));
  } catch(e) { console.error('seBnSaveState:', e.message); }
}

// ── Restore on boot. Same IST date → resume trades/log/position/active-scanning
//    as-is. Different (or missing) date → fresh day, keep params only.
function seBnLoadState() {
  const today = seTodayStr();
  try {
    if (fs.existsSync(SE_BN_STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SE_BN_STATE_FILE, 'utf8'));
      Object.assign(SE_BN, {
        tp: saved.tp ?? SE_BN.tp, sl: saved.sl ?? SE_BN.sl, volThr: saved.volThr ?? SE_BN.volThr,
        lots: saved.lots ?? SE_BN.lots, autoLots: saved.autoLots ?? SE_BN.autoLots,
        deployPct: saved.deployPct ?? SE_BN.deployPct, floorPrem: saved.floorPrem ?? SE_BN.floorPrem,
        trendPts: saved.trendPts ?? SE_BN.trendPts, trendOffsetMin: saved.trendOffsetMin ?? SE_BN.trendOffsetMin,
        exitOffsetMin: saved.exitOffsetMin ?? SE_BN.exitOffsetMin,
      });
      if (saved.dateStr === today) {
        SE_BN.dateStr      = today;
        SE_BN.stoppedToday = !!saved.stoppedToday;
        SE_BN.trades       = Array.isArray(saved.trades) ? saved.trades : [];
        SE_BN.log          = Array.isArray(saved.log) ? saved.log : [];
        SE_BN.position     = saved.position || null;
        lg(`📂 [Straddle] Same-day state restored: ${SE_BN.trades.length} trade(s), position ${SE_BN.position ? 'OPEN' : 'none'}, wasActive=${!!saved.active}`, 'i');
        if (saved.active && !SE_BN.stoppedToday) {
          SE_BN.active = true;
          seBnScheduleNextCheck();   // resume minute-boundary scanning regardless of position
          if (SE_BN.position) {
            // A position was live at crash time — resume monitoring it too.
            seBnStartMonitor();
            const msLeft = (SE_BN.position.exitDeadlineTs || 0) - Date.now();
            if (msLeft > 0) {
              setTimeout(() => seBnTimeExit(), msLeft);
              lg(`⏱ [Straddle] Exit timer restored (${Math.floor(msLeft/1000)}s)`, 'i');
            } else {
              lg('⚠️ [Straddle] Exit time already passed during downtime — closing now', 'w');
              seBnTimeExit();
            }
          }
        }
      } else {
        // New day — fresh trades/log, but remember params.
        SE_BN.dateStr = today; SE_BN.stoppedToday = false; SE_BN.trades = []; SE_BN.log = []; SE_BN.position = null;
      }
    } else {
      SE_BN.dateStr = today;
    }
  } catch(e) {
    console.error('seBnLoadState:', e.message);
    SE_BN.dateStr = today;
  }
}

// ── Persisted default params (separate from today's state — these are the
//    baseline used every morning / every restart until the app pushes new ones) ──
function seBnSaveDefaults(d) {
  try { fs.writeFileSync(SE_BN_DEFAULTS_FILE, JSON.stringify(d)); } catch(e) { console.error('seBnSaveDefaults:', e.message); }
}
function seBnLoadDefaults() {
  try {
    if (fs.existsSync(SE_BN_DEFAULTS_FILE)) return { ...SE_BN_FACTORY_DEFAULTS, ...JSON.parse(fs.readFileSync(SE_BN_DEFAULTS_FILE, 'utf8')) };
  } catch(e) { console.error('seBnLoadDefaults:', e.message); }
  return { ...SE_BN_FACTORY_DEFAULTS };
}

function seBnLg(msg, type='i') {
  const ts  = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'});
  const line = `[${ts}] ${msg}`;
  SE_BN.log.unshift(line);
  if (SE_BN.log.length > 3000) SE_BN.log.pop();  // generous full-trading-day cap, resets to [] on day rollover
  lg(`[Straddle] ${msg}`, type);
  seBnSaveState();
}

function seBnIsMarket() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm >= 9 * 60 + 20 && hhmm <= 15 * 60 + 25;
}

function seBnStart(params = {}) {
  const today = seTodayStr();
  if (SE_BN.dateStr !== today) { SE_BN.dateStr = today; SE_BN.trades = []; SE_BN.log = []; SE_BN.position = null; }
  SE_BN.stoppedToday = false;   // explicit (or auto) start always clears today's manual-stop flag
  if (SE_BN.active) { seBnLg('Already active', 'w'); return; }
  Object.assign(SE_BN, {
    active: true,
    tp:        params.tp        || SE_BN.tp,
    sl:        params.sl        || SE_BN.sl,
    volThr:    params.volThr    || SE_BN.volThr,
    lots:      params.lots      || SE_BN.lots,
    autoLots:  params.autoLots  !== undefined ? params.autoLots : SE_BN.autoLots,
    deployPct: params.deployPct || SE_BN.deployPct,
    floorPrem: params.floorPrem || SE_BN.floorPrem,
    trendPts:       params.trendPts       ?? SE_BN.trendPts,
    trendOffsetMin: params.trendOffsetMin ?? SE_BN.trendOffsetMin,
    exitOffsetMin:  params.exitOffsetMin  ?? SE_BN.exitOffsetMin,
  });
  // Enforce mutual exclusion here (not just in the HTTP route) so this also
  // applies on auto-start via token push, not only a manual toggle press.
  // Only one of NIFTY straddle / BankNifty straddle / SR runs at a time.
  if (ST.srActive) {
    ST.srActive = false;
    lg('SR deactivated — straddle engine started', 'w');
  }
  if (SE.active) {
    seStop('BankNifty straddle activated');
  }
  if (SM.active) {
    smStop('BankNifty straddle activated');
  }
  if (SM_BN.active) {
    smBnStop('BankNifty straddle activated');
  }
  saveState();
  seBnLg(`Straddle engine started — TP=${SE_BN.tp}pt SL=${SE_BN.sl}pt Vol≥${SE_BN.volThr}×`, 's');
  seBnScheduleNextCheck();
}

function seBnStop(reason = 'Manual') {
  SE_BN.active = false;
  SE_BN.stoppedToday = true;   // blocks auto-resume (token re-push, VM restart) for the REST OF TODAY only
  if (SE_BN.checkTimer) { clearTimeout(SE_BN.checkTimer); SE_BN.checkTimer = null; }
  if (SE_BN.monTimer)   { clearInterval(SE_BN.monTimer);  SE_BN.monTimer   = null; }
  seBnLg(`Straddle engine stopped (${reason})`, 'w');
  // Note: SR is NOT auto-reactivated here anymore — SR is off by default now,
  // same as straddle used to require an explicit ON. If you want SR running,
  // turn it on explicitly from the SR tab.
}

// BankNifty straddle is opt-in EVERY day, same treatment as SR — it never
// auto-starts on token push. This only rolls the day boundary over (fresh
// trades/log, active reset to off) for the case where the VM stays up
// overnight without restarting, so seBnLoadState()'s own day-check never
// runs. Mirrors srResetIfNewDay(); SMA-NIFTY is the only strategy that's
// on-by-default — see smAutoStartIfNeeded().
function seBnResetIfNewDay() {
  const today = seTodayStr();
  if (SE_BN.dateStr !== today) {
    SE_BN.dateStr = today; SE_BN.trades = []; SE_BN.log = [];
    SE_BN.position = null; SE_BN.stoppedToday = false; SE_BN.active = false;
    seBnSaveState();
  }
}

function seBnScheduleNextCheck() {
  if (!SE_BN.active) return;
  // Fire at second 50 of each minute
  const now  = new Date();
  const secs = now.getSeconds();
  const ms   = now.getMilliseconds();
  const msTo50 = secs < 50
    ? (50 - secs) * 1000 - ms
    : (60 - secs + 50) * 1000 - ms;
  SE_BN.checkTimer = setTimeout(async () => {
    if (SE_BN.active) {
      await seBnCheck();
      seBnScheduleNextCheck();
    }
  }, msTo50);
}

async function seBnCheck() {
  if (!SE_BN.active || SE_BN.position) return;
  if (!ST.token) { seBnLg('No token — skip', 'w'); return; }
  if (!seBnIsMarket()) { seBnLg('Outside market hours', 'i'); return; }

  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = `${ist.getUTCHours()}:${String(ist.getUTCMinutes()).padStart(2,'0')}:${String(ist.getUTCSeconds()).padStart(2,'0')}`;
  seBnLg(`Signal check at ${hhmm}`);

  try {
    // 1. Get NIFTY spot + prev candle range
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
    if (!spot) { seBnLg('Spot unavailable', 'w'); return; }
    seBnLg(`BANKNIFTY spot: ${spot}`);

    // 1b. Trend filter — only proceed to the (expensive, 9-call) volume check
    // if spot has also moved trendPts away from the open of the candle
    // trendOffsetMin minutes ago. Selects for "there's a trend right now",
    // not just a volume blip. trendPts:0 disables this gate entirely.
    //
    // "x-2" means: this check is evaluating minute X (right now, at :50
    // seconds past its start) — the reference is the OPEN of minute X-2,
    // i.e. two minutes before the start of the CURRENT minute, not two
    // minutes before "now". Matched by actual candle timestamp, not by
    // array position, so this can't silently drift if the API's ordering
    // or inclusion of the still-forming candle ever changes.
    if (SE_BN.trendPts > 0) {
      const td = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%20Bank/1minute');
      const tcandles = td?.data?.candles || [];
      const xStartMs  = Math.floor(Date.now() / 60000) * 60000;         // start of minute X (IST and UTC minute boundaries coincide — 5:30 offset is a whole number of minutes)
      const targetMs  = xStartMs - SE_BN.trendOffsetMin * 60000;            // start of minute X-trendOffsetMin
      let refCandle = null, refTs = null;
      for (const cnd of tcandles) {
        const cndMs = new Date(cnd[0]).getTime();
        if (Math.abs(cndMs - targetMs) < 30000) { refCandle = cnd; refTs = cnd[0]; break; }  // 30s tolerance for candle-boundary rounding
      }
      if (!refCandle) { seBnLg(`Trend filter: no candle found for x-${SE_BN.trendOffsetMin} (need more history, or market just opened) — skip`, 'w'); return; }
      const refOpen = parseFloat(refCandle[1]);
      const trendMove = spot - refOpen;
      seBnLg(`Trend check: spot ${spot} vs open ${SE_BN.trendOffsetMin}min ago [${refTs}] = ${refOpen} → ${trendMove>=0?'+':''}${trendMove.toFixed(1)}pts (need ±${SE_BN.trendPts})`);
      if (Math.abs(trendMove) < SE_BN.trendPts) {
        seBnLg(`Trend ${Math.abs(trendMove).toFixed(1)} < ${SE_BN.trendPts} — no signal`);
        return;
      }
      seBnLg(`✅ Trend confirmed: ${trendMove>=0?'+':''}${trendMove.toFixed(1)}pts vs ${SE_BN.trendOffsetMin}min ago`, 's');
    }

    // 2. Get weighted vol ratio across 9 stocks
    const STOCKS = [
      ['HDFCBANK',   'NSE_EQ%7CINE040A01034', 0.130],
      ['RELIANCE',   'NSE_EQ%7CINE002A01018', 0.090],
      ['ICICIBANK',  'NSE_EQ%7CINE090A01021', 0.080],
      ['INFY',       'NSE_EQ%7CINE009A01021', 0.060],
      ['TCS',        'NSE_EQ%7CINE467B01029', 0.050],
      ['LT',         'NSE_EQ%7CINE018A01030', 0.040],
      ['AXISBANK',   'NSE_EQ%7CINE238A01034', 0.040],
      ['HINDUNILVR', 'NSE_EQ%7CINE030A01027', 0.030],
      ['SBIN',       'NSE_EQ%7CINE062A01020', 0.030],
    ];
    let wVol = 0, totalW = 0;
    const stockDetails = [];
    for (const [sym, key, w] of STOCKS) {
      try {
        const cd = await upstox(`/v2/historical-candle/intraday/${key}/1minute`);
        const candles = (cd?.data?.candles || []).reverse();
        if (candles.length < 2) continue;
        const curVol = parseFloat(candles[candles.length-1][5]) || 0;
        const prior  = candles.slice(Math.max(0, candles.length-121), candles.length-1);
        const avgVol = prior.length > 0
          ? prior.reduce((s,c) => s + (parseFloat(c[5])||0), 0) / prior.length : 0;
        const ratio  = avgVol > 0 ? curVol / avgVol : 1;
        wVol += ratio * w; totalW += w;
        stockDetails.push(`${sym} ${ratio.toFixed(2)}×`);
        await sleep(120); // rate limit
      } catch(_) {}
    }
    const wvr = totalW > 0 ? wVol / totalW : 0;
    seBnLg(`Weighted vol ratio: ${wvr.toFixed(2)}× | threshold: ${SE_BN.volThr}×`);

    if (wvr < SE_BN.volThr) { seBnLg(`Vol ${wvr.toFixed(2)} < ${SE_BN.volThr} — no signal`); return; }
    seBnLg(`✅ VOL SURGE: ${wvr.toFixed(2)}× — entering straddle at next minute open!`, 's');
    seBnLg(`   Per-stock: ${stockDetails.join(', ')}`, 'i');

    // 3. Schedule entry at next minute open (~second 0)
    const now2 = new Date();
    const msToNext = (60 - now2.getSeconds()) * 1000 - now2.getMilliseconds() + 200;
    setTimeout(() => seBnEnter(spot), msToNext);
    seBnLg(`Entry in ${(msToNext/1000).toFixed(1)}s`, 'i');

  } catch(e) { seBnLg('Check error: ' + e.message, 'e'); }
}

// Patches a confirmed fill price wherever the order actually lives right
// now — the live position, or (if it already closed by the time the fill
// confirmation comes back) the archived trade in SE_BN.trades. Decoupled from
// timing on purpose: fill confirmation can take several seconds and must
// never block entry/exit/monitoring.
function seBnRecordFill(oid, field, price) {
  if (price == null) return;
  if (SE_BN.position && (SE_BN.position.ceOid === oid || SE_BN.position.peOid === oid)) {
    SE_BN.position[field] = price;
  }
  const t = SE_BN.trades.find(x => x.ceOid === oid || x.peOid === oid);
  if (t) t[field] = price;
  seBnSaveState();
}

async function seBnEnter(signalSpot) {
  if (!SE_BN.active || SE_BN.position) return;
  try {
    seBnLg('Placing straddle...', 'w');
    // Fresh spot at entry
    const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price) || signalSpot;
    const atm  = Math.round(spot / 100) * 100;

    // Auto-lots
    let calcLots = SE_BN.lots;
    if (SE_BN.autoLots) {
      try {
        const funds      = await getAvailableFunds();
        const deployable = funds * SE_BN.deployPct / 100;
        const expiry2    = await getLiveExpiry('BN');
        const ce2        = await findInstrument(expiry2, atm, 'CE', 'BN');
        const pe2        = await findInstrument(expiry2, atm, 'PE', 'BN');
        const effCe      = (SE_BN.floorPrem > 0 && ce2.ltp < SE_BN.floorPrem) ? SE_BN.floorPrem : ce2.ltp;
        const effPe      = (SE_BN.floorPrem > 0 && pe2.ltp < SE_BN.floorPrem) ? SE_BN.floorPrem : pe2.ltp;
        const costPerLot = (effCe + effPe) * 30;
        if (costPerLot > 0) {
          calcLots = Math.max(1, Math.floor(deployable / costPerLot));
          seBnLg(`💰 Balance ₹${funds.toFixed(0)} | ${SE_BN.deployPct}% → ₹${deployable.toFixed(0)} | cost/lot ₹${costPerLot.toFixed(0)} → ${calcLots} lots`, 's');
        }
      } catch(e) { seBnLg('Auto-lots failed: ' + e.message + ' — using ' + calcLots, 'w'); }
    }

    const expiry = await getLiveExpiry('BN');
    const ce     = await findInstrument(expiry, atm, 'CE', 'BN');
    const pe     = await findInstrument(expiry, atm, 'PE', 'BN');
    const qty    = calcLots * 30;

    seBnLg(`📐 Quoted premiums before order: CE ₹${ce.ltp} | PE ₹${pe.ltp}`, 'i');

    const ceOid = await placeMarket(ce.key, 'BUY', qty, 'D', 30);
    await sleep(400);
    const peOid = await placeMarket(pe.key, 'BUY', qty, 'D', 30);

    // Time exit: second 57 of candle (x + exitOffsetMin), x = the signal
    // candle this entry came from — stored as an ABSOLUTE timestamp (not
    // just a setTimeout) so a VM restart mid-position can recompute the
    // remaining wait correctly instead of losing the deadline.
    const now3 = new Date();
    const extraMin = Math.max(0, SE_BN.exitOffsetMin - 2);   // exitOffsetMin=2 reproduces the original timing exactly
    const msOut = (60 - now3.getSeconds() + 57) % 60 * 1000 + 60000 + 200 + extraMin * 60000;
    const exitDeadlineTs = Date.now() + msOut;

    SE_BN.position = {
      ceKey: ce.key, peKey: pe.key,
      entrySpot: spot, entryTime: new Date().toISOString(),
      lots: calcLots, tp: SE_BN.tp, sl: SE_BN.sl,
      ceClosed: false, peClosed: false,
      ceOid, peOid, exitDeadlineTs,
      ceQuotedPrice: ce.ltp, peQuotedPrice: pe.ltp,   // pre-order LTP (indicative)
      ceEntryPrice: null, peEntryPrice: null,         // filled in below once confirmed
      ceExitPrice: null, peExitPrice: null,
    };
    seBnLg(`✅ ENTERED: ${atm}CE (order ${ceOid}) + ${atm}PE (order ${peOid}) × ${calcLots} lots @ spot ${spot}`, 's');
    seBnLg(`TP: spot ±${SE_BN.tp}pts | SL: spot ±${SE_BN.sl}pts`, 'i');

    // Confirm ACTUAL fill prices from the broker, in the background — this
    // must not delay seBnStartMonitor()/the exit timer below, since the whole
    // strategy depends on watching the position within milliseconds of entry.
    (async () => {
      const [ceFill, peFill] = await Promise.all([
        waitFill(ceOid).catch(e => { seBnLg(`CE fill confirm failed: ${e.message}`, 'w'); return null; }),
        waitFill(peOid).catch(e => { seBnLg(`PE fill confirm failed: ${e.message}`, 'w'); return null; }),
      ]);
      seBnRecordFill(ceOid, 'ceEntryPrice', ceFill);
      seBnRecordFill(peOid, 'peEntryPrice', peFill);
      seBnLg(`📋 Entry fills confirmed: CE ₹${ceFill ?? '?'} | PE ₹${peFill ?? '?'}`, 'i');
    })();

    // Start 500ms monitor
    seBnStartMonitor();
    setTimeout(() => seBnTimeExit(), msOut);
    seBnLg(`Time exit in ${(msOut/1000).toFixed(0)}s`, 'i');

  } catch(e) { seBnLg('Entry error: ' + e.message, 'e'); }
}

function seBnStartMonitor() {
  if (SE_BN.monTimer) clearInterval(SE_BN.monTimer);
  SE_BN.monTimer = setInterval(async () => {
    if (!SE_BN.position) { clearInterval(SE_BN.monTimer); SE_BN.monTimer = null; return; }
    if (SE_BN.position.ceClosed && SE_BN.position.peClosed) {
      clearInterval(SE_BN.monTimer); SE_BN.monTimer = null;
      seBnClosePosition(); return;
    }
    try {
      const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
      const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
      if (!spot) return;
      const entry  = SE_BN.position.entrySpot;
      const upMove = spot - entry;
      const dnMove = entry - spot;
      const tp = SE_BN.position.tp, sl = SE_BN.position.sl;
      // CE leg
      if (!SE_BN.position.ceClosed) {
        if (upMove >= tp) {
          seBnLg(`🎯 CE TP! spot=${spot} (+${upMove.toFixed(1)}pt)`, 's');
          await seBnCloseLeg('CE', 'TP', spot);
        } else if (dnMove >= sl) {
          seBnLg(`⛔ CE SL! spot=${spot} (-${dnMove.toFixed(1)}pt)`, 'e');
          await seBnCloseLeg('CE', 'SL', spot);
        }
      }
      // PE leg
      if (!SE_BN.position.peClosed) {
        if (dnMove >= tp) {
          seBnLg(`🎯 PE TP! spot=${spot} (-${dnMove.toFixed(1)}pt)`, 's');
          await seBnCloseLeg('PE', 'TP', spot);
        } else if (upMove >= sl) {
          seBnLg(`⛔ PE SL! spot=${spot} (+${upMove.toFixed(1)}pt)`, 'e');
          await seBnCloseLeg('PE', 'SL', spot);
        }
      }
    } catch(_) {}
  }, 500);
}

async function seBnCloseLeg(leg, reason, closeSpot) {
  if (!SE_BN.position) return;
  const key = leg === 'CE' ? SE_BN.position.ceKey : SE_BN.position.peKey;
  try {
    const qty    = SE_BN.position.lots * 30;
    const oid    = await placeMarket(key, 'SELL', qty, 'D', 30);
    const tp     = SE_BN.position.tp;
    const sl     = SE_BN.position.sl;
    const DELTA  = 0.5;
    const LOT    = 30;
    // P&L per lot in option pts then rupees
    // TP hit → gained tp×delta opt pts | SL hit → lost sl×delta opt pts
    // Time exit → use actual spot move
    let optPnlPts;
    if (reason === 'TP') {
      optPnlPts = tp * DELTA;
    } else if (reason === 'SL') {
      optPnlPts = -(sl * DELTA);
    } else {
      // Time exit — estimate from spot move
      const entry = SE_BN.position.entrySpot;
      const move  = leg === 'CE' ? (closeSpot - entry) : (entry - closeSpot);
      optPnlPts = Math.max(-(sl * DELTA), Math.min(tp * DELTA, move * DELTA));
    }
    const pnlRs = optPnlPts * LOT * SE_BN.position.lots;

    if (leg === 'CE') {
      SE_BN.position.ceClosed    = true;
      SE_BN.position.ceReason    = reason || 'TIME';
      SE_BN.position.cePnlPts    = optPnlPts;
      SE_BN.position.cePnlRs     = pnlRs;
      SE_BN.position.ceCloseSpot = closeSpot;
    } else {
      SE_BN.position.peClosed    = true;
      SE_BN.position.peReason    = reason || 'TIME';
      SE_BN.position.pePnlPts    = optPnlPts;
      SE_BN.position.pePnlRs     = pnlRs;
      SE_BN.position.peCloseSpot = closeSpot;
    }
    seBnLg(`${leg} closed (${reason||'TIME'}): order ${oid} | P&L (est): ${optPnlPts > 0 ? '+' : ''}${optPnlPts.toFixed(2)} opt pts = ₹${pnlRs > 0 ? '+' : ''}${pnlRs.toFixed(0)}`, reason==='TP'?'s':'w');

    // Confirm the ACTUAL sell fill price in the background — doesn't block
    // seBnClosePosition()/the next scan, which must stay fast.
    (async () => {
      try {
        const fill = await waitFill(oid);
        seBnRecordFill(oid, leg === 'CE' ? 'ceExitPrice' : 'peExitPrice', fill);
        seBnLg(`📋 ${leg} exit fill confirmed: ₹${fill}`, 'i');
      } catch(e) { seBnLg(`${leg} exit fill confirm failed: ${e.message}`, 'w'); }
    })();
  } catch(e) { seBnLg(`${leg} close error: ${e.message}`, 'e'); }
}

async function seBnTimeExit() {
  if (!SE_BN.position) return;
  seBnLg('⏱ Time exit — closing open legs', 'w');
  const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank').catch(()=>null);
  const spot = sd ? parseFloat(Object.values(sd?.data||{})[0]?.last_price) : SE_BN.position.entrySpot;
  if (!SE_BN.position.ceClosed) await seBnCloseLeg('CE', 'TIME', spot);
  await sleep(400);
  if (!SE_BN.position.peClosed) await seBnCloseLeg('PE', 'TIME', spot);
  setTimeout(() => seBnClosePosition(), 1500);
}

function seBnClosePosition() {
  if (!SE_BN.position) return;
  const cePnl   = SE_BN.position.cePnlRs || 0;
  const pePnl   = SE_BN.position.pePnlRs || 0;
  const totalRs = cePnl + pePnl - 100; // deduct ₹100 txcost
  const totalPts= (SE_BN.position.cePnlPts||0) + (SE_BN.position.pePnlPts||0);
  SE_BN.position.totalPnlRs  = totalRs;
  SE_BN.position.totalPnlPts = totalPts;
  seBnLg(`Trade P&L: CE${cePnl>=0?'+':''}₹${cePnl.toFixed(0)} + PE${pePnl>=0?'+':''}₹${pePnl.toFixed(0)} - ₹100 txcost = ${totalRs>=0?'+':''}₹${totalRs.toFixed(0)}`, totalRs>=0?'s':'e');
  SE_BN.trades.unshift({ ...SE_BN.position, closeTime: new Date().toISOString() });
  if (SE_BN.trades.length > 300) SE_BN.trades.pop();
  SE_BN.position = null;
  if (SE_BN.monTimer) { clearInterval(SE_BN.monTimer); SE_BN.monTimer = null; }
  seBnLg(`Position closed. Trades today: ${SE_BN.trades.length}`, 's');
}

// ══════════════════════════════════════════════════════════
// SMA CROSSOVER ENGINE (NIFTY) — separate strategy from the
// straddle engine. Watches for spot crossing its own SMA and
// staying on the new side for a confirmation window, then buys
// a single directional leg (CE or PE, not a straddle).
// ══════════════════════════════════════════════════════════
const SM_STATE_FILE    = '/home/ubuntu/engine-sm-state.json';
const SM_DEFAULTS_FILE = '/home/ubuntu/engine-sm-defaults.json';

const SM_FACTORY_DEFAULTS = {
  smaLen: 120,       // SMA period in 1-min candles (today's candles only; fewer used if fewer available)
  confirmMin: 10,    // minutes spot must stay on the new side of the SMA before entry
  otmSteps: 0,       // 0 = ATM; N = N strikes OTM (CE: strike+N*step, PE: strike-N*step)
  target: 20,        // index points
  stopLoss: 10,      // index points
  hardCloseMin: 15,  // force-exit this many minutes after entry regardless
  lots: 6, autoLots: true, deployPct: 95, floorPrem: 50,
};

const SM = {
  active: false,
  smaLen: SM_FACTORY_DEFAULTS.smaLen, confirmMin: SM_FACTORY_DEFAULTS.confirmMin,
  otmSteps: SM_FACTORY_DEFAULTS.otmSteps, target: SM_FACTORY_DEFAULTS.target,
  stopLoss: SM_FACTORY_DEFAULTS.stopLoss, hardCloseMin: SM_FACTORY_DEFAULTS.hardCloseMin,
  lots: SM_FACTORY_DEFAULTS.lots, autoLots: SM_FACTORY_DEFAULTS.autoLots,
  deployPct: SM_FACTORY_DEFAULTS.deployPct, floorPrem: SM_FACTORY_DEFAULTS.floorPrem,

  checkTimer: null, monTimer: null,
  state: 'idle',          // idle | tracking
  trackDir: null,         // 'above' | 'below' — side being confirmed while tracking
  trackMinutesConfirmed: 0,
  lastSide: null,         // side as of the previous minute's check, for crossover detection

  position: null,         // {type:'CE'|'PE', key, strike, entrySpot, entryTime, lots, target, stopLoss, oid, quotedPrice, entryPrice, exitDeadlineTs}
  trades: [], log: [], dateStr: null, stoppedToday: false,
};

function smSaveState() {
  try {
    fs.writeFileSync(SM_STATE_FILE, JSON.stringify({
      active: SM.active, dateStr: SM.dateStr, stoppedToday: SM.stoppedToday,
      smaLen: SM.smaLen, confirmMin: SM.confirmMin, otmSteps: SM.otmSteps,
      target: SM.target, stopLoss: SM.stopLoss, hardCloseMin: SM.hardCloseMin,
      lots: SM.lots, autoLots: SM.autoLots, deployPct: SM.deployPct, floorPrem: SM.floorPrem,
      state: SM.state, trackDir: SM.trackDir, trackMinutesConfirmed: SM.trackMinutesConfirmed,
      lastSide: SM.lastSide, position: SM.position, trades: SM.trades, log: SM.log,
    }));
  } catch(e) { console.error('smSaveState:', e.message); }
}

function smLoadState() {
  const today = seTodayStr();   // shared IST-date helper, already defined for the straddle engine
  try {
    if (fs.existsSync(SM_STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SM_STATE_FILE, 'utf8'));
      Object.assign(SM, {
        smaLen: saved.smaLen ?? SM.smaLen, confirmMin: saved.confirmMin ?? SM.confirmMin,
        otmSteps: saved.otmSteps ?? SM.otmSteps, target: saved.target ?? SM.target,
        stopLoss: saved.stopLoss ?? SM.stopLoss, hardCloseMin: saved.hardCloseMin ?? SM.hardCloseMin,
        lots: saved.lots ?? SM.lots, autoLots: saved.autoLots ?? SM.autoLots,
        deployPct: saved.deployPct ?? SM.deployPct, floorPrem: saved.floorPrem ?? SM.floorPrem,
      });
      if (saved.dateStr === today) {
        SM.dateStr = today;
        SM.stoppedToday = !!saved.stoppedToday;
        SM.trades = Array.isArray(saved.trades) ? saved.trades : [];
        SM.log    = Array.isArray(saved.log) ? saved.log : [];
        SM.state  = saved.state || 'idle';
        SM.trackDir = saved.trackDir || null;
        SM.trackMinutesConfirmed = saved.trackMinutesConfirmed || 0;
        SM.lastSide = saved.lastSide || null;
        SM.position = saved.position || null;
        lg(`📂 [SMA] Same-day state restored: ${SM.trades.length} trade(s), state=${SM.state}, position ${SM.position ? 'OPEN' : 'none'}, wasActive=${!!saved.active}`, 'i');
        if (saved.active && !SM.stoppedToday) {
          SM.active = true;
          smScheduleNextCheck();
          if (SM.position) {
            smStartMonitor();
            const msLeft = (SM.position.exitDeadlineTs || 0) - Date.now();
            if (msLeft > 0) {
              setTimeout(() => smTimeExit(), msLeft);
              lg(`⏱ [SMA] Exit timer restored (${Math.floor(msLeft/1000)}s)`, 'i');
            } else {
              lg('⚠️ [SMA] Exit time already passed during downtime — closing now', 'w');
              smTimeExit();
            }
          }
        }
      } else {
        SM.dateStr = today; SM.stoppedToday = false; SM.trades = []; SM.log = [];
        SM.state = 'idle'; SM.trackDir = null; SM.trackMinutesConfirmed = 0; SM.lastSide = null; SM.position = null;
      }
    } else {
      SM.dateStr = today;
    }
  } catch(e) {
    console.error('smLoadState:', e.message);
    SM.dateStr = today;
  }
}

function smSaveDefaults(d) {
  try { fs.writeFileSync(SM_DEFAULTS_FILE, JSON.stringify(d)); } catch(e) { console.error('smSaveDefaults:', e.message); }
}
function smLoadDefaults() {
  try {
    if (fs.existsSync(SM_DEFAULTS_FILE)) return { ...SM_FACTORY_DEFAULTS, ...JSON.parse(fs.readFileSync(SM_DEFAULTS_FILE, 'utf8')) };
  } catch(e) { console.error('smLoadDefaults:', e.message); }
  return { ...SM_FACTORY_DEFAULTS };
}

function smLg(msg, type='i') {
  const ts = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'});
  SM.log.unshift(`[${ts}] ${msg}`);
  if (SM.log.length > 3000) SM.log.pop();
  lg(`[SMA] ${msg}`, type);
  smSaveState();
}

// General market hours — same window the other engines use. Checking,
// logging, and continuing any ALREADY-IN-PROGRESS tracking all run
// throughout this whole window, no exceptions — freezing mid-tracking is
// exactly the bug this used to have.
function smIsMarket() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm >= 9*60+16 && hhmm <= 15*60+25;
}

// Separate, narrower check used ONLY at the moment a FRESH crossover would
// start a new tracking cycle — not for continuing one already in progress.
// A cycle needs confirmMin + 1(entry delay) + hardCloseMin minutes to
// possibly play out; this just makes sure there's still enough of the day
// left for that, measured against the same 15:25 close the rest of the
// engine uses (not an earlier, arbitrary cutoff).
function smCanStartNewCycle() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm <= (15*60+25) - (SM.confirmMin + 1 + SM.hardCloseMin);
}

function smStart(params = {}) {
  const today = seTodayStr();
  if (SM.dateStr !== today) {
    SM.dateStr = today; SM.trades = []; SM.log = [];
    SM.state = 'idle'; SM.trackDir = null; SM.trackMinutesConfirmed = 0; SM.lastSide = null; SM.position = null;
  }
  SM.stoppedToday = false;
  if (SM.active) { smLg('Already active', 'w'); return; }
  Object.assign(SM, {
    active: true,
    smaLen:       params.smaLen       || SM.smaLen,
    confirmMin:   params.confirmMin   || SM.confirmMin,
    otmSteps:     params.otmSteps     ?? SM.otmSteps,
    target:       params.target       || SM.target,
    stopLoss:     params.stopLoss     || SM.stopLoss,
    hardCloseMin: params.hardCloseMin || SM.hardCloseMin,
    lots:         params.lots         || SM.lots,
    autoLots:     params.autoLots     !== undefined ? params.autoLots : SM.autoLots,
    deployPct:    params.deployPct    || SM.deployPct,
    floorPrem:    params.floorPrem    || SM.floorPrem,
  });
  // Same exclusivity group as SR / straddle-NF / straddle-BN / SMA-BN
  if (ST.srActive)  { ST.srActive = false;  lg('SR deactivated — SMA engine started', 'w'); }
  if (SE.active)    { seStop('SMA engine activated'); }
  if (SE_BN.active) { seBnStop('SMA engine activated'); }
  if (SM_BN.active) { smBnStop('NIFTY SMA engine activated'); }
  saveState();
  smLg(`SMA engine started — SMA${SM.smaLen}, confirm ${SM.confirmMin}min, target ${SM.target}pt, SL ${SM.stopLoss}pt, hard-close ${SM.hardCloseMin}min`, 's');
  smScheduleNextCheck();
}

function smStop(reason = 'Manual') {
  SM.active = false;
  SM.stoppedToday = true;
  if (SM.checkTimer) { clearTimeout(SM.checkTimer); SM.checkTimer = null; }
  if (SM.monTimer)   { clearInterval(SM.monTimer);  SM.monTimer   = null; }
  smLg(`SMA engine stopped (${reason})`, 'w');
}

// SMA-NIFTY is now the always-on-by-default engine — mirrors how NIFTY
// straddle used to behave: stays on across app close/reopen and VM
// restarts, resets to "on" every new IST day unless explicitly stopped
// THAT day. Every other module (SR, NIFTY straddle, BankNifty straddle)
// is opt-in every day; selecting any of them switches this off
// automatically via the exclusivity checks in their own start functions.
function smAutoStartIfNeeded() {
  const today = seTodayStr();
  if (SM.dateStr !== today) {
    SM.dateStr = today; SM.trades = []; SM.log = [];
    SM.state = 'idle'; SM.trackDir = null; SM.trackMinutesConfirmed = 0; SM.lastSide = null;
    SM.position = null; SM.stoppedToday = false;
  }
  if (SM.active) return;
  if (SM.stoppedToday) {
    lg('[SMA] Token received — auto-start skipped (stopped by user today)', 'i');
    return;
  }
  const d = smLoadDefaults();
  lg('[SMA] Token received — auto-starting (always-on by default)', 's');
  smStart(d);
}

function smScheduleNextCheck() {
  if (!SM.active) return;
  const now  = new Date();
  const secs = now.getSeconds();
  const ms   = now.getMilliseconds();
  const msTo50 = secs < 50 ? (50 - secs) * 1000 - ms : (60 - secs + 50) * 1000 - ms;
  SM.checkTimer = setTimeout(async () => {
    if (SM.active) { await smCheck(); smScheduleNextCheck(); }
  }, msTo50);
}

// Builds the SMA window: today's candles so far, topped up with the tail
// end of the most recent previous trading day if today alone isn't enough
// yet (e.g. early morning). Walks backwards up to 7 calendar days to find
// a trading day with data (skips weekends/holidays automatically since
// those simply return empty). Returns candles oldest-to-newest, each as
// [ts, open, high, low, close, vol] to match the intraday endpoint's shape.
async function smGetSmaWindow(len) {
  const cd = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%2050/1minute');
  const todayCandles = (cd?.data?.candles || []).slice().reverse();   // API is most-recent-first; reverse -> chronological
  if (todayCandles.length >= len) return todayCandles.slice(-len);

  const needed = len - todayCandles.length;
  let prevCandles = [];
  const todayIst = new Date(Date.now() + 5.5 * 3600000);
  for (let back = 1; back <= 7 && prevCandles.length === 0; back++) {
    const d = new Date(todayIst);
    d.setUTCDate(d.getUTCDate() - back);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const dayCandles = await btGetCandles(dateStr);   // already chronological: [{time,open,high,low,close}]
      if (dayCandles.length > 0) prevCandles = dayCandles;
    } catch(_) {}
  }
  const prevTail = prevCandles.slice(-needed).map(c => [null, c.open, c.high, c.low, c.close, 0]);
  return [...prevTail, ...todayCandles];
}

async function smCheck() {
  if (!SM.active || SM.position) return;
  if (!smIsMarket()) return;
  if (!ST.token) { smLg('No token — skip', 'w'); return; }

  try {
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
    if (!spot) { smLg('Spot unavailable', 'w'); return; }

    const windowCandles = await smGetSmaWindow(SM.smaLen);
    if (windowCandles.length === 0) { smLg('No candle history yet — skip', 'w'); return; }
    const usedPrevDay = windowCandles.length >= SM.smaLen && windowCandles.some(c => c[0] === null);
    const sma = windowCandles.reduce((s, c) => s + parseFloat(c[4]), 0) / windowCandles.length;   // close = index 4
    const side = spot >= sma ? 'above' : 'below';

    smLg(`Spot ${spot} vs SMA${SM.smaLen}(${windowCandles.length} candles${usedPrevDay ? ', incl. prev day' : ''}) ${sma.toFixed(1)} → ${side}`);

    if (SM.state === 'idle') {
      if (SM.lastSide !== null && SM.lastSide !== side) {
        if (!smCanStartNewCycle()) {
          smLg(`Crossover seen (now ${side}) but too late in the day to start a fresh ${SM.confirmMin}+${SM.hardCloseMin}min cycle — skipping`, 'w');
        } else {
          SM.state = 'tracking';
          SM.trackDir = side;
          SM.trackMinutesConfirmed = 0;
          smLg(`🔀 Crossover — now ${side} SMA${SM.smaLen} — tracking ${SM.confirmMin}min for confirmation`, 's');
        }
      }
    } else if (SM.state === 'tracking') {
      if (side === SM.trackDir) {
        SM.trackMinutesConfirmed++;
        smLg(`Tracking: ${SM.trackMinutesConfirmed}/${SM.confirmMin}min confirmed ${SM.trackDir}`);
        if (SM.trackMinutesConfirmed >= SM.confirmMin) {
          smLg(`✅ Confirmed ${SM.confirmMin}min ${SM.trackDir} SMA${SM.smaLen} — entering next minute`, 's');
          const dir = SM.trackDir;
          SM.state = 'idle'; SM.trackDir = null; SM.trackMinutesConfirmed = 0;
          const now4 = new Date();
          const msToNextMin = (60 - now4.getSeconds()) * 1000 - now4.getMilliseconds() + 100;
          setTimeout(() => smEnter(dir === 'above' ? 'CE' : 'PE', spot), msToNextMin);
        }
      } else {
        smLg(`❌ Crossed back to ${side} after ${SM.trackMinutesConfirmed}/${SM.confirmMin}min — tracking reset`, 'w');
        SM.state = 'idle'; SM.trackDir = null; SM.trackMinutesConfirmed = 0;
      }
    }
    SM.lastSide = side;
    smSaveState();
  } catch(e) { smLg('Check error: ' + e.message, 'e'); }
}

function smRecordFill(oid, field, price) {
  if (price == null) return;
  if (SM.position && SM.position.oid === oid) SM.position[field] = price;
  const t = SM.trades.find(x => x.oid === oid);
  if (t) t[field] = price;
  smSaveState();
}

async function smEnter(direction, signalSpot) {
  if (!SM.active || SM.position) return;
  try {
    smLg(`Placing ${direction}...`, 'w');
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price) || signalSpot;
    const baseAtm = Math.round(spot / 50) * 50;
    const strike = direction === 'CE' ? baseAtm + SM.otmSteps*50 : baseAtm - SM.otmSteps*50;

    let calcLots = SM.lots;
    const expiry = await getLiveExpiry('NF');
    const inst = await findInstrument(expiry, strike, direction, 'NF');

    if (SM.autoLots) {
      try {
        const funds = await getAvailableFunds();
        const deployable = funds * SM.deployPct / 100;
        const effPrem = (SM.floorPrem > 0 && inst.ltp < SM.floorPrem) ? SM.floorPrem : inst.ltp;
        const costPerLot = effPrem * 65;
        if (costPerLot > 0) {
          calcLots = Math.max(1, Math.floor(deployable / costPerLot));
          smLg(`💰 Balance ₹${funds.toFixed(0)} | ${SM.deployPct}% → ₹${deployable.toFixed(0)} | cost/lot ₹${costPerLot.toFixed(0)} → ${calcLots} lots`, 's');
        }
      } catch(e) { smLg('Auto-lots failed: ' + e.message + ' — using ' + calcLots, 'w'); }
    }

    const qty = calcLots * 65;
    smLg(`📐 Quoted premium before order: ${strike}${direction} ₹${inst.ltp}`, 'i');
    const oid = await placeMarket(inst.key, 'BUY', qty, 'D', 65);

    const exitDeadlineTs = Date.now() + SM.hardCloseMin * 60000;
    SM.position = {
      type: direction, key: inst.key, strike,
      entrySpot: spot, entryTime: new Date().toISOString(),
      lots: calcLots, target: SM.target, stopLoss: SM.stopLoss,
      oid, quotedPrice: inst.ltp, entryPrice: null, exitPrice: null,
      exitDeadlineTs,
    };
    smLg(`✅ ENTERED ${strike}${direction} × ${calcLots} lots @ spot ${spot}`, 's');
    smLg(`Target: spot ${direction==='CE'?'+':'-'}${SM.target}pts | SL: spot ${direction==='CE'?'-':'+'}${SM.stopLoss}pts | hard-close ${SM.hardCloseMin}min`, 'i');

    smStartMonitor();
    setTimeout(() => smTimeExit(), SM.hardCloseMin * 60000);

    (async () => {
      const fill = await waitFill(oid).catch(e => { smLg(`Entry fill confirm failed: ${e.message}`, 'w'); return null; });
      smRecordFill(oid, 'entryPrice', fill);
      if (fill != null) smLg(`📋 Entry fill confirmed: ₹${fill}`, 'i');
    })();
  } catch(e) { smLg('Entry error: ' + e.message, 'e'); }
}

function smStartMonitor() {
  if (SM.monTimer) clearInterval(SM.monTimer);
  SM.monTimer = setInterval(async () => {
    if (!SM.position) { clearInterval(SM.monTimer); SM.monTimer = null; return; }
    try {
      const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
      const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
      if (!spot) return;
      const p = SM.position;
      const move = p.type === 'CE' ? (spot - p.entrySpot) : (p.entrySpot - spot);
      if (move >= p.target)      await smClose('TARGET', spot);
      else if (move <= -p.stopLoss) await smClose('STOPLOSS', spot);
    } catch(_) {}
  }, 500);
}

async function smClose(reason, closeSpot) {
  if (!SM.position) return;
  if (SM.monTimer) { clearInterval(SM.monTimer); SM.monTimer = null; }
  const p = SM.position;
  try {
    const qty = p.lots * 65;
    const oid = await placeMarket(p.key, 'SELL', qty, 'D', 65);
    const DELTA = 0.4;   // established NIFTY convention for rough P&L estimate — real fill confirmed separately below
    const move = p.type === 'CE' ? (closeSpot - p.entrySpot) : (p.entrySpot - closeSpot);
    const optPnlPts = move * DELTA;
    const pnlRs = optPnlPts * 65 * p.lots;

    const trade = { ...p, exitOid: oid, exitReason: reason, exitSpot: closeSpot,
                     pnlPts: optPnlPts, pnlRs, closeTime: new Date().toISOString() };
    SM.trades.unshift(trade);
    if (SM.trades.length > 300) SM.trades.pop();
    SM.position = null;
    smLg(`${p.type} closed (${reason}): order ${oid} | P&L (est): ${optPnlPts>=0?'+':''}${optPnlPts.toFixed(2)}pts = ₹${pnlRs>=0?'+':''}${pnlRs.toFixed(0)}`, reason==='TARGET'?'s':'w');

    (async () => {
      const fill = await waitFill(oid).catch(e => { smLg(`Exit fill confirm failed: ${e.message}`, 'w'); return null; });
      smRecordFill(oid, 'exitPrice', fill);
      if (fill != null) smLg(`📋 Exit fill confirmed: ₹${fill}`, 'i');
    })();
  } catch(e) { smLg('Close error: ' + e.message, 'e'); }
}

async function smTimeExit() {
  if (!SM.position) return;
  smLg('⏱ Hard close — time limit reached', 'w');
  const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050').catch(()=>null);
  const spot = sd ? parseFloat(Object.values(sd?.data||{})[0]?.last_price) : SM.position.entrySpot;
  await smClose('TIME', spot);
}


// ══════════════════════════════════════════════════════════
// SMA CROSSOVER ENGINE (BANKNIFTY) — mirror of the NIFTY one, for the
// straddle engine. Watches for spot crossing its own SMA and
// staying on the new side for a confirmation window, then buys
// a single directional leg (CE or PE, not a straddle).
// ══════════════════════════════════════════════════════════
const SM_BN_STATE_FILE    = '/home/ubuntu/engine-sm-state.json';
const SM_BN_DEFAULTS_FILE = '/home/ubuntu/engine-sm-defaults.json';

const SM_BN_FACTORY_DEFAULTS = {
  smaLen: 120,       // SMA period in 1-min candles (today's candles only; fewer used if fewer available)
  confirmMin: 10,    // minutes spot must stay on the new side of the SMA before entry
  otmSteps: 0,       // 0 = ATM; N = N strikes OTM (CE: strike+N*step, PE: strike-N*step)
  target: 20,        // index points
  stopLoss: 10,      // index points
  hardCloseMin: 15,  // force-exit this many minutes after entry regardless
  lots: 6, autoLots: true, deployPct: 95, floorPrem: 50,
};

const SM_BN = {
  active: false,
  smaLen: SM_BN_FACTORY_DEFAULTS.smaLen, confirmMin: SM_BN_FACTORY_DEFAULTS.confirmMin,
  otmSteps: SM_BN_FACTORY_DEFAULTS.otmSteps, target: SM_BN_FACTORY_DEFAULTS.target,
  stopLoss: SM_BN_FACTORY_DEFAULTS.stopLoss, hardCloseMin: SM_BN_FACTORY_DEFAULTS.hardCloseMin,
  lots: SM_BN_FACTORY_DEFAULTS.lots, autoLots: SM_BN_FACTORY_DEFAULTS.autoLots,
  deployPct: SM_BN_FACTORY_DEFAULTS.deployPct, floorPrem: SM_BN_FACTORY_DEFAULTS.floorPrem,

  checkTimer: null, monTimer: null,
  state: 'idle',          // idle | tracking
  trackDir: null,         // 'above' | 'below' — side being confirmed while tracking
  trackMinutesConfirmed: 0,
  lastSide: null,         // side as of the previous minute's check, for crossover detection

  position: null,         // {type:'CE'|'PE', key, strike, entrySpot, entryTime, lots, target, stopLoss, oid, quotedPrice, entryPrice, exitDeadlineTs}
  trades: [], log: [], dateStr: null, stoppedToday: false,
};

function smBnSaveState() {
  try {
    fs.writeFileSync(SM_BN_STATE_FILE, JSON.stringify({
      active: SM_BN.active, dateStr: SM_BN.dateStr, stoppedToday: SM_BN.stoppedToday,
      smaLen: SM_BN.smaLen, confirmMin: SM_BN.confirmMin, otmSteps: SM_BN.otmSteps,
      target: SM_BN.target, stopLoss: SM_BN.stopLoss, hardCloseMin: SM_BN.hardCloseMin,
      lots: SM_BN.lots, autoLots: SM_BN.autoLots, deployPct: SM_BN.deployPct, floorPrem: SM_BN.floorPrem,
      state: SM_BN.state, trackDir: SM_BN.trackDir, trackMinutesConfirmed: SM_BN.trackMinutesConfirmed,
      lastSide: SM_BN.lastSide, position: SM_BN.position, trades: SM_BN.trades, log: SM_BN.log,
    }));
  } catch(e) { console.error('smBnSaveState:', e.message); }
}

function smBnLoadState() {
  const today = seTodayStr();   // shared IST-date helper, already defined for the straddle engine
  try {
    if (fs.existsSync(SM_BN_STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SM_BN_STATE_FILE, 'utf8'));
      Object.assign(SM_BN, {
        smaLen: saved.smaLen ?? SM_BN.smaLen, confirmMin: saved.confirmMin ?? SM_BN.confirmMin,
        otmSteps: saved.otmSteps ?? SM_BN.otmSteps, target: saved.target ?? SM_BN.target,
        stopLoss: saved.stopLoss ?? SM_BN.stopLoss, hardCloseMin: saved.hardCloseMin ?? SM_BN.hardCloseMin,
        lots: saved.lots ?? SM_BN.lots, autoLots: saved.autoLots ?? SM_BN.autoLots,
        deployPct: saved.deployPct ?? SM_BN.deployPct, floorPrem: saved.floorPrem ?? SM_BN.floorPrem,
      });
      if (saved.dateStr === today) {
        SM_BN.dateStr = today;
        SM_BN.stoppedToday = !!saved.stoppedToday;
        SM_BN.trades = Array.isArray(saved.trades) ? saved.trades : [];
        SM_BN.log    = Array.isArray(saved.log) ? saved.log : [];
        SM_BN.state  = saved.state || 'idle';
        SM_BN.trackDir = saved.trackDir || null;
        SM_BN.trackMinutesConfirmed = saved.trackMinutesConfirmed || 0;
        SM_BN.lastSide = saved.lastSide || null;
        SM_BN.position = saved.position || null;
        lg(`📂 [SMA] Same-day state restored: ${SM_BN.trades.length} trade(s), state=${SM_BN.state}, position ${SM_BN.position ? 'OPEN' : 'none'}, wasActive=${!!saved.active}`, 'i');
        if (saved.active && !SM_BN.stoppedToday) {
          SM_BN.active = true;
          smBnScheduleNextCheck();
          if (SM_BN.position) {
            smBnStartMonitor();
            const msLeft = (SM_BN.position.exitDeadlineTs || 0) - Date.now();
            if (msLeft > 0) {
              setTimeout(() => smBnTimeExit(), msLeft);
              lg(`⏱ [SMA] Exit timer restored (${Math.floor(msLeft/1000)}s)`, 'i');
            } else {
              lg('⚠️ [SMA] Exit time already passed during downtime — closing now', 'w');
              smBnTimeExit();
            }
          }
        }
      } else {
        SM_BN.dateStr = today; SM_BN.stoppedToday = false; SM_BN.trades = []; SM_BN.log = [];
        SM_BN.state = 'idle'; SM_BN.trackDir = null; SM_BN.trackMinutesConfirmed = 0; SM_BN.lastSide = null; SM_BN.position = null;
      }
    } else {
      SM_BN.dateStr = today;
    }
  } catch(e) {
    console.error('smBnLoadState:', e.message);
    SM_BN.dateStr = today;
  }
}

function smBnSaveDefaults(d) {
  try { fs.writeFileSync(SM_BN_DEFAULTS_FILE, JSON.stringify(d)); } catch(e) { console.error('smBnSaveDefaults:', e.message); }
}
function smBnLoadDefaults() {
  try {
    if (fs.existsSync(SM_BN_DEFAULTS_FILE)) return { ...SM_BN_FACTORY_DEFAULTS, ...JSON.parse(fs.readFileSync(SM_BN_DEFAULTS_FILE, 'utf8')) };
  } catch(e) { console.error('smBnLoadDefaults:', e.message); }
  return { ...SM_BN_FACTORY_DEFAULTS };
}

function smBnLg(msg, type='i') {
  const ts = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'});
  SM_BN.log.unshift(`[${ts}] ${msg}`);
  if (SM_BN.log.length > 3000) SM_BN.log.pop();
  lg(`[SMA] ${msg}`, type);
  smBnSaveState();
}

// Market hours for NEW signal tracking/entries — deliberately narrower than
// the straddle engine's 09:20-15:25: a confirmMin(10) + hardCloseMin(15)
// cycle needs ~25 min to play out, so entries stop being scheduled once
// there isn't enough day left, even though existing positions still get
// monitored to their normal exit regardless of the clock.
function smBnIsMarket() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm >= 9*60+16 && hhmm <= 15*60+25;
}

function smBnCanStartNewCycle() {
  const ist  = new Date(Date.now() + 5.5 * 3600000);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return hhmm <= (15*60+25) - (SM_BN.confirmMin + 1 + SM_BN.hardCloseMin);
}

function smBnStart(params = {}) {
  const today = seTodayStr();
  if (SM_BN.dateStr !== today) {
    SM_BN.dateStr = today; SM_BN.trades = []; SM_BN.log = [];
    SM_BN.state = 'idle'; SM_BN.trackDir = null; SM_BN.trackMinutesConfirmed = 0; SM_BN.lastSide = null; SM_BN.position = null;
  }
  SM_BN.stoppedToday = false;
  if (SM_BN.active) { smBnLg('Already active', 'w'); return; }
  Object.assign(SM_BN, {
    active: true,
    smaLen:       params.smaLen       || SM_BN.smaLen,
    confirmMin:   params.confirmMin   || SM_BN.confirmMin,
    otmSteps:     params.otmSteps     ?? SM_BN.otmSteps,
    target:       params.target       || SM_BN.target,
    stopLoss:     params.stopLoss     || SM_BN.stopLoss,
    hardCloseMin: params.hardCloseMin || SM_BN.hardCloseMin,
    lots:         params.lots         || SM_BN.lots,
    autoLots:     params.autoLots     !== undefined ? params.autoLots : SM_BN.autoLots,
    deployPct:    params.deployPct    || SM_BN.deployPct,
    floorPrem:    params.floorPrem    || SM_BN.floorPrem,
  });
  // Same exclusivity group as SR / straddle-NF / straddle-BN
  if (ST.srActive)  { ST.srActive = false;  lg('SR deactivated — SMA engine started', 'w'); }
  if (SE.active)    { seStop('SMA engine activated'); }
  if (SE_BN.active) { seBnStop('SMA engine activated'); }
  if (SM.active)    { smStop('BankNifty SMA engine activated'); }
  saveState();
  smBnLg(`SMA engine started — SMA${SM_BN.smaLen}, confirm ${SM_BN.confirmMin}min, target ${SM_BN.target}pt, SL ${SM_BN.stopLoss}pt, hard-close ${SM_BN.hardCloseMin}min`, 's');
  smBnScheduleNextCheck();
}

function smBnStop(reason = 'Manual') {
  SM_BN.active = false;
  SM_BN.stoppedToday = true;
  if (SM_BN.checkTimer) { clearTimeout(SM_BN.checkTimer); SM_BN.checkTimer = null; }
  if (SM_BN.monTimer)   { clearInterval(SM_BN.monTimer);  SM_BN.monTimer   = null; }
  smBnLg(`SMA engine stopped (${reason})`, 'w');
}

// BankNifty SMA is opt-in every day, same treatment as SR / NIFTY straddle
// / BankNifty straddle — only SMA-NIFTY auto-starts. This only rolls the
// day boundary over for the case where the VM stays up overnight without
// restarting.
function smBnResetIfNewDay() {
  const today = seTodayStr();
  if (SM_BN.dateStr !== today) {
    SM_BN.dateStr = today; SM_BN.trades = []; SM_BN.log = [];
    SM_BN.state = 'idle'; SM_BN.trackDir = null; SM_BN.trackMinutesConfirmed = 0; SM_BN.lastSide = null;
    SM_BN.position = null; SM_BN.stoppedToday = false; SM_BN.active = false;
    smBnSaveState();
  }
}

function smBnScheduleNextCheck() {
  if (!SM_BN.active) return;
  const now  = new Date();
  const secs = now.getSeconds();
  const ms   = now.getMilliseconds();
  const msTo50 = secs < 50 ? (50 - secs) * 1000 - ms : (60 - secs + 50) * 1000 - ms;
  SM_BN.checkTimer = setTimeout(async () => {
    if (SM_BN.active) { await smBnCheck(); smBnScheduleNextCheck(); }
  }, msTo50);
}

// Builds the SMA window: today's candles so far, topped up with the tail
// end of the most recent previous trading day if today alone isn't enough
// yet (e.g. early morning). Walks backwards up to 7 calendar days to find
// a trading day with data (skips weekends/holidays automatically since
// those simply return empty). Returns candles oldest-to-newest, each as
// [ts, open, high, low, close, vol] to match the intraday endpoint's shape.
async function smBnGetSmaWindow(len) {
  const cd = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%20Bank/1minute');
  const todayCandles = (cd?.data?.candles || []).slice().reverse();   // API is most-recent-first; reverse -> chronological
  if (todayCandles.length >= len) return todayCandles.slice(-len);

  const needed = len - todayCandles.length;
  let prevCandles = [];
  const todayIst = new Date(Date.now() + 5.5 * 3600000);
  for (let back = 1; back <= 7 && prevCandles.length === 0; back++) {
    const d = new Date(todayIst);
    d.setUTCDate(d.getUTCDate() - back);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const dayCandles = await btGetCandles(dateStr);   // already chronological: [{time,open,high,low,close}]
      if (dayCandles.length > 0) prevCandles = dayCandles;
    } catch(_) {}
  }
  const prevTail = prevCandles.slice(-needed).map(c => [null, c.open, c.high, c.low, c.close, 0]);
  return [...prevTail, ...todayCandles];
}

async function smBnCheck() {
  if (!SM_BN.active || SM_BN.position) return;
  if (!smBnIsMarket()) return;
  if (!ST.token) { smBnLg('No token — skip', 'w'); return; }

  try {
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
    if (!spot) { smBnLg('Spot unavailable', 'w'); return; }

    const windowCandles = await smBnGetSmaWindow(SM_BN.smaLen);
    if (windowCandles.length === 0) { smBnLg('No candle history yet — skip', 'w'); return; }
    const usedPrevDay = windowCandles.length >= SM_BN.smaLen && windowCandles.some(c => c[0] === null);
    const sma = windowCandles.reduce((s, c) => s + parseFloat(c[4]), 0) / windowCandles.length;   // close = index 4
    const side = spot >= sma ? 'above' : 'below';

    smBnLg(`Spot ${spot} vs SMA${SM_BN.smaLen}(${windowCandles.length} candles${usedPrevDay ? ', incl. prev day' : ''}) ${sma.toFixed(1)} → ${side}`);

    if (SM_BN.state === 'idle') {
      if (SM_BN.lastSide !== null && SM_BN.lastSide !== side) {
        if (!smBnCanStartNewCycle()) {
          smBnLg(`Crossover seen (now ${side}) but too late in the day to start a fresh ${SM_BN.confirmMin}+${SM_BN.hardCloseMin}min cycle — skipping`, 'w');
        } else {
          SM_BN.state = 'tracking';
          SM_BN.trackDir = side;
          SM_BN.trackMinutesConfirmed = 0;
          smBnLg(`🔀 Crossover — now ${side} SMA${SM_BN.smaLen} — tracking ${SM_BN.confirmMin}min for confirmation`, 's');
        }
      }
    } else if (SM_BN.state === 'tracking') {
      if (side === SM_BN.trackDir) {
        SM_BN.trackMinutesConfirmed++;
        smBnLg(`Tracking: ${SM_BN.trackMinutesConfirmed}/${SM_BN.confirmMin}min confirmed ${SM_BN.trackDir}`);
        if (SM_BN.trackMinutesConfirmed >= SM_BN.confirmMin) {
          smBnLg(`✅ Confirmed ${SM_BN.confirmMin}min ${SM_BN.trackDir} SMA${SM_BN.smaLen} — entering next minute`, 's');
          const dir = SM_BN.trackDir;
          SM_BN.state = 'idle'; SM_BN.trackDir = null; SM_BN.trackMinutesConfirmed = 0;
          const now4 = new Date();
          const msToNextMin = (60 - now4.getSeconds()) * 1000 - now4.getMilliseconds() + 100;
          setTimeout(() => smBnEnter(dir === 'above' ? 'CE' : 'PE', spot), msToNextMin);
        }
      } else {
        smBnLg(`❌ Crossed back to ${side} after ${SM_BN.trackMinutesConfirmed}/${SM_BN.confirmMin}min — tracking reset`, 'w');
        SM_BN.state = 'idle'; SM_BN.trackDir = null; SM_BN.trackMinutesConfirmed = 0;
      }
    }
    SM_BN.lastSide = side;
    smBnSaveState();
  } catch(e) { smBnLg('Check error: ' + e.message, 'e'); }
}

function smBnRecordFill(oid, field, price) {
  if (price == null) return;
  if (SM_BN.position && SM_BN.position.oid === oid) SM_BN.position[field] = price;
  const t = SM_BN.trades.find(x => x.oid === oid);
  if (t) t[field] = price;
  smBnSaveState();
}

async function smBnEnter(direction, signalSpot) {
  if (!SM_BN.active || SM_BN.position) return;
  try {
    smBnLg(`Placing ${direction}...`, 'w');
    const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
    const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price) || signalSpot;
    const baseAtm = Math.round(spot / 100) * 100;
    const strike = direction === 'CE' ? baseAtm + SM_BN.otmSteps*100 : baseAtm - SM_BN.otmSteps*100;

    let calcLots = SM_BN.lots;
    const expiry = await getLiveExpiry('BN');
    const inst = await findInstrument(expiry, strike, direction, 'BN');

    if (SM_BN.autoLots) {
      try {
        const funds = await getAvailableFunds();
        const deployable = funds * SM_BN.deployPct / 100;
        const effPrem = (SM_BN.floorPrem > 0 && inst.ltp < SM_BN.floorPrem) ? SM_BN.floorPrem : inst.ltp;
        const costPerLot = effPrem * 30;
        if (costPerLot > 0) {
          calcLots = Math.max(1, Math.floor(deployable / costPerLot));
          smBnLg(`💰 Balance ₹${funds.toFixed(0)} | ${SM_BN.deployPct}% → ₹${deployable.toFixed(0)} | cost/lot ₹${costPerLot.toFixed(0)} → ${calcLots} lots`, 's');
        }
      } catch(e) { smBnLg('Auto-lots failed: ' + e.message + ' — using ' + calcLots, 'w'); }
    }

    const qty = calcLots * 30;
    smBnLg(`📐 Quoted premium before order: ${strike}${direction} ₹${inst.ltp}`, 'i');
    const oid = await placeMarket(inst.key, 'BUY', qty, 'D', 30);

    const exitDeadlineTs = Date.now() + SM_BN.hardCloseMin * 60000;
    SM_BN.position = {
      type: direction, key: inst.key, strike,
      entrySpot: spot, entryTime: new Date().toISOString(),
      lots: calcLots, target: SM_BN.target, stopLoss: SM_BN.stopLoss,
      oid, quotedPrice: inst.ltp, entryPrice: null, exitPrice: null,
      exitDeadlineTs,
    };
    smBnLg(`✅ ENTERED ${strike}${direction} × ${calcLots} lots @ spot ${spot}`, 's');
    smBnLg(`Target: spot ${direction==='CE'?'+':'-'}${SM_BN.target}pts | SL: spot ${direction==='CE'?'-':'+'}${SM_BN.stopLoss}pts | hard-close ${SM_BN.hardCloseMin}min`, 'i');

    smBnStartMonitor();
    setTimeout(() => smBnTimeExit(), SM_BN.hardCloseMin * 60000);

    (async () => {
      const fill = await waitFill(oid).catch(e => { smBnLg(`Entry fill confirm failed: ${e.message}`, 'w'); return null; });
      smBnRecordFill(oid, 'entryPrice', fill);
      if (fill != null) smBnLg(`📋 Entry fill confirmed: ₹${fill}`, 'i');
    })();
  } catch(e) { smBnLg('Entry error: ' + e.message, 'e'); }
}

function smBnStartMonitor() {
  if (SM_BN.monTimer) clearInterval(SM_BN.monTimer);
  SM_BN.monTimer = setInterval(async () => {
    if (!SM_BN.position) { clearInterval(SM_BN.monTimer); SM_BN.monTimer = null; return; }
    try {
      const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
      const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
      if (!spot) return;
      const p = SM_BN.position;
      const move = p.type === 'CE' ? (spot - p.entrySpot) : (p.entrySpot - spot);
      if (move >= p.target)      await smBnClose('TARGET', spot);
      else if (move <= -p.stopLoss) await smBnClose('STOPLOSS', spot);
    } catch(_) {}
  }, 500);
}

async function smBnClose(reason, closeSpot) {
  if (!SM_BN.position) return;
  if (SM_BN.monTimer) { clearInterval(SM_BN.monTimer); SM_BN.monTimer = null; }
  const p = SM_BN.position;
  try {
    const qty = p.lots * 30;
    const oid = await placeMarket(p.key, 'SELL', qty, 'D', 30);
    const DELTA = 0.4;   // established NIFTY convention for rough P&L estimate — real fill confirmed separately below
    const move = p.type === 'CE' ? (closeSpot - p.entrySpot) : (p.entrySpot - closeSpot);
    const optPnlPts = move * DELTA;
    const pnlRs = optPnlPts * 30 * p.lots;

    const trade = { ...p, exitOid: oid, exitReason: reason, exitSpot: closeSpot,
                     pnlPts: optPnlPts, pnlRs, closeTime: new Date().toISOString() };
    SM_BN.trades.unshift(trade);
    if (SM_BN.trades.length > 300) SM_BN.trades.pop();
    SM_BN.position = null;
    smBnLg(`${p.type} closed (${reason}): order ${oid} | P&L (est): ${optPnlPts>=0?'+':''}${optPnlPts.toFixed(2)}pts = ₹${pnlRs>=0?'+':''}${pnlRs.toFixed(0)}`, reason==='TARGET'?'s':'w');

    (async () => {
      const fill = await waitFill(oid).catch(e => { smBnLg(`Exit fill confirm failed: ${e.message}`, 'w'); return null; });
      smBnRecordFill(oid, 'exitPrice', fill);
      if (fill != null) smBnLg(`📋 Exit fill confirmed: ₹${fill}`, 'i');
    })();
  } catch(e) { smBnLg('Close error: ' + e.message, 'e'); }
}

async function smBnTimeExit() {
  if (!SM_BN.position) return;
  smBnLg('⏱ Hard close — time limit reached', 'w');
  const sd = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank').catch(()=>null);
  const spot = sd ? parseFloat(Object.values(sd?.data||{})[0]?.last_price) : SM_BN.position.entrySpot;
  await smBnClose('TIME', spot);
}


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
// NSE freeze limits per order (must be whole lots)
// NIFTY lot=65: floor(1800/65)*65 = 1755
// BN    lot=30: floor(900/30)*30  = 900
function getFreezeQty(lotSize) {
  const ls = lotSize || 65;
  const nseLimit = ls === 30 ? 900 : 1800;  // BN=900, NF=1800
  return Math.floor(nseLimit / ls) * ls;
}

async function placeMarket(instrKey, txn, qty, productType, lotSize) {
  const product = productType === 'D' ? 'D' : 'I';
  const ls      = lotSize || 65;

  // Ensure qty is a multiple of lotSize
  if (qty % ls !== 0) {
    const adj = Math.floor(qty / ls) * ls;
    lg(`⚠️ qty ${qty} not multiple of ${ls} → adjusted to ${adj}`, 'w');
    qty = adj;
  }
  if (qty <= 0) throw new Error('Quantity is 0 after lot-size adjustment');

  const freeze = getFreezeQty(ls);

  if (qty > freeze) {
    const chunks = [];
    let rem = qty;
    while (rem > 0) {
      const chunk = Math.min(rem, freeze);
      const safe  = Math.floor(chunk / ls) * ls;
      if (safe > 0) { chunks.push(safe); rem -= safe; } else break;
    }
    lg(`⚡ Slicing ${qty} into ${chunks.length} orders: ${chunks.join(' + ')} (lotSize=${ls} freeze=${freeze})`, 'w');
    const orderIds = [];
    for (const chunk of chunks) {
      const d = await upstox('/v2/order/place', 'POST', {
        quantity: chunk, product, validity: 'DAY', price: 0,
        tag: 'nifty_cloud', instrument_token: instrKey,
        order_type: 'MARKET', transaction_type: txn,
        disclosed_quantity: 0, trigger_price: 0, is_amo: false
      });
      const id = d?.data?.order_id;
      if (!id) throw new Error(`Slice failed (${chunk} qty): ${JSON.stringify(d?.errors)}`);
      orderIds.push(id);
      lg(`⚡ Slice OK: ${id} — ${chunk/ls} lots (${chunk} qty)`, 'i');
      await sleep(600);
    }
    return orderIds[0];
  }

  const d = await upstox('/v2/order/place', 'POST', {
    quantity: qty, product, validity: 'DAY', price: 0,
    tag: 'nifty_cloud', instrument_token: instrKey,
    order_type: 'MARKET', transaction_type: txn,
    disclosed_quantity: 0, trigger_price: 0, is_amo: false
  });
  const id = d?.data?.order_id;
  if (!id) throw new Error(`Order failed: ${JSON.stringify(d?.errors)}`);
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
    const inst   = detectInst(cfg);
    const spot   = await getSpot(inst);
    ST.spotPrice = spot;
    const step   = cfg.step || 50;
    const atm    = Math.round(spot / step) * step;
    const otm    = cfg.otm || 1;
    const strike = cfg.dir === 'CE' ? atm + otm*step : atm - otm*step;
    const expiry = await getLiveExpiry(inst);
    lg(`Spot: ${spot.toFixed(2)} | ATM: ${atm} | Strike: ${strike}${cfg.dir} | Expiry: ${expiry} | ${inst}`, 'i');
    const { key, ltp } = await findInstrument(expiry, strike, cfg.dir, inst);
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
    const prodType = cfg.productType || 'D';  // D=NRML, I=MIS
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
    const { spot, optLTP } = await getSpotAndOptLTP(ST.instr.key, ST.config?.inst || 'NF');
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
    const prodType = ST.config.productType || 'D';
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
  // Check if SR system is active (can be deactivated from app)
  if (ST.srActive === false) {
    lg(`[Auto] SR system deactivated — "${slot.name}" not scheduled`, 'w');
    return;
  }

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

  // Re-check the master switch AT FIRE TIME, not just when the timer was
  // armed. A slot can sit armed for hours; if SR gets switched off in that
  // window the timer is still live and would otherwise fire anyway.
  if (ST.srActive === false) {
    lg(`[Auto] "${slot.name}": SR switched off since arming — not firing`, 'w');
    SLOT_STATUS[slot.id] = 'skipped';
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
  const lotSize = slot.lotSize || 75;  // default NIFTY lot size
  const inst    = (slot.lotSize === 30 || (slot.name||'').startsWith('BN')) ? 'BN' : 'NF';

  const config = {
    dir: direction,
    otm: slot.otm, step: slot.step,
    sl: slot.sl, tgt: slot.tgt,
    lots: slot.lots, lotSize: lotSize,
    autoLots: slot.autoLots || false,
    deployPct: slot.deployPct || 90,
    floorPremium: slot.floorPremium || 0,
    productType: slot.productType || 'D',  // ← NRML by default
    inst: inst,   // ← NF or BN
    name: slot.name,
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
  let body = ''; let rawBody = '';
  if (req.method === 'POST') {
    await new Promise(r => { req.on('data', c => { body += c; rawBody += c; }); req.on('end', r); });
    try { body = JSON.parse(body); } catch(_) { body = {}; }
  }
  const ok  = (d, code = 200) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  // ── POST /engine/sr-active ──────────────────────────────
  if (p === '/engine/sr-active' && req.method === 'POST') {
    ST.srActive = (body.active !== false);
    ST.srActiveDateStr = seTodayStr();
    if (ST.srActive && SE.active) {
      seStop('SR activated');   // enforce mutual exclusion the other direction too
    }
    if (ST.srActive && SE_BN.active) {
      seBnStop('SR activated');
    }
    if (ST.srActive && SM.active) {
      smStop('SR activated');
    }
    if (ST.srActive && SM_BN.active) {
      smBnStop('SR activated');
    }
    if (ST.srActive) {
      // Arm the roster NOW. Without this, a roster pushed while SR was off
      // (the normal case now that off is the default) would stay un-armed
      // forever — scheduleAllSlots() otherwise only runs at boot or on push,
      // never at the moment you actually flip this toggle on.
      scheduleAllSlots();
    } else {
      // Clear armed timers immediately so the UI doesn't keep showing
      // "waiting" for slots that are now dead (executeAutoSlot would reject
      // them at fire time regardless, but this keeps the display honest).
      clearAllSlotTimers();
    }
    saveState();
    lg(`SR system ${ST.srActive ? 'ACTIVATED ✅' : 'DEACTIVATED ⛔'}`, ST.srActive ? 's' : 'w');
    return ok({ ok: true, srActive: ST.srActive });
  }

  // ── POST /engine/straddle/start ─────────────────────────
  if (p === '/engine/straddle/start' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const d = seLoadDefaults();
    seStart({
      tp:        body.tp        || d.tp,
      sl:        body.sl        || d.sl,
      volThr:    body.volThr    || d.volThr,
      lots:      body.lots      || d.lots,
      autoLots:  body.autoLots  !== undefined ? body.autoLots : d.autoLots,
      deployPct: body.deployPct || d.deployPct,
      floorPrem: body.floorPremium || d.floorPrem,
      trendPts:       body.trendPts       ?? d.trendPts,
      trendOffsetMin: body.trendOffsetMin ?? d.trendOffsetMin,
      exitOffsetMin:  body.exitOffsetMin  ?? d.exitOffsetMin,
    });
    return ok({ ok: true, message: 'Straddle engine started on VM' });
  }

  // ── POST /engine/straddle/stop ──────────────────────────
  if (p === '/engine/straddle/stop' && req.method === 'POST') {
    seStop('Manual — user toggle');
    return ok({ ok: true, message: 'Straddle engine stopped for the rest of today. SR stays off unless you turn it on.' });
  }

  // ── GET /engine/straddle/status ─────────────────────────
  // Returns the FULL day's trades + log (9:15–15:30, or however much has
  // happened so far) — the app renders whatever it gets, no truncation here.
  if (p === '/engine/straddle/status' && req.method === 'GET') {
    return ok({
      ok: true,
      active:       SE.active,
      stoppedToday: SE.stoppedToday,
      dateStr:      SE.dateStr,
      position:     SE.position,
      trades:       SE.trades,
      log:          SE.log,
      params:   { tp: SE.tp, sl: SE.sl, volThr: SE.volThr, lots: SE.lots,
                  autoLots: SE.autoLots, deployPct: SE.deployPct, floorPrem: SE.floorPrem,
                  trendPts: SE.trendPts, trendOffsetMin: SE.trendOffsetMin, exitOffsetMin: SE.exitOffsetMin },
    });
  }

  // ── GET /engine/straddle/report ─────────────────────────
  // Plain-text version of the same data — readable straight in a terminal,
  // no jq/python needed: curl -s http://localhost:8081/engine/straddle/report
  if (p === '/engine/straddle/report' && req.method === 'GET') {
    const lines = [];
    lines.push(`942 Trade — Straddle report — ${SE.dateStr || seTodayStr()}`);
    lines.push(`Active: ${SE.active} | Stopped by user today: ${SE.stoppedToday}`);
    lines.push(`Params: TP=${SE.tp}pt SL=${SE.sl}pt Vol>=${SE.volThr}x Trend>=${SE.trendPts}pt/${SE.trendOffsetMin}min ExitCutoff=x+${SE.exitOffsetMin} Lots=${SE.lots}${SE.autoLots?' (auto)':''} Deploy=${SE.deployPct}% Floor=Rs${SE.floorPrem}`);
    lines.push('');
    if (SE.position) {
      const p = SE.position;
      lines.push(`OPEN POSITION: entry ${p.entryTime} | spot ${p.entrySpot} | ${p.lots} lots`);
      lines.push(`  CE: quoted Rs${p.ceQuotedPrice ?? '?'} | entry fill Rs${p.ceEntryPrice ?? 'pending'} | ${p.ceClosed ? 'closed ('+p.ceReason+') exit Rs'+(p.ceExitPrice ?? 'pending') : 'still open'}`);
      lines.push(`  PE: quoted Rs${p.peQuotedPrice ?? '?'} | entry fill Rs${p.peEntryPrice ?? 'pending'} | ${p.peClosed ? 'closed ('+p.peReason+') exit Rs'+(p.peExitPrice ?? 'pending') : 'still open'}`);
      lines.push('');
    }
    lines.push(`=== TRADES (${SE.trades.length}) ===`);
    if (!SE.trades.length) lines.push('(none yet today)');
    SE.trades.slice().reverse().forEach((t, i) => {
      lines.push(`#${i+1}  entry ${t.entryTime}  spot ${t.entrySpot}  ${t.lots} lots  ->  close ${t.closeTime || '?'}`);
      lines.push(`  CE: quoted Rs${t.ceQuotedPrice ?? '?'} -> entry Rs${t.ceEntryPrice ?? '?'} -> exit Rs${t.ceExitPrice ?? '?'}  [${t.ceReason || '?'}]  est P&L Rs${(t.cePnlRs ?? 0).toFixed(0)}`);
      lines.push(`  PE: quoted Rs${t.peQuotedPrice ?? '?'} -> entry Rs${t.peEntryPrice ?? '?'} -> exit Rs${t.peExitPrice ?? '?'}  [${t.peReason || '?'}]  est P&L Rs${(t.pePnlRs ?? 0).toFixed(0)}`);
      lines.push(`  TOTAL (after Rs100 txcost): Rs${(t.totalPnlRs ?? 0).toFixed(0)}`);
      lines.push('');
    });
    lines.push(`=== FULL LOG (${SE.log.length} lines, chronological) ===`);
    SE.log.slice().reverse().forEach(l => lines.push(l));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n'));
    return;
  }


  if (p === '/engine/straddle/exit' && req.method === 'POST') {
    if (!SE.position) return ok({ ok: false, error: 'No open position' });
    await seTimeExit();
    return ok({ ok: true, message: 'Manual exit triggered' });
  }

  // ── GET /engine/straddle/defaults ───────────────────────
  // The persisted baseline params — app reads this on load to pre-fill fields.
  if (p === '/engine/straddle/defaults' && req.method === 'GET') {
    return ok({ ok: true, defaults: seLoadDefaults() });
  }

  // ── POST /engine/straddle/defaults ──────────────────────
  // "Update" button: saves these as the new baseline for every future
  // start (today's remaining auto-resumes, and every day after). Also
  // applies live immediately if the engine is currently running.
  if (p === '/engine/straddle/defaults' && req.method === 'POST') {
    const cur = seLoadDefaults();
    const next = {
      tp:        body.tp        ?? cur.tp,
      sl:        body.sl        ?? cur.sl,
      volThr:    body.volThr    ?? cur.volThr,
      lots:      body.lots      ?? cur.lots,
      autoLots:  body.autoLots  !== undefined ? body.autoLots : cur.autoLots,
      deployPct: body.deployPct ?? cur.deployPct,
      floorPrem: body.floorPremium ?? body.floorPrem ?? cur.floorPrem,
      trendPts:       body.trendPts       ?? cur.trendPts,
      trendOffsetMin: body.trendOffsetMin ?? cur.trendOffsetMin,
      exitOffsetMin:  body.exitOffsetMin  ?? cur.exitOffsetMin,
    };
    seSaveDefaults(next);
    if (SE.active) Object.assign(SE, next);   // apply live, no need to stop/restart
    lg(`[Straddle] Defaults updated: TP=${next.tp} SL=${next.sl} Vol=${next.volThr}× Trend=${next.trendPts}pt/${next.trendOffsetMin}min ExitCutoff=x+${next.exitOffsetMin} Deploy=${next.deployPct}% Floor=₹${next.floorPrem} Lots=${next.lots}`, 's');
    seSaveState();
    return ok({ ok: true, defaults: next });
  }

  // ── GET /engine/straddle/spot ────────────────────────────
  if (p === '/engine/straddle/spot' && req.method === 'GET') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    try {
      const d = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
      const spot = parseFloat(Object.values(d?.data||{})[0]?.last_price);
      if (!spot) return ok({ ok: false, error: 'Spot unavailable' });
      const cd = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%2050/1minute');
      const candles = cd?.data?.candles || [];
      let range = 0;
      if (candles.length >= 2) {
        const prev = candles[candles.length - 2];
        range = parseFloat((prev[2] - prev[3]).toFixed(2));
      }
      return ok({ ok: true, spot, range });
    } catch(e) { return ok({ ok: false, error: e.message }); }
  }

  // ══ BANKNIFTY STRADDLE ROUTES (mirror of above, /bn/ prefixed) ══
  // ── POST /engine/straddle/start ─────────────────────────
  if (p === '/engine/straddle/bn/start' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const d = seBnLoadDefaults();
    seBnStart({
      tp:        body.tp        || d.tp,
      sl:        body.sl        || d.sl,
      volThr:    body.volThr    || d.volThr,
      lots:      body.lots      || d.lots,
      autoLots:  body.autoLots  !== undefined ? body.autoLots : d.autoLots,
      deployPct: body.deployPct || d.deployPct,
      floorPrem: body.floorPremium || d.floorPrem,
      trendPts:       body.trendPts       ?? d.trendPts,
      trendOffsetMin: body.trendOffsetMin ?? d.trendOffsetMin,
      exitOffsetMin:  body.exitOffsetMin  ?? d.exitOffsetMin,
    });
    return ok({ ok: true, message: 'Straddle engine started on VM' });
  }

  // ── POST /engine/straddle/stop ──────────────────────────
  if (p === '/engine/straddle/bn/stop' && req.method === 'POST') {
    seBnStop('Manual — user toggle');
    return ok({ ok: true, message: 'Straddle engine stopped for the rest of today. SR stays off unless you turn it on.' });
  }

  // ── GET /engine/straddle/status ─────────────────────────
  // Returns the FULL day's trades + log (9:15–15:30, or however much has
  // happened so far) — the app renders whatever it gets, no truncation here.
  if (p === '/engine/straddle/bn/status' && req.method === 'GET') {
    return ok({
      ok: true,
      active:       SE_BN.active,
      stoppedToday: SE_BN.stoppedToday,
      dateStr:      SE_BN.dateStr,
      position:     SE_BN.position,
      trades:       SE_BN.trades,
      log:          SE_BN.log,
      params:   { tp: SE_BN.tp, sl: SE_BN.sl, volThr: SE_BN.volThr, lots: SE_BN.lots,
                  autoLots: SE_BN.autoLots, deployPct: SE_BN.deployPct, floorPrem: SE_BN.floorPrem,
                  trendPts: SE_BN.trendPts, trendOffsetMin: SE_BN.trendOffsetMin, exitOffsetMin: SE_BN.exitOffsetMin },
    });
  }

  // ── GET /engine/straddle/report ─────────────────────────
  // Plain-text version of the same data — readable straight in a terminal,
  // no jq/python needed: curl -s http://localhost:8081/engine/straddle/report
  if (p === '/engine/straddle/bn/report' && req.method === 'GET') {
    const lines = [];
    lines.push(`942 Trade — Straddle report — ${SE_BN.dateStr || seTodayStr()}`);
    lines.push(`Active: ${SE_BN.active} | Stopped by user today: ${SE_BN.stoppedToday}`);
    lines.push(`Params: TP=${SE_BN.tp}pt SL=${SE_BN.sl}pt Vol>=${SE_BN.volThr}x Trend>=${SE_BN.trendPts}pt/${SE_BN.trendOffsetMin}min ExitCutoff=x+${SE_BN.exitOffsetMin} Lots=${SE_BN.lots}${SE_BN.autoLots?' (auto)':''} Deploy=${SE_BN.deployPct}% Floor=Rs${SE_BN.floorPrem}`);
    lines.push('');
    if (SE_BN.position) {
      const p = SE_BN.position;
      lines.push(`OPEN POSITION: entry ${p.entryTime} | spot ${p.entrySpot} | ${p.lots} lots`);
      lines.push(`  CE: quoted Rs${p.ceQuotedPrice ?? '?'} | entry fill Rs${p.ceEntryPrice ?? 'pending'} | ${p.ceClosed ? 'closed ('+p.ceReason+') exit Rs'+(p.ceExitPrice ?? 'pending') : 'still open'}`);
      lines.push(`  PE: quoted Rs${p.peQuotedPrice ?? '?'} | entry fill Rs${p.peEntryPrice ?? 'pending'} | ${p.peClosed ? 'closed ('+p.peReason+') exit Rs'+(p.peExitPrice ?? 'pending') : 'still open'}`);
      lines.push('');
    }
    lines.push(`=== TRADES (${SE_BN.trades.length}) ===`);
    if (!SE_BN.trades.length) lines.push('(none yet today)');
    SE_BN.trades.slice().reverse().forEach((t, i) => {
      lines.push(`#${i+1}  entry ${t.entryTime}  spot ${t.entrySpot}  ${t.lots} lots  ->  close ${t.closeTime || '?'}`);
      lines.push(`  CE: quoted Rs${t.ceQuotedPrice ?? '?'} -> entry Rs${t.ceEntryPrice ?? '?'} -> exit Rs${t.ceExitPrice ?? '?'}  [${t.ceReason || '?'}]  est P&L Rs${(t.cePnlRs ?? 0).toFixed(0)}`);
      lines.push(`  PE: quoted Rs${t.peQuotedPrice ?? '?'} -> entry Rs${t.peEntryPrice ?? '?'} -> exit Rs${t.peExitPrice ?? '?'}  [${t.peReason || '?'}]  est P&L Rs${(t.pePnlRs ?? 0).toFixed(0)}`);
      lines.push(`  TOTAL (after Rs100 txcost): Rs${(t.totalPnlRs ?? 0).toFixed(0)}`);
      lines.push('');
    });
    lines.push(`=== FULL LOG (${SE_BN.log.length} lines, chronological) ===`);
    SE_BN.log.slice().reverse().forEach(l => lines.push(l));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n'));
    return;
  }


  if (p === '/engine/straddle/bn/exit' && req.method === 'POST') {
    if (!SE_BN.position) return ok({ ok: false, error: 'No open position' });
    await seBnTimeExit();
    return ok({ ok: true, message: 'Manual exit triggered' });
  }

  // ── GET /engine/straddle/defaults ───────────────────────
  // The persisted baseline params — app reads this on load to pre-fill fields.
  if (p === '/engine/straddle/bn/defaults' && req.method === 'GET') {
    return ok({ ok: true, defaults: seBnLoadDefaults() });
  }

  // ── POST /engine/straddle/defaults ──────────────────────
  // "Update" button: saves these as the new baseline for every future
  // start (today's remaining auto-resumes, and every day after). Also
  // applies live immediately if the engine is currently running.
  if (p === '/engine/straddle/bn/defaults' && req.method === 'POST') {
    const cur = seBnLoadDefaults();
    const next = {
      tp:        body.tp        ?? cur.tp,
      sl:        body.sl        ?? cur.sl,
      volThr:    body.volThr    ?? cur.volThr,
      lots:      body.lots      ?? cur.lots,
      autoLots:  body.autoLots  !== undefined ? body.autoLots : cur.autoLots,
      deployPct: body.deployPct ?? cur.deployPct,
      floorPrem: body.floorPremium ?? body.floorPrem ?? cur.floorPrem,
      trendPts:       body.trendPts       ?? cur.trendPts,
      trendOffsetMin: body.trendOffsetMin ?? cur.trendOffsetMin,
      exitOffsetMin:  body.exitOffsetMin  ?? cur.exitOffsetMin,
    };
    seBnSaveDefaults(next);
    if (SE_BN.active) Object.assign(SE_BN, next);   // apply live, no need to stop/restart
    lg(`[Straddle] Defaults updated: TP=${next.tp} SL=${next.sl} Vol=${next.volThr}× Trend=${next.trendPts}pt/${next.trendOffsetMin}min ExitCutoff=x+${next.exitOffsetMin} Deploy=${next.deployPct}% Floor=₹${next.floorPrem} Lots=${next.lots}`, 's');
    seBnSaveState();
    return ok({ ok: true, defaults: next });
  }

  // ── GET /engine/straddle/spot ────────────────────────────
  if (p === '/engine/straddle/bn/spot' && req.method === 'GET') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    try {
      const d = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%20Bank');
      const spot = parseFloat(Object.values(d?.data||{})[0]?.last_price);
      if (!spot) return ok({ ok: false, error: 'Spot unavailable' });
      const cd = await upstox('/v2/historical-candle/intraday/NSE_INDEX%7CNifty%20Bank/1minute');
      const candles = cd?.data?.candles || [];
      let range = 0;
      if (candles.length >= 2) {
        const prev = candles[candles.length - 2];
        range = parseFloat((prev[2] - prev[3]).toFixed(2));
      }
      return ok({ ok: true, spot, range });
    } catch(e) { return ok({ ok: false, error: e.message }); }
  }

  // ══ SMA CROSSOVER ENGINE ROUTES (NIFTY) ══════════════════
  if (p === '/engine/sma/start' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const d = smLoadDefaults();
    smStart({
      smaLen:       body.smaLen       || d.smaLen,
      confirmMin:   body.confirmMin   || d.confirmMin,
      otmSteps:     body.otmSteps     ?? d.otmSteps,
      target:       body.target       || d.target,
      stopLoss:     body.stopLoss     || d.stopLoss,
      hardCloseMin: body.hardCloseMin || d.hardCloseMin,
      lots:         body.lots         || d.lots,
      autoLots:     body.autoLots     !== undefined ? body.autoLots : d.autoLots,
      deployPct:    body.deployPct    || d.deployPct,
      floorPrem:    body.floorPremium || d.floorPrem,
    });
    return ok({ ok: true, message: 'SMA engine started on VM' });
  }

  if (p === '/engine/sma/stop' && req.method === 'POST') {
    smStop('Manual — user toggle');
    return ok({ ok: true, message: 'SMA engine stopped for the rest of today' });
  }

  if (p === '/engine/sma/status' && req.method === 'GET') {
    return ok({
      ok: true,
      active: SM.active, stoppedToday: SM.stoppedToday, dateStr: SM.dateStr,
      state: SM.state, trackDir: SM.trackDir, trackMinutesConfirmed: SM.trackMinutesConfirmed,
      position: SM.position, trades: SM.trades, log: SM.log,
      params: { smaLen: SM.smaLen, confirmMin: SM.confirmMin, otmSteps: SM.otmSteps,
                target: SM.target, stopLoss: SM.stopLoss, hardCloseMin: SM.hardCloseMin,
                lots: SM.lots, autoLots: SM.autoLots, deployPct: SM.deployPct, floorPrem: SM.floorPrem },
    });
  }

  if (p === '/engine/sma/report' && req.method === 'GET') {
    const lines = [];
    lines.push(`942 Trade — SMA crossover report (NIFTY) — ${SM.dateStr || seTodayStr()}`);
    lines.push(`Active: ${SM.active} | Stopped by user today: ${SM.stoppedToday} | State: ${SM.state}${SM.state==='tracking' ? ' ('+SM.trackMinutesConfirmed+'/'+SM.confirmMin+'min '+SM.trackDir+')' : ''}`);
    lines.push(`Params: SMA${SM.smaLen} confirm=${SM.confirmMin}min OTM=${SM.otmSteps} target=${SM.target}pt SL=${SM.stopLoss}pt hardClose=${SM.hardCloseMin}min Lots=${SM.lots}${SM.autoLots?' (auto)':''} Deploy=${SM.deployPct}% Floor=Rs${SM.floorPrem}`);
    lines.push('');
    if (SM.position) {
      const p2 = SM.position;
      lines.push(`OPEN POSITION: ${p2.strike}${p2.type} entry ${p2.entryTime} | spot ${p2.entrySpot} | ${p2.lots} lots`);
      lines.push(`  quoted Rs${p2.quotedPrice ?? '?'} | entry fill Rs${p2.entryPrice ?? 'pending'}`);
      lines.push('');
    }
    lines.push(`=== TRADES (${SM.trades.length}) ===`);
    if (!SM.trades.length) lines.push('(none yet today)');
    SM.trades.slice().reverse().forEach((t, i) => {
      lines.push(`#${i+1}  ${t.strike}${t.type}  entry ${t.entryTime} spot ${t.entrySpot} ${t.lots} lots -> close ${t.closeTime || '?'}`);
      lines.push(`  quoted Rs${t.quotedPrice ?? '?'} -> entry Rs${t.entryPrice ?? '?'} -> exit Rs${t.exitPrice ?? '?'}  [${t.exitReason || '?'}]  est P&L Rs${(t.pnlRs ?? 0).toFixed(0)}`);
      lines.push('');
    });
    lines.push(`=== FULL LOG (${SM.log.length} lines, chronological) ===`);
    SM.log.slice().reverse().forEach(l => lines.push(l));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n'));
    return;
  }

  if (p === '/engine/sma/exit' && req.method === 'POST') {
    if (!SM.position) return ok({ ok: false, error: 'No open position' });
    await smTimeExit();
    return ok({ ok: true, message: 'Manual exit triggered' });
  }

  if (p === '/engine/sma/defaults' && req.method === 'GET') {
    return ok({ ok: true, defaults: smLoadDefaults() });
  }

  if (p === '/engine/sma/defaults' && req.method === 'POST') {
    const cur = smLoadDefaults();
    const next = {
      smaLen:       body.smaLen       ?? cur.smaLen,
      confirmMin:   body.confirmMin   ?? cur.confirmMin,
      otmSteps:     body.otmSteps     ?? cur.otmSteps,
      target:       body.target       ?? cur.target,
      stopLoss:     body.stopLoss     ?? cur.stopLoss,
      hardCloseMin: body.hardCloseMin ?? cur.hardCloseMin,
      lots:         body.lots         ?? cur.lots,
      autoLots:     body.autoLots     !== undefined ? body.autoLots : cur.autoLots,
      deployPct:    body.deployPct    ?? cur.deployPct,
      floorPrem:    body.floorPremium ?? body.floorPrem ?? cur.floorPrem,
    };
    smSaveDefaults(next);
    if (SM.active) Object.assign(SM, next);
    lg(`[SMA] Defaults updated: SMA${next.smaLen} confirm=${next.confirmMin}min OTM=${next.otmSteps} target=${next.target}pt SL=${next.stopLoss}pt hardClose=${next.hardCloseMin}min Deploy=${next.deployPct}% Floor=₹${next.floorPrem} Lots=${next.lots}`, 's');
    smSaveState();
    return ok({ ok: true, defaults: next });
  }

  // ══ SMA CROSSOVER ENGINE ROUTES (BANKNIFTY) ══════════════════
  if (p === '/engine/sma/bn/start' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const d = smBnLoadDefaults();
    smBnStart({
      smaLen:       body.smaLen       || d.smaLen,
      confirmMin:   body.confirmMin   || d.confirmMin,
      otmSteps:     body.otmSteps     ?? d.otmSteps,
      target:       body.target       || d.target,
      stopLoss:     body.stopLoss     || d.stopLoss,
      hardCloseMin: body.hardCloseMin || d.hardCloseMin,
      lots:         body.lots         || d.lots,
      autoLots:     body.autoLots     !== undefined ? body.autoLots : d.autoLots,
      deployPct:    body.deployPct    || d.deployPct,
      floorPrem:    body.floorPremium || d.floorPrem,
    });
    return ok({ ok: true, message: 'BankNifty SMA engine started on VM' });
  }

  if (p === '/engine/sma/bn/stop' && req.method === 'POST') {
    smBnStop('Manual — user toggle');
    return ok({ ok: true, message: 'SMA engine stopped for the rest of today' });
  }

  if (p === '/engine/sma/bn/status' && req.method === 'GET') {
    return ok({
      ok: true,
      active: SM_BN.active, stoppedToday: SM_BN.stoppedToday, dateStr: SM_BN.dateStr,
      state: SM_BN.state, trackDir: SM_BN.trackDir, trackMinutesConfirmed: SM_BN.trackMinutesConfirmed,
      position: SM_BN.position, trades: SM_BN.trades, log: SM_BN.log,
      params: { smaLen: SM_BN.smaLen, confirmMin: SM_BN.confirmMin, otmSteps: SM_BN.otmSteps,
                target: SM_BN.target, stopLoss: SM_BN.stopLoss, hardCloseMin: SM_BN.hardCloseMin,
                lots: SM_BN.lots, autoLots: SM_BN.autoLots, deployPct: SM_BN.deployPct, floorPrem: SM_BN.floorPrem },
    });
  }

  if (p === '/engine/sma/bn/report' && req.method === 'GET') {
    const lines = [];
    lines.push(`942 Trade — SMA crossover report (BANKNIFTY) — ${SM_BN.dateStr || seTodayStr()}`);
    lines.push(`Active: ${SM_BN.active} | Stopped by user today: ${SM_BN.stoppedToday} | State: ${SM_BN.state}${SM_BN.state==='tracking' ? ' ('+SM_BN.trackMinutesConfirmed+'/'+SM_BN.confirmMin+'min '+SM_BN.trackDir+')' : ''}`);
    lines.push(`Params: SMA${SM_BN.smaLen} confirm=${SM_BN.confirmMin}min OTM=${SM_BN.otmSteps} target=${SM_BN.target}pt SL=${SM_BN.stopLoss}pt hardClose=${SM_BN.hardCloseMin}min Lots=${SM_BN.lots}${SM_BN.autoLots?' (auto)':''} Deploy=${SM_BN.deployPct}% Floor=Rs${SM_BN.floorPrem}`);
    lines.push('');
    if (SM_BN.position) {
      const p2 = SM_BN.position;
      lines.push(`OPEN POSITION: ${p2.strike}${p2.type} entry ${p2.entryTime} | spot ${p2.entrySpot} | ${p2.lots} lots`);
      lines.push(`  quoted Rs${p2.quotedPrice ?? '?'} | entry fill Rs${p2.entryPrice ?? 'pending'}`);
      lines.push('');
    }
    lines.push(`=== TRADES (${SM_BN.trades.length}) ===`);
    if (!SM_BN.trades.length) lines.push('(none yet today)');
    SM_BN.trades.slice().reverse().forEach((t, i) => {
      lines.push(`#${i+1}  ${t.strike}${t.type}  entry ${t.entryTime} spot ${t.entrySpot} ${t.lots} lots -> close ${t.closeTime || '?'}`);
      lines.push(`  quoted Rs${t.quotedPrice ?? '?'} -> entry Rs${t.entryPrice ?? '?'} -> exit Rs${t.exitPrice ?? '?'}  [${t.exitReason || '?'}]  est P&L Rs${(t.pnlRs ?? 0).toFixed(0)}`);
      lines.push('');
    });
    lines.push(`=== FULL LOG (${SM_BN.log.length} lines, chronological) ===`);
    SM_BN.log.slice().reverse().forEach(l => lines.push(l));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n'));
    return;
  }

  if (p === '/engine/sma/bn/exit' && req.method === 'POST') {
    if (!SM_BN.position) return ok({ ok: false, error: 'No open position' });
    await smTimeExit();
    return ok({ ok: true, message: 'Manual exit triggered' });
  }

  if (p === '/engine/sma/bn/defaults' && req.method === 'GET') {
    return ok({ ok: true, defaults: smBnLoadDefaults() });
  }

  if (p === '/engine/sma/bn/defaults' && req.method === 'POST') {
    const cur = smBnLoadDefaults();
    const next = {
      smaLen:       body.smaLen       ?? cur.smaLen,
      confirmMin:   body.confirmMin   ?? cur.confirmMin,
      otmSteps:     body.otmSteps     ?? cur.otmSteps,
      target:       body.target       ?? cur.target,
      stopLoss:     body.stopLoss     ?? cur.stopLoss,
      hardCloseMin: body.hardCloseMin ?? cur.hardCloseMin,
      lots:         body.lots         ?? cur.lots,
      autoLots:     body.autoLots     !== undefined ? body.autoLots : cur.autoLots,
      deployPct:    body.deployPct    ?? cur.deployPct,
      floorPrem:    body.floorPremium ?? body.floorPrem ?? cur.floorPrem,
    };
    smBnSaveDefaults(next);
    if (SM_BN.active) Object.assign(SM_BN, next);
    lg(`[SMA-BN] Defaults updated: SMA${next.smaLen} confirm=${next.confirmMin}min OTM=${next.otmSteps} target=${next.target}pt SL=${next.stopLoss}pt hardClose=${next.hardCloseMin}min Deploy=${next.deployPct}% Floor=₹${next.floorPrem} Lots=${next.lots}`, 's');
    smBnSaveState();
    return ok({ ok: true, defaults: next });
  }


  // ── GET /engine/straddle/volcheck ───────────────────────
  if (p === '/engine/straddle/volcheck' && req.method === 'GET') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    try {
      const STOCKS = [
        ['HDFCBANK',   'NSE_EQ%7CINE040A01034', 0.130],
        ['RELIANCE',   'NSE_EQ%7CINE002A01018', 0.090],
        ['ICICIBANK',  'NSE_EQ%7CINE090A01021', 0.080],
        ['INFY',       'NSE_EQ%7CINE009A01021', 0.060],
        ['TCS',        'NSE_EQ%7CINE467B01029', 0.050],
        ['LT',         'NSE_EQ%7CINE018A01030', 0.040],
        ['AXISBANK',   'NSE_EQ%7CINE238A01034', 0.040],
        ['HINDUNILVR', 'NSE_EQ%7CINE030A01027', 0.030],
        ['SBIN',       'NSE_EQ%7CINE062A01020', 0.030],
      ];
      const ROLL = 120;
      let wVol = 0, totalW = 0;
      const details = [];
      for (const [sym, key, w] of STOCKS) {
        try {
          const cd = await upstox(`/v2/historical-candle/intraday/${key}/1minute`);
          const candles = (cd?.data?.candles || []).reverse();
          if (candles.length < 2) continue;
          const curVol = parseFloat(candles[candles.length-1][5]) || 0;
          const prior  = candles.slice(Math.max(0, candles.length-1-ROLL), candles.length-1);
          const avgVol = prior.length > 0
            ? prior.reduce((s,c) => s + (parseFloat(c[5])||0), 0) / prior.length : 0;
          const ratio  = avgVol > 0 ? curVol / avgVol : 1;
          wVol   += ratio * w;
          totalW += w;
          details.push({ sym, ratio: ratio.toFixed(2) });
          await sleep(150);
        } catch(_) {}
      }
      const wvr = totalW > 0 ? wVol / totalW : 0;
      return ok({ ok: true, weightedVolRatio: parseFloat(wvr.toFixed(3)), details });
    } catch(e) { return ok({ ok: false, error: e.message }); }
  }

  // ── POST /engine/straddle/enter ─────────────────────────
  if (p === '/engine/straddle/enter' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const _d = seLoadDefaults();
    const { lots=_d.lots, tp=_d.tp, sl=_d.sl, autoLots=_d.autoLots, deployPct=_d.deployPct, floorPremium=_d.floorPrem } = body;
    try {
      const sd   = await upstox('/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050');
      const spot = parseFloat(Object.values(sd?.data||{})[0]?.last_price);
      if (!spot) return ok({ ok: false, error: 'Spot unavailable' });
      const atm    = Math.round(spot / 50) * 50;
      const expiry = await getLiveExpiry('NF');
      const ce     = await findInstrument(expiry, atm, 'CE', 'NF');
      const pe     = await findInstrument(expiry, atm, 'PE', 'NF');

      // ── AUTO LOTS (same logic as SR system) ────────────────
      let calcLots = lots;  // fallback to manual
      if (autoLots) {
        try {
          const funds       = await getAvailableFunds();
          const deployable  = funds * deployPct / 100;
          // Straddle cost = CE premium + PE premium per lot
          const ceLtp       = ce.ltp || 0;
          const peLtp       = pe.ltp || 0;
          // Use floor premium if actual is below (protects against zero/stale LTP)
          const effCe       = (floorPremium > 0 && ceLtp < floorPremium) ? floorPremium : ceLtp;
          const effPe       = (floorPremium > 0 && peLtp < floorPremium) ? floorPremium : peLtp;
          const costPerLot  = (effCe + effPe) * 65;  // CE+PE per lot (65 shares)
          if (costPerLot > 0) {
            calcLots = Math.max(1, Math.floor(deployable / costPerLot));
            lg(`💰 Straddle auto-lots: Balance ₹${funds.toFixed(0)} | ${deployPct}% = ₹${deployable.toFixed(0)}`, 's');
            lg(`💰 CE LTP ₹${effCe} + PE LTP ₹${effPe} = ₹${costPerLot.toFixed(0)}/lot → ${calcLots} lot(s)`, 's');
          }
        } catch(e) {
          lg(`⚠️ Straddle auto-lots failed: ${e.message} — using ${lots} lot(s)`, 'w');
          calcLots = lots;
        }
      } else {
        lg(`💰 Manual lots: ${calcLots}`, 'i');
      }

      const qty    = calcLots * 65;
      const ceOid  = await placeMarket(ce.key, 'BUY', qty, 'D', 65);
      await sleep(300);
      const peOid  = await placeMarket(pe.key, 'BUY', qty, 'D', 65);
      lg(`📐 STRADDLE: ${atm}CE + ${atm}PE × ${calcLots}lots @ spot=${spot} | TP=${tp}pt SL=${sl}pt`, 's');
      return ok({ ok:true, spot, ceStrike:atm, peStrike:atm,
        ceKey:ce.key, peKey:pe.key, ceOrderId:ceOid, peOrderId:peOid,
        expiry, lots:calcLots, ceLtp:ce.ltp, peLtp:pe.ltp });
    } catch(e) { lg('Straddle entry: '+e.message,'e'); return ok({ok:false,error:e.message}); }
  }

  // ── POST /engine/straddle/close-leg ─────────────────────
  if (p === '/engine/straddle/close-leg' && req.method === 'POST') {
    if (!ST.token) return ok({ ok: false, error: 'No token' }, 400);
    const { leg, instrKey, lots=6 } = body;
    try {
      const qty  = lots * 65;
      const oid  = await placeMarket(instrKey, 'SELL', qty, 'D', 65);
      const fill = await waitFill(oid);
      lg(`📐 Straddle ${leg} CLOSED: fill=${fill}`, 's');
      return ok({ ok: true, leg, orderId: oid, fillPrice: fill });
    } catch(e) { return ok({ ok: false, error: e.message }); }
  }

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
    saveState();
    lg('🔑 Token received', 's');
    // Auto-start tick collector if market hours and collector installed
    autoStartTickCollector();
    // SR resets to off (its default) on a new day even if the process never restarted
    srResetIfNewDay();
    // NIFTY straddle is opt-in every day now too — same reasoning as SR
    seResetIfNewDay();
    // BankNifty straddle is opt-in every day too
    seBnResetIfNewDay();
    // BankNifty SMA is opt-in every day too
    smBnResetIfNewDay();
    // Always-on by default: SMA-NIFTY resumes automatically unless user turned it off today
    smAutoStartIfNeeded();
    return ok({ ok: true, straddleActive: SE.active, straddleStoppedToday: SE.stoppedToday,
                straddleBnActive: SE_BN.active, straddleBnStoppedToday: SE_BN.stoppedToday,
                smaActive: SM.active, smaBnActive: SM_BN.active, srActive: ST.srActive });
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
      srActive: ST.srActive !== false,
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
          const slotInst = (slot.lotSize===30||(slot.name||'').startsWith('BN')) ? 'BN' : 'NF';
          const spot   = await getSpot(slotInst);
          const step   = slot.step || 50;
          const atm    = Math.round(spot / step) * step;
          const otm    = slot.otm || 1;
          const strike = firedSet.direction === 'CE' ? atm + otm*step : atm - otm*step;
          say(`${slotInst} Spot=${spot.toFixed(2)} ATM=${atm} Strike=${strike}${firedSet.direction} OTM=${otm}`);
          const expiry = await getLiveExpiry(slotInst);
          say(`Expiry: ${expiry}`);
          const { key, ltp } = await findInstrument(expiry, strike, firedSet.direction, slotInst);
          say(`✅ Instrument found: ${key} LTP=${ltp}`, 's');
          say(`WOULD PLACE: BUY ${slotInst} ${strike}${firedSet.direction} @ ~${ltp} | SL=${slot.sl} TGT=${slot.tgt}`, 's');
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

  // ── POST /v2/login/authorization/token (OAuth proxy) ────
  // App calls this to exchange auth code for access token
  if (p === '/v2/login/authorization/token' && req.method === 'POST') {
    try {
      const d = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.upstox.com',
          path: '/v2/login/authorization/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Api-Version': '2.0',
            'Content-Length': Buffer.byteLength(rawBody),
          },
        };
        const r = require('https').request(opts, resp => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
            catch(e) { resolve({ status: resp.statusCode, body: data }); }
          });
        });
        r.on('error', reject);
        r.write(rawBody);
        r.end();
      });
      res.writeHead(d.status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d.body));
      lg('OAuth token exchange: HTTP ' + d.status, d.status === 200 ? 's' : 'e');
    } catch(e) {
      lg('OAuth proxy error: ' + e.message, 'e');
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  ok({ error: 'Unknown endpoint' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  lg(`Cloud engine v3 started on port ${PORT}`, 's');
  loadState();
  loadSlots();
  seLoadState();
  seBnLoadState();
  smLoadState();
  smBnLoadState();
  btScheduleDailyRun();
  lg('BT daily scheduler started (fires at 15:32 IST)', 'i');
});

// ══════════════════════════════════════════════════════════
// CRASH SAFETY — an uncaught error or unhandled promise rejection
// anywhere (SR slots, straddle, backtest) would otherwise kill the
// whole Node process. Node restarting fresh is exactly what wipes
// SE's in-memory trades/log and forces re-activation from the app.
// Log it and keep running instead of dying.
// ══════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  try { lg(`🔥 uncaughtException: ${err && err.stack || err}`, 'e'); } catch(_) { console.error(err); }
});
process.on('unhandledRejection', (err) => {
  try { lg(`🔥 unhandledRejection: ${err && err.stack || err}`, 'e'); } catch(_) { console.error(err); }
});
