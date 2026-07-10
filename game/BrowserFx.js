/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser implementation of the simulation's presentation sink (see sim/Fx.js).
 *
 * This is the CLIENT SHELL half of the Phase 0 split: everything the simulation
 * used to do inline — Sound.play, camera.startShake, hitstop, navigator.vibrate,
 * the announcement banner, the kill feed — lives here, behind the same interface
 * the headless server satisfies with a no-op.
 *
 * Gating on the local player happens HERE, not in the sim: the sim tags each cue
 * with the player it belongs to and this decides whether that is "me".
 */

import { NullFx } from './sim/Fx.js';
import { Sound } from './Sound.js';

export class BrowserFx extends NullFx {
  /**
   * @param {object} shell the Game shell — read live so a late-assigned camera /
   *   localPlayerId (both are set after construction) still resolve correctly.
   */
  constructor(shell) {
    super();
    this.shell = shell;
  }

  /** True when a cue tagged for `playerId` belongs to the local player. A null
   *  tag means "everyone hears this". */
  _isLocal(playerId) {
    return playerId == null || playerId === this.shell.localPlayerId;
  }

  sfx(id, playerId = null) {
    if (this._isLocal(playerId)) Sound.play(String(id));
  }

  attackSfx(weaponConfig, playerId = null) {
    if (this._isLocal(playerId)) Sound.play(Sound.attackSoundFor(weaponConfig));
  }

  shake(mag, ms, playerId = null) {
    if (!this._isLocal(playerId)) return;
    const cam = this.shell.camera;
    if (cam && typeof cam.startShake === 'function') cam.startShake(mag, ms);
  }

  hitstop(ms, playerId = null) {
    if (this._isLocal(playerId)) this.shell._triggerHitstop(Date.now(), ms);
  }

  vibrate(pattern, playerId = null) {
    if (!this._isLocal(playerId)) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(pattern); }
      catch { /* exposed but blocked by policy */ }
    }
  }

  announce(text, playerId = null) {
    if (!this._isLocal(playerId)) return;   // scoped to one player (e.g. "궁극기 준비!")
    const textEl = typeof document !== 'undefined' ? document.getElementById('announcementText') : null;
    if (!textEl) return;
    textEl.classList.remove('animate-announcement');
    void textEl.offsetWidth;   // force reflow so the animation restarts
    textEl.textContent = text;
    textEl.classList.add('animate-announcement');
  }

  killFeed(evt) {
    this.shell._pushKillFeed(evt);
  }

  weaponApplied(playerId) {
    if (!this._isLocal(playerId)) return;
    this.shell.pendingWeaponChoice = null;
    this.shell.pendingWeaponChoiceLabel = '';
  }
}
