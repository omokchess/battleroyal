import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Player } from '../game/Player.js';
import { Collision } from '../game/Collision.js';
import { SkillConfig, DashConfig, Weapons, AuxSkillConfig } from '../game/Weapons.js';
import { Game, rebaseEffectSnapshot } from '../game/Game.js';
import { PHYS } from '../game/Level.js';

function combatGame() {
  const game = Object.create(Game.prototype);
  game.players = {};
  game.projectiles = [];
  game.effects = [];
  game.pendingMeleeHits = [];
  game.pendingSwordWaves = [];
  game.mapWidth = 700;
  game.mapHeight = 700;
  game._creditKill = () => {};
  game._runWorkshopSwingEvents = () => {};
  game._terrainBlocksSegment = () => false;
  game._displace = (p, dx, dy) => { p.x += dx || 0; p.y += dy || 0; };
  game._awardUltimateGauge = () => {};
  game._applyStatusEffect = () => {};
  game._triggerHitstop = () => {};
  return game;
}

function botSpawnGame(botWorkshopWeapons = []) {
  const game = Object.create(Game.prototype);
  game.players = {};
  game._bots = [];
  game._botSeq = 0;
  game.botWorkshopWeapons = botWorkshopWeapons;
  game._getRandomSpawnPoint = () => ({ x: 100, y: 120 });
  return game;
}

test('bots fall back to sword/greatsword when no workshop pool exists', () => {
  const empty = botSpawnGame([]);
  empty._spawnBots(2, 'normal');
  const fallbackBots = Object.values(empty.players);
  assert.equal(fallbackBots.length, 2);
  assert.equal(empty._bots.length, 2);
  assert.deepEqual(new Set(fallbackBots.map(p => p.weapon)), new Set(['sword', 'greatsword']));

  const weapon = {
    id: 'ws-bot-blade',
    name: '봇 공방검',
    stats: { damage: 18, cooldownMs: 640, maxHp: 133, moveSpeed: 1.2, knockback: 40 },
    motionSet: {
      attack: {
        duration: 0.4,
        keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }],
        hitboxes: [{ ox: 35, oy: 0, w: 50, h: 30, activeStart: 0.2, activeEnd: 0.35, frameTime: 0.25 }]
      }
    }
  };
  const game = botSpawnGame([weapon]);
  game._spawnBots(3, 'normal');
  const bots = Object.values(game.players);
  assert.equal(bots.length, 3);
  assert.equal(game._bots.length, 3);
  for (const bot of bots) {
    assert.ok(bot.isBot);
    assert.equal(bot.workshopWeapon.name, '봇 공방검');
    assert.equal(bot.maxHp, 133);
  }
});

test('dash grants i-frames and bursts the player along the held direction', () => {
  const p = new Player('p1', 'Dasher', 'sword', 100, 100);

  assert.equal(p.startDash(1, 0), true);
  assert.equal(p.isInvincible(), true);

  const dt = PHYS.dashMs / 1000;
  p.updatePosition(dt, {}, null);
  assert.ok(Math.abs(p.x - (100 + PHYS.dashSpeed * dt)) < 1, `x=${p.x}`);
  assert.equal(p.isInvincible(), true);
});

test('an invincible player ignores damage', () => {
  const p = new Player('p2', 'Ghost', 'sword', 0, 0);
  p.startDash(1, 0);
  assert.equal(p.takeDamage(50), false);
  assert.equal(p.hp, p.maxHp);
});

test('dash is gated by its cooldown', () => {
  const p = new Player('p3', 'Spammer', 'sword', 0, 0);
  assert.equal(p.startDash(1, 0), true);
  p.updatePosition(DashConfig.durationMs / 1000, {}, 1000, 1000);
  assert.equal(p.startDash(1, 0), false);
});

