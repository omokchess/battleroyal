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
  cooldownMs:      [250, 2500],    // floor 250ms — no machine-gun
  range:           [30, 300],
  projectileSpeed: [180, 1200],
  knockback:       [0, 200],
  statusDurationMs:[0, 3000],
  statusIntensity: [0, 1],
  // Per-hitbox geometry (tighter than the admin canonical caps).
  hitboxDimMax:    160,            // each of w/h
  hitboxAreaMax:   14000,          // w*h px²
  activeLenMax:    0.4,            // active-window length (normalized motion time)
  maxHitboxes:     8,
  maxProjectileEvents: 5,
  maxTeleportEvents: 5,
};

export const VALID_STATUS = new Set(['none', 'slow', 'bleed', 'burn', 'stun']);
export const POINT_BUDGET = 100;

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
    out.push({ ox: clampNum(hb.ox, [-220, 220], 0), oy: clampNum(hb.oy, [-220, 220], 0), w, h, activeStart: aS, activeEnd: aE });
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
  const MOTION_STATES = ['attack', 'run', 'idle', 'jump', 'dash', 'skill', 'skill2', 'skill3', 'heavy', 'hurt', 'kill'];
  const rawSet = (r.motionSet && typeof r.motionSet === 'object') ? r.motionSet : {};
  const motionSet = {};
  for (const state of MOTION_STATES) {
    if (!rawSet[state]) continue;
    const m = sanitizeMotion(rawSet[state], undefined, { allowGameplay: true });
    // Attack/heavy/skill1-3 carry real hitboxes (they drive combat); rest cosmetic.
    if (['attack', 'heavy', 'skill', 'skill2', 'skill3'].includes(state)) { if (Array.isArray(m.hitboxes)) m.hitboxes = clampWorkshopHitboxes(m.hitboxes); }
    else delete m.hitboxes;
    // Preserve the weapon flip timeline (sanitizeMotion drops it) — cosmetic.
    if (Array.isArray(rawSet[state].flipXKeys)) m.flipXKeys = sanitizeFlipKeys(rawSet[state].flipXKeys);
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
// The six primary preset slots + absorbed non-attack (cosmetic) motion slots.
export const COMBAT_PRESET_KINDS = new Set(['basic', 'heavy', 'skill1', 'skill2', 'skill3']);
export const NONCOMBAT_PRESET_KINDS = new Set(['idle', 'run', 'jump', 'hurt', 'kill']);
export const ALL_PRESET_KINDS = new Set(['basic', 'heavy', 'dash', 'skill1', 'skill2', 'skill3', ...NONCOMBAT_PRESET_KINDS]);
export const PRIMARY_PRESET_KEYS = ['basic', 'heavy', 'dash', 'skill1', 'skill2', 'skill3'];
export const PRESET_LABELS = {
  basic: '평타', heavy: '강공격', dash: '대시', skill1: '스킬 1', skill2: '스킬 2', skill3: '스킬 3',
  idle: '대기', run: '걷기', jump: '점프', hurt: '피격', kill: '처치',
};
// Which in-game input fires each combat/dash preset (cooldown = preset.combat).
// heavy = the 3rd hit of a basic-attack combo (평타 3연타), not a dedicated key.
export const PRESET_INPUT = { basic: 'lmb', heavy: 'combo3', skill1: 'skillF', skill2: 'skillE', skill3: 'skillR', dash: 'dash' };
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

/** Cosmetic frame effects. assetId is a registered FX id; no binary data.
 *  Time is NORMALIZED (0..1) — shared axis with motion/flip keyframes. */
export function sanitizeEffects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, V2_LIMITS.maxEffects)) {
    if (!e || typeof e !== 'object') continue;
    out.push({
      time: clampNum(e.time, [0, 1], 0),
      assetId: sanitizeText(e.assetId, 32) || 'spark',
      x: clampNum(e.x, [-200, 200], 0), y: clampNum(e.y, [-200, 200], 0),
      scale: clampNum(e.scale, [0.1, 4], 1),
      rotation: clampNum(e.rotation, [-360, 360], 0),
      alpha: clampNum(e.alpha, [0, 1], 1),
      followBone: FOLLOW_BONES.has(e.followBone) ? e.followBone : null,
    });
  }
  return out.sort((a, b) => a.time - b.time);
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

/** Per-preset combat stats (cooldown kept but excluded from the budget). */
export function sanitizeCombat(c) {
  const r = (c && typeof c === 'object') ? c : {};
  const status = VALID_STATUS.has(r.status) ? r.status : 'none';
  return {
    damage: Math.round(clampNum(r.damage, ENVELOPE.damage, 18)),
    range: Math.round(clampNum(r.range, ENVELOPE.range, 70)),
    cooldownMs: Math.round(clampNum(r.cooldownMs, ENVELOPE.cooldownMs, 600)),
    knockback: Math.round(clampNum(r.knockback, ENVELOPE.knockback, 0)),
    status,
    statusDurationMs: status === 'none' ? 0 : Math.round(clampNum(r.statusDurationMs, ENVELOPE.statusDurationMs, 0)),
    statusIntensity: status === 'none' ? 0 : Math.round(clampNum(r.statusIntensity, ENVELOPE.statusIntensity, 0.5) * 100) / 100,
  };
}

