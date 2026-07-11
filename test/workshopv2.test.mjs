import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampWorkshopWeaponV2, migrateV1toV2, toWorkshopWeaponV2, makeEmptyWeaponV2, makeEmptyPreset,
  statCostV2, combatCost, sanitizeCombat, sanitizeCombatKeys, sampleCombatKeys, sanitizeFlipKeys, sampleFlip, sanitizeProjectile, sanitizeProjectileEvents, sanitizeTeleportEvents, sanitizeEffects, sampleEffectTransform,
  POINT_BUDGET, PROJECTILE_IMAGES, FIXED_PRESET_DURATIONS, AUTHORING_PRESET_KEYS,
} from '../game/Workshop.js';
import { v2ToV1Runtime } from '../game/WorkshopStore.js';

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
  assert.ok(w.baseStats.moveSpeed <= 1.2);
  assert.ok(statCostV2(w) <= POINT_BUDGET, 'migrated legacy weapon is clamped to the stronger budget');
  assert.equal(w.baseStats.damage, undefined);
  // V1 combat stats → basic.combat
  assert.equal(w.presets.basic.combat.damage, 40);
  assert.equal(w.presets.basic.combat.range, 0);
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

test('V2 weapons always expose every authoring preset and drop the removed kill preset', () => {
  const fresh = makeEmptyWeaponV2({ name: '전체 프리셋' });
  for (const key of AUTHORING_PRESET_KEYS) assert.ok(fresh.presets[key], `${key} preset exists`);
  assert.equal(fresh.presets.kill, undefined);

  const clamped = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: {
      basic: { ...makeEmptyPreset('basic'), complete: true },
      kill: { kind: 'kill', motion: { keyframes: [{ t: 0, pose: {} }] }, complete: true },
    },
  });
  for (const key of AUTHORING_PRESET_KEYS) assert.ok(clamped.presets[key], `${key} preset filled`);
  assert.equal(clamped.presets.basic.complete, true);
  assert.equal(clamped.presets.kill, undefined);
});

test('budget: cooldown is included and over-budget bleeds to ≤100 per section', () => {
  const w = makeEmptyWeaponV2({ firstPresetKind: 'basic' });
  const neutral = combatCost({ damage: 0, cooldownMs: 600, knockback: 60, status: 'none', ultimateGain: 10 });
  const faster = combatCost({ damage: 0, cooldownMs: 300, knockback: 60, status: 'none', ultimateGain: 10 });
  const slower = combatCost({ damage: 0, cooldownMs: 1100, knockback: 60, status: 'none', ultimateGain: 10 });
  assert.equal(neutral, 0, '600ms cooldown is budget-neutral');
  assert.equal(faster - neutral, 3, '100ms faster cooldown costs 1 budget');
  assert.equal(slower - neutral, -1, '500ms slower cooldown refunds 1 budget');
  // Faster cooldown costs more budget.
  const fast = { ...w, presets: { basic: { ...w.presets.basic, combat: { ...w.presets.basic.combat, cooldownMs: 250 } } } };
  const slow = { ...w, presets: { basic: { ...w.presets.basic, combat: { ...w.presets.basic.combat, cooldownMs: 2500 } } } };
  assert.ok(statCostV2(fast) > statCostV2(slow), 'cooldown affects budget');
  // Max everything across all combat presets → over budget → clamped ≤100.
  const maxed = clampWorkshopWeaponV2({
    schemaVersion: 2, baseStats: { maxHp: 160, moveSpeed: 1.35 },
    presets: Object.fromEntries(['basic', 'heavy', 'skill1', 'skill2', 'skill3', 'ultimate'].map((k) => [k,
      { kind: k, motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 60, cooldownMs: 250, knockback: 200, status: 'bleed', statusDurationMs: 3000 } }])),
  });
  assert.ok(statCostV2(maxed) <= POINT_BUDGET, `enforced ${statCostV2(maxed)} ≤ ${POINT_BUDGET}`);
});

