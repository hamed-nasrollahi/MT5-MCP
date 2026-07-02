# MT5 MCP Server

[![GitHub stars](https://img.shields.io/github/stars/hamed-nasrollahi/MT5-MCP?style=social)](https://github.com/hamed-nasrollahi/MT5-MCP/stargazers)

A **Model Context Protocol (MCP) server** that gives Claude AI full read/analysis access to MetaTrader 5 — chart objects, indicators, historical data, and backtesting.

If this project helps you, please consider [giving it a star ⭐](https://github.com/hamed-nasrollahi/MT5-MCP/stargazers) — it helps others discover it.

---

## Architecture

```
Claude Code / Claude Desktop
       │  (HTTP POST http://127.0.0.1:3000/mcp)
       ▼
 mt5-mcp-server  (Node.js — persistent HTTP daemon)
       │  (TCP 127.0.0.1:6789, newline-delimited JSON)
       ▼
MT5_MCP_Bridge.mq5  (Expert Advisor inside MT5)
       │  (MQL5 Socket API)
       ▼
MetaTrader 5 Terminal
```

The MCP server runs as a **persistent daemon** — it stays alive across Claude sessions.  
Claude Code connects to it via a URL rather than spawning a new process each time,  
which eliminates port-conflict (`EADDRINUSE`) errors on reconnect.

---

## Quick Install

### Prerequisites
- Node.js ≥ 18
- MetaTrader 5 installed and running
- Claude Desktop or Claude Code

### 1 — Clone / download and install

```bash
cd mt5-mcp-server
npm run install-ea      # copies EA to MT5, registers with Claude Desktop
npm install             # install Node dependencies
```

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
7. You should see: `MT5_MCP_Bridge connected to 127.0.0.1:6789` in the Experts log

### 3 — Start the MCP server

```bash
npm start
```

The server starts once and stays running. You don't need to restart it between Claude sessions.

### 4 — Register with Claude Code

`.mcp.json` in the project root already points Claude Code at the running server:

```json
{
  "mcpServers": {
    "mt5-mcp-server": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Open a Claude Code chat in this project folder. Type `/mcp` to confirm  
`mt5-mcp-server` shows as connected, then test with:

> *"Check mt5 status"*

---

## Server Management

### Start

```bash
npm start
# or directly:
node src/server.js
```

Safe to run when already running — a second invocation detects the live server and exits immediately with a message.

### Stop (graceful)

```bash
npm run stop
```

Or with curl / PowerShell:

```bash
# bash / Git Bash
curl -s -X POST http://127.0.0.1:3000/exit

# PowerShell
Invoke-WebRequest -Uri http://127.0.0.1:3000/exit -Method POST
```

The server closes all open MCP sessions, shuts down the MT5 bridge, then exits cleanly.

### Restart

```bash
npm run restart
```

Or manually:

```bash
npm run stop
# wait 2 seconds
npm start
```

### Status / health check

```bash
# bash / Git Bash
curl -s http://127.0.0.1:3000/health

# PowerShell
(Invoke-WebRequest -Uri http://127.0.0.1:3000/health -UseBasicParsing).Content
```

Response:

```json
{
  "status": "ok",
  "pid": 14472,
  "version": "2.0.0",
  "mt5_connected": true,
  "sessions": 1,
  "uptime_s": 3600,
  "mcp_url": "http://127.0.0.1:3000/mcp"
}
```

### HTTP endpoints summary

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Server + MT5 status |
| `POST` | `/exit` | Graceful shutdown |
| `POST` | `/mcp` | MCP tool calls / session init |
| `GET` | `/mcp` | SSE stream for server notifications |
| `DELETE` | `/mcp` | Close an MCP session |

---

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP server bind address |
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MT5_HOST` | `127.0.0.1` | MT5 EA bind address (must match EA input) |
| `MT5_PORT` | `6789` | MT5 EA TCP port (must match EA input) |

Override with environment variables:

```bash
MCP_HTTP_PORT=4000 MT5_PORT=6790 npm start
```

If you change `MCP_HTTP_PORT`, also update the `url` in `.mcp.json`.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mt5_*` tools missing in Claude | Run `/mcp` in Claude Code — reconnect `mt5-mcp-server` if shown as disconnected |
| "MT5 not connected" | Start `npm start` first, then attach EA to an MT5 chart |
| `/health` returns connection refused | Server is not running — run `npm start` |
| `EADDRINUSE` on port 3000 | Another server instance is running — run `npm run stop` first |
| `EADDRINUSE` on port 6789 | Old process still alive — run `npm run stop`, wait 2 s, then `npm start` |
| "JAson.mqh not found" | Download from mql5.com/en/code/13663, place in `MQL5/Include/` |
| Timeout errors | Check Windows Firewall isn't blocking localhost:6789 or localhost:3000 |
| Claude Desktop (not Claude Code) | Use the installer: `npm run install-ea` — it writes `claude_desktop_config.json` |

---

## Versioning

The installer writes a `.mcp_version` file in the EA folder.  
On re-run it compares versions and upgrades automatically.  
The EA file header also contains the version string.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=hamed-nasrollahi/MT5-MCP&type=Date)](https://star-history.com/#hamed-nasrollahi/MT5-MCP&Date)
