const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY     = process.env.BINANCE_API_KEY    || '';
const API_SECRET  = process.env.BINANCE_SECRET_KEY || '';
const TESTNET     = process.env.BINANCE_TESTNET === 'true';
const SYMBOL      = process.env.SYMBOL      || 'BTCUSDT';
const QUANTITY    = process.env.QUANTITY    || '0.05';
const LEVERAGE    = parseInt(process.env.LEVERAGE    || '10');
const TP_ATR_MULT = parseFloat(process.env.TP_ATR_MULT || '3.0');
const SL_ATR_MULT = parseFloat(process.env.SL_ATR_MULT || '0.5');

const BASE_URL = TESTNET ? 'testnet.binancefuture.com' : 'fapi.binance.com';

// ── State ────────────────────────────────────────────────────────────────────
let openPos           = null;
let trades            = [];
let slMonitorInterval = null;
let isClosing         = false;   // FIX: race condition guard
let isEntering        = false;   // FIX: double webhook guard

// ── Binance signed request ───────────────────────────────────────────────────
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

// ── Binance public request ───────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
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

function extractPosition(data, symbol) {
  if (Array.isArray(data)) return data.find(p => p.symbol === symbol) || null;
  if (data && data.symbol === symbol) return data;
  return null;
}

async function cancelAllOrders(symbol) {
  try {
    await binanceRequest('DELETE', '/allOpenOrders', { symbol });
    console.log('✂️  All open orders cancelled');
  } catch (e) { console.log('Cancel orders (may be none):', e.message); }
}

async function placeMarketOrder(symbol, side, quantity) {
  return binanceRequest('POST', '/order', { symbol, side, quantity, type: 'MARKET' });
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
    symbol, side, type: 'LIMIT',
    price: parseFloat(price.toFixed(1)),
    quantity, reduceOnly: 'true', timeInForce: 'GTC',
  });
  console.log('TP order result:', JSON.stringify(result));
  if (result.code) throw new Error(`TP order failed: ${result.msg}`);
  return result;
}

// ── Close position (shared by SL monitor + TP poll + manual) ────────────────
async function closePosition(reason, pnl) {
  if (isClosing) return;   // FIX: prevent double-close race condition
  isClosing = true;
  try {
    await cancelAllOrders(SYMBOL);
    if (reason === 'SL' || reason === 'MANUAL') await placeMarketClose(SYMBOL, openPos.side, openPos.qty);
    const emoji = reason === 'TP' ? '✅' : '❌';
    trades.unshift({ ...openPos, closedAt: new Date().toISOString(), result: reason, pnl: pnl.toFixed(2) });
    if (trades.length > 50) trades.pop();
    console.log(`Trade closed — ${reason} ${emoji} | PNL: ${reason === 'TP' ? '+' : ''}${pnl.toFixed(2)} USDT`);
    openPos = null;
    stopSLMonitor();
  } finally {
    isClosing = false;
  }
}

// ── SL Monitor ───────────────────────────────────────────────────────────────
function startSLMonitor() {
  if (slMonitorInterval) clearInterval(slMonitorInterval);
  slMonitorInterval = setInterval(async () => {
    if (!openPos || isClosing) return;
    try {
      const mark = await getMarkPrice(SYMBOL);
      const { side, sl, entry, qty } = openPos;
      const slHit = side === 'BUY' ? mark <= sl : mark >= sl;
      if (slHit) {
        console.log(`⛔ SL HIT @ ${mark.toFixed(1)} | level: ${sl.toFixed(1)}`);
        const pnl = side === 'BUY'
          ? (sl - entry) * parseFloat(qty) * LEVERAGE
          : (entry - sl) * parseFloat(qty) * LEVERAGE;
        await closePosition('SL', pnl);
      }
    } catch (e) { console.log('SL monitor error:', e.message); }
  }, 5000);
  console.log('🔍 SL monitor active (every 5s)');
}

function stopSLMonitor() {
  if (slMonitorInterval) { clearInterval(slMonitorInterval); slMonitorInterval = null; }
}

// ── TP Poll (every 15s, skips first 60s after entry to avoid false positives) ─
setInterval(async () => {
  if (!openPos || isClosing) return;

  // FIX: Don't poll for first 60 seconds — Binance needs time to register position
  const secondsOpen = (Date.now() - new Date(openPos.openedAt).getTime()) / 1000;
  if (secondsOpen < 60) return;

  try {
    const data = await binanceRequest('GET', '/positionRisk', { symbol: SYMBOL });
    const pos  = extractPosition(data, SYMBOL);
    const size = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
    if (size === 0) {
      const { tp, entry, qty, side } = openPos;
      const pnl = side === 'BUY'
        ? (tp - entry) * parseFloat(qty) * LEVERAGE
        : (entry - tp) * parseFloat(qty) * LEVERAGE;
      await closePosition('TP', pnl);
    }
  } catch (e) { console.log('TP poll error:', e.message); }
}, 15000);

