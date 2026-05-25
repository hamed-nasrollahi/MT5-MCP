/**
 * MT5Bridge — TCP server that waits for the MT5 Expert Advisor to connect.
 *
 * Architecture:
 *   MQL5 has no SocketBind/Listen/Accept — it can only make *outbound* connections.
 *   Therefore Node.js acts as the TCP *server* and the MT5 EA connects as a client.
 *
 * Protocol: newline-delimited JSON
 *   → Node sends:   {"id": N, "cmd": "...", "params": {...}}\n
 *   ← EA responds:  {"id": N, "ok": true/false, "data": {...}, "error": "..."}\n
 */

import net from "net";
import fs from "fs";
import { EventEmitter } from "events";

const HOST        = process.env.MT5_HOST || "127.0.0.1";
const PORT        = parseInt(process.env.MT5_PORT || "6789", 10);
const TIMEOUT_MS  = 60_000;

// ── File-based debug log (visible even for stdio MCP processes) ──────────────
const LOG_FILE = "D:\\GitHub\\MT5-MCP\\bridge-debug.log";
const _logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function dbg(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  process.stderr.write(line);
  _logStream.write(line);
}

export class MT5Bridge extends EventEmitter {
  constructor() {
    super();
    this._server    = null;
    this._socket    = null;
    this._connected = false;
    this._buf       = "";
    this._pending   = new Map(); // id → { resolve, reject, timer }
    this._seq       = 0;
    this._connGen   = 0;         // incremented on every new connection so stale
                                 // close/error handlers from old sockets don't
                                 // corrupt the bridge state
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  get connected() {
    return this._connected;
  }

  /**
   * Start the TCP server.  Resolves as soon as the server is *listening*
   * (not waiting for MT5 — tools return "MT5 not connected" until the EA
   * connects, which matches real-world startup order).
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((sock) => {
        // Bump generation so any close/error handlers still attached to the
        // previous socket know they are stale and should not touch bridge state.
        const myGen = ++this._connGen;

        // Drop any stale previous connection (its close will fire later but
        // the generation check below prevents it from corrupting state).
        if (this._socket) {
          try { this._socket.destroy(); } catch (_) {}
        }

        sock.setEncoding("utf8");
        this._socket    = sock;
        this._connected = true;
        this._buf       = "";

        const remote = `${sock.remoteAddress}:${sock.remotePort}`;
        dbg(`[Bridge] MT5 EA connected from ${remote} (gen=${myGen})`);
        this.emit("connect");

        sock.on("data",  (chunk) => this._onData(chunk));

        sock.on("close", () => {
          if (this._connGen !== myGen) {
            dbg(`[Bridge] Stale close ignored (gen=${myGen}, current=${this._connGen})`);
            return; // stale — a newer connection has already taken over
          }
          this._connected = false;
          this._socket    = null;
          dbg("[Bridge] MT5 EA disconnected — waiting for reconnect…");
          this.emit("disconnect");
          this._rejectAllPending("MT5 disconnected");
        });

        sock.on("error", (err) => {
          dbg(`[Bridge] Socket error (gen=${myGen}): ${err.message}`);
          // "close" fires next; generation check there will handle cleanup
        });
      });

      this._server.on("error", (err) => {
        dbg(`[Bridge] Server error: ${err.message}`);
        // If we haven't resolved yet, reject so the caller knows
        reject(err);
      });

      this._server.listen(PORT, HOST, () => {
        dbg(`[Bridge] TCP server listening on ${HOST}:${PORT} — waiting for MT5 EA…`);
        resolve(); // resolve immediately; tools check this._connected before sending
      });
    });
  }

  /** Graceful shutdown */
  close() {
    if (this._socket) try { this._socket.destroy(); } catch (_) {}
    if (this._server) this._server.close();
    this._rejectAllPending("Bridge closed");
  }

  /**
   * Send a command to the EA and await its response.
   * @param {string} cmd
   * @param {object} [params]
   * @returns {Promise<object>} resolved with response data
   */
  async send(cmd, params = {}) {
    if (!this._connected) throw new Error("MT5 not connected — EA has not established a connection yet");

    const id  = ++this._seq;
    const msg = JSON.stringify({ id, cmd, params }) + "\n";
    dbg(`[Bridge] SEND id=${id} cmd=${cmd} socket_writable=${this._socket?.writable} pending_count=${this._pending.size}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        dbg(`[Bridge] TIMEOUT id=${id} cmd=${cmd} pending_now=${this._pending.size}`);
        reject(new Error(`Timeout waiting for MT5 response to '${cmd}'`));
      }, TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      const wrote = this._socket.write(msg);
      dbg(`[Bridge] socket.write returned=${wrote} msg=${msg.trim()}`);
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _onData(chunk) {
    dbg(`[Bridge] _onData bytes=${chunk.length} pending=[${[...this._pending.keys()].join(",")}] raw=${JSON.stringify(chunk.slice(0,120))}`);
    this._buf += chunk;
    const lines = this._buf.split("\n");
    this._buf = lines.pop(); // retain last incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg   = JSON.parse(line);
        dbg(`[Bridge] parsed id=${msg.id} ok=${msg.ok} pendingHas=${this._pending.has(msg.id)}`);
        const entry = this._pending.get(msg.id);
        if (!entry) { dbg(`[Bridge] no pending entry for id=${msg.id} — ignoring`); continue; }
        clearTimeout(entry.timer);
        this._pending.delete(msg.id);
        if (msg.ok) {
          entry.resolve(msg.data ?? {});
        } else {
          entry.reject(new Error(msg.error ?? "MT5 error"));
        }
      } catch (e) {
        dbg(`[Bridge] Bad JSON from EA: ${line} err: ${e.message}`);
      }
    }
  }

  _rejectAllPending(reason) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
