/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tier-2 workshop weapons — the BALANCE ENVELOPE (Tier-2 safety foundation).
 *
 * Workshop weapons carry user-authored GAMEPLAY data (damage, cooldown, hitbox
 * geometry, status…), so without hard limits they would be a cheat vector. Every
 * field is min/max clamped here, and a point budget stops one weapon from maxing
 * everything ("장점엔 단점"). This runs as a DOUBLE CLAMP: once when a weapon is
 * published, and again on the host right before it enters the simulation — the
 * host re-clamps any definition it receives and never trusts the raw blob.
 *
 * INVARIANT: instakill (9999 / one-shot) is admin-canonical ONLY. The damage cap
 * here is far below any lethal-in-one-hit value, so a workshop weapon can never
 * one-shot. Sniper/matchlock instakill lives in weapon code, never reproducible
 * from workshop stats. RESPAWN_MS is untouched.
 */

import { sanitizeMotion } from './Motion.js';

// Hard min/max for every workshop stat. Tuned around the existing roster
// (damage ~10-50, cooldown 180-2000, hp 85-155, move 0.78-1.35, range 55-290)
// but never permissive enough to one-shot or machine-gun.
export const ENVELOPE = {
  maxHp:           [70, 160],
  moveSpeed:       [0.7, 1.35],
  damage:          [4, 55],        // « any instakill; a workshop weapon cannot one-shot
  cooldownMs:      [250, 10000],   // floor 250ms — no machine-gun, max 10s
  range:           [30, 300],
  projectileSpeed: [180, 1200],
  knockback:       [0, 200],
  statusDurationMs:[0, 3000],
  statusIntensity: [0, 1],
  airborneHeight:  [20, 260],
  // Per-hitbox geometry (tighter than the admin canonical caps).
  hitboxDimMax:    160,            // each of w/h
  hitboxAreaMax:   14000,          // w*h px²
  activeLenMax:    0.4,            // active-window length (normalized motion time)
  maxHitboxes:     8,
  maxProjectileEvents: 5,
  maxTeleportEvents: 5,
};

export const VALID_STATUS = new Set(['none', 'slow', 'bleed', 'burn', 'stun', 'airborne']);
export const POINT_BUDGET = 100;
const BUDGET_COST_MULT = 1.5;
const COOLDOWN_BUDGET_BASE_MS = 600;
const COOLDOWN_BUDGET_COST_STEP_MS = 100;
const COOLDOWN_BUDGET_REFUND_STEP_MS = 500;

const clampNum = (v, [lo, hi], dflt) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);

/** Strip control chars + cap length; keeps text safe to store/show (escape at
 *  render time too). */
export function sanitizeText(s, max = 24) {
  let out = String(s == null ? '' : s);
  let clean = '';
  for (const ch of out) { const c = ch.codePointAt(0); if (c >= 32 && c !== 127) clean += ch; }
  return clean.trim().slice(0, max);
}

/** Clamp a raw stat block into the envelope (no budget yet). */
export function clampWorkshopStats(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const status = VALID_STATUS.has(r.status) ? r.status : 'none';
  return {
    maxHp: Math.round(clampNum(r.maxHp, ENVELOPE.maxHp, 100)),
    moveSpeed: Math.round(clampNum(r.moveSpeed, ENVELOPE.moveSpeed, 1) * 100) / 100,
    damage: Math.round(clampNum(r.damage, ENVELOPE.damage, 18)),
    cooldownMs: Math.round(clampNum(r.cooldownMs, ENVELOPE.cooldownMs, 600)),
    range: Math.round(clampNum(r.range, ENVELOPE.range, 70)),
    projectileSpeed: Math.round(clampNum(r.projectileSpeed, ENVELOPE.projectileSpeed, 600)),
    knockback: Math.round(clampNum(r.knockback, ENVELOPE.knockback, 0)),
    status,
    statusDurationMs: status === 'none' ? 0 : Math.round(clampNum(r.statusDurationMs, ENVELOPE.statusDurationMs, 0)),
    statusIntensity: status === 'none' ? 0 : Math.round(clampNum(r.statusIntensity, ENVELOPE.statusIntensity, 0.5) * 100) / 100,
    ultimateGain: Math.round(clampNum(r.ultimateGain, [10, 35], 10) / 5) * 5,
    airborneHeight: status === 'airborne' ? Math.round(clampNum(r.airborneHeight, ENVELOPE.airborneHeight, 120)) : 120,
  };
}

// 0..1 of a stat's range (0 = weakest, 1 = strongest). Cooldown inverts (lower = stronger).
const norm = (v, [lo, hi]) => (hi <= lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))));

/**
 * Power cost of a stat block in budget points. A "balanced" weapon sits well
 * under POINT_BUDGET; maxing offence + mobility + survivability blows past it.
 */
export function statCost(stats) {
  const s = stats;
  const dmg = norm(s.damage, ENVELOPE.damage);
  const rate = 1 - norm(s.cooldownMs, ENVELOPE.cooldownMs);  // faster = stronger
  const range = norm(s.range, ENVELOPE.range);
  const hp = norm(s.maxHp, ENVELOPE.maxHp);
  const spd = norm(s.moveSpeed, ENVELOPE.moveSpeed);
  const kb = norm(s.knockback, ENVELOPE.knockback);
  const status = s.status !== 'none' ? (0.5 + 0.5 * norm(s.statusDurationMs, ENVELOPE.statusDurationMs)) : 0;
  // 1000/7 scale: the budget reads as a friendly 100 points, but every cost is
  // ×10/7 so the RATIO of build power to budget is identical to the old
  // 70-point balance (a balanced build ~57/100, maxing everything ~163/100).
  return Math.round((1000 / 7) * (0.34 * dmg + 0.24 * rate + 0.14 * range + 0.12 * hp + 0.10 * spd + 0.06 * kb + 0.14 * status));
}

