/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Procedural art for workshop projectile imageIds (arrow/bolt/magicbolt/flame/
 * iceshard/bullet). Shared by the editor preview and the in-game renderer, so a
 * user's chosen projectile looks the same in both. A real sprite atlas can hook
 * in later via imageId; this is the built-in fallback.
 */

import { resolveWeaponImage } from './WeaponImages.js';

const COLORS = {
  arrow: '#d8c38a', bolt: '#9fe0ff', magicbolt: '#c56cff',
  flame: '#ff7a3d', iceshard: '#7fd3ff', bullet: '#e5e7eb',
};

/** Draw a projectile of `imageId` centred at (x,y), pointing along `angle` (rad),
 *  sized by `size` px (long axis). Falls back to 'arrow' for unknown ids. */
export function drawProjectileShape(ctx, x, y, angle, imageId, size = 20) {
  const custom = typeof imageId === 'string' && imageId.startsWith('custom:') ? resolveWeaponImage(imageId) : null;
  if (custom && custom.img && custom.img.complete && custom.img.naturalWidth) {
    const L = Math.max(6, size);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(custom.img, -L / 2, -L / 2, L, L);
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
    return;
  }
  const col = COLORS[imageId] || COLORS.arrow;
  const L = Math.max(6, size), w = L * 0.42;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = col; ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 1;
  switch (imageId) {
    case 'bolt': {                                   // short thick dart
      ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.lineTo(-L / 3, w / 2); ctx.lineTo(-L / 3, -w / 2); ctx.closePath(); ctx.fill();
      ctx.fillRect(-L / 2, -w / 6, L / 4, w / 3); break;
    }
    case 'magicbolt': {                              // glowing orb + tail
      ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(0, 0, w * 0.9, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(0, 0, w * 0.55, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'flame': {                                  // teardrop flame
      ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.quadraticCurveTo(-L / 4, w / 2, -L / 2, 0); ctx.quadraticCurveTo(-L / 4, -w / 2, L / 2, 0); ctx.fill(); break;
    }
    case 'iceshard': {                               // sharp diamond
      ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.lineTo(0, w / 2); ctx.lineTo(-L / 2, 0); ctx.lineTo(0, -w / 2); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
    }
    case 'bullet': {                                 // small capsule
      ctx.beginPath(); ctx.arc(L / 4, 0, w / 2, -Math.PI / 2, Math.PI / 2); ctx.lineTo(-L / 3, w / 2); ctx.lineTo(-L / 3, -w / 2); ctx.closePath(); ctx.fill(); break;
    }
    default: {                                       // arrow: shaft + head + fletch
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, w * 0.28);
      ctx.beginPath(); ctx.moveTo(-L / 2, 0); ctx.lineTo(L / 3, 0); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.lineTo(L / 6, w / 2); ctx.lineTo(L / 6, -w / 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-L / 2, 0); ctx.lineTo(-L / 2 - w / 3, w / 2); ctx.lineTo(-L / 3, 0); ctx.lineTo(-L / 2 - w / 3, -w / 2); ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

const FX_COL = { spark: '#ffe08a', slash: '#e5e7eb', burst: '#ff7a3d', ring: '#7fd3ff', smoke: '#9ca3af' };
/** Draw a cosmetic frame-effect shape centred at the current ctx origin. */
export function drawFxShape(ctx, assetId, size = 18, color = null) {
  const col = color || FX_COL[assetId] || FX_COL.spark; const r = Math.max(4, size);
  ctx.fillStyle = col; ctx.strokeStyle = col;
  switch (assetId) {
    case 'slash': ctx.lineWidth = Math.max(2, r * 0.18); ctx.beginPath(); ctx.arc(0, 0, r, -0.8, 0.8); ctx.stroke(); break;
    case 'burst': for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineWidth = 2; ctx.stroke(); } break;
    case 'ring': ctx.lineWidth = Math.max(2, r * 0.16); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); break;
    case 'smoke': ctx.globalAlpha *= 0.5; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc((i - 1) * r * 0.5, 0, r * 0.5, 0, Math.PI * 2); ctx.fill(); } break;
    default: for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + Math.PI / 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineWidth = 2; ctx.stroke(); } // spark
  }
}
