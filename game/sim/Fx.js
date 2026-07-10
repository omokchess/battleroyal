/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The presentation sink the SIMULATION talks to instead of Sound / camera / DOM.
 *
 * Phase 0 of the host-authoritative → server-authoritative move: the simulation
 * must run unchanged in a browser (offline bot match) AND in Node (the game
 * server), so it may never touch Sound, the camera, `document`, or `navigator`.
 * Every juice call it used to make inline now goes through this interface.
 *
 * `playerId` means "this cue belongs to that player". The BROWSER implementation
 * decides whether that is the local player and therefore whether to play it —
 * the simulation itself has no concept of a local player, which is exactly what
 * lets the same code run on a headless server that has no local player at all.
 * Pass `null` for a cue everyone hears.
 */

/** No-op sink: the server (and headless tests) run the sim with this. */
export class NullFx {
  /** @param {string} _id sound id @param {string|null} _playerId owner of the cue */
  sfx(_id, _playerId = null) {}
  /** Swing cue for a weapon. The sim passes the weapon config and lets the sink
   *  derive the sound id, so sim code never imports the audio engine. */
  attackSfx(_weaponConfig, _playerId = null) {}
  shake(_mag, _ms, _playerId = null) {}
  hitstop(_ms, _playerId = null) {}
  vibrate(_pattern, _playerId = null) {}
  announce(_text) {}
  killFeed(_evt) {}
}

/** Shared stateless default. Simulation code can always call `this.fx.*`. */
export const NULL_FX = new NullFx();

/**
 * Records every cue instead of playing it. Used by the headless regression test
 * to assert the sim still emits the same juice it always did (and to prove it
 * never reaches for the DOM).
 */
export class RecordingFx extends NullFx {
  constructor() {
    super();
    this.calls = [];
  }
  sfx(id, playerId = null) { this.calls.push({ type: 'sfx', id, playerId }); }
  attackSfx(weaponConfig, playerId = null) { this.calls.push({ type: 'attackSfx', weaponConfig, playerId }); }
  shake(mag, ms, playerId = null) { this.calls.push({ type: 'shake', mag, ms, playerId }); }
  hitstop(ms, playerId = null) { this.calls.push({ type: 'hitstop', ms, playerId }); }
  vibrate(pattern, playerId = null) { this.calls.push({ type: 'vibrate', pattern, playerId }); }
  announce(text) { this.calls.push({ type: 'announce', text }); }
  killFeed(evt) { this.calls.push({ type: 'killFeed', evt }); }
}
