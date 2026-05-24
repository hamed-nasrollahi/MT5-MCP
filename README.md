# MT5 MCP Server

A **Model Context Protocol (MCP) server** that gives Claude AI full read/analysis access to MetaTrader 5 — chart objects, indicators, historical data, and backtesting.

---

## Architecture

```
Claude Desktop
     │  (MCP stdio)
     ▼
 mt5-mcp-server  (Node.js)
     │  (TCP 127.0.0.1:6789, newline-delimited JSON)
     ▼
MT5_MCP_Bridge.mq5  (Expert Advisor inside MT5)
     │  (MQL5 Socket API)
     ▼
MetaTrader 5 Terminal
```

---

## Quick Install

### Prerequisites
- Node.js ≥ 18
- MetaTrader 5 installed and running
- Claude Desktop app

### 1 — Clone / download this folder

```bash
cd mt5-mcp-server
npm run install-ea      # auto-detects MT5, copies EA, registers with Claude
```

The installer will:
- Search default MT5 installation paths
- Ask for the path if not found
- Compare versions and upgrade if needed
- Copy `MT5_MCP_Bridge.mq5` to `MQL5/Experts/MT5_MCP/`
- Install npm packages
- Add the server to `claude_desktop_config.json`

### 2 — MetaTrader 5 setup

1. Open MetaTrader 5
2. Go to **Tools → Options → Expert Advisors** and tick:
   - ✅ Allow automated trading
   - ✅ Allow DLL imports
3. In **Navigator** panel → **Expert Advisors** → right-click → **Refresh**
4. You need the **JAson.mqh** library:
   - Download from: https://www.mql5.com/en/code/13663
   - Copy `JAson.mqh` to `MQL5/Include/`
5. Drag **MT5_MCP / MT5_MCP_Bridge** onto any chart
6. Enable **Allow Live Trading** in the EA dialog if prompted
7. You should see: `MT5_MCP_Bridge listening on 127.0.0.1:6789` in the Experts log

### 3 — Restart Claude Desktop

After restart, test by asking Claude:

> *"Check mt5 status"*

---

## Configuration

| Environment variable | Default        | Description                 |
|---------------------|----------------|-----------------------------|
| `MT5_HOST`          | `127.0.0.1`    | EA bind address             |
| `MT5_PORT`          | `6789`         | TCP port                    |

To change port, edit both `claude_desktop_config.json` (env section) and the EA input parameter.

---

## Available Tools

### 🔌 Connectivity
| Tool | Description |
|------|-------------|
| `mt5_status` | Check if bridge is online, get account/terminal info |

### 📊 Market Data
| Tool | Description |
|------|-------------|
| `mt5_get_candles` | Fetch OHLCV bars (up to 100,000) for any symbol/timeframe |
| `mt5_get_tick` | Live bid/ask/spread for a symbol |
| `mt5_get_chart_info` | Active chart symbol, timeframe, bar count |
| `mt5_list_symbols` | All available trading symbols |

### 🖊️ Chart Objects
| Tool | Description |
|------|-------------|
| `mt5_add_object` | Add any chart object (see full list below) |
| `mt5_modify_object` | Change object properties |
| `mt5_delete_object` | Remove an object by name |
| `mt5_list_objects` | List all objects on a chart |
| `mt5_clear_objects` | Bulk delete by prefix |

**Supported object types:**
- **Lines**: `HLINE`, `VLINE`, `TRENDLINE`, `RAY`, `EXTENDED`
- **Channels**: `CHANNEL`, `STDDEVCHANNEL`, `REGRESSION`
- **Geometric**: `RECTANGLE`, `TRIANGLE`, `ELLIPSE`
- **Fibonacci**: `FIBO`, `FIBOARC`, `FIBOFAN`, `FIBOCHANNEL`, `FIBOTIMEZONES`, `FIBOEXPANSION`
- **Gann**: `GANNLINE`, `GANNGRID`, `GANNFAN`
- **Elliott**: `ELLIOTWAVE3`, `ELLIOTWAVE5`
- **Text/UI**: `TEXT`, `LABEL`, `BUTTON`, `RECTANGLE_LABEL`
- **Arrows**: `ARROW`, `ARROW_BUY`, `ARROW_SELL`, `ARROW_CHECK`

### 📈 Indicators
| Tool | Description |
|------|-------------|
| `mt5_add_indicator` | Add built-in or custom indicator, returns handle |
| `mt5_get_indicator_values` | Read buffer values for N bars |
| `mt5_remove_indicator` | Release indicator handle |
| `mt5_list_indicators` | List active handles |

**Built-in indicators**: `MA`, `EMA`, `MACD`, `RSI`, `BBANDS`, `STOCH`, `ATR`, `ADX`, `CCI`, `DEMA`, `TEMA`, `ICHIMOKU`, `SAR`, `WILLIAMS`, `MOMENTUM`, `MFI`, `OBV`, `VOLUMES`, `ZIGZAG`, `FRACTALS`

### 🔬 Backtesting
| Tool | Description |
|------|-------------|
| `mt5_backtest_strategy` | Full strategy backtest with chart annotation |
| `mt5_backtest_indicator_cross` | Quick MA-cross backtest |
| `mt5_scroll_chart` | Navigate chart to a specific datetime |

Backtesting draws directly on the chart:
- 🔵 Blue up-arrow = BUY signal
- 🔴 Red down-arrow = SELL signal  
- 🟩 Green box = winning trade
- 🟥 Red box = losing trade
- Dashed lines = entry / SL / TP levels

### 💼 Account (Read-only)
| Tool | Description |
|------|-------------|
| `mt5_account_info` | Balance, equity, margin, leverage, broker |
| `mt5_symbol_info` | Symbol specs (lot size, spread, swaps…) |
| `mt5_open_positions` | Current open positions |
| `mt5_order_history` | Historical deals |
| `mt5_order_requirements` | What's needed to enable live trading |

---

## Example Claude Prompts

```
Check my MT5 status and tell me if it's connected.

Fetch the last 200 H1 candles for EURUSD and identify the trend.

Add a Fibonacci retracement from the high at 2024-01-15 to the 
low at 2024-01-22 on the XAUUSD chart.

Add an RSI(14) indicator and tell me the current reading.

Backtest a 10/30 MA crossover strategy on EURUSD H1 from 
January 2024 to now. Show me the results and draw the signals.

Draw a horizontal support line at 1.0850 on the EURUSD chart 
in blue, and a resistance line at 1.0950 in red.
```

---

## Live Trading (Not Yet Enabled)

Call `mt5_order_requirements` to see the full checklist. Summary:
1. EA needs "Allow Live Trading" checked
2. Implement `OrderSend()` calls in the MQL5 EA
3. Add risk guards (max lot, daily loss limit, drawdown breaker)
4. Require explicit confirmation in every order tool call
5. Test on demo account first

---

## Versioning

The installer writes a `.mcp_version` file in the EA folder.  
On re-run it compares versions and upgrades automatically.  
The EA file header also contains the version string.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "MT5 not connected" | Check EA is attached to a chart and Experts log shows "listening" |
| "JAson.mqh not found" | Download from mql5.com/en/code/13663, place in MQL5/Include/ |
| Port conflict | Change `InpPort` in EA inputs and `MT5_PORT` env var |
| Claude doesn't see tools | Restart Claude Desktop after config change |
| Timeout errors | Check Windows Firewall isn't blocking localhost:6789 |