/**
 * Enforce the point budget: if the block costs more than POINT_BUDGET, bleed
 * stats down in priority order — damage first (most fungible), then cooldown up,
 * status duration, knockback, range, move speed, max hp — until it fits. With
 * the tighter 70-point budget, damage alone can't always cover a maxed build.
 * Returns { stats, cost, overBudget }.
 */
export function enforceBudget(stats) {
  const s = { ...stats };
  const over = statCost(s) > POINT_BUDGET;
  // [key, step, floor-or-ceiling accessor] — cooldown INCREASES (weaker = slower).
  const bleed = [
    ['damage', -1, () => s.damage > ENVELOPE.damage[0]],
    ['cooldownMs', +25, () => s.cooldownMs < ENVELOPE.cooldownMs[1]],
    ['statusDurationMs', -100, () => s.statusDurationMs > 0],
    ['knockback', -5, () => s.knockback > ENVELOPE.knockback[0]],
    ['range', -5, () => s.range > ENVELOPE.range[0]],
    ['moveSpeed', -0.01, () => s.moveSpeed > ENVELOPE.moveSpeed[0]],
    ['maxHp', -1, () => s.maxHp > ENVELOPE.maxHp[0]],
  ];
  let guard = 0;
  outer: while (statCost(s) > POINT_BUDGET && guard++ < 2000) {
    for (const [key, step, can] of bleed) {
      if (!can()) continue;
      s[key] = Math.round((s[key] + step) * 100) / 100;
      continue outer;   // re-check cost after every single decrement
    }
    break;   // nothing left to bleed
  }
  return { stats: s, cost: statCost(s), overBudget: over };
}

/** Clamp a list of hitboxes to the (tighter) workshop geometry caps. Exported so
 *  Player.js can defensively re-clamp a synced peer's skill/heavy hitboxes. */
export function clampWorkshopHitboxes(hitboxes) {
  if (!Array.isArray(hitboxes)) return [];
  const out = [];
  for (const hb of hitboxes.slice(0, ENVELOPE.maxHitboxes)) {
    if (!hb || typeof hb !== 'object') continue;
    let w = clampNum(hb.w, [4, ENVELOPE.hitboxDimMax], 40);
    let h = clampNum(hb.h, [4, ENVELOPE.hitboxDimMax], 40);
    if (w * h > ENVELOPE.hitboxAreaMax) {            // scale down to the area cap
      const k = Math.sqrt(ENVELOPE.hitboxAreaMax / (w * h));
      w = Math.round(w * k); h = Math.round(h * k);
    }
    let aS = clampNum(hb.activeStart, [0, 1], 0);
    let aE = clampNum(hb.activeEnd, [0, 1], 1);
    if (aE < aS) { const t = aS; aS = aE; aE = t; }
    if (aE - aS > ENVELOPE.activeLenMax) aE = aS + ENVELOPE.activeLenMax;   // cap window length
    const frameTime = clampNum(hb.frameTime, [0, 1], (aS + aE) / 2);
    const item = { ox: clampNum(hb.ox, [-220, 220], 0), oy: clampNum(hb.oy, [-220, 220], 0), w, h, activeStart: aS, activeEnd: aE, frameTime };
    if (Number.isFinite(Number(hb.damage))) item.damage = Math.round(clampNum(hb.damage, [0, 60], 0));
    out.push(item);
  }
  return out;
}

/**
 * Full double-clamp pipeline for a workshop weapon definition. Returns a safe,
 * brand-new object: sanitized name, clamped stats (envelope + budget), and a
 * sanitized motion set whose attack hitboxes obey the workshop caps. Never
 * throws — garbage in → safe defaults out.
 */
