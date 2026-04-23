const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

const API_KEY     = process.env.BINANCE_API_KEY    || '';
const API_SECRET  = process.env.BINANCE_SECRET_KEY || '';
const TESTNET     = process.env.BINANCE_TESTNET === 'true';
const SYMBOL      = process.env.SYMBOL     || 'BTCUSDT';
const QUANTITY    = process.env.QUANTITY   || '0.05';
const LEVERAGE    = parseInt(process.env.LEVERAGE   || '10');
const TP_ATR_MULT = parseFloat(process.env.TP_ATR_MULT || '3.0');
const SL_ATR_MULT = parseFloat(process.env.SL_ATR_MULT || '0.5');

const BASE_URL = TESTNET ? 'testnet.binancefuture.com' : 'fapi.binance.com';

let openPos = null;
let trades  = [];
let slMonitorInterval = null;

function binanceRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    const ts        = Date.now();
    const query     = Object.entries({ ...params, timestamp: ts })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
    const fullPath  = `/fapi/v1${path}?${query}&signature=${signature}`;
    const options   = {
      hostname: BASE_URL, path: fullPath, method,
      headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/json' },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse: ' + data)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function binancePublic(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query    = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    const fullPath = `/fapi/v1${path}${query ? '?' + query : ''}`;
    const options  = { hostname: BASE_URL, path: fullPath, method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse: ' + data)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getMarkPrice(symbol) {
  const data = await binancePublic('/premiumIndex', { symbol });
  return parseFloat(data.markPrice);
}

async function getATR(symbol) {
  const klines = await binancePublic('/klines', { symbol, interval: '3m', limit: 30 });
  const trs = klines.map(k => {
    const h = parseFloat(k[2]), l = parseFloat(k[3]), pc = parseFloat(k[4]);
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

async function cancelAllOrders(symbol) {
  try {
    await binanceRequest('DELETE', '/allOpenOrders', { symbol });
    console.log('All open orders cancelled');
  } catch (e) { console.log('Cancel orders:', e.message); }
}

async function placeMarketClose(symbol, side, quantity) {
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  return binanceRequest('POST', '/order', {
    symbol, side: closeSide, quantity,
    type: 'MARKET', reduceOnly: 'true',
  });
}

async function placeTPOrder(symbol, side, quantity, price) {
  const result = await binanceRequest('POST', '/order', {
    symbol, side,
    type: 'LIMIT',
    price: parseFloat(price.toFixed(1)),
    quantity, reduceOnly: 'true', timeInForce: 'GTC',
  });
  console.log('TP order result:', JSON.stringify(result));
  return result;
}

// ── BOT-SIDE SL MONITOR (replaces broken Binance SL order) ──────────────────
function startSLMonitor() {
  if (slMonitorInterval) clearInterval(slMonitorInterval);
  slMonitorInterval = setInterval(async () => {
    if (!openPos) return;
    try {
      const mark = await getMarkPrice(SYMBOL);
      const { side, sl, entry, tp, qty } = openPos;
      const slHit = side === 'BUY' ? mark <= sl : mark >= sl;

      if (slHit) {
        console.log(`⛔ SL HIT @ ${mark.toFixed(1)} | SL level was ${sl.toFixed(1)} | Closing...`);
        await cancelAllOrders(SYMBOL);
        await placeMarketClose(SYMBOL, side, qty);
        const pnl = side === 'BUY'
          ? (sl - entry) * parseFloat(qty) * LEVERAGE
          : (entry - sl) * parseFloat(qty) * LEVERAGE;
        trades.unshift({ ...openPos, closedAt: new Date().toISOString(), result: 'SL', pnl: pnl.toFixed(2) });
        if (trades.length > 50) trades.pop();
        console.log(`Trade closed — LOSS ❌ | PNL: ${pnl.toFixed(2)} USDT`);
        openPos = null;
        stopSLMonitor();
      }
    } catch (e) { console.log('SL monitor error:', e.message); }
  }, 5000);
  console.log('🔍 SL monitor active (checking every 5s)');
}

function stopSLMonitor() {
  if (slMonitorInterval) { clearInterval(slMonitorInterval); slMonitorInterval = null; }
}

// ── TP POLL — detect when Binance closes position via TP limit ───────────────
setInterval(async () => {
  if (!openPos) return;
  try {
    const data = await binanceRequest('GET', '/positionRisk', { symbol: SYMBOL });
    const pos  = extractPosition(data, SYMBOL);
    const size = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
    if (size === 0) {
      // FIX 1: Cancel any orphaned TP orders left on Binance
      await cancelAllOrders(SYMBOL);
      const pnl = openPos.side === 'BUY'
        ? (openPos.tp - openPos.entry) * parseFloat(openPos.qty) * LEVERAGE
        : (openPos.entry - openPos.tp) * parseFloat(openPos.qty) * LEVERAGE;
      trades.unshift({ ...openPos, closedAt: new Date().toISOString(), result: 'TP', pnl: pnl.toFixed(2) });
      if (trades.length > 50) trades.pop();
      console.log(`Trade closed — WIN ✅ | TP hit | PNL: +${pnl.toFixed(2)} USDT`);
      openPos = null;
      stopSLMonitor();
    }
  } catch (e) { console.log('TP poll error:', e.message); }
}, 30000);

// ── Helper: extract position from positionRisk response (array or object) ────
function extractPosition(data, symbol) {
  if (Array.isArray(data)) return data.find(p => p.symbol === symbol) || null;
  if (data && data.symbol === symbol) return data;
  return null;
}

// ── Startup position check (retries 3x with delay) ──────────────────────────
async function checkExistingPosition(attempt = 1) {
  try {
    const data = await binanceRequest('GET', '/positionRisk', { symbol: SYMBOL });
    const pos  = extractPosition(data, SYMBOL);
    const size = pos ? parseFloat(pos.positionAmt) : 0;
    if (Math.abs(size) > 0) {
      const side  = size > 0 ? 'BUY' : 'SELL';
      const entry = parseFloat(pos.entryPrice);
      const atr   = await getATR(SYMBOL);
      const tp    = side === 'BUY' ? entry + atr * TP_ATR_MULT : entry - atr * TP_ATR_MULT;
      const sl    = side === 'BUY' ? entry - atr * SL_ATR_MULT : entry + atr * SL_ATR_MULT;
      openPos = { side, entry, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString() };
      startSLMonitor();
      console.log(`⚠️  Position restored: ${side} @ ${entry} | TP: ${tp.toFixed(1)} | SL: ${sl.toFixed(1)}`);
    } else {
      // FIX 2: No position — cancel any orphaned open orders left from previous session
      await cancelAllOrders(SYMBOL);
      console.log('✅ No existing position — starting fresh');
    }
  } catch (e) {
    console.log(`Startup check error (attempt ${attempt}):`, e.message);
    // FIX 2: Retry up to 3 times with 5s delay
    if (attempt < 3) {
      console.log(`Retrying in 5s...`);
      setTimeout(() => checkExistingPosition(attempt + 1), 5000);
    } else {
      console.log('Startup check failed after 3 attempts — starting fresh');
    }
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { action } = req.body;
    console.log('Webhook:', JSON.stringify(req.body));

    if (openPos) {
      console.log('Already in position — ignoring signal');
      return res.json({ ok: false, reason: 'Already in position' });
    }

    const side      = action === 'buy' ? 'BUY' : 'SELL';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    await binanceRequest('POST', '/leverage', { symbol: SYMBOL, leverage: LEVERAGE });

    const currentPrice = await getMarkPrice(SYMBOL);
    const atr          = await getATR(SYMBOL);
    const entryOrder   = await placeMarketOrder(SYMBOL, side, QUANTITY);
    console.log('Entry order:', JSON.stringify(entryOrder));

    const rawAvg     = parseFloat(entryOrder.avgPrice || 0);
    const entryPrice = rawAvg > 0 ? rawAvg : currentPrice;

    const tp = side === 'BUY' ? entryPrice + atr * TP_ATR_MULT : entryPrice - atr * TP_ATR_MULT;
    const sl = side === 'BUY' ? entryPrice - atr * SL_ATR_MULT : entryPrice + atr * SL_ATR_MULT;

    await placeTPOrder(SYMBOL, closeSide, QUANTITY, tp);

    openPos = { side, entry: entryPrice, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString() };
    startSLMonitor();

    const tpDollar = (atr * TP_ATR_MULT * parseFloat(QUANTITY) * LEVERAGE).toFixed(2);
    const slDollar = (atr * SL_ATR_MULT * parseFloat(QUANTITY) * LEVERAGE).toFixed(2);

    console.log(`ENTRY ${side} @ ${entryPrice.toFixed(1)} | TP: ${tp.toFixed(1)} (+$${tpDollar}) | SL: ${sl.toFixed(1)} (-$${slDollar}) | ATR: ${atr.toFixed(1)} | Leverage: ${LEVERAGE}x`);
    res.json({ ok: true, side, entry: entryPrice.toFixed(1), tp: tp.toFixed(1), sl: sl.toFixed(1), tpDollar, slDollar });

  } catch (e) {
    console.error('Trade error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function placeMarketOrder(symbol, side, quantity) {
  return binanceRequest('POST', '/order', { symbol, side, quantity, type: 'MARKET' });
}

app.get('/status', (req, res) => {
  res.json({
    ok: true, testnet: TESTNET, symbol: SYMBOL,
    quantity: QUANTITY, leverage: LEVERAGE,
    tpMult: TP_ATR_MULT, slMult: SL_ATR_MULT,
    rr: `${TP_ATR_MULT / SL_ATR_MULT}:1`,
    slMonitorActive: slMonitorInterval !== null,
    openPos, recentTrades: trades.slice(0, 20),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), testnet: TESTNET });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  ATR14 Futures Bot — BOT-SIDE SL MONITOR    ║`);
  console.log(`║  Mode:     ${TESTNET ? 'TESTNET ✓' : 'LIVE ⚠️ '}                        ║`);
  console.log(`║  Symbol:   ${SYMBOL.padEnd(12)}              ║`);
  console.log(`║  Quantity: ${String(QUANTITY).padEnd(12)}              ║`);
  console.log(`║  Leverage: ${String(LEVERAGE).padEnd(12)}x             ║`);
  console.log(`║  TP: ${TP_ATR_MULT}x ATR (Binance LIMIT order)         ║`);
  console.log(`║  SL: ${SL_ATR_MULT}x ATR (bot monitors every 5s)       ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  await checkExistingPosition();
});
