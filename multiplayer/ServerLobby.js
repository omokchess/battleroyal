/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The lobby room list, backed by the dedicated game server's /rooms endpoint
 * (Phase 2 — replaces the P2P world's public MQTT RoomRegistry). Rooms are now
 * owned and advertised by the server, so the client just polls its list.
 *
 * Keeps the small browsing surface main.js already used (startBrowsing /
 * stopBrowsing / list / online), so the lobby UI is untouched. Hosting is no
 * longer a client concern — the server tracks rooms — so startHosting /
 * stopHosting are inert.
 */

import { gameServerHttpUrl } from './serverConfig.js';

const POLL_MS = 2500;

export class ServerLobby {
  constructor(httpUrl = null) {
    this.httpUrl = (httpUrl || gameServerHttpUrl()).replace(/\/+$/, '');
    this.online = false;       // last poll reached the server
    this._rooms = [];
    this._timer = null;
    this._cb = null;
    this._inflight = false;
  }

  /** The last fetched room list (synchronous — main.js reads this directly). */
  list() {
    return this._rooms;
  }

  startBrowsing(onRooms) {
    this._cb = typeof onRooms === 'function' ? onRooms : null;
    this._poll();                                   // immediate first fetch
    if (!this._timer) this._timer = setInterval(() => this._poll(), POLL_MS);
    if (this._timer && this._timer.unref) this._timer.unref?.();
  }

  stopBrowsing() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._cb = null;
  }

  async _poll() {
    if (this._inflight) return;
    this._inflight = true;
    try {
      const res = await fetch(`${this.httpUrl}/rooms`, { cache: 'no-store' });
      const rooms = await res.json();
      this._rooms = Array.isArray(rooms) ? rooms : [];
      this.online = true;
    } catch {
      this._rooms = [];
      this.online = false;      // server unreachable → empty list, not a crash
    } finally {
      this._inflight = false;
      if (this._cb) { try { this._cb(this._rooms); } catch { /* UI callback threw */ } }
    }
  }

  // Hosting is the server's job now; these keep the old call sites harmless.
  startHosting() {}
  stopHosting() {}
}