export function clampWorkshopWeapon(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const name = sanitizeText(r.name, 24) || '이름없는 무기';
  const desc = sanitizeText(r.desc, 80);
  const color = (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) ? r.color : null;

  const { stats } = enforceBudget(clampWorkshopStats(r.stats));

  // Motion set: cosmetic pose data + the attack's hitboxes (kept via allowGameplay),
  // then geometry re-clamped to the workshop envelope. Keys are the FIXED motion
  // tag vocabulary only — unknown slots are dropped (no smuggling arbitrary data).
  const MOTION_STATES = ['attack', 'run', 'idle', 'jump', 'dash', 'skill', 'skill2', 'skill3', 'heavy', 'hurt'];
  const rawSet = (r.motionSet && typeof r.motionSet === 'object') ? r.motionSet : {};
  const motionSet = {};
  for (const state of MOTION_STATES) {
    if (!rawSet[state]) continue;
    const m = sanitizeMotion(rawSet[state], undefined, { allowGameplay: true });
    // Attack/heavy/skill1-3 carry real hitboxes (they drive combat); rest cosmetic.
    if (['attack', 'heavy', 'skill', 'skill2', 'skill3'].includes(state)) { if (Array.isArray(rawSet[state].hitboxes)) m.hitboxes = clampWorkshopHitboxes(rawSet[state].hitboxes); }
    else delete m.hitboxes;
    // Preserve the weapon flip timeline (sanitizeMotion drops it) — cosmetic.
    if (Array.isArray(rawSet[state].flipXKeys)) m.flipXKeys = sanitizeFlipKeys(rawSet[state].flipXKeys);
    if (Array.isArray(rawSet[state].flipYKeys)) m.flipYKeys = sanitizeFlipKeys(rawSet[state].flipYKeys);
    if (Array.isArray(rawSet[state].leftFlipXKeys)) m.leftFlipXKeys = sanitizeFlipKeys(rawSet[state].leftFlipXKeys);
    if (Array.isArray(rawSet[state].leftFlipYKeys)) m.leftFlipYKeys = sanitizeFlipKeys(rawSet[state].leftFlipYKeys);
    if (Array.isArray(rawSet[state].handSwapKeys)) m.handSwapKeys = sanitizeFlipKeys(rawSet[state].handSwapKeys);
    if (['attack', 'heavy', 'skill', 'skill2', 'skill3'].includes(state)) {
      m.projectileEvents = sanitizeProjectileEvents(rawSet[state].projectileEvents);
      m.teleportEvents = sanitizeTeleportEvents(rawSet[state].teleportEvents);
    }
    motionSet[state] = m;
  }

  // Block-gimmick AST rides along as pure data; the BlockVM sanitizes + clamps it
  // when it is constructed (host-side), so we only pass a bounded object here.
  const blocks = (r.blocks && typeof r.blocks === 'object' && Array.isArray(r.blocks.events)) ? r.blocks : null;

  return { name, desc, color, stats, motionSet, blocks, tier: 'workshop' };
}

// ═══════════════════════════════════════════════════════════════════════════
// WorkshopWeaponV2 — per-preset weapons (V2 schema + sanitize + migration).
// A weapon carries only body stats globally (hp/move); every attack/utility is a
// tagged PRESET with its own motion, combat stats, hitboxes, projectile, flip
// timeline, effects and blocks. Budget = body + each combat preset's combat
// (cooldown excluded). Everything is clamped exactly like V1 (double-clamp).
// ═══════════════════════════════════════════════════════════════════════════

export const WEAPON_CATEGORIES = new Set(['melee', 'ranged', 'special']);
// The primary combat preset slots + absorbed non-attack (cosmetic) motion slots.
export const COMBAT_PRESET_KINDS = new Set(['basic', 'heavy', 'skill1', 'skill2', 'skill3', 'ultimate']);
export const NONCOMBAT_PRESET_KINDS = new Set(['idle', 'run', 'jump', 'hurt']);
export const ALL_PRESET_KINDS = new Set(['basic', 'heavy', 'dash', 'skill1', 'skill2', 'skill3', 'ultimate', ...NONCOMBAT_PRESET_KINDS]);
export const PRIMARY_PRESET_KEYS = ['basic', 'heavy', 'dash', 'skill1', 'skill2', 'skill3', 'ultimate'];
export const PRESET_LABELS = {
  basic: '평타', heavy: '강공격', dash: '대시', skill1: '스킬 1', skill2: '스킬 2', skill3: '스킬 3', ultimate: '궁극기',
  idle: '대기', run: '걷기', jump: '점프', hurt: '피격',
};
export const AUTHORING_PRESET_KEYS = [...PRIMARY_PRESET_KEYS, ...NONCOMBAT_PRESET_KINDS];
// Which in-game input fires each combat/dash preset (cooldown = preset.combat).
// heavy = a basic-attack combo finisher. The required basic count is authored
// on the heavy preset as comboAfter (1..5), defaulting to the old 3-hit behavior.
export const PRESET_INPUT = { basic: 'lmb', heavy: 'combo', skill1: 'skillF', skill2: 'skillE', skill3: 'skillR', ultimate: 'ultimate', dash: 'dash' };
export const FIXED_PRESET_DURATIONS = Object.freeze({
  dash: 0.16,  // DashConfig.durationMs
  run: 0.5,    // STICK_MOTIONS.run
  jump: 0.4,   // STICK_MOTIONS.jump
  hurt: 0.3,
});
export const PROJECTILE_IMAGES = ['arrow', 'bolt', 'magicbolt', 'flame', 'iceshard', 'bullet'];
export const PROJECTILE_ENV = {
  speed: [80, 1200], lifetimeMs: [100, 4000], scale: [0.3, 3],
  hbDim: [4, 120], hbRadius: [3, 80], hbOff: [-120, 120],
};
export const V2_LIMITS = { maxEffects: 24, maxFlipKeys: 16, dashDistance: [0, 320] };
const FOLLOW_BONES = new Set(['weaponTip', 'handR', 'handN', 'root', 'head']);
const FX_STATUS = VALID_STATUS;   // reuse

const isCombatKind = (k) => COMBAT_PRESET_KINDS.has(k);

/** flipXKeys: sorted, deduped-by-time (last wins), boolean values. Time is
 *  NORMALIZED (0..1) so flip / effect / motion keyframes share one axis and
 *  scale with the motion duration automatically. */
export function sanitizeFlipKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const byTime = new Map();
  for (const k of keys.slice(0, 64)) {
    if (!k || typeof k !== 'object') continue;
    const t = clampNum(k.time, [0, 1], 0);
    byTime.set(Math.round(t * 1000) / 1000, !!k.value);   // last write per time wins
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).slice(0, V2_LIMITS.maxFlipKeys)
    .map(([time, value]) => ({ time, value }));
}

