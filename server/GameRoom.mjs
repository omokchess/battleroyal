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
import { randomUUID } from 'node:crypto';

const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
export const RECONNECT_GRACE_MS = 25_000;

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
      onMatchOver: (results) => this._onMatchOver(results),
    });
    this.sim.isAuthority = true;
    this.sim.isRunning = true;

    // socketId -> { ws, playerId, sessionToken }
    this.clients = new Map();
    // Opaque token -> reconnectable seat. Tokens never become player ids.
    this.sessions = new Map();
    this.hostId = null;
    this.recordMatch = opts.recordMatch || (async () => null);

    this._loop = null;
    this._lastTick = 0;
    this._maxTickMs = 0;
    this._createdAt = Date.now();
  }

  get playerCount() {
    return Object.keys(this.sim.players).filter(id => !this.sim.players[id]?.isBot && !this.sim.players[id]?.isDummy).length;
  }

  get isEmpty() {
    return this.playerCount === 0;
  }

  /** Public room-list summary (mirrors the old MQTT RoomRegistry entry). */
  summary() {
    const host = [...this.clients.values()][0];
    return {
      code: this.code,
      players: this.playerCount,
      connected: this.clients.size,
      host: this.sim.players[this.hostId]?.nickname || (host ? this.sim.players[host.playerId]?.nickname : this.code) || this.code,
      hostId: this.hostId,
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
  join(socketId, ws, join = {}, identity = null) {
    const resumed = this._resume(socketId, ws, join, identity);
    if (resumed) return resumed;
    if (identity?.uid && [...this.sessions.values()].some((s) => s.uid === identity.uid)) return null;

    const playerId = `p_${randomUUID()}`;
    const player = this.sim.addPlayer(playerId, join);
    if (!player) return null;
    const sessionToken = randomUUID();
    this.clients.set(socketId, { ws, playerId, sessionToken });
    this.sessions.set(sessionToken, {
      playerId, uid: identity?.uid || null, identity, connected: true,
      joinedAt: Date.now(), expiresAt: 0, timer: null, recorded: false,
    });
    if (!this.hostId) this._setHost(playerId);

    this._send(ws, Protocol.roomJoined(
      playerId,
      this.sim.snapshotPlayers(),
      this.sim.mapWidth,
      this.sim.mapHeight,
      this.sim.roomConfig,
      this.sim.coverSeed,
      canonicalWeaponsSnapshot(),
      sessionToken,
      this.hostId,
    ));
    this._broadcast({ type: MsgType.PLAYER_JOINED, player: player.serialize() }, socketId);

    this.log(`[room ${this.code}] +${player.nickname} (${this.clients.size} in room)`);
    if (!this._loop) this._start();
    return playerId;
  }

  leave(socketId, graceful = false) {
    const c = this.clients.get(socketId);
    if (!c) return;
    this.clients.delete(socketId);
    const session = this.sessions.get(c.sessionToken);
    if (!session) return;
    session.connected = false;
    this.sim.applyInput(c.playerId, {});
    this.log(`[room ${this.code}] -${c.playerId} (${this.clients.size} connected)`);
    if (this.hostId === c.playerId) this._electHost();

    if (graceful) {
      this._expireSession(c.sessionToken);
      return;
    }
    session.expiresAt = Date.now() + RECONNECT_GRACE_MS;
    session.timer = setTimeout(() => this._expireSession(c.sessionToken), RECONNECT_GRACE_MS);
    if (session.timer.unref) session.timer.unref();
  }

  _resume(socketId, ws, join, identity) {
    const token = typeof join.sessionToken === 'string' ? join.sessionToken : '';
    const session = token && this.sessions.get(token);
    if (!session || session.connected || (session.expiresAt && Date.now() > session.expiresAt)) return null;
    if (session.uid && session.uid !== identity?.uid) return null;
    clearTimeout(session.timer);
    session.timer = null;
    session.connected = true;
    session.expiresAt = 0;
    this.clients.set(socketId, { ws, playerId: session.playerId, sessionToken: token });
    const p = this.sim.players[session.playerId];
    if (!p) return null;
    p.iframeTimeLeft = Math.max(p.iframeTimeLeft || 0, 0.5);
    this._send(ws, Protocol.roomJoined(
      session.playerId, this.sim.snapshotPlayers(), this.sim.mapWidth, this.sim.mapHeight,
      this.sim.roomConfig, this.sim.coverSeed, canonicalWeaponsSnapshot(), token, this.hostId,
    ));
    this.log(`[room ${this.code}] resumed ${session.playerId}`);
    if (!this._loop) this._start();
    return session.playerId;
  }

  _expireSession(token) {
    const session = this.sessions.get(token);
    if (!session || session.connected) return;
    clearTimeout(session.timer);
    this.sessions.delete(token);
    const player = this.sim.players[session.playerId];
    if (player) this._recordSession(session, player);
    this.sim.removePlayer(session.playerId);
    this._broadcast({ type: MsgType.PLAYER_LEFT, id: session.playerId });
    if (this.hostId === session.playerId) this._electHost();
    if (this.isEmpty) {
      this._stop();
      this._emptiedAt = Date.now();
    }
  }

  _setHost(playerId) {
    this.hostId = playerId || null;
    this._broadcast({ type: MsgType.HOST_CHANGED, hostId: this.hostId });
  }

  _electHost() {
    const next = [...this.clients.values()][0]?.playerId || null;
    this._setHost(next);
  }

  // ── inbound client messages ──────────────────────────────────────────────────

  handle(socketId, data) {
    if (!data || typeof data.type !== 'string') return;
    const playerId = this.clients.get(socketId)?.playerId;
    if (!playerId) return;
    const now = this.sim.now();
    switch (data.type) {
      case MsgType.PLAYER_INPUT:  this.sim.applyInput(playerId, data.keys); break;
      case MsgType.PLAYER_AIM:    this.sim.applyAim(playerId, data.angle); break;
      case MsgType.PLAYER_ACTION: this.sim.applyAction(playerId, data, now); break;
      case MsgType.WEAPON_SELECT: this.sim.applyWeaponSelect(playerId, data); break;
      case MsgType.LEAVE_ROOM:    this.leave(socketId, true); break;
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
    // Disconnected seats remain visible but inert and invulnerable during the
    // reconnect grace window. The room keeps ticking for everyone else.
    for (const session of this.sessions.values()) {
      if (session.connected) continue;
      const p = this.sim.players[session.playerId];
      if (p) {
        p.iframeTimeLeft = Math.max(p.iframeTimeLeft || 0, 0.25);
        p.statusImmuneUntil = now + 500;
      }
    }
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

  _recordSession(session, player) {
    if (!session?.identity?.uid || session.recorded) return;
    session.recorded = true;
    const stats = {
      kills: player.kills || 0,
      deaths: player.deaths || 0,
      weapon: player.weapon,
      durationMs: Math.max(0, Date.now() - session.joinedAt),
    };
    const matchId = `${this.code}-${session.playerId}-${session.joinedAt}`;
    Promise.resolve(this.recordMatch(session.identity, stats, matchId))
      .then((saved) => { if (saved) this.log(`[room ${this.code}] recorded ${session.identity.uid}`); })
      .catch((err) => this.log(`[room ${this.code}] record failed: ${err?.message || err}`));
  }

  _onMatchOver(results) {
    for (const result of results) {
      const session = [...this.sessions.values()].find((s) => s.playerId === result.id);
      const player = this.sim.players[result.id];
      if (session && player) this._recordSession(session, player);
    }
  }

  notifyShutdown(retryAfterMs = 3000) {
    this._broadcast({ type: MsgType.SERVER_SHUTDOWN, retryAfterMs, message: '게임 서버가 재시작됩니다.' });
  }

  destroy() {
    this._stop();
    for (const s of this.sessions.values()) clearTimeout(s.timer);
    this.sessions.clear();
    for (const c of this.clients.values()) {
      try { c.ws?.close(1012, 'server restart'); } catch {}
    }
    this.clients.clear();
    this.sim.isRunning = false;
  }
}
