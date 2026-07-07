/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Procedural stick-figure character (Phase A of the stickman pivot). Replaces the
 * sprite-sheet body with a skeleton drawn from motion data, so users / AI can
 * later author motions (Phases C/D) as pure cosmetics. NOTHING here touches
 * gameplay: hitboxes, range, damage, cooldowns and movement physics stay defined
 * in Weapons.js / Game.js. A motion only chooses joint angles for a frame; the
 * engine time-aligns its "impact" marker to the weapon's fixed hit window so the
 * swing reads as connected.
 *
 * Skeleton (side view, faces +x; flipped by `facing`). 10 posable joints — within
 * the editor budget (Phase C): spine lean, head, near/far upper+lower arm, and
 * near/far upper+lower leg. The "near" arm is the weapon arm and is biased toward
 * the aim so combat stays readable regardless of the cosmetic motion.
 *
 * Motion schema (informal in A; formalized as JSON in Phase B):
 *   { duration, loop, keyframes:[{ t, pose:{ joint:deg } }], events:[{ t, type }] }
 * Angles are ABSOLUTE degrees in local space measured from +x, clockwise positive
 * (screen y is down), so -90 points straight up. Missing joints inherit NEUTRAL.
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// Segment lengths as multiples of `scale` (scale ≈ body radius in px).
const SEG = {
  spine: 1.15,     // pelvis → neck
  neck: 0.30,      // neck → head base
  headR: 0.42,     // head radius
  upperArm: 0.62, lowerArm: 0.56,
  upperLeg: 0.72, lowerLeg: 0.70,
  shoulderDrop: 0.16, // shoulders sit slightly below the neck
};

