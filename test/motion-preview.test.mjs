import test from 'node:test';
import assert from 'node:assert/strict';

import { previewPelvisTarget } from '../game/MotionEditor.js';

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
