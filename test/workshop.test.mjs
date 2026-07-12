import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENVELOPE, POINT_BUDGET, clampWorkshopStats, statCost, enforceBudget,
  clampWorkshopWeapon, sanitizeText,
} from '../game/Workshop.js';

test('stats clamp into the envelope — no instakill, no machine-gun', () => {
  const s = clampWorkshopStats({ damage: 9999, cooldownMs: 1, maxHp: 99999, moveSpeed: 99, range: 99999 });
  assert.ok(s.damage <= ENVELOPE.damage[1], 'damage capped well below lethal');
  assert.ok(s.damage <= 55);                      // can never one-shot
  assert.ok(s.cooldownMs >= ENVELOPE.cooldownMs[0], 'cooldown floored');
  assert.ok(s.maxHp <= ENVELOPE.maxHp[1] && s.moveSpeed <= ENVELOPE.moveSpeed[1]);
  assert.ok(s.range <= ENVELOPE.range[1]);
});

test('garbage / missing stats → safe defaults', () => {
  for (const bad of [null, undefined, 42, { damage: 'x', cooldownMs: NaN }]) {
    const s = clampWorkshopStats(bad);
    assert.ok(Number.isFinite(s.damage) && s.damage >= ENVELOPE.damage[0]);
    assert.ok(Number.isFinite(s.cooldownMs) && s.cooldownMs >= ENVELOPE.cooldownMs[0]);
  }
});

test('point budget bleeds damage down when a weapon maxes everything', () => {
  const maxed = clampWorkshopStats({ damage: 55, cooldownMs: 250, maxHp: 160, moveSpeed: 1.35, range: 300, knockback: 200, status: 'bleed', statusDurationMs: 3000, statusIntensity: 1 });
  const before = statCost(maxed);
  const { stats, overBudget } = enforceBudget(maxed);
  assert.ok(before > POINT_BUDGET, 'a maxed build is over budget');
  assert.equal(overBudget, true);
  assert.ok(statCost(stats) <= POINT_BUDGET, 'budget enforced after');
  assert.ok(stats.damage < maxed.damage, 'damage was reduced to fit');
});

test('a balanced build is under budget and left intact', () => {
  const balanced = clampWorkshopStats({ damage: 20, cooldownMs: 700, maxHp: 100, moveSpeed: 1, range: 90, status: 'none' });
  const { stats, overBudget } = enforceBudget(balanced);
  assert.equal(overBudget, false);
  assert.equal(stats.damage, balanced.damage);
});

test('workshop hitboxes are clamped tighter than admin (count/size/area/window)', () => {
  const w = clampWorkshopWeapon({
    name: 'X', stats: { damage: 20 },
    motionSet: { attack: {
      duration: 0.5,
      keyframes: [{ t: 0, pose: { spine: -90 } }, { t: 1, pose: { spine: -90 } }],
      hitboxes: [
        { ox: 0, oy: 0, w: 9999, h: 9999, activeStart: 0, activeEnd: 1 },
        { ox: 10, oy: 0, w: 50, h: 50, activeStart: 0.2, activeEnd: 0.9 },
        ...Array.from({ length: 70 }, (_, i) => ({ ox: 20 + i, oy: 0, w: 50, h: 50, activeStart: 0, activeEnd: 1 })),
      ],
    } },
  });
  const hbs = w.motionSet.attack.hitboxes;
  assert.equal(hbs.length, 72, 'all valid hitboxes survive without a count cap');
  for (const hb of hbs) {
    assert.ok(hb.w <= ENVELOPE.hitboxDimMax && hb.h <= ENVELOPE.hitboxDimMax, 'dim capped');
    assert.ok(hb.w * hb.h <= ENVELOPE.hitboxAreaMax + 1, 'area capped');
    assert.ok(hb.activeEnd - hb.activeStart <= ENVELOPE.activeLenMax + 1e-9, 'active window capped');
  }
});

test('double clamp is idempotent (publish then host re-clamp)', () => {
  const once = clampWorkshopWeapon({ name: 'Cheaty', stats: { damage: 9999, cooldownMs: 1 }, motionSet: { attack: { duration: 0.4, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }], hitboxes: [{ ox: 0, oy: 0, w: 9999, h: 9999, activeStart: 0, activeEnd: 1 }] } } });
  const twice = clampWorkshopWeapon(once);
  assert.deepEqual(twice.stats, once.stats);
  assert.deepEqual(twice.motionSet.attack.hitboxes, once.motionSet.attack.hitboxes);
});

test('name/desc sanitized; weapon never throws on junk', () => {
  const w = clampWorkshopWeapon({ name: '  '.padEnd(60, 'A'), desc: 'd'.repeat(200), color: 'not-a-color' });
  assert.ok(w.name.length <= 24);
  assert.ok(w.desc.length <= 80);
  assert.equal(w.color, null);     // bad color rejected
  assert.equal(w.tier, 'workshop');
  assert.equal(sanitizeText(null), '');
});
