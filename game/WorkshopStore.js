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
} from './Workshop.js';

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

/** Import a browsed/published weapon (V1 or V2) into the local armory. */
export function importWorkshopWeapon(raw) {
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
  if (basic) motionSet.attack = { ...basic.motion, hitboxes: basic.hitboxes || [] };
  if (w.presets.dash) motionSet.dash = w.presets.dash.motion;
  for (const k of NONCOMBAT_PRESET_KINDS) if (w.presets[k]) motionSet[k] = w.presets[k].motion;
  const c = basic ? basic.combat : {};
  const stats = {
    maxHp: w.baseStats.maxHp, moveSpeed: w.baseStats.moveSpeed,
    damage: c.damage, cooldownMs: c.cooldownMs, range: c.range, knockback: c.knockback,
    status: c.status, statusDurationMs: c.statusDurationMs, statusIntensity: c.statusIntensity,
  };
  const rt = clampWorkshopWeapon({ name: w.name, color: w.color, stats, motionSet, blocks: basic ? basic.blocks : null });
  // Carry the (small, id-only) custom weapon image for the in-game renderer.
  if (w.weaponVisual && w.weaponVisual.imageId) rt.weaponVisual = { imageId: w.weaponVisual.imageId, scale: w.weaponVisual.scale || 1 };
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
