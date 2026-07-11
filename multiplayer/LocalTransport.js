/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Offline transport for the one-click bot match. There is no network and no
 * signaling broker: the browser itself is the authoritative host, running its
 * own GameSim. So this transport just announces "you are the host" and lets the
 * Game shell take its local-authority path (start() → beginMatch → physics).
 *
 * There are never any peers, so send/broadcast are no-ops — mirroring the old
 * NetworkManager.hostLocal exactly.
 */

export class LocalTransport {
  /** @param {(event:string, ...args:any[]) => void} emit the manager's emitter */
  constructor(emit) {
    this.emit = emit;
    this.isHost = true;
    this.localId = null;
    this.roomCode = '';
    this.latency = 0;
    this._stopped = false;
  }

  start(roomCode = 'SOLO') {
    this.roomCode = String(roomCode || 'SOLO').toUpperCase();
    this.localId = `local-${Date.now()}`;
    // Defer so listeners registered right after the call still fire (the Game
    // shell wires onInit/onConnected immediately after start()).
    setTimeout(() => {
      if (this._stopped) return;
      this.emit('onInit', this.roomCode);
      this.emit('onConnected');
    }, 0);
  }

  sendToHost() { return false; }   // we ARE the host; nothing to send to
  broadcast() {}                   // no guests
  sendTo() { return false; }

  stop() { this._stopped = true; }
}
