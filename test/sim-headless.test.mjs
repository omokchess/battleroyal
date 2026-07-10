/**
 * Phase 0 regression gate: the simulation core must stay runnable OUTSIDE a
 * browser, because the game server will run this exact code.
 *
 * These tests execute in plain Node — there is no `document`, no `window`, no
 * canvas — so anything that reaches for the DOM fails here rather than in
 * production. They lock in the two seams established in P0a/P0b:
 *
 *   P0a  simulation juice goes through the Fx sink, never Sound/camera/document
 *   P0b  input reaches the sim only via applyInput()/applyAim(), never a device
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../game/Game.js';
import { Player } from '../game/Player.js';
import { NullFx, RecordingFx, NULL_FX } from '../game/sim/Fx.js';

// Guard the guard: if a browser global ever leaks in, these tests would stop
// proving anything.
test('the test environment really is headless', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
});

test('Game imports under Node without touching the DOM', () => {
  assert.equal(typeof Game, 'function');
});

// ── P0a: presentation sink ──────────────────────────────────────────────────

test('the default presentation sink is a headless no-op', () => {
  // A Game built straight off the prototype (what a server/test does) inherits
  // NULL_FX, so simulation code can always call this.fx.* safely.
  const sim = Object.create(Game.prototype);
  assert.equal(sim.fx, NULL_FX);
  assert.ok(sim.fx instanceof NullFx);
});

test('every Fx cue is a safe no-op headlessly', () => {
  const sim = Object.create(Game.prototype);
  // None of these may throw with no DOM/audio present.
  sim.fx.sfx('kill', 'p1');
  sim.fx.attackSfx({ type: 'melee_slam' }, 'p1');
  sim.fx.shake(14, 340, 'p1');
  sim.fx.hitstop(65, 'p1');
  sim.fx.vibrate([10], 'p1');
  sim.fx.announce('hello');
  sim.fx.killFeed({ killerId: 'p1' });
});

test('RecordingFx captures the cues the sim raises, tagged by player', () => {
  const fx = new RecordingFx();
  fx.sfx('dash', 'bot_1');
  fx.hitstop(42, 'me');
  fx.announce('kill!');
  assert.deepEqual(fx.calls, [
    { type: 'sfx', id: 'dash', playerId: 'bot_1' },
    { type: 'hitstop', ms: 42, playerId: 'me' },
    { type: 'announce', text: 'kill!' },
  ]);
});

test('_creditKill runs headlessly and tags juice with the killer', () => {
  const sim = Object.create(Game.prototype);
  const fx = new RecordingFx();
  sim.fx = fx;
  sim.players = {};
  sim.effects = [];

  const killer = new Player('killer', 'Hunter', 'sword', 0, 0);
  const victim = new Player('victim', 'Rival', 'sword', 50, 0);
  sim.players[killer.id] = killer;
  sim.players[victim.id] = victim;

  sim._creditKill(killer.id, victim, '검으로');

  assert.equal(killer.kills, 1);
  // The sim must not decide who hears the cue — it only tags the owner.
  const tagged = fx.calls.filter(c => c.playerId !== undefined);
  assert.ok(tagged.length > 0, 'kill juice should be raised');
  assert.ok(tagged.every(c => c.playerId === killer.id));
  assert.ok(fx.calls.some(c => c.type === 'announce'));
  assert.ok(fx.calls.some(c => c.type === 'killFeed'));
});

// ── P0b: input seam ─────────────────────────────────────────────────────────

test('the physics step never reads an input device', () => {
  const src = Game.prototype._updateHostPhysics.toString();
  for (const forbidden of ['this.input', 'document.', 'this.canvas', 'this.renderer', 'Sound.']) {
    assert.ok(!src.includes(forbidden), `_updateHostPhysics must not reference ${forbidden}`);
  }
});

test('applyInput sanitizes keys and rejects unknown/dead players', () => {
  const sim = Object.create(Game.prototype);
  const p = new Player('p1', 'P', 'sword', 0, 0);
  sim.players = { p1: p };

  // Junk from the wire is coerced; unknown fields are dropped entirely.
  assert.equal(sim.applyInput('p1', { d: 'yes', w: 1, hack: true }), true);
  assert.deepEqual(p.keys, {
    w: true, a: false, s: false, d: true,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
  });
  assert.ok(!('hack' in p.keys));

  assert.equal(sim.applyInput('nobody', { d: true }), false);
  p.isDead = true;
  assert.equal(sim.applyInput('p1', { d: true }), false);
});

test('applyAim installs a finite angle and rejects anything else', () => {
  const sim = Object.create(Game.prototype);
  const p = new Player('p1', 'P', 'sword', 0, 0);
  sim.players = { p1: p };

  assert.equal(sim.applyAim('p1', 1.25), true);
  assert.equal(p.angle, 1.25);

  assert.equal(sim.applyAim('p1', NaN), false);
  assert.equal(sim.applyAim('p1', undefined), false);
  assert.equal(sim.applyAim('nobody', 0), false);
  assert.equal(p.angle, 1.25, 'a rejected aim must not clobber the last good one');
});
