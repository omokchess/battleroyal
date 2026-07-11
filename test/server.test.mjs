/**
 * Phase 1 gate: two real WebSocket clients join a SERVER room, exchange the same
 * Protocol the P2P host used, and the authoritative simulation drives them.
 *
 * Runs in plain Node against the actual server (no browser, no PeerJS). If the
 * server ever reached for the DOM, or the sim/transport wiring broke, this fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.mjs';
import { MsgType, Protocol } from '../multiplayer/Protocol.js';

/** Boot a fresh silent server on an ephemeral port; returns { port, close }. */
async function boot() {
  const server = createServer({ port: 0, silent: true });
  const addr = await server.listen();
  return { port: addr.port, close: () => server.close(), rooms: server.rooms };
}

/** A tiny client: connect, collect frames by type, send Protocol messages. */
async function connect(port, room) {
  const ws = new WebSocket(`ws://localhost:${port}/?room=${room}`);
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch {} });
  await once(ws, 'open');
  return {
    ws,
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    // wait until a frame of `type` arrives (or throw after timeout)
    wait: (type, ms = 1500) => waitFor(frames, ws, type, ms),
    close: () => ws.close(),
  };
}

function waitFor(frames, ws, type, ms) {
  return new Promise((resolve, reject) => {
    const found = frames.find(f => f.type === type);
    if (found) return resolve(found);
    const to = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`timeout waiting for ${type}`)); }, ms);
    function onMsg(buf) {
      let f; try { f = JSON.parse(buf.toString()); } catch { return; }
      if (f.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(f); }
    }
    ws.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('HTTP surface: /health and /rooms respond', async () => {
  const { port, close } = await boot();
  try {
    const health = await (await fetch(`http://localhost:${port}/health`)).json();
    assert.equal(health.ok, true);
    const rooms = await (await fetch(`http://localhost:${port}/rooms`)).json();
    assert.deepEqual(rooms, []);
  } finally { await close(); }
});

test('a client joins a server room and gets ROOM_JOINED with the arena', async () => {
  const { port, close } = await boot();
  try {
    const a = await connect(port, 'ALPHA');
    a.send(Protocol.joinRoom('Hero', 'sword'));
    const rj = await a.wait(MsgType.ROOM_JOINED);

    assert.ok(rj.id, 'assigned a player id');
    assert.ok(rj.mapWidth > 0 && rj.mapHeight > 0, 'arena dimensions sent');
    assert.ok(rj.initialPlayers[rj.id], 'the joiner is in the initial roster');
    assert.equal(rj.initialPlayers[rj.id].nickname, 'Hero');

    // The room now shows up in the lobby list.
    const rooms = await (await fetch(`http://localhost:${port}/rooms`)).json();
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].code, 'ALPHA');
    assert.equal(rooms[0].players, 1);

    a.close();
  } finally { await close(); }
});

test('two clients share a room: each is told about the other, both get state', async () => {
  const { port, close } = await boot();
  try {
    const a = await connect(port, 'BRAVO');
    a.send(Protocol.joinRoom('Ana', 'sword'));
    const rjA = await a.wait(MsgType.ROOM_JOINED);

    const b = await connect(port, 'BRAVO');
    b.send(Protocol.joinRoom('Ben', 'sword'));
    const rjB = await b.wait(MsgType.ROOM_JOINED);

    // Ana learns Ben joined; Ben's ROOM_JOINED already lists Ana.
    const joined = await a.wait(MsgType.PLAYER_JOINED);
    assert.equal(joined.player.nickname, 'Ben');
    assert.ok(rjB.initialPlayers[rjA.id], 'Ben sees Ana in his initial roster');

    // The server is ticking: both receive GAME_STATE snapshots with both players.
    const stateA = await a.wait(MsgType.GAME_STATE, 2000);
    assert.ok(stateA.players[rjA.id] && stateA.players[rjB.id], 'snapshot has both players');

    a.close(); b.close();
  } finally { await close(); }
});

test('server is authoritative: input moves only the sender, not the peer', async () => {
  const { port, close, rooms } = await boot();
  try {
    const a = await connect(port, 'CHARLIE');
    a.send(Protocol.joinRoom('Mover', 'sword'));
    const rjA = await a.wait(MsgType.ROOM_JOINED);
    const b = await connect(port, 'CHARLIE');
    b.send(Protocol.joinRoom('Still', 'sword'));
    const rjB = await b.wait(MsgType.ROOM_JOINED);

    const room = rooms.rooms.get('CHARLIE');
    const moverX0 = room.sim.players[rjA.id].x;
    const stillX0 = room.sim.players[rjB.id].x;

    // Mover holds "right" for a while; Still sends nothing.
    for (let i = 0; i < 40; i++) { a.send(Protocol.clientInput({ d: true })); await sleep(15); }

    const moverX1 = room.sim.players[rjA.id].x;
    const stillX1 = room.sim.players[rjB.id].x;
    assert.ok(moverX1 > moverX0 + 20, `mover should have walked right (${moverX0} -> ${moverX1})`);
    assert.ok(Math.abs(stillX1 - stillX0) < 5, 'the peer must not move from the mover\'s input');

    a.close(); b.close();
  } finally { await close(); }
});

test('a disconnect removes the player and empties the room', async () => {
  const { port, close, rooms } = await boot();
  try {
    const a = await connect(port, 'DELTA');
    a.send(Protocol.joinRoom('Solo', 'sword'));
    await a.wait(MsgType.ROOM_JOINED);

    const room = rooms.rooms.get('DELTA');
    assert.equal(room.clients.size, 1);

    a.close();
    await sleep(120);
    assert.equal(room.clients.size, 0, 'client removed on disconnect');
    assert.equal(room.isEmpty, true);
    // The loop stopped, so the lobby no longer advertises it.
    const list = rooms.list();
    assert.equal(list.length, 0);
  } finally { await close(); }
});