test('workshop frame hitboxes split preset damage across authored hitboxes', () => {
  const game = combatGame();
  const attacker = new Player('atk', 'Maker', 'sword', 100, 100);
  const target = new Player('tar', 'Target', 'sword', 130, 100);
  attacker.angle = 0;
  attacker.workshopWeapon = { stats: { damage: 10 } };
  game.players[attacker.id] = attacker;
  game.players[target.id] = target;

  game._startHitboxSwing(attacker, {
    duration: 1,
    hitboxes: [
      { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.2 },
      { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.6 },
    ],
  }, 1000, { damage: 10 });

  game._updateHitboxSwings(1200);
  assert.equal(target.hp, target.maxHp - 5);
  game._updateHitboxSwings(1210);
  assert.equal(target.hp, target.maxHp - 5, 'same frame hitbox does not tick repeatedly');
  game._updateHitboxSwings(1600);
  assert.equal(target.hp, target.maxHp - 10, 'all authored hitboxes together preserve the preset damage');
});

test('workshop frame hitboxes can override damage per authored frame', () => {
  const game = combatGame();
  const attacker = new Player('atk', 'Maker', 'sword', 100, 100);
  const target = new Player('tar', 'Target', 'sword', 130, 100);
  attacker.angle = 0;
  attacker.workshopWeapon = { stats: { damage: 60 } };
  game.players[attacker.id] = attacker;
  game.players[target.id] = target;

  game._startHitboxSwing(attacker, {
    duration: 1,
    hitboxes: [
      { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.2, damage: 3 },
      { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.6, damage: 14 },
    ],
  }, 1000, { damage: 60 });

  game._updateHitboxSwings(1200);
  assert.equal(target.hp, target.maxHp - 3);
  game._updateHitboxSwings(1600);
  assert.equal(target.hp, target.maxHp - 17);
});

test('one skill activation awards ultimate gauge only on its first hitbox hit', () => {
  const game = combatGame();
  let awards = 0;
  game._awardUltimateGauge = () => { awards++; };
  const attacker = new Player('atk', 'Maker', 'sword', 100, 100);
  const target = new Player('tar', 'Target', 'sword', 130, 100);
  attacker.angle = 0;
  attacker.workshopWeapon = { stats: { damage: 20 } };
  game.players[attacker.id] = attacker;
  game.players[target.id] = target;
  game._startHitboxSwing(attacker, { duration: 1, hitboxes: [
    { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.2 },
    { ox: 30, oy: 0, w: 60, h: 40, frameTime: 0.6 },
  ] }, 1000, { damage: 20, ultimateGain: 25, presetKind: 'skill1' });
  game._updateHitboxSwings(1200);
  game._updateHitboxSwings(1600);
  assert.equal(awards, 1);
});

test('motion-only workshop ultimate still starts its authored animation', () => {
  const game = combatGame();
  game._isMotionLocked = () => false;
  const player = new Player('ult', 'Maker', 'sword', 100, 100);
  const motion = { duration: 0.8, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }] };
  player.workshopWeapon = {
    presetCombat: { ultimate: { damage: 0, cooldownMs: 0, knockback: 0, status: 'none' } },
    presetHitboxes: { ultimate: [] },
    motionSet: { ultimate: motion },
  };
  game.players[player.id] = player;
  player.ultimateGauge = 100;

  game._handleUltimatePressed(player, 1000);

  assert.equal(player.ultimateGauge, 0);
  assert.equal(player.attackMotionTag, 'ultimate');
  assert.equal(player.lastAttackMotionTag, 'ultimate');
  assert.equal(player.lastAttackTime, 1000);
  assert.equal(player._hbSwing.durMs, 800);
});

test('heavy combo fires after the configured number of basic attacks', () => {
  const game = combatGame();
  game._isMotionLocked = () => false;
  game._canonicalHitboxMotion = () => ({ duration: 0.2, hitboxes: [{ ox: 1, oy: 0, w: 10, h: 10, frameTime: 0.5 }] });
  const tags = [];
  game._startHitboxSwing = (_p, _m, _now, opts = {}) => tags.push(opts.motionTag || 'basic');
  const player = {
    id: 'combo', weapon: 'sword', buffType: null, canAttack: () => true,
    workshopWeapon: {
      stats: { damage: 10 }, heavyAfter: 3,
      presetCombat: { heavy: { damage: 20, knockback: 0, status: 'none', cooldownMs: 600 } },
      presetHitboxes: { heavy: [{ ox: 1, oy: 0, w: 10, h: 10, frameTime: 0.5 }] },
      motionSet: { heavy: { duration: 0.3, hitboxes: [{ ox: 1, oy: 0, w: 10, h: 10, frameTime: 0.5 }] } },
    },
  };
  for (let i = 0; i < 4; i++) game._performBasicAttack(player, Weapons.sword, 1000 + i * 200);
  assert.deepEqual(tags, ['basic', 'basic', 'basic', 'heavy']);
});

