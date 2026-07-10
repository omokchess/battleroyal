/**
 * THE Phase 0 gate: the simulation core runs a real bot match in plain Node.
 *
 * No document, no window, no canvas, no renderer, no audio, no transport. If any
 * of that leaks back into GameSim, this file fails — which is the whole point of
 * extracting it, since the game server will run exactly this class.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GameSim } from '../game/sim/GameSim.js';
import { RecordingFx } from '../game/sim/Fx.js';
import { FixedClock } from '../game/sim/env.js';
import { makeEmptyWeaponV2, clampWorkshopWeaponV2 } from '../game/Workshop.js';
import { v2ToV1Runtime } from '../game/WorkshopStore.js';

test('the environment is headless (guards every assertion below)', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
});

/** Bots refuse to spawn without workshop weapons — a real prerequisite. */
function botWeapon(name) {
  const w = makeEmptyWeaponV2({ name, category: 'melee' });
  w.presets.basic.combat.damage = 22;
  w.presets.basic.hitboxes = [{ ox: 26, oy: 0, w: 56, h: 40, activeStart: 0.05, activeEnd: 0.45 }];
  return v2ToV1Runtime(clampWorkshopWeaponV2(w));
}

function newSim(opts = {}) {
  const clock = new FixedClock(1_000_000);
  const fx = new RecordingFx();
  const sim = new GameSim({
    seed: 4242,
    clock,
    botMatch: true,
    botCount: 3,
    botDifficulty: 'normal',
    botWorkshopWeapons: [botWeapon('a'), botWeapon('b')],
    roomConfig: { arenaSize: 'medium', platforms: 'some', allowWorkshop: true },
    matchDurationMs: 120_000,
    killTarget: 12,
    ...opts,
  });
  sim.fx = fx;
  return { sim, clock, fx };
}

test('GameSim builds a level and seats players + bots without a browser', () => {
  const { sim } = newSim();
  assert.ok(sim.level, 'a level is built in the constructor');
  assert.ok(sim.level.solids.length > 0);

  const me = sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });
  assert.equal(me.id, 'p1');
  assert.equal(sim.isAuthority, true);

  const bots = Object.values(sim.players).filter(p => p.isBot);
  assert.equal(bots.length, 3, 'bots spawned');
  assert.ok(bots.every(b => b.brain), 'each bot has a brain');
  assert.ok(bots.every(b => b.workshopWeapon), 'each bot got a workshop weapon');
});

test('a bot match actually simulates: bodies move, bots attack, effects fire', () => {
  const { sim, clock } = newSim();
  sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });

  const before = Object.fromEntries(Object.entries(sim.players).map(([id, p]) => [id, [p.x, p.y]]));

  // 3 seconds of simulation, driven entirely by the injected clock.
  for (let i = 0; i < 180; i++) {
    clock.advance(1000 / 60);
    sim.tick(1 / 60, sim.now());
  }

  const moved = Object.keys(before).filter(id => {
    const p = sim.players[id];
    return Math.abs(p.x - before[id][0]) > 0.5 || Math.abs(p.y - before[id][1]) > 0.5;
  });
  assert.ok(moved.length >= 2, `expected bodies to move, moved=${moved.length}`);

  const bots = Object.values(sim.players).filter(p => p.isBot);
  assert.ok(bots.some(b => b.lastAttackTime > 0), 'bots should swing');
  assert.ok(sim.effects.length > 0, 'the sim should raise visual effects');
});

test('the sim queues its snapshots instead of sending them (no transport)', () => {
  const { sim, clock } = newSim();
  sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });

  for (let i = 0; i < 60; i++) { clock.advance(1000 / 60); sim.tick(1 / 60, sim.now()); }

  const out = sim.drainOutbox();
  assert.ok(out.length > 0, 'GAME_STATE snapshots were queued');
  assert.ok(out.every(m => m && typeof m.type === 'string'));
  assert.deepEqual(sim.drainOutbox(), [], 'draining twice yields nothing');
});

test('input reaches a player only through applyInput/applyAim', () => {
  const { sim, clock } = newSim({ botMatch: false, botCount: 0 });
  const me = sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });
  me.x = 300; me.vx = 0;

  const x0 = me.x;
  for (let i = 0; i < 30; i++) { clock.advance(1000 / 60); sim.tick(1 / 60, sim.now()); }
  assert.ok(Math.abs(me.x - x0) < 1, 'no input -> no walking');

  sim.applyInput('p1', { d: true });
  sim.applyAim('p1', 0);
  for (let i = 0; i < 30; i++) { clock.advance(1000 / 60); sim.tick(1 / 60, sim.now()); }
  assert.ok(me.x > x0 + 20, 'walked right purely via applyInput');
});

test('the same seed replays the same match', () => {
  const run = () => {
    const { sim, clock } = newSim();
    sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });
    for (let i = 0; i < 120; i++) { clock.advance(1000 / 60); sim.tick(1 / 60, sim.now()); }
    return Object.entries(sim.players)
      .map(([id, p]) => `${id}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.hp}`)
      .sort()
      .join('|');
  };
  assert.equal(run(), run(), 'identical seeds must produce an identical match');
});

test('juice is raised through the sink, tagged by player — never played directly', () => {
  const { sim, clock, fx } = newSim();
  sim.beginMatch({ id: 'p1', nickname: 'Hero', weapon: 'sword' });
  for (let i = 0; i < 120; i++) { clock.advance(1000 / 60); sim.tick(1 / 60, sim.now()); }

  assert.ok(fx.calls.length > 0, 'the sim raised cues');
  const known = new Set(['sfx', 'attackSfx', 'shake', 'hitstop', 'vibrate', 'announce', 'killFeed', 'weaponApplied']);
  assert.ok(fx.calls.every(c => known.has(c.type)), 'only known cue types');
});
