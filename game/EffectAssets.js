const BUILTIN_EFFECT_ASSETS = Object.freeze({
  spark: { label: '반짝임', animated: true, src: '/assets/ninja/fx/Magic/Spark/Preview.gif' },
  slash: { label: '베기', animated: false, src: '' },
  burst: { label: '폭발', animated: true, src: '/assets/ninja/fx/Elemental/Explosion/Preview.gif' },
  ring: { label: '링', animated: true, src: '/assets/ninja/fx/Magic/Circle/Preview.gif' },
  smoke: { label: '연기', animated: true, src: '/assets/ninja/fx/Smoke/Smoke/Preview.gif' },
});

export const BUILTIN_EFFECTS = Object.freeze(
  Object.entries(BUILTIN_EFFECT_ASSETS).map(([id, meta]) => [id, meta.label])
);

export function builtinEffectAsset(id) {
  return BUILTIN_EFFECT_ASSETS[id] || null;
}

export function isAnimatedEffect(effect) {
  if (effect?.animated === true) return true;
  return !!builtinEffectAsset(typeof effect === 'string' ? effect : effect?.assetId)?.animated;
}

export function sanitizeEffectColor(value, fallback = '#ffffff') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

let tintCanvas = null;
let tintContext = null;

/** Draw the current frame of a static/animated image with an optional solid tint. */
export function drawTintedEffectImage(ctx, img, x, y, width, height, color = '#ffffff') {
  if (!ctx || !img || width <= 0 || height <= 0) return;
  const w = Math.max(1, Math.ceil(Math.abs(width)));
  const h = Math.max(1, Math.ceil(Math.abs(height)));
  if (typeof document === 'undefined') {
    ctx.drawImage(img, x, y, width, height);
    return;
  }
  if (!tintCanvas) {
    tintCanvas = document.createElement('canvas');
    tintContext = tintCanvas.getContext('2d');
  }
  if (!tintContext) {
    ctx.drawImage(img, x, y, width, height);
    return;
  }
  tintCanvas.width = w;
  tintCanvas.height = h;
  tintContext.clearRect(0, 0, w, h);
  tintContext.imageSmoothingEnabled = false;
  tintContext.drawImage(img, 0, 0, w, h);
  if (sanitizeEffectColor(color) !== '#ffffff') {
    tintContext.globalCompositeOperation = 'source-atop';
    tintContext.fillStyle = sanitizeEffectColor(color);
    tintContext.fillRect(0, 0, w, h);
    tintContext.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(tintCanvas, x, y, width, height);
}