test('workshop skill activation shows the authored skill name beside the caster', () => {
  const game = combatGame();
  game._isMotionLocked = () => false;
  const player = new Player('caster', 'Maker', 'sword', 100, 100);
  player.workshopWeapon = {
    name: '이름검',
    presetCombat: { skill: { damage: 10, cooldownMs: 1000, knockback: 0, status: 'none' } },
    presetNames: { skill: '번개 베기' },
    motionSet: {}
  };

  assert.equal(game._activateWorkshopSkill(player, 'skill', 1000), true);
  assert.equal(player.wsSkillCd.skill, 1);
  assert.equal(game.effects.length, 1);
  assert.equal(game.effects[0].type, 'skill_callout');
  assert.equal(game.effects[0].text, '번개 베기');
});

test('sword skill releases timed swordwaves without a spin effect', () => {
  const game = combatGame();
  const player = new Player('p4', 'Blade', 'sword', 100, 100);
  player.angle = Math.PI / 4;
  game.players[player.id] = player;

  game._castSwordSkill(player, 1000);

  assert.equal(game.projectiles.length, 0);
  assert.equal(game.pendingSwordWaves.length, SkillConfig.sword.waveCount);
  assert.equal(game.effects.filter(e => e.type === 'sword_skill').length, 0);
  assert.equal(player.skillCdLeft, SkillConfig.sword.cooldownMs / 1000);

  game._releaseDueSwordWaves(1000);
  assert.equal(game.projectiles.filter(p => p.kind === 'swordwave').length, 1);

  game._releaseDueSwordWaves(1000 + SkillConfig.sword.waveIntervalMs - 1);
  assert.equal(game.projectiles.filter(p => p.kind === 'swordwave').length, 1);

  player.angle = Math.PI / 2;
  game._releaseDueSwordWaves(1000 + SkillConfig.sword.waveIntervalMs);
  const wavesAfterSecond = game.projectiles.filter(p => p.kind === 'swordwave');
  assert.equal(wavesAfterSecond.length, 2);
  assert.equal(wavesAfterSecond[1].angle, Math.PI / 2);

  game._releaseDueSwordWaves(1000 + SkillConfig.sword.waveIntervalMs * 2);
  const waves = game.projectiles.filter(p => p.kind === 'swordwave');
  assert.equal(waves.length, SkillConfig.sword.waveCount);
  assert.equal(new Set(waves.map(p => p.id)).size, waves.length);
  assert.equal(game.pendingSwordWaves.length, 0);
});

test('greatsword skill charges quickly into a max-damage heavy cleave', () => {
  const game = combatGame();
  const owner = new Player('greatsword-owner', 'Heavy', 'greatsword', 100, 100);
  owner.angle = 0;
  const target = new Player('greatsword-target', 'Dummy', 'sword', 190, 100);
  game.players[owner.id] = owner;
  game.players[target.id] = target;

  game._startGreatswordCharge(owner, 1000);
  assert.equal(owner.greatswordChargeStart, 1000);
  assert.equal(game.effects.some(e => e.type === 'greatsword_charge'), true);

  game._releaseGreatswordCharge(owner, 1000 + SkillConfig.greatsword.chargeMaxMs);
  assert.equal(game.pendingMeleeHits.length, 1);
  assert.equal(game.effects.some(e => e.type === 'melee_heavy_arc' && e.angleDeg === SkillConfig.greatsword.angle), true);
  assert.equal(target.hp, target.maxHp);

  game._processPendingMeleeHits(1000 + SkillConfig.greatsword.chargeMaxMs + SkillConfig.greatsword.delayDamageMs);
  assert.equal(game.pendingMeleeHits.length, 0);
  assert.equal(target.hp, target.maxHp - SkillConfig.greatsword.damage);
  assert.equal(owner.skillCdLeft, SkillConfig.greatsword.cooldownMs / 1000);
});

test('greatsword cannot use automatic basic attacks', () => {
  const owner = new Player('greatsword-no-basic', 'Heavy', 'greatsword', 100, 100);
  owner.angle = 0;
  owner.lastAttackTime = 0;

  assert.equal(Weapons.greatsword.automaticAttack, false);
  assert.equal(owner.canAttack(5000), false);
});

