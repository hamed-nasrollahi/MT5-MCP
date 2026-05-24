/**
 * MT5Bridge — persistent TCP connection to the MT5 Expert Advisor.
 * The EA listens on 127.0.0.1:6789 (configurable via MT5_PORT env).
 * Protocol: newline-delimited JSON  →  {"cmd":"...", "params":{...}}
 *                                  ←  {"ok":true/false, "data":{...}, "error":"..."}
 */

import net from "net";
import { EventEmitter } from "events";

const HOST = process.env.MT5_HOST || "127.0.0.1";
const PORT = parseInt(process.env.MT5_PORT || "6789", 10);
const RECONNECT_MS = 3000;
const TIMEOUT_MS = 15000;

export class MT5Bridge extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._connected = false;
    this._buf = "";
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._seq = 0;
    this._reconnTimer = null;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  get connected() {
    return this._connected;
  }

  /** Connect (or schedule reconnect). Resolves once first connection succeeds. */
  connect() {
    return new Promise((resolve) => {
      const attempt = () => {
        const sock = new net.Socket();
        sock.setEncoding("utf8");

        sock.connect(PORT, HOST, () => {
          this._socket = sock;
          this._connected = true;
          this._buf = "";
          console.error(`[Bridge] Connected to MT5 EA at ${HOST}:${PORT}`);
          this.emit("connect");
          resolve();
        });

        sock.on("data", (chunk) => this._onData(chunk));

        sock.on("close", () => {
          this._connected = false;
          this._socket = null;
          console.error("[Bridge] Disconnected — reconnecting in 3 s…");
          this.emit("disconnect");
          this._rejectAllPending("MT5 disconnected");
          this._reconnTimer = setTimeout(attempt, RECONNECT_MS);
        });

        sock.on("error", (err) => {
          // swallow — 'close' fires next
          if (!this._connected) {
            // Still in initial connect phase; keep trying silently
            this._reconnTimer = setTimeout(attempt, RECONNECT_MS);
          }
        });
      };
      attempt();
    });
  }

  /**
   * Send a command to the EA and await its response.
   * @param {string} cmd
   * @param {object} params
   * @returns {Promise<object>} resolved with response data
   */
  async send(cmd, params = {}) {
    if (!this._connected) throw new Error("MT5 not connected");

    const id = ++this._seq;
    const msg = JSON.stringify({ id, cmd, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout waiting for MT5 response to '${cmd}'`));
      }, TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this._socket.write(msg);
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split("\n");
    this._buf = lines.pop(); // last partial line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const entry = this._pending.get(msg.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        this._pending.delete(msg.id);
        if (msg.ok) {
          entry.resolve(msg.data ?? {});
        } else {
          entry.reject(new Error(msg.error ?? "MT5 error"));
        }
      } catch (e) {
        console.error("[Bridge] Bad JSON from EA:", line);
      }
    }
  }

  _rejectAllPending(reason) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
