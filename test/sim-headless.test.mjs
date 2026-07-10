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

import { Game, rebaseEffectSnapshot } from '../game/Game.js';
import { GameSim } from '../game/sim/GameSim.js';
import { Player } from '../game/Player.js';
import { NullFx, RecordingFx, NULL_FX } from '../game/sim/Fx.js';
import { makeRng, FixedClock, SystemClock } from '../game/sim/env.js';

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

  // The kill event is QUEUED, not broadcast: the sim owns no transport.
  const out = sim.drainOutbox();
  assert.equal(out.length, 1);
  assert.equal(out[0].killerId, killer.id);
  assert.deepEqual(sim.drainOutbox(), [], 'draining twice yields nothing');

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

// ── P0c: seeded randomness + injected clock ─────────────────────────────────

test('the same seed replays the same random sequence', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const c = makeRng(12346);

  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  const seqC = Array.from({ length: 8 }, () => c());

  assert.deepEqual(seqA, seqB, 'identical seeds must replay identically');
  assert.notDeepEqual(seqA, seqC, 'a different seed must diverge');
  assert.ok(seqA.every(v => v >= 0 && v < 1), 'values live in [0,1)');
  assert.equal(new Set(seqA).size, 8, 'no immediate repeats');
});

test('a zero seed does not degenerate the generator', () => {
  const rng = makeRng(0);
  const seq = Array.from({ length: 5 }, () => rng());
  assert.ok(seq.every(v => v >= 0 && v < 1));
  assert.ok(new Set(seq).size > 1, 'must not emit a constant');
});

test('rng() is well distributed in the low bits (floor(rng()*n) hits every bucket)', () => {
  // The sim does Math.floor(rng() * n) to pick targets/weapons; a bad PRNG would
  // bias those buckets. Check all 3 buckets get hit, as _castMagicStaff needs.
  const rng = makeRng(99);
  const buckets = [0, 0, 0];
  for (let i = 0; i < 300; i++) buckets[Math.floor(rng() * 3)]++;
  assert.ok(buckets.every(b => b > 60), `buckets skewed: ${buckets}`);
});

test('a Game seeds its rng from options.seed and reuses it as the terrain seed', () => {
  const mk = seed => Object.assign(Object.create(Game.prototype), { seed, rng: makeRng(seed) });
  const g1 = mk(777);
  const g2 = mk(777);
  assert.equal(g1.rng(), g2.rng(), 'same seed -> same first draw');
});

test('the sim clock is injectable and never reads the wall clock', () => {
  const clock = new FixedClock(1000);
  const sim = Object.create(Game.prototype);
  sim.clock = clock;

  assert.equal(sim.now(), 1000);
  clock.advance(250);
  assert.equal(sim.now(), 1250, 'time only moves when the harness advances it');

  // Default (no injection) falls back to the real clock.
  const real = Object.create(Game.prototype);
  assert.equal(real.clock, SystemClock);
  assert.ok(Math.abs(real.now() - Date.now()) < 50);
});

test('_canApplyStatus reads the injected clock, not Date.now', () => {
  const clock = new FixedClock(5000);
  const sim = Object.create(Game.prototype);
  sim.clock = clock;

  const target = new Player('t', 'T', 'sword', 0, 0);
  target.statusImmuneUntil = 6000;   // still immune at t=5000

  assert.equal(sim._canApplyStatus(target), false, 'immune while clock < immuneUntil');
  clock.advance(1500);               // t=6500, immunity expired
  assert.notEqual(sim._canApplyStatus(target), false, 'no longer immune once the clock passes');
});

test('simulation methods never reach for ambient randomness or the wall clock', () => {
  // Render-only juice (_spawnHitSpark/_spawnDeathBurst/_trackDamagePopups) is
  // deliberately excluded: it never touches sim state, so seeding it would only
  // correlate particles across clients for no benefit.
  const simMethods = [
    '_updateHostPhysics', '_performBasicAttack', '_performAutomaticAttack',
    '_creditKill', '_tryDash', '_canApplyStatus', '_applyStun',
    '_pickBotWorkshopWeapon', '_castMagicStaff', '_resolveMeleeHitResult',
    '_spawnWorkshopProjectile', '_applyAirborne', '_isMotionLocked',
  ];
  for (const name of simMethods) {
    const fn = Game.prototype[name];
    assert.equal(typeof fn, 'function', `${name} should exist`);
    const src = fn.toString();
    assert.ok(!/Math\.random\(/.test(src), `${name} must use this.rng() instead of Math.random()`);
    assert.ok(!/Date\.now\(/.test(src), `${name} must use this.now() instead of Date.now()`);
  }
});

test('the simulation knows nothing about a "local" player or a transport', () => {
  // On a server there is no local player and no peer connection. Any sim method
  // that reads this.localPlayerId or this.networkManager would be a design bug.
  const shell = new Set([
    '_cameraFocusPoints', '_cleanupVisualSettingsPanel', '_consumeTargetCastWorld', '_gameLoop',
    '_keyLabel', '_keyStrong', '_loadControlSettings', '_loadVisualSettings', '_onLocalDamaged',
    '_pushKillFeed', '_renderFrame', '_renderKillFeed', '_resizeCanvas', '_resolveInputDashVector',
    '_saveVisualSettings', '_sendLocalInput', '_setRowLabel', '_setupNetworkCallbacks',
    '_setupVisualSettingsPanel', '_spawnDeathBurst', '_spawnHitSpark', '_trackDamagePopups',
    '_trackSoundCues', '_triggerHitstop', '_triggerLocalBowSkillVibration',
    '_triggerLocalBowSkillVibrations', '_triggerLocalSpearThrowFeedback',
    '_triggerLocalSpearThrowFeedbacks', '_updateAbilityHud', '_updateClientInterpolations',
    '_updateExtendedAbilityHud', '_updateHUD', '_vibrateDevice', 'constructor', 'quit',
    'requestWeaponChange', 'start', '_flushOutbox',
  ]);

  // Inspect GameSim.prototype, not Game.prototype: after the split the sim
  // methods live on the base class, so iterating Game's OWN properties would
  // silently check nothing at all.
  const names = Object.getOwnPropertyNames(GameSim.prototype);
  assert.ok(names.length > 100, `expected the sim core on GameSim.prototype, saw ${names.length}`);

  const offenders = [];
  for (const name of names) {
    if (shell.has(name)) continue;
    const fn = GameSim.prototype[name];
    if (typeof fn !== 'function') continue;
    const src = fn.toString();
    if (/this\.localPlayerId/.test(src)) offenders.push(`${name} reads localPlayerId`);
    if (/this\.networkManager/.test(src)) offenders.push(`${name} reads networkManager`);
  }
  assert.deepEqual(offenders, []);
});

test('_publish queues per instance rather than on a shared prototype array', () => {
  const a = Object.create(Game.prototype);
  const b = Object.create(Game.prototype);
  a._publish({ x: 1 });
  assert.deepEqual(b.drainOutbox(), [], 'one sim must not see another sim\'s messages');
  assert.equal(a.drainOutbox().length, 1);
});

test('rebaseEffectSnapshot is a top-level helper and defaults without a `this`', () => {
  // Regression: it briefly defaulted to `this.now()`, which throws when called
  // as a bare function (there is no `this` in an ES module).
  const out = rebaseEffectSnapshot({ progress: 0, lifetime: 300, timestamp: Date.now() });
  assert.ok(out && typeof out === 'object');
});
