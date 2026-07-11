import test from 'node:test';
import assert from 'node:assert/strict';

import { projectServerSnapshot } from '../game/Game.js';

test('local reconciliation projects stale server movement by half RTT', () => {
  const projected = projectServerSnapshot({ x: 100, y: 200, vx: 300, vy: -120 }, 100);
  // 50ms one-way latency plus one 60Hz server tick.
  assert.ok(Math.abs(projected.x - 120) < 0.01);
  assert.ok(Math.abs(projected.y - 192) < 0.01);
});

test('local reconciliation caps projection during latency spikes', () => {
  const projected = projectServerSnapshot({ x: 0, y: 0, vx: 100, vy: 100 }, 2000);
  assert.deepEqual(projected, { x: 12, y: 12 });
});
