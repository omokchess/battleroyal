/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolves a workshop weapon's custom image (weaponVisual.imageId) into a loaded
 * <img> + its grip/tip anchors + size, for the IN-GAME stick renderer.
 *
 * Images live per-device in localStorage (psd_custom_weapons, a data-URL each).
 * Multiplayer/published workshop payloads may carry the compact image record;
 * receivers fold that record into localStorage, then the renderer resolves it
 * by imageId like any locally authored weapon.
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

// Shared byte budget for a custom weapon image dataURL — kept the same on the
// upload side (this file) and the Firestore rule, so nothing gets silently
// rejected downstream after clearing this check.
export const WEAPON_IMAGE_BUDGET = 850000;

/**
 * Re-encode a dataURL to fit under `maxBytes` by progressively downscaling —
 * used before publishing so a detailed/noisy source image still reaches
 * recipients (shrunk) instead of being silently dropped because it was a few
 * KB over the limit. Resolves the original src unchanged if it already fits,
 * or if it can't be decoded (caller re-checks the length either way).
 */
export function shrinkDataUrlToBudget(src, maxBytes = WEAPON_IMAGE_BUDGET) {
  return new Promise((resolve) => {
    if (!src || src.length <= maxBytes) { resolve(src); return; }
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || 256, h = img.naturalHeight || 256;
      let out = src;
      for (let i = 0; i < 8 && out.length > maxBytes && Math.max(w, h) > 24; i++) {
        w = Math.max(24, Math.round(w * 0.8));
        h = Math.max(24, Math.round(h * 0.8));
        try {
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          out = cv.toDataURL('image/png');
        } catch { break; }   // tainted canvas or unsupported — keep last good `out`
      }
      resolve(out);
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

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
  if (rec.src.length > WEAPON_IMAGE_BUDGET) return false;    // matches the upload-side shrink budget
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
