/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolves a workshop weapon's custom image (weaponVisual.imageId) into a loaded
 * <img> + its grip/tip anchors + size, for the IN-GAME stick renderer.
 *
 * Images live per-device in localStorage (psd_custom_weapons, a data-URL each).
 * Only the small imageId travels in the synced appearance — the renderer looks
 * the pixels up locally. So the local player sees their own uploaded weapon;
 * peers who don't have that image just get the default stick (local-first).
 */

const KEY = 'psd_custom_weapons';
const cache = new Map();   // imageId → { img, size, anchors } | null (miss)

export function resolveWeaponImage(imageId) {
  if (!imageId || typeof imageId !== 'string' || !imageId.startsWith('custom:')) return null;
  if (cache.has(imageId)) return cache.get(imageId);
  let rec = null;
  try { const list = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(list)) rec = list.find(c => c && c.id === imageId); }
  catch {}
  if (!rec || !rec.src) { cache.set(imageId, null); return null; }
  const img = new Image();
  img.src = rec.src;
  const entry = { img, size: Number(rec.size) || 2, anchors: rec.anchors || null };
  cache.set(imageId, entry);
  return entry;
}

/** Drop a cached entry (e.g. after the user deletes/re-anchors a custom weapon). */
export function invalidateWeaponImage(imageId) { cache.delete(imageId); }

// ── Shared custom-weapon store access (psd_custom_weapons) ───────────────────
// Single source of truth for the per-device image records so both the editor,
// the publish path (attach pixels), and the import path (persist pixels for the
// recipient) agree on the shape: { id:'custom:…', name, src(dataURL), size, anchors }.

function _readStore() {
  try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

/** The local image record for an imageId (or null) — used to attach pixels on upload. */
export function getCustomWeaponRecord(imageId) {
  if (!imageId || typeof imageId !== 'string' || !imageId.startsWith('custom:')) return null;
  return _readStore().find(c => c && c.id === imageId) || null;
}

/**
 * Persist a custom-weapon image record locally so `resolveWeaponImage` can find
 * it — used when importing a weapon someone else made (the pixels travel with
 * the published doc as `weaponImage`, and we fold them into this device's store).
 * Skips absurdly large payloads defensively. Returns true when stored.
 */
export function saveCustomWeaponRecord(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id.startsWith('custom:') || typeof rec.src !== 'string') return false;
  if (rec.src.length > 400_000) return false;               // ~400KB dataURL cap (well under Firestore's 1MB doc)
  const entry = {
    id: rec.id,
    name: String(rec.name || '무기').slice(0, 40),
    src: rec.src,
    size: Number(rec.size) || 2,
    anchors: (rec.anchors && typeof rec.anchors === 'object') ? rec.anchors : null,
  };
  try {
    const list = _readStore();
    const i = list.findIndex(c => c && c.id === entry.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { return false; }
  invalidateWeaponImage(entry.id);
  return true;
}