const sanitizeBlocksData = (b) => (b && typeof b === 'object' && Array.isArray(b.events)) ? b : null;

/** Sanitize one preset. `key` is the preset kind and drives which fields apply. */
export function sanitizePreset(raw, key) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const kind = ALL_PRESET_KINDS.has(key) ? key : 'basic';
  // Pose only (hitboxes live separately on combat presets → strip from motion).
  const motion = sanitizeMotion(r.motion, undefined, { allowGameplay: false });
  const out = {
    label: PRESET_LABELS[kind] || kind,
    kind,
    motion,
    previewOffset: sanitizePreviewOffset(r.previewOffset),
    weaponTimeline: { flipXKeys: sanitizeFlipKeys(r.weaponTimeline && r.weaponTimeline.flipXKeys) },
    effects: sanitizeEffects(r.effects),
    hitboxes: [],
    blocks: null,
  };
  if (isCombatKind(kind)) {
    out.combat = sanitizeCombat(r.combat);
    out.hitboxes = clampWorkshopHitboxes(r.hitboxes);
    out.ranged = !!r.ranged;
    out.projectile = sanitizeProjectile(r.projectile);
    out.projectileEvents = sanitizeProjectileEvents(r.projectileEvents);
    out.teleportEvents = sanitizeTeleportEvents(r.teleportEvents);
    out.blocks = sanitizeBlocksData(r.blocks);
  } else if (kind === 'dash') {
    out.dashDistance = Math.round(clampNum(r.dashDistance, V2_LIMITS.dashDistance, 120));
    out.ranged = false;
    out.blocks = sanitizeBlocksData(r.blocks);
  }
  // non-combat kinds: motion + previewOffset + flip + effects only.
  return out;
}

// ── Budget (V2): body + every combat preset's combat, cooldown EXCLUDED ──────
function baseStatsCost(bs) {
  const hp = norm(bs.maxHp, ENVELOPE.maxHp), spd = norm(bs.moveSpeed, ENVELOPE.moveSpeed);
  return 14 * hp + 10 * spd;
}
export function combatCost(combat) {
  const c = combat || {};
  const dmg = norm(c.damage, ENVELOPE.damage);
  const range = norm(c.range, ENVELOPE.range);
  const kb = norm(c.knockback, ENVELOPE.knockback);
  const status = c.status && c.status !== 'none' ? (0.5 + 0.5 * norm(c.statusDurationMs, ENVELOPE.statusDurationMs)) : 0;
  return 18 * dmg + 6 * range + 3 * kb + 7 * status;   // NO cooldown
}
export function statCostV2(weapon) {
  const w = weapon || {};
  let cost = baseStatsCost(w.baseStats || {});
  for (const key of PRIMARY_PRESET_KEYS) {
    const p = w.presets && w.presets[key];
    if (p && isCombatKind(p.kind)) cost += combatCost(p.combat);
  }
  return Math.round(cost);
}

/** Safety bleed for data that arrives over budget (the editor blocks it live). */
export function enforceBudgetV2(weapon) {
  const w = weapon;
  const over = statCostV2(w) > POINT_BUDGET;
  let guard = 0;
  // Bleed damage across combat presets (highest first), then body hp/move.
  while (statCostV2(w) > POINT_BUDGET && guard++ < 4000) {
    let best = null, bestDmg = -1;
    for (const key of PRIMARY_PRESET_KEYS) {
      const p = w.presets[key];
      if (p && isCombatKind(p.kind) && p.combat.damage > ENVELOPE.damage[0] && p.combat.damage > bestDmg) { best = p; bestDmg = p.combat.damage; }
    }
    if (best) { best.combat.damage -= 1; continue; }
    if (w.baseStats.moveSpeed > ENVELOPE.moveSpeed[0]) { w.baseStats.moveSpeed = Math.round((w.baseStats.moveSpeed - 0.01) * 100) / 100; continue; }
    if (w.baseStats.maxHp > ENVELOPE.maxHp[0]) { w.baseStats.maxHp -= 1; continue; }
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
  const presets = { [firstKind]: makeEmptyPreset(firstKind) };
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
  const weaponVisual = {
    imageId: vv.imageId ? sanitizeText(vv.imageId, 128) : null,
    scale: clampNum(vv.scale, [0.3, 4.5], 1),
    rotationOffset: clampNum(vv.rotationOffset, [-360, 360], 0),
    offsetX: clampNum(vv.offsetX, [-120, 120], 0),
    offsetY: clampNum(vv.offsetY, [-120, 120], 0),
    dual: !!vv.dual,   // 쌍수(양손) — draws a second off-hand weapon
  };
  const rawPresets = (r.presets && typeof r.presets === 'object') ? r.presets : {};
  const presets = {};
  for (const key of Object.keys(rawPresets)) {
    if (!ALL_PRESET_KINDS.has(key)) continue;   // drop unknown slots
    presets[key] = sanitizePreset(rawPresets[key], key);
  }
  if (!Object.keys(presets).length) presets.basic = makeEmptyPreset('basic');
  let equippedPresetKey = presets[r.equippedPresetKey] ? r.equippedPresetKey : Object.keys(presets)[0];

  const out = {
    schemaVersion: 2,
    id: r.id ? sanitizeText(r.id, 48) : ('w2_' + Date.now().toString(36) + '_' + (_v2seq++)),
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
