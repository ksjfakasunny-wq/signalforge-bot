const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const TESTNET    = process.env.BINANCE_TESTNET === 'true';
const BASE_URL   = TESTNET ? 'testnet.binancefuture.com' : 'fapi.binance.com';
const SYMBOL     = process.env.SYMBOL      || 'BTCUSDT';
const QUANTITY   = process.env.QUANTITY    || '0.001';
const TP_ATR_MULT= parseFloat(process.env.TP_ATR_MULT || '3.0');
const SL_ATR_MULT= parseFloat(process.env.SL_ATR_MULT || '0.5');
const LEVERAGE   = parseInt(process.env.LEVERAGE   || '1');

let trades  = [];
let openPos = null;

function binanceRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    const query     = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const fullQuery = `${query}&signature=${signature}`;
    const options = {
      hostname: BASE_URL,
      path:     method === 'GET' ? `${path}?${fullQuery}` : path,
      method,
      headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
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

function getCurrentPrice(symbol) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path:     `/fapi/v1/ticker/price?symbol=${symbol}`,
      method:   'GET',
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const price  = parseFloat(parsed.price);
          if (!price || price <= 0) reject(new Error('Bad price: ' + data));
          else resolve(price);
        } catch (e) { reject(new Error('Price parse failed: ' + data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getATR(symbol, interval = '3m', atrLen = 14) {
  const klines = await binanceRequest('GET', '/fapi/v1/klines', { symbol, interval, limit: atrLen + 5 });
  if (!klines || klines.length < atrLen) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high  = parseFloat(klines[i][2]);
    const low   = parseFloat(klines[i][3]);
    const pClose= parseFloat(klines[i-1][4]);
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  const recent = trs.slice(-atrLen);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

async function setLeverage(symbol, leverage) {
  try { await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage }); }
  catch (e) { console.log('Leverage note:', e.message); }
}

async function placeMarketOrder(symbol, side, quantity) {
  return binanceRequest('POST', '/fapi/v1/order', { symbol, side, type: 'MARKET', quantity });
}

async function placeTPOrder(symbol, side, quantity, price) {
  const limitPrice = parseFloat(price.toFixed(1));
  const result = await binanceRequest('POST', '/fapi/v1/order', {
    symbol, side,
    type:        'LIMIT',
    price:       limitPrice,
    quantity,
    reduceOnly:  'true',
    timeInForce: 'GTC',
  });
  console.log('TP order result:', JSON.stringify(result));
  return result;
}

async function placeSLOrder(symbol, side, quantity, price) {
  const stopPrice  = parseFloat(price.toFixed(1));
  // STOP order needs a limit price slightly beyond the stop
  const limitPrice = side === 'SELL'
    ? parseFloat((price * 0.998).toFixed(1))
    : parseFloat((price * 1.002).toFixed(1));
  const result = await binanceRequest('POST', '/fapi/v1/order', {
    symbol, side,
    type:        'STOP',
    stopPrice,
    price:       limitPrice,
    quantity,
    reduceOnly:  'true',
    timeInForce: 'GTC',
  });
  console.log('SL order result:', JSON.stringify(result));
  return result;
}

async function cancelAllOrders(symbol) {
  try { await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }); }
  catch (e) { console.log('Cancel orders note:', e.message); }
}

async function checkExistingPosition() {
  try {
    const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL });
    const pos = positions.find(p => p.symbol === SYMBOL);
    if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) {
      const amt        = parseFloat(pos.positionAmt);
      const side       = amt > 0 ? 'BUY' : 'SELL';
      const entryPrice = parseFloat(pos.entryPrice);
      const atr        = await getATR(SYMBOL, '3m', 14);
      const tp = side === 'BUY' ? entryPrice + atr * TP_ATR_MULT : entryPrice - atr * TP_ATR_MULT;
      const sl = side === 'BUY' ? entryPrice - atr * SL_ATR_MULT : entryPrice + atr * SL_ATR_MULT;
      openPos = { side, entry: entryPrice, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString(), restored: true };
      console.log(`⚠️  Existing position restored: ${side} @ ${entryPrice} | TP: ${tp.toFixed(1)} | SL: ${sl.toFixed(1)}`);
    } else {
      console.log('✅ No existing position — starting fresh');
    }
  } catch (e) {
    console.log('Startup position check error:', e.message);
  }
}

