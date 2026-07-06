/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local workshop weapon storage (V2) + save/equip/upload separation.
 *
 *  - 저장 + 장착 (Save + Equip): local only — upsert into the device store + set
 *    the equipped id. NEVER publishes to Firebase.
 *  - 업로드 (Upload): the ONLY path that publishes; the caller (MotionEditor)
 *    wires it to accountUI.publishMyWorkshopWeapon. A save failure blocks upload;
 *    an upload failure never rolls back the local save. Offline still saves.
 *
 * The GAME still consumes the legacy V1 runtime shape ({stats, motionSet, blocks});
 * `equippedWorkshopWeapon()` derives that from the equipped V2 weapon's `basic`
 * preset so nothing in Game/Player/Motion needs to change yet (full multi-preset
 * runtime is a later task).
 */

import {
  clampWorkshopWeaponV2, toWorkshopWeaponV2, clampWorkshopWeapon,
  PRIMARY_PRESET_KEYS, COMBAT_PRESET_KINDS, NONCOMBAT_PRESET_KINDS,
  sanitizeCombat, clampWorkshopHitboxes,
} from './Workshop.js';
import { saveCustomWeaponRecord } from './WeaponImages.js';

const WS_STORE = 'pixelroyale_workshop_weapons_v2';        // { id: WorkshopWeaponV2 }
const WS_EQUIP = 'pixelroyale_equipped_workshop_weapon_v2';// equipped weapon id
const LEGACY_WS = 'pixelroyale_workshop_equipped_v1';      // old single V1 def

function _readMap() {
  try { const m = JSON.parse(localStorage.getItem(WS_STORE) || '{}'); return (m && typeof m === 'object') ? m : {}; }
  catch { return {}; }
}
function _writeMap(map) { try { localStorage.setItem(WS_STORE, JSON.stringify(map)); } catch {} }

/** One-time: fold a legacy V1 equipped weapon into the V2 store as equipped. */
function _absorbLegacy(map) {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LEGACY_WS) || 'null'); } catch {}
  if (!raw) return false;
  const w = toWorkshopWeaponV2(raw);
  map[w.id] = w; _writeMap(map);
  try { localStorage.setItem(WS_EQUIP, w.id); } catch {}
  try { localStorage.removeItem(LEGACY_WS); } catch {}
  return true;
}

/** All locally saved workshop weapons (V2), re-clamped defensively. */
export function loadWorkshopWeaponsV2() {
  const map = _readMap();
  if (!Object.keys(map).length) _absorbLegacy(map);
  return Object.values(_readMap()).map(clampWorkshopWeaponV2);
}

export function getWorkshopWeaponV2(id) {
  const w = _readMap()[id];
  return w ? clampWorkshopWeaponV2(w) : null;
}

/** 저장 + 장착의 저장 절반: upsert into the local store (no publish). */
export function saveWorkshopWeaponLocal(raw) {
  const w = clampWorkshopWeaponV2(raw);
  const map = _readMap();
  map[w.id] = w; _writeMap(map);
  return w;
}

export function deleteWorkshopWeaponLocal(id) {
  const map = _readMap();
  if (map[id]) { delete map[id]; _writeMap(map); }
  if (equippedWorkshopWeaponId() === id) unequipWorkshopWeapon();
}

/** Import a browsed/published weapon (V1 or V2) into the local armory. When the
 *  published doc carried the author's custom weapon pixels (weaponImage), fold
 *  them into THIS device's image store so the recipient sees the image too — not
 *  just the default stick. */
export function importWorkshopWeapon(raw) {
  const imgId = raw && raw.weaponVisual && raw.weaponVisual.imageId;
  if (raw && raw.weaponImage && imgId && String(imgId).startsWith('custom:')) {
    saveCustomWeaponRecord({ ...raw.weaponImage, id: imgId });
  }
  return saveWorkshopWeaponLocal(toWorkshopWeaponV2(raw));
}

// ── equip ──────────────────────────────────────────────────────────────────
export function equipWorkshopWeaponLocal(id) {
  if (!_readMap()[id]) return false;
  try { localStorage.setItem(WS_EQUIP, id); } catch {}
  return true;
}
export function equippedWorkshopWeaponId() {
  try { return localStorage.getItem(WS_EQUIP) || null; } catch { return null; }
}
export function unequipWorkshopWeapon() {
  try { localStorage.removeItem(WS_EQUIP); } catch {}
}
/** The equipped weapon as a V2 object (or null). */
export function equippedWorkshopWeaponV2() {
  const map = _readMap();
  if (!Object.keys(map).length) { if (_absorbLegacy(map)) { /* re-read */ } }
  const id = equippedWorkshopWeaponId();
  const w = id && _readMap()[id];
  return w ? clampWorkshopWeaponV2(w) : null;
}

// ── V2 → legacy V1 runtime adapter (keeps Game/Player/Motion unchanged) ──────
function firstCombatPreset(w) {
  for (const k of PRIMARY_PRESET_KEYS) { const p = w.presets[k]; if (p && COMBAT_PRESET_KINDS.has(p.kind)) return p; }
  return null;
}
/** Build the legacy `{name,color,stats,motionSet,blocks}` the sim consumes from a
 *  V2 weapon (basic preset = the primary swing). Re-clamped through V1 path. */
