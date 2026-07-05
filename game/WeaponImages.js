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
