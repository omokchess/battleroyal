import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../game/Game.js';

const resolve = (ctx, player, preset = 'basic') =>
  Game.prototype._resolveAimAssistTarget.call(ctx, player, preset);

const gameCtx = (ctx) => Object.assign(Object.create(Game.prototype), ctx);

const apply = (ctx, player, preset = 'basic') =>
  Game.prototype._applyMobileAimAssistForAttack.call(gameCtx(ctx), player, preset);

test('mobile aim assist prefers targets near the current aim line for ranged presets', () => {
  const player = {
    id: 'p',
    x: 100,
    y: 100,
    angle: 0,
    isMobile: true,
    mobileAimAssist: true,
    workshopWeapon: {
      category: 'ranged',
      presets: { basic: { ranged: true, combat: { range: 400 } } }
    }
  };
  const ctx = {
    players: {
      p: player,
      closeButOffLine: { id: 'closeButOffLine', x: 170, y: 250, isDead: false },
      onLine: { id: 'onLine', x: 460, y: 106, isDead: false }
    }
  };

  const target = resolve(ctx, player);
  assert.equal(target.targetId, 'onLine');
  assert.ok(Math.abs(target.angle) < 0.02);
});

test('mobile aim assist does nothing when disabled', () => {
  const player = {
    id: 'p',
    x: 0,
    y: 0,
    angle: 0.5,
    facing: 1,
    isMobile: true,
    mobileAimAssist: false
  };
  const ctx = {
    players: {
      p: player,
      e: { id: 'e', x: 200, y: 0, isDead: false }
    }
  };

  assert.equal(apply(ctx, player), false);
  assert.equal(player.angle, 0.5);
});

test('mobile aim assist rotates a melee player toward a nearby valid target', () => {
  const player = {
    id: 'p',
    x: 100,
    y: 100,
    angle: 0,
    facing: 1,
    isMobile: true,
    mobileAimAssist: true,
    workshopWeapon: {
      category: 'melee',
      presets: { basic: { ranged: false, combat: { range: 120 } } }
    }
  };
  const ctx = {
    players: {
      p: player,
      e: { id: 'e', x: 240, y: 130, isDead: false }
    }
  };

  assert.equal(apply(ctx, player), true);
  assert.ok(player.angle > 0 && player.angle < 0.3);
  assert.equal(player.facing, 1);
});