test('ultimate has no cooldown and allows 100 damage at one budget per damage', () => {
  const ultimate = sanitizeCombat({ damage: 100, cooldownMs: 250 }, 'ultimate');
  assert.equal(ultimate.damage, 100);
  assert.equal(ultimate.cooldownMs, 0);
  assert.equal(combatCost({ ...ultimate, knockback: 60, status: 'none' }, 'ultimate'), 100);
});

test('skill ultimate gain is clamped in 5-point steps and costs budget', () => {
  const base = combatCost({ damage: 10, cooldownMs: 1000, knockback: 60, status: 'none', ultimateGain: 10 });
  const high = combatCost({ damage: 10, cooldownMs: 1000, knockback: 60, status: 'none', ultimateGain: 35 });
  assert.equal(high - base, Math.round(15 * 1.5), '25 extra gain costs 15 budget before multiplier');
  assert.equal(sanitizeCombat({ ultimateGain: 34 }).ultimateGain, 35);
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: { skill1: { kind: 'skill1', motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 0, cooldownMs: 2500, knockback: 60, ultimateGain: 35 } } },
  });
  assert.ok(statCostV2(w) <= POINT_BUDGET, 'ultimate gain participates in budget enforcement');
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

test('airborne status and weapon hand timelines survive V2 clamp and runtime export', () => {
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    name: '에어본검',
    presets: {
      skill3: {
        kind: 'skill3',
        motion: { duration: 0.8, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] },
        weaponTimeline: {
          flipXKeys: [{ time: 0.15, value: true }],
          flipYKeys: [{ time: 0.2, value: true }],
          leftFlipXKeys: [{ time: 0.25, value: true }],
          leftFlipYKeys: [{ time: 0.3, value: true }],
          handSwapKeys: [{ time: 0.25, value: true }, { time: 0.75, value: false }],
        },
        combat: { damage: 10, cooldownMs: 10000, knockback: 60, status: 'airborne', statusDurationMs: 500, airborneHeight: 180 },
      },
    },
  });
  assert.equal(w.presets.skill3.label, '스킬 3');
  assert.equal(w.presets.skill3.combat.status, 'airborne');
  assert.equal(w.presets.skill3.combat.airborneHeight, 180);
  assert.equal(w.presets.skill3.weaponTimeline.handSwapKeys.length, 2);
  assert.equal(w.presets.skill3.weaponTimeline.leftFlipXKeys.length, 1);
  assert.equal(w.presets.skill3.weaponTimeline.leftFlipYKeys.length, 1);
  const rt = v2ToV1Runtime(w);
  assert.equal(rt.presetCombat.skill3.status, 'airborne');
  assert.equal(rt.presetCombat.skill3.airborneHeight, 180);
  assert.equal(rt.motionSet.skill3.flipXKeys.length, 1);
  assert.equal(rt.motionSet.skill3.flipYKeys.length, 1);
  assert.equal(rt.motionSet.skill3.leftFlipXKeys.length, 1);
  assert.equal(rt.motionSet.skill3.leftFlipYKeys.length, 1);
  assert.equal(rt.motionSet.skill3.handSwapKeys.length, 2);
});

test('ultimate preset is separate from skill3 and exports to the ultimate runtime slot', () => {
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: {
      skill3: { kind: 'skill3', displayName: '돌진 찌르기', motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 12, cooldownMs: 900 } },
      ultimate: { kind: 'ultimate', displayName: '천둥 참격', motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 45, cooldownMs: 3000 } },
    },
  });
  assert.equal(w.presets.skill3.label, '스킬 3');
  assert.equal(w.presets.skill3.displayName, '돌진 찌르기');
  assert.equal(w.presets.ultimate.label, '궁극기');
  const rt = v2ToV1Runtime(w);
  assert.ok(rt.presetCombat.skill3, 'R skill remains skill3');
  assert.ok(rt.presetCombat.ultimate, 'Y ultimate uses its own slot');
  assert.equal(rt.presetNames.skill3, '돌진 찌르기');
  assert.equal(rt.presetNames.ultimate, '천둥 참격');
  assert.ok(rt.motionSet.skill3, 'skill3 motion exported');
  assert.ok(rt.motionSet.ultimate, 'ultimate motion exported');
});

