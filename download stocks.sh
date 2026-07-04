node << 'NODEOF'
const https = require('https');
const fs    = require('fs');

const s     = require('child_process').execSync('curl -s http://localhost:8081/engine/token').toString();
const token = JSON.parse(s).token;
if (!token) { console.error('No token'); process.exit(1); }
console.log('Token OK. Downloading', 20 , 'stocks...');

const stocks = [('RELIANCE', 'NSE_EQ%7CRELIANCE'), ('TCS', 'NSE_EQ%7CTCS'), ('HDFCBANK', 'NSE_EQ%7CHDFCBANK'), ('INFY', 'NSE_EQ%7CINFY'), ('ICICIBANK', 'NSE_EQ%7CICICIBANK'), ('SBIN', 'NSE_EQ%7CSBIN'), ('AXISBANK', 'NSE_EQ%7CAXISBANK'), ('BAJFINANCE', 'NSE_EQ%7CBAJFINANCE'), ('KOTAKBANK', 'NSE_EQ%7CKOTAKBANK'), ('TATAMOTORS', 'NSE_EQ%7CTATAMOTORS'), ('WIPRO', 'NSE_EQ%7CWIPRO'), ('HINDUNILVR', 'NSE_EQ%7CHINDUNILVR'), ('ASIANPAINT', 'NSE_EQ%7CASIANPAINT'), ('MARUTI', 'NSE_EQ%7CMARUTI'), ('TITAN', 'NSE_EQ%7CTITAN'), ('LT', 'NSE_EQ%7CLT'), ('SUNPHARMA', 'NSE_EQ%7CSUNPHARMA'), ('ONGC', 'NSE_EQ%7CONGC'), ('NTPC', 'NSE_EQ%7CNTPC'), ('POWERGRID', 'NSE_EQ%7CPOWERGRID')];

// Date chunks: last 2 years monthly
const chunks = [
  ['2024-07-01','2024-08-01'],['2024-08-01','2024-09-01'],['2024-09-01','2024-10-01'],
  ['2024-10-01','2024-11-01'],['2024-11-01','2024-12-01'],['2024-12-01','2025-01-01'],
  ['2025-01-01','2025-02-01'],['2025-02-01','2025-03-01'],['2025-03-01','2025-04-01'],
  ['2025-04-01','2025-05-01'],['2025-05-01','2025-06-01'],['2025-06-01','2025-07-01'],
  ['2025-07-01','2025-08-01'],['2025-08-01','2025-09-01'],['2025-09-01','2025-10-01'],
  ['2025-10-01','2025-11-01'],['2025-11-01','2025-12-01'],['2025-12-01','2026-01-01'],
  ['2026-01-01','2026-02-01'],['2026-02-01','2026-03-01'],['2026-03-01','2026-04-01'],
  ['2026-04-01','2026-05-01'],['2026-05-01','2026-06-01'],['2026-06-01','2026-07-01'],
];

async function fetchChunk(key, from, to) {
  return new Promise(resolve => {
    let d = '';
    https.get({
      hostname: 'api.upstox.com',
      path: '/v2/historical-candle/' + key + '/1minute/' + to + '/' + from,
      headers: {'Authorization':'Bearer '+token,'Accept':'application/json','Api-Version':'2.0'}
    }, res => {
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const candles = (JSON.parse(d)?.data?.candles || []).reverse();
          let rows = '';
          candles.forEach(c => {
            const ist = new Date(new Date(c[0]).getTime() + 5.5*3600000);
            const ts  = ist.toISOString().replace('T',' ').slice(0,16);
            const hhmm = ts.slice(11,16);
            if (hhmm >= '09:15' && hhmm <= '15:29')
              rows += ts+','+c[1]+','+c[2]+','+c[3]+','+c[4]+','+(c[5]||0)+'\n';
          });
          resolve({ rows, n: candles.length });
        } catch(e) { resolve({ rows:'', n:0 }); }
      });
    }).on('error', () => resolve({ rows:'', n:0 }));
  });
}

const dir = '/home/ubuntu/stocks';
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

(async () => {
  for (const [sym, key] of stocks) {
    const out = dir + '/' + sym + '_2y_1min.csv';
    fs.writeFileSync(out, 'timestamp,open,high,low,close,volume\n');
    let total = 0;
    for (const [from, to] of chunks) {
      const { rows, n } = await fetchChunk(key, from, to);
      if (rows) fs.appendFileSync(out, rows);
      total += n;
      await new Promise(r => setTimeout(r, 350));
    }
    const lines = fs.readFileSync(out,'utf8').split('\n').length - 2;
    console.log(sym + ': ' + lines + ' candles saved');
  }
  console.log('\nAll done! Files in /home/ubuntu/stocks/');
})();
NODEOF