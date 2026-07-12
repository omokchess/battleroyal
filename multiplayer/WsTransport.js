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
const RECONNECT_GRACE_MS = 25000;
const AUTH_TOKEN_TIMEOUT_MS = 1500;

export class WsTransport {
  /**
   * @param {(event:string, ...args:any[]) => void} emit the manager's emitter
   * @param {string} url base ws(s):// server URL
   */
  constructor(emit, url, options = {}) {
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
    this.getAuthToken = typeof options.getAuthToken === 'function' ? options.getAuthToken : null;
    this.sessionToken = '';
    this._joinPayload = null;
    this._everOpened = false;
    this._reconnectStartedAt = 0;
    this._retryTimer = null;
    this._attempt = 0;
    this._pendingGameState = null;
    this._gameStateFlushHandle = null;
    this._gameStateFlushKind = '';
    this._lastGameStateSequence = -1;
  }

  /**
   * Connect and register. `joinPayload` is the JOIN_ROOM frame; a room-creator
   * puts roomConfig on it so the server builds the arena with those settings.
   */
  start(roomCode, joinPayload = {}) {
    this.roomCode = String(roomCode || '').trim().toUpperCase();
    this._joinPayload = { ...joinPayload };
    this._connect();
  }

  _connect() {
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

    ws.onopen = async () => {
      if (this._stopped) return;
      let idToken = '';
      try {
        idToken = await Promise.race([
          Promise.resolve(this.getAuthToken?.()).catch(() => ''),
          new Promise((resolve) => setTimeout(() => resolve(''), AUTH_TOKEN_TIMEOUT_MS)),
        ]) || '';
      } catch { /* guest fallback */ }
      if (this._stopped || ws !== this.ws) return;
      const payload = { ...this._joinPayload };
      if (idToken) payload.idToken = idToken;
      if (this.sessionToken) payload.sessionToken = this.sessionToken;
      this._send(payload);
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
        this._lastGameStateSequence = -1;
        const firstJoin = !this._joined;
        this._joined = true;
        this.localId = data.id;
        if (data.sessionToken) this.sessionToken = data.sessionToken;
        this._reconnectStartedAt = 0;
        this._attempt = 0;
        clearTimeout(this._connectTimer);
        // "Connected" means the server accepted the room join, not merely that
        // the TCP/WebSocket handshake opened. Emit synchronously before onData
        // so main.js can construct the Game shell, which then receives this same
        // ROOM_JOINED frame below.
        if (firstJoin && !this._everOpened) {
          this._everOpened = true;
          this.emit('onConnected');
        }
      }
      if (data.type === MsgType.SERVER_SHUTDOWN) {
        this.emit('onData', 'server', data);
        this._finishDisconnect(data.message || '게임 서버가 재시작됩니다.');
        return;
      }
      if (data.type === MsgType.ERROR) {
        this.emit('onError', data.message || '서버 오류.');
        return;
      }
      if (data.type === MsgType.GAME_STATE) {
        this._queueLatestGameState(data);
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
      this._cancelQueuedGameState();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // close follows error in browser and Node WebSocket implementations;
      // the close path owns retry/final failure so UI is not torn down early.
    };
  }

  sendToHost(payload) { return this._send(payload); }
  broadcast() {}                 // a guest never broadcasts; the server fans out
  sendTo() { return false; }

  stop() {
    if (!this._stopped) this._send({ type: MsgType.LEAVE_ROOM });
    this._stopped = true;
    this._stopPing();
    this._cancelQueuedGameState();
    clearTimeout(this._connectTimer);
    clearTimeout(this._retryTimer);
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

  /**
   * A proxy or a temporarily busy tab can deliver several authoritative
   * snapshots in one burst. Applying every stale intermediate state before the
   * next paint stacks the client's per-snapshot correction and looks like a
   * teleport. Keep only the newest GAME_STATE for the next render frame.
   * Discrete frames (kills, joins, actions) still bypass this queue unchanged.
   */
  _queueLatestGameState(frame) {
    const sequence = Number(frame?.stateSeq);
    const pendingSequence = Number(this._pendingGameState?.stateSeq);
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      if (sequence <= this._lastGameStateSequence) return;
      if (this._pendingGameState && Number.isSafeInteger(pendingSequence) && sequence <= pendingSequence) return;
    }

    this._pendingGameState = frame;
    if (this._gameStateFlushHandle !== null) return;

    const flush = () => {
      this._gameStateFlushHandle = null;
      this._gameStateFlushKind = '';
      const latest = this._pendingGameState;
      this._pendingGameState = null;
      if (this._stopped || !latest) return;
      const latestSequence = Number(latest.stateSeq);
      if (Number.isSafeInteger(latestSequence) && latestSequence >= 0) {
        if (latestSequence <= this._lastGameStateSequence) return;
        this._lastGameStateSequence = latestSequence;
      }
      this.emit('onData', 'server', latest);
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this._gameStateFlushKind = 'raf';
      this._gameStateFlushHandle = globalThis.requestAnimationFrame(flush);
    } else {
      this._gameStateFlushKind = 'timeout';
      this._gameStateFlushHandle = setTimeout(flush, 0);
    }
  }

  _cancelQueuedGameState() {
    if (this._gameStateFlushHandle !== null) {
      if (this._gameStateFlushKind === 'raf' && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this._gameStateFlushHandle);
      } else {
        clearTimeout(this._gameStateFlushHandle);
      }
    }
    this._gameStateFlushHandle = null;
    this._gameStateFlushKind = '';
    this._pendingGameState = null;
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

  _scheduleReconnect() {
    if (this._stopped) return;
    if (!this._reconnectStartedAt) this._reconnectStartedAt = Date.now();
    const elapsed = Date.now() - this._reconnectStartedAt;
    if (elapsed >= RECONNECT_GRACE_MS) {
      this._finishDisconnect('게임 서버 재연결 시간이 초과되었습니다.');
      return;
    }
    const delay = Math.min(2500, 300 * (2 ** Math.min(this._attempt++, 4)));
    this.emit('onReconnecting', { attempt: this._attempt, remainingMs: RECONNECT_GRACE_MS - elapsed });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  _finishDisconnect(reason) {
    if (this._stopped) return;
    this._stopped = true;
    this._stopPing();
    this._cancelQueuedGameState();
    clearTimeout(this._connectTimer);
    clearTimeout(this._retryTimer);
    try { this.ws?.close(); } catch {}
    this.emit('onDisconnected', reason);
  }
}
