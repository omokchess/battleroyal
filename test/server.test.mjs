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

async function bootWithFirebase(firebaseServices) {
  const server = createServer({ port: 0, silent: true, firebaseServices });
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

test('the room list exposes creator settings as soon as the join is accepted', async () => {
  const { port, close } = await boot();
  try {
    const a = await connect(port, 'CONFIGURED');
    const join = Protocol.joinRoom('Builder', 'sword');
    join.roomConfig = { platforms: 'many', platformShape: 'stairs', cover: 'few', healing: false };
    a.send(join);
    await a.wait(MsgType.ROOM_JOINED);

    const rooms = await (await fetch(`http://localhost:${port}/rooms`, { cache: 'no-store' })).json();
    const listed = rooms.find(r => r.code === 'CONFIGURED');
    assert.ok(listed, 'accepted room is advertised');
    assert.equal(listed.config.platforms, 'many');
    assert.equal(listed.config.platformShape, 'stairs');
    assert.equal(listed.config.cover, 'few');
    assert.equal(listed.config.healing, false);
    a.close();
  } finally { await close(); }
});

test('a dead server-authoritative player respawns and the client receives it', async () => {
  const { port, close, rooms } = await boot();
  try {
    const a = await connect(port, 'RESPAWN');
    a.send(Protocol.joinRoom('Phoenix', 'sword'));
    const joined = await a.wait(MsgType.ROOM_JOINED);
    const room = rooms.rooms.get('RESPAWN');
    const player = room.sim.players[joined.id];
    player.hp = 0;
    player.isDead = true;

    const deadline = Date.now() + 3000;
    let aliveSnapshot = null;
    while (Date.now() < deadline && !aliveSnapshot) {
      aliveSnapshot = a.frames.find(f => f.type === MsgType.GAME_STATE
        && f.players?.[joined.id]?.isDead === false
        && f.players[joined.id].hp > 0);
      if (!aliveSnapshot) await sleep(25);
    }
    assert.ok(aliveSnapshot, 'authoritative state announces the respawn');
    assert.equal(player.isDead, false);
    assert.equal(player.hp, player.maxHp);
    assert.equal(player.respawnTime, 0);
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

test('a disconnect keeps the seat during grace, then expiry removes it', async () => {
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
    assert.equal(room.isEmpty, false, 'seat remains reconnectable during grace');
    assert.ok(room.sim.players[Object.keys(room.sim.players)[0]], 'server-side character remains');

    const token = [...room.sessions.keys()][0];
    room._expireSession(token);
    assert.equal(room.isEmpty, true, 'seat is removed after grace expires');
    assert.equal(rooms.list().length, 0);
  } finally { await close(); }
});

test('a client reconnects with the same opaque session and player id', async () => {
  const { port, close, rooms } = await boot();
  try {
    const a = await connect(port, 'ECHO');
    a.send(Protocol.joinRoom('Returner', 'sword'));
    const first = await a.wait(MsgType.ROOM_JOINED);
    assert.ok(first.sessionToken);
    a.close();
    await sleep(100);

    const b = await connect(port, 'ECHO');
    b.send(Protocol.joinRoom('Returner', 'sword', null, false, null, { sessionToken: first.sessionToken }));
    const resumed = await b.wait(MsgType.ROOM_JOINED);
    assert.equal(resumed.id, first.id);
    assert.equal(rooms.rooms.get('ECHO').playerCount, 1, 'reconnect did not duplicate the character');
    b.close();
  } finally { await close(); }
});

test('room setting ownership moves to the next connected player', async () => {
  const { port, close, rooms } = await boot();
  try {
    const a = await connect(port, 'FOXTROT');
    a.send(Protocol.joinRoom('First', 'sword'));
    const first = await a.wait(MsgType.ROOM_JOINED);
    const b = await connect(port, 'FOXTROT');
    b.send(Protocol.joinRoom('Second', 'sword'));
    const second = await b.wait(MsgType.ROOM_JOINED);
    assert.equal(rooms.rooms.get('FOXTROT').hostId, first.id);

    a.close();
    const changed = await b.wait(MsgType.HOST_CHANGED);
    assert.equal(changed.hostId, second.id);
    assert.equal(rooms.rooms.get('FOXTROT').hostId, second.id);
    b.close();
  } finally { await close(); }
});

test('verified Firebase identity binds uid/nickname and records authoritative stats', async () => {
  const recorded = [];
  const firebaseServices = {
    enabled: true,
    verifyIdToken: async (token) => token === 'good' ? { uid: 'uid-1', name: 'VerifiedName' } : null,
    recordMatch: async (identity, stats, id) => { recorded.push({ identity, stats, id }); return true; },
  };
  const { port, close } = await bootWithFirebase(firebaseServices);
  try {
    const a = await connect(port, 'GOLF');
    const join = Protocol.joinRoom('ForgedName', 'sword', null, false, null, { idToken: 'good' });
    a.send(join);
    const joined = await a.wait(MsgType.ROOM_JOINED);
    assert.equal(joined.initialPlayers[joined.id].nickname, 'VerifiedName');
    a.send(Protocol.leaveRoom());
    for (let i = 0; i < 50 && !recorded.length; i++) await sleep(10);
    assert.equal(recorded[0].identity.uid, 'uid-1');
    assert.equal(recorded[0].stats.kills, 0);
    a.close();
  } finally { await close(); }
});

test('invalid Firebase token falls back to an unverified guest seat', async () => {
  const firebaseServices = {
    enabled: true,
    verifyIdToken: async () => { throw new Error('bad token'); },
    recordMatch: async () => null,
  };
  const { port, close, rooms } = await bootWithFirebase(firebaseServices);
  try {
    const a = await connect(port, 'HOTEL');
    a.send(Protocol.joinRoom('Nope', 'sword', null, false, null, { idToken: 'bad' }));
    const joined = await a.wait(MsgType.ROOM_JOINED);
    assert.equal(joined.initialPlayers[joined.id].nickname, 'Nope');
    assert.equal(rooms.rooms.size, 1);
    a.send(Protocol.leaveRoom());
  } finally { await close(); }
});
