/**
 * Phase 2: the client's transport abstraction.
 *
 * NetworkManager is now a thin facade over a pluggable transport. These tests
 * cover the offline LocalTransport and the online WsTransport (driven against a
 * REAL game server over a real WebSocket, in plain Node — no PeerJS, no browser).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NetworkManager } from '../multiplayer/NetworkManager.js';
import { LocalTransport } from '../multiplayer/LocalTransport.js';
import { WsTransport } from '../multiplayer/WsTransport.js';
import { MsgType, Protocol } from '../multiplayer/Protocol.js';
import { createServer } from '../server/index.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── facade ────────────────────────────────────────────────────────────────

test('every registered listener for an event fires', () => {
  const nm = new NetworkManager();
  let a = 0, b = 0;
  nm.on('onConnected', () => a++);
  nm.on('onConnected', () => b++);
  nm._emit('onConnected');
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('off() removes a listener; unknown events are ignored', () => {
  const nm = new NetworkManager();
  let n = 0;
  const stop = nm.on('onData', () => n++);
  nm._emit('onData'); stop(); nm._emit('onData');
  assert.equal(n, 1);
  assert.doesNotThrow(() => nm.on('nope', () => {})());
});

test('WsTransport coalesces a burst of state snapshots to the newest frame', async () => {
  const seen = [];
  const transport = new WsTransport((event, from, data) => {
    if (event === 'onData') seen.push([from, data]);
  }, 'ws://unused');

  for (let i = 1; i <= 40; i++) {
    transport._queueLatestGameState({ type: MsgType.GAME_STATE, stateSeq: i, players: { frame: i } });
  }
  await sleep(10);

  assert.equal(seen.length, 1, 'one render interval must apply at most one state correction');
  assert.equal(seen[0][0], 'server');
  assert.equal(seen[0][1].players.frame, 40, 'the newest authoritative state wins');

  transport._queueLatestGameState({ type: MsgType.GAME_STATE, stateSeq: 39, players: { frame: 39 } });
  await sleep(10);
  assert.equal(seen.length, 1, 'an older state cannot roll the client backward');
  transport.stop();
});

// ── LocalTransport (offline bot match) ──────────────────────────────────────

test('hostLocal makes the client its own authoritative host, no network', async () => {
  const nm = new NetworkManager();
  const events = [];
  nm.on('onInit', (code) => events.push(['onInit', code]));
  nm.on('onConnected', () => events.push(['onConnected']));

  nm.hostLocal('SOLO');
  assert.ok(nm.transport instanceof LocalTransport);
  assert.equal(nm.isHost, true, 'offline host is authoritative');

  await sleep(5);   // onInit/onConnected are deferred a tick
  assert.deepEqual(events, [['onInit', 'SOLO'], ['onConnected']]);
  assert.ok(String(nm.localId).startsWith('local-'));

  // No peers → messaging is a harmless no-op.
  assert.equal(nm.sendToHost({ type: 'x' }), false);
  assert.doesNotThrow(() => nm.broadcast({ type: 'x' }));
  nm.stop();
});

test('a stopped LocalTransport never emits', async () => {
  const nm = new NetworkManager();
  let fired = 0;
  nm.on('onInit', () => fired++);
  nm.hostLocal('SOLO');
  nm.stop();          // before the deferred emit runs
  await sleep(5);
  assert.equal(fired, 0);
});

// ── WsTransport (online, against the real server) ───────────────────────────

async function boot() {
  const server = createServer({ port: 0, silent: true });
  const addr = await server.listen();
  return { url: `ws://localhost:${addr.port}`, close: () => server.close(), rooms: server.rooms };
}

test('joinRoom connects to the server as a guest and completes the handshake', async () => {
  const { url, close } = await boot();
  try {
    const nm = new NetworkManager({ serverUrl: url });
    const seen = [];
    nm.on('onConnected', () => seen.push('connected'));
    nm.on('onData', (from, data) => seen.push([from, data.type]));

    nm.joinRoom('ALPHA', Protocol.joinRoom('Hero', 'sword'));
    assert.ok(nm.transport instanceof WsTransport);
    assert.equal(nm.isHost, false, 'online client is a guest; the server is authoritative');

    for (let i = 0; i < 100 && !seen.some(e => Array.isArray(e) && e[1] === MsgType.ROOM_JOINED); i++) await sleep(10);

    assert.ok(seen.includes('connected'), 'onConnected fired after room acceptance');
    assert.ok(seen.some(e => Array.isArray(e) && e[0] === 'server' && e[1] === MsgType.ROOM_JOINED), 'ROOM_JOINED relayed via onData');
    assert.ok(seen.indexOf('connected') < seen.findIndex(e => Array.isArray(e) && e[1] === MsgType.ROOM_JOINED),
      'the shell can install its onData listener between acceptance and ROOM_JOINED delivery');
    assert.ok(nm.localId, 'the server assigned a player id');
    nm.stop();
  } finally { await close(); }
});

test('sendToHost reaches the server and drives the authoritative sim', async () => {
  const { url, close, rooms } = await boot();
  try {
    const nm = new NetworkManager({ serverUrl: url });
    let joinedId = null;
    nm.on('onData', (_from, data) => { if (data.type === MsgType.ROOM_JOINED) joinedId = data.id; });
    nm.joinRoom('BRAVO', Protocol.joinRoom('Mover', 'sword'));

    for (let i = 0; i < 100 && !joinedId; i++) await sleep(10);
    assert.ok(joinedId, 'joined');

    const room = rooms.rooms.get('BRAVO');
    const x0 = room.sim.players[joinedId].x;
    for (let i = 0; i < 40; i++) { nm.sendToHost(Protocol.clientInput({ d: true })); await sleep(15); }
    const x1 = room.sim.players[joinedId].x;
    assert.ok(x1 > x0 + 20, `input forwarded to server moved the player (${x0} -> ${x1})`);

    nm.stop();
  } finally { await close(); }
});

test('stop() closes the socket and the server drops the player', async () => {
  const { url, close, rooms } = await boot();
  try {
    const nm = new NetworkManager({ serverUrl: url });
    let id = null;
    nm.on('onData', (_f, d) => { if (d.type === MsgType.ROOM_JOINED) id = d.id; });
    nm.joinRoom('CHARLIE', Protocol.joinRoom('Solo', 'sword'));
    for (let i = 0; i < 100 && !id; i++) await sleep(10);

    const room = rooms.rooms.get('CHARLIE');
    assert.equal(room.clients.size, 1);
    nm.stop();
    await sleep(120);
    assert.equal(room.clients.size, 0, 'server removed the player after stop()');
  } finally { await close(); }
});

test('WsTransport reconnects into the same server seat after a forced drop', async () => {
  const { url, close, rooms } = await boot();
  try {
    const nm = new NetworkManager({ serverUrl: url });
    const joined = [];
    nm.on('onData', (_f, d) => { if (d.type === MsgType.ROOM_JOINED) joined.push(d.id); });
    nm.joinRoom('REJOIN', Protocol.joinRoom('Returner', 'sword'));
    for (let i = 0; i < 100 && joined.length < 1; i++) await sleep(10);
    const room = rooms.rooms.get('REJOIN');
    const serverSocket = [...room.clients.values()][0].ws;
    serverSocket.terminate();

    for (let i = 0; i < 300 && joined.length < 2; i++) await sleep(10);
    assert.equal(joined.length, 2, 'transport completed a reconnect handshake');
    assert.equal(joined[1], joined[0], 'server restored the original player id');
    assert.equal(room.playerCount, 1);
    nm.stop();
  } finally { await close(); }
});
