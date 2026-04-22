const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Config ────────────────────────────────────────────
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const TESTNET    = process.env.BINANCE_TESTNET === 'true';
const BASE_URL   = TESTNET
  ? 'testnet.binancefuture.com'
  : 'fapi.binance.com';

const SYMBOL     = process.env.SYMBOL   || 'BTCUSDT';
const QUANTITY   = process.env.QUANTITY || '0.001';  // testnet BTC qty
const TP_ATR_MULT= parseFloat(process.env.TP_ATR_MULT || '3.0');
const SL_ATR_MULT= parseFloat(process.env.SL_ATR_MULT || '0.5');
const LEVERAGE   = parseInt(process.env.LEVERAGE || '1');

// ── Trade log ─────────────────────────────────────────
let trades   = [];
let openPos  = null;  // { side, entry, tp, sl, qty, atr, openedAt }

// ── Binance API helper ────────────────────────────────
function binanceRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    params.recvWindow = 5000;

    const query     = new URLSearchParams(params).toString();
    const signature = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(query)
      .digest('hex');
    const fullQuery = `${query}&signature=${signature}`;

    const options = {
      hostname: BASE_URL,
      path:     method === 'GET'
                  ? `${path}?${fullQuery}`
                  : path,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data)); }
      });
    });

    req.on('error', reject);
    if (method !== 'GET') req.write(fullQuery);
    req.end();
  });
}

// ── Get current ATR from Binance klines ───────────────
async function getATR(symbol, interval = '3m', atrLen = 14) {
  const klines = await binanceRequest('GET', '/fapi/v1/klines', {
    symbol, interval, limit: atrLen + 5
  });
  if (!klines || klines.length < atrLen) return null;

  // Calculate ATR (Wilder's smoothed)
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high  = parseFloat(klines[i][2]);
    const low   = parseFloat(klines[i][3]);
    const pClose= parseFloat(klines[i-1][4]);
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  // Simple average of last atrLen TRs
  const recent = trs.slice(-atrLen);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ── Set leverage ──────────────────────────────────────
async function setLeverage(symbol, leverage) {
  try {
    await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
  } catch (e) {
    console.log('Leverage already set or error:', e.message);
  }
}

// ── Place market order ────────────────────────────────
async function placeMarketOrder(symbol, side, quantity) {
  return binanceRequest('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity,
  });
}

// ── Place TP limit order ──────────────────────────────
async function placeTPOrder(symbol, side, quantity, price) {
  const roundedPrice = Math.round(price * 10) / 10; // BTC 1dp
  return binanceRequest('POST', '/fapi/v1/order', {
    symbol,
    side,        // opposite to entry
    type:         'TAKE_PROFIT_MARKET',
    stopPrice:    roundedPrice,
    closePosition: 'true',
    timeInForce:  'GTE_GTC',
  });
}

// ── Place SL stop order ───────────────────────────────
async function placeSLOrder(symbol, side, quantity, price) {
  const roundedPrice = Math.round(price * 10) / 10;
  return binanceRequest('POST', '/fapi/v1/order', {
    symbol,
    side,
    type:          'STOP_MARKET',
    stopPrice:     roundedPrice,
    closePosition: 'true',
    timeInForce:   'GTE_GTC',
  });
}

// ── Cancel all open orders ────────────────────────────
async function cancelAllOrders(symbol) {
  try {
    await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  } catch (e) {
    console.log('Cancel orders error:', e.message);
  }
}

// ── Close position at market ──────────────────────────
async function closePosition(symbol, side, quantity) {
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  return binanceRequest('POST', '/fapi/v1/order', {
    symbol,
    side:          closeSide,
    type:          'MARKET',
    quantity,
    reduceOnly:    'true',
  });
}