/** Sample the weapon flip at a normalized phase (0..1) — a step function. */
export function sampleFlip(flipKeys, time) {
  if (!Array.isArray(flipKeys) || !flipKeys.length) return false;
  let v = flipKeys[0].value;
  for (const k of flipKeys) { if (k.time <= time) v = k.value; else break; }
  return !!v;
}

function sanitizePreviewOffset(o) {
  const r = (o && typeof o === 'object') ? o : {};
  return { x: clampNum(r.x, [-200, 200], 0), y: clampNum(r.y, [-200, 200], 0) };
}

/** Cosmetic frame effects. assetId is a registered FX id or a bounded custom
 *  image id (`custom:fx_*`); the image payload itself travels separately as
 *  effectImages when published.
 *  Time is NORMALIZED (0..1) — shared axis with motion/flip keyframes. */
export function sanitizeEffects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, V2_LIMITS.maxEffects)) {
    if (!e || typeof e !== 'object') continue;
    const time = clampNum(e.time, [0, 1], 0);
    const endTime = clampNum(e.endTime, [time, 1], Math.min(1, time + 0.12));
    const rawAssetId = sanitizeText(e.assetId, 128) || 'spark';
    const base = {
      time,
      endTime,
      assetId: rawAssetId,
      x: clampNum(e.x, [-200, 200], 0), y: clampNum(e.y, [-200, 200], 0),
      scaleX: clampNum(e.scaleX ?? e.scale, [0.1, 4], 1),
      scaleY: clampNum(e.scaleY ?? e.scale, [0.1, 4], 1),
      rotation: clampNum(e.rotation, [-360, 360], 0),
      alpha: clampNum(e.alpha, [0, 1], 1),
      flipX: !!e.flipX,
      flipY: !!e.flipY,
    };
    const rawKeys = Array.isArray(e.keys) ? e.keys : [];
    const byTime = new Map();
    byTime.set(time, { time, x: base.x, y: base.y, scaleX: base.scaleX, scaleY: base.scaleY, rotation: base.rotation, alpha: base.alpha, flipX: base.flipX, flipY: base.flipY });
    for (const key of rawKeys.slice(0, 64)) {
      if (!key || typeof key !== 'object') continue;
      const kt = Math.round(clampNum(key.time, [time, endTime], time) * 1000) / 1000;
      byTime.set(kt, {
        time: kt,
        x: clampNum(key.x, [-200, 200], base.x), y: clampNum(key.y, [-200, 200], base.y),
        scaleX: clampNum(key.scaleX ?? key.scale, [0.1, 4], base.scaleX),
        scaleY: clampNum(key.scaleY ?? key.scale, [0.1, 4], base.scaleY),
        rotation: clampNum(key.rotation, [-360, 360], base.rotation),
        alpha: clampNum(key.alpha, [0, 1], base.alpha), flipX: key.flipX === undefined ? base.flipX : !!key.flipX,
        flipY: key.flipY === undefined ? base.flipY : !!key.flipY,
      });
    }
    base.keys = [...byTime.values()].sort((a, b) => a.time - b.time);
    out.push(base);
  }
  return out.sort((a, b) => a.time - b.time);
}

export function sampleEffectTransform(effect, time = 0) {
  const e = sanitizeEffects([effect])[0];
  if (!e) return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, flipX: false, flipY: false };
  const keys = e.keys || [];
  if (!keys.length || time <= keys[0].time) return { ...keys[0] };
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 1; i < keys.length; i++) {
    if (time <= keys[i].time) { a = keys[i - 1]; b = keys[i]; break; }
    a = keys[i];
  }
  const u = b.time === a.time ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
  const lerp = (x, y) => x + (y - x) * u;
  return {
    time, x: lerp(a.x, b.x), y: lerp(a.y, b.y), scaleX: lerp(a.scaleX, b.scaleX), scaleY: lerp(a.scaleY, b.scaleY),
    rotation: lerp(a.rotation, b.rotation), alpha: lerp(a.alpha, b.alpha),
    flipX: u < 1 ? a.flipX : b.flipX, flipY: u < 1 ? a.flipY : b.flipY,
  };
}

/** Projectile config for a ranged combat preset (imageId only; hitbox separate). */
export function sanitizeProjectile(p) {
  const r = (p && typeof p === 'object') ? p : {};
  const hbIn = (r.hitbox && typeof r.hitbox === 'object') ? r.hitbox : {};
  const shape = hbIn.shape === 'circle' ? 'circle' : 'rect';
  const hitbox = {
    shape,
    x: clampNum(hbIn.x, PROJECTILE_ENV.hbOff, 0),
    y: clampNum(hbIn.y, PROJECTILE_ENV.hbOff, 0),
    width: clampNum(hbIn.width, PROJECTILE_ENV.hbDim, 24),
    height: clampNum(hbIn.height, PROJECTILE_ENV.hbDim, 12),
    radius: clampNum(hbIn.radius, PROJECTILE_ENV.hbRadius, 8),
  };
  const dir = ['cursor', 'facing', 'angle'].includes(r.directionSource) ? r.directionSource : 'cursor';
  const rawImageId = typeof r.imageId === 'string' ? r.imageId : '';
  const imageId = PROJECTILE_IMAGES.includes(rawImageId)
    ? rawImageId
    : (rawImageId.startsWith('custom:') ? sanitizeText(rawImageId, 128) : 'arrow');
  return {
    imageId,
    directionSource: dir,
    angle: clampNum(r.angle, [-360, 360], 0),
    rotation: clampNum(r.rotation, [-180, 180], 0),
    speed: clampNum(r.speed, PROJECTILE_ENV.speed, 600),
    lifetimeMs: clampNum(r.lifetimeMs, PROJECTILE_ENV.lifetimeMs, 1200),
    pierce: !!r.pierce,
    scale: clampNum(r.scale, PROJECTILE_ENV.scale, 1),
    hitbox,
  };
}

