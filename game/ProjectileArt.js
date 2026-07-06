/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Procedural art for workshop projectile imageIds (arrow/bolt/magicbolt/flame/
 * iceshard/bullet). Shared by the editor preview and the in-game renderer, so a
 * user's chosen projectile looks the same in both. A real sprite atlas can hook
 * in later via imageId; this is the built-in fallback.
 */

const COLORS = {
  arrow: '#d8c38a', bolt: '#9fe0ff', magicbolt: '#c56cff',
  flame: '#ff7a3d', iceshard: '#7fd3ff', bullet: '#e5e7eb',
};

/** Draw a projectile of `imageId` centred at (x,y), pointing along `angle` (rad),
 *  sized by `size` px (long axis). Falls back to 'arrow' for unknown ids. */
export function drawProjectileShape(ctx, x, y, angle, imageId, size = 20) {
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
