/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Weapons, getEffectiveWeapon, SkillConfig, DashConfig } from './Weapons.js';
import { SpriteAtlas, SPRITE_MANIFEST, CHAR_FRAME, CHAR_COLS, CHAR_ROW, WEAPON_SPRITE_TUNE, WEAPON_TUNE_DEFAULT } from './SpriteAtlas.js';
import { drawStickman, WEAPON_STICK_COLOR } from './Stickman.js';
import { StickAnimator } from './Motion.js';
import { sanitizeLook } from './StickLook.js';
import { resolveWeaponImage } from './WeaponImages.js';
import { drawProjectileShape } from './ProjectileArt.js';

// Pixel-detected frame x-ranges of fx/slash2 (SpriteSheetSlash02.png, H=50).
// The sheet is not a uniform grid; these are the real crescent frames
// (appear → grow → full → full → shrink → wisp).
const SLASH2_FRAMES = [[0, 26], [66, 120], [134, 193], [205, 263], [290, 329], [374, 395]];

// SpriteSheetCircular.png (378×55) is the hand-cut 360-slash animation: 6
// frames on a clean 63px grid, each frame's own canvas centred in its cell.
// We draw the WHOLE cell centred on the player (not the tight bbox) so the
// ring keeps the vertical sweep the artist baked into each frame. Aspect ratio
// is preserved (no square stretch). [sx, sy, w, h] in sheet px.
const CIRC_FRAMES = [[0, 0, 63, 55], [63, 0, 63, 55], [126, 0, 63, 55], [189, 0, 63, 55], [252, 0, 63, 55], [315, 0, 63, 55]];
const CIRC_CELL = 63;   // reference full-ring size; scale = targetSize / CIRC_CELL

// Cover obstacle textures, cut from the nature tileset (tile/nature). Each entry
// is [sx, sy, sw, sh] in sheet px — a FULL sprite island (tight opaque bbox, so
// nothing is ever sliced). These are all SOLID boulders/rocks/stumps (no leafy
// bushes), so a cover tile reads instantly as something you can't walk through.
// Each tile deterministically picks one (+ flip) from its world position, so the
// look is varied but identical on every client.
const COVER_SPRITES = [
  [193, 83, 61, 44],   // 0 boulder pile (big)
  [210, 132, 29, 27],  // 1 round boulder
  [1, 134, 30, 23],    // 2 rock
  [33, 134, 30, 23],   // 3 rock (reddish)
  [64, 145, 32, 30],   // 4 tree stump
  [240, 192, 80, 32],  // 5 rock cluster (wide)
];
// Which sprites suit each biome, and an optional colour wash so the same rocks
// read as dry sandstone (desert) or frosted stone (snow).
const COVER_GROUP = { day: 'green', night: 'green', dawn: 'green', desert: 'desert', snow: 'snow' };
const BIOME_COVER = {
  green:  [0, 1, 2, 4],   // mossy boulders + a stump (forest/grass)
  desert: [0, 1, 3, 5],   // sandstone boulders + a rock cluster
  snow:   [0, 1, 2, 3],   // bare rocks (frosted via the tint below)
};
const COVER_TINT = { desert: 'rgba(225,182,120,0.30)', snow: 'rgba(206,228,246,0.55)' };

// Biome floor palettes for the baked field: base colour, the two mottle fleck
// colours, whether to scatter green grass tufts, and an optional translucent
// full-field wash for atmosphere. 'day' reproduces the original green field.
const BIOME_FLOOR = {
  day:    { base: '#adbc3a', mDark: 'rgba(150,170,46,0.35)',  mLight: 'rgba(196,210,92,0.30)',  tufts: true,  wash: null },
  night:  { base: '#3c4a52', mDark: 'rgba(18,28,46,0.42)',    mLight: 'rgba(96,116,134,0.22)',  tufts: true,  wash: 'rgba(26,38,84,0.32)' },
  dawn:   { base: '#9fae54', mDark: 'rgba(150,110,80,0.28)',  mLight: 'rgba(232,202,150,0.30)', tufts: true,  wash: 'rgba(255,156,110,0.18)' },
  desert: { base: '#d9c38a', mDark: 'rgba(188,158,100,0.42)', mLight: 'rgba(242,226,182,0.36)', tufts: false, wash: 'rgba(230,200,140,0.10)' },
  snow:   { base: '#e9eef3', mDark: 'rgba(176,198,220,0.42)', mLight: 'rgba(255,255,255,0.55)', tufts: false, wash: 'rgba(200,222,245,0.12)' },
};

// Water body + frozen-ice colours (the snow biome freezes water into ice).
const WATER_COLORS = {
  water: { body: '#2f6d96', band: 'rgba(120,180,210,0.35)', edge: 'rgba(207,233,245,0.85)' },
  ice:   { body: '#bcd6e4', band: 'rgba(255,255,255,0.40)', edge: 'rgba(255,255,255,0.75)' },
};

// Side-scroller sky gradients (top → bottom) per biome.
const PLATFORMER_SKY = {
  day:    ['#9fd8ef', '#dff3e6'],
  night:  ['#161d33', '#2b3a55'],
  dawn:   ['#f4a06a', '#ffe6c8'],
  desert: ['#f1cf8c', '#f8edd0'],
  snow:   ['#cfe3f2', '#eef6fb'],
};
// Parallax hill layers (far→near): colour, scroll factor, bump amplitude/period.
const PLATFORMER_HILLS = {
  day:    [{ color: '#bfe0c2', factor: 0.15, amp: 90, period: 520, baseY: 0.72 }, { color: '#9ecb9f', factor: 0.34, amp: 60, period: 340, baseY: 0.84 }],
  night:  [{ color: '#27324d', factor: 0.15, amp: 90, period: 520, baseY: 0.72 }, { color: '#1c2740', factor: 0.34, amp: 60, period: 340, baseY: 0.84 }],
  dawn:   [{ color: '#e7a487', factor: 0.15, amp: 90, period: 520, baseY: 0.72 }, { color: '#cf8b75', factor: 0.34, amp: 60, period: 340, baseY: 0.84 }],
  desert: [{ color: '#e6c98f', factor: 0.15, amp: 70, period: 560, baseY: 0.74 }, { color: '#d6b878', factor: 0.34, amp: 46, period: 360, baseY: 0.86 }],
  snow:   [{ color: '#dbe9f4', factor: 0.15, amp: 80, period: 540, baseY: 0.73 }, { color: '#c5d8e8', factor: 0.34, amp: 52, period: 360, baseY: 0.85 }],
};

// Rounded-rectangle path helper (platformer body draw).
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const WEAPON_SPRITE_META = {
  sword: { src: '/assets/weapons/sword.png', scale: 0.55, anchorX: 0.24, anchorY: 0.5, angleOffset: 0 },
  axe: { src: '/assets/weapons/axe.png', scale: 0.64, anchorX: 0.22, anchorY: 0.52, angleOffset: 0, noAimFlip: true },
  bow: { src: '/assets/weapons/bow.png', scale: 0.58, anchorX: 0.32, anchorY: 0.5, angleOffset: 0 },
  spear: { src: '/assets/weapons/spear.png', scale: 0.68, anchorX: 0.2, anchorY: 0.5, angleOffset: 0 },
  gauntlet: { src: '/assets/weapons/gauntlet.png', scale: 0.42, anchorX: 0.36, anchorY: 0.52, angleOffset: 0 },
  greatsword: { src: '/assets/weapons/greatsword.png', scale: 0.76, anchorX: 0.84, anchorY: 0.52, angleOffset: Math.PI, noAimFlip: true },
  scythe: { src: '/assets/weapons/scythe.png', scale: 0.82, anchorX: 0.18, anchorY: 0.72, angleOffset: 0, noAimFlip: true },
  dagger: { src: '/assets/weapons/dagger.png', scale: 0.44, anchorX: 0.26, anchorY: 0.5, angleOffset: 0 },
  rapier: { src: '/assets/weapons/rapier.png', scale: 0.56, anchorX: 0.18, anchorY: 0.5, angleOffset: 0 },
  hammer: { src: '/assets/weapons/hammer.png', scale: 0.68, anchorX: 0.22, anchorY: 0.56, angleOffset: 0 },
  matchlock: { src: '/assets/weapons/matchlock.png', scale: 0.62, anchorX: 0.2, anchorY: 0.5, angleOffset: 0 },
  katana: { src: '/assets/weapons/katana.png', scale: 0.62, anchorX: 0.2, anchorY: 0.5, angleOffset: 0, noAimFlip: true },
  magicstaff: { src: '/assets/weapons/magicstaff.png', scale: 0.62, anchorX: 0.2, anchorY: 0.5, angleOffset: 0 },
  sniper: { src: '/assets/weapons/sniper.png', scale: 0.72, anchorX: 0.18, anchorY: 0.5, angleOffset: 0 }
};
const PROJECTILE_SPRITE_META = {
  arrow: { src: '/assets/ninja/weapon/arrow.png', scale: 1.65, anchorX: 0.5, anchorY: 0.5, angleOffset: Math.PI / 4 }
};
const WEAPON_ASSET_VERSION = '20260625a';
const WS_TINTS = { ember: '#ff3d3d', frost: '#5fd3ff', void: '#b14bff' };

// The low-res "pixel filter" (Task 4) is disabled by user request — the world
// renders crisp at full resolution. Flip to true to bring the chunky look back.
const PIXEL_ART_ENABLED = false;

// Fantasy lighting rule (Task 4-4): only arcane casts bloom. Effects of these
// types keep their glow; every other combat effect (steel arcs, powder shots)
// renders flat so it reads as physical rather than neon.
const MAGIC_EFFECT_TYPES = new Set([
  'explosion', 'lifebound_heal', 'icicle_load',
]);

// Only greatsword uses an idle angle offset; other idle weapons point at aim.
const WEAPON_IDLE_POSE = {
  greatsword: -0.7
};