// Neutral standing pose (absolute degrees). Joints not in a keyframe fall back here.
const NEUTRAL = {
  spine: -90,      // torso points up
  head: -90,
  armNearU: 60, armNearL: 75,   // near (weapon) arm hangs slightly forward
  armFarU: 108, armFarL: 95,    // far arm hangs slightly back
  legNearU: 84, legNearL: 90,
  legFarU: 96, legFarL: 92,
  weapon: 75,      // weapon angle from the hand (≈ continues the neutral forearm)
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + angWrap(b - a) * t;
function angWrap(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

/**
 * Built-in developer motions (Phase A). Locomotion (idle/run/brake/jump/fall) is
 * weapon-agnostic; the attack motion is a generic swing whose `impact` event the
 * engine aligns to the real hit. Weapon-specific motion sets arrive in Phase B.
 */
export const STICK_MOTIONS = {
  idle: {
    duration: 2.2, loop: true,
    keyframes: [
      { t: 0,   pose: { spine: -90, armNearU: 62, armNearL: 78, armFarU: 110, armFarL: 96, legNearU: 86, legFarU: 94 } },
      { t: 0.5, pose: { spine: -88, armNearU: 64, armNearL: 80, armFarU: 112, armFarL: 98 } },
      { t: 1,   pose: { spine: -90, armNearU: 62, armNearL: 78, armFarU: 110, armFarL: 96, legNearU: 86, legFarU: 94 } },
    ],
    events: [],
  },
  run: {
    duration: 0.5, loop: true,
    keyframes: [
      { t: 0,    pose: { spine: -82, armNearU: 40, armNearL: 70, armFarU: 130, armFarL: 110, legNearU: 55, legNearL: 80, legFarU: 120, legFarL: 70 } },
      { t: 0.25, pose: { spine: -84, armNearU: 75, armNearL: 90, armFarU: 95,  armFarL: 100, legNearU: 90, legNearL: 95, legFarU: 90,  legFarL: 120 } },
      { t: 0.5,  pose: { spine: -82, armNearU: 130, armNearL: 110, armFarU: 40, armFarL: 70, legNearU: 120, legNearL: 70, legFarU: 55, legFarL: 80 } },
      { t: 0.75, pose: { spine: -84, armNearU: 95, armNearL: 100, armFarU: 75, armFarL: 90, legNearU: 90, legNearL: 120, legFarU: 90, legFarL: 95 } },
      { t: 1,    pose: { spine: -82, armNearU: 40, armNearL: 70, armFarU: 130, armFarL: 110, legNearU: 55, legNearL: 80, legFarU: 120, legFarL: 70 } },
    ],
    events: [],
  },
  brake: {
    duration: 0.3, loop: false,
    keyframes: [
      { t: 0, pose: { spine: -98, legNearU: 70, legNearL: 100, legFarU: 110, legFarL: 80, armNearU: 50, armFarU: 120 } },
      { t: 1, pose: { spine: -94, legNearU: 78, legNearL: 95, legFarU: 102, legFarL: 88 } },
    ],
    events: [],
  },
  jump: {
    duration: 0.4, loop: false,
    keyframes: [
      { t: 0, pose: { spine: -90, armNearU: 30, armFarU: 40, legNearU: 70, legNearL: 60, legFarU: 78, legFarL: 64 } },
      { t: 1, pose: { spine: -92, armNearU: 20, armFarU: 30, legNearU: 64, legNearL: 70, legFarU: 70, legFarL: 76 } },
    ],
    events: [],
  },
  fall: {
    duration: 0.5, loop: true,
    keyframes: [
      { t: 0, pose: { spine: -88, armNearU: 35, armFarU: 50, legNearU: 80, legNearL: 110, legFarU: 100, legFarL: 120 } },
      { t: 0.5, pose: { spine: -90, armNearU: 30, armFarU: 45, legNearU: 84, legNearL: 115, legFarU: 96, legFarL: 124 } },
      { t: 1, pose: { spine: -88, armNearU: 35, armFarU: 50, legNearU: 80, legNearL: 110, legFarU: 100, legFarL: 120 } },
    ],
    events: [],
  },
  // Generic attack swing: windup (back) → strike (through aim) → recover. The
  // near arm is overridden to sweep around the aim direction (see drawStickman),
  // so this mainly animates the torso/legs/off-arm for weight. impact at t≈0.45.
  attack: {
    duration: 0.42, loop: false,
    keyframes: [
      { t: 0,    pose: { spine: -86, armFarU: 120, legNearU: 80, legFarU: 100 } },
      { t: 0.3,  pose: { spine: -78, armFarU: 70 } },
      { t: 0.45, pose: { spine: -98, armFarU: 60, legNearU: 70, legFarU: 110 } },
      { t: 1,    pose: { spine: -88, armFarU: 110, legNearU: 84, legFarU: 96 } },
    ],
    events: [{ t: 0.45, type: 'impact' }],
  },
};

// Weapon → stick colour (Phase A). Phase B turns this into the formal
// weapon = { color, motionSet } table. Falls back to the player colour.
export const WEAPON_STICK_COLOR = {
  sword: '#d8dee9', axe: '#c98b53', spear: '#9fb4c9', bow: '#8fcf86',
  gauntlet: '#e0a85a', greatsword: '#b0b6c2', scythe: '#9a7bd0', dagger: '#cdd3da',
  rapier: '#a9d3e8', hammer: '#c2773f', katana: '#e08a8a', magicstaff: '#7fd0c4',
  sniper: '#6f7b8c', chakram: '#e6c14a', pistols: '#caa15a', guardian: '#d0c089',
  harpoon: '#7fb0c9', minebag: '#b58b5a', flamethrower: '#e07a3a',
};

// Neutral pose accessor (so Motion.js can sanitize against the joint set).
export const STICK_NEUTRAL = NEUTRAL;

// Pose at a normalised phase [0,1) of a motion, interpolated between keyframes.
export function samplePose(motion, phase) {
  const kfs = motion.keyframes;
  const p = Math.max(0, Math.min(0.99999, phase));
  let a = kfs[0], b = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (p >= kfs[i].t && p <= kfs[i + 1].t) { a = kfs[i]; b = kfs[i + 1]; break; }
  }
  const span = Math.max(1e-4, b.t - a.t);
  const lt = Math.max(0, Math.min(1, (p - a.t) / span));
  const pose = {};
  for (const j in NEUTRAL) {
    const av = (a.pose[j] !== undefined) ? a.pose[j] : NEUTRAL[j];
    const bv = (b.pose[j] !== undefined) ? b.pose[j] : NEUTRAL[j];
    pose[j] = lerpAngle(av, bv, lt);
  }
  return pose;
}

/**
 * Resolve the FK chain into local joint points (facing +x, pelvis at origin),
 * in px (already multiplied by `scale`).
 */
function solveSkeleton(pose, scale) {
  const dir = (deg) => ({ x: Math.cos(deg * DEG), y: Math.sin(deg * DEG) });
  const add = (p, d, len) => ({ x: p.x + d.x * len, y: p.y + d.y * len });

  const pelvis = { x: 0, y: 0 };
  const sp = dir(pose.spine);
  const neck = add(pelvis, sp, SEG.spine * scale);
  const shoulder = add(neck, dir(90), SEG.shoulderDrop * scale); // a touch below neck
  const headBase = add(neck, dir(pose.head), SEG.neck * scale);
  const head = add(headBase, dir(pose.head), SEG.headR * scale * 0.5);

  const elbowN = add(shoulder, dir(pose.armNearU), SEG.upperArm * scale);
  const handN = add(elbowN, dir(pose.armNearL), SEG.lowerArm * scale);
  const elbowF = add(shoulder, dir(pose.armFarU), SEG.upperArm * scale);
  const handF = add(elbowF, dir(pose.armFarL), SEG.lowerArm * scale);

  const kneeN = add(pelvis, dir(pose.legNearU), SEG.upperLeg * scale);
  const footN = add(kneeN, dir(pose.legNearL), SEG.lowerLeg * scale);
  const kneeF = add(pelvis, dir(pose.legFarU), SEG.upperLeg * scale);
  const footF = add(kneeF, dir(pose.legFarL), SEG.lowerLeg * scale);

  return { pelvis, neck, shoulder, headBase, head, headR: SEG.headR * scale,
    elbowN, handN, elbowF, handF, kneeN, footN, kneeF, footF };
}

/**
 * Draw a stick character. `opts`:
 *   ctx, x, y (anchor = player CENTER in screen px), scale (≈ radius px),
 *   facing (+1/-1), color (stick colour), accent, lineW,
 *   pose (sampled), aimAngle (world rad, for the weapon arm), weapon (id),
 *   attackBlend (0..1 — how much the near arm follows the swing vs. aim).
 */
/**
 * Resolve a pose into SCREEN-space joint points anchored at (x, y = body centre),
 * with the facing flip applied. Shared by the game renderer and the motion editor
 * so handle hit-testing matches exactly what is drawn.
 *   opts.rawNearArm = true → keep the authored near-arm pose (editor); otherwise
 *   the near (weapon) arm is overridden to follow `aimAngle` (in-game readability).
 * Returns { joints: {name:{x,y}}, headR }.
 */
// Per-weapon held length (× scale). Exported so the editor can place the weapon
// handle at the real tip.
export function weaponReach(weapon, scale) {
  const m = {
    spear: 2.6, greatsword: 2.2, scythe: 2.2, rapier: 2.0, katana: 1.9, sword: 1.6,
    hammer: 1.7, axe: 1.5, dagger: 1.0, gauntlet: 0.7, harpoon: 2.3,
    bow: 1.2, sniper: 2.0, pistols: 0.9, chakram: 0.9, magicstaff: 2.0,
    guardian: 1.5, minebag: 0.8, flamethrower: 1.5,
  }[weapon] ?? 1.5;
  return m * scale;
}

const segAngle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) / DEG;

