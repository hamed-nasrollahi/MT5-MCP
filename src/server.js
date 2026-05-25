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

    // Tools that return an image embed it under _mcpImageContent
    if (result && result._mcpImageContent) {
      const { _mcpImageContent, ...meta } = result;
      return {
        content: [
          _mcpImageContent,                                          // image block
          { type: "text", text: JSON.stringify(meta, null, 2) },   // metadata
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

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  process.stderr.write(`[MT5-MCP] Server v${VERSION} starting (pid=${process.pid})…\n`);
  await bridge.connect();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[MT5-MCP] Ready — waiting for Claude.\n");
}

main().catch((e) => {
  process.stderr.write(`[MT5-MCP] Fatal: ${e}\n`);
  process.exit(1);
});