async function checkPositionClosed() {
  if (!openPos) return;
  try {
    const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL });
    const pos = positions.find(p => p.symbol === SYMBOL);
    if (pos && parseFloat(pos.positionAmt) === 0) {
      console.log('Position closed by Binance (TP or SL hit)');
      const exitPrice = await getCurrentPrice(SYMBOL);
      const pnl = openPos.side === 'BUY'
        ? (exitPrice - openPos.entry) * parseFloat(QUANTITY)
        : (openPos.entry - exitPrice) * parseFloat(QUANTITY);
      trades.unshift({
        time:   new Date().toISOString(),
        side:   openPos.side,
        entry:  openPos.entry,
        exit:   exitPrice,
        tp:     openPos.tp,
        sl:     openPos.sl,
        pnl:    pnl.toFixed(4),
        result: pnl > 0 ? 'TP WIN ✅' : 'SL LOSS ❌',
      });
      console.log(`Trade closed — ${pnl > 0 ? 'WIN ✅' : 'LOSS ❌'} | PNL: ${pnl.toFixed(4)} USDT`);
      openPos = null;
    }
  } catch (e) {
    console.log('Position poll error:', e.message);
  }
}

setInterval(checkPositionClosed, 30000);

app.post('/webhook', async (req, res) => {
  const { sentiment } = req.body;
  console.log(`[${new Date().toISOString()}] Webhook:`, req.body);

  if (sentiment === 'flat') {
    if (!openPos) return res.json({ ok: true, message: 'No open position' });
    try {
      await cancelAllOrders(SYMBOL);
      const exitPrice = await getCurrentPrice(SYMBOL);
      const pnl = openPos.side === 'BUY'
        ? (exitPrice - openPos.entry) * parseFloat(QUANTITY)
        : (openPos.entry - exitPrice) * parseFloat(QUANTITY);
      trades.unshift({ time: new Date().toISOString(), side: openPos.side, entry: openPos.entry, exit: exitPrice, tp: openPos.tp, sl: openPos.sl, pnl: pnl.toFixed(4), result: 'MANUAL EXIT' });
      openPos = null;
      return res.json({ ok: true, message: 'Position closed', pnl: pnl.toFixed(4) });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  if (sentiment !== 'long' && sentiment !== 'short') {
    return res.json({ ok: true, message: 'Not an entry signal' });
  }

  if (openPos) {
    console.log('Already in position — ignoring signal');
    return res.json({ ok: true, message: 'Already in position — ignored' });
  }

  try {
    await setLeverage(SYMBOL, LEVERAGE);

    const [currentPrice, atr] = await Promise.all([
      getCurrentPrice(SYMBOL),
      getATR(SYMBOL, '3m', 14)
    ]);

    if (!atr)          throw new Error('Could not calculate ATR');
    if (!currentPrice) throw new Error('Could not get current price');

    const side      = sentiment === 'long' ? 'BUY' : 'SELL';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    const entryOrder = await placeMarketOrder(SYMBOL, side, QUANTITY);
    console.log('Entry order:', JSON.stringify(entryOrder));

    const rawAvg     = parseFloat(entryOrder.avgPrice || 0);
    const entryPrice = rawAvg > 0 ? rawAvg : currentPrice;

    const tp = side === 'BUY' ? entryPrice + atr * TP_ATR_MULT : entryPrice - atr * TP_ATR_MULT;
    const sl = side === 'BUY' ? entryPrice - atr * SL_ATR_MULT : entryPrice + atr * SL_ATR_MULT;

    await placeTPOrder(SYMBOL, closeSide, QUANTITY, tp);
    await placeSLOrder(SYMBOL, closeSide, QUANTITY, sl);

    openPos = { side, entry: entryPrice, tp, sl, atr, qty: QUANTITY, openedAt: new Date().toISOString() };
    console.log(`ENTRY ${side} @ ${entryPrice.toFixed(1)} | TP: ${tp.toFixed(1)} | SL: ${sl.toFixed(1)} | ATR: ${atr.toFixed(1)}`);

    res.json({ ok: true, side, entry: entryPrice.toFixed(1), tp: tp.toFixed(1), sl: sl.toFixed(1), atr: atr.toFixed(1), rr: `${TP_ATR_MULT/SL_ATR_MULT}:1` });

  } catch (e) {
    console.error('Trade error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ ok: true, testnet: TESTNET, symbol: SYMBOL, quantity: QUANTITY, leverage: LEVERAGE, tpMult: TP_ATR_MULT, slMult: SL_ATR_MULT, rr: `${TP_ATR_MULT/SL_ATR_MULT}:1`, openPos, recentTrades: trades.slice(0, 20) });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), testnet: TESTNET });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`ATR14 Binance Futures Bot | Mode: ${TESTNET ? 'TESTNET' : 'LIVE'} | Symbol: ${SYMBOL} | Port: ${PORT}`);
  await checkExistingPosition();
});

