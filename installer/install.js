#!/usr/bin/env node
/**
 * install.js — MT5 MCP Server Installer
 *
 * 1. Auto-detects MetaTrader 5 installation
 * 2. Checks for existing version and upgrades
 * 3. Copies the MQL5 EA to the correct folder
 * 4. Installs Node dependencies
 * 5. Registers the MCP server in Claude's config
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import { execSync, spawnSync } from "child_process";
import readline from "readline";

const EA_VERSION   = "1.0.0";
const EA_FILENAME  = "MT5_MCP_Bridge.mq5";
const SERVER_NAME  = "mt5-mcp-server";
const SCRIPT_DIR   = path.dirname(new URL(import.meta.url).pathname);

// ── Colour helpers ────────────────────────────────────────────────────────────
const c = {
  reset : "\x1b[0m",
  bold  : "\x1b[1m",
  green : "\x1b[32m",
  yellow: "\x1b[33m",
  red   : "\x1b[31m",
  cyan  : "\x1b[36m",
};
const ok   = (s) => console.log(`${c.green}✔${c.reset}  ${s}`);
const warn = (s) => console.log(`${c.yellow}⚠${c.reset}  ${s}`);
const err  = (s) => console.log(`${c.red}✖${c.reset}  ${s}`);
const info = (s) => console.log(`${c.cyan}ℹ${c.reset}  ${s}`);
const head = (s) => console.log(`\n${c.bold}${s}${c.reset}`);

// ── MT5 detection ─────────────────────────────────────────────────────────────
const SEARCH_PATHS = {
  win32: [
    "C:\\Program Files\\MetaTrader 5",
    "C:\\Program Files (x86)\\MetaTrader 5",
    path.join(os.homedir(), "AppData", "Roaming", "MetaQuotes", "Terminal"),
    "D:\\MetaTrader 5",
  ],
  linux: [
    path.join(os.homedir(), ".wine", "drive_c", "Program Files", "MetaTrader 5"),
    "/opt/metatrader5",
  ],
  darwin: [
    path.join(os.homedir(), "Library", "Application Support", "MetaTrader 5"),
  ],
};

function findMT5Root() {
  const plat = process.platform;
  const paths = SEARCH_PATHS[plat] ?? SEARCH_PATHS.linux;

  for (const p of paths) {
    if (fs.existsSync(p)) {
      // Could be the terminal root itself or the AppData hash folder
      const direct = path.join(p, "MQL5", "Experts");
      if (fs.existsSync(direct)) return p;

      // AppData\Roaming\MetaQuotes\Terminal\<HASH>\
      if (fs.existsSync(p)) {
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            const sub = path.join(p, e.name, "MQL5", "Experts");
            if (fs.existsSync(sub)) return path.join(p, e.name);
          }
        } catch {}
      }
    }
  }
  return null;
}

function getExpertsDir(mt5Root) {
  return path.join(mt5Root, "MQL5", "Experts", "MT5_MCP");
}

// ── Version helpers ───────────────────────────────────────────────────────────
function readInstalledVersion(expertsDir) {
  const vFile = path.join(expertsDir, ".mcp_version");
  if (!fs.existsSync(vFile)) return null;
  return fs.readFileSync(vFile, "utf8").trim();
}

function writeInstalledVersion(expertsDir, version) {
  fs.writeFileSync(path.join(expertsDir, ".mcp_version"), version);
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) > (pb[i]||0)) return 1;
    if ((pa[i]||0) < (pb[i]||0)) return -1;
  }
  return 0;
}

// ── Claude config ─────────────────────────────────────────────────────────────
function getClaudeConfigPath() {
  const plat = process.platform;
  if (plat === "win32")
    return path.join(os.homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  if (plat === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function registerMCPServer() {
  const cfgPath = getClaudeConfigPath();
  const entry = {
    command: "node",
    args: [path.join(SCRIPT_DIR, "..", "src", "server.js")],
    env: { MT5_PORT: "6789" },
  };

  let cfg = { mcpServers: {} };
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[SERVER_NAME] = entry;

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(`Registered '${SERVER_NAME}' in ${cfgPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${c.bold}╔══════════════════════════════════════════╗`);
  console.log(`║   MT5 MCP Server Installer  v${EA_VERSION}      ║`);
  console.log(`╚══════════════════════════════════════════╝${c.reset}\n`);

  // 1. Find MT5
  head("Step 1 — Locating MetaTrader 5");
  let mt5Root = findMT5Root();

  if (!mt5Root) {
    warn("MT5 not found in default locations.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    mt5Root = await new Promise((res) =>
      rl.question("  Enter your MT5 data folder path: ", (ans) => { rl.close(); res(ans.trim()); })
    );
    if (!fs.existsSync(mt5Root)) { err("Path does not exist. Aborting."); process.exit(1); }
  } else {
    ok(`Found MT5 at: ${mt5Root}`);
  }

  // 2. Check existing version
  head("Step 2 — Checking existing installation");
  const expertsDir = getExpertsDir(mt5Root);
  const installed  = readInstalledVersion(expertsDir);

  if (installed) {
    const cmp = compareVersions(EA_VERSION, installed);
    if (cmp === 0) {
      ok(`Already up to date (v${installed}). Reinstalling anyway…`);
    } else if (cmp > 0) {
      ok(`Upgrading v${installed} → v${EA_VERSION}`);
    } else {
      warn(`Installed version (v${installed}) is newer than this package (v${EA_VERSION}). Continuing…`);
    }
  } else {
    info("Fresh installation.");
  }

  // 3. Copy EA
  head("Step 3 — Installing MT5 Expert Advisor");
  fs.mkdirSync(expertsDir, { recursive: true });

  const src = path.join(SCRIPT_DIR, "..", "mql5", EA_FILENAME);
  const dst = path.join(expertsDir, EA_FILENAME);

  if (!fs.existsSync(src)) { err(`EA source not found: ${src}`); process.exit(1); }
  fs.copyFileSync(src, dst);
  writeInstalledVersion(expertsDir, EA_VERSION);
  ok(`Copied ${EA_FILENAME} → ${dst}`);
  info("Open MT5, go to Navigator > Expert Advisors, right-click and Refresh.");
  info("Then drag MT5_MCP_Bridge onto any chart and enable 'Allow DLL imports'.");

  // 4. Install Node dependencies
  head("Step 4 — Installing Node.js dependencies");
  const pkgDir = path.join(SCRIPT_DIR, "..");
  if (!fs.existsSync(path.join(pkgDir, "node_modules"))) {
    info("Running npm install…");
    const r = spawnSync("npm", ["install"], { cwd: pkgDir, stdio: "inherit", shell: true });
    if (r.status !== 0) { err("npm install failed."); process.exit(1); }
    ok("Dependencies installed.");
  } else {
    ok("node_modules already present, skipping.");
  }

  // 5. Register in Claude Desktop
  head("Step 5 — Registering MCP server with Claude Desktop");
  try {
    registerMCPServer();
  } catch (e) {
    warn(`Could not auto-register: ${e.message}`);
    info("Manually add to claude_desktop_config.json:");
    console.log(JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          command: "node",
          args: [path.join(SCRIPT_DIR, "..", "src", "server.js")],
        },
      },
    }, null, 2));
  }

  // Done
  console.log(`\n${c.bold}${c.green}Installation complete!${c.reset}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Compile & attach MT5_MCP_Bridge in MetaTrader 5`);
  console.log(`  2. Restart Claude Desktop`);
  console.log(`  3. Ask Claude: "Check mt5 status" to verify the connection\n`);
}

main().catch((e) => { err(e.message); process.exit(1); });
