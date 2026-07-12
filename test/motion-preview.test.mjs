import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCustomWeaponVisual, effectScaleFromDrag, previewGroundY, previewPelvisTarget } from '../game/MotionEditor.js';

test('teleport preview keeps the current character centered at large distances', () => {
  const current = previewPelvisTarget(800, 400, { x: 0, y: 0 }, { x: 260, y: -260 }, { x: 260, y: -260 });
  assert.equal(current.x, 400);
  assert.ok(Math.abs(current.y - 232) < 0.001);
});

test('teleport preview keeps prior frames relative to the current camera', () => {
  const previous = previewPelvisTarget(800, 400, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 0 });
  assert.ok(previous.x < 400);
  assert.ok(Math.abs(previous.y - 232) < 0.001);
});

test('teleport onion skin and floor use the same zoomed world scale', () => {
  const normal = previewPelvisTarget(800, 400, { x: 0, y: 0 }, { x: 100, y: -20 }, { x: 120, y: -40 }, 1);
  const zoomed = previewPelvisTarget(800, 400, { x: 0, y: 0 }, { x: 100, y: -20 }, { x: 120, y: -40 }, 2);
  assert.ok(Math.abs((zoomed.x - 400) - (normal.x - 400) * 2) < 1e-9);
  assert.ok(Math.abs((zoomed.y - 232) - (normal.y - 232) * 2) < 1e-9);
  assert.ok(Math.abs((previewGroundY(400, 2, -40) - 232) - (previewGroundY(400, 1, -40) - 232) * 2) < 1e-9);
});

test('workshop preview floor stays fixed instead of following animated feet', () => {
  assert.equal(previewGroundY(400), 312);
  assert.equal(previewGroundY(800), 624);
  assert.ok(previewGroundY(400, 2, 0) > previewGroundY(400, 1, 0), 'zoom moves a fixed world floor away from the camera center');
  assert.ok(previewGroundY(400, 1, -20) > previewGroundY(400, 1, 0), 'camera moving up makes the floor move down');
  assert.ok(previewGroundY(400, 1, 20) < previewGroundY(400, 1, 0), 'camera moving down makes the floor move up');
});

test('effect resize drag supports the full 128x scale range', () => {
  assert.equal(effectScaleFromDrag(4, 32, 16), 8);
  assert.equal(effectScaleFromDrag(64, 64, 16), 128);
  assert.equal(effectScaleFromDrag(128, 1000, 1), 128);
});

test('adding a custom image immediately writes it into the workshop draft', () => {
  const draft = { weaponVisual: { dual: true, offhand: { imageId: 'custom:left' } } };
  applyCustomWeaponVisual(draft, { id: 'custom:new', size: 2.5 });
  assert.equal(draft.weaponVisual.imageId, 'custom:new');
  assert.equal(draft.weaponVisual.scale, 2.5);
  assert.equal(draft.weaponVisual.dual, true);
  assert.equal(draft.weaponVisual.offhand.imageId, 'custom:left');
});