// ── Keep-alive self-ping to prevent Render free tier sleep ───────────────────
setInterval(() => {
  const req = https.request({ hostname: 'localhost', port: PORT, path: '/health', method: 'GET' }, () => {});
  req.on('error', () => {});
  req.end();
}, 5 * 60 * 1000);

// ── Startup position check (retries 3x) ──────────────────────────────────────
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
      await cancelAllOrders(SYMBOL); // clean up any orphaned orders
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

// ── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { action } = req.body;
    console.log('Webhook:', JSON.stringify(req.body));

    // FIX: double webhook race condition guard
    if (openPos || isEntering) {
      console.log('Already in position or entering — ignoring signal');
      return res.json({ ok: false, reason: 'Already in position' });
    }
    isEntering = true;

    try {
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

      // FIX: wait 2s for Binance to register position before placing TP
      // Prevents -2022 ReduceOnly rejected error
      await new Promise(r => setTimeout(r, 2000));

      // FIX: retry TP up to 3 times
      let tpPlaced = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await placeTPOrder(SYMBOL, closeSide, QUANTITY, tp);
          tpPlaced = true;
          break;
        } catch (tpErr) {
          console.error(`⚠️  TP attempt ${attempt} failed: ${tpErr.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!tpPlaced) console.error('⚠️  TP failed all 3 attempts — SL monitor protecting');

      openPos = { side, entry: entryPrice, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString() };
      startSLMonitor();

      const tpDollar = (atr * TP_ATR_MULT * parseFloat(QUANTITY) * LEVERAGE).toFixed(2);
      const slDollar = (atr * SL_ATR_MULT * parseFloat(QUANTITY) * LEVERAGE).toFixed(2);

      console.log(`ENTRY ${side} @ ${entryPrice.toFixed(1)} | TP: ${tp.toFixed(1)} (+$${tpDollar}) | SL: ${sl.toFixed(1)} (-$${slDollar}) | ATR: ${atr.toFixed(1)} | Leverage: ${LEVERAGE}x`);
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

// ── FIX: Manual close endpoint ───────────────────────────────────────────────
app.post('/close', async (req, res) => {
  if (!openPos) return res.json({ ok: false, reason: 'No open position' });
  try {
    console.log('🔴 Manual close requested');
    const mark = await getMarkPrice(SYMBOL);
    const { side, entry, qty } = openPos;
    const pnl = side === 'BUY'
      ? (mark - entry) * parseFloat(qty) * LEVERAGE
      : (entry - mark) * parseFloat(qty) * LEVERAGE;
    await closePosition('MANUAL', pnl);
    res.json({ ok: true, pnl: pnl.toFixed(2) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Status & Health ──────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ok: true, testnet: TESTNET, symbol: SYMBOL,
    quantity: QUANTITY, leverage: LEVERAGE,
    tpMult: TP_ATR_MULT, slMult: SL_ATR_MULT,
    rr: `${TP_ATR_MULT / SL_ATR_MULT}:1`,
    slMonitorActive: slMonitorInterval !== null,
    isClosing, isEntering,
    openPos, recentTrades: trades.slice(0, 20),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), testnet: TESTNET, symbol: SYMBOL });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  // FIX: API key check on startup
  if (!API_KEY || !API_SECRET) {
    console.error('🚨 MISSING API KEYS — set BINANCE_API_KEY and BINANCE_SECRET_KEY in Render environment');
  }
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  ATR14 Futures Bot — BOT-SIDE SL MONITOR    ║`);
  console.log(`║  Mode:     ${TESTNET ? 'TESTNET ✓' : 'LIVE ⚠️ '}                        ║`);
  console.log(`║  Symbol:   ${SYMBOL.padEnd(12)}              ║`);
  console.log(`║  Quantity: ${String(QUANTITY).padEnd(12)}              ║`);
  console.log(`║  Leverage: ${String(LEVERAGE).padEnd(12)}x             ║`);
  console.log(`║  TP: ${TP_ATR_MULT}x ATR (Binance LIMIT order)         ║`);
  console.log(`║  SL: ${SL_ATR_MULT}x ATR (bot monitors every 5s)       ║`);
  console.log(`║  Keep-alive: ping every 5 min               ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  await checkExistingPosition();
});
