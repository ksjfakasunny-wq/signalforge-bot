# SignalForge Bot — ATR14 Binance Futures

Receives TradingView webhook signals and places orders directly on Binance Futures with automatic TP and SL bracket orders.

## Railway Environment Variables

Set these in Railway → your project → Variables:

| Variable | Value | Description |
|---|---|---|
| `BINANCE_API_KEY` | your key | Binance Futures API key |
| `BINANCE_SECRET_KEY` | your secret | Binance Futures secret key |
| `BINANCE_TESTNET` | `true` | Use testnet (set false for live) |
| `SYMBOL` | `BTCUSDT` | Trading pair |
| `QUANTITY` | `0.001` | BTC quantity per trade |
| `LEVERAGE` | `1` | Futures leverage (1 = no leverage) |
| `TP_ATR_MULT` | `3.0` | TP distance in ATR multiples |
| `SL_ATR_MULT` | `0.5` | SL distance in ATR multiples |

## TradingView Alert JSON

### Entry Long
```json
{"ticker":"BTCUSDT","action":"buy","sentiment":"long","orderType":"market"}
```

### Entry Short
```json
{"ticker":"BTCUSDT","action":"sell","sentiment":"short","orderType":"market"}
```

### Webhook URL
```
https://your-railway-url.up.railway.app/webhook
```

## Endpoints

- `GET /health` — server status
- `GET /status` — current position + recent trades
- `POST /webhook` — TradingView signals

## How It Works

1. TradingView fires alert → webhook hits Railway bot
2. Bot fetches live ATR from Binance (3m candles, ATR14)
3. Bot places MARKET entry order on Binance Futures Testnet
4. Bot immediately places:
   - TAKE_PROFIT_MARKET order at entry ± 3× ATR
   - STOP_MARKET order at entry ∓ 0.5× ATR
5. Binance monitors and closes automatically — no exit alerts needed
6. Position logged to /status endpoint
