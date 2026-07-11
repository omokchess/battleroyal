import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Camera } from '../game/Camera.js';

const VW = 1280;
const VH = 720;
const LEVEL = { width: 1960, height: 1400 };
const CHARACTER_WORLD_H = 14 * 4.15;
const EXPECTED_ZOOM = VH / 7.5 / CHARACTER_WORLD_H;

const stepPlatformer = (cam, tx, ty, startNow, n = 1, stepMs = 16, vx = 0, vy = 0) => {
  let now = startNow;
  for (let i = 0; i < n; i++) {
    now += stepMs;
    cam.updatePlatformer(tx, ty, VW, VH, LEVEL, vx, vy, now);
  }
  return now;
};

const settlePlatformer = (cam, tx, ty, n = 1000) => {
  stepPlatformer(cam, tx, ty, 0, n);
};

test('platformer camera uses fixed character-scale zoom', () => {
  const cam = new Camera();
  settlePlatformer(cam, 980, 900);
  assert.equal(cam.tracking, true);
  assert.ok(Math.abs(cam.zoom - EXPECTED_ZOOM) < 1e-9);
});

test('platformer camera clamps to level bounds', () => {
  const cam = new Camera();
  settlePlatformer(cam, 0, 0);
  const halfW = VW / (2 * EXPECTED_ZOOM);
  const halfH = VH / (2 * EXPECTED_ZOOM);
  assert.ok(Math.abs(cam.x - halfW) < 1.0);
  assert.ok(Math.abs(cam.y - halfH) < 1.0);
  assert.ok(cam.x - halfW >= -1e-6);
  assert.ok(cam.y - halfH >= -1e-6);
});

test('manual wheel zoom API is removed', () => {
  const cam = new Camera();
  assert.equal(typeof cam.adjustZoom, 'undefined');
  assert.equal(typeof cam.resetZoom, 'undefined');
  assert.equal(cam.userZoom, undefined);
});

test('action camera can snap to an authoritative spawn before easing', () => {
  const cam = new Camera();
  cam.snapAction([{ x: 1420, y: 760 }], VW, VH, LEVEL);
  assert.ok(cam.x > 0 && cam.y > 0);
  assert.ok(Math.abs(cam.x - 1420) < 1e-6);
  assert.ok(Math.abs(cam.y - 760) < 1e-6);
  assert.equal(cam.tracking, true);
});

test('platformer camera no longer takes aim lookahead arguments', () => {
  const base = new Camera();
  assert.equal(Camera.prototype.updatePlatformer.length, 5);
  settlePlatformer(base, 980, 700);
  assert.ok(Number.isFinite(base.x));
  assert.ok(Number.isFinite(base.y));
});

test('platformer camera holds inside 180px/135px screen deadzone, then idle recenters after 1.8s', () => {
  const cam = new Camera();
  let now = stepPlatformer(cam, 980, 700, 0, 1000);
  const settledX = cam.x;

  const insideWorldOffset = 150 / EXPECTED_ZOOM;
  now = stepPlatformer(cam, 980 + insideWorldOffset, 700, now, 100);
  assert.ok(Math.abs(cam.x - settledX) < 1e-9);

  now = stepPlatformer(cam, 980 + insideWorldOffset, 700, now, 120);
  assert.ok(cam.x > settledX);
});

test('platformer camera waits 180ms before following outside the screen deadzone', () => {
  const cam = new Camera();
  let now = stepPlatformer(cam, 980, 700, 0, 1000);
  const settledX = cam.x;

  const outsideWorldOffset = 220 / EXPECTED_ZOOM;
  now = stepPlatformer(cam, 980 + outsideWorldOffset, 700, now, 11);
  assert.ok(Math.abs(cam.x - settledX) < 1e-9);

  now = stepPlatformer(cam, 980 + outsideWorldOffset, 700, now, 5);
  assert.ok(cam.x > settledX);

  now = stepPlatformer(cam, 980 + outsideWorldOffset, 700, now, 420);
  assert.ok(Math.abs(cam.x - (980 + outsideWorldOffset)) * EXPECTED_ZOOM <= 4);
});

test('platformer camera uses player velocity for movement lookahead', () => {
  const still = new Camera();
  const moving = new Camera();
  let nowA = stepPlatformer(still, 980, 700, 0, 1000);
  let nowB = stepPlatformer(moving, 980, 700, 0, 1000);

  const outsideWorldOffset = 220 / EXPECTED_ZOOM;
  nowA = stepPlatformer(still, 980 + outsideWorldOffset, 700, nowA, 180, 16, 0, 0);
  nowB = stepPlatformer(moving, 980 + outsideWorldOffset, 700, nowB, 180, 16, 800, 0);

  assert.ok(moving.x > still.x);
});

test('platformer velocity lookahead reverses smoothly', () => {
  const cam = new Camera();
  let now = stepPlatformer(cam, 980, 700, 0, 1000);
  const outsideWorldOffset = 220 / EXPECTED_ZOOM;
  now = stepPlatformer(cam, 980 + outsideWorldOffset, 700, now, 180, 16, 800, 0);
  const beforeReverseX = cam.x;
  now = stepPlatformer(cam, 980 + outsideWorldOffset, 700, now, 1, 16, -800, 0);
  assert.ok(Math.abs(cam.x - beforeReverseX) * EXPECTED_ZOOM < 12);
});