export function v2ToV1Runtime(w) {
  if (!w) return null;
  const basic = w.presets.basic && COMBAT_PRESET_KINDS.has(w.presets.basic.kind) ? w.presets.basic : firstCombatPreset(w);
  const motionSet = {};
  // Attach each preset's flip timeline onto its runtime motion so the in-game
  // renderer can flip the weapon exactly like the editor preview does.
  const withTimelineEvents = (p) => ({
    ...p.motion,
    flipXKeys: (p.weaponTimeline && p.weaponTimeline.flipXKeys) || [],
    projectileEvents: p.projectileEvents || [],
    teleportEvents: p.teleportEvents || [],
  });
  const withFlip = (p) => withTimelineEvents(p);
  if (basic) motionSet.attack = { ...withTimelineEvents(basic), hitboxes: basic.hitboxes || [] };
  if (w.presets.dash) motionSet.dash = withFlip(w.presets.dash);
  for (const k of NONCOMBAT_PRESET_KINDS) if (w.presets[k]) motionSet[k] = withFlip(w.presets[k]);
  // Combat skill preset motions → the runtime slots the animator plays via synced
  // stick_motion triggers (skill1=F->'skill', skill2=E->'skill2', skill3=R->'skill3').
  // Each also keeps its OWN hitboxes (like heavy) so the actual ability can fire,
  // not just the cosmetic pose.
  const SKILL_MOTION_SLOT = { skill1: 'skill', skill2: 'skill2', skill3: 'skill3' };
  for (const k of Object.keys(SKILL_MOTION_SLOT)) {
    if (!w.presets[k]) continue;
    const sp = w.presets[k];
    motionSet[SKILL_MOTION_SLOT[k]] = { ...withFlip(sp), hitboxes: sp.hitboxes || [] };
  }
  // Heavy (평타 3연타 finisher) keeps its OWN hitboxes for the 3rd-hit swing.
  if (w.presets.heavy) motionSet.heavy = { ...withTimelineEvents(w.presets.heavy), hitboxes: w.presets.heavy.hitboxes || [] };
  const c = basic ? basic.combat : {};
  const stats = {
    maxHp: w.baseStats.maxHp, moveSpeed: w.baseStats.moveSpeed,
    damage: c.damage, cooldownMs: c.cooldownMs, range: c.range, knockback: c.knockback,
    status: c.status, statusDurationMs: c.statusDurationMs, statusIntensity: c.statusIntensity,
  };
  const rt = clampWorkshopWeapon({ name: w.name, color: w.color, stats, motionSet, blocks: basic ? basic.blocks : null });
  // Carry the (small, id-only) custom weapon image for the in-game renderer.
  if (w.weaponVisual && (w.weaponVisual.imageId || w.weaponVisual.dual)) {
    rt.weaponVisual = {
      imageId: w.weaponVisual.imageId || null,
      scale: w.weaponVisual.scale || 1,
      rotationOffset: w.weaponVisual.rotationOffset || 0,
      offsetX: w.weaponVisual.offsetX || 0,
      offsetY: w.weaponVisual.offsetY || 0,
      dual: !!w.weaponVisual.dual
    };
  }
  // The primary (basic) preset's ranged/projectile config drives the basic attack.
  if (basic && basic.ranged && basic.projectile) { rt.ranged = true; rt.projectile = basic.projectile; }
  // Heavy (3rd-hit finisher) + skill1/2/3 each carry their OWN combat stats
  // (damage/cooldown/knockback/status) + hitboxes/ranged-projectile so the game
  // can actually EXECUTE the authored ability, not just play its motion.
  // clampWorkshopWeapon (V1) only knows the legacy shape, so re-clamp + attach
  // these after it (mirrors ranged/weaponVisual above).
  const presetCombat = {};
  const presetHitboxes = {};
  const presetRanged = {};
  const abilitySlots = { heavy: 'heavy', ...SKILL_MOTION_SLOT };
  for (const presetKey of Object.keys(abilitySlots)) {
    const sp = w.presets[presetKey];
    if (!sp || !sp.combat) continue;
    const slot = abilitySlots[presetKey];
    presetCombat[slot] = sanitizeCombat(sp.combat);              // re-clamp defensively
    presetHitboxes[slot] = clampWorkshopHitboxes(sp.hitboxes);   // re-clamp defensively
    if (sp.ranged && sp.projectile) presetRanged[slot] = sp.projectile;
  }
  if (Object.keys(presetCombat).length) rt.presetCombat = presetCombat;
  if (Object.keys(presetHitboxes).length) rt.presetHitboxes = presetHitboxes;
  if (Object.keys(presetRanged).length) rt.presetRanged = presetRanged;
  rt.id = w.id || rt.id || null;
  return rt;
}

// ── Legacy-named compat exports (consumed by main.js / localAppearance) ──────
/** The equipped workshop weapon in the game's V1 runtime shape (or null). */
export function equippedWorkshopWeapon() {
  return v2ToV1Runtime(equippedWorkshopWeaponV2());
}
export function equippedWorkshopWeaponName() {
  const w = equippedWorkshopWeaponV2();
  return w ? w.name : null;
}
/** Compat equip: accept a V1 or V2 blob, save + equip locally. */
export function equipWorkshopWeapon(def) {
  const w = saveWorkshopWeaponLocal(toWorkshopWeaponV2(def));
  equipWorkshopWeaponLocal(w.id);
  return w;
}
export function clearWorkshopWeapon() { unequipWorkshopWeapon(); }
