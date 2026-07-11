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
  sanitizeCombat, sanitizeCombatKeys, clampWorkshopHitboxes,
} from './Workshop.js';
import { saveCustomWeaponRecord } from './WeaponImages.js';

const WS_STORE = 'pixelroyale_workshop_weapons_v2';        // { id: WorkshopWeaponV2 }
const WS_EQUIP = 'pixelroyale_equipped_workshop_weapon_v2';// equipped weapon id
const LEGACY_WS = 'pixelroyale_workshop_equipped_v1';      // old single V1 def

function _readMap() {
  try { const m = JSON.parse(localStorage.getItem(WS_STORE) || '{}'); return (m && typeof m === 'object') ? m : {}; }
  catch { return {}; }
}
function _writeMap(map) {
  try {
    localStorage.setItem(WS_STORE, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
function _emitStoreChanged(action, weapon = null) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try { window.dispatchEvent(new CustomEvent('pixelroyale:workshop-store-changed', { detail: { action, weapon } })); } catch {}
}

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
  map[w.id] = w;
  if (!_writeMap(map) || !_readMap()[w.id]) {
    throw new Error('무기 저장공간이 부족하거나 로컬 저장에 실패했습니다');
  }
  _emitStoreChanged('save', w);
  return w;
}

export function deleteWorkshopWeaponLocal(id) {
  const map = _readMap();
  if (map[id]) { const old = map[id]; delete map[id]; _writeMap(map); _emitStoreChanged('delete', old); }
  if (equippedWorkshopWeaponId() === id) unequipWorkshopWeapon();
}

/** Import a browsed/published weapon (V1 or V2) into the local armory. When the
 *  published doc carried the author's custom weapon pixels (weaponImage), fold
 *  them into THIS device's image store so the recipient sees the image too — not
 *  just the default stick. */
export function importWorkshopWeapon(raw) {
  const savedImages = new Set();
  const saveImageOnce = (img, idOverride = null) => {
    const id = idOverride || img?.id;
    if (!img || !id || !String(id).startsWith('custom:') || savedImages.has(id)) return;
    if (saveCustomWeaponRecord({ ...img, id })) savedImages.add(id);
  };
  const imgId = raw && raw.weaponVisual && raw.weaponVisual.imageId;
  if (raw && raw.weaponImage && imgId && String(imgId).startsWith('custom:')) {
    saveImageOnce(raw.weaponImage, imgId);
  }
  const offhandId = raw && raw.weaponVisual && raw.weaponVisual.offhand && raw.weaponVisual.offhand.imageId;
  if (raw && raw.offhandImage && offhandId && String(offhandId).startsWith('custom:')) {
    saveImageOnce(raw.offhandImage, offhandId);
  }
  const hatId = raw && raw.weaponVisual && raw.weaponVisual.hat && raw.weaponVisual.hat.imageId;
  if (raw && raw.hatImage && hatId && String(hatId).startsWith('custom:')) {
    saveImageOnce(raw.hatImage, hatId);
  }
  const hats = raw && raw.weaponVisual && Array.isArray(raw.weaponVisual.hats) ? raw.weaponVisual.hats : [];
  if (raw && Array.isArray(raw.hatImages)) {
    const ids = new Set(hats.map(h => h && h.imageId).filter(id => id && String(id).startsWith('custom:')));
    for (const img of raw.hatImages.slice(0, 5)) {
      if (img && (!ids.size || ids.has(img.id))) saveImageOnce(img, img.id);
    }
  }
  if (raw && Array.isArray(raw.effectImages)) {
    const ids = new Set();
    const presets = raw.presets && typeof raw.presets === 'object' ? raw.presets : {};
    for (const preset of Object.values(presets)) {
      for (const fx of (Array.isArray(preset?.effects) ? preset.effects : [])) {
        if (fx?.assetId && String(fx.assetId).startsWith('custom:fx_')) ids.add(fx.assetId);
      }
    }
    for (const img of raw.effectImages.slice(0, 24)) {
      if (img && (!ids.size || ids.has(img.id))) saveImageOnce(img, img.id);
    }
  }
  const saved = saveWorkshopWeaponLocal(toWorkshopWeaponV2(raw));
  _emitStoreChanged('import', saved);
  return saved;
}

// ── equip ──────────────────────────────────────────────────────────────────
export function equipWorkshopWeaponLocal(id) {
  if (!_readMap()[id]) return false;
  try { localStorage.setItem(WS_EQUIP, id); } catch {}
  _emitStoreChanged('equip', _readMap()[id] || null);
  return true;
}
export function equippedWorkshopWeaponId() {
  try { return localStorage.getItem(WS_EQUIP) || null; } catch { return null; }
}
export function unequipWorkshopWeapon() {
  try { localStorage.removeItem(WS_EQUIP); } catch {}
  _emitStoreChanged('unequip', null);
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
    previewOffset: p.previewOffset || null,
    flipXKeys: (p.weaponTimeline && p.weaponTimeline.flipXKeys) || [],
    flipYKeys: (p.weaponTimeline && p.weaponTimeline.flipYKeys) || [],
    leftFlipXKeys: (p.weaponTimeline && p.weaponTimeline.leftFlipXKeys) || [],
    leftFlipYKeys: (p.weaponTimeline && p.weaponTimeline.leftFlipYKeys) || [],
    handSwapKeys: (p.weaponTimeline && p.weaponTimeline.handSwapKeys) || [],
    effects: p.effects || [],
    projectileEvents: p.projectileEvents || [],
    teleportEvents: p.teleportEvents || [],
    combatKeys: p.combatKeys || [],
  });
  const withFlip = (p) => withTimelineEvents(p);
  if (basic) motionSet.attack = { ...withTimelineEvents(basic), hitboxes: basic.hitboxes || [] };
  if (w.presets.dash) motionSet.dash = withFlip(w.presets.dash);
  for (const k of NONCOMBAT_PRESET_KINDS) if (w.presets[k]) motionSet[k] = withFlip(w.presets[k]);
  // Combat skill preset motions → the runtime slots the animator plays via synced
  // stick_motion triggers (skill1=F->'skill', skill2=E->'skill2', skill3=R->'skill3', ultimate=Y).
  // Each also keeps its OWN hitboxes (like heavy) so the actual ability can fire,
  // not just the cosmetic pose.
  const SKILL_MOTION_SLOT = { skill1: 'skill', skill2: 'skill2', skill3: 'skill3', ultimate: 'ultimate' };
  for (const k of Object.keys(SKILL_MOTION_SLOT)) {
    if (!w.presets[k]) continue;
    const sp = w.presets[k];
    motionSet[SKILL_MOTION_SLOT[k]] = { ...withFlip(sp), hitboxes: sp.hitboxes || [] };
  }
  // Heavy combo finisher keeps its OWN hitboxes and configurable basic count.
  if (w.presets.heavy) motionSet.heavy = { ...withTimelineEvents(w.presets.heavy), hitboxes: w.presets.heavy.hitboxes || [] };
  const c = basic ? basic.combat : {};
  const stats = {
    maxHp: w.baseStats.maxHp, moveSpeed: w.baseStats.moveSpeed,
    damage: c.damage, cooldownMs: c.cooldownMs, range: c.range, knockback: c.knockback,
    status: c.status, statusDurationMs: c.statusDurationMs, statusIntensity: c.statusIntensity,
    airborneHeight: c.airborneHeight,
  };
  const rt = clampWorkshopWeapon({ name: w.name, color: w.color, stats, motionSet, blocks: basic ? basic.blocks : null });
  for (const key of Object.keys(motionSet)) {
    if (!Array.isArray(motionSet[key]?.combatKeys) || !motionSet[key].combatKeys.length) continue;
    rt.motionSet = rt.motionSet || {};
    rt.motionSet[key] = rt.motionSet[key] || {};
    const presetKind = key === 'attack' ? 'basic' : key;
    rt.motionSet[key].combatKeys = sanitizeCombatKeys(motionSet[key].combatKeys, key === 'attack' ? stats : null, presetKind);
  }
  // V1's legacy clamp only knows skill/skill2/skill3. Preserve the new Y
  // ultimate slot after clamping so the animator can play the authored motion.
  if (motionSet.ultimate) {
    rt.motionSet = rt.motionSet || {};
    rt.motionSet.ultimate = motionSet.ultimate;
  }
  // Carry the (small, id-only) custom weapon image for the in-game renderer.
  if (w.weaponVisual && (w.weaponVisual.imageId || w.weaponVisual.dual || w.weaponVisual.hat || (Array.isArray(w.weaponVisual.hats) && w.weaponVisual.hats.length) || Array.isArray(w.weaponVisual.layerOrder))) {
    const hats = Array.isArray(w.weaponVisual.hats) ? w.weaponVisual.hats.slice(0, 5) : (w.weaponVisual.hat ? [w.weaponVisual.hat] : []);
    rt.weaponVisual = {
      imageId: w.weaponVisual.imageId || null,
      scale: w.weaponVisual.scale || 1,
      rotationOffset: w.weaponVisual.rotationOffset || 0,
      offsetX: w.weaponVisual.offsetX || 0,
      offsetY: w.weaponVisual.offsetY || 0,
      dual: !!w.weaponVisual.dual,
      offhand: w.weaponVisual.offhand || null,
      hat: w.weaponVisual.hat || hats[0] || null,
      hats,
      selectedHat: w.weaponVisual.selectedHat || 0,
      layerOrder: Array.isArray(w.weaponVisual.layerOrder) ? w.weaponVisual.layerOrder.slice(0, 8) : null,
    };
  }
  // The primary (basic) preset's ranged/projectile config drives the basic attack.
  if (basic && basic.ranged && basic.projectile) { rt.ranged = true; rt.projectile = basic.projectile; }
  // Heavy (3rd-hit finisher) + skill1/2/3/ultimate each carry their OWN combat stats
  // (damage/cooldown/knockback/status) + hitboxes/ranged-projectile so the game
  // can actually EXECUTE the authored ability, not just play its motion.
  // clampWorkshopWeapon (V1) only knows the legacy shape, so re-clamp + attach
  // these after it (mirrors ranged/weaponVisual above).
  const presetCombat = {};
  const presetCombatKeys = {};
  const presetHitboxes = {};
  const presetRanged = {};
  const presetNames = {};
  const abilitySlots = { heavy: 'heavy', ...SKILL_MOTION_SLOT };
  for (const presetKey of Object.keys(abilitySlots)) {
    const sp = w.presets[presetKey];
    if (!sp || !sp.combat) continue;
    const slot = abilitySlots[presetKey];
    presetCombat[slot] = sanitizeCombat(sp.combat, presetKey);              // re-clamp defensively
    presetCombatKeys[slot] = sanitizeCombatKeys(sp.combatKeys, sp.combat, presetKey);
    presetHitboxes[slot] = clampWorkshopHitboxes(sp.hitboxes);   // re-clamp defensively
    presetNames[slot] = String(sp.displayName || sp.label || '').slice(0, 24);
    if (sp.ranged && sp.projectile) presetRanged[slot] = sp.projectile;
  }
  if (Object.keys(presetCombat).length) rt.presetCombat = presetCombat;
  if (Object.values(presetCombatKeys).some(v => Array.isArray(v) && v.length)) rt.presetCombatKeys = presetCombatKeys;
  if (Object.keys(presetHitboxes).length) rt.presetHitboxes = presetHitboxes;
  if (Object.keys(presetRanged).length) rt.presetRanged = presetRanged;
  if (Object.keys(presetNames).length) rt.presetNames = presetNames;
  if (w.presets.heavy) rt.heavyAfter = Math.max(1, Math.min(5, Math.round(Number(w.presets.heavy.comboAfter) || 3)));
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
