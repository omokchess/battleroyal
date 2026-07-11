/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const VIEW_PADDING = 60;
const PLATFORMER_CHARACTER_WORLD_H = 14 * 4.15;
const PLATFORMER_CHARACTER_SCREEN_FRACTION = 1 / 7.5;
const PLATFORMER_DEADZONE_X_SCREEN = 180;
const PLATFORMER_DEADZONE_Y_SCREEN = 135;
const PLATFORMER_RECENTER_EPS_SCREEN = 3;
const PLATFORMER_IDLE_RECENTER_MS = 1800;
const PLATFORMER_EXIT_RECENTER_MS = 180;
const PLATFORMER_MAX_FRAME_MS = 100;
const PLATFORMER_LOOKAHEAD_X = 120;
const PLATFORMER_LOOKAHEAD_Y = 60;
const PLATFORMER_LOOKAHEAD_RESPONSE_MS = 260;

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1.0;
    this.shakeStart = 0;
    this.shakeEnd = 0;
    this.shakeMagnitude = 0;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    this.screenOffsetY = 0;

    // True when the map is too large to fit, so we follow the local player.
    // Minimap / off-screen indicators only render in this mode.
    this.tracking = false;

    // Lerping inertia (0.1 means 10% movement per frame leading to very smooth chase)
    this.lerpSpeed = 0.12;
    this.platformerRecenterX = false;
    this.platformerRecenterY = false;
    this.platformerDeadzoneMs = 0;
    this.platformerOutsideDeadzoneMs = 0;
    this.platformerLastNow = null;
    this.platformerLastTargetX = null;
    this.platformerLastTargetY = null;
    this.platformerLookX = 0;
    this.platformerLookY = 0;
  }

  /**
   * Fighting-game action camera (1v1 focus): frame ALL the given focus points
   * (the local player + nearby opponents) inside the view and zoom by how far
   * apart they are — pull in tight for close combat, ease out as they separate.
   * Smoothly lerps both zoom and position, clamped to the level bounds.
   */
  updateAction(points, vw, vh, level) {
    this.tracking = true;
    this.screenOffsetY = 0;
    if (!points || !points.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    // World-space view size grows with the player spread, clamped to a punchy
    // range: small spread → small view → zoomed IN; large spread → zoomed OUT.
    const MARGIN_X = 250, MARGIN_Y = 200;
    const MIN_VIEW_W = 560, MAX_VIEW_W = 1650, MIN_VIEW_H = 400, MAX_VIEW_H = 1040;
    const viewW = Math.max(MIN_VIEW_W, Math.min(MAX_VIEW_W, (maxX - minX) + MARGIN_X * 2));
    const viewH = Math.max(MIN_VIEW_H, Math.min(MAX_VIEW_H, (maxY - minY) + MARGIN_Y * 2));
    let targetZoom = Math.min(vw / viewW, vh / viewH) * (this.userZoom || 1);
    targetZoom = Math.max(0.1, Math.min(3, targetZoom));

    // Snappy-but-smooth zoom, then clamp the focus at the new zoom.
    this.zoom += (targetZoom - this.zoom) * 0.085;
    const halfW = vw / (2 * this.zoom), halfH = vh / (2 * this.zoom);
    const lw = level?.width || vw, lh = level?.height || vh;
    const fx = clampRange(cx, halfW, lw - halfW, lw / 2);
    const fy = clampRange(cy, halfH, lh - halfH, lh / 2);
    this.x += (fx - this.x) * 0.13;
    this.y += (fy - this.y) * 0.13;
  }

  /** Place the action camera on valid arena coordinates before its first lerp. */
  snapAction(points, vw, vh, level) {
    if (!points || !points.length) return;
    const valid = points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid.length) return;
    const minX = Math.min(...valid.map(p => p.x));
    const maxX = Math.max(...valid.map(p => p.x));
    const minY = Math.min(...valid.map(p => p.y));
    const maxY = Math.max(...valid.map(p => p.y));
    const viewW = Math.max(560, Math.min(1650, maxX - minX + 500));
    const viewH = Math.max(400, Math.min(1040, maxY - minY + 400));
    this.zoom = Math.max(0.1, Math.min(3, Math.min(vw / viewW, vh / viewH) * (this.userZoom || 1)));
    const halfW = vw / (2 * this.zoom);
    const halfH = vh / (2 * this.zoom);
    const lw = level?.width || vw;
    const lh = level?.height || vh;
    this.x = clampRange((minX + maxX) / 2, halfW, lw - halfW, lw / 2);
    this.y = clampRange((minY + maxY) / 2, halfH, lh - halfH, lh / 2);
    this.tracking = true;
    this.screenOffsetY = 0;
  }

  /**
   * Move the camera toward its focus with smooth inertia.
   *
   * Auto mode:
   *  - If the whole map fits at >= the tracking zoom, keep a centered full-map
   *    view (focus = map center).
   *  - Otherwise track the local player (targetX/targetY), clamped so the
   *    viewport never reveals past the map edges.
   *
   * During death the caller keeps passing the (frozen) death position, so the
   * camera naturally holds there and lerps back on respawn.
   */
  update(targetX, targetY, viewportWidth, viewportHeight, mapWidth, mapHeight) {
    const isMobilePortrait = (() => {
      if (typeof window === 'undefined') return false;
      const cssWidth = window.visualViewport?.width || window.innerWidth || viewportWidth;
      return cssWidth <= 640 && viewportHeight > viewportWidth * 1.1;
    })();
    const topReserve = isMobilePortrait ? Math.min(viewportHeight * 0.12, viewportWidth * 0.3) : 0;
    const bottomReserve = isMobilePortrait ? Math.min(viewportHeight * 0.24, viewportWidth * 0.46) : 0;
    const usableHeight = Math.max(1, viewportHeight - topReserve - bottomReserve);
    this.screenOffsetY = isMobilePortrait ? (topReserve - bottomReserve) / 2 : 0;

    const clampZoom = (z) => Math.max(0.1, Math.min(2.5, z));
    // Zoom that fits the entire map into the usable play area (legacy view).
    const fitZoom = clampZoom(Math.min(
      viewportWidth / (mapWidth + VIEW_PADDING),
      usableHeight / (mapHeight + VIEW_PADDING)
    ));
    const trackZoom = clampZoom(usableHeight * PLATFORMER_CHARACTER_SCREEN_FRACTION / PLATFORMER_CHARACTER_WORLD_H);

    this.tracking = fitZoom < trackZoom - 1e-3;
    const baseZoom = this.tracking ? trackZoom : fitZoom;
    this.zoom = Math.max(0.06, Math.min(4, baseZoom));

    let focusX = mapWidth / 2;
    let focusY = mapHeight / 2;
    if (this.tracking) {
      // Half-extents of the viewport in world units (Y accounts for the mobile
      // reserve offset so reserved bands never expose out-of-map area).
      const halfW = viewportWidth / (2 * this.zoom);
      const halfTop = (viewportHeight / 2 + this.screenOffsetY) / this.zoom;
      const halfBot = (viewportHeight / 2 - this.screenOffsetY) / this.zoom;
      focusX = clampRange(targetX, halfW, mapWidth - halfW, mapWidth / 2);
      focusY = clampRange(targetY, halfTop, mapHeight - halfBot, mapHeight / 2);
    }

    // Apply linear interpolation (preserves the existing chase inertia).
    this.x += (focusX - this.x) * this.lerpSpeed;
    this.y += (focusY - this.y) * this.lerpSpeed;
  }

  /**
   * Platformer 2D follow (side-scroller pivot). Zoom is fixed from viewport
   * height so the character occupies roughly 1/7.5 of the screen vertically.
   */
  updatePlatformer(targetX, targetY, vw, vh, level, velocityX = 0, velocityY = 0, now = performance.now()) {
    this.screenOffsetY = 0;
    this.tracking = true;
    const deltaMs = this.platformerLastNow === null
      ? 0
      : Math.max(0, Math.min(PLATFORMER_MAX_FRAME_MS, now - this.platformerLastNow));
    this.platformerLastNow = now;
    const baseZoom = vh * PLATFORMER_CHARACTER_SCREEN_FRACTION / PLATFORMER_CHARACTER_WORLD_H;
    this.zoom = Math.max(0.65, Math.min(2.6, baseZoom));

    const halfW = vw / (2 * this.zoom);
    const halfH = vh / (2 * this.zoom);
    const lw = level?.width || vw, lh = level?.height || vh;

    this.x = clampRange(this.x, halfW, lw - halfW, lw / 2);
    this.y = clampRange(this.y, halfH, lh - halfH, lh / 2);

    const targetMoved = this.platformerLastTargetX !== null &&
      Math.hypot(targetX - this.platformerLastTargetX, targetY - this.platformerLastTargetY) > 0.5;
    if (targetMoved) this.platformerDeadzoneMs = 0;
    this.platformerLastTargetX = targetX;
    this.platformerLastTargetY = targetY;

    const targetLookX = clamp((Number.isFinite(velocityX) ? velocityX : 0) * 0.16, -PLATFORMER_LOOKAHEAD_X, PLATFORMER_LOOKAHEAD_X);
    const targetLookY = clamp((Number.isFinite(velocityY) ? velocityY : 0) * 0.08, -PLATFORMER_LOOKAHEAD_Y, PLATFORMER_LOOKAHEAD_Y);
    const lookAlpha = 1 - Math.exp(-deltaMs / PLATFORMER_LOOKAHEAD_RESPONSE_MS);
    this.platformerLookX += (targetLookX - this.platformerLookX) * lookAlpha;
    this.platformerLookY += (targetLookY - this.platformerLookY) * lookAlpha;
    const screenDx = (targetX - this.x) * this.zoom;
    const screenDy = (targetY - this.y) * this.zoom;
    const insideDeadzone = Math.abs(screenDx) <= PLATFORMER_DEADZONE_X_SCREEN && Math.abs(screenDy) <= PLATFORMER_DEADZONE_Y_SCREEN;
    if (insideDeadzone) {
      this.platformerDeadzoneMs += deltaMs;
      this.platformerOutsideDeadzoneMs = 0;
    } else {
      this.platformerDeadzoneMs = 0;
      this.platformerOutsideDeadzoneMs += deltaMs;
      if (this.platformerOutsideDeadzoneMs >= PLATFORMER_EXIT_RECENTER_MS) {
        if (Math.abs(screenDx) > PLATFORMER_DEADZONE_X_SCREEN) this.platformerRecenterX = true;
        if (Math.abs(screenDy) > PLATFORMER_DEADZONE_Y_SCREEN) this.platformerRecenterY = true;
      }
    }
    const idleRecentering = insideDeadzone && this.platformerDeadzoneMs >= PLATFORMER_IDLE_RECENTER_MS;
    if (idleRecentering) {
      this.platformerRecenterX = true;
      this.platformerRecenterY = true;
    }

    const desiredX = this.platformerRecenterX ? targetX + this.platformerLookX : this.x;
    const desiredY = this.platformerRecenterY ? targetY + this.platformerLookY : this.y;
    const fx = clampRange(desiredX, halfW, lw - halfW, lw / 2);
    const fy = clampRange(desiredY, halfH, lh - halfH, lh / 2);

    const speedScale = idleRecentering ? 0.35 : 1;
    this.x = easeFollow(this.x, fx, speedScale);
    this.y = easeFollow(this.y, fy, speedScale);

    if (Math.abs((targetX - this.x) * this.zoom) <= PLATFORMER_RECENTER_EPS_SCREEN) this.platformerRecenterX = false;
    if (Math.abs((targetY - this.y) * this.zoom) <= PLATFORMER_RECENTER_EPS_SCREEN) this.platformerRecenterY = false;
  }

  startShake(magnitude = 8, durationMs = 220, now = performance.now()) {
    this.shakeStart = now;
    this.shakeEnd = Math.max(this.shakeEnd, now + durationMs);
    this.shakeMagnitude = Math.max(this.shakeMagnitude, magnitude);
  }

  getShakeOffset(now = performance.now()) {
    if (now >= this.shakeEnd || this.shakeMagnitude <= 0) {
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
      this.shakeMagnitude = 0;
      return { x: 0, y: 0 };
    }

    const duration = Math.max(1, this.shakeEnd - this.shakeStart);
    const progress = Math.max(0, Math.min(1, (now - this.shakeStart) / duration));
    const strength = this.shakeMagnitude * (1 - progress);
    const wobble = now * 0.09;
    this.shakeOffsetX = Math.cos(wobble * 1.7) * strength + Math.sin(wobble * 0.7) * strength * 0.45;
    this.shakeOffsetY = Math.sin(wobble * 1.9) * strength + Math.cos(wobble * 0.8) * strength * 0.45;
    return { x: this.shakeOffsetX, y: this.shakeOffsetY };
  }

  /**
   * Map absolute coords to relative viewport coords taking Zoom factor into consideration
   */
  toScreen(worldX, worldY, viewportWidth, viewportHeight) {
    return {
      x: (worldX - this.x) * this.zoom + viewportWidth / 2,
      y: (worldY - this.y) * this.zoom + viewportHeight / 2 + this.screenOffsetY
    };
  }

  /**
   * Map screen coordinates back to absolute coordinates taking Zoom factor into consideration
   */
  toWorld(screenX, screenY, viewportWidth, viewportHeight) {
    return {
      x: (screenX - viewportWidth / 2) / this.zoom + this.x,
      y: (screenY - viewportHeight / 2 - this.screenOffsetY) / this.zoom + this.y
    };
  }
}

// Clamp v into [lo, hi]; if the range is inverted (map smaller than the
// viewport on that axis) fall back to the centered value instead.
function clampRange(v, lo, hi, mid) {
  if (lo > hi) return mid;
  return Math.max(lo, Math.min(hi, v));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeFollow(current, target, speedScale = 1) {
  const delta = target - current;
  const dist = Math.abs(delta);
  if (dist < 0.001) return target;
  const t = Math.min(1, dist / 320);
  const eased = 1 - Math.pow(1 - t, 3);
  const alpha = (0.015 + eased * 0.165) * speedScale;
  return current + delta * alpha;
}