export function sanitizeProjectileEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, ENVELOPE.maxProjectileEvents)) {
    if (!e || typeof e !== 'object') continue;
    out.push({
      time: clampNum(e.time, [0, 1], 0.5),
      projectile: sanitizeProjectile(e.projectile || e),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function sanitizeTeleportEvents(list) {
  if (!Array.isArray(list)) return [];
  const dirs = new Set(['cursor', 'facing', 'angle', 'up', 'down', 'back']);
  const out = [];
  for (const e of list.slice(0, ENVELOPE.maxTeleportEvents)) {
    if (!e || typeof e !== 'object') continue;
    out.push({
      time: clampNum(e.time, [0, 1], 0.5),
      directionSource: dirs.has(e.directionSource) ? e.directionSource : 'cursor',
      angle: clampNum(e.angle, [-360, 360], 0),
      distance: clampNum(e.distance, [0, 260], 80),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Per-preset combat stats. Range is kept only for legacy payload compatibility;
 *  authored hitboxes/projectiles define reach in the current workshop model. */
export function sanitizeCombat(c, kind = null) {
  const r = (c && typeof c === 'object') ? c : {};
  const ultimate = kind === 'ultimate';
  const status = VALID_STATUS.has(r.status) ? r.status : 'none';
  return {
    damage: Math.round(clampNum(r.damage, [0, ultimate ? 100 : 60], 18)),
    range: 0,
    cooldownMs: ultimate ? 0 : Math.round(clampNum(r.cooldownMs, ENVELOPE.cooldownMs, 600)),
    knockback: Math.round(clampNum(r.knockback, ENVELOPE.knockback, 0)),
    status,
    statusDurationMs: status === 'none' ? 0 : Math.round(clampNum(r.statusDurationMs, ENVELOPE.statusDurationMs, 0)),
    statusIntensity: status === 'none' ? 0 : Math.round(clampNum(r.statusIntensity, ENVELOPE.statusIntensity, 0.5) * 100) / 100,
    ultimateGain: Math.round(clampNum(r.ultimateGain, [10, 35], 10) / 5) * 5,
    airborneHeight: status === 'airborne' ? Math.round(clampNum(r.airborneHeight, ENVELOPE.airborneHeight, 120)) : 120,
  };
}

export function sanitizeCombatKeys(keys, fallbackCombat = null, kind = null) {
  if (!Array.isArray(keys)) return [];
  const byTime = new Map();
  for (const k of keys.slice(0, 64)) {
    if (!k || typeof k !== 'object') continue;
    const rawTime = Number.isFinite(Number(k.time)) ? Number(k.time) : Number(k.t);
    const time = Math.round(clampNum(rawTime, [0, 1], 0) * 1000) / 1000;
    const rawCombat = (k.combat && typeof k.combat === 'object') ? k.combat : k;
    byTime.set(time, sanitizeCombat({ ...(fallbackCombat || {}), ...rawCombat }, kind));
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).slice(0, 64)
    .map(([time, combat]) => ({ time, combat }));
}

export function sampleCombatKeys(keys, fallbackCombat = null, time = 0, kind = null) {
  const base = sanitizeCombat(fallbackCombat, kind);
  const list = sanitizeCombatKeys(keys, base, kind);
  if (!list.length) return base;
  const t = clampNum(time, [0, 1], 0);
  let out = list[0].combat;
  for (const k of list) {
    if (k.time <= t) out = k.combat;
    else break;
  }
  return sanitizeCombat({ ...base, ...out }, kind);
}

const sanitizeBlocksData = (b) => (b && typeof b === 'object' && Array.isArray(b.events)) ? b : null;

/** Sanitize one preset. `key` is the preset kind and drives which fields apply. */
export function sanitizePreset(raw, key) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const kind = ALL_PRESET_KINDS.has(key) ? key : 'basic';
  // Pose only (hitboxes live separately on combat presets → strip from motion).
  const motion = sanitizeMotion(r.motion, undefined, { allowGameplay: false });
  if (Object.prototype.hasOwnProperty.call(FIXED_PRESET_DURATIONS, kind)) {
    motion.duration = FIXED_PRESET_DURATIONS[kind];
  }
  const out = {
    label: PRESET_LABELS[kind] || kind,
    displayName: sanitizeText(r.displayName, 24),
    kind,
    complete: !!r.complete,
    motion,
    previewOffset: sanitizePreviewOffset(r.previewOffset),
    weaponTimeline: {
      flipXKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.flipXKeys),
      flipYKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.flipYKeys),
      leftFlipXKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.leftFlipXKeys),
      leftFlipYKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.leftFlipYKeys),
      handSwapKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.handSwapKeys)
    },
    effects: sanitizeEffects(r.effects),
    hitboxes: [],
    blocks: null,
  };
  if (isCombatKind(kind)) {
    out.combat = sanitizeCombat(r.combat, kind);
    out.combatKeys = sanitizeCombatKeys(r.combatKeys, out.combat, kind);
    out.hitboxes = clampWorkshopHitboxes(r.hitboxes);
    out.ranged = !!r.ranged;
    out.projectile = sanitizeProjectile(r.projectile);
    out.projectileEvents = sanitizeProjectileEvents(r.projectileEvents);
    out.teleportEvents = sanitizeTeleportEvents(r.teleportEvents);
    out.blocks = sanitizeBlocksData(r.blocks);
    if (kind === 'heavy') out.comboAfter = Math.round(clampNum(r.comboAfter, [1, 5], 3));
  } else if (kind === 'dash') {
    out.dashDistance = Math.round(clampNum(r.dashDistance, V2_LIMITS.dashDistance, 120));
    out.ranged = false;
    out.blocks = sanitizeBlocksData(r.blocks);
  }
  // non-combat kinds: motion + previewOffset + flip + effects only.
  return out;
}

// ── Budget (V2): body budget + per-combat-preset budget ─────────────────────
export function baseStatsCost(bs = {}) {
  const hp = Math.max(0, (Number(bs.maxHp) || 100) - 100) * 2;
  const spdSteps = Math.max(0, Math.round(((Number(bs.moveSpeed) || 1) - 1) * 100));
  return Math.round((hp + spdSteps * 2) * BUDGET_COST_MULT);
}
export function combatCost(combat, kind = null) {
  const c = combat || {};
  const isUltimate = kind === 'ultimate';
  const damage = Math.max(0, Math.min(isUltimate ? 100 : 60, Number(c.damage) || 0));
  const cooldownMs = Math.max(ENVELOPE.cooldownMs[0], Math.min(ENVELOPE.cooldownMs[1], Number(c.cooldownMs) || COOLDOWN_BUDGET_BASE_MS));
  const cooldownDelta = COOLDOWN_BUDGET_BASE_MS - cooldownMs;
  const cooldown = isUltimate ? 0 : (cooldownDelta >= 0
    ? Math.floor(cooldownDelta / COOLDOWN_BUDGET_COST_STEP_MS)
    : -Math.floor(Math.abs(cooldownDelta) / COOLDOWN_BUDGET_REFUND_STEP_MS));
  const knockback = Math.round(Math.abs((Number(c.knockback) || 60) - 60) / 5) * 2;
  const dur = Math.max(0, Number(c.statusDurationMs) || 0);
  const statusMul = c.status === 'slow' ? 1 : (c.status === 'bleed' || c.status === 'burn' ? 2 : (c.status === 'stun' ? 3 : (c.status === 'airborne' ? 4 : 0)));
  const status = Math.ceil(dur / 100) * statusMul;
  const ultimate = Math.max(0, Math.round(((Number(c.ultimateGain) || 10) - 10) / 5) * 3);
  return isUltimate
    ? Math.round(damage + (knockback + status) * BUDGET_COST_MULT)
    : Math.round((damage + knockback + status + ultimate) * BUDGET_COST_MULT + cooldown);
}
export function statCostV2(weapon) {
  const w = weapon || {};
  let cost = baseStatsCost(w.baseStats || {});
  for (const key of PRIMARY_PRESET_KEYS) {
    const p = w.presets && w.presets[key];
    if (p && isCombatKind(p.kind)) {
      cost = Math.max(cost, combatCost(p.combat, key));
      for (const ck of sanitizeCombatKeys(p.combatKeys, p.combat, key)) {
        cost = Math.max(cost, combatCost(ck.combat, key));
      }
    }
  }
  return Math.round(cost);
}

/** Safety bleed for data that arrives over budget (the editor blocks it live). */
export function enforceBudgetV2(weapon) {
  const w = weapon;
  const over = statCostV2(w) > POINT_BUDGET;
  let guard = 0;
  while ((baseStatsCost(w.baseStats) > POINT_BUDGET || statCostV2(w) > POINT_BUDGET) && guard++ < 4000) {
    if (baseStatsCost(w.baseStats) > POINT_BUDGET) {
      if (w.baseStats.moveSpeed > 1) { w.baseStats.moveSpeed = Math.round((w.baseStats.moveSpeed - 0.01) * 100) / 100; continue; }
      if (w.baseStats.maxHp > 100) { w.baseStats.maxHp -= 1; continue; }
    }
    let best = null, bestCost = -1;
    for (const key of PRIMARY_PRESET_KEYS) {
      const p = w.presets[key];
      if (!p || !isCombatKind(p.kind)) continue;
      const candidates = [{ kind: key, get combat() { return p.combat; }, set combat(v) { p.combat = v; } }];
      if (Array.isArray(p.combatKeys)) {
        for (const ck of p.combatKeys) candidates.push({ kind: key, get combat() { return ck.combat; }, set combat(v) { ck.combat = v; } });
      }
      for (const c of candidates) {
        const cost = combatCost(c.combat, c.kind);
        if (cost > POINT_BUDGET && cost > bestCost) { best = c; bestCost = cost; }
      }
    }
    if (best && best.combat.statusDurationMs > 0) { best.combat.statusDurationMs = Math.max(0, best.combat.statusDurationMs - 100); continue; }
    if (best && best.combat.ultimateGain > 10) { best.combat.ultimateGain = Math.max(10, best.combat.ultimateGain - 5); continue; }
    if (best && best.kind !== 'ultimate' && best.combat.cooldownMs < ENVELOPE.cooldownMs[1]) { best.combat.cooldownMs = Math.min(ENVELOPE.cooldownMs[1], best.combat.cooldownMs + COOLDOWN_BUDGET_REFUND_STEP_MS); continue; }
    if (best && best.combat.damage > 0) { best.combat.damage -= 1; continue; }
    if (best && best.combat.knockback !== 60) { best.combat.knockback += best.combat.knockback > 60 ? -5 : 5; continue; }
    break;
  }
  return over;
}

let _v2seq = 0;
export function makeEmptyPreset(kind) {
  return sanitizePreset({
    motion: { duration: 0.42, loop: NONCOMBAT_PRESET_KINDS.has(kind), keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }], events: isCombatKind(kind) ? [{ t: 0.5, type: 'impact' }] : [] },
  }, kind);
}
export function makeEmptyWeaponV2({ name = '새 무기', desc = '', category = 'melee', firstPresetKind = 'basic' } = {}) {
  const cat = WEAPON_CATEGORIES.has(category) ? category : 'melee';
  const firstKind = ALL_PRESET_KINDS.has(firstPresetKind) ? firstPresetKind : 'basic';
  const presets = Object.fromEntries(AUTHORING_PRESET_KEYS.map(k => [k, makeEmptyPreset(k)]));
  return clampWorkshopWeaponV2({
    schemaVersion: 2,
    id: 'w2_' + Date.now().toString(36) + '_' + (_v2seq++),
    name, desc, category: cat,
    baseStats: { maxHp: 100, moveSpeed: 1 },
    presets,
    equippedPresetKey: firstKind,
  });
}

