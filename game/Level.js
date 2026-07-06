/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side-scroller level + platformer physics constants (Phase 1 of the top-down →
 * platformer pivot). A level is a set of axis-aligned rectangles in world px:
 *   - solids:  full collision (ground, walls, ceilings, pillars)
 *   - oneWays: one-way platforms — block only when landing on them from above;
 *              you can jump up through them and drop down (down + jump)
 * plus ground spawn points. Geometry is DETERMINISTIC from the size preset, so
 * the host sim and every client build the identical level with no extra sync —
 * the same philosophy the grass/water already use.
 *
 * Coordinates: a body is an axis-aligned box centred at (x, y) with half-extents
 * (halfW, halfH). Collision lives in Collision.moveAndCollide.
 */

// Platformer physics tuning (world px, seconds). Tuned for a snappy, floaty-ish
// feel with clear air control; revisit after playtests (Phase 1 deliverable).
export const PHYS = {
  gravity: 2600,        // downward accel (px/s²)
  maxFall: 1500,        // terminal fall speed (px/s)
  runSpeed: 360,        // top horizontal run speed (px/s)
  groundAccel: 3600,    // ground acceleration toward target run speed
  groundDecel: 4800,    // ground deceleration when no input
  airAccel: 2200,       // weaker air control
  airDecel: 1400,
  jumpSpeed: 880,       // initial upward jump velocity
  jumpCutMul: 0.45,     // releasing jump early multiplies remaining up-velocity
  coyoteMs: 90,         // grace window to still jump just after leaving ground
  jumpBufferMs: 110,    // press jump slightly before landing and it still fires
  // Dash (re-used from the old DashConfig idea, now a ground/air burst).
  dashSpeed: 980,
  dashMs: 150,
  dashCdMs: 700,
  dashIframeMs: 220,   // i-frames linger a touch past the dash for forgiveness
  // Pogo: a downward air-attack that connects with an enemy or surface bounces
  // the attacker back up (Hollow-Knight style).
  pogoSpeed: 780,
  // Grapple (harpoon F): zip toward the hooked point fast, gravity-free, then
  // exit with a little momentum so it chains into platforming.
  grappleSpeed: 1500,
  grappleMaxMs: 450,
  grappleExitVy: -260,   // small upward kick on arrival
};

export const TILE = 32;          // authoring grid unit
const GROUND_H = 2 * TILE;       // ground slab thickness
const WALL_W = 0.75 * TILE;      // side wall thickness
const PLAT_H = 0.5 * TILE;       // one-way platform thickness
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Level pixel size for a square arena-side preset. Side-scroller levels read
 * better a bit wider than tall, so width = side·1.4, height = side.
 */
export function levelDimensions(side) {
  return { width: Math.round(side * 1.4), height: side };
}

/**
 * Build the (single, Phase-1) test level: a symmetric layered arena — solid
 * ground + side walls, three tiers of one-way platforms mirrored left↔right,
 * and two ground spawn points. Deterministic from `side`.
 */
