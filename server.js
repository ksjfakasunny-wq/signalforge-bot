const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY     = process.env.KUCOIN_API_KEY    || '';
const API_SECRET  = process.env.KUCOIN_SECRET_KEY || '';
const API_PASS    = process.env.KUCOIN_PASSPHRASE || '';
const SYMBOL      = process.env.SYMBOL      || 'XBTUSDTM'; // BTC/USDT perpetual
const LOTS        = parseInt(process.env.LOTS || '3');      // 1 lot = 0.001 BTC
const LEVERAGE    = process.env.LEVERAGE    || '3';
const TP_ATR_MULT = parseFloat(process.env.TP_ATR_MULT || '3.0');
const SL_ATR_MULT = parseFloat(process.env.SL_ATR_MULT || '0.5');

const BASE_URL = 'api-futures.kucoin.com';
const PORT = process.env.PORT || 3000;

// ── State ─────────────────────────────────────────────────────────────────────
let openPos           = null;
let trades            = [];
let slMonitorInterval = null;
let isClosing         = false;
let isEntering        = false;

// ── KuCoin signed request ─────────────────────────────────────────────────────
function kucoinRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const ts        = Date.now().toString();
    const bodyStr   = body ? JSON.stringify(body) : '';
    const signStr   = ts + method.toUpperCase() + path + bodyStr;
    const sign      = crypto.createHmac('sha256', API_SECRET).update(signStr).digest('base64');
    const passHmac  = crypto.createHmac('sha256', API_SECRET).update(API_PASS).digest('base64');

    const options = {
      hostname: BASE_URL,
      path,
      method: method.toUpperCase(),
      headers: {
        'Content-Type':       'application/json',
        'KC-API-KEY':         API_KEY,
        'KC-API-SIGN':        sign,
        'KC-API-TIMESTAMP':   ts,
        'KC-API-PASSPHRASE':  passHmac,
        'KC-API-KEY-VERSION': '2',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code !== '200000') {
            reject(new Error(`KuCoin error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed.data !== undefined ? parsed.data : parsed);
          }
        } catch { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── KuCoin public request ─────────────────────────────────────────────────────
function kucoinPublic(path) {
  return new Promise((resolve, reject) => {
    const options = { hostname: BASE_URL, path, method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data !== undefined ? parsed.data : parsed);
        } catch { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Get mark price ────────────────────────────────────────────────────────────
async function getMarkPrice() {
  const data = await kucoinPublic(`/api/v1/mark-price/${SYMBOL}/current`);
  return parseFloat(data.value);
}

// ── Get ATR14 from 3m klines ──────────────────────────────────────────────────
async function getATR() {
  const to   = Date.now();
  const from = to - (30 * 3 * 60 * 1000); // 30 x 3min candles
  const data = await kucoinPublic(`/api/v1/klines?symbol=${SYMBOL}&granularity=3&from=${from}&to=${to}`);
  // KuCoin kline format: [time, open, high, low, close, volume]
  const trs = data.map((k, i) => {
    const h = parseFloat(k[2]), l = parseFloat(k[3]);
    const pc = i > 0 ? parseFloat(data[i-1][4]) : l;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ── Place market order ────────────────────────────────────────────────────────
async function placeMarketOrder(side, size) {
  return kucoinRequest('POST', '/api/v1/orders', {
    clientOid: Date.now().toString(),
    side,      // 'buy' or 'sell'
    symbol:    SYMBOL,
    type:      'market',
    size,      // number of lots
    leverage:  LEVERAGE,
  });
}

// ── Place limit TP order ──────────────────────────────────────────────────────
async function placeTPOrder(side, size, price) {
  const result = await kucoinRequest('POST', '/api/v1/orders', {
    clientOid:   Date.now().toString(),
    side,
    symbol:      SYMBOL,
    type:        'limit',
    size,
    price:       parseFloat(price.toFixed(1)),
    leverage:    LEVERAGE,
    reduceOnly:  true,
    timeInForce: 'GTC',
  });
  console.log('TP order placed:', JSON.stringify(result));
  return result;
}

// ── Cancel all open orders ────────────────────────────────────────────────────
async function cancelAllOrders() {
  try {
    await kucoinRequest('DELETE', `/api/v1/orders?symbol=${SYMBOL}`);
    console.log('✂️  All open orders cancelled');
  } catch (e) { console.log('Cancel orders (may be none):', e.message); }
}

// ── Close position at market ──────────────────────────────────────────────────
async function placeMarketClose(side, size) {
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  return kucoinRequest('POST', '/api/v1/orders', {
    clientOid:  Date.now().toString(),
    side:       closeSide,
    symbol:     SYMBOL,
    type:       'market',
    size,
    leverage:   LEVERAGE,
    reduceOnly: true,
  });
}

// ── Get open position ─────────────────────────────────────────────────────────
async function getPosition() {
  try {
    const data = await kucoinRequest('GET', `/api/v1/position?symbol=${SYMBOL}`);
    return data;
  } catch (e) { return null; }
}

// ── Close position (shared handler) ──────────────────────────────────────────
async function closePosition(reason, pnl) {
  if (isClosing) return;
  isClosing = true;
  try {
    await cancelAllOrders();
    await placeMarketClose(openPos.side, openPos.lots);
    const emoji = reason === 'TP' ? '✅' : '❌';
    trades.unshift({ ...openPos, closedAt: new Date().toISOString(), result: reason, pnl: pnl.toFixed(2) });
    if (trades.length > 50) trades.pop();
    console.log(`Trade closed — ${reason} ${emoji} | PNL: ${reason === 'TP' ? '+' : ''}${pnl.toFixed(2)} USDT`);
    openPos = null;
    stopMonitor();
  } finally {
    isClosing = false;
  }
}

// ── Price monitor — watches TP and SL every 5s ────────────────────────────────
function startMonitor() {
  if (slMonitorInterval) clearInterval(slMonitorInterval);
  slMonitorInterval = setInterval(async () => {
    if (!openPos || isClosing) return;
    try {
      const mark = await getMarkPrice();
      const { side, sl, tp, entry, lots } = openPos;

      const tpHit = side === 'buy' ? mark >= tp : mark <= tp;
      const slHit = side === 'buy' ? mark <= sl : mark >= sl;

      if (tpHit) {
        console.log(`🎯 TP HIT @ ${mark.toFixed(1)} | level: ${tp.toFixed(1)}`);
        const pnl = side === 'buy'
          ? (tp - entry) * lots * 0.001 * parseFloat(LEVERAGE)
          : (entry - tp) * lots * 0.001 * parseFloat(LEVERAGE);
        await closePosition('TP', pnl);
      } else if (slHit) {
        console.log(`⛔ SL HIT @ ${mark.toFixed(1)} | level: ${sl.toFixed(1)}`);
        const pnl = side === 'buy'
          ? (sl - entry) * lots * 0.001 * parseFloat(LEVERAGE)
          : (entry - sl) * lots * 0.001 * parseFloat(LEVERAGE);
        await closePosition('SL', pnl);
      }
    } catch (e) { console.log('Monitor error:', e.message); }
  }, 5000);
  console.log('🔍 Price monitor active (TP + SL every 5s)');
}

function stopMonitor() {
  if (slMonitorInterval) { clearInterval(slMonitorInterval); slMonitorInterval = null; }
}

// ── Startup position check ────────────────────────────────────────────────────
async function checkExistingPosition(attempt = 1) {
  try {
    const pos = await getPosition();
    if (pos && pos.currentQty && pos.currentQty !== 0) {
      const side  = pos.currentQty > 0 ? 'buy' : 'sell';
      const entry = parseFloat(pos.avgEntryPrice);
      const lots  = Math.abs(pos.currentQty);
      const atr   = await getATR();
      const tp    = side === 'buy' ? entry + atr * TP_ATR_MULT : entry - atr * TP_ATR_MULT;
      const sl    = side === 'buy' ? entry - atr * SL_ATR_MULT : entry + atr * SL_ATR_MULT;
      openPos = { side, entry, tp, sl, atr, lots, openedAt: new Date().toISOString() };
      startMonitor();
      console.log(`⚠️  Position restored: ${side.toUpperCase()} @ ${entry} | TP: ${tp.toFixed(1)} | SL: ${sl.toFixed(1)}`);
    } else {
      await cancelAllOrders();
      console.log('✅ No existing position — starting fresh');
    }
  } catch (e) {
    console.log(`Startup check error (attempt ${attempt}):`, e.message);
    if (attempt < 3) {
      console.log('Retrying in 5s...');
      setTimeout(() => checkExistingPosition(attempt + 1), 5000);
    } else {
      console.log('Startup check failed after 3 attempts — starting fresh');
    }
  }
}

// ── Keep-alive ping ───────────────────────────────────────────────────────────
setInterval(() => {
  const req = https.request({ hostname: 'localhost', port: PORT, path: '/health', method: 'GET' }, () => {});
  req.on('error', () => {});
  req.end();
}, 5 * 60 * 1000);

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { action } = req.body;
    console.log('Webhook:', JSON.stringify(req.body));

    if (openPos || isEntering) {
      console.log('Already in position or entering — ignoring signal');
      return res.json({ ok: false, reason: 'Already in position' });
    }
    isEntering = true;

    try {
      const side      = action === 'buy' ? 'buy' : 'sell';
      const closeSide = side === 'buy' ? 'sell' : 'buy';

      const markPrice  = await getMarkPrice();
      const atr        = await getATR();
      const entryOrder = await placeMarketOrder(side, LOTS);
      console.log('Entry order:', JSON.stringify(entryOrder));

      const entryPrice = markPrice; // use mark price as fill estimate
      const tp = side === 'buy' ? entryPrice + atr * TP_ATR_MULT : entryPrice - atr * TP_ATR_MULT;
      const sl = side === 'buy' ? entryPrice - atr * SL_ATR_MULT : entryPrice + atr * SL_ATR_MULT;

      // Wait for position to register then place TP
      console.log('⏳ Waiting for position to register...');
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const pos = await getPosition();
        if (pos && pos.currentQty && pos.currentQty !== 0) {
          console.log(`✅ Position confirmed after ${i+1}s`);
          break;
        }
      }

      // Place TP limit order
      try {
        await placeTPOrder(closeSide, LOTS, tp);
      } catch (tpErr) {
        console.error('⚠️  TP order failed — monitor protecting:', tpErr.message);
      }

      const tpDollar = (atr * TP_ATR_MULT * LOTS * 0.001 * parseFloat(LEVERAGE)).toFixed(2);
      const slDollar = (atr * SL_ATR_MULT * LOTS * 0.001 * parseFloat(LEVERAGE)).toFixed(2);

      openPos = { side, entry: entryPrice, tp, sl, atr, lots: LOTS, openedAt: new Date().toISOString() };
      startMonitor();

      console.log(`ENTRY ${side.toUpperCase()} @ ${entryPrice.toFixed(1)} | TP: ${tp.toFixed(1)} (+$${tpDollar}) | SL: ${sl.toFixed(1)} (-$${slDollar}) | ATR: ${atr.toFixed(1)} | Leverage: ${LEVERAGE}x`);
      res.json({ ok: true, side, entry: entryPrice.toFixed(1), tp: tp.toFixed(1), sl: sl.toFixed(1), tpDollar, slDollar });

    } finally {
      isEntering = false;
    }

  } catch (e) {
    isEntering = false;
    console.error('Trade error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Manual close ──────────────────────────────────────────────────────────────
app.post('/close', async (req, res) => {
  if (!openPos) return res.json({ ok: false, reason: 'No open position' });
  try {
    const mark = await getMarkPrice();
    const { side, entry, lots } = openPos;
    const pnl = side === 'buy'
      ? (mark - entry) * lots * 0.001 * parseFloat(LEVERAGE)
      : (entry - mark) * lots * 0.001 * parseFloat(LEVERAGE);
    await closePosition('MANUAL', pnl);
    res.json({ ok: true, pnl: pnl.toFixed(2) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Status & Health ───────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ok: true, exchange: 'KuCoin Futures', symbol: SYMBOL,
    lots: LOTS, leverage: LEVERAGE,
    tpMult: TP_ATR_MULT, slMult: SL_ATR_MULT,
    rr: `${TP_ATR_MULT / SL_ATR_MULT}:1`,
    monitorActive: slMonitorInterval !== null,
    isClosing, isEntering,
    openPos, recentTrades: trades.slice(0, 20),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), exchange: 'KuCoin', symbol: SYMBOL });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  if (!API_KEY || !API_SECRET || !API_PASS) {
    console.error('🚨 MISSING API KEYS — set KUCOIN_API_KEY, KUCOIN_SECRET_KEY, KUCOIN_PASSPHRASE');
  }
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  ATR14 Futures Bot — KuCoin Edition          ║`);
  console.log(`║  Exchange:  KuCoin Futures                   ║`);
  console.log(`║  Symbol:    ${SYMBOL.padEnd(12)}              ║`);
  console.log(`║  Lots:      ${String(LOTS).padEnd(12)}              ║`);
  console.log(`║  Leverage:  ${String(LEVERAGE).padEnd(12)}x             ║`);
  console.log(`║  TP: ${TP_ATR_MULT}x ATR  SL: ${SL_ATR_MULT}x ATR  RR: ${TP_ATR_MULT/SL_ATR_MULT}:1       ║`);
  console.log(`║  Monitor:   every 5s (TP + SL)               ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  await checkExistingPosition();
});
