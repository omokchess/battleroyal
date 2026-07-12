import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundedPositionCorrection,
  consumePositionCorrectionBudget,
  projectServerSnapshot
} from '../game/Game.js';

test('local reconciliation projects stale server movement by half RTT', () => {
  const projected = projectServerSnapshot({ x: 100, y: 200, vx: 300, vy: -120 }, 100);
  // 50ms one-way latency plus one 60Hz server tick.
  assert.ok(Math.abs(projected.x - 120) < 0.01);
  assert.equal(projected.y, 200);
});

test('local reconciliation caps projection during latency spikes', () => {
  const projected = projectServerSnapshot({ x: 0, y: 0, vx: 100, vy: 100 }, 2000);
  assert.deepEqual(projected, { x: 12, y: 0 });
});

test('ordinary reconciliation cannot teleport farther than its per-snapshot cap', () => {
  const correction = boundedPositionCorrection(500, -300, 0.18, 18);
  assert.ok(Math.hypot(correction.x, correction.y) <= 18.0001);
  assert.ok(correction.x > 0);
  assert.ok(correction.y < 0);
});

test('a burst of stale snapshots shares one render-frame correction budget', () => {
  let remaining = 18;
  let moved = 0;
  for (let i = 0; i < 40; i++) {
    const correction = consumePositionCorrectionBudget(-500, 0, 0.18, remaining);
    moved += Math.hypot(correction.x, correction.y);
    remaining = correction.remaining;
  }
  assert.ok(moved <= 18.0001, `burst correction moved ${moved}px in one frame`);
  assert.equal(remaining, 0);
});