export function solveStickman(pose, scale, x, y, facing = 1, opts = {}) {
  const S = solveSkeleton(pose, scale);
  const footLocalY = Math.max(S.footN.y, S.footF.y);
  const anchorY = y + scale * 1.28 - footLocalY;          // keep feet planted
  const toScreen = (pt) => ({ x: x + pt.x * facing, y: anchorY + pt.y });

  // Authored forearm direction (local) BEFORE any aim override — used to keep the
  // weapon's authored angle relative to the arm when the arm tracks the aim.
  const authForeDeg = segAngle(S.elbowN, S.handN);

  if (!opts.rawNearArm) {
    // Near arm follows the aim so the weapon points at the cursor (un-flip by facing).
    const localAim = facing >= 0 ? (opts.aimAngle || 0) : Math.PI - (opts.aimAngle || 0);
    const sh = S.shoulder;
    const reach = (SEG.upperArm + SEG.lowerArm) * scale * 0.92;
    S.elbowN = { x: sh.x + Math.cos(localAim) * SEG.upperArm * scale, y: sh.y + Math.sin(localAim) * SEG.upperArm * scale };
    S.handN = { x: sh.x + Math.cos(localAim) * reach, y: sh.y + Math.sin(localAim) * reach };
  }

  // Weapon segment from the hand. The authored `pose.weapon` is an ABSOLUTE local
  // angle; in-game we preserve its OFFSET from the (authored) forearm so the weapon
  // still tracks the aim when unedited (offset 0 → points along the aim).
  const wAuthored = (pose.weapon ?? NEUTRAL.weapon);
  const wLen = weaponReach(opts.weapon, scale);
  let wDeg;
  if (opts.rawNearArm) {
    wDeg = wAuthored;
  } else {
    const curForeDeg = segAngle(S.elbowN, S.handN);
    wDeg = curForeDeg + (wAuthored - authForeDeg);
  }
  S.weaponTip = { x: S.handN.x + Math.cos(wDeg * DEG) * wLen, y: S.handN.y + Math.sin(wDeg * DEG) * wLen };

  const joints = {};
  for (const k of ['pelvis', 'neck', 'shoulder', 'head', 'elbowN', 'handN', 'elbowF', 'handF', 'kneeN', 'footN', 'kneeF', 'footF', 'weaponTip']) {
    joints[k] = toScreen(S[k]);
  }
  return { joints, headR: S.headR };
}