test('combat preset controls can vary by authored frame and export to runtime', () => {
  const w = clampWorkshopWeaponV2({
    name: '프레임 조절 검',
    presets: {
      basic: {
        kind: 'basic',
        motion: { duration: 1, keyframes: [{ t: 0, pose: {} }, { t: 0.5, pose: {} }, { t: 1, pose: {} }] },
        combat: { damage: 10, cooldownMs: 800, knockback: 20, status: 'none' },
        combatKeys: [
          { time: 0, combat: { damage: 10, cooldownMs: 800, knockback: 20, status: 'none' } },
          { time: 0.5, combat: { damage: 32, cooldownMs: 800, knockback: 80, status: 'stun', statusDurationMs: 200 } },
        ],
      },
    },
  });
  assert.equal(w.presets.basic.combatKeys.length, 2);
  assert.equal(sampleCombatKeys(w.presets.basic.combatKeys, w.presets.basic.combat, 0.25).damage, 10);
  assert.equal(sampleCombatKeys(w.presets.basic.combatKeys, w.presets.basic.combat, 0.5).damage, 32);
  assert.equal(sampleCombatKeys(w.presets.basic.combatKeys, w.presets.basic.combat, 0.9).status, 'stun');
  const rt = v2ToV1Runtime(w);
  assert.equal(rt.motionSet.attack.combatKeys.length, 2);
  assert.equal(sampleCombatKeys(rt.motionSet.attack.combatKeys, rt.stats, 0.5).knockback, 80);
});

test('projectile sanitize: valid imageId + hitbox clamped + direction source', () => {
  const p = sanitizeProjectile({ imageId: 'nonsense', directionSource: 'weird', angle: 999, rotation: 999, speed: 99999, hitbox: { shape: 'circle', radius: 9999, width: -5 } });
  assert.ok(PROJECTILE_IMAGES.includes(p.imageId), 'bad imageId → default arrow');
  assert.equal(p.imageId, 'arrow');
  assert.equal(p.directionSource, 'cursor', 'bad direction → default');
  assert.equal(p.angle, 360, 'fixed angle clamped to editor range');
  assert.equal(p.rotation, 180, 'image rotation clamped to editor range');
  assert.ok(p.speed <= 1200, 'speed clamped');
  assert.equal(p.hitbox.shape, 'circle');
  assert.ok(p.hitbox.radius <= 80 && p.hitbox.radius > 0, 'radius clamped, no huge screen-wide hit');
  assert.ok(p.hitbox.width >= 4, 'negative width fixed');
});

test('preset motion duration survives V2 clamp', () => {
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: {
      basic: {
        ...makeEmptyPreset('basic'),
        motion: { duration: 12.34, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] },
      },
    },
  });
  assert.equal(w.presets.basic.motion.duration, 12.34);
});

test('movement and hit-reaction preset durations are fixed to gameplay timing', () => {
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: {
      dash: { ...makeEmptyPreset('dash'), motion: { duration: 9, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] } },
      run: { ...makeEmptyPreset('run'), motion: { duration: 9, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] } },
      jump: { ...makeEmptyPreset('jump'), motion: { duration: 9, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] } },
      hurt: { ...makeEmptyPreset('hurt'), motion: { duration: 9, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] } },
      basic: { ...makeEmptyPreset('basic'), motion: { duration: 2.5, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] } },
    },
  });
  assert.equal(w.presets.dash.motion.duration, FIXED_PRESET_DURATIONS.dash);
  assert.equal(w.presets.run.motion.duration, FIXED_PRESET_DURATIONS.run);
  assert.equal(w.presets.jump.motion.duration, FIXED_PRESET_DURATIONS.jump);
  assert.equal(w.presets.hurt.motion.duration, FIXED_PRESET_DURATIONS.hurt);
  assert.equal(w.presets.basic.motion.duration, 2.5);
});

