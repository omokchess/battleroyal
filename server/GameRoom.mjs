/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One authoritative match on the game server: a GameSim plus the sockets of the
 * players in it. This is the "thin layer that owns the sim and delivers its
 * messages" — all the game logic lives in GameSim (game/sim/GameSim.js), which
 * runs here exactly as it does in the browser host.
 *
 * A room:
 *   - ticks the sim at a fixed 30 Hz (server clock)
 *   - drains the sim's outbox and fans it out to the room's sockets (~20 Hz for
 *     GAME_STATE, immediately for kills), replacing the browser host's broadcast
 *   - seats a joining socket via GameSim.addPlayer and replies with ROOM_JOINED
 *   - routes PLAYER_INPUT/AIM/ACTION/WEAPON_SELECT into the sim seam
 *
 * It never renders and never touches the DOM (there is none): the sim's Fx sink
 * defaults to the headless NULL_FX.
 */

import { GameSim } from '../game/sim/GameSim.js';
import { MsgType, Protocol } from '../multiplayer/Protocol.js';
import { canonicalWeaponsSnapshot } from '../game/Motion.js';

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

export class GameRoom {
  /**
   * @param {string} code room code
   * @param {object} opts { roomConfig, botWorkshopWeapons, seed, log }
   */
  constructor(code, opts = {}) {
    this.code = code;
    this.log = opts.log || (() => {});
    // The sim owns every rule. The server is the authority, so mark it so.
    this.sim = new GameSim({
      roomConfig: opts.roomConfig || {},
      botWorkshopWeapons: opts.botWorkshopWeapons || [],
      seed: opts.seed,
    });
    this.sim.isAuthority = true;
    this.sim.isRunning = true;

    // socketId -> { ws, playerId }
    this.clients = new Map();

    this._loop = null;
    this._lastTick = 0;
    this._maxTickMs = 0;
    this._createdAt = Date.now();
  }

  get playerCount() {
    return Object.keys(this.sim.players).filter(id => !this.sim.players[id]?.isBot && !this.sim.players[id]?.isDummy).length;
  }

  get isEmpty() {
    return this.clients.size === 0;
  }

  /** Public room-list summary (mirrors the old MQTT RoomRegistry entry). */
  summary() {
    const host = [...this.clients.values()][0];
    return {
      code: this.code,
      players: this.clients.size,
      host: host ? (this.sim.players[host.playerId]?.nickname || this.code) : this.code,
      config: this.sim.roomConfig,
      dummy: false,
    };
  }

  // ── membership ─────────────────────────────────────────────────────────────

  /**
   * Seat a socket. `join` is the untrusted JOIN_ROOM payload; the sim sanitizes
   * it. Replies to this socket with ROOM_JOINED and tells the rest a player
   * joined. Returns the assigned playerId.
   */
  join(socketId, ws, join = {}) {
    const player = this.sim.addPlayer(socketId, join);
    if (!player) return null;
    this.clients.set(socketId, { ws, playerId: socketId });

    this._send(ws, Protocol.roomJoined(
      socketId,
      this.sim.snapshotPlayers(),
      this.sim.mapWidth,
      this.sim.mapHeight,
      this.sim.roomConfig,
      this.sim.coverSeed,
      canonicalWeaponsSnapshot(),
    ));
    this._broadcast({ type: MsgType.PLAYER_JOINED, player: player.serialize() }, socketId);

    this.log(`[room ${this.code}] +${player.nickname} (${this.clients.size} in room)`);
    if (!this._loop) this._start();
    return socketId;
  }

  leave(socketId) {
    const c = this.clients.get(socketId);
    if (!c) return;
    this.clients.delete(socketId);
    this.sim.removePlayer(socketId);
    this._broadcast({ type: MsgType.PLAYER_LEFT, id: socketId });
    this.log(`[room ${this.code}] -${socketId} (${this.clients.size} left)`);
    if (this.isEmpty) this._stop();
  }

  // ── inbound client messages ──────────────────────────────────────────────────

  handle(socketId, data) {
    if (!data || typeof data.type !== 'string') return;
    const now = this.sim.now();
    switch (data.type) {
      case MsgType.PLAYER_INPUT:  this.sim.applyInput(socketId, data.keys); break;
      case MsgType.PLAYER_AIM:    this.sim.applyAim(socketId, data.angle); break;
      case MsgType.PLAYER_ACTION: this.sim.applyAction(socketId, data, now); break;
      case MsgType.WEAPON_SELECT: this.sim.applyWeaponSelect(socketId, data); break;
      case MsgType.PING:          this._send(this.clients.get(socketId)?.ws, Protocol.pong(data.seq)); break;
      default: break;
    }
  }

  // ── the authoritative loop ───────────────────────────────────────────────────

  _start() {
    this._lastTick = this.sim.now();
    this._snapAccum = 0;
    // setInterval is fine here: unlike a browser tab, a Node server is never
    // throttled in the background.
    this._loop = setInterval(() => this._step(), TICK_MS);
    this.log(`[room ${this.code}] loop started @${TICK_HZ}Hz`);
  }

  _stop() {
    if (this._loop) clearInterval(this._loop);
    this._loop = null;
    this.log(`[room ${this.code}] loop stopped`);
  }

  _step() {
    const now = this.sim.now();
    let dt = (now - this._lastTick) / 1000;
    this._lastTick = now;
    // Clamp a long stall (GC pause, laptop sleep) so physics can't tunnel.
    if (dt > 0.1) dt = 0.1;

    const t0 = now;
    this.sim.tick(dt, now);
    // The sim already caps GAME_STATE to its own ~22 Hz cadence and queues kills
    // as they happen, so just fan whatever it queued out to the room.
    for (const m of this.sim.drainOutbox()) this._broadcast(m);

    const spent = this.sim.now() - t0;
    if (spent > this._maxTickMs) this._maxTickMs = spent;
    if (spent > TICK_MS) this.log(`[room ${this.code}] ⚠ slow tick ${spent.toFixed(1)}ms`);
  }

  // ── delivery ─────────────────────────────────────────────────────────────────

  _send(ws, msg) {
    if (ws && ws.readyState === 1 /* OPEN */) {
      try { ws.send(JSON.stringify(msg)); } catch { /* dropped socket */ }
    }
  }

  _broadcast(msg, exceptSocketId = null) {
    const raw = JSON.stringify(msg);
    for (const [sid, c] of this.clients) {
      if (sid === exceptSocketId) continue;
      if (c.ws && c.ws.readyState === 1) {
        try { c.ws.send(raw); } catch { /* dropped socket */ }
      }
    }
  }

  destroy() {
    this._stop();
    this.clients.clear();
    this.sim.isRunning = false;
  }
}
