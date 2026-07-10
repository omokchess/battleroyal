/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Max single-frame target travel that still gets a swept melee test. Anything
// longer is treated as a teleport (sniper R, respawn) and collapses to a point
// so it can't sweep a giant line across the map.
const MAX_MELEE_SWEEP = 120;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Squared shortest distance between segment P1Q1 and segment P2Q2.
// (Ericson, Real-Time Collision Detection — ClosestPtSegmentSegment.)
function segSegDistSq(p1x, p1y, q1x, q1y, p2x, p2y, q2x, q2y) {
  const d1x = q1x - p1x, d1y = q1y - p1y; // segment 1 direction
  const d2x = q2x - p2x, d2y = q2y - p2y; // segment 2 direction
  const rx = p1x - p2x, ry = p1y - p2y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1x = p1x + s * d1x, c1y = p1y + s * d1y;
  const c2x = p2x + t * d2x, c2y = p2y + t * d2y;
  const dx = c1x - c2x, dy = c1y - c2y;
  return dx * dx + dy * dy;
}

export const Collision = {
  /**
   * Keep players inside map boundaries
   */
  clampToMap(player, mapWidth, mapHeight) {
    const rx = player.radius || 14;
    const ry = player.radius || 14;

    if (player.x < rx) {
      player.x = rx;
      player.vx = 0;
    } else if (player.x > mapWidth - rx) {
      player.x = mapWidth - rx;
      player.vx = 0;
    }

    if (player.y < ry) {
      player.y = ry;
      player.vy = 0;
    } else if (player.y > mapHeight - ry) {
      player.y = mapHeight - ry;
      player.vy = 0;
    }
  },

  /**
   * Prevent two players from clipping into each other
   */
  resolvePlayerCollisions(players, localPlayerId) {
    const ids = Object.keys(players);
    const radius = 14; // Player basic radius

    for (let i = 0; i < ids.length; i++) {
      const p1 = players[ids[i]];
      if (p1.isDead) continue;

      for (let j = i + 1; j < ids.length; j++) {
        const p2 = players[ids[j]];
        if (p2.isDead) continue;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = radius * 1.55;

        if (dist < minDist) {
          // If perfectly overlapping, nudge them
          const overlap = minDist - dist;
          const forceX = dist === 0 ? 1 : dx / dist;
          const forceY = 0;

          // Push them apart gently. This is only an anti-overlap nudge, not combat knockback.
          p1.x -= forceX * overlap * 0.18;
          p1.y -= forceY * overlap * 0.18;
          p2.x += forceX * overlap * 0.18;
          p2.y += forceY * overlap * 0.18;
        }
      }
    }
  },

  /**
   * Check if attacker hits target, sweeping the target's path this frame so a
   * fast-moving target can't tunnel through a thin or quick blade between ticks.
   *
   *  - Line weapons (spear/dagger/rapier…): the blade is a segment from the
   *    attacker out to `range`; the target is its path segment. Hit when the two
   *    segments come within halfWidth + radius (segment-vs-capsule).
   *  - Everything else (arcs, circles, blade-sweep): the legacy point test is
   *    sampled along the target's path (current, previous, midpoint).
   */
  checkMeleeHit(attacker, target, weapon) {
    if (attacker.id === target.id || target.isDead) return false;

    const r = target.radius || 14;

    // Target swept path: previous tick-start → current position. Teleports
    // collapse to a point (see MAX_MELEE_SWEEP).
    let px = Number.isFinite(target.prevX) ? target.prevX : target.x;
    let py = Number.isFinite(target.prevY) ? target.prevY : target.y;
    const movedSq = (target.x - px) * (target.x - px) + (target.y - py) * (target.y - py);
    if (movedSq > MAX_MELEE_SWEEP * MAX_MELEE_SWEEP) { px = target.x; py = target.y; }
    const swept = (px !== target.x || py !== target.y);

    const lineTypes = new Set(['melee_line', 'melee_heavy_line', 'melee_precise_line']);
    if (lineTypes.has(weapon.type)) {
      const ax = attacker.x, ay = attacker.y;
      const bx = ax + Math.cos(attacker.angle) * weapon.range;
      const by = ay + Math.sin(attacker.angle) * weapon.range;
      const limit = (weapon.width / 2) + r;
      return segSegDistSq(ax, ay, bx, by, px, py, target.x, target.y) <= limit * limit;
    }

    if (this._meleePointHit(attacker, target.x, target.y, r, weapon)) return true;
    if (swept) {
      if (this._meleePointHit(attacker, px, py, r, weapon)) return true;
      if (this._meleePointHit(attacker, (px + target.x) / 2, (py + target.y) / 2, r, weapon)) return true;
    }
    return false;
  },

  /**
   * Legacy per-frame point hit test for one target position. Arc/circle/blade-
   * sweep weapons route through here (sampled along the swept path above).
   */
  _meleePointHit(attacker, tx, ty, r, weapon) {
    const dx = tx - attacker.x;
    const dy = ty - attacker.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Attacker custom weapon range + target boundary radius
    const maxRange = weapon.range + r;

    if (dist > maxRange) return false;

    const circleTypes = new Set(['melee_circle', 'melee_slam']);
    const arcTypes = new Set(['melee_arc', 'melee_heavy_arc', 'melee_sweet_arc', 'melee_backstab']);
    const lineTypes = new Set(['melee_line', 'melee_heavy_line', 'melee_precise_line']);

    // hitMode lets an arc weapon (sword, scythe…) use the greatsword's blade
    // sweep hit test while keeping its own damage type (sweet, crit, etc.).
    const hitType = weapon.hitMode || weapon.type;

    if (hitType === 'melee_blade_sweep') {
      // Greatsword: only the sweeping blade connects, not the whole fan. The
      // blade is a length-`range` bar sweeping ±halfSweep around the aim; a
      // target inside that band (and within range, already checked) is cut.
      // Just outside the band, allow the blade's physical thickness.
      const targetAngle = Math.atan2(dy, dx);
      let angleDiff = targetAngle - attacker.angle;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

      const halfSweep = ((weapon.angle || 150) * Math.PI) / 360;
      if (Math.abs(angleDiff) <= halfSweep) return true;

      // Perpendicular distance from the target to the nearest sweep-edge blade.
      const over = Math.abs(angleDiff) - halfSweep;
      const halfWidthLimit = (weapon.bladeHalfWidth || 0) + r;
      return dist * Math.sin(Math.min(over, Math.PI / 2)) <= halfWidthLimit;
    }

    if (circleTypes.has(weapon.type)) {
      // 360 degree attack
      return true;
    }

    if (arcTypes.has(weapon.type)) {
      if ((weapon.angle || 0) >= 360) {
        return true;
      }

      // Angular arc check (Sword/Gauntlets)
      // Angle between attacker aim direction and target vector
      const targetAngle = Math.atan2(dy, dx);

      // Calculate angular delta between target angle and weapon center angle
      let angleDiff = targetAngle - attacker.angle;

      // Norm to [-PI, PI]
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

      // Half weapon angle in radians
      const halfWeaponAngleRad = (weapon.angle * Math.PI) / 360;

      return Math.abs(angleDiff) <= halfWeaponAngleRad;
    }

    if (lineTypes.has(weapon.type)) {
      // Directional thrust rect check (Spear)
      // Project target vector onto the aim unit vector
      const uX = Math.cos(attacker.angle);
      const uY = Math.sin(attacker.angle);

      // Dot product: projection distance along spear direction
      const projLength = dx * uX + dy * uY;

      // Parallel check
      if (projLength < 0 || projLength > weapon.range + r) {
        return false;
      }

      // Cross product or perpendicular component tells orthogonal deviation from centerline
      const perpDiff = Math.abs(dx * uY - dy * uX);
      const halfWidthLimit = (weapon.width / 2) + r;

      return perpDiff <= halfWidthLimit;
    }

    return false;
  },

  /**
   * Projectile vs Player collides
   */
  checkProjectileHit(proj, target) {
    if (proj.ownerId === target.id || target.isDead) return false;

    const dx = target.x - proj.x;
    const dy = target.y - proj.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const hitRadius = (target.radius || 14) + proj.radius;
    return dist <= hitRadius;
  },

  /**
   * Hitscan helper: distance from a ray origin to the first contact with a
   * circle, or null when the ray misses. `dirX/dirY` must be a unit vector.
   * Used by the bow railgun skill to resolve an instant 50000px/s shot.
   */
  rayCircleHitDistance(ox, oy, dirX, dirY, cx, cy, r) {
    const mx = ox - cx;
    const my = oy - cy;
    const b = mx * dirX + my * dirY;
    const c = mx * mx + my * my - r * r;

    // Origin outside the circle and pointing away from it → no hit.
    if (c > 0 && b > 0) return null;

    const disc = b * b - c;
    if (disc < 0) return null;

    const t = -b - Math.sqrt(disc);
    return t < 0 ? 0 : t; // origin already inside → contact at distance 0
  },

  /**
   * Platformer AABB movement (Phase 1). Advance a body {x,y,vx,vy,halfW,halfH}
   * through `level` over `dt`, resolving against solid rects (X then Y) and
   * one-way platforms (block only when landing on their top from above). The
   * body is centred at (x,y). Set `opts.dropThrough` to fall through one-ways.
   * Returns contact flags { grounded, ceiling, wallLeft, wallRight }.
   *
   * Movement is sub-stepped so a fast body (dash) can't tunnel through thin
   * geometry between frames.
   */
  moveAndCollide(body, level, dt, opts = {}) {
    const out = { grounded: false, ceiling: false, wallLeft: false, wallRight: false };
    if (!level) { body.x += body.vx * dt; body.y += body.vy * dt; return out; }
    const solids = level.solids || [];
    const oneWays = level.oneWays || [];
    const hw = body.halfW, hh = body.halfH;

    // Sub-step so no single step moves more than ~a quarter of the box extent.
    const maxStep = Math.max(6, Math.min(hw, hh) * 0.5);
    const dist = Math.hypot(body.vx, body.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    const sdt = dt / steps;

    const overlaps = (l, t, r, b, rc) =>
      l < rc.x + rc.w && r > rc.x && t < rc.y + rc.h && b > rc.y;

    for (let s = 0; s < steps; s++) {
      // --- X axis ---
      body.x += body.vx * sdt;
      let l = body.x - hw, r = body.x + hw, t = body.y - hh, b = body.y + hh;
      for (const rc of solids) {
        if (!overlaps(l, t, r, b, rc)) continue;
        if (body.vx > 0) { body.x = rc.x - hw; out.wallRight = true; }
        else if (body.vx < 0) { body.x = rc.x + rc.w + hw; out.wallLeft = true; }
        body.vx = 0;
        l = body.x - hw; r = body.x + hw;
      }

      // --- Y axis ---
      const prevBottom = body.y + hh;
      body.y += body.vy * sdt;
      l = body.x - hw; r = body.x + hw; t = body.y - hh; b = body.y + hh;
      for (const rc of solids) {
        if (!overlaps(l, t, r, b, rc)) continue;
        if (body.vy > 0) { body.y = rc.y - hh; out.grounded = true; }
        else if (body.vy < 0) { body.y = rc.y + rc.h + hh; out.ceiling = true; }
        body.vy = 0;
        t = body.y - hh; b = body.y + hh;
      }
      // One-way platforms: only catch a body falling onto the top edge whose
      // feet were at/above the platform top at the start of this step.
      if (body.vy > 0 && !opts.dropThrough) {
        for (const rc of oneWays) {
          if (r <= rc.x || l >= rc.x + rc.w) continue;       // horizontal overlap
          if (prevBottom <= rc.y + 1 && (body.y + hh) >= rc.y) {
            body.y = rc.y - hh; body.vy = 0; out.grounded = true;
            b = body.y + hh;
          }
        }
      }
    }
    return out;
  },

  /**
   * Distance from a point to the arena boundary along a unit direction.
   * Returns Infinity if the direction never leaves the box.
   */
  rayToBoundsDistance(x, y, dirX, dirY, mapWidth, mapHeight) {
    const candidates = [];
    if (dirX > 0) candidates.push((mapWidth - x) / dirX);
    if (dirX < 0) candidates.push((0 - x) / dirX);
    if (dirY > 0) candidates.push((mapHeight - y) / dirY);
    if (dirY < 0) candidates.push((0 - y) / dirY);

    const dist = Math.min(...candidates.filter(v => v > 0 && Number.isFinite(v)));
    return Number.isFinite(dist) ? dist : Infinity;
  }
};