export function resolveWeaponSpriteDrawAngle(weaponType, playerAngle, weaponAngle, active) {
  const aimAngle = Number.isFinite(playerAngle) ? playerAngle : 0;
  const motionAngle = Number.isFinite(weaponAngle) ? weaponAngle : aimAngle;
  if (active) {
    if (weaponType === 'bow') return aimAngle;
    if (weaponType === 'scythe') return motionAngle + 0.35;
    return motionAngle;
  }
  if (weaponType === 'greatsword') return aimAngle + WEAPON_IDLE_POSE.greatsword;
  return aimAngle;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.lastTime = Date.now();
    this.lastPlayersInfo = {};
    this.weaponSprites = {};
    this.projectileSprites = {};
    this._glow = 1;     // shadowBlur multiplier — set to 0 by performance mode
    this._perf = false; // performance mode: glows + particles disabled

    // --- Pixel-art pipeline -------------------------------------------------
    // The world is drawn to a low-resolution offscreen buffer, then scaled up to
    // the main canvas with smoothing OFF so every pixel becomes a chunky square.
    // Drawing uses the SAME logical coordinates (camera.toScreen output), so the
    // camera/input/coordinate system is completely unchanged — only the internal
    // raster resolution drops. HUD overlays are drawn afterward at full res.
    this._pixelScale = 2;        // world raster ≈ 1/2 res (3 in performance mode)
    this.offscreen = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    this.offCtx = this.offscreen ? this.offscreen.getContext('2d') : null;

    this._initWeaponSprites();
    this._initProjectileSprites();

    // Ninja Adventure sprite atlas (Task 4). Loads async + fails soft: until it
    // is ready (or if an asset 404s) every sprite draw falls back to the legacy
    // shape rendering, so the game is always playable.
    this.atlas = new SpriteAtlas('/assets/ninja');
    this.atlas.load(SPRITE_MANIFEST).catch(() => {});
    this._charTintCache = {};   // tinted body frames keyed by skin+color
    this._charPrev = {};        // last positions, to detect movement for the walk cycle
    this._charAnim = {};        // per-player walk frame state
    this._stick = new StickAnimator();   // procedural stickman animation state (per player)
  }

  /**
   * Side-scroller render path (Phase 1). Sky + parallax background, the level
   * geometry (solids / one-way platforms), and players drawn in side view
   * (facing follows aim, foot shadow, nickname + HP). Full-res, direct to the
   * main canvas — independent of the legacy top-down render() pipeline.
   */
  renderPlatformer(state, localPlayerId, camera, level, visualSettings = {}) {
    const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    const now = Date.now();
    const biome = state.biome || 'day';
    this._perf = !!visualSettings.performanceMode;
    this._glow = this._perf ? 0 : 1;

    // Sky gradient.
    const sky = PLATFORMER_SKY[biome] || PLATFORMER_SKY.day;
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);

    // Parallax hills (slower than the camera for depth).
    this._drawParallax(ctx, camera, cw, ch, biome);

    const shake = camera.getShakeOffset ? camera.getShakeOffset(now) : { x: 0, y: 0 };
    ctx.save();
    ctx.translate(shake.x || 0, shake.y || 0);

    if (level) this._drawLevel(ctx, camera, cw, ch, level, biome);
    if (state.storm) this._drawPlatformerZone(ctx, camera, cw, ch, state.storm, now);
    if (state.healingItems && state.healingItems.length) this._drawHealingItems(ctx, camera, cw, ch, state.healingItems, now);
    if (state.mines && state.mines.length) this._drawMines(ctx, camera, cw, ch, state.mines, localPlayerId, now);
    if (state.firePatches && state.firePatches.length) this._drawFirePatches(ctx, camera, cw, ch, state.firePatches, now);
    if (state.effects && state.effects.length) {
      this._drawEffects(ctx, camera, cw, ch, state.effects, state.players || {}, localPlayerId, visualSettings);
      this._drawPlatformerEffects(ctx, camera, cw, ch, state.effects, now);
    }
    // Local-only juice particles (hit sparks / death bursts), drawn over the level.
    if (state.localFx && state.localFx.length) {
      this._drawPlatformerEffects(ctx, camera, cw, ch, state.localFx, now);
    }
    if (state.projectiles && state.projectiles.length) this._drawProjectiles(ctx, camera, cw, ch, state.projectiles, state.players || {});

    const players = state.players || {};
    // 모션 재생 block triggers: resolve tag→motion from each player's synced
    // weapon def and fire the one-shot pose overlay (idempotent per effect).
    this._stick.consumeTriggers(state.effects || [], players, now);
    const activeAttacks = this._getActiveAttacks(state.effects || []);
    for (const id in players) {
      const p = players[id];
      if (!p || p.isDead) continue;
      this._drawPlatformerPlayer(ctx, camera, cw, ch, p, id === localPlayerId, now, activeAttacks[id] || activeAttacks[p.id] || null);
    }
    if (state.damagePopups && state.damagePopups.length) {
      this._drawDamagePopups(ctx, camera, cw, ch, state.damagePopups, now);
    }
    ctx.restore();

    if (camera.tracking && state.players && level) {
      this._drawMinimap(ctx, cw, ch, state.players, localPlayerId, level.width, level.height, state);
      this._drawOffscreenEnemyArrows(ctx, camera, cw, ch, state.players, localPlayerId);
    }
    if (state.hitFlash) this._drawHitVignette(ctx, cw, ch, state.hitFlash);
    if (state.zoneOutside) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 120);
      this._drawZoneWarning(ctx, cw, ch, pulse);
    } else if (state.storm && Number.isFinite(state.storm.floorY)) {
      // Flood-proximity glow (P4): the lava is closing on the local player's
      // feet — a red glow swells from the bottom of the screen roughly a second
      // before contact, so "왜 죽었는지 모르는 죽음" doesn't happen.
      const me = players[localPlayerId];
      if (me && !me.isDead) {
        const gap = state.storm.floorY - (me.y + (me.halfH || 20));
        if (gap > 0 && gap < 140) {
          const a = (1 - gap / 140) * 0.55;
          const grad = ctx.createLinearGradient(0, ch * 0.55, 0, ch);
          grad.addColorStop(0, 'rgba(255,64,32,0)');
          grad.addColorStop(1, `rgba(255,64,32,${a.toFixed(3)})`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, Math.floor(ch * 0.55), cw, Math.ceil(ch * 0.45));
        }
      }
    }

    // Desktop aim reticle at the cursor.
    if (state.cursorPos) this._drawReticle(ctx, state.cursorPos);
  }

  _drawPlatformerZone(ctx, camera, cw, ch, storm, now) {
    if (storm.kind !== 'platformer_rise') {
      this._drawZone(ctx, camera, cw, ch, storm, now);
      return;
    }

    const mapW = storm.mapWidth || 0;
    const mapH = storm.mapHeight || 0;
    const leftX = Number.isFinite(storm.leftX) ? storm.leftX : 0;
    const rightX = Number.isFinite(storm.rightX) ? storm.rightX : mapW;
    const floorY = Number.isFinite(storm.floorY) ? storm.floorY : mapH + 96;
    const bottom = Math.max(mapH + 220, floorY + 220);
    const z = camera.zoom || 1;

    const fillRectWorld = (x, y, w, h, color) => {
      if (w <= 0 || h <= 0) return;
      const a = camera.toScreen(x, y, cw, ch);
      const b = camera.toScreen(x + w, y + h, cw, ch);
      ctx.fillStyle = color;
      ctx.fillRect(Math.floor(a.x), Math.floor(a.y), Math.ceil(b.x - a.x), Math.ceil(b.y - a.y));
    };

    ctx.save();
    const pulse = 0.55 + 0.45 * Math.sin(now / 180);
    fillRectWorld(leftX, floorY, rightX - leftX, bottom - floorY, `rgba(220,48,26,${0.45 + pulse * 0.18})`);
    fillRectWorld(-160, -80, leftX + 160, bottom + 160, 'rgba(132,30,24,0.50)');
    fillRectWorld(rightX, -80, mapW - rightX + 160, bottom + 160, 'rgba(132,30,24,0.50)');

    const drawLineY = (y, color, dashed = false, width = 3) => {
      const a = camera.toScreen(leftX, y, cw, ch);
      const b = camera.toScreen(rightX, y, cw, ch);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, width * z);
      if (dashed) ctx.setLineDash([8 * z, 6 * z]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);
    };
    // Surface line blinks hard while the lava is actively moving (P4 — the
    // boundary must be unmissable), steadier while parked.
    const moving = storm.phase === 'warning' || storm.phase === 'shrinking';
    const blink = moving ? 0.55 + 0.45 * Math.sin(now / 110) : 0.9;
    drawLineY(floorY, `rgba(255,214,92,${blink})`, false, moving ? 5 : 3);
    if (storm.phase === 'warning' || storm.phase === 'shrinking') {
      if (Number.isFinite(storm.nextFloorY) && Math.abs(storm.nextFloorY - floorY) > 2) {
        drawLineY(storm.nextFloorY, 'rgba(255,245,157,0.85)', true);
      }
    }

    const top = camera.toScreen(leftX, 0, cw, ch);
    const bottomLeft = camera.toScreen(leftX, mapH, cw, ch);
    const topRight = camera.toScreen(rightX, 0, cw, ch);
    const bottomRight = camera.toScreen(rightX, mapH, cw, ch);
    ctx.strokeStyle = 'rgba(255,138,76,0.85)';
    ctx.lineWidth = Math.max(2, 2 * z);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y); ctx.lineTo(bottomLeft.x, bottomLeft.y);
    ctx.moveTo(topRight.x, topRight.y); ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.stroke();
    ctx.restore();
  }

  _drawPlatformerEffects(ctx, camera, cw, ch, effects, now) {
    const z = camera.zoom || 1;
    ctx.save();
    for (const e of effects) {
      if (!e || !e.type) continue;
      const life = Math.max(0, Math.min(1, (now - e.timestamp) / Math.max(1, e.lifetime || 1)));
      if (life >= 1) continue;
      const scr = camera.toScreen(e.x, e.y, cw, ch);
      if (e.type === 'landing_dust') {
        const alpha = 1 - life;
        const spread = (12 + life * 34) * (e.strength || 1) * z;
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = '#d7c38c';
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.ellipse(scr.x + i * spread * 0.34, scr.y - life * 5 * z, spread * 0.34, 5 * z * alpha, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (e.type === 'danger_pop') {
        const alpha = 1 - life;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#ffcf5a';
        ctx.lineWidth = Math.max(2, 3 * z * alpha);
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, (10 + life * 34) * z, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'hit_spark' || e.type === 'death_burst') {
        // Pixel (square) particle shower. Each part flies out along its own unit
        // vector, decelerating, with a little gravity, fading as it ages.
        const tSec = (now - e.timestamp) / 1000;
        const alpha = 1 - life;
        const grav = 520;
        const isDeath = e.type === 'death_burst';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = e.color || '#ffe9a8';
        ctx.imageSmoothingEnabled = false;
        for (const pt of (e.parts || [])) {
          const decel = Math.max(0, 1 - tSec * 1.6);
          const px = e.x + pt.ox * pt.sp * tSec * decel;
          const py = e.y + pt.oy * pt.sp * tSec * decel + 0.5 * grav * tSec * tSec;
          const s = pt.sz * z * (isDeath ? 1.2 : 1);
          const sc = camera.toScreen(px, py, cw, ch);
          ctx.fillRect(sc.x - s / 2, sc.y - s / 2, s, s);
        }
        // Death gets a quick white flash ring at the origin for extra pop.
        if (isDeath && life < 0.4) {
          ctx.globalAlpha = (1 - life / 0.4) * 0.8;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(2, 3 * z);
          ctx.beginPath();
          ctx.arc(scr.x, scr.y, (8 + life * 70) * z, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  _drawParallax(ctx, camera, cw, ch, biome) {
    const layers = PLATFORMER_HILLS[biome] || PLATFORMER_HILLS.day;
    const z = camera.zoom || 1;
    for (let li = 0; li < layers.length; li++) {
      const { color, factor, amp, period, baseY } = layers[li];
      ctx.fillStyle = color;
      // Horizon tied loosely to camera Y so it feels connected; hills scroll in X.
      const horizon = ch * baseY - camera.y * factor * z * 0.25;
      const off = -(camera.x * factor * z) % period;
      ctx.beginPath();
      ctx.moveTo(-period, ch);
      for (let x = -period + off; x < cw + period; x += period) {
        ctx.quadraticCurveTo(x + period / 2, horizon - amp, x + period, horizon);
      }
      ctx.lineTo(cw + period, ch);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawLevel(ctx, camera, cw, ch, level, biome) {
    const floor = BIOME_FLOOR[biome] || BIOME_FLOOR.day;
    const cap = floor.base;
    const rectScreen = (r) => {
      const a = camera.toScreen(r.x, r.y, cw, ch);
      const b = camera.toScreen(r.x + r.w, r.y + r.h, cw, ch);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    };
    const onScreen = (s) => !(s.x + s.w < -4 || s.x > cw + 4 || s.y + s.h < -4 || s.y > ch + 4);
    const hash = (a, b) => {
      let h = (Math.floor(a) * 374761393 + Math.floor(b) * 668265263) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const drawProceduralTexture = (r, s, kind = 'stone') => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.round(s.x), Math.round(s.y), Math.ceil(s.w), Math.ceil(s.h));
      ctx.clip();

      const z = camera.zoom || 1;
      const cell = Math.max(6, Math.round((kind === 'top' ? 12 : 18) * z));
      for (let y = Math.floor(s.y / cell) * cell; y < s.y + s.h; y += cell) {
        for (let x = Math.floor(s.x / cell) * cell; x < s.x + s.w; x += cell) {
          const wx = r.x + (x - s.x) / z;
          const wy = r.y + (y - s.y) / z;
          const n = hash(wx / cell, wy / cell);
          if (kind === 'top') {
            if (n > 0.74) ctx.fillStyle = floor.mLight;
            else if (n < 0.20) ctx.fillStyle = floor.mDark;
            else continue;
            ctx.fillRect(x, y, cell, Math.max(2, Math.round(cell * 0.35)));
          } else {
            ctx.fillStyle = n > 0.58 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.11)';
            ctx.fillRect(x, y, cell, cell);
          }
        }
      }

      const detailCount = Math.max(4, Math.min(40, Math.round((r.w * r.h) / (kind === 'top' ? 11000 : 18000))));
      for (let i = 0; i < detailCount; i++) {
        const n1 = hash(r.x / 17 + i * 19, r.y / 23 + i * 7);
        const n2 = hash(r.x / 29 + i * 11, r.y / 31 + i * 13);
        const x = s.x + n1 * s.w;
        const y = s.y + n2 * s.h;
        if (kind === 'top') {
          const len = (6 + hash(i, r.x) * 11) * z;
          const h = (2 + hash(i, r.y) * 5) * z;
          ctx.strokeStyle = floor.tufts ? 'rgba(64,108,38,0.45)' : floor.mDark;
          ctx.lineWidth = Math.max(1, z);
          ctx.beginPath();
          ctx.moveTo(x, s.y + Math.min(s.h - 1, Math.max(1, y - s.y)));
          ctx.lineTo(x + len * 0.35, y - h);
          ctx.lineTo(x + len, y);
          ctx.stroke();
        } else {
          const len = (10 + hash(i, r.w) * 24) * z;
          ctx.strokeStyle = hash(i, r.h) > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.18)';
          ctx.lineWidth = Math.max(1, z * 0.75);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + len, y + (hash(i, r.y) - 0.5) * 9 * z);
          ctx.stroke();
        }
      }
      ctx.restore();
    };
    const drawTopDetails = (r, s, capH) => {
      ctx.fillStyle = cap;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.ceil(s.w), capH);
      drawProceduralTexture(r, { x: s.x, y: s.y, w: s.w, h: capH }, 'top');
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.ceil(s.w), Math.max(1, capH * 0.4));
    };

    // Solids: stone body + a grassy/biome cap along the top edge.
    for (const r of level.solids) {
      const s = rectScreen(r); if (!onScreen(s)) continue;
      const x = Math.round(s.x), y = Math.round(s.y), w = Math.ceil(s.w), h = Math.ceil(s.h);
      ctx.fillStyle = '#3b3a44'; ctx.fillRect(x, y, w, h);
      drawProceduralTexture(r, s, 'stone');
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x, y + Math.min(10, h * 0.4), w, h);
      const capH = Math.max(3, Math.round(8 * (camera.zoom || 1)));
      drawTopDetails(r, s, capH);
    }
    // One-way platforms: thin wooden planks with a bright top lip.
    for (const r of level.oneWays) {
      const s = rectScreen(r); if (!onScreen(s)) continue;
      const x = Math.round(s.x), y = Math.round(s.y), w = Math.ceil(s.w), h = Math.max(4, Math.ceil(s.h));
      ctx.fillStyle = '#7a5230'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#9c6b3f'; ctx.fillRect(x, y, w, Math.max(2, h * 0.45));
      drawProceduralTexture(r, s, 'wood');
      ctx.fillStyle = 'rgba(255,235,200,0.35)'; ctx.fillRect(x, y, w, 2);
    }
  }

  _drawPlatformerPlayer(ctx, camera, cw, ch, p, isLocal, now, activeAttack = null) {
    const z = camera.zoom || 1;
    const hw = (p.halfW || 13), hh = (p.halfH || 20);
    const pos = camera.toScreen(p.x, p.y, cw, ch);
    const feet = camera.toScreen(p.x, p.y + hh, cw, ch);
    const bw = hw * 2 * z, bh = hh * 2 * z;
    // Facing follows the aim angle (always synced), so remote players face right.
    const face = Math.cos(p.angle || 0) >= 0 ? 1 : -1;

    // Foot shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(pos.x, feet.y, bw * 0.55, bh * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    const motion = this._getAttackMotion(p, activeAttack);
    const bodyScr = {
      x: pos.x + motion.bodyX,
      y: pos.y + motion.bodyY
    };
    const radius = 14 * z;

    if (p.dashTrailColor && p.iframeTimeLeft > 0) {
      const t = Math.min(1, p.iframeTimeLeft / 0.2);
      ctx.save();
      ctx.shadowColor = p.dashTrailColor;
      ctx.shadowBlur = this._glow ? 14 : 0;
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.22 * t / i;
        ctx.fillStyle = p.dashTrailColor;
        ctx.beginPath();
        ctx.ellipse(
          bodyScr.x - Math.cos(p.angle || 0) * i * 8 * z,
          bodyScr.y - Math.sin(p.angle || 0) * i * 3 * z,
          radius * (1 + i * 0.16),
          radius * 0.72,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    }

    // Dash i-frame blink.
    const blink = (p.iframeTimeLeft > 0) ? (0.45 + 0.4 * Math.abs(Math.sin(now / 40))) : 1;
    ctx.globalAlpha = blink;

    const bodyColor = p.color || '#cdd3da';
    const accent = p.accentColor || '#ffffff';
    this._drawCostumeEffect(ctx, bodyScr, p, radius, now);

    // Procedural stick-figure body (Phase A stickman pivot): replaces the sprite
    // sheet + in-hand weapon sprite. The motion only chooses joint angles — all
    // combat stays code-defined. The weapon is drawn in-hand by the stickman in
    // its weapon colour, biased to the (synced) aim so it reads in combat.
    const { pose, weaponFlip } = this._stick.sample(p, now);
    const look = sanitizeLook(p.stickLook);
    // A workshop weapon's custom image (resolved locally from the small id) rides
    // on the stick's hand instead of the procedural bar.
    const wv = p.workshopWeapon && p.workshopWeapon.weaponVisual;
    const wimg = wv && wv.imageId ? resolveWeaponImage(wv.imageId) : null;
    drawStickman({
      ctx, x: bodyScr.x, y: bodyScr.y, scale: radius, facing: face,
      color: look.color || bodyColor, accent: '#0d0a06', lineW: look.lineW,
      pose, aimAngle: p.angle || 0, weapon: p.weapon,
      headShape: look.head, accessory: look.accessory,
      weaponImage: wimg && wimg.img && wimg.img.complete && wimg.img.naturalWidth ? wimg.img : null,
      weaponImageSize: wimg ? wimg.size : 2.0,
      weaponImageAnchors: wimg ? wimg.anchors : null,
      weaponFlip: !!weaponFlip,
      weaponDual: !!(wv && wv.dual),
    });

    if (p.burnTimeLeft > 0) this._drawBurnFlames(ctx, bodyScr, radius, z);
    if (p.pendingIcicles > 0) this._drawLoadedIcicles(ctx, bodyScr, p.pendingIcicles, radius, z);
    this._drawCostumeDecoration(ctx, bodyScr, p, radius, now);

    ctx.globalAlpha = 1;

    // Nameplate + HP bar above the head.
    const nameY = bodyScr.y - radius * 2.15;
    ctx.font = `${Math.max(10, Math.round(11 * z))}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = isLocal ? '#ffe9a8' : '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
    ctx.strokeText(p.nickname || '', bodyScr.x, nameY);
    ctx.fillText(p.nickname || '', bodyScr.x, nameY);
    this._drawStatusIcons(ctx, bodyScr, p, radius);
    const hpW = bw * 1.2, hpH = Math.max(3, 4 * z), hpX = pos.x - hpW / 2, hpY = nameY + 4 * z;
    const frac = Math.max(0, Math.min(1, (p.hp || 0) / (p.maxHp || 100)));
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(hpX - 1, hpY - 1, hpW + 2, hpH + 2);
    ctx.fillStyle = frac > 0.5 ? '#5fbf4f' : frac > 0.25 ? '#d9a441' : '#c0392b';
    ctx.fillRect(hpX, hpY, hpW * frac, hpH);
    ctx.textAlign = 'left';
  }

  _drawReticle(ctx, cursor) {
    const x = cursor.x, y = cursor.y, s = 9;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)'; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - s, y); ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y); ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s); ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3); ctx.lineTo(x, y + s);
    ctx.stroke();

    ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(x - s, y); ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y); ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s); ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3); ctx.lineTo(x, y + s);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#7df09a'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.88)'; ctx.stroke();
    ctx.restore();
  }

  _initWeaponSprites() {
    if (typeof Image === 'undefined') return;
    Object.entries(WEAPON_SPRITE_META).forEach(([key, meta]) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = `${meta.src}?v=${WEAPON_ASSET_VERSION}`;
      this.weaponSprites[key] = { image, meta, ready: false };
      image.onload = () => {
        this.weaponSprites[key].ready = true;
      };
    });
  }

  _initProjectileSprites() {
    if (typeof Image === 'undefined') return;
    Object.entries(PROJECTILE_SPRITE_META).forEach(([key, meta]) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = `${meta.src}?v=${WEAPON_ASSET_VERSION}`;
      this.projectileSprites[key] = { image, meta, ready: false };
      image.onload = () => {
        this.projectileSprites[key].ready = true;
      };
    });
  }

  /**
   * Main render call
   */
  render(gameState, localPlayerId, camera, mapWidth, mapHeight, visualSettings = {}) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    const nowTime = Date.now();
    const dt = Math.min((nowTime - this.lastTime) / 1000, 0.1);
    this.lastTime = nowTime;
    const activeEffects = gameState.effects || [];

    // Performance mode kills the two heaviest canvas costs: glows (every
    // shadowBlur is multiplied by _glow) and particles. In performance mode the
    // pixel raster also drops further (bigger pixels = fewer of them = cheaper).
    this._perf = !!visualSettings.performanceMode;
    this._glow = this._perf ? 0 : 1;
    this._pixelScale = this._perf ? 3 : 2;

    // --- Set up the low-res world buffer. All world drawing below targets this
    // offscreen context via `ctx`; it shares the SAME logical coordinate space
    // as the main canvas (a base scale transform maps [0,cw]x[0,ch] onto the
    // smaller buffer), so camera math and the _draw* helpers are unchanged.
    const S = this._pixelScale;
    const ow = Math.max(1, Math.round(cw / S));
    const oh = Math.max(1, Math.round(ch / S));
    let ctx;
    let usingBuffer = false;
    if (this.offCtx && PIXEL_ART_ENABLED) {
      if (this.offscreen.width !== ow || this.offscreen.height !== oh) {
        this.offscreen.width = ow;
        this.offscreen.height = oh;
      }
      ctx = this.offCtx;
      usingBuffer = true;
      // Map logical [0,cw]x[0,ch] coords onto the smaller buffer: scale by
      // ow/cw (= 1/S), NOT cw/ow. The blit below scales back up by S.
      ctx.setTransform(ow / cw, 0, 0, oh / ch, 0, 0);
      ctx.imageSmoothingEnabled = false;               // crisp sprite pixels
    } else {
      ctx = this.ctx; // SSR / no document: draw straight to the main canvas
    }

    // Particle logic updates & triggers
    if (this._perf) {
      if (this.particles.length) this.particles.length = 0;
    } else {
      this._triggerInstantSparks(gameState, dt);
      this._updateParticles(dt);
    }

    // Clear Screen (dark beyond the arena walls)
    ctx.fillStyle = '#0d0a06';
    ctx.fillRect(0, 0, cw, ch);

    const shake = typeof camera.getShakeOffset === 'function'
      ? camera.getShakeOffset(nowTime)
      : { x: 0, y: 0 };
    ctx.save();
    ctx.translate(shake.x || 0, shake.y || 0);

    // Grid rendering (biome-themed floor; only the visible region is blitted)
    this._drawGrid(ctx, camera, cw, ch, mapWidth, mapHeight, gameState.biome);

    // Water bodies sit on the floor, under everything else.
    if (gameState.water) this._drawWater(ctx, camera, cw, ch, gameState.water, gameState.biome);

    // Floor particles rendering (Dust trails, projectile flows)
    this._drawParticles(ctx, camera, cw, ch, 'floor', gameState.players);

    // Draw Map Borders
    this._drawBorders(ctx, camera, cw, ch, mapWidth, mapHeight);

    // Storm zone boundary (under entities so players read on top of it).
    if (gameState.storm) this._drawZone(ctx, camera, cw, ch, gameState.storm, nowTime);

    // Cover obstacles + healing items sit on the floor, under players.
    if (gameState.cover && gameState.cover.length) this._drawCover(ctx, camera, cw, ch, gameState.cover, gameState.biome);
    if (gameState.healingItems && gameState.healingItems.length) this._drawHealingItems(ctx, camera, cw, ch, gameState.healingItems, nowTime);
    if (gameState.mines && gameState.mines.length) this._drawMines(ctx, camera, cw, ch, gameState.mines, localPlayerId, nowTime);
    if (gameState.firePatches && gameState.firePatches.length) this._drawFirePatches(ctx, camera, cw, ch, gameState.firePatches, nowTime);

    // Draw Active Attack Visual Effects
    if (activeEffects.length) {
      this._drawEffects(ctx, camera, cw, ch, activeEffects, gameState.players, localPlayerId, visualSettings);
    }

    // Draw Bow Projectiles
    if (gameState.projectiles) {
      this._drawProjectiles(ctx, camera, cw, ch, gameState.projectiles, gameState.players);
    }

    // Draw All Connected Players
    if (gameState.players) {
      this._drawPlayers(ctx, camera, cw, ch, gameState.players, localPlayerId, activeEffects, mapWidth, mapHeight, visualSettings);
      // Orbiting guardian blades (deterministic from time; suppressed while launched).
      this._drawGuardianOrbits(ctx, camera, cw, ch, gameState.players, gameState.projectiles, nowTime);
      this._drawChakramOrbit(ctx, camera, cw, ch, gameState.players, nowTime);
      this._drawHeatShields(ctx, camera, cw, ch, gameState.players, nowTime);
      // Flamethrower cones for anyone actively spraying.
      this._drawFlameCones(ctx, camera, cw, ch, gameState.players, nowTime);
    }

    // Top particles rendering (Hurt splatters, death grave explosions, weapon arcs)
    this._drawParticles(ctx, camera, cw, ch, 'onTop', gameState.players);

    // Floating damage numbers above whoever just took a hit (dummy or player).
    if (gameState.damagePopups && gameState.damagePopups.length) {
      this._drawDamagePopups(ctx, camera, cw, ch, gameState.damagePopups, nowTime);
    }

    // Cursor crosshair — drawn last so it's always on top. Coordinates are
    // already in canvas-buffer-space (no camera transform needed).
    if (gameState.cursorPos) {
      this._drawCursorCrosshair(ctx, gameState.cursorPos.x, gameState.cursorPos.y);
    }

    ctx.restore();

    // Blit the low-res world buffer onto the main canvas with smoothing OFF, so
    // every rendered pixel becomes a chunky upscaled square (the pixel-art look).
    if (usingBuffer) {
      const main = this.ctx;
      main.setTransform(1, 0, 0, 1, 0, 0);
      main.imageSmoothingEnabled = false;
      main.clearRect(0, 0, cw, ch);
      main.drawImage(this.offscreen, 0, 0, ow, oh, 0, 0, cw, ch);
    }

    // Tracking-mode HUD overlays: screen-space, drawn after the shake restore so
    // they stay rock-steady. Only shown when the camera is following the player
    // (i.e. the map is larger than the viewport); the legacy full-map view needs
    // neither a minimap nor off-screen arrows.
    if (camera.tracking && gameState.players) {
      // HUD overlays render on the MAIN canvas at full resolution (crisp), not
      // in the low-res world buffer.
      this._drawOffscreenEnemyArrows(this.ctx, camera, cw, ch, gameState.players, localPlayerId);
      this._drawMinimap(this.ctx, cw, ch, gameState.players, localPlayerId, mapWidth, mapHeight, gameState);
    }

    // Local-player damage vignette (full-res, on top of everything else).
    if (gameState.hitFlash) {
      this._drawHitVignette(this.ctx, cw, ch, gameState.hitFlash);
    }
    // Out-of-zone warning: pulsing purple screen edge while taking storm damage.
    if (gameState.zoneOutside) {
      const pulse = 0.45 + 0.25 * Math.sin(nowTime / 140);
      this._drawZoneWarning(this.ctx, cw, ch, pulse);
    }
  }

  // Device-pixel ratio used by the backing store, so HUD strokes/sizes stay
  // crisp and consistent in CSS terms across desktop/retina/mobile.
  _dpr() {
    const cssW = this.canvas.clientWidth || parseFloat(this.canvas.style.width) || this.canvas.width;
    return Math.max(1, Math.min(3, this.canvas.width / (cssW || this.canvas.width)));
  }

  /**
   * Corner minimap (tracking mode only). Angular pixel-theme panel showing the
   * arena outline, the local player (bright cyan), enemies (red), practice
   * dummies (gray), plus optional storm zone (Task 5) and healing items (Task 9).
   */
  _drawMinimap(ctx, cw, ch, players, localPlayerId, mapWidth, mapHeight, gameState = {}) {
    const dpr = this._dpr();
    const portrait = ch > cw * 1.1;
    const pad = Math.round(10 * dpr);
    // Smaller on phones; sits in the reserved top band (portrait) or the free
    // bottom-right corner (landscape/desktop) to dodge the existing HUD panels.
    const size = Math.round(Math.min(cw, ch) * (portrait ? 0.19 : 0.16));
    const px = portrait ? Math.round((cw - size) / 2) : (cw - size - pad);
    const py = portrait ? pad : (ch - size - pad);

    // Map area inside the panel, aspect-preserved (arena is square today).
    const inset = Math.round(5 * dpr);
    const innerW = size - inset * 2;
    const innerH = size - inset * 2;
    const aspect = mapWidth / mapHeight;
    let mw = innerW, mh = innerW / aspect;
    if (mh > innerH) { mh = innerH; mw = innerH * aspect; }
    const ox = px + inset + (innerW - mw) / 2;
    const oy = py + inset + (innerH - mh) / 2;
    const w2m = (wx, wy) => ({ x: ox + (wx / mapWidth) * mw, y: oy + (wy / mapHeight) * mh });

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    // Panel + border (angular, no glow).
    ctx.fillStyle = 'rgba(11, 12, 16, 0.74)';
    ctx.fillRect(px, py, size, size);
    ctx.lineWidth = Math.max(1, 2 * dpr);
    ctx.strokeStyle = '#2b6f72';
    ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
    // Inner arena outline.
    ctx.strokeStyle = 'rgba(69, 243, 255, 0.55)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(Math.round(ox), Math.round(oy), Math.round(mw), Math.round(mh));

    // Storm zone (Task 5): safe circle + incoming target ring. Inert until then.
    // Cover tiles (Task 9): faint gray blocks for navigation.
    const cover = gameState.cover;
    if (Array.isArray(cover) && cover.length) {
      ctx.fillStyle = 'rgba(120, 132, 150, 0.8)';
      for (const t of cover) {
        const a = w2m(t.x, t.y);
        const w = Math.max(1, (t.w / mapWidth) * mw);
        const h = Math.max(1, (t.h / mapHeight) * mh);
        ctx.fillRect(Math.round(a.x), Math.round(a.y), Math.ceil(w), Math.ceil(h));
      }
    }

    const storm = gameState.storm;
    if (storm?.kind === 'platformer_rise') {
      const floorY = Number.isFinite(storm.floorY) ? storm.floorY : mapHeight;
      const leftX = Number.isFinite(storm.leftX) ? storm.leftX : 0;
      const rightX = Number.isFinite(storm.rightX) ? storm.rightX : mapWidth;
      const a = w2m(leftX, 0);
      const b = w2m(rightX, floorY);
      ctx.fillStyle = 'rgba(34,197,94,0.08)';
      ctx.fillRect(Math.round(a.x), Math.round(a.y), Math.round(b.x - a.x), Math.round(b.y - a.y));
      const lavaTop = w2m(leftX, floorY);
      const lavaBottom = w2m(rightX, mapHeight);
      ctx.fillStyle = 'rgba(239,68,68,0.45)';
      ctx.fillRect(Math.round(lavaTop.x), Math.round(lavaTop.y), Math.round(lavaBottom.x - lavaTop.x), Math.round(lavaBottom.y - lavaTop.y));
      ctx.strokeStyle = 'rgba(250,204,21,0.95)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); ctx.moveTo(lavaTop.x, lavaTop.y); ctx.lineTo(lavaBottom.x, lavaTop.y); ctx.stroke();
      if (Number.isFinite(storm.nextFloorY) && (storm.phase === 'warning' || storm.phase === 'shrinking')) {
        const n = w2m(leftX, storm.nextFloorY);
        const nr = w2m(rightX, storm.nextFloorY);
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeStyle = 'rgba(253,224,71,0.75)';
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(nr.x, nr.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (storm && Number.isFinite(storm.x) && Number.isFinite(storm.y) && Number.isFinite(storm.radius)) {
      const c = w2m(storm.x, storm.y);
      const rr = (storm.radius / mapWidth) * mw;
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.85)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1, rr), 0, Math.PI * 2); ctx.stroke();
      if (Number.isFinite(storm.nextX) && Number.isFinite(storm.nextRadius)) {
        const nc = w2m(storm.nextX, storm.nextY);
        const nr = (storm.nextRadius / mapWidth) * mw;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeStyle = 'rgba(244, 114, 182, 0.8)';
        ctx.beginPath(); ctx.arc(nc.x, nc.y, Math.max(1, nr), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Healing items (Task 9): small green squares. Inert until then.
    const items = gameState.healingItems;
    if (Array.isArray(items)) {
      const s = Math.max(2, Math.round(2 * dpr));
      ctx.fillStyle = '#34d399';
      for (const it of items) {
        if (!it || !Number.isFinite(it.x)) continue;
        const m = w2m(it.x, it.y);
        ctx.fillRect(Math.round(m.x - s / 2), Math.round(m.y - s / 2), s, s);
      }
    }

    // Players: dummies gray, enemies red, local bright cyan (drawn last/on top).
    const dot = Math.max(2, Math.round(3 * dpr));
    const ids = Object.keys(players);
    for (const id of ids) {
      const p = players[id];
      if (!p || p.isDead || id === localPlayerId) continue;
      const m = w2m(p.x, p.y);
      ctx.fillStyle = p.isDummy ? '#9ca3af' : '#ff4d4d';
      ctx.fillRect(Math.round(m.x - dot / 2), Math.round(m.y - dot / 2), dot, dot);
    }
    const local = players[localPlayerId];
    if (local && !local.isDead) {
      const m = w2m(local.x, local.y);
      const ld = dot + Math.round(dpr);
      ctx.fillStyle = '#5ffbf1';
      ctx.fillRect(Math.round(m.x - ld / 2), Math.round(m.y - ld / 2), ld, ld);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(m.x - ld / 2) - 0.5, Math.round(m.y - ld / 2) - 0.5, ld + 1, ld + 1);
    }

    ctx.restore();
  }

  /**
   * Edge arrows pointing toward off-screen enemies (tracking mode only).
   * Capped to the nearest few so a crowded match stays readable; closer enemies
   * draw more opaque.
   */
  _drawOffscreenEnemyArrows(ctx, camera, cw, ch, players, localPlayerId) {
    const local = players[localPlayerId];
    if (!local || local.isDead) return;
    const dpr = this._dpr();
    const margin = Math.round(24 * dpr);
    const localScr = camera.toScreen(local.x, local.y, cw, ch);

    const offscreen = [];
    for (const id of Object.keys(players)) {
      if (id === localPlayerId) continue;
      const p = players[id];
      if (!p || p.isDead || p.isDummy) continue;
      const s = camera.toScreen(p.x, p.y, cw, ch);
      if (s.x >= 0 && s.x <= cw && s.y >= 0 && s.y <= ch) continue; // on screen → no arrow
      offscreen.push({ p, s, d: Math.hypot(p.x - local.x, p.y - local.y) });
    }
    if (!offscreen.length) return;
    offscreen.sort((a, b) => a.d - b.d);
    const MAX_ARROWS = 4;

    const left = margin, right = cw - margin, top = margin, bot = ch - margin;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < Math.min(MAX_ARROWS, offscreen.length); i++) {
      const { s, d } = offscreen[i];
      const dx = s.x - localScr.x;
      const dy = s.y - localScr.y;
      if (dx === 0 && dy === 0) continue;
      // Intersect the ray from the local player toward the enemy with the inset
      // rectangle to find where to pin the arrow.
      let t = Infinity;
      if (dx > 0) t = Math.min(t, (right - localScr.x) / dx);
      else if (dx < 0) t = Math.min(t, (left - localScr.x) / dx);
      if (dy > 0) t = Math.min(t, (bot - localScr.y) / dy);
      else if (dy < 0) t = Math.min(t, (top - localScr.y) / dy);
      if (!Number.isFinite(t) || t < 0) continue;
      const ax = Math.max(left, Math.min(right, localScr.x + dx * t));
      const ay = Math.max(top, Math.min(bot, localScr.y + dy * t));
      const ang = Math.atan2(dy, dx);
      const alpha = Math.max(0.35, Math.min(0.95, 1 - d / 2200));
      const r = 9 * dpr;

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.7, r * 0.7);
      ctx.lineTo(-r * 0.7, -r * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Small status-effect badges above a player (bleed/burn/slow/stun).
   * Uses 24×24 skill-icon sprites when the atlas is ready; falls back to the
   * original pixel shapes so the game never breaks on a missing asset.
   */
  _drawStatusIcons(ctx, bodyScr, p, radius) {
    const active = [];
    if (p.bleedTimeLeft > 0) active.push('bleed');
    if (p.burnTimeLeft > 0) active.push('burn');
    if (p.slowTimeLeft > 0) active.push('slow');
    if (p.stunTimeLeft > 0) active.push('stun');
    if (!active.length) return;

    const S = 16;                 // rendered icon size (px on screen)
    const gap = 3;
    const total = active.length * (S + gap) - gap;
    let x = Math.round(bodyScr.x - total / 2);
    const y = Math.round(bodyScr.y - radius - 44);
    const blink = (Math.sin(Date.now() / 160) + 1) / 2;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const kind of active) {
      // Dark backing pill
      ctx.fillStyle = 'rgba(11,12,16,0.75)';
      ctx.fillRect(x - 1, y - 1, S + 2, S + 2);

      const img = this.atlas?.get(`status/${kind}`);
      if (img && img.naturalWidth) {
        // Sprite icon — stun blinks by modulating alpha
        ctx.globalAlpha = (kind === 'stun') ? (0.55 + 0.45 * blink) : 1;
        ctx.drawImage(img, x, y, S, S);
        ctx.globalAlpha = 1;
      } else {
        // Procedural fallback (original pixel shapes, scaled to S)
        const cx = x + S / 2, cy = y + S / 2, sc = S / 8;
        if (kind === 'bleed') {
          ctx.fillStyle = '#c0392b';
          ctx.beginPath(); ctx.arc(cx, cy + sc, 2.6 * sc, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(cx, cy - 3.5 * sc); ctx.lineTo(cx - 2.2 * sc, cy + 0.5 * sc); ctx.lineTo(cx + 2.2 * sc, cy + 0.5 * sc); ctx.closePath(); ctx.fill();
        } else if (kind === 'burn') {
          ctx.fillStyle = '#fb923c';
          ctx.beginPath(); ctx.moveTo(cx, cy - 4 * sc); ctx.lineTo(cx + 3 * sc, cy + 3 * sc); ctx.lineTo(cx - 3 * sc, cy + 3 * sc); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#fde047'; ctx.fillRect(cx - sc, cy, 2 * sc, 3 * sc);
        } else if (kind === 'slow') {
          ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 1.3;
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI;
            ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 3.5 * sc, cy - Math.sin(a) * 3.5 * sc);
            ctx.lineTo(cx + Math.cos(a) * 3.5 * sc, cy + Math.sin(a) * 3.5 * sc); ctx.stroke();
          }
        } else {
          ctx.fillStyle = `rgba(250,204,21,${0.6 + 0.4 * blink})`;
          for (const dx of [-2.5, 0, 2.5]) ctx.fillRect(cx + dx * sc - 0.8 * sc, cy - 1.6 * sc, 1.6 * sc, 1.6 * sc);
        }
      }
      x += S + gap;
    }
    ctx.imageSmoothingEnabled = prevSmooth;
    ctx.restore();
  }

  /**
   * Floating pixel-font damage numbers that rise and fade above a character.
   * Color/size encode the hit tier; your own damage is always red so you can
   * tell at a glance that YOU got hit. Each number drifts on its own random
   * horizontal vector so stacked hits fan out instead of overlapping.
   */
  _drawDamagePopups(ctx, camera, cw, ch, popups, now) {
    const z = camera.zoom || 1;
    // Readable on phones but still scales modestly with zoom (clamped — this is
    // UI feedback, not a hitbox, so it keeps a legibility floor).
    const baseSize = 15 * Math.max(0.85, Math.min(1.5, z));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const d of popups) {
      const life = (now - d.born) / 900; // 0..1
      if (life >= 1) continue;

      // Tier → palette + size bump. Your own hits override to red.
      const tier = d.tier || 'normal';
      const sizeMul = tier === 'lethal' ? 1.55 : tier === 'big' ? 1.25 : 1;
      const size = Math.round(baseSize * sizeMul);
      let fill = '#ffe27a';
      if (tier === 'big') fill = '#ff9d3a';
      if (tier === 'lethal') fill = '#ff5d5d';
      if (d.isLocal) fill = '#ff5555';
      if (d.dotColor) fill = d.dotColor; // bleed/burn tick color overrides

      const anchor = camera.toScreen(d.x, d.y, cw, ch);
      const rise = 14 + life * 30;                    // drift upward (screen px)
      const x = anchor.x + (d.vx || 0) * (10 + life * 22) * z * 0.4;
      const y = anchor.y - 22 * z - rise;
      const alpha = life < 0.7 ? 1 : Math.max(0, 1 - (life - 0.7) / 0.3);
      const pop = life < 0.12 ? 1 + (0.12 - life) * 2.2 : 1; // brief scale-in punch
      const text = String(d.amount);
      ctx.font = `${size}px "Galmuri11", monospace`;
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(x, y);
      if (pop !== 1) ctx.scale(pop, pop);
      ctx.lineWidth = Math.max(2, size * 0.28);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = fill;
      ctx.fillText(text, 0, 0);
      // Lethal hits get a tiny white core for extra pop.
      if (tier === 'lethal') {
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, 0, 0);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Local-player damage vignette: a soft red glow hugging the screen edges.
   * Drawn on the MAIN canvas at full res (after the world blit) so it stays
   * crisp and never tints the pixel buffer. `strength` is 0..1.
   */
  _drawHitVignette(ctx, cw, ch, strength) {
    if (!(strength > 0)) return;
    const s = Math.min(1, strength);
    ctx.save();
    // Radial gradient: transparent center → red at the corners.
    const cx = cw / 2, cy = ch / 2;
    const inner = Math.min(cw, ch) * 0.28;
    const outer = Math.hypot(cw, cy) * 0.62;
    const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    grad.addColorStop(0, 'rgba(255,0,0,0)');
    grad.addColorStop(1, `rgba(190,12,12,${0.55 * s})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  // Purple screen-edge glow while the local player stands outside the storm.
  _drawZoneWarning(ctx, cw, ch, strength) {
    const s = Math.max(0, Math.min(1, strength));
    ctx.save();
    const cx = cw / 2, cy = ch / 2;
    const inner = Math.min(cw, ch) * 0.30;
    const outer = Math.hypot(cw, cy) * 0.62;
    const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    grad.addColorStop(0, 'rgba(168,85,247,0)');
    grad.addColorStop(1, `rgba(147,51,234,${0.5 * s})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  /**
   * A biome-tinted copy of the nature sheet (cached). Desert/snow wash the rocks
   * to dry sandstone / frosted stone; grassy biomes use the raw sheet.
   */
  _getTintedNature(biome) {
    const sheet = this.atlas?.get('tile/nature');
    if (!sheet) return null;
    const tint = COVER_TINT[biome];
    if (!tint) return sheet;
    this._natureTinted = this._natureTinted || {};
    if (this._natureTinted[biome]) return this._natureTinted[biome];
    if (typeof document === 'undefined') return sheet;
    const w = sheet.naturalWidth || sheet.width, h = sheet.naturalHeight || sheet.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.drawImage(sheet, 0, 0);
    g.globalCompositeOperation = 'source-atop';   // recolour only opaque pixels
    g.fillStyle = tint; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    this._natureTinted[biome] = c;
    return c;
  }

  /**
   * Cover tiles. Each draws a boulder/bush sprite cut from the nature tileset,
   * chosen deterministically from the tile's world position (so it's varied but
   * identical on every client — same idea as the grass field). The sprite SET
   * and colour wash follow the biome (leafy bushes by day, dry rocks in the
   * desert, frosted stone on snow). Width-fit to the tile so the footprint
   * matches the 46px hitbox; taller rocks overhang upward. Falls back to a flat
   * gray block until the tileset finishes loading.
   */
  _drawCover(ctx, camera, cw, ch, cover, biome = 'day') {
    const z = camera.zoom || 1;
    const sheet = this._getTintedNature(biome);
    const set = BIOME_COVER[COVER_GROUP[biome] || 'grassy'] || BIOME_COVER.grassy;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const t of cover) {
      const a = camera.toScreen(t.x, t.y, cw, ch);
      const w = t.w * z, h = t.h * z;
      // Cull off-screen tiles (extra top margin for the upward boulder overhang).
      if (a.x + w < -40 || a.x > cw + 40 || a.y + h < -120 || a.y > ch + 40) continue;
      const x = Math.round(a.x), y = Math.round(a.y);

      if (!sheet) {
        // Tileset not ready yet — flat gray block fallback.
        ctx.fillStyle = '#3a4250';
        ctx.fillRect(x, y, Math.ceil(w), Math.ceil(h));
        ctx.fillStyle = '#4b5566';
        ctx.fillRect(x, y, Math.ceil(w), Math.max(2, Math.round(h * 0.18)));
        continue;
      }

      // Deterministic per-tile pick from world position (stable across clients).
      const key = (Math.round(t.x) * 73856093) ^ (Math.round(t.y) * 19349663);
      const idx = set[(key >>> 3) % set.length];
      const flip = ((key >>> 1) & 1) === 1;
      const [sx, sy, sw, sh] = COVER_SPRITES[idx];

      // Ground contact shadow — an ellipse at the tile base so the rock reads as
      // a solid object resting on the floor (the big "this blocks you" cue).
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h - h * 0.10, w * 0.48, h * 0.20, 0, 0, Math.PI * 2);
      ctx.fill();

      // Width-fit (slight overhang); height follows the sprite's aspect, anchored
      // to the tile's bottom so the base sits on the hitbox and tall rocks rise up.
      const dw = w * 1.12;
      const dh = dw * (sh / sw);
      const dx = x + w / 2 - dw / 2;
      const dy = y + h - dh;
      if (flip) {
        ctx.save();
        ctx.translate(dx + dw, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, sx, sy, sw, sh, 0, 0, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(sheet, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    }
    ctx.restore();
  }



  /** Storm zone: solid safe-circle ring + dashed incoming next circle. */
  _drawZone(ctx, camera, cw, ch, storm, now) {
    const z = camera.zoom || 1;
    ctx.save();
    // Incoming circle (during warning/shrinking the next target is shown dashed).
    if (Number.isFinite(storm.nextRadius) && storm.phase !== 'safe' &&
        (storm.nextRadius !== storm.radius || storm.nextX !== storm.x)) {
      const nc = camera.toScreen(storm.nextX, storm.nextY, cw, ch);
      ctx.setLineDash([6 * z, 5 * z]);
      ctx.lineWidth = Math.max(1, 2 * z);
      ctx.strokeStyle = 'rgba(244,114,182,0.85)';
      ctx.beginPath();
      ctx.arc(nc.x, nc.y, Math.max(2, storm.nextRadius * z), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Current safe-circle boundary.
    const c = camera.toScreen(storm.x, storm.y, cw, ch);
    const r = Math.max(2, storm.radius * z);
    ctx.lineWidth = Math.max(2, 3 * z);
    ctx.strokeStyle = 'rgba(168,85,247,0.9)';
    ctx.shadowColor = 'rgba(168,85,247,0.8)';
    ctx.shadowBlur = this._glow ? 10 * z : 0;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Mines. The placer sees their own mines clearly; enemies only get a faint
   * blinking pixel (intentional — fully invisible mines feel unfair).
   */
  _drawMines(ctx, camera, cw, ch, mines, localPlayerId, now) {
    const z = camera.zoom || 1;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const blink = (Math.sin(now / 220) + 1) / 2; // 0..1
    for (const m of mines) {
      if (!m || !Number.isFinite(m.x)) continue;
      const s = camera.toScreen(m.x, m.y, cw, ch);
      const armed = now >= (m.armAt || 0);
      const mine = m.ownerId === localPlayerId;
      if (mine) {
        // Owner: clear pixel mine with a pulsing light.
        const r = 6 * z;
        ctx.fillStyle = '#7c5410';
        ctx.fillRect(Math.round(s.x - r), Math.round(s.y - r), Math.round(r * 2), Math.round(r * 2));
        ctx.fillStyle = armed ? `rgba(255,80,80,${0.5 + 0.5 * blink})` : '#fbbf24';
        const c = Math.max(2, Math.round(2.4 * z));
        ctx.fillRect(Math.round(s.x - c / 2), Math.round(s.y - c / 2), c, c);
        ctx.strokeStyle = '#3a2a08';
        ctx.lineWidth = Math.max(1, z);
        ctx.strokeRect(Math.round(s.x - r) - 0.5, Math.round(s.y - r) - 0.5, Math.round(r * 2) + 1, Math.round(r * 2) + 1);
      } else if (armed) {
        // Enemy: just a faint 1–2px blink, so it's barely perceptible.
        ctx.globalAlpha = 0.25 + 0.35 * blink;
        ctx.fillStyle = '#ff6b6b';
        const c = Math.max(2, Math.round(2 * z));
        ctx.fillRect(Math.round(s.x - c / 2), Math.round(s.y - c / 2), c, c);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  /** Flame cone in front of every player currently spraying the flamethrower. */
  _drawFlameCones(ctx, camera, cw, ch, players, now) {
    const cfg = Weapons.flamethrower;
    const z = camera.zoom || 1;
    for (const id of Object.keys(players)) {
      const p = players[id];
      if (!p || p.isDead || p.weapon !== 'flamethrower' || !p.flameSpraying) continue;
      const scr = camera.toScreen(p.x, p.y, cw, ch);
      const half = (cfg.angle * Math.PI) / 360;
      const reach = cfg.range * z;
      ctx.save();
      ctx.translate(scr.x, scr.y);
      ctx.rotate(p.angle);
      // Layered flickering cone: outer orange, inner yellow.
      const flick = 0.85 + 0.15 * Math.sin(now / 40 + (p.x + p.y));
      for (const [frac, color] of [[1, 'rgba(251,146,60,0.32)'], [0.7, 'rgba(253,224,71,0.4)'], [0.4, 'rgba(255,255,255,0.45)']]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, reach * frac * flick, -half, half);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /** Burning ground patches (flamethrower F), flickering flame discs. */
  _drawFirePatches(ctx, camera, cw, ch, patches, now) {
    const cfg = Weapons.flamethrower;
    const z = camera.zoom || 1;
    const r = (cfg && SkillConfig.flamethrower ? SkillConfig.flamethrower.patchRadius : 55) * z;
    ctx.save();
    for (const fp of patches) {
      if (!fp || !Number.isFinite(fp.x)) continue;
      const scr = camera.toScreen(fp.x, fp.y, cw, ch);
      const flick = 0.8 + 0.2 * Math.sin(now / 60 + fp.id);
      ctx.shadowColor = '#fb923c';
      ctx.shadowBlur = this._glow ? 16 : 0;
      ctx.fillStyle = `rgba(251,146,60,${0.28 * flick})`;
      ctx.beginPath(); ctx.arc(scr.x, scr.y, r * flick, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(253,224,71,${0.32 * flick})`;
      ctx.beginPath(); ctx.arc(scr.x, scr.y, r * 0.6 * flick, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** Pixel hearts for healing items, with a gentle bob. */
  _drawHealingItems(ctx, camera, cw, ch, items, now) {
    const z = camera.zoom || 1;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const it of items) {
      if (!it || !Number.isFinite(it.x)) continue;
      const bob = Math.sin((now + (it.id || 0) * 320) / 360) * 3 * z;
      const s = camera.toScreen(it.x, it.y, cw, ch);
      this._drawPixelHeart(ctx, s.x, s.y + bob, 5 * z);
    }
    ctx.restore();
  }

  // A small chunky heart centered at (cx,cy); `u` is the pixel unit size.
  _drawPixelHeart(ctx, cx, cy, u) {
    const px = Math.max(1, Math.round(u));
    // 7x6 heart bitmap.
    const rows = [
      '0110110',
      '1111111',
      '1111111',
      '0111110',
      '0011100',
      '0001000'
    ];
    ctx.save();
    ctx.shadowColor = 'rgba(255,80,120,0.8)';
    ctx.shadowBlur = this._glow ? 6 : 0;
    const w = 7 * px, h = rows.length * px;
    const ox = Math.round(cx - w / 2), oy = Math.round(cy - h / 2);
    ctx.fillStyle = '#ff5d7a';
    for (let r = 0; r < rows.length; r++) {
      for (let cI = 0; cI < 7; cI++) {
        if (rows[r][cI] === '1') ctx.fillRect(ox + cI * px, oy + r * px, px, px);
      }
    }
    // tiny white highlight
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(ox + px, oy + px, px, px);
    ctx.restore();
  }

  /**
   * Process dynamic triggers for particle bursts
   */
  _triggerInstantSparks(gameState, dt) {
    if (!gameState || !gameState.players) return;

    Object.keys(gameState.players).forEach(id => {
      const p = gameState.players[id];
      const prev = this.lastPlayersInfo[id];

      if (p.isDead) {
        // Just died check
        if (prev && !prev.isDead) {
          // Play colossal death core smoke and sparks ring
          for (let i = 0; i < 30; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 110 + 20;
            this.particles.push({
              x: p.x,
              y: p.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              color: i % 2 === 0 ? p.color : '#374151',
              size: Math.random() * 4 + 2,
              alpha: 1.0,
              decay: Math.random() * 1.5 + 0.8,
              shape: 'circle',
              layer: 'onTop'
            });
          }
        }
        this.lastPlayersInfo[id] = { hp: p.hp, isDead: p.isDead, x: p.x, y: p.y };
        return;
      }

      // 1. Hurt check (Spatter bloody/shield shards)
      if (prev && prev.hp > p.hp) {
        const dmgGap = prev.hp - p.hp;
        const count = Math.min(25, Math.ceil(dmgGap * 0.8) + 6);
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = Math.random() * 150 + 50;
          this.particles.push({
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            color: i % 3 === 0 ? '#ef4444' : i % 3 === 1 ? p.color : '#ffffff',
            size: Math.random() * 3 + 1,
            alpha: 1.0,
            decay: Math.random() * 2.2 + 1.2,
            shape: i % 2 === 0 ? 'rect' : 'circle',
            layer: 'onTop'
          });
        }
      }

      // 2. Dust trails when moving
      if (prev && (Math.abs(prev.x - p.x) > 0.4 || Math.abs(prev.y - p.y) > 0.4)) {
        if (Math.random() < 0.22) {
          const oppositeAngle = Math.atan2(prev.y - p.y, prev.x - p.x) + (Math.random() * 0.4 - 0.2);
          const speed = Math.random() * 20 + 5;
          this.particles.push({
            x: p.x + (Math.random() * 8 - 4),
            y: p.y + 11, // At the feet
            vx: Math.cos(oppositeAngle) * speed,
            vy: Math.sin(oppositeAngle) * speed,
            color: 'rgba(255, 255, 255, 0.12)',
            size: Math.random() * 2.5 + 1.0,
            alpha: 0.5,
            decay: Math.random() * 2.0 + 1.5,
            shape: 'circle',
            layer: 'floor'
          });
        }
      }

      this.lastPlayersInfo[id] = { hp: p.hp, isDead: p.isDead, x: p.x, y: p.y };
    });

    // 3. Melee Swing slash sparks trails
    if (gameState.effects) {
      gameState.effects.forEach(e => {
        const weapon = getEffectiveWeapon(e.weapon, e.buffType) || Weapons.sword;
        const anchoredEffect = this._resolveEffectAttachment(e, gameState.players);
        if (e.type === 'projectile_shot') {
          if (Math.random() < 0.75) {
            const dist = 16 + Math.random() * 8;
            const side = e.angle + Math.PI + (Math.random() * 0.8 - 0.4);
            this.particles.push({
              x: e.x + Math.cos(e.angle) * dist,
              y: e.y + Math.sin(e.angle) * dist,
              vx: Math.cos(side) * (20 + Math.random() * 40),
              vy: Math.sin(side) * (20 + Math.random() * 40),
              color: Math.random() < 0.45 ? '#ffffff' : weapon.color,
              size: Math.random() * 2.4 + 1.0,
              alpha: 0.9,
              decay: Math.random() * 2.6 + 2.0,
              shape: 'circle',
              layer: 'onTop'
            });
          }
          return;
        }

        if (e.type === 'projectile_burst') {
          if (e.progress < 0.35 && Math.random() < 0.8) {
            for (let i = 0; i < 3; i++) {
              const burstAngle = e.angle + Math.PI + (Math.random() * 1.6 - 0.8);
              const speed = 25 + Math.random() * 85;
              this.particles.push({
                x: e.x,
                y: e.y,
                vx: Math.cos(burstAngle) * speed,
                vy: Math.sin(burstAngle) * speed,
                color: Math.random() < 0.45 ? '#ffffff' : weapon.color,
                size: Math.random() * 2.4 + 1.0,
                alpha: 0.9,
                decay: Math.random() * 2.4 + 2.0,
                shape: 'circle',
                layer: 'onTop'
              });
            }
          }
          return;
        }

        // Sword-energy explosion: a quick spark burst at the blast point.
        if (e.type === 'explosion') {
          if (e.progress < 0.32 && Math.random() < 0.9) {
            for (let i = 0; i < 4; i++) {
              const a = Math.random() * Math.PI * 2;
              const speed = 70 + Math.random() * 180;
              this.particles.push({
                x: e.x,
                y: e.y,
                vx: Math.cos(a) * speed,
                vy: Math.sin(a) * speed,
                color: Math.random() < 0.5 ? '#ffffff' : weapon.color,
                size: Math.random() * 2.8 + 1.2,
                alpha: 1.0,
                decay: Math.random() * 2.2 + 1.8,
                shape: Math.random() < 0.5 ? 'rect' : 'circle',
                layer: 'onTop'
              });
            }
          }
          return;
        }

        // Only arc/circle swings emit trailing spark dots. This removes the
        // stray spear dots that flew past the hitbox, and keeps the new skill
        // effects (line thrust, railbeam, buff) clean.
        const sparkArcTypes = ['melee_arc', 'melee_heavy_arc', 'melee_sweet_arc', 'melee_backstab'];
        const sparkCircleTypes = ['melee_circle', 'melee_slam'];
        if (!sparkArcTypes.includes(e.type) && !sparkCircleTypes.includes(e.type)) return;

        if (Math.random() < 0.45) {
          let px = anchoredEffect.x;
          let py = anchoredEffect.y;
          let angle = anchoredEffect.angle;

          if (sparkArcTypes.includes(e.type)) {
            const spread = (weapon.angle * Math.PI) / 360;
            const ranAngle = anchoredEffect.angle + (Math.random() * spread * 2 - spread);
            const dist = weapon.range * (0.35 + Math.random() * 0.65);
            px += Math.cos(ranAngle) * dist;
            py += Math.sin(ranAngle) * dist;
            angle = ranAngle + Math.PI / 2;
          } else if (sparkCircleTypes.includes(e.type)) {
            const ranAngle = Math.random() * Math.PI * 2;
            const dist = weapon.range * e.progress;
            px += Math.cos(ranAngle) * dist;
            py += Math.sin(ranAngle) * dist;
            angle = ranAngle;
          } else if (e.type === 'melee_line') {
            let ext = 0;
            if (e.progress < 0.15) {
              const t = e.progress / 0.15;
              ext = 1 - (1 - t) * (1 - t);
            } else if (e.progress < 0.35) {
              const t = (e.progress - 0.15) / 0.20;
              ext = 1.0 - t * 0.1;
            } else {
              const t = (e.progress - 0.35) / 0.65;
              ext = 0.9 * (1 - t);
            }
            const dist = weapon.range * ext;
            px += Math.cos(anchoredEffect.angle) * dist;
            py += Math.sin(anchoredEffect.angle) * dist;
          }

          const spd = Math.random() * 30 + 10;
          const particle = {
            x: px,
            y: py,
            vx: Math.cos(angle) * spd + (Math.random() * 10 - 5),
            vy: Math.sin(angle) * spd + (Math.random() * 10 - 5),
            color: Math.random() < 0.25 ? '#ffffff' : weapon.color,
            size: Math.random() * 2.2 + 1.0,
            alpha: 0.8,
            decay: Math.random() * 5.0 + 4.5,
            shape: 'circle',
            layer: 'onTop'
          };

          if (this._isPlayerBoundEffect(e)) {
            particle.anchorId = e.attackerId;
            particle.anchorAngle = anchoredEffect.angle;
            particle.rotateWithAnchor = true;
            particle.offsetX = px - anchoredEffect.x;
            particle.offsetY = py - anchoredEffect.y;
          }

          this.particles.push(particle);
        }
      });
    }

    // 4. Bow arrows trace stardust sparkling trails
    if (gameState.projectiles) {
      const trailColors = { arrow: '#a3ff45', swordwave: '#dce4ee', thrownspear: '#ffa345' };
      gameState.projectiles.forEach(proj => {
        if (!proj.isDead && Math.random() < 0.35) {
          this.particles.push({
            x: proj.x,
            y: proj.y,
            vx: (Math.random() * 10 - 5) - proj.vx * 0.05,
            vy: (Math.random() * 10 - 5) - proj.vy * 0.05,
            color: trailColors[proj.kind] || '#a3ff45',
            size: Math.random() * 1.8 + 0.8,
            alpha: 0.7,
            decay: Math.random() * 3.0 + 1.8,
            shape: 'circle',
            layer: 'floor'
          });
        }
      });
    }
  }

  /**
   * Propagate particle positions and decay lifetimes
   */
  _updateParticles(dt) {
    this.particles.forEach(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.anchorId) {
        p.offsetX = (p.offsetX || 0) + p.vx * dt;
        p.offsetY = (p.offsetY || 0) + p.vy * dt;
      }
      p.alpha -= p.decay * dt;
    });
    this.particles = this.particles.filter(p => p.alpha > 0);
  }

  /**
   * Render active particle traces
   */
  _drawParticles(ctx, camera, cw, ch, layerType, players = {}) {
    ctx.save();
    this.particles.forEach(p => {
      if (p.layer !== layerType) return;

      const pos = this._resolveParticlePosition(p, players);
      const scr = camera.toScreen(pos.x, pos.y, cw, ch);
      if (scr.x < -20 || scr.x > cw + 20 || scr.y < -20 || scr.y > ch + 20) return;

      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));

      if (p.shape === 'rect') {
        const sz = p.size;
        ctx.fillRect(scr.x - sz / 2, scr.y - sz / 2, sz, sz);
      } else {
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.restore();
  }

  /**
   * Draw the arena floor: a grassy field (Task 4).
   *
   * The grass is baked ONCE into an offscreen canvas at full world resolution
   * (deterministic from world position, so every client renders the exact same
   * field — no sync needed) and then blitted with the camera transform. Baking
   * once keeps per-frame cost to a single scaled drawImage.
   */
  _drawGrid(ctx, camera, cw, ch, mapWidth, mapHeight, biome = 'day') {
    ctx.save();
    const tl = camera.toScreen(0, 0, cw, ch);
    const br = camera.toScreen(mapWidth, mapHeight, cw, ch);
    const dw = br.x - tl.x, dh = br.y - tl.y;
    const grass = this._getGrassField(mapWidth, mapHeight, biome);
    if (grass) {
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(grass, 0, 0, grass.width, grass.height, tl.x, tl.y, dw, dh);
      ctx.imageSmoothingEnabled = prev;
    } else {
      ctx.fillStyle = (BIOME_FLOOR[biome] || BIOME_FLOOR.day).base;
      ctx.fillRect(tl.x, tl.y, dw, dh);
    }
    ctx.restore();
  }

  _getGrassField(mapWidth, mapHeight, biome = 'day') {
    if (typeof document === 'undefined') return null;
    const pal = BIOME_FLOOR[biome] || BIOME_FLOOR.day;
    const tufts = pal.tufts ? this.atlas?.get('tile/tufts') : null;
    // Re-bake when size, biome, or tuft-sheet readiness changes (key encodes all).
    const needTufts = pal.tufts;
    const key = `${mapWidth}x${mapHeight}_${biome}_${tufts ? '1' : '0'}`;
    if (this._grassKey === key && this._grassField) return this._grassField;

    const tw = mapWidth, th = mapHeight;
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;

    // 1) Flat base field, biome-coloured.
    g.fillStyle = pal.base;
    g.fillRect(0, 0, tw, th);

    // Deterministic hash → fract in [0,1). No RNG state, so every client bakes
    // the identical field without any network sync.
    const hash = (a, b) => {
      let h = (a * 374761393 + b * 668265263) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    // 2) Very subtle ground mottling so the bare floor isn't dead flat.
    const MB = 16;
    for (let by = 0, ry = 0; by < th; by += MB, ry++) {
      for (let bx = 0, rx = 0; bx < tw; bx += MB, rx++) {
        const n = hash(rx * 3 + 1, ry * 3 + 2);
        if (n > 0.82)      g.fillStyle = pal.mDark;    // darker fleck
        else if (n < 0.12) g.fillStyle = pal.mLight;   // lighter fleck
        else continue;
        g.fillRect(bx, by, MB, MB);
      }
    }

    // 3) Scatter grass tufts on a 32×32 block grid (grassy biomes only),
    //    deterministically so every client bakes the identical field.
    if (needTufts) {
      if (!tufts) {
        // Tuft sheet not ready yet — bake base+mottle only, retry next frame.
        this._grassKey = null;
        this._grassField = cv;
        return cv;
      }
      const SRC = 16;
      const COUNT = Math.max(1, Math.floor((tufts.naturalWidth || 176) / SRC));
      const BLOCK = 32;
      const DENSITY = 0.20;                            // ~20% of blocks get a tuft
      const cols = Math.ceil(tw / BLOCK), rows = Math.ceil(th / BLOCK);
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          if (hash(rx + 17, ry + 31) > DENSITY) continue;
          const idx  = (hash(rx + 7, ry + 3) * COUNT) | 0;
          const size = 22 + ((hash(rx + 11, ry + 5) * 12) | 0);   // 22–33px
          const ax = rx * BLOCK;
          const ay = ry * BLOCK + BLOCK - size;
          g.drawImage(tufts, idx * SRC, 0, SRC, SRC, ax, ay, size, size);
        }
      }
    }

    // 4) Optional atmospheric wash (night blue / dawn warm / etc).
    if (pal.wash) { g.fillStyle = pal.wash; g.fillRect(0, 0, tw, th); }

    this._grassField = cv;
    this._grassKey = key;
    return cv;
  }

  /**
   * Special obstacle: water. Bodies block player movement but let projectiles
   * fly over (the sim only adds water to the movement blockers, never to the
   * projectile/LOS checks). On the snow biome it renders as frozen ice (and the
   * sim leaves it out of the blockers, so players walk across). Drawn on the
   * floor under players. Foam/ice edges are painted on cells bordering land.
   */
  _drawWater(ctx, camera, cw, ch, water, biome) {
    if (!water || !water.tiles || !water.tiles.length) return;
    const z = camera.zoom || 1;
    const col = biome === 'snow' ? WATER_COLORS.ice : WATER_COLORS.water;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // Body: filled strips with a lighter surface band along the top.
    for (const t of water.tiles) {
      const a = camera.toScreen(t.x, t.y, cw, ch);
      const w = t.w * z, h = t.h * z;
      if (a.x + w < -20 || a.x > cw + 20 || a.y + h < -20 || a.y > ch + 20) continue;
      const x = Math.round(a.x), y = Math.round(a.y), W = Math.ceil(w), H = Math.ceil(h);
      ctx.fillStyle = col.body;
      ctx.fillRect(x, y, W, H);
      ctx.fillStyle = col.band;
      ctx.fillRect(x, y, W, Math.max(2, Math.round(H * 0.16)));
    }
    // Shoreline foam / ice rim: edges of cells whose neighbour is land.
    const cell = water.cell, cells = water.cells;
    const lw = Math.max(1, Math.round(2 * z));
    ctx.fillStyle = col.edge;
    for (const k of cells) {
      const ci = k.indexOf(',');
      const c = +k.slice(0, ci), r = +k.slice(ci + 1);
      const a = camera.toScreen(c * cell, r * cell, cw, ch);
      const s = cell * z;
      if (a.x + s < -20 || a.x > cw + 20 || a.y + s < -20 || a.y > ch + 20) continue;
      const x = Math.round(a.x), y = Math.round(a.y), S = Math.ceil(s);
      if (!cells.has(`${c},${r - 1}`)) ctx.fillRect(x, y, S, lw);            // top
      if (!cells.has(`${c},${r + 1}`)) ctx.fillRect(x, y + S - lw, S, lw);   // bottom
      if (!cells.has(`${c - 1},${r}`)) ctx.fillRect(x, y, lw, S);            // left
      if (!cells.has(`${c + 1},${r}`)) ctx.fillRect(x + S - lw, y, lw, S);   // right
    }
    ctx.restore();
  }

  /**
   * Draw high intensity boundaries
   */
  _drawBorders(ctx, camera, cw, ch, mapWidth, mapHeight) {
    ctx.save();
    const tl = camera.toScreen(0, 0, cw, ch);
    const br = camera.toScreen(mapWidth, mapHeight, cw, ch);
    const w = br.x - tl.x, h = br.y - tl.y;

    // Darken everything beyond the arena walls.
    ctx.fillStyle = '#07060b';
    if (tl.y > 0) ctx.fillRect(0, 0, cw, tl.y);
    if (tl.x > 0) ctx.fillRect(0, tl.y, tl.x, ch - tl.y);
    if (br.x < cw) ctx.fillRect(br.x, tl.y, cw - br.x, ch - tl.y);
    if (br.y < ch) ctx.fillRect(0, br.y, cw, ch - br.y);

    // Stone wall (thick) + lighter capstone edge — warm castle masonry.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#5b5048';
    ctx.lineWidth = 8;
    ctx.strokeRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = '#7a6b58';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x - 3, tl.y - 3, w + 6, h + 6);

    // Gilded brass trim on the inner edge (medieval, torch-lit).
    ctx.shadowBlur = this._glow * 10;
    ctx.shadowColor = '#c9a227';
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x + 4, tl.y + 4, w - 8, h - 8);
    ctx.shadowBlur = 0;

    // Flickering torches: four corners + the middle of each wall (medieval + glow).
    const now = Date.now();
    const mx = (tl.x + br.x) / 2, my = (tl.y + br.y) / 2;
    this._drawTorch(ctx, tl.x, tl.y, now);
    this._drawTorch(ctx, br.x, tl.y, now);
    this._drawTorch(ctx, tl.x, br.y, now);
    this._drawTorch(ctx, br.x, br.y, now);
    this._drawTorch(ctx, mx, tl.y, now);
    this._drawTorch(ctx, mx, br.y, now);
    this._drawTorch(ctx, tl.x, my, now);
    this._drawTorch(ctx, br.x, my, now);

    ctx.restore();
  }

  // A corner wall torch: iron sconce + flickering amber flame with a warm glow.
  _drawTorch(ctx, x, y, now) {
    ctx.save();
    ctx.fillStyle = '#2a2018';
    ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.strokeStyle = '#5b5044';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
    const flick = Math.sin(now / 90 + x * 0.5) * 2 + Math.sin(now / 47 + y) * 1;
    ctx.shadowBlur = this._glow * 14;
    ctx.shadowColor = '#fb923c';
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(x, y - 14 - flick);
    ctx.quadraticCurveTo(x + 5, y - 2, x, y + 3);
    ctx.quadraticCurveTo(x - 5, y - 2, x, y - 14 - flick);
    ctx.fill();
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.moveTo(x, y - 8 - flick);
    ctx.quadraticCurveTo(x + 2.5, y - 1, x, y + 1);
    ctx.quadraticCurveTo(x - 2.5, y - 1, x, y - 8 - flick);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Graphic drawings for bow arrows
   */
  _drawProjectiles(ctx, camera, cw, ch, projectiles, players) {
    ctx.save();
    const zoom = camera.zoom || 1;

    projectiles.forEach(p => {
      if (p.isDead) return;

      const scr = camera.toScreen(p.x, p.y, cw, ch);
      if (scr.x < -60 || scr.x > cw + 60 || scr.y < -60 || scr.y > ch + 60) return;

      const angle = Number.isFinite(p.angle) ? p.angle : Math.atan2(p.vy, p.vx);
      const owner = players && p.ownerId ? players[p.ownerId] : null;

      if (p.kind === 'wsranged') {
        // Workshop ranged projectile: draw its chosen procedural shape.
        drawProjectileShape(ctx, scr.x, scr.y, angle, p.wsImageId || 'arrow', (18 * (p.wsScale || 1)) * zoom);
      } else if (p.kind === 'thrownspear') {
        this._drawWeaponProjectile(ctx, scr, angle, zoom, 'spear', owner, { tumble: true });
      } else if (p.kind === 'chakram') {
        this._drawWeaponProjectile(ctx, scr, angle, zoom, 'chakram', owner, { spin: true });
      } else if (p.kind === 'harpoon') {
        this._drawWeaponProjectile(ctx, scr, angle, zoom, 'harpoon', owner, {});
        this._drawHarpoonRope(ctx, scr, angle, zoom);
      } else if (p.kind === 'swordwave') {
        this._drawSwordWave(ctx, scr, angle, zoom);
      } else if (p.kind === 'greatswordwave') {
        this._drawGreatswordWave(ctx, scr, angle, zoom);
      } else if (p.kind === 'fireball') {
        this._drawFireball(ctx, scr, angle, zoom);
      } else if (p.kind === 'iceshard') {
        this._drawIceShard(ctx, scr, angle, zoom);
      } else if (p.kind === 'pistol') {
        this._drawPistolBullet(ctx, scr, angle, zoom);
      } else if (p.kind === 'guardianlaunch' || p.kind === 'guardiandart' || p.kind === 'guardianseek') {
        this._drawWeaponProjectile(ctx, scr, p.angle, zoom, 'guardian', p, { tumble: true });
      } else {
        this._drawArrow(ctx, scr, angle);
      }
    });

    ctx.restore();
  }

  // Draws the actual weapon sprite as a flying projectile. Used for weapons
  // that are literally thrown — spear (tumbles), chakram (spins), harpoon.
  _drawWeaponProjectile(ctx, scr, angle, zoom, weapon, owner, { spin = false, tumble = false } = {}) {
    // Resolve sprite: prefer owner's per-weapon skin, fall back to base.
    const skin = owner?.weaponSkins?.[weapon];
    const img = (skin && this.atlas?.get(`wpn/${weapon}@${skin}`))
              || this.atlas?.get(`wpn/${weapon}`);
    if (!img || !img.naturalWidth) {
      // No sprite available — use old canvas fallback per weapon.
      if (weapon === 'harpoon') this._drawHarpoon(ctx, scr, angle, zoom);
      else if (weapon === 'spear') this._drawThrownSpear(ctx, scr, angle, zoom);
      else this._drawChakram(ctx, scr, zoom);
      return;
    }

    const tune = WEAPON_SPRITE_TUNE[weapon] || WEAPON_TUNE_DEFAULT;
    const size = 16 * 2 * (tune.scale || 1) * Math.max(0.7, zoom * 0.55 + 0.3);

    // Sprites point UP-RIGHT (-π/4). To align the tip with the flight angle:
    // rotation = angle + π/4. Tumbling adds a time-based extra spin.
    let rot = angle + Math.PI / 4 + (tune.rot || 0);
    if (spin)   rot = (Date.now() / 90)  % (Math.PI * 2);           // chakram: full spin, no angle
    if (tumble) rot = angle + Math.PI / 4 + (Date.now() / 120) % (Math.PI * 2); // spear: tumbles along path

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(scr.x), Math.round(scr.y));
    ctx.rotate(rot);
    // Center the sprite on the projectile position.
    ctx.drawImage(img, -size * 0.5, -size * 0.5, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
  }

  // Harpoon rope trail — kept separate so it draws under the sprite.
  _drawHarpoonRope(ctx, scr, angle, zoom) {
    const len = 20 * (0.7 + zoom * 0.3);
    const tailX = scr.x - Math.cos(angle) * len;
    const tailY = scr.y - Math.sin(angle) * len;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,130,96,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawArrow(ctx, scr, angle) {
    if (this._drawProjectileSprite(ctx, 'arrow', scr, angle)) return;

    ctx.save();
    const length = 22;

    // 1. Draw glowing outer energy trace aura
      ctx.strokeStyle = 'rgba(163, 255, 69, 0.4)';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(scr.x, scr.y);
      ctx.lineTo(scr.x - Math.cos(angle) * length, scr.y - Math.sin(angle) * length);
      ctx.stroke();

      // 2. Draw solid primary energetic arrow shaft (neon lime)
      ctx.strokeStyle = '#a3ff45';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(scr.x, scr.y);
      ctx.lineTo(scr.x - Math.cos(angle) * length, scr.y - Math.sin(angle) * length);
      ctx.stroke();

      // 3. Draw bright white core shaft line
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(scr.x, scr.y);
      ctx.lineTo(scr.x - Math.cos(angle) * (length * 0.75), scr.y - Math.sin(angle) * (length * 0.75));
      ctx.stroke();

      // 4. Draw a beautifully styled arrowhead triangle
      ctx.save();
      ctx.translate(scr.x, scr.y);
      ctx.rotate(angle);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#a3ff45';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(-6, -4);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-6, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // 5. Draw arrow tail fletching wings
      ctx.save();
      const tailX = scr.x - Math.cos(angle) * length;
      const tailY = scr.y - Math.sin(angle) * length;
      ctx.translate(tailX, tailY);
      ctx.rotate(angle);
      ctx.strokeStyle = '#a3ff45';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // Draw fletch lines branching backwards
      ctx.moveTo(-2, -3);
      ctx.lineTo(2, 0);
      ctx.lineTo(-2, 3);
      ctx.stroke();
      ctx.restore();

    ctx.restore();
  }

  _drawProjectileSprite(ctx, key, scr, angle) {
    const sprite = this.projectileSprites?.[key];
    if (!sprite?.ready || !sprite.image?.naturalWidth) return false;
    const { meta, image } = sprite;
    const size = Math.max(image.naturalWidth, image.naturalHeight) * (meta.scale || 1);

    ctx.save();
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(scr.x), Math.round(scr.y));
    ctx.rotate(angle + (meta.angleOffset || 0));
    ctx.drawImage(
      image,
      -size * (Number.isFinite(meta.anchorX) ? meta.anchorX : 0.5),
      -size * (Number.isFinite(meta.anchorY) ? meta.anchorY : 0.5),
      size,
      size
    );
    ctx.imageSmoothingEnabled = smoothing;
    ctx.restore();
    return true;
  }

  // Harpoon bolt: a barbed head with a trailing rope back along its path.
  _drawHarpoon(ctx, scr, angle, zoom) {
    const len = 20 * (0.7 + zoom * 0.3);
    const tailX = scr.x - Math.cos(angle) * len;
    const tailY = scr.y - Math.sin(angle) * len;
    ctx.save();
    // rope
    ctx.strokeStyle = 'rgba(150,130,96,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    ctx.setLineDash([]);
    // head
    ctx.translate(scr.x, scr.y);
    ctx.rotate(angle);
    ctx.shadowColor = '#9aa2ad';
    ctx.shadowBlur = this._glow ? 4 : 0;
    ctx.fillStyle = '#c2cad6';
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-3, -5); ctx.lineTo(0, 0); ctx.lineTo(-3, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Small fast bullet with a short motion streak (dual pistols).
  _drawPistolBullet(ctx, scr, angle, zoom) {
    const len = 9 * (0.7 + zoom * 0.3);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(251, 113, 133, 0.4)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(scr.x - Math.cos(angle) * len, scr.y - Math.sin(angle) * len);
    ctx.stroke();
    ctx.shadowColor = '#fb7185';
    ctx.shadowBlur = this._glow ? 6 : 0;
    ctx.fillStyle = '#fecdd3';
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // A single teal guardian blade (used for launched blades and the orbit).
  _drawGuardianBlade(ctx, scr, zoom, spin = null) {
    const s = 9 * (0.7 + zoom * 0.3);
    const rot = spin !== null ? spin : (Date.now() / 70) % (Math.PI * 2);
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(rot);
    ctx.shadowColor = '#2dd4bf';
    ctx.shadowBlur = this._glow ? 7 : 0;
    ctx.fillStyle = '#2dd4bf';
    // A 4-point throwing-star blade.
    ctx.beginPath();
    ctx.moveTo(s, 0); ctx.lineTo(0, s * 0.4);
    ctx.lineTo(-s, 0); ctx.lineTo(0, -s * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, s); ctx.lineTo(s * 0.4, 0);
    ctx.lineTo(0, -s); ctx.lineTo(-s * 0.4, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#99f6e4';
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Two blades orbiting each guardian player, unless their blades are launched.
  /**
   * Draw the player body as a Ninja Adventure character sprite (Task 4-C).
   * Returns false if the atlas isn't ready / the skin failed to load, so the
   * caller falls back to the legacy square. Hitbox is unchanged — this is
   * purely cosmetic and centered on the player's logical position.
   */
  _drawCharacterSprite(ctx, scr, player, radius, isLocal, options = {}) {
    if (!this.atlas) return false;

    // All characters now share the side-view run sheet (RunBoy.png): 6 frames in
    // a single horizontal strip. The sprite faces LEFT; we flip horizontally when
    // the player faces right. Up/down has no dedicated art, so it falls back to
    // the horizontal facing (left when aiming straight up/down-ish).
    const runSheet = this.atlas.get('char/run');
    if (!runSheet || !runSheet.naturalWidth) return false;

    const TOTAL_FRAMES = 8;   // 0-5 run (faces right), 6 stand-right, 7 stand-left
    const RUN_FRAMES = 6;
    const cellW = runSheet.naturalWidth / TOTAL_FRAMES;
    const cellH = runSheet.naturalHeight;

    // Walk frame + facing both come from ACTUAL movement (position delta), not the
    // aim angle — a side-view runner should face where it walks, and flip the
    // instant the move direction flips. Idle / vertical-only keeps the last facing.
    const now = Date.now();
    const prev = this._charPrev[player.id];
    const dxMove = prev ? player.x - prev.x : 0;
    const moving = prev ? (Math.abs(dxMove) + Math.abs(player.y - prev.y)) > 0.4 : false;
    this._charPrev[player.id] = { x: player.x, y: player.y };
    let anim = this._charAnim[player.id];
    if (!anim) anim = this._charAnim[player.id] = { frame: 0, at: now, faceRight: true };
    if (options.faceByAim) {
      anim.faceRight = Math.cos(player.angle || 0) >= 0;
    } else if (Math.abs(dxMove) > 0.05) {
      anim.faceRight = dxMove > 0;
    }

    let drawFrame, flip;
    let airStretch = 1;
    if (player.grounded === false) {
      // Airborne (jump/fall): hold a single mid-stride leap frame instead of
      // cycling the run, and stretch a touch when rising / squash when falling
      // so a jump reads distinctly from a ground run. (grounded + vy are synced,
      // so remote players get the same pose.)
      anim.at = now;
      drawFrame = 3;                       // a mid-stride frame that reads as a leap
      flip = !anim.faceRight;
      const vy = Number.isFinite(player.vy) ? player.vy : 0;
      airStretch = vy < 0 ? 1.08 : 0.96;   // rising taller, falling flatter
    } else if (moving) {
      if (now - anim.at > 110) { anim.frame = (anim.frame + 1) % RUN_FRAMES; anim.at = now; }
      // Run art faces right; flip when moving left.
      drawFrame = anim.frame;
      flip = !anim.faceRight;
    } else {
      // Idle: dedicated standing frame for each side, already drawn directional.
      anim.at = now;
      drawFrame = anim.faceRight ? 6 : 7;
      flip = false;
    }
    const sx = drawFrame * cellW;

    // Keep the on-screen height stable; width follows the (slimmed) cell aspect.
    // Idle frames are squashed a touch vertically so the standing pose reads less
    // lanky; width is unchanged, so it just looks slightly flatter.
    const IDLE_SQUASH = 0.92;
    const refH = radius * 4.15;
    const drawW = refH * (cellW / cellH);
    const drawH = refH * (player.grounded === false ? airStretch : (moving ? 1 : IDLE_SQUASH));
    const feetY = scr.y + refH * 0.38;   // keep feet planted regardless of squash
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(scr.x, feetY);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(runSheet, sx, 0, cellW, cellH, -drawW / 2, -drawH, drawW, drawH);
    // Hit-flash: overlay a white silhouette of the same frame while the player's
    // _hurtFlashUntil window is open (set in Game._trackDamagePopups from the
    // synced HP drop, so it fires on host and clients).
    const flashLeft = (player._hurtFlashUntil || 0) - now;
    if (flashLeft > 0) {
      const fa = Math.min(1, flashLeft / 110);
      const prevFilter = ctx.filter;
      ctx.globalAlpha = fa;
      ctx.filter = 'brightness(0) invert(1)';
      ctx.drawImage(runSheet, sx, 0, cellW, cellH, -drawW / 2, -drawH, drawW, drawH);
      ctx.filter = prevFilter || 'none';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.imageSmoothingEnabled = prevSmooth;
    return true;
  }

  // Which body sheet a player uses. Cosmetic skin if set, else a stable default.
  _charSkinKey(player) {
    const want = player.bodySkin ? `char/${player.bodySkin}` : 'char/Boy';
    return this.atlas.has(want) ? want : 'char/Boy';
  }

  // 차크람 LMB 맴돌이: a single disc orbiting the caster while active. Mirrors the
  // host spin in _updateChakramOrbit (now/140, radius 46) so positions agree.
  _drawChakramOrbit(ctx, camera, cw, ch, players, now) {
    for (const id of Object.keys(players)) {
      const pl = players[id];
      if (!pl || pl.isDead || !(pl.chakramOrbitUntil > now)) continue;
      const radius = pl.chakramOrbitRadius || 46;
      const zoom = camera.zoom || 1;
      const baseAng = (now / 93) % (Math.PI * 2);
      for (let i = 0; i < 3; i++) {
        const ang = baseAng + (i / 3) * Math.PI * 2;
        const wx = pl.x + Math.cos(ang) * radius;
        const wy = pl.y + Math.sin(ang) * radius;
        this._drawWeaponProjectile(ctx, camera.toScreen(wx, wy, cw, ch), ang, zoom, 'chakram', pl, { spin: true });
      }
    }
  }

  // 열기 방패 (flamethrower LMB): a pulsing ember ring around the shielded player.
  _drawHeatShields(ctx, camera, cw, ch, players, now) {
    for (const id of Object.keys(players)) {
      const pl = players[id];
      if (!pl || pl.isDead || !(pl.heatShieldUntil > now)) continue;
      const scr = camera.toScreen(pl.x, pl.y, cw, ch);
      const z = camera.zoom || 1;
      const r = (pl.radius || 14) * z + 8 + Math.sin(now / 90) * 2;
      ctx.save();
      ctx.shadowColor = '#fb923c';
      ctx.shadowBlur = this._glow ? 14 : 0;
      ctx.strokeStyle = this._hexToRGB('#fb923c', 0.85);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = this._hexToRGB('#fde68a', 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(scr.x, scr.y, r - 3, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  _drawGuardianOrbits(ctx, camera, cw, ch, players, projectiles, now) {
    const cfg = Weapons.guardian;
    // Track which blade slots are currently deployed as guardianseek projectiles.
    const deployedSlots = {};
    if (Array.isArray(projectiles)) {
      for (const p of projectiles) {
        if (p.kind === 'guardianseek') {
          if (!deployedSlots[p.ownerId]) deployedSlots[p.ownerId] = new Set();
          deployedSlots[p.ownerId].add(p.bladeSlot);
        }
      }
    }
    const period = cfg.orbitPeriodMs || 1100;
    const n = cfg.orbitCount || 3;
    for (const id of Object.keys(players)) {
      const pl = players[id];
      if (!pl || pl.isDead || pl.weapon !== 'guardian') continue;
      const slots = deployedSlots[id] || new Set();
      const base = (now / period) * Math.PI * 2;
      const z = camera.zoom || 1;
      // F 버프 활성 중: orbit 반경 확장 + 글로우 강화 (시각적 버프 연출)
      const surging = pl.guardianSurgeUntil && now < pl.guardianSurgeUntil;
      const radius = cfg.orbitRadius + (surging ? 20 : 0);
      for (let i = 0; i < n; i++) {
        if (slots.has(i)) continue;
        const a = base + (i / n) * Math.PI * 2;
        const wx = pl.x + Math.cos(a) * radius;
        const wy = pl.y + Math.sin(a) * radius;
        const scr = camera.toScreen(wx, wy, cw, ch);
        if (surging) {
          ctx.save();
          ctx.shadowColor = '#67e8f9';
          ctx.shadowBlur = this._glow ? 16 : 0;
          this._drawWeaponProjectile(ctx, scr, -Math.PI / 2, z, 'guardian', pl);
          ctx.restore();
        } else {
          this._drawWeaponProjectile(ctx, scr, -Math.PI / 2, z, 'guardian', pl);
        }
      }
    }
  }

  _visualSwingDirection(weaponType, rawDirection) {
    const tune = WEAPON_SPRITE_TUNE[weaponType] || null;
    if (tune?.asymmetric && Number.isFinite(tune.swingDirection)) {
      return tune.swingDirection < 0 ? -1 : 1;
    }
    return rawDirection === -1 ? -1 : 1;
  }

  // Spinning chakram disc — a bladed ring that rotates over time.
  _drawChakram(ctx, scr, zoom) {
    const r = 13 * (0.7 + zoom * 0.3);
    const spin = (Date.now() / 90) % (Math.PI * 2);
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(spin);
    ctx.shadowColor = '#c2cad6';
    ctx.shadowBlur = this._glow ? 5 : 0;
    // Outer ring
    ctx.strokeStyle = '#c2cad6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    // Four blade spikes
    ctx.fillStyle = '#bae6fd';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(r - 2, -3);
      ctx.lineTo(r + 5, 0);
      ctx.lineTo(r - 2, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Hub
    ctx.fillStyle = '#8d99a8';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Trace a regular polygon (used by the fireball's hexagon trail).
  _tracePolygon(ctx, cx, cy, r, sides, rot = 0) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // 마법 지팡이 — 파이어볼: orange orb with a trailing chain of hexagons.
  _drawFireball(ctx, scr, angle, zoom) {
    ctx.save();
    const r = 9 * zoom;
    const t = Date.now();
    for (let i = 3; i >= 1; i--) {
      const tx = scr.x - Math.cos(angle) * (i * 9);
      const ty = scr.y - Math.sin(angle) * (i * 9);
      ctx.strokeStyle = this._hexToRGB('#fb923c', 0.5 - i * 0.12);
      ctx.lineWidth = 2;
      this._tracePolygon(ctx, tx, ty, r * (1 - i * 0.2), 6, t / 280 + i);
      ctx.stroke();
    }
    ctx.shadowBlur = this._glow * 16;
    ctx.shadowColor = '#fb923c';
    ctx.fillStyle = '#fed7aa';
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 마법 지팡이 — 아이스 샤드: light-blue icicle with a dotted trail.
  _drawIceShard(ctx, scr, angle, zoom) {
    ctx.save();
    const s = 7 * zoom;
    for (let i = 3; i >= 1; i--) {
      const tx = scr.x - Math.cos(angle) * (i * 7);
      const ty = scr.y - Math.sin(angle) * (i * 7);
      ctx.fillStyle = this._hexToRGB('#7dd3fc', 0.5 - i * 0.12);
      ctx.beginPath();
      ctx.arc(tx, ty, (4 - i) * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.translate(scr.x, scr.y);
    ctx.rotate(angle);
    ctx.shadowBlur = this._glow * 10;
    ctx.shadowColor = '#7dd3fc';
    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.moveTo(s * 1.6, 0);
    ctx.lineTo(-s * 0.4, -s * 0.55);
    ctx.lineTo(-s * 0.9, 0);
    ctx.lineTo(-s * 0.4, s * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(s * 1.2, 0);
    ctx.lineTo(-s * 0.2, -s * 0.28);
    ctx.lineTo(-s * 0.2, s * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Fire DoT: flickering flames ringing a burning player.
  _drawBurnFlames(ctx, scr, radius, zoom) {
    ctx.save();
    const t = Date.now();
    ctx.shadowBlur = this._glow * 8;
    ctx.shadowColor = '#f97316';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + t / 220;
      const wob = Math.sin(t / 90 + i * 1.7);
      const fx = scr.x + Math.cos(a) * radius * 0.75;
      const fy = scr.y + Math.sin(a) * radius * 0.75 - radius * 0.3;
      const h = (6 + wob * 3) * (0.7 + zoom * 0.3);
      ctx.fillStyle = this._hexToRGB(i % 2 ? '#fb923c' : '#fbbf24', 0.85);
      ctx.beginPath();
      ctx.moveTo(fx, fy - h);
      ctx.quadraticCurveTo(fx + 3, fy, fx, fy + 2);
      ctx.quadraticCurveTo(fx - 3, fy, fx, fy - h);
      ctx.fill();
    }
    ctx.restore();
  }

  // Loaded ice shards orbiting a magic-staff caster (waiting for F).
  _drawLoadedIcicles(ctx, scr, count, radius, zoom) {
    ctx.save();
    const t = Date.now();
    const orbit = radius + 16;
    ctx.shadowBlur = this._glow * 8;
    ctx.shadowColor = '#7dd3fc';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + t / 600;
      const ix = scr.x + Math.cos(a) * orbit;
      const iy = scr.y + Math.sin(a) * orbit;
      ctx.save();
      ctx.translate(ix, iy);
      ctx.rotate(a + Math.PI / 2); // tip pointing outward
      const s = 6 * (0.7 + zoom * 0.3);
      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.45, s * 0.5);
      ctx.lineTo(-s * 0.45, s * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.6);
      ctx.lineTo(s * 0.22, s * 0.4);
      ctx.lineTo(-s * 0.22, s * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // 라이프바운드: a green heal ring with rising sparkles.
  _drawLifeboundHeal(ctx, scr, e, alpha, zoom) {
    const progress = clamp01(e.progress);
    ctx.save();
    const r = (14 + 40 * easeOutCubic(progress)) * (0.6 + zoom * 0.4);
    ctx.shadowBlur = this._glow * 10 * alpha;
    ctx.shadowColor = '#a3e635';
    ctx.strokeStyle = this._hexToRGB('#a3e635', 0.7 * alpha);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this._hexToRGB('#bef264', 0.85 * alpha);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const rise = progress * 30;
      ctx.beginPath();
      ctx.arc(scr.x + Math.cos(a) * r * 0.6, scr.y + Math.sin(a) * r * 0.6 - rise, 2.4 * (1 - progress) + 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 아이스 샤드 장전: a quick light-blue ripple when shards are loaded.
  _drawIcicleLoad(ctx, scr, e, alpha, zoom) {
    const progress = clamp01(e.progress);
    ctx.save();
    const r = (10 + 30 * easeOutCubic(progress)) * (0.6 + zoom * 0.4);
    ctx.strokeStyle = this._hexToRGB('#7dd3fc', 0.6 * (1 - progress));
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    this._drawFxSprite(ctx, 'fx/magic/circleSpark', 6, 32, 32, scr.x, scr.y, r * 2.2, progress, alpha * (1 - progress) * 0.85, 0);
  }

  // 스나이퍼 순간이동: an expanding green scope ring with crosshair ticks.
  _drawSniperTeleport(ctx, scr, e, alpha, zoom) {
    const progress = clamp01(e.progress);
    ctx.save();
    const r = (8 + 34 * easeOutCubic(progress)) * (0.6 + zoom * 0.4);
    ctx.shadowBlur = this._glow * 10 * alpha;
    ctx.shadowColor = '#22c55e';
    ctx.strokeStyle = this._hexToRGB('#22c55e', 0.8 * alpha);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = this._hexToRGB('#bbf7d0', 0.7 * alpha);
    ctx.lineWidth = 1.5;
    for (const ang of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(ang) * r * 0.5, scr.y + Math.sin(ang) * r * 0.5);
      ctx.lineTo(scr.x + Math.cos(ang) * r, scr.y + Math.sin(ang) * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawThrownSpear(ctx, scr, angle, zoom) {
    const len = 30 * zoom;
    const tailX = scr.x - Math.cos(angle) * len;
    const tailY = scr.y - Math.sin(angle) * len;

    ctx.save();
    ctx.lineCap = 'round';
    // Glowing shaft
    ctx.strokeStyle = 'rgba(255, 163, 69, 0.4)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();

    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();

    // Spear head
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(angle);
    ctx.fillStyle = '#ffa345';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  _drawSwordWave(ctx, scr, angle, zoom) {
    const radius = Math.max(26, Weapons.sword.range * 0.56) * zoom;
    const halfAngle = ((Weapons.sword.angle || 110) * Math.PI) / 360;
    const apexX = -radius;

    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(angle);
    ctx.shadowBlur = this._glow * 6;
    ctx.shadowColor = '#e8eef6';
    ctx.lineCap = 'round';

    // Pizza-slice blade energy: the projectile sits on the far edge of the sword arc.
    ctx.fillStyle = 'rgba(220, 228, 238, 0.16)';
    ctx.beginPath();
    ctx.moveTo(apexX, 0);
    ctx.arc(apexX, 0, radius, -halfAngle, halfAngle);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(220, 228, 238, 0.78)';
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.arc(apexX, 0, radius, -halfAngle, halfAngle);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(apexX, 0, radius - 5, -halfAngle * 0.9, halfAngle * 0.9);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.46)';
    ctx.lineWidth = 1.5;
    [-halfAngle, halfAngle].forEach(edge => {
      ctx.beginPath();
      ctx.moveTo(apexX + Math.cos(edge) * 8, Math.sin(edge) * 8);
      ctx.lineTo(apexX + Math.cos(edge) * (radius - 3), Math.sin(edge) * (radius - 3));
      ctx.stroke();
    });

    ctx.restore();
  }

  /**
   * Fading graphic slices for melee collisions
   */
  _drawEffects(ctx, camera, cw, ch, effects, players = {}, localPlayerId = null, visualSettings = {}) {
    ctx.save();
    const zoom = camera.zoom || 1;

    effects.forEach(e => {
      if (!e || !Number.isFinite(e.progress)) return;

      const anchoredEffect = this._resolveEffectAttachment(e, players);
      const scr = camera.toScreen(anchoredEffect.x, anchoredEffect.y, cw, ch);
      const baseWeapon = getEffectiveWeapon(e.weapon, e.buffType) || Weapons.sword;
      // Convert the weapon's world-space reach into screen pixels so the drawn
      // effect lines up with the actual hitbox at any camera zoom. This is what
      // fixes the spear effect spilling past its hitbox on zoomed-out screens.
      const weapon = {
        ...baseWeapon,
        range: (Number.isFinite(e.range) ? e.range : (baseWeapon.range || 0)) * zoom,
        width: (Number.isFinite(e.width) ? e.width : (baseWeapon.width || 0)) * zoom,
        innerRange: (Number.isFinite(e.innerRange) ? e.innerRange : (baseWeapon.innerRange || 0)) * zoom,
        angle: Number.isFinite(e.angleDeg) ? e.angleDeg : baseWeapon.angle
      };
      const isEnemyEffect = Boolean(e.attackerId && e.attackerId !== localPlayerId);
      const minimized = Boolean(visualSettings.minimizeEnemyAttackEffects && isEnemyEffect && this._isCombatEffect(e));
      let alpha = clamp01(1 - e.progress);
      if (minimized) alpha *= 0.28;

      if (scr.x < -260 || scr.x > cw + 260 || scr.y < -260 || scr.y > ch + 260) {
        return;
      }

      // Fantasy lighting: only magic blooms. Steel (melee) and powder (ranged)
      // effects read as physical, so the default glow is suppressed for them and
      // reserved for arcane fire/frost/heal casts.
      const isMagicFx = MAGIC_EFFECT_TYPES.has(e.type) || baseWeapon.type === 'magic';
      ctx.shadowBlur = isMagicFx ? (this._glow * (minimized ? 4 : 14) * alpha) : 0;
      ctx.shadowColor = weapon.color;

      if (e.type === 'melee_heavy_arc') {
        this._drawHeavyCleave(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'greatsword_charge') {
        this._drawGreatswordCharge(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'katana_charge') {
        this._drawKatanaCharge(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'melee_sweet_arc') {
        this._drawScytheSweep(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'melee_backstab') {
        this._drawDaggerStab(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'dagger_qte_lock') {
        this._drawDaggerQteLock(ctx, camera, cw, ch, scr, anchoredEffect, players, weapon, alpha);
      } else if (e.type === 'dagger_qte_window') {
        this._drawDaggerQteWindow(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'dagger_qte_hit') {
        this._drawDaggerQteHit(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'dagger_qte_fail') {
        this._drawDaggerQteFail(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'melee_precise_line') {
        if (e.weapon === 'dagger') {
          this._drawDaggerPierce(ctx, scr, anchoredEffect, weapon, alpha);
        } else {
          this._drawRapierPierce(ctx, scr, anchoredEffect, weapon, alpha);
        }
      } else if (e.type === 'melee_heavy_line') {
        this._drawHeavyLine(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'melee_slam') {
        this._drawHammerSlam(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'hammer_windup') {
        this._drawHammerWindup(ctx, scr, anchoredEffect, weapon, alpha);
      } else if (e.type === 'melee_arc') {
        if (e.weapon === 'gauntlet') {
          this._drawPunchCombo(ctx, scr, anchoredEffect, weapon, alpha);
        } else {
          this._drawArcSlash(ctx, scr, anchoredEffect, weapon, alpha);
        }
      } else if (e.type === 'melee_circle') {
        if (e.weapon === 'axe') {
          this._drawArcSlash(ctx, scr, anchoredEffect, { ...weapon, angle: 360 }, alpha);
        } else {
          this._drawAxeSpin(ctx, scr, anchoredEffect, weapon, alpha);
        }
      } else if (e.type === 'melee_line') {
        if (e.weapon === 'gauntlet') {
          this._drawGauntletLance(ctx, scr, anchoredEffect, weapon, alpha);
        } else {
          this._drawSpearThrust(ctx, scr, anchoredEffect, weapon, alpha);
        }
      } else if (e.type === 'projectile_shot') {
        this._drawShotFlash(ctx, scr, e, weapon, alpha);
      } else if (e.type === 'projectile_burst') {
        this._drawProjectileBurst(ctx, scr, e, weapon, alpha);
      } else if (e.type === 'explosion') {
        this._drawExplosion(ctx, scr, e, weapon, alpha, zoom);
      } else if (e.type === 'railbeam') {
        const endScr = camera.toScreen(e.x2, e.y2, cw, ch);
        this._drawRailBeam(ctx, scr, endScr, e, weapon, alpha);
      } else if (e.type === 'sniper_telegraph' || e.type === 'matchlock_telegraph') {
        // Endpoint follows the attacker's live aim angle (mouse-tracking preview).
        const attacker = this._findPlayerById(players, e.attackerId);
        const liveAngle = Number.isFinite(attacker?.angle) ? attacker.angle : e.angle;
        const liveX = attacker ? attacker.x : anchoredEffect.x;
        const liveY = attacker ? attacker.y : anchoredEffect.y;
        const dist = e.beamDist || Math.max(2000, cw + ch);
        const endScr = camera.toScreen(
          liveX + Math.cos(liveAngle) * dist,
          liveY + Math.sin(liveAngle) * dist,
          cw, ch
        );
        const originScr = camera.toScreen(liveX, liveY, cw, ch);
        this._drawSniperTelegraph(ctx, originScr, endScr, e, weapon, alpha);
      } else if (e.type === 'buff_activate') {
        this._drawBuffActivate(ctx, scr, e, weapon, alpha, zoom);
      } else if (e.type === 'lifebound_heal') {
        this._drawLifeboundHeal(ctx, scr, e, alpha, zoom);
      } else if (e.type === 'icicle_load') {
        this._drawIcicleLoad(ctx, scr, e, alpha, zoom);
      } else if (e.type === 'sniper_teleport') {
        this._drawSniperTeleport(ctx, scr, e, alpha, zoom);
      } else if (e.type === 'mine_blast') {
        this._drawMineBlast(ctx, scr, e, alpha, zoom);
      } else if (e.type === 'kill_fx') {
        this._drawKillFx(ctx, scr, e, alpha, zoom);
      } else if (e.type === 'respawn_fx') {
        this._drawRespawnFx(ctx, scr, e, alpha, zoom);
      }
    });

    ctx.restore();
  }

  // Cosmetic kill effect at the victim (style chosen in the shop).
  _drawKillFx(ctx, scr, e, alpha, zoom) {
    const p = clamp01(e.progress);
    const col = e.color || '#ffd24a';
    ctx.save();
    ctx.globalAlpha = alpha * (1 - p);
    ctx.shadowColor = col;
    ctx.shadowBlur = this._glow ? 12 : 0;
    const n = e.style === 'coins' ? 8 : e.style === 'skull' ? 1 : 10;
    if (e.style === 'skull') {
      // a rising pixel skull
      ctx.fillStyle = col;
      const u = 2.4 * zoom, oy = -p * 22 * zoom;
      const rows = ['01110', '11111', '10101', '11111', '01110', '01010'];
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < 5; c++)
        if (rows[r][c] === '1') ctx.fillRect(scr.x + (c - 2.5) * u, scr.y + oy + (r - 3) * u, u, u);
    } else {
      // firework / coin fountain: radiating squares
      ctx.fillStyle = col;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (e.style === 'coins' ? -Math.PI / 2 : 0);
        const dist = (10 + p * 34) * zoom * (e.style === 'coins' ? Math.abs(Math.sin(a)) + 0.4 : 1);
        const s = Math.max(2, 3 * zoom);
        ctx.fillRect(scr.x + Math.cos(a) * dist - s / 2, scr.y + Math.sin(a) * dist - s / 2, s, s);
      }
    }
    ctx.restore();
  }

  // Cosmetic respawn effect at the player (a rising ring of color).
  _drawRespawnFx(ctx, scr, e, alpha, zoom) {
    const p = clamp01(e.progress);
    const col = e.color || '#67e8f9';
    ctx.save();
    ctx.globalAlpha = alpha * (1 - p);
    ctx.shadowColor = col;
    ctx.shadowBlur = this._glow ? 14 : 0;
    ctx.strokeStyle = col;
    ctx.lineWidth = 3 * zoom * (1 - p) + 1;
    const r = (6 + p * 30) * zoom;
    ctx.beginPath(); ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2); ctx.stroke();
    // upward sparks
    ctx.fillStyle = col;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.3;
      const d = (8 + p * 26) * zoom;
      const s = Math.max(2, 2.4 * zoom);
      ctx.fillRect(scr.x + Math.cos(a) * d - s / 2, scr.y + Math.sin(a) * d - s / 2, s, s);
    }
    ctx.restore();
  }

  // Expanding orange shockwave for a mine detonation.
  _drawMineBlast(ctx, scr, e, alpha, zoom) {
    const p = clamp01(e.progress);
    const r = (e.range || 60) * zoom * (0.3 + 0.7 * easeOutCubic(p));
    ctx.save();
    ctx.globalAlpha = alpha * (1 - p);
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = this._glow ? 14 : 0;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3 + 3 * (1 - p);
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(245,158,11,${0.25 * (1 - p)})`;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The Slash02 sheet is NOT a uniform grid; these are the pixel-detected frame
  // x-ranges (appear → grow → full → full → shrink → wisp). One blit per frame
  // keeps the blue slash cheap (no per-frame procedural drawing = no lag).
  _drawSlashFrames(ctx, key, rects, sheetH, cx, cy, targetH, progress, alpha, angle, flipY) {
    const sheet = this.atlas?.get(key);
    if (!sheet || !sheet.naturalWidth) return false;
    const n = rects.length;
    const fi = Math.min(n - 1, Math.max(0, Math.floor(clamp01(progress) * n)));
    const x0 = rects[fi][0], x1 = rects[fi][1];
    const fw = x1 - x0 + 1;
    const scale = targetH / sheetH;
    const dw = fw * scale, dh = sheetH * scale;
    const prev = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy);
    if (angle !== 0) ctx.rotate(angle);
    if (flipY) ctx.scale(-1, 1);   // mirror across the aim axis (sprite is rotated by aim+1.5pi, so aim runs vertically -> flip on X)
    ctx.drawImage(sheet, x0, 0, fw, sheetH, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.imageSmoothingEnabled = prev;
    return true;
  }

  // Blit one frame of an irregular ring sheet (e.g. SpriteSheetCircular) using
  // its tight per-frame bounding box, so each frame keeps its own size + aspect
  // and is centred on the player instead of on its (offset) cell. `rects` are
  // [sx, sy, w, h] in sheet px; `cell` is the reference full-ring size so the
  // whole animation scales by a single factor (targetSize / cell).
  _drawCircFrames(ctx, key, rects, cell, cx, cy, targetSize, progress, alpha, angle) {
    const sheet = this.atlas?.get(key);
    if (!sheet || !sheet.naturalWidth) return false;
    const n = rects.length;
    const fi = Math.min(n - 1, Math.max(0, Math.floor(clamp01(progress) * n)));
    const sx = rects[fi][0], sy = rects[fi][1], sw = rects[fi][2], sh = rects[fi][3];
    const scale = targetSize / cell;
    const dw = sw * scale, dh = sh * scale;
    const prev = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy);
    if (angle !== 0) ctx.rotate(angle);
    ctx.drawImage(sheet, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.imageSmoothingEnabled = prev;
    return true;
  }

  _drawArcSlash(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const finisher = Boolean(e.comboFinisher);
    const isFullCircleSlash = weapon.angle >= 359;
    const spriteAlpha = Math.pow(1 - progress, 0.4) * 0.95;

    if (isFullCircleSlash) {
      // Blue circular slash sheet — per-frame bbox so the ring stays centred on
      // the body and keeps its real (slightly elliptical) shape per frame.
      this._drawCircFrames(ctx, 'fx/slashCircular', CIRC_FRAMES, CIRC_CELL, scr.x, scr.y,
        weapon.range * 2.0, progress, spriteAlpha, e.angle);
      return;
    }

    // Blue crescent (Slash02). The sheet reads correctly when rotated to
    // e.angle + 270° (picked from the rotation-offset preview): the vertical
    // crescent stands in front with its belly toward the aim. Flip across the
    // swing axis for handedness, and nestle it close to the body.
    // Flip on the DOWN swing (swingDirection > 0) so the crescent curls the
    // same way the blade travels: down-swing curls down, up-swing curls up.
    const flipY = this._visualSwingDirection(e.weapon, e.swingDirection) > 0;
    const reach = weapon.range * (finisher ? 0.95 : 0.85);
    const targetH = reach * (finisher ? 1.45 : 1.2);
    const fwd = reach * (finisher ? 0.4 : 0.35);
    const cx = scr.x + Math.cos(e.angle) * fwd;
    const cy = scr.y + Math.sin(e.angle) * fwd;
    this._drawSlashFrames(ctx, 'fx/slash2', SLASH2_FRAMES, 50, cx, cy, targetH, progress, spriteAlpha, e.angle + Math.PI * 1.5, flipY);
  }

  _drawGreatswordWave(ctx, scr, angle, zoom) {
    const radius = Math.max(34, Weapons.greatsword.range * 0.62) * zoom;
    const halfAngle = ((Weapons.greatsword.angle || 100) * Math.PI) / 360;
    const apexX = -radius;

    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(angle);
    ctx.shadowBlur = this._glow *16;
    ctx.shadowColor = Weapons.greatsword.color;
    ctx.lineCap = 'round';

    ctx.fillStyle = 'rgba(139, 211, 255, 0.17)';
    ctx.beginPath();
    ctx.moveTo(apexX, 0);
    ctx.arc(apexX, 0, radius, -halfAngle, halfAngle);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = Weapons.greatsword.color;
    ctx.lineWidth = 5.8;
    ctx.beginPath();
    ctx.arc(apexX, 0, radius, -halfAngle, halfAngle);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(apexX, 0, radius - 5, -halfAngle * 0.9, halfAngle * 0.9);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.6;
    [-halfAngle, 0, halfAngle].forEach(edge => {
      ctx.beginPath();
      ctx.moveTo(apexX + Math.cos(edge) * 10, Math.sin(edge) * 10);
      ctx.lineTo(apexX + Math.cos(edge) * (radius - 3), Math.sin(edge) * (radius - 3));
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawHeavyCleave(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const charge = clamp01(progress / 0.42);
    const release = progress < 0.42 ? 0 : easeOutCubic((progress - 0.42) / 0.58);
    const pulse = 0.7 + 0.3 * Math.sin(progress * Math.PI * 8);

    ctx.save();
    if (progress < 0.42) {
      const halfAngle = ((weapon.angle || 95) * Math.PI) / 360;
      ctx.strokeStyle = this._hexToRGB(weapon.color, 0.35 * alpha * pulse);
      ctx.lineWidth = 2.4 * alpha;
      ctx.setLineDash([6, 7]);
      [-halfAngle, 0, halfAngle].forEach(offset => {
        ctx.beginPath();
        ctx.moveTo(scr.x + Math.cos(e.angle + offset) * 18, scr.y + Math.sin(e.angle + offset) * 18);
        ctx.lineTo(
          scr.x + Math.cos(e.angle + offset) * weapon.range * (0.45 + charge * 0.45),
          scr.y + Math.sin(e.angle + offset) * weapon.range * (0.45 + charge * 0.45)
        );
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }
    ctx.restore();

    // The blade-arc slash used to render ~100ms ahead of the character's swing
    // motion. Delay the slash by 100ms (converted to progress units) so the arc
    // lands together with the motion instead of leading it.
    const slashDelay = 100 / (e.lifetime || 720);
    const rawSlash = clamp01(Math.max(progress, release * 0.9) - slashDelay);
    // Skip the first of the 6 slash frames on the cleave — it reads as a stray
    // sliver. Remap progress into [1/6, 1] so playback starts on frame 1.
    const slashProgress = (1 + 5 * rawSlash) / 6;
    this._drawArcSlash(ctx, scr, { ...e, progress: slashProgress, comboFinisher: true }, weapon, alpha);
  }

  _drawGreatswordCharge(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const radius = weapon.range * (0.38 + 0.62 * progress);
    const halfAngle = ((weapon.angle || 210) * Math.PI) / 360;
    const threshold = clamp01(SkillConfig.greatsword.chargeThreshold ?? 0.5);
    const thresholdRadius = weapon.range * threshold;
    const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 80);

    // Below the charge threshold the strike only deals 1 damage — show that as a
    // dashed gray fan so the player can tell when the hit is still "weak".
    const underThreshold = progress < threshold;

    ctx.save();
    ctx.fillStyle = this._hexToRGB(underThreshold ? '#9ca3af' : weapon.color, (0.05 + 0.1 * progress) * alpha);
    ctx.strokeStyle = underThreshold
      ? this._hexToRGB('#9ca3af', (0.42 + 0.3 * pulse) * alpha)
      : this._hexToRGB(weapon.color, (0.35 + 0.3 * pulse) * alpha);
    ctx.lineWidth = (2 + 3 * progress) * alpha;
    ctx.setLineDash(underThreshold ? [7, 6] : []);
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.arc(scr.x, scr.y, radius, e.angle - halfAngle, e.angle + halfAngle);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = this._hexToRGB('#ffffff', (0.36 + 0.22 * pulse) * alpha);
    ctx.lineWidth = 1.8 * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, thresholdRadius, e.angle - halfAngle, e.angle + halfAngle);
    ctx.stroke();
    ctx.restore();

    [-0.72, 0, 0.72].forEach(t => {
      const a = e.angle + halfAngle * t;
      ctx.strokeStyle = this._hexToRGB('#ffffff', (0.22 + 0.28 * progress) * alpha);
      ctx.lineWidth = 1.7 * alpha;
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(a) * 16, scr.y + Math.sin(a) * 16);
      ctx.lineTo(scr.x + Math.cos(a) * radius, scr.y + Math.sin(a) * radius);
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawKatanaCharge(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const range = weapon.range || 150;
    const width = Math.max(8, weapon.width || 40);
    const fill = 0.25 + 0.75 * progress;
    const x = scr.x + Math.cos(e.angle) * 16;
    const y = scr.y + Math.sin(e.angle) * 16;

    ctx.save();
    ctx.shadowBlur = this._glow * 12 * alpha;
    ctx.shadowColor = weapon.color;
    this._drawAttackLane(
      ctx,
      x,
      y,
      e.angle,
      range * fill,
      width,
      this._hexToRGB(weapon.color, 0.08 * alpha)
    );

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.42 * alpha);
    ctx.lineWidth = 2 * alpha;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(e.angle) * range, y + Math.sin(e.angle) * range);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.82 * alpha);
    ctx.lineWidth = 3 * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, 19 + 4 * progress, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();
    ctx.restore();
  }

  _drawScytheSweep(ctx, scr, e, weapon, alpha) {
    this._drawArcSlash(ctx, scr, e, weapon, alpha);
  }

  _drawDaggerStab(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const thrust = progress < 0.22
      ? easeOutBack(progress / 0.22)
      : Math.max(0, 1 - (progress - 0.22) / 0.78);
    const reach = weapon.range * (0.35 + 0.65 * thrust);
    const side = e.swingDirection === -1 ? -1 : 1;
    const angle = e.angle + side * 0.16;
    const tipX = scr.x + Math.cos(angle) * reach;
    const tipY = scr.y + Math.sin(angle) * reach;

    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const offset = (i - 1) * 0.18 * side;
      const a = angle + offset;
      const start = 12 + i * 3;
      const end = reach - i * 5;
      this._drawCapsuleLine(
        ctx,
        scr.x + Math.cos(a) * start,
        scr.y + Math.sin(a) * start,
        scr.x + Math.cos(a) * end,
        scr.y + Math.sin(a) * end,
        (5 - i) * alpha,
        this._hexToRGB(i === 0 ? '#ffffff' : weapon.color, (0.55 - i * 0.12) * alpha)
      );
    }

    ctx.fillStyle = this._hexToRGB('#ffffff', 0.82 * alpha);
    ctx.strokeStyle = this._hexToRGB(weapon.color, alpha);
    ctx.lineWidth = 1.5;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -3.5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  _drawDaggerQteLock(ctx, camera, cw, ch, scr, e, players, weapon, alpha) {
    const target = this._findPlayerById(players, e.targetId);
    if (!target || target.isDead) return;
    const targetScr = camera.toScreen(target.x, target.y, cw, ch);
    const progress = clamp01(e.progress);

    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = `rgba(209, 213, 219, ${0.25 + 0.35 * (1 - progress)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.lineTo(targetScr.x, targetScr.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const scanR = 14 + 28 * progress;
    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.65 * alpha);
    ctx.beginPath();
    ctx.arc(targetScr.x, targetScr.y, scanR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawDaggerQteWindow(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const perfectT = clamp01((e.perfectMs || 560) / (e.lifetime || 900));
    const outer = 52 - 36 * progress;
    const target = 52 - 36 * perfectT;

    ctx.save();
    ctx.shadowBlur = this._glow *14 * alpha;
    ctx.shadowColor = weapon.color;
    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.65 * alpha);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, target, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.9 * alpha);
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, Math.max(4, outer), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawDaggerQteHit(ctx, scr, e, weapon, alpha) {
    ctx.save();
    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.86 * alpha);
    ctx.lineWidth = 5 * alpha;
    ctx.beginPath();
    ctx.moveTo(scr.x - 28, scr.y + 18);
    ctx.lineTo(scr.x + 26, scr.y - 18);
    ctx.stroke();
    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.75 * alpha);
    ctx.lineWidth = 2.2 * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, 18 + 22 * e.progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawDaggerQteFail(ctx, scr, e, weapon, alpha) {
    ctx.save();
    ctx.strokeStyle = this._hexToRGB('#ef4444', 0.8 * alpha);
    ctx.lineWidth = 3 * alpha;
    ctx.beginPath();
    ctx.moveTo(scr.x - 12, scr.y - 12);
    ctx.lineTo(scr.x + 12, scr.y + 12);
    ctx.moveTo(scr.x + 12, scr.y - 12);
    ctx.lineTo(scr.x - 12, scr.y + 12);
    ctx.stroke();
    ctx.restore();
  }

  _drawRapierPierce(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const thrust = progress < 0.16
      ? easeOutBack(progress / 0.16)
      : Math.max(0, 1 - (progress - 0.16) / 0.84);
    const reach = weapon.range * (0.2 + 0.8 * thrust);
    const tipX = scr.x + Math.cos(e.angle) * reach;
    const tipY = scr.y + Math.sin(e.angle) * reach;
    const baseX = scr.x + Math.cos(e.angle) * Math.max(8, reach - 18);
    const baseY = scr.y + Math.sin(e.angle) * Math.max(8, reach - 18);
    const pX = -Math.sin(e.angle);
    const pY = Math.cos(e.angle);
    const flare = 5.5 * thrust;

    ctx.save();
    if (progress < 0.42) {
      this._drawAttackLane(ctx, scr.x, scr.y, e.angle, weapon.range, 6, this._hexToRGB(weapon.color, 0.08 * alpha));
    }
    this._drawCapsuleLine(ctx, scr.x, scr.y, tipX, tipY, 1.1 * alpha, this._hexToRGB('#ffffff', 0.92 * alpha), 'butt');
    this._drawCapsuleLine(ctx, scr.x, scr.y, tipX, tipY, 3.6 * alpha, this._hexToRGB(weapon.color, 0.24 * alpha), 'butt');

    ctx.fillStyle = this._hexToRGB('#ffffff', 0.88 * alpha);
    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.9 * alpha);
    ctx.lineWidth = 1.2 * alpha;
    ctx.beginPath();
    ctx.moveTo(tipX + Math.cos(e.angle) * 12, tipY + Math.sin(e.angle) * 12);
    ctx.lineTo(baseX + pX * flare, baseY + pY * flare);
    ctx.lineTo(baseX - pX * flare, baseY - pY * flare);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.72 * alpha);
    ctx.lineWidth = 0.9 * alpha;
    ctx.beginPath();
    ctx.moveTo(scr.x + pX * 3, scr.y + pY * 3);
    ctx.lineTo(baseX + pX * flare * 0.55, baseY + pY * flare * 0.55);
    ctx.moveTo(scr.x - pX * 3, scr.y - pY * 3);
    ctx.lineTo(baseX - pX * flare * 0.55, baseY - pY * flare * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  _drawDaggerPierce(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const thrust = progress < 0.14
      ? easeOutBack(progress / 0.14)
      : Math.max(0, 1 - (progress - 0.14) / 0.86);
    const reach = weapon.range * (0.12 + 0.88 * thrust);
    const tipX = scr.x + Math.cos(e.angle) * reach;
    const tipY = scr.y + Math.sin(e.angle) * reach;
    const baseX = scr.x + Math.cos(e.angle) * Math.max(6, reach - 18);
    const baseY = scr.y + Math.sin(e.angle) * Math.max(6, reach - 18);
    const pX = -Math.sin(e.angle);
    const pY = Math.cos(e.angle);
    const flare = 8 * thrust;

    ctx.save();
    if (progress < 0.36) {
      this._drawAttackLane(ctx, scr.x, scr.y, e.angle, weapon.range, 10, this._hexToRGB(weapon.color, 0.08 * alpha));
    }

    ctx.shadowBlur = this._glow *12 * alpha;
    ctx.shadowColor = weapon.color;
    ctx.fillStyle = this._hexToRGB(weapon.color, 0.32 * alpha);
    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.88 * alpha);
    ctx.lineWidth = 1.8 * alpha;
    ctx.beginPath();
    ctx.moveTo(tipX + Math.cos(e.angle) * 9, tipY + Math.sin(e.angle) * 9);
    ctx.lineTo(baseX + pX * flare, baseY + pY * flare);
    ctx.lineTo(baseX - pX * flare, baseY - pY * flare);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    this._drawCapsuleLine(ctx, scr.x, scr.y, tipX, tipY, 1.5 * alpha, this._hexToRGB('#ffffff', 0.92 * alpha), 'butt');
    [-1, 1].forEach(side => {
      ctx.strokeStyle = this._hexToRGB(weapon.color, 0.36 * alpha);
      ctx.lineWidth = 1.1 * alpha;
      ctx.beginPath();
      ctx.moveTo(scr.x + pX * side * 4, scr.y + pY * side * 4);
      ctx.lineTo(baseX + pX * side * flare * 0.7, baseY + pY * side * flare * 0.7);
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawHeavyLine(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const charge = clamp01(progress / 0.28);
    const release = progress < 0.28 ? 0 : easeOutCubic((progress - 0.28) / 0.72);
    const length = weapon.range * (0.35 + release * 0.65);
    const width = weapon.width || 46;

    ctx.save();
    this._drawAttackLane(ctx, scr.x, scr.y, e.angle, weapon.range, width, this._hexToRGB(weapon.color, 0.13 * alpha));
    this._drawCapsuleLine(ctx, scr.x, scr.y, scr.x + Math.cos(e.angle) * length, scr.y + Math.sin(e.angle) * length, width * 0.34 * alpha, this._hexToRGB(weapon.color, 0.44 * alpha), 'round');
    this._drawCapsuleLine(ctx, scr.x, scr.y, scr.x + Math.cos(e.angle) * length, scr.y + Math.sin(e.angle) * length, 5.2 * alpha, this._hexToRGB('#ffffff', 0.86 * alpha), 'round');

    const pX = -Math.sin(e.angle);
    const pY = Math.cos(e.angle);
    [0.38, 0.66, 0.9].forEach((t, i) => {
      const cx = scr.x + Math.cos(e.angle) * weapon.range * t;
      const cy = scr.y + Math.sin(e.angle) * weapon.range * t;
      const crack = width * (0.2 + i * 0.07) * (0.4 + charge * 0.6);
      ctx.strokeStyle = this._hexToRGB('#ffffff', (0.34 - i * 0.06) * alpha);
      ctx.lineWidth = 1.7 * alpha;
      ctx.beginPath();
      ctx.moveTo(cx - pX * crack, cy - pY * crack);
      ctx.lineTo(cx + pX * crack, cy + pY * crack);
      ctx.stroke();
    });
    ctx.restore();
  }

  _drawHammerSlam(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const charge = clamp01(progress / 0.42);
    const release = progress < 0.42 ? 0 : easeOutCubic((progress - 0.42) / 0.58);
    const radius = weapon.range * (0.35 + 0.65 * Math.max(charge * 0.45, release));

    if (release > 0) {
      const spriteAlpha = Math.pow(1 - progress, 0.25) * 0.95;
      this._drawFxSprite(ctx, 'fx/explosion', 9, 40, 40, scr.x, scr.y, radius * 2.8, release, spriteAlpha, e.angle);
    }
  }

  _drawHammerWindup(ctx, scr, e, weapon, alpha) {
    const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 70);
    const lifetime = e.lifetime || 1;
    const elapsed = clamp01(e.progress) * lifetime; // ms since cast
    // e.ranges are raw world radii; weapon.range is already zoom-scaled, so
    // recover the zoom factor to scale each telegraphed ring.
    const zoom = e.range ? weapon.range / e.range : 1;
    const ranges = (Array.isArray(e.ranges) && e.ranges.length ? e.ranges : [e.range || weapon.range]).map(r => r * zoom);
    const hits = Array.isArray(e.hitOffsets) ? e.hitOffsets : [];
    const fillStart = e.fillStartMs ?? 0;

    // The filling disc reaches ranges[i] exactly at hitOffsets[i], so it visibly
    // touches each dashed ring the instant that shockwave fires.
    let fillR = 0;
    let prevT = fillStart;
    let prevR = 0;
    for (let i = 0; i < ranges.length; i++) {
      const at = Number.isFinite(hits[i]) ? hits[i] : lifetime;
      if (elapsed >= at) { prevT = at; prevR = ranges[i]; fillR = ranges[i]; continue; }
      const span = at - prevT;
      const seg = span > 0 ? clamp01((elapsed - prevT) / span) : 1;
      fillR = prevR + (ranges[i] - prevR) * seg;
      break;
    }

    ctx.save();

    // Filling disc (the "countdown" that touches each ring on its hit).
    if (fillR > 0) {
      ctx.fillStyle = this._hexToRGB(weapon.color, 0.1 * alpha);
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, fillR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = this._hexToRGB('#ffffff', 0.6 * alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, fillR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The shockwave radii as dashed rings; already-fired ones glow in weapon color.
    ctx.setLineDash([8, 7]);
    ctx.lineCap = 'round';
    ranges.forEach((r, i) => {
      const fired = elapsed >= (Number.isFinite(hits[i]) ? hits[i] : Infinity);
      ctx.strokeStyle = this._hexToRGB(fired ? weapon.color : '#ffffff', (fired ? 0.7 : 0.3 + 0.25 * pulse) * alpha);
      ctx.lineWidth = ((fired ? 2.6 : 1.6) + 0.5 * i) * Math.max(0.6, alpha);
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawPunchCombo(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const thrust = progress < 0.38
      ? easeOutBack(progress / 0.38)
      : Math.max(0, 1 - (progress - 0.38) / 0.62);
    const fistRadius = 5.5;
    const reach = Math.min(weapon.range - fistRadius, weapon.range * (0.35 + 0.5 * thrust));
    const offsets = [-0.22, 0.22];

    ctx.save();
    offsets.forEach((offset, index) => {
      const angle = e.angle + offset;
      const base = 10 + index * 2;
      const x1 = scr.x + Math.cos(angle) * base;
      const y1 = scr.y + Math.sin(angle) * base;
      const x2 = scr.x + Math.cos(angle) * reach;
      const y2 = scr.y + Math.sin(angle) * reach;

      this._drawCapsuleLine(ctx, x1, y1, x2, y2, 10 * alpha, this._hexToRGB(weapon.color, 0.48 * alpha));
      this._drawCapsuleLine(ctx, x1, y1, x2, y2, 5 * alpha, this._hexToRGB('#ffffff', 0.75 * alpha));

      ctx.strokeStyle = this._hexToRGB(weapon.color, 0.65 * alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x2, y2, fistRadius, 0, Math.PI * 2);
      ctx.stroke();
    });

    ctx.fillStyle = this._hexToRGB(weapon.color, 0.12 * alpha);
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y);
    ctx.arc(scr.x, scr.y, weapon.range, e.angle - 0.42, e.angle + 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawAxeSpin(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const finisher = Boolean(e.comboFinisher);
    const scale = progress < 0.22
      ? easeOutCubic(progress / 0.22)
      : 1 + (progress - 0.22) * (finisher ? 0.18 : 0.06);
    const radius = Math.max(2, weapon.range * scale);
    const spinAngle = e.angle - progress * Math.PI * (finisher ? 6.2 : 4.4);
    const spriteAlpha = Math.pow(1 - progress, 0.4) * 0.95;
    this._drawCircFrames(ctx, 'fx/slashCircular', CIRC_FRAMES, CIRC_CELL, scr.x, scr.y, radius * 2.0, progress, spriteAlpha, spinAngle);
  }

  _drawSpearThrust(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const finisher = Boolean(e.comboFinisher);
    const length = weapon.range;
    const width = weapon.width;
    const ext = progress < 0.16
      ? easeOutCubic(progress / 0.16)
      : progress < 0.38
        ? 1 - ((progress - 0.16) / 0.22) * 0.06
        : Math.max(0, 0.94 * (1 - (progress - 0.38) / 0.62));
    const shake = progress > 0.14 && progress < 0.36 ? Math.sin(progress * 120) * 0.02 : 0;
    const angle = e.angle + shake;
    const tipX = scr.x + Math.cos(angle) * length * ext;
    const tipY = scr.y + Math.sin(angle) * length * ext;

    ctx.save();

    if (progress < 0.5) {
      const laneAlpha = (finisher ? 0.25 : 0.16) * (1 - progress / 0.5);
      this._drawAttackLane(ctx, scr.x, scr.y, e.angle, length, width, this._hexToRGB(weapon.color, laneAlpha));
    }

    const headSize = Math.max(6, width * (finisher ? 0.68 : 0.52)) * (0.75 + alpha * 0.25);
    const shaftEndX = scr.x + Math.cos(angle) * Math.max(0, length * ext - headSize * 0.6);
    const shaftEndY = scr.y + Math.sin(angle) * Math.max(0, length * ext - headSize * 0.6);

    this._drawCapsuleLine(ctx, scr.x, scr.y, shaftEndX, shaftEndY, width * (finisher ? 0.96 : 0.78) * alpha, this._hexToRGB(weapon.color, (finisher ? 0.68 : 0.54) * alpha), 'butt');
    this._drawCapsuleLine(ctx, scr.x, scr.y, shaftEndX, shaftEndY, (finisher ? 5.2 : 4.0) * alpha, this._hexToRGB('#ffffff', 0.86 * alpha), 'butt');

    ctx.fillStyle = this._hexToRGB('#ffffff', 0.88 * alpha);
    ctx.strokeStyle = this._hexToRGB(weapon.color, alpha);
    ctx.lineWidth = 2;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-headSize, -headSize * 0.52);
    ctx.lineTo(-headSize * 0.62, 0);
    ctx.lineTo(-headSize, headSize * 0.52);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (progress < 0.25) {
      ctx.strokeStyle = this._hexToRGB('#ffffff', 0.42 * (1 - progress / 0.25));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(scr.x + Math.cos(e.angle) * 12, scr.y + Math.sin(e.angle) * 12, 8 + 28 * progress, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _isCombatEffect(effect) {
    return Boolean(effect && (
      effect.type === 'melee_arc' ||
      effect.type === 'melee_circle' ||
      effect.type === 'melee_line' ||
      effect.type === 'melee_heavy_arc' ||
      effect.type === 'melee_sweet_arc' ||
      effect.type === 'melee_backstab' ||
      effect.type === 'melee_precise_line' ||
      effect.type === 'melee_heavy_line' ||
      effect.type === 'melee_slam' ||
      effect.type === 'greatsword_charge' ||
      effect.type === 'katana_charge' ||
      effect.type === 'dagger_qte_lock' ||
      effect.type === 'dagger_qte_window' ||
      effect.type === 'dagger_qte_hit' ||
      effect.type === 'hammer_windup' ||
      effect.type === 'projectile_shot' ||
      effect.type === 'projectile_burst' ||
      effect.type === 'railbeam'
    ));
  }

  _drawGauntletLance(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const finisher = Boolean(e.comboFinisher);
    const length = weapon.range;
    const width = weapon.width;
    const rawThrust = progress < 0.14
      ? easeOutBack(progress / 0.14)
      : Math.max(0, 1 - (progress - 0.14) / 0.86);
    const thrust = clamp01(rawThrust);
    const angle = e.angle;
    const pulse = 0.75 + 0.25 * Math.sin(progress * Math.PI * (finisher ? 11 : 8));
    const fistRadius = Math.max(6, width * (finisher ? 0.56 : 0.42)) * pulse;
    const burstRadius = progress < 0.28 ? Math.min(width * 0.5, 7 + 12 * progress) : 0;
    const maxVisualRadius = Math.max(fistRadius, burstRadius);
    const rawReach = length * (0.28 + 0.62 * thrust);
    const reach = Math.max(maxVisualRadius + 2, Math.min(length - maxVisualRadius - 2, rawReach));
    const fistX = scr.x + Math.cos(angle) * reach;
    const fistY = scr.y + Math.sin(angle) * reach;

    ctx.save();
    ctx.lineCap = 'round';

    if (progress < 0.55) {
      const laneAlpha = (finisher ? 0.24 : 0.13) * (1 - progress / 0.55);
      this._drawAttackLane(ctx, scr.x, scr.y, angle, length, width, this._hexToRGB(weapon.color, laneAlpha));
    }

    const trailStart = Math.max(10, reach - length * 0.48);
    this._drawCapsuleLine(
      ctx,
      scr.x + Math.cos(angle) * trailStart,
      scr.y + Math.sin(angle) * trailStart,
      fistX,
      fistY,
      width * (finisher ? 0.92 : 0.72) * alpha,
      this._hexToRGB(weapon.color, (finisher ? 0.52 : 0.36) * alpha),
      'round'
    );
    this._drawCapsuleLine(
      ctx,
      scr.x + Math.cos(angle) * Math.max(8, reach - length * 0.28),
      scr.y + Math.sin(angle) * Math.max(8, reach - length * 0.28),
      fistX,
      fistY,
      (finisher ? 5.4 : 4.2) * alpha,
      this._hexToRGB('#ffffff', 0.72 * alpha),
      'round'
    );

    ctx.save();
    ctx.translate(fistX, fistY);
    ctx.rotate(angle);

    ctx.shadowBlur = this._glow *12 * alpha;
    ctx.shadowColor = weapon.color;
    ctx.fillStyle = this._hexToRGB(weapon.color, 0.72 * alpha);
    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.82 * alpha);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, fistRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.72 * alpha);
    ctx.lineWidth = 1.5;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-fistRadius * 0.35, i * fistRadius * 0.34);
      ctx.lineTo(fistRadius * 0.45, i * fistRadius * 0.22);
      ctx.stroke();
    }
    ctx.restore();

    if (progress < 0.28) {
      ctx.strokeStyle = this._hexToRGB(weapon.color, 0.48 * (1 - progress / 0.28));
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(fistX, fistY, burstRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawShotFlash(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const flash = 1 - easeOutCubic(progress);

    if (e.weapon === 'flamethrower') {
      const flamX = scr.x + Math.cos(e.angle) * (42 * flash * 0.6 + 18);
      const flamY = scr.y + Math.sin(e.angle) * (42 * flash * 0.6 + 18);
      const spriteAlpha = Math.pow(1 - progress, 0.3) * flash * 0.95;
      this._drawFxSprite(ctx, 'fx/elemental/flam', 5, 40, 30, flamX, flamY, 64 * flash + 16, progress, spriteAlpha, e.angle);
      return;
    }

    const length = 42 * flash;
    const half = 0.18 + 0.2 * flash;
    const start = e.angle - half;
    const end = e.angle + half;

    ctx.save();
    ctx.fillStyle = this._hexToRGB(weapon.color, 0.22 * alpha);
    ctx.beginPath();
    ctx.moveTo(scr.x + Math.cos(e.angle) * 12, scr.y + Math.sin(e.angle) * 12);
    ctx.arc(scr.x, scr.y, length + 18, start, end);
    ctx.closePath();
    ctx.fill();
    this._drawCapsuleLine(
      ctx,
      scr.x + Math.cos(e.angle) * 8,
      scr.y + Math.sin(e.angle) * 8,
      scr.x + Math.cos(e.angle) * (length + 26),
      scr.y + Math.sin(e.angle) * (length + 26),
      4 + 8 * flash,
      this._hexToRGB('#ffffff', 0.72 * alpha)
    );
    ctx.restore();
  }

  _drawProjectileBurst(ctx, scr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    const radius = 8 + easeOutCubic(progress) * 24;
    const spriteAlpha = Math.pow(1 - progress, 0.3) * 0.95;

    if (e.weapon === 'magicstaff') {
      this._drawFxSprite(ctx, 'fx/elemental/ice', 10, 32, 32, scr.x, scr.y, radius * 3.5, progress, spriteAlpha, 0);
      return;
    }
    if (e.weapon === 'flamethrower') {
      this._drawFxSprite(ctx, 'fx/elemental/flam', 5, 40, 30, scr.x, scr.y, radius * 3.5, progress, spriteAlpha, e.angle);
      return;
    }

    ctx.save();
    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.78 * alpha);
    ctx.lineWidth = 3.5 * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this._hexToRGB(weapon.color, 0.18 * alpha);
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, radius * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.75 * alpha);
    ctx.lineWidth = 2 * alpha;
    for (let i = 0; i < 8; i++) {
      const angle = e.angle + Math.PI + (i - 3.5) * 0.34;
      const inner = radius * 0.25;
      const outer = radius * (0.82 + (i % 2) * 0.16);
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(angle) * inner, scr.y + Math.sin(angle) * inner);
      ctx.lineTo(scr.x + Math.cos(angle) * outer, scr.y + Math.sin(angle) * outer);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawFxSprite(ctx, key, frames, fw, fh, cx, cy, drawSize, progress, alpha, angle = 0, flipY = false) {
    const sheet = this.atlas?.get(key);
    if (!sheet || !sheet.naturalWidth) return false;
    const frame = Math.min(frames - 1, Math.floor(clamp01(progress) * frames));
    const prev = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy);
    if (angle !== 0) ctx.rotate(angle);
    if (flipY) ctx.scale(1, -1);    // mirror across the swing axis (handedness)
    ctx.drawImage(sheet, frame * fw, 0, fw, fh, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
    ctx.imageSmoothingEnabled = prev;
    return true;
  }

  _drawExplosion(ctx, scr, e, weapon, alpha, zoom) {
    const progress = clamp01(e.progress);
    const maxR = (e.radius || 70) * zoom;
    const radius = maxR * easeOutCubic(progress);

    ctx.save();

    // Sprite sheet: 9 frames of 40×40 in a 360×40 strip.
    const sheet = this.atlas?.get('fx/explosion');
    if (sheet && sheet.naturalWidth) {
      const FRAMES = 9, FW = 40, FH = 40;
      const frame = Math.min(FRAMES - 1, Math.floor(progress * FRAMES));
      const drawSize = maxR * 2.4;
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sheet, frame * FW, 0, FW, FH,
        scr.x - drawSize / 2, scr.y - drawSize / 2, drawSize, drawSize);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = prevSmooth;
    } else {
      // Procedural fallback
      ctx.strokeStyle = this._hexToRGB(weapon.color, 0.85 * alpha);
      ctx.lineWidth = 5 * alpha + 1;
      ctx.beginPath(); ctx.arc(scr.x, scr.y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = this._hexToRGB('#ffffff', 0.5 * alpha * (1 - progress));
      ctx.beginPath(); ctx.arc(scr.x, scr.y, radius * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = this._hexToRGB(weapon.color, 0.18 * alpha);
      ctx.beginPath(); ctx.arc(scr.x, scr.y, radius * 0.85, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }

  _drawRailBeam(ctx, startScr, endScr, e, weapon, alpha) {
    ctx.save();
    ctx.lineCap = 'round';

    // Outer glow → core → white-hot center give the railgun beam its punch.
    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.35 * alpha);
    ctx.lineWidth = 14 * alpha + 2;
    ctx.beginPath();
    ctx.moveTo(startScr.x, startScr.y);
    ctx.lineTo(endScr.x, endScr.y);
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.9 * alpha);
    ctx.lineWidth = 5 * alpha + 1;
    ctx.beginPath();
    ctx.moveTo(startScr.x, startScr.y);
    ctx.lineTo(endScr.x, endScr.y);
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.95 * alpha);
    ctx.lineWidth = 2 * alpha + 0.5;
    ctx.beginPath();
    ctx.moveTo(startScr.x, startScr.y);
    ctx.lineTo(endScr.x, endScr.y);
    ctx.stroke();

    ctx.fillStyle = this._hexToRGB('#ffffff', 0.8 * alpha);
    ctx.beginPath();
    ctx.arc(endScr.x, endScr.y, 5 * alpha + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Sniper aim-line warning shown for ~0.5s before the killing shot lands.
  // Color interpolates weapon color → bright red as the shot approaches.
  _drawSniperTelegraph(ctx, startScr, endScr, e, weapon, alpha) {
    const progress = clamp01(e.progress);
    // Pulse frequency accelerates as progress increases — feels more urgent.
    const pulseFreq = 3 + progress * 5;
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(progress * Math.PI * pulseFreq));

    // Ease-in curve so the red surge feels like a countdown.
    const redT = progress * progress;
    const dangerColor = this._lerpHexColor(weapon.color, '#ff2020', redT);
    const dotColor = this._lerpHexColor('#ffffff', '#ff4040', redT);

    ctx.save();
    ctx.lineCap = 'round';

    // Outer danger halo — grows wider and more opaque as shot nears.
    const haloWidth = (6 + 10 * redT) * alpha + 1;
    const haloAlpha = (0.12 + 0.30 * redT) * alpha * pulse;
    ctx.strokeStyle = this._hexToRGB(dangerColor, haloAlpha);
    ctx.lineWidth = haloWidth;
    ctx.beginPath();
    ctx.moveTo(startScr.x, startScr.y);
    ctx.lineTo(endScr.x, endScr.y);
    ctx.stroke();

    // Dashed bright core — intensifies and shifts red.
    const dashGap = Math.max(3, 8 - progress * 6); // gaps close as shot nears
    ctx.setLineDash([10, dashGap]);
    ctx.strokeStyle = this._hexToRGB(dangerColor, (0.5 + 0.45 * progress) * alpha);
    ctx.lineWidth = (1.5 + 2.0 * redT) * alpha + 0.5;
    ctx.beginPath();
    ctx.moveTo(startScr.x, startScr.y);
    ctx.lineTo(endScr.x, endScr.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Final-20% warning: bright red full-line flash overlay.
    if (progress > 0.80) {
      const warnT = (progress - 0.80) / 0.20;
      const flashPulse = 0.5 + 0.5 * Math.abs(Math.sin(progress * Math.PI * 10));
      ctx.strokeStyle = this._hexToRGB('#ff0000', warnT * 0.55 * flashPulse * alpha);
      ctx.lineWidth = (3 + 4 * warnT) * alpha;
      ctx.beginPath();
      ctx.moveTo(startScr.x, startScr.y);
      ctx.lineTo(endScr.x, endScr.y);
      ctx.stroke();
    }

    // Charge dot creeping from muzzle to impact — turns red and enlarges.
    const dotX = startScr.x + (endScr.x - startScr.x) * progress;
    const dotY = startScr.y + (endScr.y - startScr.y) * progress;
    const dotR = (2.5 + 3.5 * redT) * alpha + 1.5 * pulse;
    ctx.fillStyle = this._hexToRGB(dotColor, (0.85 + 0.15 * redT) * alpha);
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();

    // Dot glow ring at the end.
    if (progress > 0.6) {
      const glowT = (progress - 0.6) / 0.4;
      ctx.strokeStyle = this._hexToRGB('#ff2020', glowT * 0.6 * pulse * alpha);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotR * 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Linearly interpolates between two 6-digit hex colors, returns hex string.
  _lerpHexColor(hexA, hexB, t) {
    const clampT = Math.max(0, Math.min(1, t));
    const parse = (h) => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];
    const [ar, ag, ab] = parse(hexA.startsWith('hsl') ? '#888888' : hexA);
    const [br, bg, bb] = parse(hexB);
    const r = Math.round(ar + (br - ar) * clampT);
    const g = Math.round(ag + (bg - ag) * clampT);
    const b = Math.round(ab + (bb - ab) * clampT);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  _drawBuffActivate(ctx, scr, e, weapon, alpha, zoom) {
    const progress = clamp01(e.progress);
    const radius = (18 + 46 * easeOutCubic(progress)) * (0.6 + zoom * 0.4);

    ctx.save();
    this._drawSustainedBuffBurst(ctx, scr, e.buffType, weapon.color, alpha, zoom, Date.now() + progress * 420);

    ctx.strokeStyle = this._hexToRGB(weapon.color, 0.8 * alpha);
    ctx.lineWidth = 4 * alpha + 1;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.7 * alpha);
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(a) * radius * 0.5, scr.y + Math.sin(a) * radius * 0.5);
      ctx.lineTo(scr.x + Math.cos(a) * radius * 0.9, scr.y + Math.sin(a) * radius * 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSustainedBuffBurst(ctx, scr, buffType, color, alpha = 1, zoom = 1, timeMs = Date.now()) {
    const isAxe = buffType === 'axe_rage';
    const baseRadius = (isAxe ? 42 : 34) * zoom;
    const spin = timeMs / (isAxe ? 520 : 460);
    const counterSpin = -timeMs / (isAxe ? 760 : 640);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs / 150);
    const ringRadius = baseRadius + pulse * (isAxe ? 5 : 4);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = color;
    ctx.shadowBlur = this._glow *12 * alpha;

    ctx.fillStyle = this._hexToRGB(color, (isAxe ? 0.12 : 0.1) * alpha);
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, ringRadius * 0.78, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.strokeStyle = this._hexToRGB(color, 0.48 * alpha);
    ctx.lineWidth = (isAxe ? 4.2 : 3.4) * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, ringRadius, spin, spin + Math.PI * 1.35);
    ctx.stroke();

    ctx.strokeStyle = this._hexToRGB('#ffffff', 0.46 * alpha);
    ctx.lineWidth = (isAxe ? 2.8 : 2.2) * alpha;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, ringRadius * 0.72, counterSpin, counterSpin + Math.PI * 1.05);
    ctx.stroke();

    const burstCount = isAxe ? 8 : 7;
    for (let i = 0; i < burstCount; i++) {
      const t = i / burstCount;
      const a = spin * 0.55 + t * Math.PI * 2;
      const flicker = 0.72 + 0.28 * Math.sin(timeMs / 95 + i * 1.7);
      const inner = ringRadius * (0.28 + (i % 2) * 0.08);
      const outer = ringRadius * (0.82 + (i % 3) * 0.08) * flicker;
      ctx.strokeStyle = this._hexToRGB(i % 3 === 0 ? '#ffffff' : color, (i % 3 === 0 ? 0.56 : 0.42) * alpha);
      ctx.lineWidth = (isAxe ? 2.6 : 2.1) * alpha * flicker;
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(a) * inner, scr.y + Math.sin(a) * inner);
      ctx.lineTo(scr.x + Math.cos(a) * outer, scr.y + Math.sin(a) * outer);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawCapsuleLine(ctx, x1, y1, x2, y2, width, color, lineCap = 'round') {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.1, width);
    ctx.lineCap = lineCap;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  _drawAttackLane(ctx, x, y, angle, length, width, color) {
    const uX = Math.cos(angle);
    const uY = Math.sin(angle);
    const pX = -uY * width / 2;
    const pY = uX * width / 2;

    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + pX, y + pY);
    ctx.lineTo(x - pX, y - pY);
    ctx.lineTo(x - pX + uX * length, y - pY + uY * length);
    ctx.lineTo(x + pX + uX * length, y + pY + uY * length);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _getActiveAttacks(effects) {
    const active = {};

    effects.forEach(effect => {
      if (!effect.attackerId || effect.progress >= 1) return;
      if (!this._isWeaponMotionEffect(effect)) return;
      const current = active[effect.attackerId];
      if (!current || effect.timestamp >= current.timestamp) {
        active[effect.attackerId] = effect;
      }
    });

    return active;
  }

  _isWeaponMotionEffect(effect) {
    return Boolean(effect) && (
      effect.type === 'projectile_shot' ||
      effect.type === 'melee_arc' ||
      effect.type === 'melee_circle' ||
      effect.type === 'melee_line' ||
      effect.type === 'melee_heavy_arc' ||
      effect.type === 'melee_sweet_arc' ||
      effect.type === 'melee_backstab' ||
      effect.type === 'melee_precise_line' ||
      effect.type === 'melee_heavy_line' ||
      effect.type === 'melee_slam' ||
      effect.type === 'greatsword_charge' ||
      effect.type === 'dagger_qte_lock' ||
      effect.type === 'dagger_qte_window' ||
      effect.type === 'dagger_qte_hit' ||
      effect.type === 'hammer_windup' ||
      effect.type === 'spear_windup' ||
      effect.type === 'finisher_ready'
    );
  }

  _isPlayerBoundEffect(effect) {
    return Boolean(effect && effect.attackerId) &&
      !effect.worldAnchored &&
      effect.type !== 'projectile_shot' &&
      effect.type !== 'projectile_burst' &&
      effect.type !== 'explosion' &&
      effect.type !== 'railbeam' &&
      effect.type !== 'sniper_telegraph' &&
      effect.type !== 'matchlock_telegraph';
  }

  _resolveEffectAttachment(effect, players = {}) {
    if (!this._isPlayerBoundEffect(effect)) return effect;

    const attacker = this._findPlayerById(players, effect.attackerId);
    if (!attacker || attacker.isDead) return effect;
    const angleOffset = Number.isFinite(effect.angleOffset) ? effect.angleOffset : 0;
    const baseAngle = Number.isFinite(attacker.angle) ? attacker.angle : effect.angle;

    return {
      ...effect,
      x: attacker.x,
      y: attacker.y,
      angle: Number.isFinite(baseAngle) ? baseAngle + angleOffset : effect.angle
    };
  }

  _resolveParticlePosition(particle, players = {}) {
    if (!particle.anchorId) {
      return { x: particle.x, y: particle.y };
    }

    const anchor = this._findPlayerById(players, particle.anchorId);
    if (!anchor || anchor.isDead) {
      return { x: particle.x, y: particle.y };
    }

    let offsetX = particle.offsetX || 0;
    let offsetY = particle.offsetY || 0;
    if (particle.rotateWithAnchor && Number.isFinite(particle.anchorAngle) && Number.isFinite(anchor.angle)) {
      const delta = anchor.angle - particle.anchorAngle;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      const rotatedX = offsetX * cos - offsetY * sin;
      const rotatedY = offsetX * sin + offsetY * cos;
      offsetX = rotatedX;
      offsetY = rotatedY;
    }

    return {
      x: anchor.x + offsetX,
      y: anchor.y + offsetY
    };
  }

  _findPlayerById(players = {}, id) {
    if (!id) return null;
    if (players[id]) return players[id];
    return Object.values(players).find(player => player && player.id === id) || null;
  }

  _getAttackMotion(player, effect) {
    const empty = { active: false, bodyX: 0, bodyY: 0, bodyScale: 0, weaponReach: 0, weaponAngle: player.angle };
    if (!effect) return empty;

    const progress = clamp01(effect.progress);
    const angleOffset = Number.isFinite(effect.angleOffset) ? effect.angleOffset : 0;
    const baseAngle = this._isPlayerBoundEffect(effect) && Number.isFinite(player.angle)
      ? player.angle
      : (Number.isFinite(effect.angle) ? effect.angle : player.angle);
    const angle = baseAngle + angleOffset;
    let lunge = 0;
    let weaponReach = 0;
    let weaponAngle = angle;
    let bodyScale = 0;

    if (effect.type === 'projectile_shot') {
      const draw = progress < 0.45
        ? easeOutCubic(progress / 0.45)
        : Math.max(0, 1 - (progress - 0.45) / 0.55);
      lunge = -2 * draw;
      weaponReach = -11 * draw;
      bodyScale = 1.1 * draw;

    } else if (effect.type === 'spear_windup') {
      // Pull spear back (0%→50% progress), hold at peak, release (50%→100%)
      const pullT = progress < 0.5
        ? easeOutCubic(progress / 0.5)
        : 1 - easeOutCubic((progress - 0.5) / 0.5);
      lunge = -6 * pullT;
      weaponReach = -16 * pullT;  // negative = tip retreats toward body
      bodyScale = 1.3 * pullT;

    } else if (effect.type === 'finisher_ready') {
      // Sword held in pull-back pose while waiting for finisher window.
      // Keep the whole delay alive so the prep does not snap into a frozen pose.
      const chargeT = progress * progress * (3 - 2 * progress);
      const pullPulse = Math.sin(Math.PI * progress);
      const readyOffset = effect.weapon === 'sword' ? -Math.PI * 0.75 : Math.PI * 0.82;
      const pullDirection = effect.weapon === 'sword' ? -1 : 1;
      lunge = -5.5 * chargeT - 1.2 * pullPulse;
      weaponReach = -13 * chargeT - 2.5 * pullPulse;
      weaponAngle = angle + readyOffset * chargeT + pullDirection * 0.12 * pullPulse;
      bodyScale = 1.35 * chargeT + 0.25 * pullPulse;

    } else if (effect.type === 'greatsword_charge') {
      const chargeT = easeOutCubic(clamp01((progress + 0.12) / 0.58));
      lunge = -7 * chargeT;
      weaponReach = -24 * chargeT;
      weaponAngle = angle - 1.95 * chargeT;
      bodyScale = 2.1 * chargeT;

    } else if (effect.type === 'katana_charge') {
      const chargeT = progress * progress * (3 - 2 * progress);
      lunge = -4 * chargeT;
      weaponReach = -11 * chargeT;
      weaponAngle = angle - 1.05 * chargeT;
      bodyScale = 0.9 * chargeT;

    } else if (effect.type === 'hammer_windup') {
      const chargeT = easeOutCubic(progress);
      lunge = -4 * chargeT;
      weaponReach = -12 * chargeT;
      weaponAngle = angle - Math.PI * 0.72 * chargeT;
      bodyScale = 1.8 * chargeT;

    } else if (effect.type === 'dagger_qte_hit') {
      const stab = progress < 0.22 ? easeOutBack(progress / 0.22) : Math.max(0, 1 - (progress - 0.22) / 0.78);
      lunge = 15 * stab;
      weaponReach = 24 * stab;
      weaponAngle = angle;
      bodyScale = 1.4 * stab;

    } else if (effect.type === 'melee_heavy_arc' || effect.type === 'melee_heavy_line') {
      const isGreatsword = effect.weapon === 'greatsword';
      const motionProgress = isGreatsword ? clamp01(progress + 0.1) : progress;
      const windupPortion = isGreatsword ? 0.16 : 0.45;
      const chargeT = motionProgress < windupPortion ? easeOutCubic(motionProgress / windupPortion) : 1;
      const releaseT = progress < windupPortion ? 0 : easeOutBack((progress - windupPortion) / (1 - windupPortion));
      const swingDirection = this._visualSwingDirection(effect.weapon, effect.swingDirection);
      lunge = (isGreatsword ? -7 : -8) * chargeT + (isGreatsword ? 21 : 13) * releaseT;
      weaponReach = (isGreatsword ? -14 : -12) * chargeT + (isGreatsword ? 36 : 20) * releaseT;
      weaponAngle = angle + swingDirection * ((isGreatsword ? -2.18 : -1.15) * chargeT + (isGreatsword ? 3.85 : 2.25) * releaseT);
      bodyScale = 2.1 * Math.sin(Math.PI * clamp01(progress));

    } else if (effect.type === 'melee_sweet_arc') {
      const swingDirection = this._visualSwingDirection(effect.weapon, effect.swingDirection);
      const sweep = easeOutCubic(clamp01(progress / 0.92));
      lunge = 5 * Math.sin(Math.PI * progress);
      weaponReach = 20 * Math.sin(Math.PI * progress);
      weaponAngle = angle + swingDirection * (-1.55 + sweep * 3.1);
      bodyScale = 1.25 * Math.sin(Math.PI * progress);

    } else if (effect.type === 'melee_backstab') {
      const stab = progress < 0.24
        ? easeOutBack(progress / 0.24)
        : Math.max(0, 1 - (progress - 0.24) / 0.76);
      lunge = 12 * stab;
      weaponReach = 18 * stab;
      weaponAngle = angle + (effect.swingDirection === -1 ? -0.25 : 0.25) * stab;
      bodyScale = 1.25 * stab;

    } else if (effect.type === 'melee_precise_line') {
      const thrust = progress < 0.16
        ? easeOutBack(progress / 0.16)
        : Math.max(0, 1 - (progress - 0.16) / 0.84);
      lunge = 9 * thrust;
      weaponReach = 22 * thrust;
      weaponAngle = angle;
      bodyScale = 1.1 * thrust;

    } else if (effect.type === 'melee_slam') {
      const lift = progress < 0.45 ? easeOutCubic(progress / 0.45) : 1 - easeOutCubic((progress - 0.45) / 0.55);
      lunge = progress < 0.45 ? -5 * lift : 4 * (1 - lift);
      weaponReach = progress < 0.45 ? -10 * lift : 8 * (1 - lift);
      weaponAngle = angle - Math.PI / 2 * lift;
      bodyScale = 2.4 * Math.sin(Math.PI * clamp01(progress));

    } else if (effect.type === 'melee_circle' && effect.weapon !== 'axe') {
      const spin = easeOutCubic(Math.min(1, progress / 0.6));
      weaponAngle = angle - spin * Math.PI * (effect.comboFinisher ? 2.8 : 2.1);
      bodyScale = (effect.comboFinisher ? 2.4 : 1.5) * Math.sin(Math.PI * clamp01(progress));

    } else if (effect.weapon === 'sword' && effect.comboFinisher) {
      // Sword finisher: keep the charged lower-left pose, then sweep a full 360.
      const motionProgress = clamp01(progress + 0.08);
      const readyOffset = -Math.PI * 0.75;
      if (motionProgress < 0.08) {
        const t = easeOutCubic(motionProgress / 0.08);
        lunge = -6 + 2 * t;
        weaponReach = -14 + 2 * t;
        weaponAngle = angle + readyOffset;
        bodyScale = 1.55 + 0.35 * t;
      } else {
        const t = easeOutCubic((motionProgress - 0.08) / 0.92);
        const fadeOut = Math.max(0, 1 - (motionProgress - 0.08) / 0.55);
        lunge = -4 * fadeOut;
        weaponReach = -12 + 24 * t;
        weaponAngle = angle + readyOffset - t * Math.PI * 2;
        bodyScale = 1.9 * (1 - easeOutCubic(Math.min(1, (motionProgress - 0.08) / 0.92)));
      }

    } else if (effect.weapon === 'axe') {
      const angleDeg = effect.type === 'melee_circle'
        ? 360
        : (Number.isFinite(effect.angleDeg) ? effect.angleDeg : 120);
      const halfAngle = (angleDeg * Math.PI) / 360;
      const startAngle = angle - halfAngle;
      const endAngle = angleDeg >= 359 ? startAngle + Math.PI * 2 : angle + halfAngle;
      const swingDirection = this._visualSwingDirection(effect.weapon, effect.swingDirection);
      const sweep = easeOutCubic(clamp01(progress / 0.58));
      // Reverse the full 360 spin so it turns the same way as the other circular
      // slashes; keep the narrower rage arc (120°) swinging its original way.
      const reverse = angleDeg >= 359;
      const goPositive = (swingDirection > 0) !== reverse;
      weaponAngle = goPositive
        ? startAngle + (endAngle - startAngle) * sweep
        : endAngle - (endAngle - startAngle) * sweep;
      weaponReach = Math.max(0, (effect.range || 0) * 0.18) * Math.sin(Math.PI * clamp01(progress));
      bodyScale = (effect.comboFinisher ? 2.25 : 1.65) * Math.sin(Math.PI * clamp01(progress));

    } else if (effect.weapon === 'gauntlet') {
      const punch = progress < 0.2
        ? easeOutBack(progress / 0.2)
        : Math.max(0, 1 - (progress - 0.2) / 0.8);
      lunge = 6 * punch;
      weaponReach = 18 * punch;
      weaponAngle = angle;
      bodyScale = 1.15 * punch;

    } else if (effect.type === 'melee_line') {
      const thrust = progress < 0.18
        ? easeOutBack(progress / 0.18)
        : Math.max(0, 1 - (progress - 0.18) / 0.82);
      const finisherBoost = effect.comboFinisher ? 1.45 : 1;
      lunge = 8 * thrust * finisherBoost;
      weaponReach = 18 * thrust * finisherBoost;
      bodyScale = 1.2 * thrust * finisherBoost;

    } else {
      const swingDirection = this._visualSwingDirection(effect.weapon, effect.swingDirection);
      const motionProgress = effect.weapon === 'sword' ? clamp01((progress + 0.1) / 0.62) : progress;
      const slashProgress = effect.weapon === 'sword' ? clamp01((progress + 0.06) / 0.72) : clamp01(motionProgress * 0.95);
      const slash = Math.sin(Math.PI * slashProgress);
      const finisherBoost = effect.comboFinisher ? 1.7 : 1;
      lunge = 4 * slash * finisherBoost;
      weaponReach = 10 * slash * finisherBoost;
      weaponAngle = angle + swingDirection * (-0.9 + easeOutCubic(motionProgress) * 1.8) * finisherBoost;
      bodyScale = 1.0 * slash * finisherBoost;
    }

    return {
      active: true,
      effectType: effect.type,
      attackProgress: progress,
      isFinisher: Boolean(effect.comboFinisher),
      swingDirection: this._visualSwingDirection(effect.weapon, effect.swingDirection),
      bodyX: Math.cos(angle) * lunge,
      bodyY: Math.sin(angle) * lunge,
      bodyScale,
      weaponReach,
      weaponAngle,
      punchSide: Number.isFinite(effect.punchSide) ? effect.punchSide : 0
    };
  }

  /**
   * Draw Players with beautiful pixel graphics
   */
  _drawPlayers(ctx, camera, cw, ch, players, localPlayerId, activeEffects = [], mapWidth = 0, mapHeight = 0, visualSettings = {}) {
    const zoom = camera.zoom || 1;
    // The world collision radius is 14 units, so the body must be drawn at
    // 14 * zoom px to match the hitbox at every device zoom (fixes small-screen
    // devices showing the character/hits larger than where they actually land).
    const radius = 14 * zoom;
    const activeAttacks = this._getActiveAttacks(activeEffects);

    Object.keys(players).forEach(id => {
      const p = players[id];
      if (p.isDead) {
        this._drawGrave(ctx, camera, cw, ch, p);
        return;
      }

      const scr = camera.toScreen(p.x, p.y, cw, ch);
      const isLocal = id === localPlayerId;
      const activeAttack = activeAttacks[id] || activeAttacks[p.id] || null;
      const motion = this._getAttackMotion(p, activeAttack);
      const bodyScr = {
        x: scr.x + motion.bodyX,
        y: scr.y + motion.bodyY
      };

      // Equipped dash trail: a colored after-glow while dashing (i-frames). Drawn
      // under the body so it reads as a trail aura.
      if (p.dashTrailColor && p.iframeTimeLeft > 0 && !p.isDead) {
        const z = camera.zoom || 1;
        const t = Math.min(1, p.iframeTimeLeft / 0.2);
        ctx.save();
        ctx.shadowColor = p.dashTrailColor;
        ctx.shadowBlur = this._glow ? 14 : 0;
        for (let i = 1; i <= 3; i++) {
          ctx.globalAlpha = 0.28 * t / i;
          ctx.fillStyle = p.dashTrailColor;
          ctx.beginPath();
          ctx.arc(bodyScr.x, bodyScr.y, (14 + i * 4) * z, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Mobile ranged players always show their aim beam (the instant-fire tell),
      // even to viewers who hid enemy previews — it's the counterplay window.
      const mobileRangedTell = p.isMobile && getEffectiveWeapon(p.weapon, p.buffType)?.type === 'projectile';
      if (isLocal || !visualSettings.hideEnemyAttackPreviews || mobileRangedTell) {
        this._drawPlayerAttackRange(ctx, camera, cw, ch, scr, p, isLocal, Boolean(activeAttack), mapWidth, mapHeight, activeAttack);
      }

      // Ground/foot shadow: a soft dark ellipse under the player's actual
      // position (not the lunge offset) so sprites read as standing ON the
      // grass rather than floating over it.
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = '#0d0a06';
      ctx.beginPath();
      ctx.ellipse(scr.x, scr.y + radius * 0.78, radius * 1.05, radius * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();

      ctx.shadowBlur = 0;
      ctx.fillStyle = p.color;

      const drawWeaponFrame = () => {
        ctx.save();
        ctx.translate(bodyScr.x, bodyScr.y);
        ctx.scale(zoom, zoom);
        ctx.translate(-bodyScr.x, -bodyScr.y);
        this._drawPlayerWeapon(ctx, bodyScr, p, motion);
        ctx.restore();
      };
      const weaponTune = WEAPON_SPRITE_TUNE[p.weapon] || WEAPON_TUNE_DEFAULT;
      const weaponDrawOverBody = Boolean(weaponTune.drawOverBody);

      // Active skill-buff floor burst (axe rage / gauntlet lance).
      if (p.buffTimeLeft > 0) {
        const auraColor = p.buffType === 'axe_rage' ? '#f55555'
          : p.buffType === 'gauntlet_lance' ? '#ff45db'
          : p.accentColor;
        this._drawSustainedBuffBurst(ctx, bodyScr, p.buffType, auraColor, 0.72, camera.zoom || 1, Date.now());
      }
      this._drawCostumeEffect(ctx, bodyScr, p, radius, Date.now());

      // Grip-based weapons sit behind the body so the character covers the
      // handle. Center-held weapons opt back over the body for visibility.
      if (!weaponDrawOverBody) drawWeaponFrame();

      // Draw Main Player Chassis — sprite if loaded, else the legacy square.
      const bodyR = radius + motion.bodyScale;
      const drewSprite = this._drawCharacterSprite(ctx, bodyScr, p, radius, isLocal);
      if (!drewSprite) {
        ctx.fillRect(bodyScr.x - bodyR, bodyScr.y - bodyR, bodyR * 2, bodyR * 2);
        // Outline
        ctx.shadowBlur = this._glow *0;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = isLocal ? '#ef4444' : '#0d0a06';
        ctx.strokeRect(bodyScr.x - bodyR, bodyScr.y - bodyR, bodyR * 2, bodyR * 2);
      }

      // Magic staff status overlays: fire DoT flames + loaded ice shards orbiting.
      if (p.burnTimeLeft > 0) this._drawBurnFlames(ctx, bodyScr, radius, camera.zoom || 1);
      if (p.pendingIcicles > 0) this._drawLoadedIcicles(ctx, bodyScr, p.pendingIcicles, radius, camera.zoom || 1);

      // Local Player Highlight Marker Ring
      if (isLocal) {
        // Broad pulsing red warning circle representing absolute player presence
        const pulse = 8 + Math.sin(Date.now() / 120) * 3.5;
        
        ctx.save();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 3;
        ctx.shadowBlur = 0;
        const lr = radius + pulse;
        ctx.strokeRect(bodyScr.x - lr, bodyScr.y - lr, lr * 2, lr * 2);
        ctx.restore();
      }

      if (weaponDrawOverBody) drawWeaponFrame();
      this._drawCostumeDecoration(ctx, bodyScr, p, radius, Date.now());

      // Restore style frame before text elements
      ctx.restore();

      // Floating Username Indicator
      ctx.save();
      ctx.font = '11px "Galmuri11", monospace';
      ctx.textAlign = 'center';
      
      // Calculate text background padding sizes
      const tagText = `${p.nickname} [${p.kills}]`;
      const textWidth = ctx.measureText(tagText).width;

      ctx.fillStyle = 'rgba(11, 12, 16, 0.75)';
      ctx.fillRect(bodyScr.x - textWidth / 2 - 4, bodyScr.y - radius - 24, textWidth + 8, 14);

      ctx.fillStyle = isLocal ? '#ffffff' : '#ccd6f6';
      ctx.fillText(tagText, bodyScr.x, bodyScr.y - radius - 13);

      // Equipped title (cosmetic) floats just above the name tag.
      if (p.title && p.title.text) {
        ctx.font = '9px "Galmuri11", monospace';
        ctx.fillStyle = p.title.color || '#facc15';
        ctx.fillText(p.title.text, bodyScr.x, bodyScr.y - radius - 27);
      }

      // Status-effect icons (bleed/burn/slow/stun) above the HP bar.
      this._drawStatusIcons(ctx, bodyScr, p, radius);

      // Mini floating HP bars (hovering above head)
      const barW = 32;
      const barH = 3.5;
      const barX = bodyScr.x - barW / 2;
      const barY = bodyScr.y - radius - 8;

      // Hp Bar Background border
      ctx.fillStyle = '#111216';
      ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);

      // Hp Bar Filled portion
      const hpPct = Math.max(0, p.hp / (p.maxHp || 100));
      ctx.fillStyle = hpPct > 0.5 ? '#10b981' : hpPct > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.fillRect(barX, barY, barW * hpPct, barH);

      if (p.weapon === 'bow') {
        const maxStacks = SkillConfig.bow?.maxStacks || 5;
        const stacks = Math.max(0, Math.min(maxStacks, Math.floor(p.arrowStacks || 0)));
        const stackText = `[${stacks} / ${maxStacks} 스택]`;
        const stackWidth = ctx.measureText(stackText).width;
        const stackY = bodyScr.y + radius + 21;

        ctx.fillStyle = 'rgba(11, 12, 16, 0.72)';
        ctx.fillRect(bodyScr.x - stackWidth / 2 - 4, stackY - 10, stackWidth + 8, 13);
        ctx.fillStyle = stacks > 0 ? '#a3ff45' : '#9ca3af';
        ctx.fillText(stackText, bodyScr.x, stackY);
      }

      ctx.restore();
    });
  }

  _drawCostumeEffect(ctx, scr, player, radius, now) {
    const effect = player.costumeEffect;
    if (!effect) return;
    const t = now / 1000;
    ctx.save();
    ctx.shadowBlur = this._glow * 8;
    ctx.shadowColor = player.accentColor;

    if (effect === 'embers' || effect === 'sparkles' || effect === 'leaves') {
      const color = effect === 'embers' ? '#fb923c' : effect === 'leaves' ? '#86efac' : '#fde68a';
      const count = effect === 'sparkles' ? 5 : 4;
      for (let i = 0; i < count; i++) {
        const a = t * (effect === 'leaves' ? -1.4 : 1.7) + i * Math.PI * 2 / count;
        const d = radius + 6 + Math.sin(t * 2 + i) * 2;
        const x = scr.x + Math.cos(a) * d;
        const y = scr.y + Math.sin(a) * d;
        ctx.fillStyle = this._hexToRGB(color, 0.68);
        if (effect === 'sparkles') {
          ctx.strokeStyle = this._hexToRGB(color, 0.78);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x - 3, y);
          ctx.lineTo(x + 3, y);
          ctx.moveTo(x, y - 3);
          ctx.lineTo(x, y + 3);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, effect === 'embers' ? 2 : 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (effect === 'runes') {
      ctx.strokeStyle = this._hexToRGB('#c084fc', 0.48);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, radius + 8, t * 1.4, t * 1.4 + Math.PI * 1.4);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (effect === 'shade') {
      const back = player.angle + Math.PI;
      ctx.fillStyle = this._hexToRGB('#020617', 0.32);
      ctx.beginPath();
      ctx.ellipse(
        scr.x + Math.cos(back) * 7,
        scr.y + Math.sin(back) * 7,
        radius + 8,
        radius * 0.58,
        back,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    ctx.restore();
  }

  _drawCostumeDecoration(ctx, scr, player, radius, now) {
    const decoration = player.costumeDecoration;
    if (!decoration) return;
    const upX = scr.x;
    const upY = scr.y - radius - 4;
    const accent = player.accentColor || '#e8d5a3';

    ctx.save();
    ctx.shadowBlur = this._glow * 7;
    ctx.shadowColor = accent;
    ctx.strokeStyle = accent;
    ctx.fillStyle = this._hexToRGB(accent, 0.86);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (decoration === 'crown') {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(upX - 8, upY + 1);
      ctx.lineTo(upX - 5, upY - 7);
      ctx.lineTo(upX, upY - 2);
      ctx.lineTo(upX + 5, upY - 7);
      ctx.lineTo(upX + 8, upY + 1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else if (decoration === 'crest') {
      ctx.beginPath();
      ctx.moveTo(upX, upY - 9);
      ctx.lineTo(upX - 6, upY + 2);
      ctx.lineTo(upX + 6, upY + 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (decoration === 'halo') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(upX, upY - 4 + Math.sin(now / 220) * 1.5, 9, 3.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (decoration === 'wings') {
      ctx.lineWidth = 2;
      ctx.strokeStyle = this._hexToRGB(accent, 0.78);
      [-1, 1].forEach(side => {
        ctx.beginPath();
        ctx.moveTo(scr.x - Math.cos(player.angle) * 3, scr.y);
        ctx.quadraticCurveTo(scr.x + side * 17, scr.y - 11, scr.x + side * 24, scr.y + 2);
        ctx.quadraticCurveTo(scr.x + side * 12, scr.y + 3, scr.x + side * 8, scr.y + 11);
        ctx.stroke();
      });
    } else if (decoration === 'cape') {
      const back = player.angle + Math.PI;
      const side = back + Math.PI / 2;
      const bx = scr.x + Math.cos(back) * 7;
      const by = scr.y + Math.sin(back) * 7;
      ctx.fillStyle = this._hexToRGB(accent, 0.34);
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(side) * 6, by + Math.sin(side) * 6);
      ctx.lineTo(bx - Math.cos(side) * 6, by - Math.sin(side) * 6);
      ctx.lineTo(bx + Math.cos(back) * 20, by + Math.sin(back) * 20);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw miniature weapon icons on player circle boundary
   */
  _drawPlayerWeapon(ctx, scr, player, motion = {}) {
    const radius = 14;
    const weaponAngle = Number.isFinite(motion.weaponAngle) ? motion.weaponAngle : player.angle;
    const reach = Number.isFinite(motion.weaponReach) ? motion.weaponReach : 0;
    const active = Boolean(motion.active) || Math.abs(reach) > 1;
    const holdOffset = active ? 0.24 : 0.55;
    const wAngle = weaponAngle + holdOffset;
    const wDistance = radius + Math.max(0, reach * 0.38);
    const wX = scr.x + Math.cos(wAngle) * wDistance;
    const wY = scr.y + Math.sin(wAngle) * wDistance;

    ctx.save();
    const weaponInk = WS_TINTS[player.weaponSkins?.[player.weapon]] || player.accentColor;
    ctx.strokeStyle = weaponInk;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.fillStyle = '#111216';
    ctx.shadowBlur = this._glow * (active ? 8 : 0);
    ctx.shadowColor = weaponInk;

    const weaponType = player.weapon;
    // Ninja Adventure in-hand weapon sprite (Task 4-D) — preferred. Follows the
    // same motion (weaponAngle/reach) so swings/thrusts move the sprite; the
    // attack hitbox geometry is unchanged. Falls back to the legacy PNG, then
    // to the procedural drawings below.
    if (this._drawNinjaWeapon(ctx, scr, player, motion, radius, weaponAngle, reach, active)) {
      ctx.restore();
      return;
    }
    if (this._drawWeaponSprite(ctx, scr, player, motion, radius, weaponAngle, reach, active)) {
      ctx.restore();
      return;
    }

    if (weaponType === 'sword') {
      const isFinisherSpin = motion.isFinisher && active;
      const swingDir = motion.swingDirection === -1 ? -1 : 1;

      if (isFinisherSpin) {
        // 360° finisher: orbit the blade around the body (kept as the spin sweep).
        const orbitDist = radius + 4 + Math.max(0, reach * 0.4);
        ctx.translate(scr.x + Math.cos(weaponAngle) * orbitDist, scr.y + Math.sin(weaponAngle) * orbitDist);
        ctx.rotate(weaponAngle);
        const ext = 18;
        ctx.fillStyle = this._hexToRGB('#dbeafe', 0.88);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(-1, 1);
        ctx.lineTo(ext, -ext);
        ctx.lineTo(ext - 4, -ext + 1.2);
        ctx.lineTo(1, 3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = player.accentColor;
        ctx.lineWidth = 3.1;
        ctx.beginPath();
        ctx.moveTo(-6, 4);
        ctx.lineTo(4, -6);
        ctx.stroke();
        ctx.fillStyle = '#111216';
        ctx.beginPath();
        ctx.arc(-6, 4, 2.1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Real slash: the hilt is pinned near the hand and the blade extends along
        // the swing angle, rotating through the arc as weaponAngle sweeps. The
        // scale(1, swingDir) flip keeps the SAME cutting edge leading on every
        // alternating swing (instead of hitting with the back of the blade).
        const drawAngle = active ? weaponAngle : weaponAngle + 0.5;
        const hilt = radius - 3;
        const len = 20 + Math.max(0, reach * 0.5);

        ctx.translate(scr.x, scr.y);
        ctx.rotate(drawAngle);
        ctx.scale(1, swingDir);

        // Blade: hilt → tip along +x, cutting edge on the -y side.
        ctx.fillStyle = this._hexToRGB('#dbeafe', 0.9);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(hilt, 2.4);
        ctx.lineTo(hilt + len, -0.6);
        ctx.lineTo(hilt + len - 3, -2.6);
        ctx.lineTo(hilt, -2.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Bright cutting edge (-y).
        ctx.strokeStyle = this._hexToRGB('#ffffff', 0.7);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(hilt, -2.2);
        ctx.lineTo(hilt + len - 3, -2.6);
        ctx.stroke();

        // Crossguard + pommel at the hand.
        ctx.strokeStyle = player.accentColor;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(hilt - 1, -4.5);
        ctx.lineTo(hilt - 1, 4.5);
        ctx.stroke();
        ctx.fillStyle = '#111216';
        ctx.beginPath();
        ctx.arc(hilt - 4, 0, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    else if (weaponType === 'axe') {
      const idleHoldAngle = -Math.PI / 4;
      const rageActive = player.buffType === 'axe_rage';

      // During any attack: orbit the axe around the body using the spinning weaponAngle.
      const orbitAngle = active ? weaponAngle : (rageActive ? player.angle : idleHoldAngle);
      const orbitR = active
        ? radius + 4 + Math.max(0, reach * 0.08)
        : rageActive
          ? radius + 1
          : radius + 2;
      const axeX = scr.x + Math.cos(orbitAngle) * orbitR;
      const axeY = scr.y + Math.sin(orbitAngle) * orbitR;

      const shaftEnd = active ? 12 : (rageActive ? 19 + Math.max(0, reach * 0.24) : 9);
      const bladeRoot = shaftEnd - 6;
      const bladeTip = shaftEnd + 5;

      ctx.translate(axeX, axeY);
      ctx.rotate(orbitAngle);
      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(shaftEnd, 0);
      ctx.stroke();

      ctx.strokeStyle = player.accentColor;
      ctx.fillStyle = '#111216';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bladeRoot, -9);
      ctx.lineTo(bladeTip, -5);
      ctx.lineTo(bladeTip, 5);
      ctx.lineTo(bladeRoot, 9);
      ctx.quadraticCurveTo(shaftEnd, 0, bladeRoot, -9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    else if (weaponType === 'bow') {
      const bowX = scr.x + Math.cos(player.angle) * (radius - 1);
      const bowY = scr.y + Math.sin(player.angle) * (radius - 1);
      ctx.translate(bowX, bowY);
      ctx.rotate(player.angle);

      // Bow limb
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, 9, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();

      // String is always drawn back (ready to fire). On attack, it snaps
      // forward (releases) then returns to full draw.
      const maxPull = 6;
      let stringPull;
      if (active) {
        // Release: quick forward snap using attackProgress
        const releaseT = clamp01((motion.attackProgress || 0) / 0.35);
        stringPull = maxPull * (1 - easeOutCubic(releaseT));
      } else {
        stringPull = maxPull; // always at full draw between shots
      }
      const nockX = -3 - stringPull;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = active ? 1 : 0.75;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(nockX, 0);
      ctx.lineTo(0, 9);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Arrow nock visible when drawn
      if (stringPull > 1) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(nockX, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();

        ctx.fillStyle = player.accentColor;
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(3, -2.2);
        ctx.lineTo(4.5, 0);
        ctx.lineTo(3, 2.2);
        ctx.closePath();
        ctx.fill();
      }
    }
    
    else if (weaponType === 'spear') {
      // Allow negative reach (pull-back during windup) — just clamp so tip
      // doesn't clip into the player body.
      const ext = Math.max(-radius + 4, radius + 18 + reach);
      const baseX = scr.x + Math.cos(player.angle) * (radius - 2);
      const baseY = scr.y + Math.sin(player.angle) * (radius - 2);
      const tipX = scr.x + Math.cos(player.angle) * ext;
      const tipY = scr.y + Math.sin(player.angle) * ext;

      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      ctx.strokeStyle = this._hexToRGB(player.accentColor, 0.55);
      ctx.lineWidth = 1;
      const sideX = Math.cos(player.angle + Math.PI / 2) * 2;
      const sideY = Math.sin(player.angle + Math.PI / 2) * 2;
      ctx.beginPath();
      ctx.moveTo(baseX + sideX, baseY + sideY);
      ctx.lineTo(tipX + sideX, tipY + sideY);
      ctx.stroke();

      ctx.fillStyle = player.accentColor;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.save();
      ctx.translate(tipX, tipY);
      ctx.rotate(player.angle);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-5, -5);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } 
    
    else if (weaponType === 'gauntlet') {
      ctx.fillStyle = player.accentColor;
      [-0.24, 0.24].forEach(offset => {
        const fistAngle = player.angle + offset;
        const fistDist = radius + 2 + Math.max(0, reach * 0.45);
        const fistX = scr.x + Math.cos(fistAngle) * fistDist;
        const fistY = scr.y + Math.sin(fistAngle) * fistDist;

        ctx.beginPath();
        ctx.arc(fistX, fistY, active ? 5.2 : 3.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = active ? '#ffffff' : '#111216';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = this._hexToRGB('#ffffff', active ? 0.82 : 0.55);
        ctx.beginPath();
        ctx.arc(fistX - Math.cos(fistAngle) * 1.8, fistY - Math.sin(fistAngle) * 1.8, active ? 1.6 : 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = player.accentColor;
      });
    }

    else if (weaponType === 'greatsword') {
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle - Math.PI / 4);
      const len = 23 + Math.max(0, reach * 0.28);
      ctx.fillStyle = this._hexToRGB('#e5e7eb', 0.9);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-5, -4);
      ctx.lineTo(len, len);
      ctx.lineTo(len - 5, len - 1);
      ctx.lineTo(-1, -7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = this._hexToRGB(player.accentColor, 0.6);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(len - 6, len - 6);
      ctx.stroke();
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(-10, -8);
      ctx.lineTo(2, 4);
      ctx.stroke();
      ctx.fillStyle = '#111216';
      ctx.beginPath();
      ctx.arc(-8, -6, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    else if (weaponType === 'scythe') {
      const scytheAngle = active ? weaponAngle + 0.35 : player.angle + Math.PI * 1.5;
      const idleForward = active ? 0 : radius * 3.5;
      const gripX = scr.x + Math.cos(player.angle) * ((active ? 5 : 7) + idleForward);
      const gripY = scr.y + Math.sin(player.angle) * ((active ? 5 : 7) + idleForward);
      const handleTop = -31 - Math.max(0, reach * 0.12);
      const handleBottom = 38;
      ctx.translate(gripX, gripY);
      ctx.rotate(scytheAngle);

      ctx.shadowBlur = this._glow * (active ? 8 : 3);
      ctx.shadowColor = player.accentColor;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-6, handleBottom + 6);
      ctx.lineTo(7, handleTop);
      ctx.stroke();

      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-6, handleBottom + 6);
      ctx.lineTo(7, handleTop);
      ctx.stroke();

      ctx.strokeStyle = this._hexToRGB('#ffffff', 0.36);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-4, handleBottom + 2);
      ctx.lineTo(9, handleTop + 2);
      ctx.stroke();

      const jointX = 7;
      const jointY = handleTop;
      ctx.fillStyle = '#111216';
      ctx.strokeStyle = this._hexToRGB(player.accentColor, 0.78);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(jointX - 4, jointY + 1);
      ctx.bezierCurveTo(jointX + 15, jointY - 13, jointX + 38, jointY - 13, jointX + 54, jointY - 5);
      ctx.bezierCurveTo(jointX + 36, jointY - 5, jointX + 16, jointY - 2, jointX + 1, jointY + 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(jointX + 2, jointY - 1);
      ctx.bezierCurveTo(jointX + 17, jointY - 9, jointX + 39, jointY - 9, jointX + 51, jointY - 5);
      ctx.stroke();

      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(jointX - 4, jointY - 5);
      ctx.lineTo(jointX + 7, jointY + 6);
      ctx.stroke();

      ctx.fillStyle = this._hexToRGB('#ffffff', 0.92);
      ctx.beginPath();
      ctx.arc(jointX + 1, jointY + 1, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    else if (weaponType === 'dagger') {
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      const len = 13 + Math.max(0, reach * 0.22);
      ctx.fillStyle = this._hexToRGB('#ffffff', 0.86);
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(len + 4, 0);
      ctx.lineTo(0, -3.2);
      ctx.lineTo(2, 0);
      ctx.lineTo(0, 3.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(1, -4);
      ctx.lineTo(1, 4);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-4, 0);
      ctx.lineTo(1, 0);
      ctx.stroke();
    }

    else if (weaponType === 'rapier') {
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      const len = 25 + Math.max(0, reach * 0.36);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-5, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = this._hexToRGB(player.accentColor, 0.7);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-2, -1.8);
      ctx.lineTo(len - 4, -1.8);
      ctx.stroke();
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(-4, 0, 5, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(len, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    else if (weaponType === 'hammer') {
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle - Math.PI / 8);
      const len = 18 + Math.max(0, reach * 0.2);
      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.fillStyle = '#111216';
      ctx.strokeStyle = player.accentColor;
      ctx.lineWidth = 2.2;
      ctx.fillRect(len - 2, -7, 13, 14);
      ctx.strokeRect(len - 2, -7, 13, 14);
      ctx.strokeStyle = this._hexToRGB('#ffffff', 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(len + 1, -4);
      ctx.lineTo(len + 8, -4);
      ctx.moveTo(len + 1, 4);
      ctx.lineTo(len + 8, 4);
      ctx.stroke();
      ctx.fillStyle = player.accentColor;
      ctx.beginPath();
      ctx.arc(len - 2, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    else if (weaponType === 'matchlock') {
      // 화승총: short musket — wood stock + steel barrel + red muzzle.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#5b3b1a';
      ctx.fillRect(-11, -2.6, 9, 5.2);              // stock
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-3, -0.4);
      ctx.lineTo(19, -0.4);                          // barrel
      ctx.stroke();
      ctx.fillStyle = '#9a3412';
      ctx.fillRect(-3, 1.4, 6, 2.4);                 // lock/trigger block
      ctx.shadowBlur = this._glow * 6;
      ctx.shadowColor = '#ef4444';
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(19, -0.4, 2.3, 0, Math.PI * 2);        // muzzle
      ctx.fill();
    }
    else if (weaponType === 'katana') {
      // 카타나: long slim blade, rose guard + dark wrapped handle.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      const len = 25 + Math.max(0, reach * 0.5);
      ctx.fillStyle = this._hexToRGB('#ffe4e6', 0.92);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-1, 1.5);
      ctx.lineTo(len, -0.2);
      ctx.lineTo(len - 3, -1.9);
      ctx.lineTo(-1, -1.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#f43f5e';                   // tsuba (guard)
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-1, -3.6);
      ctx.lineTo(-1, 3.6);
      ctx.stroke();
      ctx.strokeStyle = '#9f1239';                   // handle
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-1, 0);
      ctx.lineTo(-9, 0);
      ctx.stroke();
    }
    else if (weaponType === 'magicstaff') {
      // 마법 지팡이: wooden shaft with a glowing purple orb at the tip.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.strokeStyle = '#7c4d2a';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(15, 0);                             // shaft
      ctx.stroke();
      ctx.shadowBlur = this._glow * 9;
      ctx.shadowColor = '#a855f7';
      ctx.fillStyle = '#c084fc';
      ctx.beginPath();
      ctx.arc(17, 0, 4, 0, Math.PI * 2);             // orb
      ctx.fill();
      ctx.fillStyle = '#f3e8ff';
      ctx.beginPath();
      ctx.arc(17, 0, 1.8, 0, Math.PI * 2);           // orb core
      ctx.fill();
    }
    else if (weaponType === 'sniper') {
      // 스나이퍼: long rifle with a green scope.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(-13, -2.6, 7, 5.2);               // stock
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-7, 0);
      ctx.lineTo(24, 0);                             // long barrel
      ctx.stroke();
      ctx.fillStyle = '#111216';                     // scope body
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.4;
      ctx.fillRect(1, -5.5, 9, 3.2);
      ctx.strokeRect(1, -5.5, 9, 3.2);
      ctx.shadowBlur = this._glow * 6;
      ctx.shadowColor = '#22c55e';
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(24, 0, 2, 0, Math.PI * 2);             // muzzle
      ctx.fill();
    }
    else if (weaponType === 'chakram') {
      // 차크람: a held spinning ring with four blade spikes.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle + (Date.now() / 120) % (Math.PI * 2));
      ctx.strokeStyle = '#c2cad6';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(6, 0, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#e8eef6';
      for (let i = 0; i < 4; i++) {
        ctx.save(); ctx.translate(6, 0); ctx.rotate(i * Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(5, -2); ctx.lineTo(10, 0); ctx.lineTo(5, 2); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
    else if (weaponType === 'pistols') {
      // 쇠뇌: a compact fallback silhouette.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(-2, -2, 16, 4);                   // barrel
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(-4, 0, 5, 8);                     // grip
      ctx.shadowBlur = this._glow * (active ? 6 : 0);
      ctx.shadowColor = '#fb7185';
      ctx.fillStyle = '#fecdd3';
      ctx.fillRect(13, -1.5, 3, 3);                  // muzzle
    }
    else if (weaponType === 'guardian') {
      // 디펜더: a short emitter blade (orbit shown separately).
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.shadowBlur = this._glow * (active ? 8 : 4);
      ctx.shadowColor = '#2dd4bf';
      ctx.fillStyle = '#2dd4bf';
      ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(14, 0); ctx.lineTo(0, 3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#0f766e';
      ctx.fillRect(-5, -2.2, 6, 4.4);                // hilt
    }
    else if (weaponType === 'harpoon') {
      // 작살: a launcher with a barbed bolt.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#5b4a32';
      ctx.fillRect(-9, -3, 6, 6);                    // launcher body
      ctx.strokeStyle = '#9aa2ad';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(16, 0); ctx.stroke(); // shaft
      ctx.fillStyle = '#c2cad6';
      ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(14, -5); ctx.lineTo(16, 0); ctx.lineTo(14, 5); ctx.closePath(); ctx.fill(); // barbed head
    }
    else if (weaponType === 'minebag') {
      // 지뢰 가방: a satchel with a spiked mine.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#92400e';
      ctx.fillRect(-6, -5, 11, 10);                  // bag
      ctx.fillStyle = '#3a2a08';
      ctx.fillRect(-6, -5, 11, 2);                   // flap
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(9, 0, 4, 0, Math.PI * 2); ctx.fill(); // mine
      ctx.fillStyle = '#7c2d12';
      for (const a of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
        ctx.fillRect(9 + Math.cos(a) * 4 - 0.8, Math.sin(a) * 4 - 0.8, 1.6, 1.6);
      }
    }
    else if (weaponType === 'flamethrower') {
      // 화염방사기: a tank + nozzle with a pilot flame.
      ctx.translate(wX, wY);
      ctx.rotate(weaponAngle);
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(-9, -3.5, 11, 7);                 // tank/body
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(16, 0); ctx.stroke(); // nozzle
      ctx.shadowBlur = this._glow * 8;
      ctx.shadowColor = '#fb923c';
      ctx.fillStyle = '#fb923c';
      ctx.beginPath(); ctx.arc(18, 0, 3, 0, Math.PI * 2); ctx.fill(); // pilot flame
      if (active) {
        ctx.fillStyle = 'rgba(253,224,71,0.85)';
        ctx.beginPath(); ctx.arc(22, 0, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * Draw the Ninja Adventure in-hand weapon sprite at the hand, oriented to the
   * aim/swing angle. The item icon art points up-right, so the base draw angle
   * adds 45 degrees and per-weapon tune values handle centered bows/crossbows.
   * Returns false if no sprite exists for this weapon so the caller falls back.
   */
  _drawNinjaWeapon(ctx, scr, player, motion, radius, weaponAngle, reach, active) {
    // Equipped weapon skin swaps to an alternate sprite; falls back to the base.
    // 'pistols' weapon uses 'crossbow' as its shop/skin key.
    const effectiveKey = player.weapon === 'pistols' ? 'crossbow' : player.weapon;
    const skin = player.weaponSkins?.[effectiveKey];
    const img = (skin && this.atlas?.get(`wpn/${effectiveKey}@${skin}`))
      || this.atlas?.get(`wpn/${effectiveKey}`)
      || this.atlas?.get(`wpn/${player.weapon}`);
    if (!img || !img.naturalWidth) return false;     // no sprite for this key → fallback

    const tune = WEAPON_SPRITE_TUNE[player.weapon] || WEAPON_TUNE_DEFAULT;
    // The icon art points UP-RIGHT (tip ≈ -45°), grip at the lower-left, so the
    // base rotation that aligns the tip with the aim is aim + 45°.
    const aim = Number.isFinite(weaponAngle) ? weaponAngle : player.angle;
    const handReachScale = Number.isFinite(tune.handReachScale) ? tune.handReachScale : 0.08;
    const baseHandDist = Number.isFinite(tune.handDistance) ? tune.handDistance : radius + 2;
    const handDist = Math.max(0, baseHandDist + Math.max(0, reach) * handReachScale);
    const hx = scr.x + Math.cos(aim) * handDist;
    const hy = scr.y + Math.sin(aim) * handDist;
    // Integer 2× scale keeps the 16px pixels crisp. tune.scale fine-tunes.
    const size = 16 * 2 * (tune.scale || 1);
    const ax = Number.isFinite(tune.anchorX) ? tune.anchorX : 0.2;  // grip ≈ lower-left
    const ay = Number.isFinite(tune.anchorY) ? tune.anchorY : 0.82;
    const isMagic = player.weapon === 'magicstaff';

    ctx.save();
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(hx), Math.round(hy));
    ctx.rotate(aim + Math.PI / 4 + (tune.rot || 0));
    if (isMagic) { ctx.shadowBlur = this._glow * (active ? 8 : 3); ctx.shadowColor = player.accentColor || '#a855f7'; }
    ctx.drawImage(img, -size * ax, -size * ay, size, size);   // grip at the hand
    ctx.imageSmoothingEnabled = smoothing;
    ctx.restore();
    return true;
  }

  _drawWeaponSprite(ctx, scr, player, motion, radius, weaponAngle, reach, active) {
    const weaponType = player.weapon;
    const sprite = this.weaponSprites?.[weaponType];
    if (!sprite?.ready || !sprite.image?.naturalWidth) return false;

    const meta = sprite.meta;
    const drawAngle = resolveWeaponSpriteDrawAngle(weaponType, player.angle, weaponAngle, active);

    const spriteScale = meta.scale * (active ? 1.06 : 1);
    const size = Math.max(38, 147 * spriteScale + Math.max(0, reach) * 0.08); // base 92 → 147 (~1.6x bigger weapons)
    const handDist = Math.max(radius - 3, radius + 6 + reach * 0.2);
    const idleForward = 0;
    const handX = scr.x + Math.cos(drawAngle) * handDist + Math.cos(player.angle) * idleForward;
    const handY = scr.y + Math.sin(drawAngle) * handDist + Math.sin(player.angle) * idleForward;

    const idleScytheFlip = 0;
    const drawSingle = (offsetAngle = 0, offsetDist = 0, flipY = 1, options = {}) => {
      const a = drawAngle + offsetAngle;
      const forward = Number.isFinite(options.forward) ? options.forward : 0;
      const drawScale = Number.isFinite(options.scale) ? options.scale : 1;
      const drawSize = size * drawScale;
      const x = handX + Math.cos(drawAngle) * forward + Math.cos(drawAngle + Math.PI / 2) * offsetDist;
      const y = handY + Math.sin(drawAngle) * forward + Math.sin(drawAngle + Math.PI / 2) * offsetDist;
      ctx.save();
      const smoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.translate(x, y);
      ctx.rotate(a + (meta.angleOffset || 0) + idleScytheFlip);
      ctx.scale(1, flipY);
      ctx.globalAlpha = Number.isFinite(options.alpha) ? options.alpha : (active ? 1 : 0.94);
      ctx.shadowBlur = this._glow * (active ? 8 : 2);
      ctx.shadowColor = player.accentColor;
      ctx.drawImage(
        sprite.image,
        -drawSize * meta.anchorX,
        -drawSize * meta.anchorY,
        drawSize,
        drawSize
      );
      ctx.imageSmoothingEnabled = smoothing;
      ctx.restore();
    };

    // Aim pointing left would otherwise render the sprite upside-down. Mirror it
    // vertically once the draw direction crosses the ±90° (straight up/down)
    // lines so the weapon always stays "upright" around its grip.
    const aimFlip = meta.noAimFlip ? 1 : (Math.cos(drawAngle) < 0 ? -1 : 1);
    if (weaponType === 'gauntlet') {
      const side = Number.isFinite(motion.punchSide) ? Math.sign(motion.punchSide) : 0;
      if (active && side !== 0) {
        const flipForSide = (handSide) => handSide < 0 ? aimFlip : -aimFlip;
        const guardSide = -side;
        drawSingle(-0.04 * side, guardSide * 5.1, flipForSide(guardSide), {
          forward: -Math.max(3, reach * 0.28),
          alpha: 0.82,
          scale: 0.92
        });
        drawSingle(0.03 * side, side * 5.9, flipForSide(side), {
          forward: Math.max(7, reach * 0.62),
          alpha: 1,
          scale: 1.08
        });
      } else {
        drawSingle(0.05, -5, aimFlip);
        drawSingle(-0.05, 5, -aimFlip);
      }
    } else {
      drawSingle(0, 0, aimFlip);
    }
    return true;
  }

  /**
   * Draw attack range helper outline and subtle fill
   */
  _drawPlayerAttackRange(ctx, camera, cw, ch, scr, player, isLocal, isAttacking = false, mapWidth = 0, mapHeight = 0, activeAttack = null) {
    if (!player || player.isDead) return;
    const baseWeapon = getEffectiveWeapon(player.weapon, player.buffType);
    if (!baseWeapon) return;
    // Reaching here means the guide should be shown: the local player always, and
    // enemies whenever the viewer hasn't hidden them (gated by hideEnemyAttackPreviews
    // in the caller). So enemy guides show whether or not they're mid-attack —
    // idle draws the dashed guide, attacking overlays the solid shape.

    // Charging up the combo finisher? Preview its (bigger) hit range instead.
    const isFinisherPreview = activeAttack?.type === 'finisher_ready' && Boolean(activeAttack.previewType);
    const isGreatswordChargePreview = activeAttack?.type === 'greatsword_charge' && player.weapon === 'greatsword';
    const skillPreview = isGreatswordChargePreview ? SkillConfig.greatsword : null;

    // Only these are real hit-shapes. Motion-only effects (projectile_shot,
    // spear_windup, finisher_ready) must NOT override the drawn shape, or the
    // guide vanishes mid-attack (e.g. the bow path disappears the instant you
    // fire). For those, fall back to the weapon's base shape.
    const SHAPE_TYPES = [
      'melee_arc', 'melee_circle', 'melee_line', 'projectile',
      'melee_heavy_arc', 'melee_sweet_arc', 'melee_backstab',
      'melee_precise_line', 'melee_heavy_line', 'melee_slam', 'melee_blade_sweep'
    ];
    const activeShapeType = SHAPE_TYPES.includes(activeAttack?.type) ? activeAttack.type : null;

    // Scale the world-space reach to screen pixels so the guide matches the
    // real hitbox at any zoom (and reflects active skill buffs).
    const zoom = camera.zoom || 1;
    let shapeType = activeShapeType || baseWeapon.type;
    let shapeRange = Number.isFinite(activeAttack?.range) ? activeAttack.range : baseWeapon.range;
    let shapeWidth = Number.isFinite(activeAttack?.width) ? activeAttack.width : baseWeapon.width;
    let shapeInnerRange = Number.isFinite(activeAttack?.innerRange) ? activeAttack.innerRange : baseWeapon.innerRange;
    let shapeAngleDeg = Number.isFinite(activeAttack?.angleDeg) ? activeAttack.angleDeg : baseWeapon.angle;
    if (isFinisherPreview) {
      shapeType = activeAttack.previewType;
      shapeRange = activeAttack.previewRange;
      shapeWidth = activeAttack.previewWidth;
      shapeAngleDeg = activeAttack.previewAngleDeg;
    } else if (skillPreview) {
      shapeType = skillPreview.type;
      shapeRange = skillPreview.range;
      shapeWidth = skillPreview.width;
      shapeInnerRange = skillPreview.innerRange;
      shapeAngleDeg = skillPreview.angle;
    } else if (player.weapon === 'greatsword' && !activeShapeType) {
      // Idle (not charging) greatsword guide is drawn at the full charged reach
      // so its resting footprint matches the charge preview's size.
      shapeRange = SkillConfig.greatsword.range;
      shapeAngleDeg = SkillConfig.greatsword.angle;
    }

    const weapon = {
      ...baseWeapon,
      type: shapeType,
      range: (shapeRange || 0) * zoom,
      width: (shapeWidth || 0) * zoom,
      innerRange: (shapeInnerRange || 0) * zoom,
      angle: shapeAngleDeg
    };

    ctx.save();

    // Ranged weapons keep a constant gray dashed path preview at all times so
    // opponents can read & dodge incoming fire — it never flips to a solid
    // highlight on attack.
    const isProjectile = weapon.type === 'projectile';

    // Finisher preview pulses in the weapon color so the player can pre-aim the
    // big strike. Active attacks use a solid bright overlay; idle uses a faint
    // dashed guide.
    const showStrong = isAttacking && !isFinisherPreview && !isProjectile;
    let guideColor;
    let fillAlpha;
    let strokeAlpha;
    if (isFinisherPreview) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 110);
      guideColor = weapon.color;
      fillAlpha = 0.06 + 0.06 * pulse;
      strokeAlpha = 0.45 + 0.35 * pulse;
    } else {
      guideColor = showStrong ? weapon.color : '#d1d5db';
      fillAlpha = showStrong ? 0.035 : 0.018;
      strokeAlpha = showStrong ? 0.36 : 0.18;
    }

    ctx.fillStyle = this._hexToRGB(guideColor, fillAlpha);
    ctx.strokeStyle = this._hexToRGB(guideColor, strokeAlpha);
    ctx.lineWidth = isFinisherPreview ? 2.2 : (showStrong ? 1.6 : 1.1);
    ctx.setLineDash(isFinisherPreview ? [9, 5] : (showStrong ? [] : [6, 7]));

    const range = weapon.range;
    const angle = player.angle + (Number.isFinite(activeAttack?.angleOffset) ? activeAttack.angleOffset : 0);
    const arcShapeTypes = ['melee_arc', 'melee_heavy_arc', 'melee_sweet_arc', 'melee_backstab', 'melee_blade_sweep'];
    const circleShapeTypes = ['melee_circle', 'melee_slam'];
    const lineShapeTypes = ['melee_line', 'melee_precise_line', 'melee_heavy_line'];

    if (circleShapeTypes.includes(weapon.type)) {
      // Circle shape (Axe)
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, range, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    else if (arcShapeTypes.includes(weapon.type)) {
      // Arc shape (Sword, Gauntlet)
      const halfAngleRad = (weapon.angle * Math.PI) / 360;
      const startAngle = angle - halfAngleRad;
      const endAngle = angle + halfAngleRad;

      ctx.beginPath();
      ctx.moveTo(scr.x, scr.y);
      ctx.arc(scr.x, scr.y, range, startAngle, endAngle);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (isGreatswordChargePreview) {
        const thresholdRadius = range * clamp01(SkillConfig.greatsword.chargeThreshold ?? 0.5);
        ctx.save();
        ctx.setLineDash([5, 6]);
        ctx.strokeStyle = this._hexToRGB('#ffffff', 0.44);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, thresholdRadius, startAngle, endAngle);
        ctx.stroke();
        ctx.restore();
      }

      if (weapon.type === 'melee_sweet_arc' && weapon.innerRange > 0) {
        ctx.save();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = this._hexToRGB(guideColor, strokeAlpha * 0.75);
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, weapon.innerRange, startAngle, endAngle);
        ctx.stroke();
        ctx.restore();
      }
    }
    else if (lineShapeTypes.includes(weapon.type)) {
      // Rectangular line/thrust shape (Spear)
      const uX = Math.cos(angle);
      const uY = Math.sin(angle);
      
      // Orthogonal offset vector
      const halfWidth = weapon.width / 2;
      const pX = -uY * halfWidth;
      const pY = uX * halfWidth;

      // Draw the four corners of the box
      ctx.beginPath();
      ctx.moveTo(scr.x + pX, scr.y + pY);
      ctx.lineTo(scr.x - pX, scr.y - pY);
      ctx.lineTo(scr.x - pX + uX * range, scr.y - pY + uY * range);
      ctx.lineTo(scr.x + pX + uX * range, scr.y + pY + uY * range);
      ctx.closePath();
      
      ctx.fill();
      ctx.stroke();
    } 
    else if (weapon.type === 'projectile') {
      const start = 22;
      const distanceToWall = rayToMapBoundaryDistance(player.x, player.y, angle, mapWidth, mapHeight);
      const previewRange = Number.isFinite(distanceToWall) ? distanceToWall : Math.max(cw, ch);
      const startWorldX = player.x + Math.cos(angle) * start;
      const startWorldY = player.y + Math.sin(angle) * start;
      const endWorldX = player.x + Math.cos(angle) * previewRange;
      const endWorldY = player.y + Math.sin(angle) * previewRange;
      const startScr = camera.toScreen(startWorldX, startWorldY, cw, ch);
      const endScr = camera.toScreen(endWorldX, endWorldY, cw, ch);

      if (player.isMobile) {
        // Mobile shooters fire instantly (no telegraph window), so their aim
        // beam glows in the weapon color and is visible to EVERYONE — it stands
        // in for the telegraph so enemies can read and dodge the instant shot.
        // Desktop shooters keep the faint guide (they still get the telegraph).
        ctx.save();
        ctx.setLineDash([]);
        ctx.shadowColor = weapon.color;
        ctx.shadowBlur = this._glow ? 8 : 0;
        ctx.strokeStyle = this._hexToRGB(weapon.color, 0.9);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(startScr.x, startScr.y);
        ctx.lineTo(endScr.x, endScr.y);
        ctx.stroke();
        // bright impact dot at the wall
        ctx.fillStyle = this._hexToRGB(weapon.color, 0.95);
        ctx.beginPath();
        ctx.arc(endScr.x, endScr.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.moveTo(startScr.x, startScr.y);
        ctx.lineTo(endScr.x, endScr.y);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.fillStyle = this._hexToRGB(guideColor, 0.25);
      ctx.beginPath();
      ctx.arc(endScr.x, endScr.y, 3, 0, Math.PI * 2);
      ctx.fill();

      // Crosshair always visible for local player — use weapon color so it
      // stands out clearly against any background, regardless of attack state.
      if (isLocal) this._drawCrosshair(ctx, endScr.x, endScr.y, weapon.color || guideColor, true);
    }

    // Dashed aim line + crosshair at reach tip for melee arc/line (local player).
    if (isLocal && (arcShapeTypes.includes(weapon.type) || lineShapeTypes.includes(weapon.type))) {
      const tipSx = scr.x + Math.cos(angle) * range;
      const tipSy = scr.y + Math.sin(angle) * range;
      ctx.save();
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = this._hexToRGB(guideColor, isAttacking ? 0.42 : 0.25);
      ctx.lineWidth = 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(scr.x + Math.cos(angle) * 20, scr.y + Math.sin(angle) * 20);
      ctx.lineTo(tipSx, tipSy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      this._drawCrosshair(ctx, tipSx, tipSy, guideColor, isAttacking);
    }

    // Axe (melee_circle): direction dot at ring edge.
    if (isLocal && circleShapeTypes.includes(weapon.type)) {
      const dotSx = scr.x + Math.cos(angle) * range * 0.88;
      const dotSy = scr.y + Math.sin(angle) * range * 0.88;
      ctx.save();
      ctx.fillStyle = this._hexToRGB(guideColor, isAttacking ? 0.85 : 0.5);
      ctx.beginPath();
      ctx.arc(dotSx, dotSy, isAttacking ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Draw a + crosshair at (sx, sy) — used for weapon endpoint guides.
   * color is the weapon color; bright=true when the player is actively attacking.
   */
  _drawCrosshair(ctx, sx, sy, color, bright = false) {
    const sz = bright ? 10 : 7;
    const gap = bright ? 3 : 2;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';

    // Dark outline for contrast against any background
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = (bright ? 2.2 : 1.4) + 2;
    ctx.beginPath();
    ctx.moveTo(sx - sz, sy); ctx.lineTo(sx - gap, sy);
    ctx.moveTo(sx + gap, sy); ctx.lineTo(sx + sz, sy);
    ctx.moveTo(sx, sy - sz); ctx.lineTo(sx, sy - gap);
    ctx.moveTo(sx, sy + gap); ctx.lineTo(sx, sy + sz);
    ctx.stroke();

    // Colored inner lines
    ctx.shadowBlur = this._glow * (bright ? 10 : 4);
    ctx.shadowColor = color;
    ctx.strokeStyle = bright ? color : this._hexToRGB(color, 0.85);
    ctx.lineWidth = bright ? 2.2 : 1.4;
    ctx.beginPath();
    ctx.moveTo(sx - sz, sy); ctx.lineTo(sx - gap, sy);
    ctx.moveTo(sx + gap, sy); ctx.lineTo(sx + sz, sy);
    ctx.moveTo(sx, sy - sz); ctx.lineTo(sx, sy - gap);
    ctx.moveTo(sx, sy + gap); ctx.lineTo(sx, sy + sz);
    ctx.stroke();

    // Center dot
    ctx.shadowBlur = this._glow *0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, bright ? 2.8 : 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw the cursor crosshair at the exact mouse position (screen space, no
   * camera transform). High-contrast gold/mint + black outline so it reads on
   * bright platformer skies and dark interiors.
   */
  _drawCursorCrosshair(ctx, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const sz = 13;
    const gap = 4;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';

    // Shadow / outline
    ctx.strokeStyle = 'rgba(0,0,0,0.86)';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(x - sz, y); ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y); ctx.lineTo(x + sz, y);
    ctx.moveTo(x, y - sz); ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap); ctx.lineTo(x, y + sz);
    ctx.stroke();

    // Gold lines
    ctx.strokeStyle = '#ffd84d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - sz, y); ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y); ctx.lineTo(x + sz, y);
    ctx.moveTo(x, y - sz); ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap); ctx.lineTo(x, y + sz);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = '#7df09a';
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.88)';
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Dead player tombstone/grave visual representation
   */
  _drawGrave(ctx, camera, cw, ch, player) {
    const scr = camera.toScreen(player.x, player.y, cw, ch);
    ctx.save();

    // Semi-translucent Tombstone
    ctx.fillStyle = 'rgba(74, 85, 104, 0.65)';
    ctx.strokeStyle = 'rgba(26, 32, 44, 0.8)';
    ctx.lineWidth = 2.5;

    // Drawing Headstone SVG alternative arch
    ctx.beginPath();
    ctx.moveTo(scr.x - 9, scr.y + 10);
    ctx.lineTo(scr.x - 9, scr.y - 6);
    ctx.quadraticCurveTo(scr.x, scr.y - 15, scr.x + 9, scr.y - 6);
    ctx.lineTo(scr.x + 9, scr.y + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // RIP sign or standard Cross inner lining
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(scr.x, scr.y - 8);
    ctx.lineTo(scr.x, scr.y + 4);
    ctx.moveTo(scr.x - 4, scr.y - 4);
    ctx.lineTo(scr.x + 4, scr.y - 4);
    ctx.stroke();

    // Faded nickname hovering under
    ctx.fillStyle = 'rgba(160, 174, 192, 0.5)';
    ctx.font = '9px "Galmuri9", "Galmuri11", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${player.nickname} [RIP]`, scr.x, scr.y + 20);

    ctx.restore();
  }

  /**
   * Conversion helpers for HEX color sets
   */
  _hexToRGB(hex, alpha = 1) {
    // If HSL passed directly, bypass hex process
    if (hex.startsWith('hsl')) {
      return hex.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
    }

    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(value) {
  const t = clamp01(value);
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(value) {
  const t = clamp01(value);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function rayToMapBoundaryDistance(x, y, angle, mapWidth, mapHeight) {
  if (!mapWidth || !mapHeight) return Infinity;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const candidates = [];

  if (dx > 0) candidates.push((mapWidth - x) / dx);
  if (dx < 0) candidates.push((0 - x) / dx);
  if (dy > 0) candidates.push((mapHeight - y) / dy);
  if (dy < 0) candidates.push((0 - y) / dy);

  const distance = Math.min(...candidates.filter(value => value > 0 && Number.isFinite(value)));
  return Number.isFinite(distance) ? distance : Infinity;
}