export function buildLevel(side, config = {}) {
  const { width: W, height: H } = levelDimensions(side);
  const solids = [];
  const oneWays = [];
  const itemSpawns = [];
  const platformDensity = config?.platforms || 'some';
  const platformShape = config?.platformShape || 'balanced';
  const coverDensity = config?.cover || 'none';

  // Outer shell: ground slab + left/right walls (no ceiling — open top).
  solids.push({ x: 0, y: H - GROUND_H, w: W, h: GROUND_H });          // ground
  solids.push({ x: 0, y: 0, w: WALL_W, h: H });                        // left wall
  solids.push({ x: W - WALL_W, y: 0, w: WALL_W, h: H });               // right wall

  const addItemSpawn = (x, surfaceY) => {
    itemSpawns.push({ x: Math.round(x), y: Math.round(surfaceY - 18) });
  };
  const addOneWay = (x, y, w) => {
    const r = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: PLAT_H };
    oneWays.push(r);
    addItemSpawn(r.x + r.w / 2, r.y);
    return r;
  };

  const coverPairs = ({ none: 0, few: 1, some: 2, many: 3 })[coverDensity] ?? 0;
  for (let i = 0; i < coverPairs; i++) {
    const k = i + 1;
    const inset = W * (0.23 + i * 0.13);
    const h = TILE * (2.2 + i * 0.65);
    const w = TILE * (1.15 + (i % 2) * 0.35);
    const y = Math.round(H - GROUND_H - h);
    solids.push({ x: Math.round(inset - w / 2), y, w: Math.round(w), h: Math.round(h) });
    solids.push({ x: Math.round(W - inset - w / 2), y, w: Math.round(w), h: Math.round(h) });
    if (k === 1 || coverDensity === 'many') {
      addItemSpawn(inset, y);
      addItemSpawn(W - inset, y);
    }
  }

  const platformCount = ({ none: 0, few: 2, some: 4, many: 6 })[platformDensity] ?? 4;
  const platW = Math.round(clamp(W * 0.18, 130, 260));
  const cx = W / 2;
  const platformSlots = [];
  // Tier heights are kept within a single jump's reach (jump apex ≈
  // jumpSpeed²/2·gravity ≈ 149px ≈ 4.6 tiles): first tier ~3 tiles up and each
  // step ~2.5 tiles, so every platform is comfortably reachable by jumping alone.
  if (platformShape === 'stairs') {
    for (let i = 0; i < platformCount; i++) {
      const sideSign = i % 2 === 0 ? -1 : 1;
      const step = Math.floor(i / 2);
      platformSlots.push({
        x: cx + sideSign * W * (0.18 + step * 0.09) - platW / 2,
        y: H - GROUND_H - (2.8 + i * 1.2) * TILE,
        w: platW
      });
    }
  } else if (platformShape === 'towers') {
    const xs = [W * 0.24, W * 0.76, W * 0.38, W * 0.62, W * 0.50, W * 0.50];
    for (let i = 0; i < platformCount; i++) {
      platformSlots.push({
        x: xs[i] - platW / 2,
        y: H - GROUND_H - (3.0 + Math.floor(i / 2) * 2.3) * TILE,
        w: i >= 4 ? platW * 0.9 : platW
      });
    }
  } else {
    const tiers = [
      { y: H - GROUND_H - 3.0 * TILE, dx: W * 0.25 },
      { y: H - GROUND_H - 5.6 * TILE, dx: W * 0.12 },
      { y: H - GROUND_H - 8.2 * TILE, dx: 0 },
    ];
    for (const t of tiers) {
      if (platformSlots.length >= platformCount) break;
      if (t.dx === 0) {
        platformSlots.push({ x: cx - platW / 2, y: t.y, w: platW });
      } else {
        platformSlots.push({ x: cx - t.dx - platW / 2, y: t.y, w: platW });
        if (platformSlots.length < platformCount) platformSlots.push({ x: cx + t.dx - platW / 2, y: t.y, w: platW });
      }
    }
  }

  for (const slot of platformSlots.slice(0, platformCount)) {
    const y = slot.y;
    if (y < TILE * 2.5) break;
    addOneWay(clamp(slot.x, WALL_W + TILE, W - WALL_W - slot.w - TILE), y, slot.w);
  }

  // Spawn candidates are surface points. The game lifts the body by halfH.
  const spawnY = H - GROUND_H;
  const groundSpawnXs = [0.16, 0.30, 0.50, 0.70, 0.84];
  const spawns = groundSpawnXs.map(k => ({ x: Math.round(W * k), y: spawnY }));
  for (const p of oneWays) {
    spawns.push({ x: Math.round(p.x + p.w / 2), y: p.y });
  }

  return { width: W, height: H, solids, oneWays, spawns, itemSpawns };
}