/** Draw a stick figure from solved screen joints. `aimAngle` only orients the
 *  held weapon. Used by both the game and the editor preview. */
export function drawStickFromJoints(ctx, sc, headR, { color = '#cdd3da', accent = '#0d0a06', lineW = 3, scale = 14, weapon = 'sword', drawWeapon = true, aimAngle = 0, headShape = 'circle', accessory = 'none', weaponImage = null, weaponImageSize = 2.0, weaponImageAnchors = null, weaponFlip = false, weaponFlipY = false, weaponDual = false, hatImage = null, hat = null } = {}) {
  const lw = Math.max(2, lineW * (scale / 14));
  const limb = (a, b, w, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  const back = shade(color, -0.32);
  limb(sc.pelvis, sc.kneeF, lw, back); limb(sc.kneeF, sc.footF, lw, back);
  // Arms start at the NECK (not the lower shoulder) so they read as attached at
  // the top of the torso.
  limb(sc.neck, sc.elbowF, lw * 0.9, back); limb(sc.elbowF, sc.handF, lw * 0.9, back);
  // Dual-wield: a second (back-hand) weapon behind the body, drawn before the
  // front so it reads as the off-hand.
  if (drawWeapon && weaponDual && sc.weaponTip && sc.handF) {
    const farTip = { x: sc.handF.x + (sc.weaponTip.x - sc.handN.x), y: sc.handF.y + (sc.weaponTip.y - sc.handN.y) };
    if (weaponImage && weaponImage.complete && weaponImage.naturalWidth) {
      ctx.save(); ctx.globalAlpha = 0.85; drawImageWeapon(ctx, sc.handF, farTip, scale, weaponImage, weaponImageSize, weaponImageAnchors, !weaponFlip, weaponFlipY); ctx.restore();
    } else drawHeldWeapon(ctx, sc.handF, farTip, scale, weapon, shade(WEAPON_STICK_COLOR[weapon] || color, -0.25));
  }
  limb(sc.pelvis, sc.neck, lw * 1.15, color);
  limb(sc.pelvis, sc.kneeN, lw, color); limb(sc.kneeN, sc.footN, lw, color);
  drawHead(ctx, sc.head, sc.neck, headR, color, accent, Math.max(1, lw * 0.5), headShape, accessory);
  if (hatImage && hatImage.complete && hatImage.naturalWidth && sc.head) {
    const cfg = hat || {};
    const size = headR * 2.4 * (Number(cfg.scale) || 1);
    ctx.save();
    ctx.globalAlpha = Number.isFinite(cfg.alpha) ? cfg.alpha : 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      hatImage,
      sc.head.x - size / 2 + (Number(cfg.offsetX) || 0) * (scale / 46),
      sc.head.y - size / 2 + (Number(cfg.offsetY) || -18) * (scale / 46),
      size,
      size
    );
    ctx.restore();
  }
  limb(sc.neck, sc.elbowN, lw, color); limb(sc.elbowN, sc.handN, lw, color);
  if (drawWeapon && sc.weaponTip) {
    if (weaponImage && weaponImage.complete && weaponImage.naturalWidth) {
      drawImageWeapon(ctx, sc.handN, sc.weaponTip, scale, weaponImage, weaponImageSize, weaponImageAnchors, weaponFlip, weaponFlipY);
    } else {
      const wcol = WEAPON_STICK_COLOR[weapon] || color;
      drawHeldWeapon(ctx, sc.handN, sc.weaponTip, scale, weapon, wcol);
    }
  }
}