// ══════════════════════════════════════════════════════
// WEBHOOK ENDPOINT — TradingView sends here
// ══════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  const body   = req.body;
  const action = body.action;    // buy / sell
  const sentiment = body.sentiment; // long / short / flat

  console.log(`[${new Date().toISOString()}] Webhook received:`, body);

  // ── EXIT signal ──────────────────────────────────────
  if (sentiment === 'flat') {
    if (!openPos) {
      return res.json({ ok: true, message: 'No open position to close' });
    }
    try {
      await cancelAllOrders(SYMBOL);
      await closePosition(SYMBOL, openPos.side, QUANTITY);
      const pnl = openPos.side === 'BUY'
        ? (parseFloat(body.price || openPos.entry) - openPos.entry) * parseFloat(QUANTITY)
        : (openPos.entry - parseFloat(body.price || openPos.entry)) * parseFloat(QUANTITY);

      trades.unshift({
        time:   new Date().toISOString(),
        side:   openPos.side,
        entry:  openPos.entry,
        exit:   parseFloat(body.price || openPos.entry),
        tp:     openPos.tp,
        sl:     openPos.sl,
        pnl:    pnl.toFixed(2),
        result: 'MANUAL EXIT',
      });
      openPos = null;
      return res.json({ ok: true, message: 'Position closed' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── ENTRY signal ─────────────────────────────────────
  if (sentiment !== 'long' && sentiment !== 'short') {
    return res.json({ ok: true, message: 'Not an entry signal — ignored' });
  }

  // Block if already in position
  if (openPos) {
    console.log('Already in position — ignoring entry signal');
    return res.json({ ok: true, message: 'Already in position — signal ignored' });
  }

  try {
    // Set leverage
    await setLeverage(SYMBOL, LEVERAGE);

    // Get live ATR
    const atr = await getATR(SYMBOL, '3m', 14);
    if (!atr) throw new Error('Could not calculate ATR');

    const side      = sentiment === 'long' ? 'BUY' : 'SELL';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    // Place market entry
    const entryOrder = await placeMarketOrder(SYMBOL, side, QUANTITY);
    const entryPrice = parseFloat(entryOrder.avgPrice || entryOrder.price || body.price || 0);

    // Calculate TP and SL
    const tp = side === 'BUY'
      ? entryPrice + atr * TP_ATR_MULT
      : entryPrice - atr * TP_ATR_MULT;
    const sl = side === 'BUY'
      ? entryPrice - atr * SL_ATR_MULT
      : entryPrice + atr * SL_ATR_MULT;

    // Place bracket orders
    await placeTPOrder(SYMBOL, closeSide, QUANTITY, tp);
    await placeSLOrder(SYMBOL, closeSide, QUANTITY, sl);

    // Record open position
    openPos = { side, entry: entryPrice, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString() };

    console.log(`[${new Date().toISOString()}] ENTRY ${side} @ ${entryPrice} | TP: ${tp.toFixed(1)} | SL: ${sl.toFixed(1)} | ATR: ${atr.toFixed(1)}`);

    res.json({
      ok: true,
      side,
      entry:  entryPrice,
      tp:     tp.toFixed(1),
      sl:     sl.toFixed(1),
      atr:    atr.toFixed(1),
      rr:     `${TP_ATR_MULT / SL_ATR_MULT}:1`,
    });

  } catch (e) {
    console.error('Trade error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /status — current position + recent trades ────
app.get('/status', (req, res) => {
  res.json({
    ok:       true,
    testnet:  TESTNET,
    symbol:   SYMBOL,
    quantity: QUANTITY,
    leverage: LEVERAGE,
    tpMult:   TP_ATR_MULT,
    slMult:   SL_ATR_MULT,
    rr:       `${TP_ATR_MULT / SL_ATR_MULT}:1`,
    openPos,
    recentTrades: trades.slice(0, 20),
  });
});

// ── GET /health ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), testnet: TESTNET });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  ATR14 Binance Futures Bot           ║`);
  console.log(`║  Mode: ${TESTNET ? 'TESTNET ✓' : 'LIVE ⚠️ '}                   ║`);
  console.log(`║  Symbol: ${SYMBOL}                  ║`);
  console.log(`║  TP: ${TP_ATR_MULT}× ATR  SL: ${SL_ATR_MULT}× ATR       ║`);
  console.log(`║  Port: ${PORT}                          ║`);
  console.log(`╚══════════════════════════════════════╝`);
});
