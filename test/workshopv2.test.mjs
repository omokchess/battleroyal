import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampWorkshopWeaponV2, migrateV1toV2, toWorkshopWeaponV2, makeEmptyWeaponV2, makeEmptyPreset,
  statCostV2, combatCost, sanitizeFlipKeys, sampleFlip, sanitizeProjectile, sanitizeEffects,
  POINT_BUDGET, PROJECTILE_IMAGES,
} from '../game/Workshop.js';

test('V1 → V2 migration moves fields to the right places', () => {
  const v1 = {
    name: '낡은검', desc: 'x', color: '#aabbcc',
    stats: { damage: 40, cooldownMs: 500, maxHp: 130, moveSpeed: 1.2, range: 120, knockback: 60, status: 'bleed', statusDurationMs: 1500, statusIntensity: 0.6 },
    motionSet: {
      attack: { duration: 0.4, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }], hitboxes: [{ ox: 40, oy: 0, w: 50, h: 44, activeStart: 0.3, activeEnd: 0.5 }] },
      dash: { duration: 0.3, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] },
      skill: { duration: 0.5, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] },
      run: { duration: 0.6, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }], hitboxes: [{ ox: 0, oy: 0, w: 40, h: 40 }] },
    },
    blocks: { events: [{ on: 'basicAttack', do: [{ op: 'spawnMelee', damagePct: 100 }] }] },
  };
  const w = migrateV1toV2(v1);
  assert.equal(w.schemaVersion, 2);
  // body stats only on the weapon
  assert.equal(w.baseStats.maxHp, 130);
  assert.equal(w.baseStats.moveSpeed, 1.2);
  assert.equal(w.baseStats.damage, undefined);
  // V1 combat stats → basic.combat
  assert.equal(w.presets.basic.combat.damage, 40);
  assert.equal(w.presets.basic.combat.range, 120);
  assert.equal(w.presets.basic.combat.status, 'bleed');
  // motions routed
  assert.ok(w.presets.basic.motion.keyframes.length);
  assert.ok(w.presets.dash, 'dash preset created');
  assert.ok(w.presets.skill1, 'skill → skill1');
  // attack hitboxes → basic.hitboxes; non-attack hitboxes dropped
  assert.equal(w.presets.basic.hitboxes.length, 1);
  assert.equal(w.presets.run.hitboxes.length, 0, 'run (non-combat) carries no hitboxes');
  // blocks → basic.blocks
  assert.ok(w.presets.basic.blocks && w.presets.basic.blocks.events.length);
  assert.equal(w.equippedPresetKey, 'basic');
});

test('toWorkshopWeaponV2 passes V2 through and migrates V1', () => {
  const v2 = makeEmptyWeaponV2({ name: 'A', category: 'ranged' });
  assert.equal(toWorkshopWeaponV2(v2).schemaVersion, 2);
  assert.equal(toWorkshopWeaponV2(v2).category, 'ranged');
  const migrated = toWorkshopWeaponV2({ stats: { damage: 20 }, motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } } });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.presets.basic.combat.damage, 20);
});

test('budget: cooldown is excluded and over-budget bleeds to ≤100', () => {
  const w = makeEmptyWeaponV2({ firstPresetKind: 'basic' });
  // Two identical combat costs: fast vs slow cooldown → same budget.
  const fast = { ...w, presets: { basic: { ...w.presets.basic, combat: { ...w.presets.basic.combat, cooldownMs: 250 } } } };
  const slow = { ...w, presets: { basic: { ...w.presets.basic, combat: { ...w.presets.basic.combat, cooldownMs: 2500 } } } };
  assert.equal(statCostV2(fast), statCostV2(slow), 'cooldown does not affect budget');
  // Max everything across all 6 combat presets → over budget → clamped ≤100.
  const maxed = clampWorkshopWeaponV2({
    schemaVersion: 2, baseStats: { maxHp: 160, moveSpeed: 1.35 },
    presets: Object.fromEntries(['basic', 'heavy', 'skill1', 'skill2', 'skill3'].map((k) => [k,
      { kind: k, motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 55, range: 300, knockback: 200, status: 'bleed', statusDurationMs: 3000 } }])),
  });
  assert.ok(statCostV2(maxed) <= POINT_BUDGET, `enforced ${statCostV2(maxed)} ≤ ${POINT_BUDGET}`);
});

test('flip keys sanitize: sorted, deduped (last wins), boolean, clamped', () => {
  const keys = sanitizeFlipKeys([
    { time: 0.6, value: 'yes' }, { time: 0, value: 0 }, { time: 0.3, value: 1 }, { time: 0.3, value: false }, { time: 99, value: true },
  ], 1);
  const times = keys.map((k) => k.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'sorted');
  assert.ok(times.every((t) => t <= 1), 'clamped to duration');
  assert.equal(keys.find((k) => k.time === 0.3).value, false, 'last write per time wins');
  assert.equal(typeof keys[0].value, 'boolean');
  // sampling is a step function
  assert.equal(sampleFlip([{ time: 0, value: false }, { time: 0.5, value: true }], 0.2), false);
  assert.equal(sampleFlip([{ time: 0, value: false }, { time: 0.5, value: true }], 0.7), true);
});

test('projectile sanitize: valid imageId + hitbox clamped + direction source', () => {
  const p = sanitizeProjectile({ imageId: 'nonsense', directionSource: 'weird', speed: 99999, hitbox: { shape: 'circle', radius: 9999, width: -5 } });
  assert.ok(PROJECTILE_IMAGES.includes(p.imageId), 'bad imageId → default arrow');
  assert.equal(p.imageId, 'arrow');
  assert.equal(p.directionSource, 'cursor', 'bad direction → default');
  assert.ok(p.speed <= 1200, 'speed clamped');
  assert.equal(p.hitbox.shape, 'circle');
  assert.ok(p.hitbox.radius <= 80 && p.hitbox.radius > 0, 'radius clamped, no huge screen-wide hit');
  assert.ok(p.hitbox.width >= 4, 'negative width fixed');
});

test('non-combat / dash presets carry no combat or hitboxes', () => {
  const run = makeEmptyPreset('run');
  assert.equal(run.combat, undefined);
  assert.equal(run.hitboxes.length, 0);
  const dash = makeEmptyPreset('dash');
  assert.equal(dash.combat, undefined);
  assert.equal(typeof dash.dashDistance, 'number');
  assert.equal(dash.ranged, false);
  const basic = makeEmptyPreset('basic');
  assert.ok(basic.combat, 'combat preset has combat');
  assert.equal(basic.ranged, false);
  assert.ok(basic.projectile, 'combat preset has a projectile config (used when ranged)');
});

test('effects sanitize: capped, followBone whitelisted, alpha 0..1', () => {
  const fx = sanitizeEffects([
    { time: 0.2, assetId: 'spark', alpha: 5, followBone: 'weaponTip' },
    { time: 0.1, assetId: 'boom', followBone: 'hacker' },
  ], 1);
  assert.equal(fx.length, 2);
  assert.equal(fx[0].time, 0.1, 'sorted by time');
  assert.ok(fx.every((e) => e.alpha >= 0 && e.alpha <= 1));
  assert.equal(fx.find((e) => e.assetId === 'boom').followBone, null, 'unknown bone → null');
});
