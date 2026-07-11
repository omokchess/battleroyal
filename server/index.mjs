/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PIXELROYALE dedicated game server (Phase 1).
 *
 * A single Node process that owns every online room's simulation. It speaks the
 * SAME Protocol the P2P host used, so a client talks to it almost exactly like it
 * used to talk to a host peer — the server just plays the "host" role for real,
 * over WebSocket instead of PeerJS.
 *
 *   HTTP  GET /health   -> { ok: true }
 *         GET /rooms    -> [{ code, players, host, config }]  (the lobby list)
 *         GET /stats    -> { rooms, players, maxTickMs }
 *   WS    /?room=CODE   -> join CODE (or send a JOIN_ROOM frame with { room })
 *
 * Run:  npm run server   (PORT env, default 8787)
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager.mjs';

const PORT = Number(process.env.PORT) || 8787;
const log = (...a) => console.log(new Date().toISOString(), ...a);

export function createServer({ port = PORT, silent = false } = {}) {
  const rooms = new RoomManager({ log: silent ? () => {} : log });

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...rooms.stats() }));
    } else if (url.pathname === '/rooms') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rooms.list()));
    } else if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rooms.stats()));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer });
  let seq = 0;

  wss.on('connection', (ws, req) => {
    const socketId = `s${Date.now().toString(36)}_${(seq++).toString(36)}`;
    const roomHint = new URL(req.url, 'http://localhost').searchParams.get('room');
    const { onMessage, onClose } = rooms.attach(socketId, ws, roomHint);

    ws.on('message', (buf) => onMessage(typeof buf === 'string' ? buf : buf.toString()));
    ws.on('close', onClose);
    ws.on('error', onClose);
  });

  return {
    httpServer,
    wss,
    rooms,
    listen: () => new Promise((resolve) => httpServer.listen(port, () => {
      if (!silent) log(`[server] listening on :${port} (ws + http)`);
      resolve(httpServer.address());
    })),
    close: () => new Promise((resolve) => {
      rooms.shutdown();
      wss.close(() => httpServer.close(() => resolve()));
    }),
  };
}

// Run directly (node server/index.mjs), not when imported by a test. pathToFileURL
// gives the correct file:///C:/... form on Windows (a hand-built file:// prefix
// would mismatch and the server would silently never listen).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer();
  server.listen();
  const bye = async () => { log('[server] shutting down'); await server.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
