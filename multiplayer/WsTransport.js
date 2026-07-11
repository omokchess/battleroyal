/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Online transport: a WebSocket to the dedicated game server (server/).
 *
 * The server is the authority, so this client is always a GUEST — it renders the
 * snapshots the server sends and forwards its own input. "Creating" a room and
 * "joining" one are the same operation: connect and send JOIN_ROOM; the server
 * creates the room on the first join (a room-creator carries roomConfig in the
 * payload). This is why isHost is always false and broadcast/sendTo are no-ops.
 *
 * It maps the server's frames onto the same events the P2P guest path used
 * (onConnected on open, onData for everything, onDisconnected on drop), so the
 * Game shell's existing client route works unchanged.
 *
 * Uses the global WebSocket, which exists in the browser and in Node ≥ 22, so
 * the transport is testable headlessly against the real server.
 */

import { MsgType } from './Protocol.js';

const CONNECT_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 2500;

export class WsTransport {
  /**
   * @param {(event:string, ...args:any[]) => void} emit the manager's emitter
   * @param {string} url base ws(s):// server URL
   */
  constructor(emit, url) {
    this.emit = emit;
    this.url = url;
    this.isHost = false;          // the SERVER is the host
    this.localId = null;          // assigned by the server in ROOM_JOINED
    this.roomCode = '';
    this.latency = 0;
    this.ws = null;
    this._stopped = false;
    this._joined = false;
    this._connectTimer = null;
    this._pingTimer = null;
    this._pingSeq = 0;
    this._pendingPings = new Map();
  }

  /**
   * Connect and register. `joinPayload` is the JOIN_ROOM frame; a room-creator
   * puts roomConfig on it so the server builds the arena with those settings.
   */
  start(roomCode, joinPayload = {}) {
    this.roomCode = String(roomCode || '').trim().toUpperCase();
    const sep = this.url.includes('?') ? '&' : '?';
    const full = `${this.url}${sep}room=${encodeURIComponent(this.roomCode)}`;

    let ws;
    try {
      ws = new WebSocket(full);
    } catch (err) {
      this.emit('onError', '게임 서버에 연결할 수 없습니다.');
      return;
    }
    this.ws = ws;

    this._connectTimer = setTimeout(() => {
      if (this._joined) return;
      this.emit('onError', `방 "${this.roomCode}" 연결 시간 초과.`);
      this.stop();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this._stopped) return;
      this._send(joinPayload);
      this.emit('onConnected');   // Game shell builds the (guest) match here
      this._startPing();
    };

    ws.onmessage = (ev) => {
      if (this._stopped) return;
      let data;
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (!data || typeof data.type !== 'string') return;

      if (data.type === MsgType.PONG) { this._onPong(data); return; }
      if (data.type === MsgType.ROOM_JOINED) {
        this._joined = true;
        this.localId = data.id;
        clearTimeout(this._connectTimer);
      }
      if (data.type === MsgType.ERROR) {
        this.emit('onError', data.message || '서버 오류.');
        return;
      }
      // Every game frame flows through onData, tagged 'server' (the sim/shell
      // don't care about the sender id on the client).
      this.emit('onData', 'server', data);
    };

    ws.onclose = () => {
      if (this._stopped) return;
      clearTimeout(this._connectTimer);
      this._stopPing();
      if (this._joined) this.emit('onDisconnected', '게임 서버 연결이 끊어졌습니다.');
      else this.emit('onError', '게임 서버 연결이 종료되었습니다.');
    };

    ws.onerror = () => {
      if (this._stopped || this._joined) return;
      this.emit('onError', '게임 서버 연결 오류.');
    };
  }

  sendToHost(payload) { return this._send(payload); }
  broadcast() {}                 // a guest never broadcasts; the server fans out
  sendTo() { return false; }

  stop() {
    this._stopped = true;
    this._stopPing();
    clearTimeout(this._connectTimer);
    if (this.ws) {
      try { this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null; this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
  }

  _send(payload) {
    if (this._stopped || !this.ws || this.ws.readyState !== 1 /* OPEN */) return false;
    try { this.ws.send(JSON.stringify(payload)); return true; }
    catch { return false; }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      const seq = ++this._pingSeq;
      this._pendingPings.set(seq, Date.now());
      this._send({ type: MsgType.PING, seq });
      // forget stale pings
      const cutoff = Date.now() - 4 * PING_INTERVAL_MS;
      for (const [s, t] of this._pendingPings) if (t < cutoff) this._pendingPings.delete(s);
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._pendingPings.clear();
  }

  _onPong(data) {
    const sentAt = this._pendingPings.get(data.seq);
    if (!sentAt) return;
    this._pendingPings.delete(data.seq);
    this.latency = Date.now() - sentAt;
  }
}