test('greatsword charge damage starts scaling only after the midpoint', () => {
  const game = combatGame();
  const owner = new Player('greatsword-half', 'Heavy', 'greatsword', 100, 100);
  owner.angle = 0;
  const target = new Player('greatsword-target-half', 'Dummy', 'sword', 190, 100);
  game.players[owner.id] = owner;
  game.players[target.id] = target;

  game._startGreatswordCharge(owner, 1000);
  game._releaseGreatswordCharge(owner, 1000 + SkillConfig.greatsword.chargeMaxMs * 0.75);

  const expectedDamage = Math.round(
    SkillConfig.greatsword.thresholdDamage +
    (SkillConfig.greatsword.damage - SkillConfig.greatsword.thresholdDamage) * 0.5
  );
  assert.equal(game.pendingMeleeHits[0].attackConfig.damage, expectedDamage);

  game._processPendingMeleeHits(1000 + SkillConfig.greatsword.chargeMaxMs * 0.75 + SkillConfig.greatsword.delayDamageMs);
  assert.equal(target.hp, target.maxHp - expectedDamage);
});

test('greatsword release before midpoint still deals minimum damage', () => {
  const game = combatGame();
  const owner = new Player('greatsword-before-mid', 'Heavy', 'greatsword', 100, 100);
  owner.angle = 0;
  const target = new Player('greatsword-target-before-mid', 'Dummy', 'sword', 190, 100);
  game.players[owner.id] = owner;
  game.players[target.id] = target;

  game._startGreatswordCharge(owner, 1000);
  game._releaseGreatswordCharge(owner, 1000 + SkillConfig.greatsword.chargeMaxMs * 0.49);
  game._processPendingMeleeHits(1000 + SkillConfig.greatsword.chargeMaxMs * 0.49 + SkillConfig.greatsword.delayDamageMs);

  assert.equal(target.hp, target.maxHp - SkillConfig.greatsword.minDamage);
});

test('greatsword blade sweep cuts inside the swept arc but not behind/outside it', () => {
  const sk = SkillConfig.greatsword;
  const weapon = { type: 'melee_blade_sweep', range: sk.range, angle: sk.angle, bladeHalfWidth: sk.bladeHalfWidth };
  const attacker = { id: 'gs', x: 100, y: 100, angle: 0, radius: 14 };

  const inFront = { id: 't1', x: 100 + 90, y: 100, isDead: false, radius: 14 };
  const behind = { id: 't2', x: 100 - 90, y: 100, isDead: false, radius: 14 };
  const beyondReach = { id: 't3', x: 100 + sk.range + 40, y: 100, isDead: false, radius: 14 };

  assert.equal(Collision.checkMeleeHit(attacker, inFront, weapon), true);
  assert.equal(Collision.checkMeleeHit(attacker, behind, weapon), false);
  assert.equal(Collision.checkMeleeHit(attacker, beyondReach, weapon), false);
});

test('generic R and LMB auxiliary skills apply their own cooldowns', () => {
  const game = combatGame();
  const sword = new Player('sword-aux', 'Blade', 'sword', 100, 100);
  sword.angle = 0;
  const close = new Player('close-target', 'Close', 'sword', 150, 100);
  const line = new Player('line-target', 'Line', 'sword', 210, 100);
  game.players[sword.id] = sword;
  game.players[close.id] = close;
  game.players[line.id] = line;

  game._castAuxAltSkill(sword, 1000);
  assert.equal(sword.altSkillCdLeft, AuxSkillConfig.sword.alt.cooldownMs / 1000);
  assert.equal(close.hp, close.maxHp - AuxSkillConfig.sword.alt.damage);

  game._castAuxTargetSkill(sword, 2000, 260, 100);
  assert.equal(sword.targetSkillCdLeft, AuxSkillConfig.sword.target.cooldownMs / 1000);
  assert.equal(sword.angle, 0);
  assert.ok(line.hp < line.maxHp);
});

