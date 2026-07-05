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
  maxHitboxes:     2,
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

/** Clamp a list of hitboxes to the (tighter) workshop geometry caps. */
function clampWorkshopHitboxes(hitboxes) {
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
  const MOTION_STATES = ['attack', 'run', 'idle', 'jump', 'dash', 'skill', 'hurt', 'kill'];
  const rawSet = (r.motionSet && typeof r.motionSet === 'object') ? r.motionSet : {};
  const motionSet = {};
  for (const state of MOTION_STATES) {
    if (!rawSet[state]) continue;
    const m = sanitizeMotion(rawSet[state], undefined, { allowGameplay: true });
    // Only the attack slot may carry hitboxes; the rest are pure cosmetics.
    if (state === 'attack') { if (Array.isArray(m.hitboxes)) m.hitboxes = clampWorkshopHitboxes(m.hitboxes); }
    else delete m.hitboxes;
    motionSet[state] = m;
  }

  // Block-gimmick AST rides along as pure data; the BlockVM sanitizes + clamps it
  // when it is constructed (host-side), so we only pass a bounded object here.
  const blocks = (r.blocks && typeof r.blocks === 'object' && Array.isArray(r.blocks.events)) ? r.blocks : null;

  return { name, desc, color, stats, motionSet, blocks, tier: 'workshop' };
}
