import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../game/Game.js';
import { PlatformerZone } from '../game/PlatformerZone.js';

test('platformer zone rises from the bottom and becomes lethal only after warning', () => {
  const z = new PlatformerZone(1400, 1000, 'medium');
  let t = 1000;

  z.update(t);
  assert.equal(z.phase, 'safe');
  assert.equal(z.isDamaging(), false);
  assert.equal(z.isOutside(700, 900), false);

  t += z.durSafe + 1;
  assert.equal(z.update(t), 'warning');
  assert.equal(z.isDamaging(), false);
  assert.ok(z.nextFloorY < z.floorY);

  t += z.durWarning + 1;
  assert.equal(z.update(t), 'shrinking');
  assert.equal(z.isDamaging(), true);

  t += Math.floor(z.durShrink / 2);
  z.update(t);
  assert.ok(z.floorY < z.startFloorY);
  assert.equal(z.isOutside(700, z.floorY + 2), true);
  assert.equal(z.isOutside(700, z.floorY - 30), false);
});

test('platformer zone serializes the fields clients render from', () => {
  const z = new PlatformerZone(1800, 1200, 'large');
  z.update(0);
  const s = z.serialize();
  for (const key of ['kind', 'phase', 'floorY', 'nextFloorY', 'leftX', 'rightX', 'nextLeftX', 'nextRightX']) {
    assert.ok(key in s, `missing ${key}`);
  }
  assert.equal(s.kind, 'platformer_rise');
});

test('respawn zone grace prevents immediate hazard death, then expires', () => {
  const player = {
    id: 'p1',
    x: 120,
    y: 900,
    isDead: false,
    isDummy: false,
    zoneGraceUntil: 2000,
    isInvincible: () => false
  };
  const ctx = {
    players: { p1: player },
    zone: {
      update: () => {},
      isDamaging: () => true,
      isOutside: () => true
    },
    _updateRingOutDeaths: () => {},
    _killByEnvironment: (p) => { p.isDead = true; }
  };

  Game.prototype._updateZone.call(ctx, 1500, 1 / 60);
  assert.equal(player.isDead, false);

  Game.prototype._updateZone.call(ctx, 2100, 1 / 60);
  assert.equal(player.isDead, true);
});