/** Full double-clamp for a V2 weapon. Never throws; garbage → safe defaults. */
export function clampWorkshopWeaponV2(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const category = WEAPON_CATEGORIES.has(r.category) ? r.category : 'melee';
  const bs0 = (r.baseStats && typeof r.baseStats === 'object') ? r.baseStats : {};
  const baseStats = {
    maxHp: Math.round(clampNum(bs0.maxHp, ENVELOPE.maxHp, 100)),
    moveSpeed: Math.round(clampNum(bs0.moveSpeed, ENVELOPE.moveSpeed, 1) * 100) / 100,
  };
  const vv = (r.weaponVisual && typeof r.weaponVisual === 'object') ? r.weaponVisual : {};
  const sanitizeAnchors = (a) => {
    if (!a || typeof a !== 'object') return null;
    const gx = clampNum(a.gx, [0, 1], 0.15);
    const gy = clampNum(a.gy, [0, 1], 0.5);
    const tx = clampNum(a.tx, [0, 1], 0.95);
    const ty = clampNum(a.ty, [0, 1], 0.5);
    return Math.hypot(tx - gx, ty - gy) < 0.02 ? null : { gx, gy, tx, ty };
  };
  const sanitizeDecorationAnchors = (a) => {
    if (!a || typeof a !== 'object') return null;
    const gx = clampNum(a.gx, [0, 1], 0.5);
    const gy = clampNum(a.gy, [0, 1], 0.5);
    const tx = clampNum(a.tx, [0, 1], 0.85);
    const ty = clampNum(a.ty, [0, 1], 0.5);
    return Math.hypot(tx - gx, ty - gy) < 0.02 ? { gx, gy, tx: 0.85, ty: 0.5 } : { gx, gy, tx, ty };
  };
  const sanitizeHat = (h) => (h && typeof h === 'object') ? {
    imageId: h.imageId ? sanitizeText(h.imageId, 128) : null,
    name: h.name ? sanitizeText(h.name, 24) : null,
    scale: clampNum(h.scale, [0.2, 4], 1),
    offsetX: clampNum(h.offsetX, [-120, 120], 0),
    offsetY: clampNum(h.offsetY, [-120, 120], -18),
    alpha: clampNum(h.alpha, [0, 1], 1),
    rotation: clampNum(h.rotation, [-180, 180], 0),
    anchorX: clampNum(h.anchorX, [0, 1], 0.5),
    anchorY: clampNum(h.anchorY, [0, 1], 0.5),
    anchors: sanitizeDecorationAnchors(h.anchors),
    layer: ['behindPlayer', 'overPlayer', 'overWeapon'].includes(h.layer) ? h.layer : 'overPlayer',
    showHandles: h.showHandles !== false,
    followHead: !!h.followHead,
    keys: Array.isArray(h.keys) ? h.keys.slice(0, 64).map(k => ({
      t: clampNum(k && k.t, [0, 1], 0),
      offsetX: clampNum(k && k.offsetX, [-120, 120], 0),
      offsetY: clampNum(k && k.offsetY, [-120, 120], -18),
      rotation: clampNum(k && k.rotation, [-180, 180], 0),
      scale: clampNum(k && k.scale, [0.2, 4], 1),
      alpha: clampNum(k && k.alpha, [0, 1], 1),
    })).sort((a, b) => a.t - b.t) : [],
  } : null;
  const hats = (Array.isArray(vv.hats) && vv.hats.length ? vv.hats : (vv.hat ? [vv.hat] : []))
    .map(sanitizeHat)
    .filter(Boolean)
    .slice(0, 5);
  const sanitizeLayerOrder = (raw) => {
    const dual = !!vv.dual;
    const weapons = dual ? ['weapon:left', 'weapon:right'] : ['weapon'];
    const allowed = new Set(['player', ...weapons, ...hats.map((_, i) => `hat:${i}`)]);
    const out = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const key = sanitizeText(item, 16);
        if (dual && key === 'weapon') {
          for (const w of weapons) if (!out.includes(w)) out.push(w);
          continue;
        }
        if (!dual && (key === 'weapon:left' || key === 'weapon:right')) {
          if (!out.includes('weapon')) out.push('weapon');
          continue;
        }
        if (allowed.has(key) && !out.includes(key)) out.push(key);
      }
    }
    for (const item of ['player', ...weapons, ...hats.map((_, i) => `hat:${i}`)]) {
      if (!out.includes(item)) out.push(item);
    }
    return out;
  };
  const weaponVisual = {
    imageId: vv.imageId ? sanitizeText(vv.imageId, 128) : null,
    scale: clampNum(vv.scale, [0.3, 4.5], 1),
    rotationOffset: clampNum(vv.rotationOffset, [-360, 360], 0),
    offsetX: clampNum(vv.offsetX, [-120, 120], 0),
    offsetY: clampNum(vv.offsetY, [-120, 120], 0),
    dual: !!vv.dual,   // 쌍수(양손) — draws a second off-hand weapon
    offhand: vv.offhand && typeof vv.offhand === 'object' ? {
      imageId: vv.offhand.imageId ? sanitizeText(vv.offhand.imageId, 128) : null,
      scale: clampNum(vv.offhand.scale, [0.3, 4.5], 1),
      rotationOffset: clampNum(vv.offhand.rotationOffset, [-360, 360], 0),
      offsetX: clampNum(vv.offhand.offsetX, [-120, 120], 0),
      offsetY: clampNum(vv.offhand.offsetY, [-120, 120], 0),
      anchors: sanitizeAnchors(vv.offhand.anchors),
    } : null,
    hat: hats[0] || null,
    hats,
    selectedHat: clampNum(vv.selectedHat, [0, Math.max(0, hats.length - 1)], 0),
    layerOrder: sanitizeLayerOrder(vv.layerOrder),
  };
  const rawPresets = (r.presets && typeof r.presets === 'object') ? r.presets : {};
  const presets = {};
  for (const key of Object.keys(rawPresets)) {
    if (!ALL_PRESET_KINDS.has(key)) continue;   // drop unknown slots
    presets[key] = sanitizePreset(rawPresets[key], key);
  }
  for (const key of AUTHORING_PRESET_KEYS) {
    if (!presets[key]) presets[key] = makeEmptyPreset(key);
  }
  let equippedPresetKey = presets[r.equippedPresetKey] ? r.equippedPresetKey : Object.keys(presets)[0];

  const out = {
    schemaVersion: 2,
    id: r.id ? sanitizeText(r.id, 128) : ('w2_' + Date.now().toString(36) + '_' + (_v2seq++)),
    name: sanitizeText(r.name, 24) || '이름없는 무기',
    desc: sanitizeText(r.desc, 80),
    color: (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) ? r.color : null,
    category, weaponVisual, baseStats, presets, equippedPresetKey, tier: 'workshop',
  };
  enforceBudgetV2(out);
  return out;
}

