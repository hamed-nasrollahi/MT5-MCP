#!/usr/bin/env node
/**
 * MT5 MCP Server
 * Bridges Claude AI ↔ MetaTrader 5 via named pipe / TCP socket
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MT5Bridge } from "./mt5Bridge.js";
import { tools } from "./tools.js";

const VERSION = "1.0.0";

const server = new Server(
  { name: "mt5-mcp-server", version: VERSION },
  { capabilities: { tools: {} } }
);

const bridge = new MT5Bridge();

// ── List tools ────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

// ── Call tool ─────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    const result = await tool.handler(bridge, args);
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

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[MT5-MCP] Server v${VERSION} starting…`);
  await bridge.connect();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MT5-MCP] Ready — waiting for Claude.");
}

main().catch((e) => {
  console.error("[MT5-MCP] Fatal:", e);
  process.exit(1);
});
