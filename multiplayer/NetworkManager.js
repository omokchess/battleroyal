/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The client's networking facade. It keeps the same event/method surface the
 * game shell always used, but the actual connection is delegated to a pluggable
 * transport (Phase 2 of the server-authoritative move):
 *
 *   - LocalTransport : offline one-click bot match — the browser is its own
 *                      authoritative host, no network at all.
 *   - WsTransport    : online — a WebSocket to the dedicated game server, which
 *                      is the authority. This client is a guest that renders
 *                      snapshots and forwards input.
 *
 * PeerJS/WebRTC is gone: the server plays the "host" role for real.
 *
 * `hostRoom`/`joinRoom` both open a WsTransport — creating and joining a room
 * are the same operation server-side (it creates the room on the first join; a
 * creator carries roomConfig in the payload). `hostLocal` uses LocalTransport.
 */

import { LocalTransport } from './LocalTransport.js';
import { WsTransport } from './WsTransport.js';
import { gameServerUrl } from './serverConfig.js';

const EVENTS = [
  'onInit',
  'onError',
  'onConnected',
  'onPlayerJoined',
  'onPlayerLeft',
  'onData',
  'onDisconnected'
];

export class NetworkManager {
  constructor(options = {}) {
    this.callbacks = {};
    EVENTS.forEach(event => { this.callbacks[event] = new Set(); });
    // Overridable for tests (Node) that point at an ephemeral local server.
    this.serverUrl = options.serverUrl || null;
    this.transport = null;
  }

  on(event, callback) {
    if (!Object.prototype.hasOwnProperty.call(this.callbacks, event) || typeof callback !== 'function') {
      return () => {};
    }
    this.callbacks[event].add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (Object.prototype.hasOwnProperty.call(this.callbacks, event)) {
      this.callbacks[event].delete(callback);
    }
  }

  _emit(event, ...args) {
    const listeners = this.callbacks[event];
    if (!listeners) return;
    [...listeners].forEach(listener => {
      try { listener(...args); }
      catch (err) { console.error(`NetworkManager listener failed for ${event}:`, err); }
    });
  }

  // ── identity (delegated to the active transport) ─────────────────────────────
  get isHost()  { return this.transport ? this.transport.isHost : false; }
  get localId() { return this.transport ? this.transport.localId : null; }
  get roomCode() { return this.transport ? this.transport.roomCode : ''; }
  get latency() { return this.transport ? this.transport.latency : 0; }

  _useTransport(transport) {
    if (this.transport) this.transport.stop();
    this.transport = transport;
    return transport;
  }

  _wsUrl() { return this.serverUrl || gameServerUrl(); }

  // ── connection lifecycle ─────────────────────────────────────────────────────

  /** Offline bot match: the browser hosts its own GameSim (no server). */
  hostLocal(roomCode = 'SOLO') {
    const t = this._useTransport(new LocalTransport(this._emit.bind(this)));
    t.start(roomCode);
  }

  /** Create an online room on the server. Same as joinRoom — the server creates
   *  the room on the first join; the creator's payload carries roomConfig. */
  hostRoom(roomCode, joinPayload = {}) {
    const t = this._useTransport(new WsTransport(this._emit.bind(this), this._wsUrl()));
    t.start(roomCode, joinPayload);
  }

  /** Join an online room on the server (guest — the server is authoritative). */
  joinRoom(roomCode, joinPayload = {}) {
    const t = this._useTransport(new WsTransport(this._emit.bind(this), this._wsUrl()));
    t.start(roomCode, joinPayload);
  }

  // ── messaging (delegated) ────────────────────────────────────────────────────
  // A client is either the offline local host (no peers) or an online guest
  // (the server fans out), so broadcast/sendTo are no-ops in both cases and only
  // sendToHost carries traffic online.
  broadcast(payload) { this.transport?.broadcast?.(payload); }
  sendTo(targetId, payload) { return this.transport?.sendTo?.(targetId, payload) ?? false; }
  sendToHost(payload) { return this.transport?.sendToHost?.(payload) ?? false; }

  stop() {
    if (this.transport) { this.transport.stop(); this.transport = null; }
  }
}