// A user-supplied weapon IMAGE. The user marks two anchors on the image — the
// GRIP (손잡이) and the TIP (끝) — and we map grip→hand and the grip→tip vector
// onto the hand→weaponTip direction (so the weapon joint still aims it), scaled
// so the grip→tip distance equals the weapon length (scale × size multiplier).
function drawImageWeapon(ctx, hand, tip, scale, img, sizeMul, anchors, flip = false, flipY = false) {
  const a = (anchors && Number.isFinite(anchors.gx)) ? anchors : { gx: 0.15, gy: 0.5, tx: 0.95, ty: 0.5 };
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const gX = a.gx * iw, gY = a.gy * ih;
  const dx = (a.tx - a.gx) * iw, dy = (a.ty - a.gy) * ih;
  const d = Math.hypot(dx, dy);
  if (!(d > 1)) return;                                   // degenerate anchors → skip
  const len = scale * (sizeMul || 2.0);
  const s = len / d;
  const ang = Math.atan2(tip.y - hand.y, tip.x - hand.x);
  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(ang - Math.atan2(dy, dx));
  if (flip) ctx.scale(1, -1);                             // 무기 좌우 반전 (blade side mirror)
  if (flipY) ctx.scale(-1, 1);                             // 무기 상하 반전 (grip-axis mirror)
  ctx.scale(s, s);
  ctx.translate(-gX, -gY);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// Head shape + optional accessory (cosmetic appearance, Phase E).
function drawHead(ctx, head, neck, r, color, accent, lineW, shape, accessory) {
  // No black outline ring — fill only (user request). A subtle same-hue rim keeps
  // the head readable against the body without the heavy dark circle.
  ctx.fillStyle = color; ctx.strokeStyle = shade(color, -0.18); ctx.lineWidth = Math.max(1, lineW * 0.6);
  ctx.beginPath();
  if (shape === 'square') {
    ctx.rect(head.x - r, head.y - r, r * 2, r * 2);
  } else if (shape === 'diamond') {
    ctx.moveTo(head.x, head.y - r * 1.15); ctx.lineTo(head.x + r, head.y);
    ctx.lineTo(head.x, head.y + r * 1.15); ctx.lineTo(head.x - r, head.y); ctx.closePath();
  } else {
    ctx.arc(head.x, head.y, r, 0, TAU);
  }
  ctx.fill(); ctx.stroke();

  if (!accessory || accessory === 'none') return;
  ctx.lineWidth = Math.max(1.5, lineW * 1.3); ctx.lineCap = 'round';
  if (accessory === 'horns') {
    ctx.strokeStyle = '#e8d5a3';
    ctx.beginPath(); ctx.moveTo(head.x - r * 0.7, head.y - r * 0.6); ctx.lineTo(head.x - r * 1.4, head.y - r * 1.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(head.x + r * 0.7, head.y - r * 0.6); ctx.lineTo(head.x + r * 1.4, head.y - r * 1.6); ctx.stroke();
  } else if (accessory === 'antenna') {
    ctx.strokeStyle = '#7df09a';
    ctx.beginPath(); ctx.moveTo(head.x, head.y - r); ctx.lineTo(head.x, head.y - r * 2.1); ctx.stroke();
    ctx.fillStyle = '#7df09a'; ctx.beginPath(); ctx.arc(head.x, head.y - r * 2.3, r * 0.32, 0, TAU); ctx.fill();
  } else if (accessory === 'halo') {
    ctx.strokeStyle = '#ffe08a';
    ctx.beginPath(); ctx.ellipse(head.x, head.y - r * 1.6, r * 0.95, r * 0.4, 0, 0, TAU); ctx.stroke();
  } else if (accessory === 'crown') {
    ctx.fillStyle = '#ffd24a';
    const cy = head.y - r;
    ctx.beginPath();
    ctx.moveTo(head.x - r, cy); ctx.lineTo(head.x - r, cy - r * 0.5); ctx.lineTo(head.x - r * 0.5, cy - r * 0.15);
    ctx.lineTo(head.x, cy - r * 0.7); ctx.lineTo(head.x + r * 0.5, cy - r * 0.15); ctx.lineTo(head.x + r, cy - r * 0.5);
    ctx.lineTo(head.x + r, cy); ctx.closePath(); ctx.fill();
  }
}

export function drawStickman(opts) {
  const { ctx, x, y, scale, facing = 1, color = '#cdd3da', accent = '#0d0a06',
    lineW = 3, pose, aimAngle = 0, weapon = 'sword', headShape = 'circle', accessory = 'none',
    weaponImage = null, weaponImageSize = 2.0, weaponImageAnchors = null, weaponFlip = false, weaponFlipY = false, weaponDual = false,
    hatImage = null, hat = null,
    rawNearArm = false } = opts;
  const { joints, headR } = solveStickman(pose, scale, x, y, facing, { aimAngle, weapon, rawNearArm });
  drawStickFromJoints(ctx, joints, headR, { color, accent, lineW, scale, weapon, aimAngle, headShape, accessory, weaponImage, weaponImageSize, weaponImageAnchors, weaponFlip, weaponFlipY, weaponDual, hatImage, hat });
}

// A held weapon: a bar/blade from the hand to the (already-solved) tip.
function drawHeldWeapon(ctx, hand, tip, scale, weapon, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, (weapon === 'hammer' || weapon === 'greatsword' ? 4 : 2.4) * (scale / 14));
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(hand.x, hand.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
  // A small guard/head marker for heavy weapons.
  if (weapon === 'hammer' || weapon === 'axe') {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, scale * 0.28, 0, TAU); ctx.fill();
  }
}

// Lighten/darken a hex/hsl-ish colour for back-limb depth shading.
function shade(col, amt) {
  // Works for #rrggbb; otherwise just return the original (hsl etc.).
  const m = /^#([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = amt < 0 ? (1 + amt) : 1;
  const add = amt > 0 ? amt * 255 : 0;
  r = Math.max(0, Math.min(255, Math.round(r * f + add)));
  g = Math.max(0, Math.min(255, Math.round(g * f + add)));
  b = Math.max(0, Math.min(255, Math.round(b * f + add)));
  return `rgb(${r},${g},${b})`;
}