test('projectile sanitize preserves custom image ids', () => {
  const id = 'custom:' + 'p'.repeat(72);
  const p = sanitizeProjectile({ imageId: id, speed: 400 });
  assert.equal(p.imageId, id);
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

test('heavy preset stores combo count and exports runtime heavyAfter', () => {
  const heavy = makeEmptyPreset('heavy');
  assert.equal(heavy.comboAfter, 3, 'default keeps the old 3-hit combo behavior');
  const w = clampWorkshopWeaponV2({
    ...makeEmptyWeaponV2({ firstPresetKind: 'basic' }),
    presets: {
      basic: makeEmptyPreset('basic'),
      heavy: {
        ...heavy,
        comboAfter: 5,
        hitboxes: [{ ox: 30, oy: 0, w: 40, h: 30, frameTime: 0.5, activeStart: 0.48, activeEnd: 0.52 }],
      },
    },
  });
  assert.equal(w.presets.heavy.comboAfter, 5);
  assert.equal(w.presets.heavy.hitboxes[0].frameTime, 0.5);
  const rt = v2ToV1Runtime(w);
  assert.equal(rt.heavyAfter, 5);
  assert.equal(rt.presetHitboxes.heavy[0].frameTime, 0.5);
});

test('hitbox frame damage survives V2 clamp and runtime export', () => {
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    presets: {
      basic: {
        ...makeEmptyPreset('basic'),
        combat: { damage: 60, cooldownMs: 1000, knockback: 60 },
        hitboxes: [
          { ox: 30, oy: 0, w: 40, h: 30, frameTime: 0.25, activeStart: 0.23, activeEnd: 0.27, damage: 3 },
          { ox: 30, oy: 0, w: 40, h: 30, frameTime: 0.75, activeStart: 0.73, activeEnd: 0.77 },
        ],
      },
    },
  });
  assert.equal(w.presets.basic.hitboxes[0].damage, 3);
  assert.equal(w.presets.basic.hitboxes[1].damage, undefined);
  const rt = v2ToV1Runtime(w);
  assert.equal(rt.motionSet.attack.hitboxes[0].damage, 3);
});

test('effects sanitize into independent per-frame transforms', () => {
  const fx = sanitizeEffects([
    { time: 0.2, endTime: 0.4, assetId: 'custom:fx_abc', alpha: 5, followBone: 'weaponTip', flipX: true, flipY: true },
    { time: 0.1, assetId: 'boom', followBone: 'hacker' },
  ], 1);
  assert.equal(fx.length, 2);
  assert.equal(fx[0].time, 0.1, 'sorted by time');
  assert.ok(fx.every((e) => e.alpha >= 0 && e.alpha <= 1));
  assert.equal(fx.find((e) => e.assetId === 'custom:fx_abc').endTime, 0.4);
  assert.equal(fx.find((e) => e.assetId === 'custom:fx_abc').flipX, true);
  assert.equal(fx.find((e) => e.assetId === 'custom:fx_abc').flipY, true);
  assert.equal('followBone' in fx.find((e) => e.assetId === 'boom'), false, 'attachment data is removed');
  const keyed = sanitizeEffects([{ time: 0.2, endTime: 0.6, keys: [
    { time: 0.2, x: 0, scaleX: 1, scaleY: 2, rotation: 0, flipX: false },
    { time: 0.6, x: 40, scaleX: 2, scaleY: 4, rotation: 90, flipX: true },
  ] }])[0];
  const mid = sampleEffectTransform(keyed, 0.4);
  assert.ok(Math.abs(mid.x - 20) < 1e-9);
  assert.equal(mid.scaleX, 1.5);
  assert.equal(mid.scaleY, 3);
  assert.ok(Math.abs(mid.rotation - 45) < 1e-9);
  assert.equal(mid.flipX, false, 'flip changes on its authored key, not midway');
});