test('generic R auxiliary skills expose non-blink HUD labels', () => {
  Object.values(AuxSkillConfig).forEach(config => {
    if (!config.alt) return;
    assert.equal(typeof config.alt.label, 'string');
    assert.notEqual(config.alt.label, '');
    assert.notEqual(config.alt.label, 'BLINK');
  });
});

test('mobile directional target casts resolve to a world point on the aim ray', () => {
  const game = Object.create(Game.prototype);
  game.mapWidth = 700;
  game.mapHeight = 700;
  game.input = {
    consumeTargetCast: () => null,
    consumeTargetCastDirection: () => 0
  };

  const target = game._consumeTargetCastWorld({ x: 100, y: 200 });
  assert.deepEqual(target, { x: 700, y: 200 });
});

test('railgun hitscan reports the closest contact distance and misses cleanly', () => {
  const hit = Collision.rayCircleHitDistance(0, 0, 1, 0, 100, 0, 14);
  assert.ok(Math.abs(hit - 86) < 1e-6);

  const miss = Collision.rayCircleHitDistance(0, 0, 1, 0, 100, 100, 14);
  assert.equal(miss, null);
});

test('sword uses the blade-sweep hit test via hitMode', () => {
  assert.equal(Weapons.sword.hitMode, 'melee_blade_sweep');

  const sword = { id: 'sw', x: 100, y: 100, angle: 0, radius: 14 };
  const front = { id: 'f', x: 160, y: 100, isDead: false, radius: 14 };
  const behind = { id: 'b', x: 40, y: 100, isDead: false, radius: 14 };

  assert.equal(Collision.checkMeleeHit(sword, front, Weapons.sword), true);
  assert.equal(Collision.checkMeleeHit(sword, behind, Weapons.sword), false);
});

test('weapon swap is queued for valid built-ins and ignores unknown weapons', () => {
  const game = Object.create(Game.prototype);
  game.players = {};
  game.localPlayerId = 'p';
  game.networkManager = { isHost: true };

  const p = new Player('p', 'Switcher', 'sword', 0, 0);
  game.players.p = p;

  game.requestWeaponChange('greatsword');
  assert.equal(p.pendingWeapon, 'greatsword');
  assert.equal(p.weapon, 'sword');
  assert.equal(game.pendingWeaponChoice, 'greatsword');

  game.requestWeaponChange('not-a-weapon');
  assert.equal(p.pendingWeapon, 'greatsword');
});

test('effect rebase preserves extra skill fields', () => {
  const rebased = rebaseEffectSnapshot({
    x: 0, y: 0, x2: 300, y2: 120, radius: 70,
    type: 'railbeam', weapon: 'sword',
    progress: 0.5, timestamp: 1000, lifetime: 400
  }, 5000);

  assert.equal(rebased.x2, 300);
  assert.equal(rebased.y2, 120);
  assert.equal(rebased.radius, 70);
  assert.equal(rebased.progress, 0.5);
});

test('dummy kills are tallied separately and never credited as real kills', () => {
  const game = Object.create(Game.prototype);
  const announces = [];
  game.players = {};
  game._announce = msg => announces.push(msg);

  const killer = new Player('killer', 'Hunter', 'sword', 0, 0);
  const realTarget = new Player('real', 'Rival', 'sword', 50, 0);
  const dummy = new Player('dummy_0', '더미 1', 'sword', 80, 0);
  dummy.isDummy = true;
  game.players[killer.id] = killer;
  game.players[realTarget.id] = realTarget;
  game.players[dummy.id] = dummy;

  game._creditKill(killer.id, dummy, '검으로');
  assert.equal(killer.kills, 0);
  assert.equal(killer.dummyKills, 1);
  assert.equal(announces.length, 0);

  game._creditKill(killer.id, realTarget, '검으로');
  assert.equal(killer.kills, 1);
  assert.equal(killer.dummyKills, 1);
  assert.equal(announces.length, 1);
});

test('player kills/dummyKills/deaths survive serialization', () => {
  const p = new Player('stat-sync', 'Stats', 'sword', 0, 0);
  p.kills = 7;
  p.dummyKills = 3;
  p.deaths = 2;

  const restored = new Player('stat-sync', 'Stats', 'sword', 0, 0);
  restored.deserialize(p.serialize());

  assert.equal(restored.kills, 7);
  assert.equal(restored.dummyKills, 3);
  assert.equal(restored.deaths, 2);
});
