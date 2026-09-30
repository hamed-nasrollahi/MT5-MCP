#!/usr/bin/env node
/**
 * MT5 MCP Server — HTTP transport  (v2)
 *
 * Runs as a persistent daemon. Claude Code connects via URL — no process
 * spawning, no port conflicts across sessions.
 *
 * Endpoints:
 *   POST   /mcp     — MCP Streamable-HTTP (tool calls + session init)
 *   GET    /mcp     — SSE stream for server-initiated messages
 *   DELETE /mcp     — close an MCP session
 *   GET    /health  — { status, pid, mt5_connected, sessions, uptime_s }
 *   POST   /exit    — graceful shutdown
 */

import http     from "node:http";
import { randomUUID } from "node:crypto";

import { Server }                       from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MT5Bridge } from "./mt5Bridge.js";
import { tools     } from "./tools.js";

// ── Config ────────────────────────────────────────────────────────────────────
const VERSION   = "2.0.0";
const HTTP_HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);

// ── Shared MT5 bridge (one connection, all sessions share it) ─────────────────
const bridge = new MT5Bridge();

// ── Session registry: sessionId → { mcpServer, transport } ───────────────────
/** @type {Map<string, { mcpServer: Server, transport: StreamableHTTPServerTransport }>} */
const sessions = new Map();

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  process.stderr.write(`[MT5-MCP] ${msg}\n`);
}

// ── Create a new MCP Server+Transport pair for one Claude session ─────────────
function createSession() {
  const mcpServer = new Server(
    { name: "mt5-mcp-server", version: VERSION },
    { capabilities: { tools: {} } }
  );

  // List tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  // Call tool
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);

      const result = await tool.handler(bridge, args);

      if (result && result._mcpImageContent) {
        const { _mcpImageContent, ...meta } = result;
        return {
          content: [
            _mcpImageContent,
            { type: "text", text: JSON.stringify(meta, null, 2) },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `ERROR: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),

    // Called once Claude sends its `initialize` request — store session then.
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { mcpServer, transport });
      log(`Session opened  ${sessionId} (total: ${sessions.size})`);
    },
  });

  // Clean up when the transport closes
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      log(`Session closed  ${sid} (total: ${sessions.size})`);
    }
  };

  mcpServer.connect(transport); // non-blocking
  return transport;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function jsonResponse(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end",  () => resolve(raw));
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const startTime = Date.now();

const httpServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method?.toUpperCase();

  try {
    // ── GET /health ──────────────────────────────────────────────────────────
    if (pathname === "/health" && method === "GET") {
      return jsonResponse(res, 200, {
        status:        "ok",
        pid:           process.pid,
        version:       VERSION,
        mt5_connected: bridge.connected,
        sessions:      sessions.size,
        uptime_s:      Math.floor((Date.now() - startTime) / 1000),
        mcp_url:       `http://${HTTP_HOST}:${HTTP_PORT}/mcp`,
      });
    }

    // ── POST /exit ───────────────────────────────────────────────────────────
    if (pathname === "/exit" && method === "POST") {
      jsonResponse(res, 200, { ok: true, message: "Server shutting down…" });
      log("Shutdown requested via POST /exit");
      setImmediate(gracefulShutdown);
      return;
    }

    // ── /mcp ─────────────────────────────────────────────────────────────────
    if (pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];

      // POST — tool call or initialize
      if (method === "POST") {
        const raw = await readBody(req);
        let body;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return jsonResponse(res, 400, { error: "Invalid JSON body" });
        }

        // A stale session ID must be rejected so clients can initialize a
        // fresh session. Creating a transport for an ordinary tool call leaves
        // the client waiting because that transport has never been initialized.
        const entry = sessionId ? sessions.get(sessionId) : null;
        if (sessionId && !entry) {
          return jsonResponse(res, 404, { error: "MCP session not found; initialize a new session" });
        }
        if (!sessionId && body?.method !== "initialize") {
          return jsonResponse(res, 400, { error: "MCP initialize required" });
        }
        const transport = entry ? entry.transport : createSession();

        await transport.handleRequest(req, res, body);
        return;
      }

      // GET — SSE stream (server-initiated messages)
      if (method === "GET") {
        const entry = sessionId ? sessions.get(sessionId) : null;
        if (!entry) return jsonResponse(res, 404, { error: "Session not found" });
        await entry.transport.handleRequest(req, res);
        return;
      }

      // DELETE — close session
      if (method === "DELETE") {
        const entry = sessionId ? sessions.get(sessionId) : null;
        if (entry) {
          await entry.transport.close();     // triggers transport.onclose → map cleanup
        }
        return jsonResponse(res, 200, { ok: true });
      }

      return jsonResponse(res, 405, { error: "Method not allowed" });
    }

    jsonResponse(res, 404, { error: `Not found: ${pathname}` });

  } catch (err) {
    log(`Request error: ${err.message}`);
    if (!res.headersSent) jsonResponse(res, 500, { error: err.message });
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function gracefulShutdown() {
  log("Graceful shutdown — closing sessions…");

  for (const [sid, { transport }] of sessions) {
    try { await transport.close(); } catch (_) {}
    sessions.delete(sid);
  }

  bridge.close();

  httpServer.close(() => {
    log("HTTP server stopped. Bye.");
    process.exit(0);
  });

  // Force exit after 5 s if something hangs
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT",  gracefulShutdown);

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Already running? ───────────────────────────────────────────────────────
  try {
    const probe = await fetch(`http://${HTTP_HOST}:${HTTP_PORT}/health`);
    if (probe.ok) {
      const info = await probe.json();
      log(`Server already running on port ${HTTP_PORT} (pid=${info.pid}). Nothing to do.`);
      log(`  To stop it: curl -s -X POST http://${HTTP_HOST}:${HTTP_PORT}/exit`);
      process.exit(0);
    }
  } catch {
    // Not running — proceed
  }

  log(`Server v${VERSION} starting (pid=${process.pid})…`);

  // Connect to MT5 EA over TCP
  await bridge.connect();

  // Start HTTP server
  await new Promise((resolve, reject) => {
    httpServer.listen(HTTP_PORT, HTTP_HOST, resolve);
    httpServer.on("error", reject);
  });

  log(`HTTP server ready at http://${HTTP_HOST}:${HTTP_PORT}`);
  log(`  MCP endpoint : POST http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  log(`  Health       : GET  http://${HTTP_HOST}:${HTTP_PORT}/health`);
  log(`  Shutdown     : POST http://${HTTP_HOST}:${HTTP_PORT}/exit`);
}

main().catch((e) => {
  log(`Fatal: ${e}`);
  process.exit(1);
});
