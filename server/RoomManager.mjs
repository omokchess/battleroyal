/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owns every live GameRoom on the server: create-on-first-join, route a socket
 * to its room, and reap empty/idle rooms. Replaces the P2P world's public MQTT
 * RoomRegistry — the room list is now just this map, served over HTTP/ws.
 */

import { GameRoom } from './GameRoom.mjs';
import { MsgType } from '../multiplayer/Protocol.js';

const IDLE_ROOM_MS = 5 * 60 * 1000;   // an empty room is swept after 5 min

export class RoomManager {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.botWorkshopWeapons = opts.botWorkshopWeapons || [];
    this.rooms = new Map();   // code -> GameRoom
    this._sweep = setInterval(() => this._reap(), 60 * 1000);
    if (this._sweep.unref) this._sweep.unref();
  }

  _normalizeCode(code) {
    return String(code || '').trim().toUpperCase().slice(0, 12) || 'LOBBY';
  }

  getOrCreate(code, roomConfig) {
    const key = this._normalizeCode(code);
    let room = this.rooms.get(key);
    if (!room) {
      room = new GameRoom(key, {
        roomConfig: roomConfig || {},
        botWorkshopWeapons: this.botWorkshopWeapons,
        log: this.log,
      });
      this.rooms.set(key, room);
      this.log(`[rooms] created ${key} (${this.rooms.size} total)`);
    }
    return room;
  }

  /** The lobby's room list (was the MQTT registry's retained messages). */
  list() {
    return [...this.rooms.values()].filter(r => !r.isEmpty).map(r => r.summary());
  }

  /**
   * Wire a freshly-connected socket. It stays room-less until its JOIN_ROOM
   * frame arrives; after that every frame routes to its room. Returns a cleanup
   * fn to call on socket close.
   */
  attach(socketId, ws, roomCodeHint) {
    let room = null;

    const onMessage = (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      if (!data || typeof data.type !== 'string') return;

      if (data.type === MsgType.JOIN_ROOM) {
        if (room) return;   // already seated — ignore a second join
        const code = this._normalizeCode(data.room || roomCodeHint);
        room = this.getOrCreate(code, data.roomConfig);
        const assigned = room.join(socketId, ws, data);
        if (!assigned) { room = null; return; }
        return;
      }
      if (room) room.handle(socketId, data);
    };

    const onClose = () => {
      if (room) room.leave(socketId);
      if (room && room.isEmpty) this._maybeReap(room);
      room = null;
    };

    return { onMessage, onClose };
  }

  _maybeReap(room) {
    // Keep just-emptied rooms briefly (a lone player refreshing shouldn't lose
    // the room); the periodic sweep drops ones idle past IDLE_ROOM_MS.
    room._emptiedAt = Date.now();
  }

  _reap() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isEmpty && room._emptiedAt && now - room._emptiedAt > IDLE_ROOM_MS) {
        room.destroy();
        this.rooms.delete(code);
        this.log(`[rooms] reaped ${code} (${this.rooms.size} left)`);
      }
    }
  }

  stats() {
    let players = 0, maxTick = 0;
    for (const r of this.rooms.values()) {
      players += r.clients.size;
      maxTick = Math.max(maxTick, r._maxTickMs || 0);
    }
    return { rooms: this.rooms.size, players, maxTickMs: Math.round(maxTick * 10) / 10 };
  }

  shutdown() {
    clearInterval(this._sweep);
    for (const r of this.rooms.values()) r.destroy();
    this.rooms.clear();
  }
}
