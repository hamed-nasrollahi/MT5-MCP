# MT5 MCP Server — Project Memory

## What This Project Is

A Model Context Protocol (MCP) server that bridges Claude to MetaTrader 5 via a TCP Expert Advisor (EA). Claude can read live market data, draw chart objects, and run backtests — all through JSON commands over a local socket.

## Architecture

```
Claude Code / Claude Desktop
       │ (HTTP POST http://127.0.0.1:3000/mcp)
       ▼
Node.js MCP Server  (src/server.js)  ← persistent HTTP daemon
       │ (TCP 127.0.0.1:6789, newline-delimited JSON)
       ▼
MT5_MCP_Bridge EA  (mql5/MT5_MCP_Bridge.mq5)
       │ (MQL5 Socket API)
       ▼
MetaTrader 5 Terminal
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server.js` | MCP HTTP server (v2 — persistent daemon) |
| `src/tools.js` | All tool definitions + handlers |
| `src/mt5Bridge.js` | TCP bridge to MT5 EA |
| `mql5/MT5_MCP_Bridge.mq5` | EA running inside MT5 |
| `.mcp.json` | Claude Code MCP registration (`url` transport) |

## Running the Server

```bash
# Start (idempotent — safe to run twice, second call exits 0)
node src/server.js
# or
npm start

# Check status
GET http://127.0.0.1:3000/health

# Stop gracefully
POST http://127.0.0.1:3000/exit
# or
npm run stop
```

The server runs as a **persistent daemon** — it survives across Claude Code sessions. Claude Code connects to it via the `url` in `.mcp.json` instead of spawning a new process each time.

## HTTP Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | MCP tool calls + session init |
| `GET` | `/mcp` | SSE stream for server notifications |
| `DELETE` | `/mcp` | Close an MCP session |
| `GET` | `/health` | Status: pid, mt5_connected, sessions, uptime |
| `POST` | `/exit` | Graceful shutdown |

## MT5 Setup

EA must be attached to a chart with:
- Allow Automated Trading ✅
- Expert Advisors enabled ✅
- EA connects outbound to Node.js on port 6789

## Why HTTP (not stdio)

The old `command`-based `.mcp.json` spawned a new Node process every Claude session.
If the previous session's process was still alive, port 6789 got `EADDRINUSE`.

With `url`-based `.mcp.json`, Claude Code just connects to the already-running server —
no spawning, no port conflicts, sessions come and go while the daemon stays up.

## Available Skills

| Skill | Trigger |
|-------|---------|
| `mt5-range-breakout` | Range breakout backtest on any symbol, day-by-day chart annotation |

Skills are in `.claude/skills/`.

## MCP Tool Naming

When used through Claude Code, tools are prefixed: `mcp__mt5-mcp-server__mt5_*`  
When used through Claude Desktop, tools are called directly: `mt5_*`
