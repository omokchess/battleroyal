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

test('one-way platform drop requires down plus jump', () => {
  const level = buildLevel(1000, { platforms: 'few', platformShape: 'balanced', cover: 'none' });
  const platform = level.oneWays[0];
  const makePlayer = () => {
    const p = new Player('p', 'N', 'sword', platform.x + platform.w / 2, platform.y - 20);
    p.grounded = true;
    p.coyoteLeft = 0.09;
    return p;
  };

  const sOnly = makePlayer();
  for (let i = 0; i < 8; i++) sOnly.updatePosition(1 / 60, { s: true }, level);
  assert.ok(sOnly.y <= platform.y - 19, 'holding S alone should stay on the platform');

  const sSpace = makePlayer();
  sSpace.updatePosition(1 / 60, { s: true, w: true }, level);
  for (let i = 0; i < 10; i++) sSpace.updatePosition(1 / 60, { s: true }, level);
  assert.ok(sSpace.y > platform.y + 4, 'S + Space should drop through the platform');
});

test('authored root motion can float without being pulled down by gravity', () => {
  const p = new Player('p', 'N', 'sword', 100, 200);
  p.grounded = true;
  p.vy = 0;
  const now = Date.now();
  const motion = {
    duration: 0.5,
    keyframes: [
      { t: 0, pose: {}, root: { x: 0, y: 0 } },
      { t: 1, pose: {}, root: { x: 0, y: -90 } },
    ],
  };
  p.beginMotionRoot(motion, now - 250, 500);
  p.motionRootPrev = { x: 0, y: 0 };
  p.updatePosition(1 / 60, {}, null);
  assert.ok(p.y < 170, 'root motion moves the actual body upward');
  assert.equal(p.vy, 0, 'gravity is suppressed while grounded root motion owns vertical position');
  assert.ok(p.serialize().rootMotionMs > 0, 'root motion state is synced for remote renderers');
});