/** Migrate a V1 workshop weapon ({stats, motionSet, blocks}) into a V2 weapon. */
export function migrateV1toV2(v1) {
  const r = (v1 && typeof v1 === 'object') ? v1 : {};
  const s = clampWorkshopStats(r.stats);
  const set = (r.motionSet && typeof r.motionSet === 'object') ? r.motionSet : {};
  const presets = {};
  // basic ← attack motion + V1 combat stats + V1 blocks + attack hitboxes.
  const basicMotion = set.attack || null;
  presets.basic = sanitizePreset({
    motion: basicMotion,
    combat: { damage: s.damage, range: s.range, cooldownMs: s.cooldownMs, knockback: s.knockback, status: s.status, statusDurationMs: s.statusDurationMs, statusIntensity: s.statusIntensity },
    hitboxes: (basicMotion && Array.isArray(basicMotion.hitboxes)) ? basicMotion.hitboxes : [],
    blocks: r.blocks || null,
    ranged: false,
  }, 'basic');
  if (set.dash) presets.dash = sanitizePreset({ motion: set.dash }, 'dash');
  if (set.skill) presets.skill1 = sanitizePreset({ motion: set.skill }, 'skill1');
  // Non-attack cosmetic motions carry over (hitboxes already stripped by kind).
  for (const k of NONCOMBAT_PRESET_KINDS) if (set[k]) presets[k] = sanitizePreset({ motion: set[k] }, k);

  return clampWorkshopWeaponV2({
    schemaVersion: 2,
    id: r.id || undefined,
    name: r.name, desc: r.desc, color: r.color,
    category: 'melee',
    baseStats: { maxHp: s.maxHp, moveSpeed: s.moveSpeed },
    presets,
    equippedPresetKey: 'basic',
  });
}

/** Accept any workshop blob (V1 or V2) → a clamped V2 weapon. */
export function toWorkshopWeaponV2(raw) {
  if (raw && typeof raw === 'object' && raw.schemaVersion === 2) return clampWorkshopWeaponV2(raw);
  return migrateV1toV2(raw);
}
