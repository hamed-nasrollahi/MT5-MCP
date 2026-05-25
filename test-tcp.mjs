/**
 * Quick TCP probe — sends a "status" command directly to the MT5 EA bridge
 * and prints the raw response.  Run with:  node test-tcp.mjs
 *
 * NOTE: Only works when the MCP bridge is NOT already bound to port 6789.
 * If the MCP server is running, this will get EADDRINUSE on server.listen().
 * Instead, we connect as a *client* to see if the EA is on the OTHER side.
 */

import net from "net";

const HOST = "127.0.0.1";
const PORT = 6789;

console.log(`[test] Connecting to ${HOST}:${PORT} as a CLIENT (simulating Node bridge)…`);

// We connect AS the server-side: we open a client socket to 6789.
// But 6789 is the server socket — so this won't work directly.
//
// Better approach: run a small server on a different port and test locally.
// OR: just check if the existing server's process is handling stdio.

// Actually, since the bridge server is already running on 6789 and the EA is connected,
// we can test by writing directly to a NEW server on a different port (6790)
// and having the EA connect there — but that requires EA restart.
//
// Instead, let's just verify the TCP stack by connecting to 6789 as a second client.
// The bridge server will accept us too (it accepts multiple connections, though it
// drops the old one when a new one comes in).

const sock = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log("[test] Connected! Sending status command…");
  const cmd = JSON.stringify({ id: 1, cmd: "status", params: {} }) + "\n";
  sock.write(cmd);
  console.log("[test] Sent:", cmd.trim());
});

sock.setEncoding("utf8");
let buf = "";
sock.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log("[test] RESPONSE:", line);
    sock.destroy();
  }
});

sock.on("error", (err) => console.error("[test] Socket error:", err.message));
sock.on("close", () => console.log("[test] Connection closed."));

setTimeout(() => {
  console.error("[test] TIMEOUT — no response after 10s");
  sock.destroy();
  process.exit(1);
}, 10_000);