test('frame events sanitize: projectiles capped to 5 and teleports clamped', () => {
  const shots = sanitizeProjectileEvents(Array.from({ length: 8 }, (_, i) => ({
    time: 1 - i * 0.1,
    projectile: { imageId: 'bolt', speed: 99999, hitbox: { shape: 'circle', radius: 999 } },
  })));
  assert.equal(shots.length, 5);
  assert.deepEqual(shots.map(e => e.time), [...shots.map(e => e.time)].sort((a, b) => a - b));
  assert.ok(shots.every(e => e.projectile.speed <= 1200));

  const teleports = sanitizeTeleportEvents([{ time: 2, directionSource: 'hacked', distance: 9999 }]);
  assert.equal(teleports[0].time, 1);
  assert.equal(teleports[0].directionSource, 'cursor');
  assert.equal(teleports[0].distance, 260);
});

test('V2 weaponVisual keeps long custom image ids', () => {
  const id = 'custom:' + 'a'.repeat(80);
  const offhandId = 'custom:' + 'b'.repeat(80);
  const offhandAnchors = { gx: 0.22, gy: 0.62, tx: 0.88, ty: 0.38 };
  const hats = Array.from({ length: 7 }, (_, i) => ({
    imageId: `custom:hat${i}`,
    name: `모자${i}`,
    scale: 1 + i * 0.1,
    offsetX: i * 2,
    offsetY: -18 - i,
    alpha: 1 - i * 0.1,
    rotation: i * 12,
    anchorX: 0.25,
    anchorY: 0.75,
    anchors: { gx: 0.3, gy: 0.7, tx: 0.8, ty: 0.2 },
    layer: i % 2 ? 'overWeapon' : 'behindPlayer',
    showHandles: i !== 2,
    keys: [{ t: 0.5, offsetX: 10 + i, offsetY: -10 - i, rotation: 30 + i, scale: 1.5, alpha: 0.8 }],
  }));
  const w = clampWorkshopWeaponV2({
    schemaVersion: 2,
    weaponVisual: {
      imageId: id,
      scale: 2,
      dual: true,
      offhand: { imageId: offhandId, scale: 2.5, anchors: offhandAnchors },
      hats,
      selectedHat: 4,
      layerOrder: ['hat:0', 'player', 'weapon:left', 'hat:1', 'weapon:right', 'hat:2', 'hat:3', 'hat:4'],
    },
    presets: { basic: makeEmptyPreset('basic') },
  });
  assert.equal(w.weaponVisual.imageId, id);
  assert.equal(w.weaponVisual.dual, true);
  assert.equal(w.weaponVisual.offhand.imageId, offhandId);
  assert.equal(w.weaponVisual.offhand.scale, 2.5);
  assert.deepEqual(w.weaponVisual.offhand.anchors, offhandAnchors);
  assert.equal(w.weaponVisual.hats.length, 5);
  assert.equal(w.weaponVisual.hat.imageId, 'custom:hat0');
  assert.equal(w.weaponVisual.hats[4].imageId, 'custom:hat4');
  assert.equal(w.weaponVisual.hats[4].offsetY, -22);
  assert.equal(w.weaponVisual.hats[4].rotation, 48);
  assert.equal(w.weaponVisual.hats[4].anchorX, 0.25);
  assert.deepEqual(w.weaponVisual.hats[4].anchors, { gx: 0.3, gy: 0.7, tx: 0.8, ty: 0.2 });
  assert.equal(w.weaponVisual.hats[4].layer, 'behindPlayer');
  assert.equal(w.weaponVisual.hats[2].showHandles, false);
  assert.equal(w.weaponVisual.hats[4].keys[0].rotation, 34);
  assert.equal(w.weaponVisual.selectedHat, 4);
  assert.deepEqual(w.weaponVisual.layerOrder, ['hat:0', 'player', 'weapon:left', 'hat:1', 'weapon:right', 'hat:2', 'hat:3', 'hat:4']);
});
