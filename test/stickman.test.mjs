import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageWeaponAnchorVector } from '../game/Stickman.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);

test('weapon image anchor vector accounts for flip before rotation', () => {
  const anchors = { gx: 0.2, gy: 0.25, tx: 0.8, ty: 0.75 };
  const normal = imageWeaponAnchorVector(anchors, 100, 80, false, false);
  near(normal.dx, 60);
  near(normal.dy, 40);

  const flipX = imageWeaponAnchorVector(anchors, 100, 80, true, false);
  near(flipX.dx, 60);
  near(flipX.dy, -40);

  const flipY = imageWeaponAnchorVector(anchors, 100, 80, false, true);
  near(flipY.dx, -60);
  near(flipY.dy, 40);

  const both = imageWeaponAnchorVector(anchors, 100, 80, true, true);
  near(both.dx, -60);
  near(both.dy, -40);
  near(both.d, Math.hypot(60, 40));
});
