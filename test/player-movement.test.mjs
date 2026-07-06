import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Player } from '../game/Player.js';
import { Weapons } from '../game/Weapons.js';
import { buildLevel } from '../game/Level.js';

// Platformer pivot: horizontal movement accelerates toward a capped run speed
// (no instant top-down velocity), so we assert the per-weapon move-speed
// multiplier still SCALES how far a grounded player runs over a fixed window.
test('weapon move-speed multipliers scale horizontal run distance', () => {
  const level = buildLevel(1000);
  const groundTop = level.solids[0].y;
  const runDist = (weapon, costume = null) => {
    const p = new Player('p', 'N', weapon, 240, groundTop - 21, costume); // feet just above ground
    for (let i = 0; i < 45; i++) p.updatePosition(1 / 60, { d: true }, level);
    return p.x - 240;
  };
  const order = (wa, wb) => {
    const a = runDist(wa), b = runDist(wb);
    if (Weapons[wa].moveSpeed > Weapons[wb].moveSpeed) assert.ok(a > b + 1, `${wa} should outrun ${wb}`);
    else if (Weapons[wa].moveSpeed < Weapons[wb].moveSpeed) assert.ok(a < b - 1, `${wb} should outrun ${wa}`);
    else assert.ok(Math.abs(a - b) < 2, `${wa}/${wb} equal move speed → equal distance`);
  };
  order('sword', 'greatsword');

  const slowWorkshop = { workshopWeapon: { stats: { moveSpeed: 0.75 }, motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } } } };
  const fastWorkshop = { workshopWeapon: { stats: { moveSpeed: 1.35 }, motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } } } };
  assert.ok(runDist('sword', fastWorkshop) > runDist('sword', slowWorkshop) + 1);
});

test('weapon max hp is applied on spawn and serialization', () => {
  const sword = new Player('sword-player', 'Sword', 'sword', 0, 0);
  const greatsword = new Player('greatsword-player', 'Greatsword', 'greatsword', 0, 0);
  const fallback = new Player('fallback-player', 'Fallback', 'removed-weapon', 0, 0);
  const workshop = new Player('workshop-player', 'Workshop', 'sword', 0, 0, {
    workshopWeapon: {
      stats: { maxHp: 155, moveSpeed: 1.1 },
      motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } }
    }
  });

  assert.equal(sword.maxHp, 120);
  assert.equal(greatsword.maxHp, 140);
  assert.equal(fallback.weapon, 'sword');
  assert.equal(fallback.maxHp, 120);
  assert.equal(workshop.maxHp, 155);
  assert.equal(workshop.hp, workshop.maxHp);
  assert.equal(workshop.serialize().maxHp, 155);
});
