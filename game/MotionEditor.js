/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-game motion editor (Phase C of the stickman pivot) — a small Stick-Nodes
 * style tool: drag joints to pose the figure, drop keyframes along a timeline,
 * preview, and save. Output is PURE COSMETIC motion
 * data (the schema in Motion.js); it can never touch hitboxes/range/damage/
 * cooldown/physics.
 *
 * Guardrails (the whole point):
 *  - Scope caps keep it light + the data bounded: ≤ 8 keyframes, fixed canvas,
 *    the 10 known joints only.
 *  - Everything is re-sanitized by Motion.sanitizeMotion on save/load/register,
 *    so even a hand-edited localStorage blob can't inject unsafe data.
 */

import { solveStickman, drawStickFromJoints, samplePose, STICK_NEUTRAL, WEAPON_STICK_COLOR } from './Stickman.js';
import { resolveMotion, weaponSetId, sanitizeMotion, registerMotionSet, MOTION_LIMITS, setCanonicalWeapon, sampleRootOffset } from './Motion.js';
import { captureMotionFromWebcam } from './PoseCapture.js';
import { drawProjectileShape, drawFxShape } from './ProjectileArt.js';
import { equippedStickLook, saveStickLook } from './StickLook.js';
import { clampWorkshopStats, statCost, enforceBudget, clampWorkshopWeapon, POINT_BUDGET, toWorkshopWeaponV2, clampWorkshopWeaponV2, COMBAT_PRESET_KINDS, PRESET_LABELS, AUTHORING_PRESET_KEYS, FIXED_PRESET_DURATIONS, makeEmptyWeaponV2, makeEmptyPreset, statCostV2, baseStatsCost, combatCost, sanitizeCombat, sanitizeCombatKeys, sampleCombatKeys, sanitizeProjectile, sanitizeProjectileEvents, sanitizeTeleportEvents, sanitizeEffects, sampleEffectTransform, VALID_STATUS, sanitizeFlipKeys, sampleFlip } from './Workshop.js';
import { saveWorkshopWeaponLocal, equipWorkshopWeaponLocal, v2ToV1Runtime } from './WorkshopStore.js';
import { invalidateWeaponImage, shrinkDataUrlToBudget, WEAPON_IMAGE_BUDGET } from './WeaponImages.js';
// Local workshop storage + equip live in WorkshopStore now; re-export the
// legacy-named helpers so existing import sites (main.js) keep working.
export { equippedWorkshopWeapon, equipWorkshopWeapon, clearWorkshopWeapon, equippedWorkshopWeaponName } from './WorkshopStore.js';

const MAX_KF = 64;                                 // editor keyframe budget (admin authoring)
const STORE_SETS = 'pixelroyale_motionsets_v1';    // { id: { attack: motion } }
const STORE_EQUIP = 'pixelroyale_equipped_motion_v1';
const STORE_CANON = 'pixelroyale_canonical_weapons_v1'; // { weapon: { attack: motion } }

const STAT_KEYS = ['damage', 'cooldownMs', 'maxHp', 'moveSpeed', 'knockback', 'statusDurationMs'];

// Editable weapons (those whose stick attack reads clearly). Kept short on purpose.
// Workshop weapons are custom-image-first: no fixed base roster anymore, just a
// plain stick default ('sword' = a simple bar) plus the user's uploaded images.
const EDITOR_WEAPONS = ['sword'];
const EDITOR_WEAPON_LABEL = { sword: '기본 (막대)' };
const HAT_IMAGE_BUDGET = Math.floor(WEAPON_IMAGE_BUDGET / 5);
const EFFECT_IMAGE_BUDGET = Math.floor(WEAPON_IMAGE_BUDGET / 5);
const CUSTOM_IMAGE_BOX_SIZE = 400;
const BUILTIN_EFFECTS = [
  ['spark', '반짝임'],
  ['slash', '베기'],
  ['burst', '폭발'],
  ['ring', '링'],
  ['smoke', '연기'],
];
const DECORATION_LAYERS = [
  ['behindPlayer', '플레이어 뒤'],
  ['overPlayer', '플레이어 위 / 무기 아래'],
  ['overWeapon', '무기 위'],
];

// Fixed motion-tag vocabulary (the bridge between authored motions and gameplay /
// blockcoding). Keys are the engine slot names; labels are what users see.
// attack/run/idle/jump auto-apply via the StickAnimator; dash/skill/hurt are
// trigger tags fired by block programs (모션 재생 블록).
export const MOTION_TAGS = [
  { key: 'attack', label: '공격' }, { key: 'run', label: '걷기' },
  { key: 'idle', label: '대기' }, { key: 'jump', label: '점프' },
  { key: 'dash', label: '대시' }, { key: 'skill', label: '스킬' },
  { key: 'hurt', label: '피격' },
];
const TAG_LABEL = Object.fromEntries(MOTION_TAGS.map(t => [t.key, t.label]));

// Resizable editor columns: drag threshold below which a block folds shut, and
// the localStorage key persisting per-column widths / collapsed state.
const ME_COLLAPSE_AT = 120;
const ME_LAYOUT_KEY = 'psd_me_layout';
const FRAME_OVERVIEW_SIZE_KEY = 'psd_me_frame_overview_size';
const FRAME_OVERVIEW_HEIGHT_KEY = 'psd_me_frame_overview_height';

function normalizeCustomImageDataUrl(dataUrl, boxSize = CUSTOM_IMAGE_BOX_SIZE) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve({ src: dataUrl, img: null });
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const iw = Math.max(1, img.naturalWidth || img.width || 1);
        const ih = Math.max(1, img.naturalHeight || img.height || 1);
        const cv = document.createElement('canvas');
        cv.width = boxSize;
        cv.height = boxSize;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, boxSize, boxSize);
        ctx.imageSmoothingEnabled = true;
        const s = Math.min(boxSize / iw, boxSize / ih);
        const w = Math.max(1, Math.round(iw * s));
        const h = Math.max(1, Math.round(ih * s));
        const x = Math.round((boxSize - w) / 2);
        const y = Math.round((boxSize - h) / 2);
        ctx.drawImage(img, x, y, w, h);
        const src = cv.toDataURL('image/png');
        const normalized = new Image();
        normalized.onload = () => resolve({ src, img: normalized });
        normalized.onerror = () => resolve({ src, img });
        normalized.src = src;
      } catch {
        resolve({ src: dataUrl, img });
      }
    };
    img.onerror = () => resolve({ src: dataUrl, img: null });
    img.src = dataUrl;
  });
}

// First-run workshop tutorial (goal: make ONE weapon end-to-end). Each step
// highlights a target and auto-advances when the user performs the action.
const ME_TUT_KEY = 'psd_ws_tut_done';
const ME_TUT_STEPS = [
  { target: 'mePresetBar', title: '① 프리셋 선택', text: '평타·강공격·스킬 1/2/3·궁극기·대시·이동 모션은 처음부터 모두 준비됩니다. 공격 프리셋만 대미지와 판정을 가집니다.', action: '상단 프리셋 버튼 중 하나를 누르세요. 완성한 프리셋은 [해당 프리셋 완성] 버튼으로 표시합니다.', auto: 'preset' },
  { target: 'meCanvas', title: '② 포즈 만들기', text: '초록 관절점으로 몸을 움직이고, 주황 무기점을 돌려 무기 기울기를 만듭니다. 빨간 골반점 이동은 미리보기와 실전 위치 보정에 반영됩니다.', action: '미리보기 안의 초록 관절점 또는 주황 무기점을 드래그하세요.', auto: 'joint' },
  { target: 'meNewFrame', title: '③ 프레임 추가', text: '＋ 새 프레임은 현재 포즈를 이어받습니다. 최대 64프레임까지 만들 수 있고, 프레임 몰아보기에서 전체 포즈를 한눈에 확인합니다.', action: '＋ 새 프레임 버튼을 누르세요.', auto: 'newframe' },
  { target: 'meHitboxRow', title: '④ 프레임 판정', text: '공격 프리셋에서는 원하는 프레임에 히트박스를 추가하고, 빨간 상자를 끌어 위치·크기를 조절합니다. 비공격 프리셋에는 판정이 붙지 않습니다.', action: '판정 영역의 ＋ 현재 프레임 판정 버튼을 누르세요.', auto: 'hitbox' },
  { target: 'meEffectsBlock', title: '⑤ 이펙트/발사체/텔레포트', text: '공격 이펙트는 프레임 단위로 재생됩니다. 원거리 프리셋은 발사체 이미지와 히트박스를 직접 고르고, 최대 5개 발사/텔레포트 이벤트를 넣을 수 있습니다.', action: '이펙트 블록의 ＋ 이펙트 버튼을 누르세요.', auto: 'effect' },
  { target: 'meRightFlipToggle', title: '⑥ 무기 반전', text: '오른손/왼손 무기 반전을 따로 찍을 수 있습니다. 손 변경 후에도 버튼은 실제 오른손과 왼손에 든 무기를 기준으로 적용됩니다.', action: '오른손 좌우 버튼을 누르세요.', auto: 'flip' },
  { target: 'meStatsPanel', title: '⑦ 예산 설정', text: '무기 전역 예산은 체력·이동속도, 프리셋 예산은 대미지·쿨타임·넉백·상태이상에 쓰입니다. 예산 100을 넘기면 더 올릴 수 없습니다.', action: '무기 스탯 또는 프리셋 스탯 슬라이더를 하나 움직이세요.', auto: 'stat' },
  { target: 'meSave', title: '⑧ 저장과 업로드', text: '저장 + 장착은 내 무기고에 저장하고 바로 장착합니다. 업로드를 눌러야 워크샵에 공개됩니다. 워크샵 무기는 첫 1개 무료, 이후 추가는 100화폐입니다.', action: '저장 + 장착 버튼을 누르세요.', auto: 'save' },
];

// User-authored motion presets: [{ id, name, tag, motion, equipped }]. Saved
// locally; the equipped one per tag is bundled into the workshop weapon def.
const STORE_PRESETS = 'psd_motion_presets';
const loadUserPresets = () => { try { const a = JSON.parse(localStorage.getItem(STORE_PRESETS) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const saveUserPresets = (list) => { try { localStorage.setItem(STORE_PRESETS, JSON.stringify(list)); } catch {} };

// User-uploaded weapon images (cosmetic), persisted locally. Each is
// { id:'custom:…', name, src(dataURL), size(length multiplier) }.
const CUSTOM_WEAPONS_KEY = 'psd_custom_weapons';
const loadCustomWeapons = () => { try { const a = JSON.parse(localStorage.getItem(CUSTOM_WEAPONS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const saveCustomWeapons = (list) => { try { localStorage.setItem(CUSTOM_WEAPONS_KEY, JSON.stringify(list)); } catch {} };
const escOpt = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// Which pose joint + parent joint each draggable handle controls.
const HANDLES = [
  { name: 'neck',   joint: 'spine',     parent: 'pelvis' },
  { name: 'head',   joint: 'head',      parent: 'neck' },
  { name: 'elbowN', joint: 'armNearU',  parent: 'shoulder' },
  { name: 'handN',  joint: 'armNearL',  parent: 'elbowN' },
  { name: 'elbowF', joint: 'armFarU',   parent: 'shoulder' },
  { name: 'handF',  joint: 'armFarL',   parent: 'elbowF' },
  { name: 'kneeN',  joint: 'legNearU',  parent: 'pelvis' },
  { name: 'footN',  joint: 'legNearL',  parent: 'kneeN' },
  { name: 'kneeF',  joint: 'legFarU',   parent: 'pelvis' },
  { name: 'footF',  joint: 'legFarL',   parent: 'kneeF' },
  { name: 'weaponTip', joint: 'weapon', parent: 'handN' },   // rotate the held weapon
  { name: 'weaponOffTip', joint: 'weaponOff', parent: 'handF' }, // rotate the off-hand weapon
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

/**
 * Load + re-register every stored motion set (call once at app start). localStorage
 * is this device's CANONICAL cache (only the admin-gated editor writes it), so it
 * re-registers with allowGameplay → authored hitboxes survive a reload. Everything
 * is still re-sanitized (clamped) on the way in, never trusting a raw blob. In
 * multiplayer the host's ROOM_JOINED set is authoritative + re-clamped (T1-F), so
 * a hand-edited local blob can only ever affect that device's own offline play.
 */
export function loadStoredMotionSets() {
  let sets = {};
  try { sets = JSON.parse(localStorage.getItem(STORE_SETS) || '{}') || {}; } catch { sets = {}; }
  for (const id in sets) {
    const safe = {};
    for (const state in sets[id]) safe[state] = sanitizeMotion(sets[id][state], undefined, { allowGameplay: true });
    registerMotionSet(id, safe, { allowGameplay: true });
  }
  return sets;
}

/** The currently equipped custom motion-set id (or null). */
export function equippedMotionSetId() {
  try { return localStorage.getItem(STORE_EQUIP) || null; } catch { return null; }
}

/**
 * Fallback chain step 2 (localStorage canonical cache): load every cached
 * per-weapon canonical set into the registry at app start, so an offline / bot
 * match still uses the latest admin definitions seen on this device. Re-sanitized
 * with allowGameplay (still clamped). Firestore (step 3) overwrites these later.
 */
export function loadCanonicalWeaponCache() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(STORE_CANON) || '{}') || {}; } catch { map = {}; }
  for (const weapon in map) setCanonicalWeapon(weapon, map[weapon], { allowGameplay: true });
  return map;
}

/** Persist one weapon's canonical set into the localStorage cache. */
export function cacheCanonicalWeapon(weapon, set) {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(STORE_CANON) || '{}') || {}; } catch { map = {}; }
  map[weapon] = set;
  try { localStorage.setItem(STORE_CANON, JSON.stringify(map)); } catch {}
}

export class MotionEditor {
  constructor() {
    this.root = document.getElementById('motionEditor');
    if (!this.root) return;
    this.canvas = document.getElementById('meCanvas');
    this.timeline = document.getElementById('meTimeline');
    this.ctx = this.canvas?.getContext('2d');
    this.tctx = this.timeline?.getContext('2d');

    this.weapon = 'sword';
    this.userPresets = loadUserPresets();       // user-authored tagged motion presets
    this.customWeapons = loadCustomWeapons();   // user-uploaded weapon images (local)
    this._wimgCache = {};                       // id → HTMLImageElement
    this.mode = 'canonical';           // 'canonical' (admin) | 'workshop' (user weapon)
    this.stats = clampWorkshopStats({});
    this.blocks = null;                // workshop weapon's block-gimmick AST
    this.blockEditor = null;           // lazy BlockEditor instance
    this.look = equippedStickLook();   // stick appearance (live-applied + equipped)
    this.motion = null;          // working { duration, loop:false, keyframes, events }
    this.selKf = 0;
    this.playing = false;
    this.scrubT = 0;
    this.onion = true;          // stick-fighter onion skin: show the previous frame faintly
    this.dragHandle = null;
    this.dragKfIndex = -1;
    this.dragHitbox = null;     // 'move' | 'resize'
    this.dragEffect = null;     // 'move' | 'resize'
    this._selectedHitboxIndex = -1;
    this._selectedEffectIndex = -1;
    this._flipKeys = [];
    this._flipYKeys = [];
    this._leftFlipKeys = [];
    this._leftFlipYKeys = [];
    this._handSwapKeys = [];
    this._previewZoom = clamp(Number(localStorage.getItem('psd_me_preview_zoom')) || 1, 0.35, 3);
    this._pinch = null;
    this._frameOverviewOpen = false;
    this._frameOverviewSize = clamp(Number(localStorage.getItem(FRAME_OVERVIEW_SIZE_KEY)) || 72, 48, 128);
    this._frameOverviewHeight = clamp(Number(localStorage.getItem(FRAME_OVERVIEW_HEIGHT_KEY)) || 144, 96, 360);
    this._undoStack = [];
    this._undoLastSig = '';
    this._frameClipboard = null;
    this._raf = null;
    this._lastT = 0;

    this._wire();
  }

  _wire() {
    const $ = (id) => document.getElementById(id);
    $('meClose')?.addEventListener('click', () => this.close());
    $('meDelKf')?.addEventListener('click', () => this._delKeyframe());
    $('mePlay')?.addEventListener('click', () => this._togglePlay());
    // Frame-flip navigation (stick-fighter): page through keyframes one at a time.
    $('mePrevFrame')?.addEventListener('click', () => this._gotoFrame(-1));
    $('meNextFrame')?.addEventListener('click', () => this._gotoFrame(1));
    $('meNewFrame')?.addEventListener('click', () => this._newFrameCarry());
    $('meCopyFrame')?.addEventListener('click', () => this._copyFrame());
    $('mePasteFrame')?.addEventListener('click', () => this._pasteFrame());
    $('meOnion')?.addEventListener('click', () => { this.onion = !this.onion; this._syncOnionBtn(); this._renderPreview(); });
    this.root.addEventListener('input', (e) => this._captureUndoFromUiEvent(e), true);
    this.root.addEventListener('change', (e) => this._captureUndoFromUiEvent(e), true);
    this.root.addEventListener('click', (e) => this._captureUndoFromUiEvent(e), true);
    // ←/→ flip frames while the editor is open (not while typing / block editor up).
    window.addEventListener('keydown', (e) => {
      if (!this.root || this.root.classList.contains('hidden')) return;
      const be = document.getElementById('blockEditor');
      if (be && !be.classList.contains('hidden')) return;
      const tag = document.activeElement?.tagName || '';
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this._save();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this._undo();
        return;
      }
      if (/^(INPUT|TEXTAREA)$/.test(tag)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this._copyFrame();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        this._pasteFrame();
        return;
      }
      if (/^(SELECT)$/.test(tag)) return;
      if (e.key === 'ArrowLeft') { this._gotoFrame(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { this._gotoFrame(1); e.preventDefault(); }
    });
    $('meReset')?.addEventListener('click', () => this._loadTemplate());
    $('meSave')?.addEventListener('click', () => this._save());
    $('meUpload')?.addEventListener('click', () => { if (this.mode === 'workshop') this._uploadWorkshop(); else this._setStatus('업로드는 공방 무기에서만 가능합니다.'); });
    $('meTutReplay')?.addEventListener('click', () => this._tutStart());
    $('meFlipToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'right', 'x'));
    $('meFlipYToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'right', 'y'));
    $('meRightFlipToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'right', 'x'));
    $('meRightFlipYToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'right', 'y'));
    $('meLeftFlipToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'left', 'x'));
    $('meLeftFlipYToggle')?.addEventListener('click', () => this._toggleFlipAt(this.scrubT, 'left', 'y'));
    $('meHandSwapToggle')?.addEventListener('click', () => this._toggleHandSwapAt(this.scrubT));
    $('meFrameOverviewToggle')?.addEventListener('click', () => {
      this._frameOverviewOpen = !this._frameOverviewOpen;
      this._renderFrameOverview();
    });
    $('meFrameOverviewSize')?.addEventListener('input', (e) => this._setFrameOverviewSize(parseFloat(e.target.value)));
    $('meFrameOverviewSmaller')?.addEventListener('click', () => this._setFrameOverviewSize(this._frameOverviewSize - 4));
    $('meFrameOverviewLarger')?.addEventListener('click', () => this._setFrameOverviewSize(this._frameOverviewSize + 4));
    $('meFrameOverviewHeight')?.addEventListener('input', (e) => this._setFrameOverviewHeight(parseFloat(e.target.value)));
    $('meFrameOverviewLower')?.addEventListener('click', () => this._setFrameOverviewHeight(this._frameOverviewHeight - 12));
    $('meFrameOverviewHigher')?.addEventListener('click', () => this._setFrameOverviewHeight(this._frameOverviewHeight + 12));
    $('meFrameOverviewResize')?.addEventListener('pointerdown', (e) => {
      this.dragFrameOverviewHeight = { y: e.clientY, h: this._frameOverviewHeight || 144 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    $('meEffectAdd')?.addEventListener('click', () => this._addEffect());
    $('meEffectAsset')?.addEventListener('change', (e) => this._updateSelectedEffect('assetId', e.target.value));
    $('meEffectFileBtn')?.addEventListener('click', () => $('meEffectFile')?.click());
    $('meEffectFile')?.addEventListener('change', (e) => this._onEffectFile(e));
    $('meEffectStartFrame')?.addEventListener('change', (e) => this._updateSelectedEffectFrame('start', parseInt(e.target.value, 10)));
    $('meEffectEndFrame')?.addEventListener('change', (e) => this._updateSelectedEffectFrame('end', parseInt(e.target.value, 10)));
    $('meEffectRot')?.addEventListener('input', (e) => this._updateSelectedEffect('rotation', parseFloat(e.target.value)));
    $('meEffectAlpha')?.addEventListener('input', (e) => this._updateSelectedEffect('alpha', parseFloat(e.target.value)));
    $('meEffectFlipX')?.addEventListener('change', (e) => this._updateSelectedEffect('flipX', !!e.target.checked));
    $('meEffectFlipY')?.addEventListener('change', (e) => this._updateSelectedEffect('flipY', !!e.target.checked));
    $('meDualWield')?.addEventListener('change', (e) => {
      if (!this._editingV2) return;
      const dual = !!e.target.checked;
      const visual = { ...(this._editingV2.weaponVisual || { imageId: null, scale: 1 }), dual };
      if (dual && !visual.offhand) visual.offhand = { imageId: visual.imageId || this.weapon || 'sword', scale: visual.scale || 1 };
      this._editingV2.weaponVisual = visual;
      this._syncDualControls();
      if (dual) setTimeout(() => this._openDualWeaponPicker(), 0);
      this._renderPreview();
    });
    $('meDualWeapon')?.addEventListener('change', (e) => this._setOffhandWeapon(e.target.value));
    $('meDualPickBtn')?.addEventListener('click', () => this._openDualWeaponPicker());
    $('meDualWeaponSize')?.addEventListener('input', (e) => this._setOffhandSize(parseFloat(e.target.value)));
    $('meDualAnchorBtn')?.addEventListener('click', () => {
      const c = this._customWeapon(this._offhandId());
      if (c) this._openAnchorPicker(c.src, c.name, c, { offhand: true });
    });
    $('meHatAdd')?.addEventListener('click', () => $('meHatFile')?.click());
    $('meHatFile')?.addEventListener('change', (e) => this._onHatFile(e));
    $('meHatClear')?.addEventListener('click', () => this._removeSelectedHat());
    $('meHatSlots')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-hat-slot]');
      if (btn) this._selectHat(Number(btn.dataset.hatSlot));
      const del = e.target.closest('[data-hat-remove]');
      if (del) { this._selectHat(Number(del.dataset.hatRemove)); this._removeSelectedHat(); }
      const anch = e.target.closest('[data-hat-anchor]');
      if (anch) this._openHatAnchor(Number(anch.dataset.hatAnchor));
    });
    $('meHatSlots')?.addEventListener('input', (e) => {
      const input = e.target.closest('[data-hat-field]');
      if (!input) return;
      if (input.dataset.hatText) return;
      const index = Number(input.dataset.hatIndex);
      const field = input.dataset.hatField;
      const value = input.type === 'checkbox' ? input.checked : (input.dataset.hatText ? input.value : parseFloat(input.value));
      this._updateHatAt(index, field, value, { sync: false });
    });
    $('meHatSlots')?.addEventListener('change', (e) => {
      const input = e.target.closest('[data-hat-field]');
      if (!input) return;
      const index = Number(input.dataset.hatIndex);
      const field = input.dataset.hatField;
      const value = input.type === 'checkbox' ? input.checked : (input.dataset.hatText ? input.value : parseFloat(input.value));
      this._updateHatAt(index, field, value);
    });
    $('meLayerBlock')?.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-layer-item]');
      if (!row) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.layerItem);
    });
    $('meLayerBlock')?.addEventListener('dragend', () => {
      document.querySelectorAll('.me-layer-hover-before,.me-layer-hover-after').forEach(n => n.classList.remove('me-layer-hover-before', 'me-layer-hover-after'));
    });
    $('meLayerBlock')?.addEventListener('dragover', (e) => {
      const row = e.target.closest('[data-layer-item]');
      if (!row) return;
      e.preventDefault();
      document.querySelectorAll('.me-layer-hover-before,.me-layer-hover-after').forEach(n => n.classList.remove('me-layer-hover-before', 'me-layer-hover-after'));
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY > rect.top + rect.height / 2 ? 'me-layer-hover-after' : 'me-layer-hover-before');
    });
    $('meLayerBlock')?.addEventListener('dragleave', (e) => {
      const row = e.target.closest('[data-layer-item]');
      if (row) row.classList.remove('me-layer-hover-before', 'me-layer-hover-after');
    });
    $('meLayerBlock')?.addEventListener('drop', (e) => {
      const target = e.target.closest('[data-layer-item]');
      if (!target) return;
      e.preventDefault();
      document.querySelectorAll('.me-layer-hover-before,.me-layer-hover-after').forEach(n => n.classList.remove('me-layer-hover-before', 'me-layer-hover-after'));
      const rect = target.getBoundingClientRect();
      const dropIndex = Number(target.dataset.layerIndex) + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
      this._moveLayerItem(e.dataTransfer.getData('text/plain'), dropIndex);
    });
    $('meHatX')?.addEventListener('input', (e) => this._updateHat('offsetX', parseFloat(e.target.value)));
    $('meHatY')?.addEventListener('input', (e) => this._updateHat('offsetY', parseFloat(e.target.value)));
    $('meHatScale')?.addEventListener('input', (e) => this._updateHat('scale', parseFloat(e.target.value)));
    $('meHatAlpha')?.addEventListener('input', (e) => this._updateHat('alpha', parseFloat(e.target.value)));
    // Ranged / projectile controls (per combat preset).
    $('ms_ranged')?.addEventListener('change', (e) => this._setRanged(e.target.checked));
    const pjInput = (id, field, num) => $(id)?.addEventListener('input', (e) => this._setProjectile(field, num ? parseFloat(e.target.value) : e.target.value));
    pjInput('pj_imageId', 'imageId', false); pjInput('pj_directionSource', 'directionSource', false);
    pjInput('pj_speed', 'speed', true); pjInput('pj_lifetimeMs', 'lifetimeMs', true); pjInput('pj_scale', 'scale', true);
    $('pj_angle')?.addEventListener('input', (e) => this._setProjectileAngle(parseFloat(e.target.value)));
    $('pj_angle_text')?.addEventListener('change', (e) => this._setProjectileAngle(parseFloat(String(e.target.value).replace(/[^\d.-]/g, '')) || 0));
    $('pj_angle_text')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._setProjectileAngle(parseFloat(String(e.target.value).replace(/[^\d.-]/g, '')) || 0);
        e.target.blur();
      }
    });
    $('pj_pierce')?.addEventListener('change', (e) => this._setProjectile('pierce', e.target.checked));
    $('pj_rotation_btn')?.addEventListener('click', () => this._openProjectileRotation());
    $('pjRotationClose')?.addEventListener('click', () => this._closeProjectileRotation());
    $('pjRotationReset')?.addEventListener('click', () => this._setProjectileRotation(0));
    $('pjRotationRange')?.addEventListener('input', (e) => this._setProjectileRotation(parseFloat(e.target.value)));
    $('pjRotationText')?.addEventListener('change', (e) => this._setProjectileRotation(parseFloat(String(e.target.value).replace(/[^\d.-]/g, '')) || 0));
    $('pjRotationText')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._setProjectileRotation(parseFloat(String(e.target.value).replace(/[^\d.-]/g, '')) || 0);
        e.target.blur();
      }
    });
    $('pj_hb_width')?.addEventListener('input', (e) => this._setProjectileHb('width', parseFloat(e.target.value)));
    $('pj_hb_height')?.addEventListener('input', (e) => this._setProjectileHb('height', parseFloat(e.target.value)));
    $('pj_hb_radius')?.addEventListener('input', (e) => this._setProjectileHb('radius', parseFloat(e.target.value)));
    $('pj_shape_rect')?.addEventListener('click', () => this._setProjectileHb('shape', 'rect'));
    $('pj_shape_circle')?.addEventListener('click', () => this._setProjectileHb('shape', 'circle'));
    $('pj_event_add')?.addEventListener('click', () => this._addProjectileEvent());
    $('tp_event_add')?.addEventListener('click', () => this._addTeleportEvent());
    $('tp_directionSource')?.addEventListener('change', () => this._syncFrameEventLists());
    $('tp_distance')?.addEventListener('input', () => this._syncFrameEventLists());
    $('meCapture')?.addEventListener('click', () => this._capture());
    $('meAddHitbox')?.addEventListener('click', () => this._toggleHitbox());
    $('meHitboxDamage')?.addEventListener('change', (e) => this._setHitboxDamage(e.target.value));
    $('meHitboxDamage')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } });
    const dur = $('meDuration');
    dur?.addEventListener('input', () => this._setDuration(parseFloat(dur.value) || 0.5));
    $('meDurationText')?.addEventListener('change', (e) => this._setDuration(parseFloat(String(e.target.value).replace(/[^\d.]/g, '')) || this.motion?.duration || 0.5));
    $('meDurationText')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._setDuration(parseFloat(String(e.target.value).replace(/[^\d.]/g, '')) || this.motion?.duration || 0.5);
        e.target.blur();
      }
    });
    $('meDurationDown')?.addEventListener('click', () => this._setDuration((this.motion?.duration || 0.5) - 0.01));
    $('meDurationUp')?.addEventListener('click', () => this._setDuration((this.motion?.duration || 0.5) + 0.01));
    const wsel = $('meWeapon');
    if (wsel) {
      this._populateWeaponSelect();
      wsel.addEventListener('change', () => { this.weapon = wsel.value; this._syncWeaponUI(); this._loadTemplate(); });
    }
    // Custom weapon image: add / resize / delete.
    $('meAddWeapon')?.addEventListener('click', () => $('meWeaponFile')?.click());
    $('meWeaponFile')?.addEventListener('change', (e) => this._onWeaponFile(e));
    $('meWeaponSize')?.addEventListener('input', (e) => {
      const c = this._customWeapon(this.weapon); if (!c) return;
      c.size = clamp(parseFloat(e.target.value) || 2, 0.6, 4.5); saveCustomWeapons(this.customWeapons); this._renderPreview();
    });
    $('meDelWeapon')?.addEventListener('click', () => this._delCustomWeapon());
    // Anchor picker (grip + tip on the weapon image).
    $('meAnchorBtn')?.addEventListener('click', () => { const c = this._customWeapon(this.weapon); if (c) this._openAnchorPicker(c.src, c.name, c); });
    $('meAnchorOk')?.addEventListener('click', () => this._anchorConfirm());
    $('meAnchorCancel')?.addEventListener('click', () => this._anchorClose());
    const acv = $('meAnchorCanvas');
    if (acv) {
      acv.addEventListener('pointerdown', (e) => this._anchorDown(e));
      acv.addEventListener('pointermove', (e) => this._anchorMove(e));
      window.addEventListener('pointerup', () => { if (this._anchor) this._anchor.drag = null; });
    }
    // Preset library: the user's own tagged motions (save current → library;
    // click → load; ★ = equipped for its tag; built-ins remain as 예시).
    const tagSel = $('mePresetTag');
    if (tagSel) tagSel.innerHTML = MOTION_TAGS.map(t => `<option value="${t.key}">${t.label}</option>`).join('');
    $('mePresetSave')?.addEventListener('click', () => this._savePreset());
    this._renderPresetList();
    // Appearance controls (Phase E): live-apply + persist the equipped look.
    const applyLook = (patch) => {
      this.look = saveStickLook({ ...this.look, ...patch });
      this._renderPreview();
    };
    // Workshop stat sliders (Tier 2): live-clamp into the envelope + budget bar.
    STAT_KEYS.forEach(k => $('ms_' + k)?.addEventListener('input', (e) => this._updateStat(k, parseFloat(e.target.value))));
    $('ms_dashDistance')?.addEventListener('input', (e) => this._updateStat('dashDistance', parseFloat(e.target.value)));
    $('ms_heavyAfter')?.addEventListener('input', (e) => this._setHeavyAfter(parseInt(e.target.value, 10)));
    $('ms_ultimateGain')?.addEventListener('input', (e) => this._updateStat('ultimateGain', parseFloat(e.target.value)));
    $('ms_airborneHeight')?.addEventListener('input', (e) => this._updateStat('airborneHeight', parseFloat(e.target.value)));
    $('ms_status')?.addEventListener('change', (e) => this._updateStat('status', e.target.value));
    $('mePresetDisplayName')?.addEventListener('input', (e) => this._setPresetDisplayName(e.target.value));
    $('meColor')?.addEventListener('input', (e) => applyLook({ color: e.target.value }));
    $('meColorClear')?.addEventListener('click', () => applyLook({ color: null }));
    $('meLineW')?.addEventListener('input', (e) => applyLook({ lineW: parseInt(e.target.value, 10) }));
    $('meHead')?.addEventListener('change', (e) => applyLook({ head: e.target.value }));
    $('meAccessory')?.addEventListener('change', (e) => applyLook({ accessory: e.target.value }));

    // Preview canvas: drag joint handles.
    this.canvas?.addEventListener('pointerdown', (e) => this._previewDown(e));
    this.canvas?.addEventListener('wheel', (e) => this._previewWheel(e), { passive: false });
    this.canvas?.addEventListener('touchstart', (e) => this._previewTouchStart(e), { passive: false });
    this.canvas?.addEventListener('touchmove', (e) => this._previewTouchMove(e), { passive: false });
    this.canvas?.addEventListener('touchend', () => { this._pinch = null; });
    $('meZoomIn')?.addEventListener('click', () => this._setPreviewZoom(this._previewZoom * 1.15));
    $('meZoomOut')?.addEventListener('click', () => this._setPreviewZoom(this._previewZoom / 1.15));
    $('mePresetComplete')?.addEventListener('click', () => { this._togglePresetComplete(this._activeKey); this._tutEvent('preset'); });
    window.addEventListener('pointermove', (e) => this._pointerMove(e));
    window.addEventListener('pointerup', () => this._pointerUp());
    // Timeline: scrub / select / drag keyframe / hitbox windows.
    this.timeline?.addEventListener('pointerdown', (e) => this._timelineDown(e));
    // Resizable columns: drag splitters, collapse under threshold, header chips.
    this._initLayout();
  }

  // --- Undo / hotkeys --------------------------------------------------------
  _cloneState(v) {
    try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
    catch { try { return JSON.parse(JSON.stringify(v)); } catch { return null; } }
  }
  _snapshotState() {
    if (!this.motion) return null;
    return {
      mode: this.mode,
      weapon: this.weapon,
      customWeapons: this._cloneState(this.customWeapons) || [],
      editingV2: this._cloneState(this._editingV2) || null,
      editingId: this._editingId || null,
      activeKey: this._activeKey || null,
      motion: this._cloneState(this.motion),
      blocks: this._cloneState(this.blocks),
      flipKeys: this._cloneState(this._flipKeys || []) || [],
      flipYKeys: this._cloneState(this._flipYKeys || []) || [],
      leftFlipKeys: this._cloneState(this._leftFlipKeys || []) || [],
      leftFlipYKeys: this._cloneState(this._leftFlipYKeys || []) || [],
      handSwapKeys: this._cloneState(this._handSwapKeys || []) || [],
      previewOffset: this._cloneState(this._previewOffset || { x: 0, y: 0 }) || { x: 0, y: 0 },
      look: this._cloneState(this.look) || equippedStickLook(),
      stats: this._cloneState(this.stats) || clampWorkshopStats({}),
      selKf: this.selKf || 0,
      scrubT: this.scrubT || 0,
      selectedHitboxIndex: this._selectedHitboxIndex,
      selectedEffectIndex: this._selectedEffectIndex,
    };
  }
  _stateSig(s) {
    try { return JSON.stringify(s); } catch { return ''; }
  }
  _pushUndo(label = 'edit') {
    if (this._restoringUndo) return;
    const snap = this._snapshotState();
    if (!snap) return;
    const sig = this._stateSig(snap);
    if (!sig || sig === this._undoLastSig) return;
    this._undoStack.push({ label, snap, sig });
    if (this._undoStack.length > 80) this._undoStack.shift();
    this._undoLastSig = sig;
  }
  _captureUndoFromUiEvent(e) {
    if (!this.root || this.root.classList.contains('hidden') || this._restoringUndo) return;
    const el = e.target?.closest?.('button,input,select,textarea,[data-hat-field],[data-layer-item]');
    if (!el) return;
    const id = el.id || '';
    if (/^(meSave|meUpload|meClose|mePlay|meTut|mePrevFrame|meNextFrame|meFrameOverview|meAnchorCancel)$/.test(id)) return;
    this._pushUndo(id || e.type);
  }
  _undo() {
    if (!this._undoStack.length) { this._setStatus('되돌릴 편집 기록이 없습니다.'); return; }
    const entry = this._undoStack.pop();
    const s = entry.snap;
    this._restoringUndo = true;
    this.mode = s.mode || this.mode;
    this.weapon = s.weapon || 'sword';
    this.customWeapons = Array.isArray(s.customWeapons) ? s.customWeapons : [];
    saveCustomWeapons(this.customWeapons);
    this._wimgCache = {};
    this._editingV2 = s.editingV2 || this._editingV2 || null;
    this._editingId = s.editingId || this._editingV2?.id || null;
    this._activeKey = s.activeKey || this._activeKey;
    this.motion = sanitizeMotion(s.motion, undefined, { allowGameplay: true });
    this.blocks = s.blocks || null;
    this._flipKeys = Array.isArray(s.flipKeys) ? s.flipKeys : [];
    this._flipYKeys = Array.isArray(s.flipYKeys) ? s.flipYKeys : [];
    this._leftFlipKeys = Array.isArray(s.leftFlipKeys) ? s.leftFlipKeys : [];
    this._leftFlipYKeys = Array.isArray(s.leftFlipYKeys) ? s.leftFlipYKeys : [];
    this._handSwapKeys = Array.isArray(s.handSwapKeys) ? s.handSwapKeys : [];
    this._previewOffset = s.previewOffset || { x: 0, y: 0 };
    this.look = s.look || equippedStickLook();
    this.stats = s.stats || clampWorkshopStats({});
    this.selKf = clamp(Number(s.selKf) || 0, 0, Math.max(0, (this.motion?.keyframes?.length || 1) - 1));
    this.scrubT = Number.isFinite(Number(s.scrubT)) ? Number(s.scrubT) : (this.motion?.keyframes?.[this.selKf]?.t || 0);
    this._selectedHitboxIndex = Number.isFinite(Number(s.selectedHitboxIndex)) ? Number(s.selectedHitboxIndex) : -1;
    this._selectedEffectIndex = Number.isFinite(Number(s.selectedEffectIndex)) ? Number(s.selectedEffectIndex) : -1;
    this.playing = false;
    const play = document.getElementById('mePlay'); if (play) play.textContent = '▶ 재생';
    this._populateWeaponSelect();
    this._syncWeaponUI();
    this._syncBaseSliders();
    const p = this._activePreset();
    if (p && COMBAT_PRESET_KINDS.has(this._activeKey)) { this._syncCombatSliders(this._combatForCurrentFrame(p)); this._syncProjectilePanel(p); }
    this._renderPresetBar();
    this._renderEffectList();
    this._syncFrameEventLists();
    this._renderBudget();
    this._updateBlockCount();
    this._renderAll();
    this._undoLastSig = this._stateSig(this._snapshotState());
    this._restoringUndo = false;
    this._setStatus(`되감기 완료: ${entry.label}`);
  }

  // --- Resizable / collapsible columns --------------------------------------
  _ensureLayoutStyles() {
    if (document.getElementById('meLayoutStyles')) return;
    const st = document.createElement('style'); st.id = 'meLayoutStyles';
    st.textContent = `
    .me-split{width:6px;flex:none;align-self:stretch;cursor:col-resize;border-radius:3px;background:#3f3f46;opacity:.55;transition:opacity .12s,background .12s;touch-action:none}
    .me-split:hover,.me-split.on{opacity:1;background:#7df09a}
    .me-col-collapsed{width:32px !important}
    .me-col-collapsed>*{display:none !important}
    .me-col-collapsed>.me-expand-rail{display:flex !important}
    .me-expand-rail{display:none;flex:1;flex-direction:column;align-items:center;gap:8px;background:#0d0a06;border:1px solid #3f3f46;border-radius:6px;cursor:pointer;padding-top:8px;color:#7df09a;font-size:13px}
    .me-expand-rail:hover{border-color:#7df09a}
    .me-expand-rail .vlabel{writing-mode:vertical-rl;font-size:10px;color:#9ca3af;letter-spacing:2px}
    .me-cat-head{display:flex;align-items:center;gap:6px;justify-content:flex-end;min-height:22px;margin:-2px -2px 4px -2px;flex:0 0 auto}
    .me-cat-title{display:none;min-width:0;flex:1;color:#ffd24a;font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .me-cat-toggle{width:22px;height:22px;border:1px solid #3f3f46;background:#14100b;color:#ffd24a;font-size:11px;line-height:20px;flex:0 0 auto}
    .me-cat-toggle:hover{border-color:#ffd24a;background:#1c1710}
    .me-cat-body{display:contents}
    .me-cat-collapsed>.me-cat-head{margin-bottom:0}
    .me-cat-collapsed>.me-cat-head>.me-cat-title{display:block}
    .me-cat-collapsed>.me-cat-head>.me-cat-toggle{color:#7df09a}
    .me-cat-collapsed>.me-cat-body{display:none}
    [data-layer-item].me-layer-hover-before{box-shadow:inset 0 2px 0 #7df09a}
    [data-layer-item].me-layer-hover-after{box-shadow:inset 0 -2px 0 #7df09a}
    #meTutScrim{position:absolute;inset:0;z-index:94;pointer-events:none}
    #meTutScrim .tut-block{position:absolute;background:rgba(0,0,0,.72);pointer-events:auto;transition:opacity .12s ease}
    #meTutScrim .tut-ring{position:absolute;z-index:1;pointer-events:none;box-sizing:border-box;border:4px solid #ffd24a;border-radius:10px;box-shadow:0 0 24px rgba(255,210,74,.82),inset 0 0 0 1px rgba(255,210,74,.45);transition:opacity .12s ease;opacity:0}
    #meTutCard{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:98;width:min(540px,92%);background:#1a1410;border:2px solid #ffd24a;border-radius:8px;padding:12px 16px;box-shadow:0 6px 24px rgba(0,0,0,.65);font-family:monospace;transition:left .24s ease,top .24s ease,bottom .18s ease,transform .24s ease,opacity .18s ease}
    .me-tut-hi{position:relative !important;z-index:97 !important;border-radius:8px}
    .me-tut-title{color:#ffd24a;font-size:13px;font-weight:800}
    .me-tut-copy{color:#efe7d8;font-size:12px;line-height:1.62}
    .me-tut-em{color:#ffe36a;background:rgba(255,210,74,.14);border:1px solid rgba(255,210,74,.28);border-radius:4px;padding:0 3px;font-weight:800}
    .me-tut-action{margin-top:8px;border:1px solid rgba(255,210,74,.5);background:#21170e;color:#ffd24a;font-size:12px;line-height:1.48;padding:7px 9px;animation:meTutTextIn .24s ease both}
    .me-tut-anim{animation:meTutTextIn .24s ease both}
    .me-tut-decline{flex:1;background:#2a0f12;border:1px solid #ff5a5a;color:#ffd6d6;font-size:11px;padding:8px 10px;cursor:pointer;animation:meTutDeclineIn .32s ease both;transition:background .18s,border-color .18s,color .18s,transform .12s}
    .me-tut-decline:hover{background:#4a151b;border-color:#ff8a8a;color:#fff}
    .me-tut-decline:active{transform:scale(.985)}
    .me-tut-decline span{display:inline-block;animation:meTutLabelSwap .28s ease both}
    @keyframes meTutTextIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    @keyframes meTutDeclineIn{from{background:#14100b;border-color:#6b6156;color:#8a8175}to{background:#2a0f12;border-color:#ff5a5a;color:#ffd6d6}}
    @keyframes meTutLabelSwap{from{opacity:0;transform:translateY(4px);letter-spacing:.08em}to{opacity:1;transform:translateY(0);letter-spacing:0}}
    @media(max-width:640px){#motionEditor{padding-bottom:55vh!important;scroll-padding-top:16vh;scroll-padding-bottom:45vh}}`;
    document.head.appendChild(st);
  }

  // --- First-run workshop tutorial (goal: make one weapon) -------------------
  _formatTutText(text) {
    const terms = [
      '저장 + 장착', '＋ 현재 프레임 판정', '＋ 새 프레임', '＋ 이펙트',
      '초록 관절점', '주황 무기점', '빨간 골반점', '빨간 상자',
      '프레임 몰아보기', '좌우/상하 반전', '첫 1개 무료',
      '히트박스', '이펙트', '발사체', '텔레포트', '예산 100',
      '워크샵', '업로드', '대미지', '쿨타임', '넉백', '상태이상',
      'PC', '태블릿', '100화폐',
    ];
    const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|\\d+화폐|\\d+프레임)`, 'g');
    return escOpt(text).replace(pattern, '<strong class="me-tut-em">$1</strong>');
  }

  _tutScrimParts() {
    const scrim = document.getElementById('meTutScrim');
    if (!scrim) return { blocks: [], ring: null };
    let blocks = Array.from(scrim.querySelectorAll('.tut-block'));
    if (blocks.length !== 4) {
      blocks.forEach((b) => b.remove());
      blocks = Array.from({ length: 4 }, () => {
        const el = document.createElement('div');
        el.className = 'tut-block';
        scrim.appendChild(el);
        return el;
      });
    }
    let ring = scrim.querySelector('.tut-ring');
    if (!ring) {
      ring = document.createElement('div');
      ring.className = 'tut-ring';
      scrim.appendChild(ring);
    }
    return { blocks, ring };
  }

  _setTutSpotlight(target) {
    const scrim = document.getElementById('meTutScrim');
    if (!scrim || !this.root) return;
    const { blocks, ring } = this._tutScrimParts();
    if (blocks.length !== 4) return;
    const rootRect = this.root.getBoundingClientRect();
    const rootW = Math.max(1, rootRect.width);
    const rootH = Math.max(1, rootRect.height);
    if (!target) {
      Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${rootW}px`, height: `${rootH}px` });
      for (let i = 1; i < 4; i++) Object.assign(blocks[i].style, { left: '0px', top: '0px', width: '0px', height: '0px' });
      if (ring) ring.style.opacity = '0';
      this._positionTutCard(null);
      return;
    }
    const rect = this._tutTargetRect(target, rootRect);
    if (!rect) {
      this._setTutSpotlight(null);
      return;
    }
    const pad = 12;
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const right = Math.min(rootW, rect.right + pad);
    const bottom = Math.min(rootH, rect.bottom + pad);
    const holeW = Math.max(0, right - left);
    const holeH = Math.max(0, bottom - top);
    Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${rootW}px`, height: `${top}px` });
    Object.assign(blocks[1].style, { left: '0px', top: `${bottom}px`, width: `${rootW}px`, height: `${Math.max(0, rootH - bottom)}px` });
    Object.assign(blocks[2].style, { left: '0px', top: `${top}px`, width: `${left}px`, height: `${holeH}px` });
    Object.assign(blocks[3].style, { left: `${right}px`, top: `${top}px`, width: `${Math.max(0, rootW - right)}px`, height: `${holeH}px` });
    if (!holeW || !holeH) Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${rootW}px`, height: `${rootH}px` });
    if (ring) Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${holeW}px`, height: `${holeH}px`, opacity: holeW && holeH ? '1' : '0' });
    this._positionTutCard({ left, top, right, bottom });
  }

  _tutTargetRect(target, rootRect) {
    if (!target || !rootRect) return null;
    let rect = target.getBoundingClientRect();
    if ((!rect.width || !rect.height) && typeof target.getBoxQuads === 'function') {
      try {
        const q = target.getBoxQuads({ box: 'border' })?.[0];
        if (q) {
          const xs = [q.p1.x, q.p2.x, q.p3.x, q.p4.x];
          const ys = [q.p1.y, q.p2.y, q.p3.y, q.p4.y];
          rect = new DOMRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        }
      } catch {}
    }
    if (!rect.width || !rect.height) return null;
    const left = Math.round(rect.left - rootRect.left);
    const top = Math.round(rect.top - rootRect.top);
    const right = Math.round(rect.right - rootRect.left);
    const bottom = Math.round(rect.bottom - rootRect.top);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  _positionTutCard(rect) {
    const card = document.getElementById('meTutCard');
    if (!card || !this.root) return;
    if (!rect) {
      Object.assign(card.style, { left: '50%', top: '', bottom: '14px', transform: 'translateX(-50%)' });
      return;
    }
    const rootRect = this.root.getBoundingClientRect();
    const rootW = Math.max(1, rootRect.width);
    const rootH = Math.max(1, rootRect.height);
    const gap = 14;
    const margin = 10;
    const cr = card.getBoundingClientRect();
    const width = Math.min(cr.width || 540, rootW - margin * 2);
    const height = cr.height || 130;
    let x = (rect.left + rect.right) / 2 - width / 2;
    x = Math.max(margin, Math.min(rootW - width - margin, x));
    let y = rect.bottom + gap;
    if (y + height > rootH - margin) y = rect.top - height - gap;
    if (y < margin) y = Math.max(margin, rootH - height - margin);
    Object.assign(card.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', transform: 'none' });
  }

  _scheduleTutSpotlight(target, step) {
    const stepIndex = this._tut?.step;
    const sync = () => {
      if (!this._tut || this._tut.step !== stepIndex) return;
      document.querySelectorAll('.me-tut-hi').forEach((n) => n.classList.remove('me-tut-hi'));
      const activeStep = ME_TUT_STEPS[this._tut.step];
      if (step && activeStep !== step) return;
      const current = step?.target ? document.getElementById(step.target) : null;
      current?.classList.add('me-tut-hi');
      this._setTutSpotlight(current || target || null);
    };
    requestAnimationFrame(() => requestAnimationFrame(sync));
  }

  _tutStart() {
    this._tutStop();
    this._ensureLayoutStyles();
    this._tut = { step: 0 };
    let scrim = document.getElementById('meTutScrim');
    if (!scrim) { scrim = document.createElement('div'); scrim.id = 'meTutScrim'; this.root.appendChild(scrim); }
    let card = document.getElementById('meTutCard');
    if (!card) { card = document.createElement('div'); card.id = 'meTutCard'; this.root.appendChild(card); }
    this._tutRender();
  }
  _tutRender() {
    const card = document.getElementById('meTutCard');
    if (!card || !this._tut) return;
    const i = this._tut.step, s = ME_TUT_STEPS[i];
    if (!s) return this._tutFinish();
    const dots = ME_TUT_STEPS.map((_, k) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${k < i ? '#7df09a' : k === i ? '#ffd24a' : '#4b4237'}"></span>`).join('');
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span>${dots}</span>
        <b class="me-tut-title">${escOpt(s.title)}</b>
        <span style="margin-left:auto;color:#8a8175;font-size:10px">${i + 1} / ${ME_TUT_STEPS.length}</span>
      </div>
      <div class="me-tut-copy me-tut-anim">${this._formatTutText(s.text)}</div>
      ${s.action ? `<div class="me-tut-action">다음 단계: ${this._formatTutText(s.action)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="meTutSkip" class="me-tut-decline"><span>무기 공방 튜토리얼 보지 않기</span></button>
      </div>`;
    card.querySelector('#meTutSkip').addEventListener('click', () => this._tutFinish());
    // Highlight the step's target (expanding its column if it's folded away).
    document.querySelectorAll('.me-tut-hi').forEach((n) => n.classList.remove('me-tut-hi'));
    const target = document.getElementById(s.target);
    if (target) {
      const col = target.closest('.me-col-collapsed');
      if (col && this._cols) for (const key of ['left', 'right']) if (this._cols[key].el === col) this._expandCol(key);
      target.scrollIntoView?.({ behavior: 'smooth', block: window.innerWidth <= 640 ? 'center' : 'nearest', inline: 'nearest' });
      this._scheduleTutSpotlight(target, s);
    } else {
      this._setTutSpotlight(null);
    }
  }
  /** Auto-advance: handlers report what the user just did. */
  _tutEvent(kind) {
    if (!this._tut) return;
    const s = ME_TUT_STEPS[this._tut.step];
    if (s && s.auto === kind) this._tutNext();
  }
  _tutNext() {
    if (!this._tut) return;
    this._tut.step++;
    if (this._tut.step >= ME_TUT_STEPS.length) this._tutFinish();
    else this._tutRender();
  }
  _tutFinish() {
    try { localStorage.setItem(ME_TUT_KEY, '1'); } catch {}
    this._tutStop();
    this._setStatus('🎉 튜토리얼 완료! 이제 프리셋 태그·⚓기준점까지 자유롭게 실험해 보세요.');
  }
  /** Tear down without marking done (e.g., editor closed mid-way). */
  _tutStop() {
    this._tut = null;
    document.getElementById('meTutCard')?.remove();
    document.getElementById('meTutScrim')?.remove();
    document.querySelectorAll('.me-tut-hi').forEach((n) => n.classList.remove('me-tut-hi'));
  }

  _initLayout() {
    this._ensureLayoutStyles();
    const L = document.getElementById('meColLeft'), R = document.getElementById('meColRight');
    if (!L || !R) return;
    this._cols = {
      left:  { el: L, split: document.getElementById('meSplitL'), side: 1,  label: '컨트롤', arrow: '▶', def: 0.34 },
      right: { el: R, split: document.getElementById('meSplitR'), side: -1, label: '무기 · 스탯', arrow: '◀', def: 0.27 },
    };
    for (const key of ['left', 'right']) {
      const c = this._cols[key];
      // Collapsed state renders as a thin rail — click anywhere on it to expand.
      const rail = document.createElement('div');
      rail.className = 'me-expand-rail'; rail.title = '클릭하여 펼치기';
      rail.innerHTML = `<b>${c.arrow}</b><span class="vlabel">${c.label} 펼치기</span>`;
      rail.addEventListener('click', () => this._expandCol(key));
      c.el.appendChild(rail);
      // Splitter: drag = resize (collapses under the threshold); dblclick = toggle.
      c.split?.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { c.split.setPointerCapture(e.pointerId); } catch {}
        c.split.classList.add('on');
        const startX = e.clientX;
        const startW = c.el.classList.contains('me-col-collapsed') ? 32 : c.el.getBoundingClientRect().width;
        const parentW = c.el.parentElement.getBoundingClientRect().width;
        const move = (ev) => this._setColWidth(key, startW + (ev.clientX - startX) * c.side, parentW);
        const up = () => { c.split.classList.remove('on'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); this._saveLayout(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      c.split?.addEventListener('dblclick', () => c.el.classList.contains('me-col-collapsed') ? this._expandCol(key) : this._collapseCol(key));
    }
    this._applyLayout(this._loadLayout());
    this._initCategoryToggles();
  }

  _initCategoryToggles() {
    const cols = [document.getElementById('meColLeft'), document.getElementById('meColRight')].filter(Boolean);
    cols.forEach((col) => Array.from(col.children).forEach((box, i) => {
      if (!box || box.classList.contains('me-expand-rail') || box.querySelector(':scope > .me-cat-head')) return;
      if (!box.className || !String(box.className).includes('border')) return;
      const titleText = this._categoryTitleForBox(box, i, col.id);
      const head = document.createElement('div');
      head.className = 'me-cat-head';
      const title = document.createElement('span');
      title.className = 'me-cat-title';
      title.textContent = titleText;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'me-cat-toggle';
      btn.textContent = '▾';
      btn.title = '카테고리 접기 / 펼치기';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        box.classList.toggle('me-cat-collapsed');
        btn.textContent = box.classList.contains('me-cat-collapsed') ? '▸' : '▾';
      });
      const body = document.createElement('div');
      body.className = 'me-cat-body';
      while (box.firstChild) body.appendChild(box.firstChild);
      head.appendChild(title);
      head.appendChild(btn);
      box.appendChild(head);
      box.appendChild(body);
    }));
  }

  _categoryTitleForBox(box, index = 0, colId = '') {
    const directTitle = Array.from(box.children).find((el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (!['h1', 'h2', 'h3', 'h4', 'b', 'strong', 'label'].includes(tag)) return false;
      return (el.textContent || '').trim();
    });
    const text = (directTitle?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 28);
    const idMap = {
      meBlockPreset: '프리셋',
      meBlockAppearance: '외형',
      meBlockLayers: '레이어',
      meBlockTimeline: '타임라인',
      meBlockFrames: '프레임 몰아보기',
      meBlockStats: '무기 스탯',
      meBlockSkillStats: '스킬 스탯',
      meBlockDecorations: '장식',
      meBlockEffects: '이펙트',
      meBlockProjectiles: '투사체',
      meBlockHitboxes: '히트박스',
      meBlockGimmick: '기믹 코딩',
    };
    const sequenceMap = {
      meColLeft: [
        '프레임 조작',
        '타임라인 / 판정',
        '순간이동 이벤트',
        '공격 이펙트',
        '모션 클립',
        '외형 설정',
      ],
      meColRight: [
        '무기 이미지 / 장식',
        '무기 스탯 / 전투 설정',
        '저장 / 업로드',
      ],
    };
    return idMap[box.id] || box.getAttribute('data-title') || sequenceMap[colId]?.[index] || '편집 설정';
  }

  /** Live width during a splitter drag; below the threshold the block folds. */
  _setColWidth(key, w, parentW) {
    const c = this._cols[key];
    if (w < ME_COLLAPSE_AT) { if (!c.el.classList.contains('me-col-collapsed')) this._collapseCol(key, true); return; }
    if (c.el.classList.contains('me-col-collapsed')) { c.el.classList.remove('me-col-collapsed'); this._syncChips(); }
    const max = (parentW || c.el.parentElement.getBoundingClientRect().width) * 0.45;
    c.el.style.width = Math.min(max, w) + 'px';
    c.lastW = Math.min(max, w);
  }

  _collapseCol(key, silent) {
    const c = this._cols[key];
    if (!c.el.classList.contains('me-col-collapsed')) {
      c.prevW = c.lastW || c.el.getBoundingClientRect().width;
      c.el.classList.add('me-col-collapsed');
    }
    this._syncChips();
    if (!silent) this._saveLayout();
  }

  _expandCol(key) {
    const c = this._cols[key];
    c.el.classList.remove('me-col-collapsed');
    const parentW = c.el.parentElement.getBoundingClientRect().width;
    const target = Math.max(ME_COLLAPSE_AT + 40, Math.min(parentW * 0.45, c.prevW || parentW * c.def));
    c.el.style.width = target + 'px';
    c.lastW = target;
    this._syncChips();
    this._saveLayout();
  }

  /** Header chips (top-right): one ▶/◀ 펼치기 button per collapsed block. */
  _syncChips() {
    const host = document.getElementById('meExpandChips'); if (!host || !this._cols) return;
    host.innerHTML = '';
    for (const key of ['left', 'right']) {
      const c = this._cols[key];
      if (!c.el.classList.contains('me-col-collapsed')) continue;
      const b = document.createElement('button');
      b.className = 'bg-[#14100b] hover:bg-gray-800 border border-[#7df09a] text-[#7df09a] text-[10px] px-2 py-1 cursor-pointer active:scale-95';
      b.textContent = `${c.arrow} ${c.label} 펼치기`;
      b.addEventListener('click', () => this._expandCol(key));
      host.appendChild(b);
    }
  }

  _saveLayout() {
    if (!this._cols) return;
    try {
      localStorage.setItem(ME_LAYOUT_KEY, JSON.stringify({
        l: this._cols.left.el.classList.contains('me-col-collapsed') ? 'c' : (this._cols.left.lastW || null),
        r: this._cols.right.el.classList.contains('me-col-collapsed') ? 'c' : (this._cols.right.lastW || null),
        lp: this._cols.left.prevW || null, rp: this._cols.right.prevW || null,
      }));
    } catch {}
  }
  _loadLayout() { try { return JSON.parse(localStorage.getItem(ME_LAYOUT_KEY) || 'null'); } catch { return null; } }
  _applyLayout(s) {
    if (!s) { this._syncChips(); return; }
    if (s.lp) this._cols.left.prevW = s.lp;
    if (s.rp) this._cols.right.prevW = s.rp;
    if (s.l === 'c') this._collapseCol('left', true);
    else if (s.l) { this._cols.left.el.style.width = s.l + 'px'; this._cols.left.lastW = s.l; }
    if (s.r === 'c') this._collapseCol('right', true);
    else if (s.r) { this._cols.right.el.style.width = s.r + 'px'; this._cols.right.lastW = s.r; }
    this._syncChips();
  }

  replayTutorial() {
    this._tutStart();
  }

  open(weapon = 'sword', mode = 'canonical') {
    if (!this.root) return;
    this.mode = mode === 'workshop' ? 'workshop' : 'canonical';
    this.weapon = EDITOR_WEAPONS.includes(weapon) ? weapon : 'sword';
    const wsel = document.getElementById('meWeapon'); if (wsel) wsel.value = this.weapon;
    // Reflect the equipped look in the appearance controls.
    this.look = equippedStickLook();
    const $ = (id) => document.getElementById(id);
    if ($('meColor')) $('meColor').value = this.look.color || '#7df09a';
    if ($('meLineW')) $('meLineW').value = String(this.look.lineW);
    if ($('meHead')) $('meHead').value = this.look.head;
    if ($('meAccessory')) $('meAccessory').value = this.look.accessory;

    // Workshop mode: show the stats panel + reset to a balanced build; canonical
    // mode hides it. Title/CTA reflect the mode.
    const ws = this.mode === 'workshop';
    $('meStatsPanel')?.classList.toggle('hidden', !ws);
    $('mePresetBar')?.classList.toggle('hidden', !ws);
    $('mePresetComplete')?.classList.toggle('hidden', !ws);
    $('meEffectsBlock')?.classList.toggle('hidden', !ws);
    $('meLegacyPresetBlock')?.classList.toggle('hidden', ws);   // V2 preset bar replaces it in workshop
    const title = this.root.querySelector('h2'); if (title) title.textContent = ws ? '🔧 무기 공방' : '🎬 모션 에디터';
    if (ws) {
      // V2-native: edit a whole weapon (baseStats + per-preset). openWorkshopV2
      // sets _pendingV2; the plain path creates a fresh empty weapon.
      this._editingV2 = this._pendingV2 || makeEmptyWeaponV2({});
      this._ensureAuthoringPresets();
      this._editingId = this._editingV2.id;
      this._activeKey = this._editingV2.presets[this._editingV2.equippedPresetKey]
        ? this._editingV2.equippedPresetKey : Object.keys(this._editingV2.presets)[0];
      const nm = $('meName'); if (nm) nm.value = this._editingV2.name;
      const desc = $('meDesc'); if (desc) desc.value = this._editingV2.desc || '';
      if (this._editingV2.color) { this.look = { ...this.look, color: this._editingV2.color }; if ($('meColor')) $('meColor').value = this.look.color; }
      const vis = this._editingV2.weaponVisual;
      this.weapon = (vis && vis.imageId && this._customWeapon(vis.imageId)) ? vis.imageId : 'sword';
      this._syncDualControls();
      this._syncHatControls();
    }
    this._populateWeaponSelect();
    this._syncWeaponUI();
    if (ws) { this._renderPresetBar(); this._loadActivePreset(); }
    else { this._loadTemplate(); }
    this._undoStack = [];
    this._undoLastSig = this._stateSig(this._snapshotState());
    this._syncOnionBtn();
    this.root.classList.remove('hidden');
    // First visit to the workshop → guided "make one weapon" tutorial.
    if (this.mode === 'workshop' && !localStorage.getItem(ME_TUT_KEY)) this._tutStart();
    else this._tutStop();
  }

  /** Open the editor loaded with an existing V2 workshop weapon. */
  openWorkshopV2(w) {
    this._pendingV2 = w;
    this.open('sword', 'workshop');
    this._pendingV2 = null;
    this._setStatus(`"${w.name}" 편집 중. 💾 저장하면 무기고에 반영됩니다.`);
  }

  // ── V2 preset tabs + per-preset load/commit ────────────────────────────────
  _ensureAuthoringPresets() {
    const w = this._editingV2;
    if (!w) return;
    if (!w.presets || typeof w.presets !== 'object') w.presets = {};
    for (const key of Object.keys(w.presets)) {
      if (!AUTHORING_PRESET_KEYS.includes(key)) delete w.presets[key];
    }
    for (const key of AUTHORING_PRESET_KEYS) {
      if (!w.presets[key]) w.presets[key] = makeEmptyPreset(key);
    }
    if (!w.presets[w.equippedPresetKey]) w.equippedPresetKey = 'basic';
    if (!w.presets[this._activeKey]) this._activeKey = w.equippedPresetKey;
  }
  _presetOrder() {
    const w = this._editingV2; if (!w) return [];
    return AUTHORING_PRESET_KEYS.filter(k => w.presets[k]);
  }
  _renderPresetBar() {
    const bar = document.getElementById('mePresetBar'); const w = this._editingV2;
    if (!bar || !w) return;
    this._ensureAuthoringPresets();
    bar.innerHTML = '';
    const order = this._presetOrder();
    for (const key of order) {
      const wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px;flex:0 0 auto';
      const b = document.createElement('button');
      const active = key === this._activeKey;
      const done = !!w.presets[key]?.complete;
      b.className = 'min-w-[56px] text-[10px] px-2 py-1 rounded cursor-pointer active:scale-95 ' + (active
        ? `bg-[#1c6b33] text-white ${done ? 'border-2' : 'border'} border-[#7df09a]`
        : done ? 'bg-[#142318] text-[#b8ffc8] border-2 border-[#7df09a] hover:bg-[#1a3020]'
          : 'bg-[#14100b] text-gray-300 border border-gray-700 hover:border-gray-500');
      const star = w.equippedPresetKey === key ? '★ ' : '';
      const presetName = w.presets[key]?.displayName || PRESET_LABELS[key] || key;
      b.textContent = star + presetName + (done ? ' ✓' : '');
      b.title = `${PRESET_LABELS[key] || key}${w.presets[key]?.displayName ? ` · 표시명: ${w.presets[key].displayName}` : ''}`;
      b.title += COMBAT_PRESET_KINDS.has(key) ? ' · 공격 프리셋' : (key === 'dash' ? ' · 대시' : ' · 비공격(코스메틱) 프리셋');
      b.addEventListener('click', () => { this._switchPreset(key); this._tutEvent('preset'); });
      wrap.appendChild(b);
      bar.appendChild(wrap);
    }
    this._syncPresetCompleteButton();
  }
  _switchPreset(key) {
    if (!this._editingV2 || key === this._activeKey) return;
    this._commitActivePreset();
    this._activeKey = key;
    this._loadActivePreset();
    this._renderPresetBar();
  }
  _addPresetKind(kind) {
    const w = this._editingV2; if (!w || !AUTHORING_PRESET_KEYS.includes(kind) || w.presets[kind]) return;
    this._commitActivePreset();
    w.presets[kind] = makeEmptyPreset(kind);
    this._activeKey = kind;
    this._loadActivePreset();
    this._renderPresetBar();
    this._setStatus(`"${PRESET_LABELS[kind] || kind}" 프리셋을 추가했습니다.`);
  }
  _togglePresetComplete(key) {
    const w = this._editingV2; if (!w || !w.presets[key]) return;
    if (key === this._activeKey) this._commitActivePreset();
    const p = w.presets[key];
    p.complete = !p.complete;
    this._renderPresetBar();
    this._syncPresetCompleteButton();
    this._setStatus(`${p.displayName || PRESET_LABELS[key] || key} 프리셋을 ${p.complete ? '완성 표시' : '미완성으로 되돌림'}했습니다. 수정은 계속 가능합니다.`);
  }
  _syncPresetCompleteButton() {
    const btn = document.getElementById('mePresetComplete');
    const p = this._editingV2?.presets?.[this._activeKey];
    if (!btn) return;
    const done = !!p?.complete;
    btn.disabled = !p;
    btn.textContent = done ? '현재 프리셋 완성됨 ✓' : '현재 프리셋 완성';
    btn.className = 'border text-[10px] px-2 py-1 hover:border-white active:scale-95 disabled:opacity-40 ' + (done
      ? 'border-[#7df09a] bg-[#16351f] text-[#7df09a]'
      : 'border-[#ffd24a] bg-[#24180c] text-[#ffd24a]');
    btn.title = done ? '다시 누르면 미완성으로 되돌립니다.' : '현재 선택한 프리셋을 완성 표시합니다.';
  }
  _deletePreset(key) {
    const w = this._editingV2; if (!w || this._presetOrder().length <= 1) return;
    delete w.presets[key];
    if (w.equippedPresetKey === key) w.equippedPresetKey = this._presetOrder()[0];
    if (this._activeKey === key) this._activeKey = this._presetOrder()[0];
    this._loadActivePreset();
    this._renderPresetBar();
  }
  /** Write the current editor pose/blocks back into the active preset. */
  _commitActivePreset() {
    const w = this._editingV2, key = this._activeKey, p = w && w.presets[key];
    if (!p) return;
    this._applyFixedPresetDuration();
    p.motion = this.motion;
    p.weaponTimeline = {
      flipXKeys: sanitizeFlipKeys(this._flipKeys || []),
      flipYKeys: sanitizeFlipKeys(this._flipYKeys || []),
      leftFlipXKeys: sanitizeFlipKeys(this._leftFlipKeys || []),
      leftFlipYKeys: sanitizeFlipKeys(this._leftFlipYKeys || []),
      handSwapKeys: sanitizeFlipKeys(this._handSwapKeys || [])
    };
    p.previewOffset = this._previewOffset || { x: 0, y: 0 };
    if (COMBAT_PRESET_KINDS.has(key)) {
      p.displayName = this._presetDisplayNameValue();
      p.hitboxes = Array.isArray(this.motion.hitboxes) ? this.motion.hitboxes : [];
      p.combatKeys = sanitizeCombatKeys(p.combatKeys || [], p.combat, key);
      p.projectileEvents = sanitizeProjectileEvents(p.projectileEvents || []);
      p.teleportEvents = sanitizeTeleportEvents(p.teleportEvents || []);
      p.blocks = this.blocks;
    }
    else if (key === 'dash') { p.blocks = this.blocks; }
  }
  /** Load the active preset into the editor + toggle the combat/dash UI. */
  _loadActivePreset() {
    const w = this._editingV2, key = this._activeKey, p = w && w.presets[key];
    const $ = (id) => document.getElementById(id);
    if (!p) return;
    const isCombat = COMBAT_PRESET_KINDS.has(key), isDash = key === 'dash';
    this.motion = sanitizeMotion(isCombat ? { ...p.motion, hitboxes: p.hitboxes || [] } : p.motion, undefined, { allowGameplay: true });
    this._applyFixedPresetDuration();
    this.blocks = (isCombat || isDash) ? (p.blocks || null) : null;
    this._flipKeys = (p.weaponTimeline && Array.isArray(p.weaponTimeline.flipXKeys)) ? p.weaponTimeline.flipXKeys.map(k => ({ ...k })) : [];
    this._flipYKeys = (p.weaponTimeline && Array.isArray(p.weaponTimeline.flipYKeys)) ? p.weaponTimeline.flipYKeys.map(k => ({ ...k })) : [];
    this._leftFlipKeys = (p.weaponTimeline && Array.isArray(p.weaponTimeline.leftFlipXKeys)) ? p.weaponTimeline.leftFlipXKeys.map(k => ({ ...k })) : [];
    this._leftFlipYKeys = (p.weaponTimeline && Array.isArray(p.weaponTimeline.leftFlipYKeys)) ? p.weaponTimeline.leftFlipYKeys.map(k => ({ ...k })) : [];
    this._handSwapKeys = (p.weaponTimeline && Array.isArray(p.weaponTimeline.handSwapKeys)) ? p.weaponTimeline.handSwapKeys.map(k => ({ ...k })) : [];
    this._previewOffset = p.previewOffset ? { ...p.previewOffset } : { x: 0, y: 0 };
    this.selKf = 0; this.scrubT = this.motion.keyframes[0]?.t || 0; this.playing = false;
    this._selectedHitboxIndex = -1;
    this._selectHitboxForTime(this.scrubT);
    this._syncDurationControls();
    this._syncBaseSliders();
    if (isCombat) { this._syncCombatSliders(this._combatForCurrentFrame(p)); this._syncProjectilePanel(p); }
    else {
      document.getElementById('meProjectilePanel')?.classList.add('hidden');
      document.getElementById('meTeleportPanel')?.classList.add('hidden');
    }
    this._renderEffectList();
    if (isDash && $('ms_dashDistance')) { $('ms_dashDistance').value = String(p.dashDistance || 120); if ($('ms_dashDistance_v')) $('ms_dashDistance_v').textContent = p.dashDistance || 120; }
    $('meCombatStats')?.classList.toggle('hidden', !isCombat);
    $('meDashStats')?.classList.toggle('hidden', !isDash);
    $('meHitboxRow')?.classList.toggle('hidden', !isCombat);   // hitboxes = combat only
    this._syncHeavyStats(isCombat ? p : null);
    const cn = $('meCombatPresetName'); if (cn) cn.textContent = PRESET_LABELS[key] || key;
    const ultimate = key === 'ultimate';
    $('meCooldownRow')?.classList.toggle('hidden', ultimate);
    if ($('ms_damage')) $('ms_damage').max = ultimate ? '100' : '60';
    this._syncPresetDisplayName(p, isCombat);
    this._syncFrameEventLists();
    this._renderBudget(); this._updateBlockCount(); this._renderAll();
  }
  _presetDisplayNameValue() {
    return String(document.getElementById('mePresetDisplayName')?.value || '').trim().slice(0, 24);
  }
  _syncPresetDisplayName(p, enabled = true) {
    const input = document.getElementById('mePresetDisplayName');
    if (!input) return;
    input.disabled = !enabled;
    input.value = enabled ? String(p?.displayName || '') : '';
    input.placeholder = enabled ? (PRESET_LABELS[this._activeKey] || '기본 프리셋 이름 사용') : '비전투 프리셋';
  }
  _setPresetDisplayName(value) {
    const p = this._activeCombatPreset();
    if (!p) return;
    p.displayName = String(value || '').trim().slice(0, 24);
    this._renderPresetBar();
  }
  // ── Ranged / projectile (per combat preset) ────────────────────────────────
  _activeCombatPreset() { const p = this._editingV2 && this._editingV2.presets[this._activeKey]; return (p && COMBAT_PRESET_KINDS.has(p.kind)) ? p : null; }
  _setRanged(on) {
    const p = this._activeCombatPreset(); if (!p) return;
    p.ranged = !!on;
    document.getElementById('meProjectilePanel')?.classList.remove('hidden');
    document.getElementById('meTeleportPanel')?.classList.remove('hidden');
    this._renderProjectilePreview();
    this._setStatus(on ? '원거리 공격 켜짐 — 투사체 설정을 조절하세요.' : '근접 공격으로 전환.');
  }
  _setProjectile(field, value) {
    const p = this._activeCombatPreset(); if (!p) return;
    p.projectile = p.projectile || {};
    p.projectile[field] = value;
    p.projectile = sanitizeProjectile(p.projectile);
    const $ = (id) => document.getElementById(id);
    if (field === 'speed' && $('pj_speed_v')) $('pj_speed_v').textContent = value;
    if (field === 'lifetimeMs' && $('pj_lifetimeMs_v')) $('pj_lifetimeMs_v').textContent = value;
    if (field === 'scale' && $('pj_scale_v')) $('pj_scale_v').textContent = Number(value).toFixed(2);
    if (field === 'directionSource') this._syncProjectileAngleControls();
    if (field === 'rotation') this._syncProjectileRotationControls(value);
    this._renderProjectilePreview();
  }

  _setProjectileAngle(value) {
    const deg = Math.round(clamp(Number(value) || 0, -360, 360));
    const p = this._activeCombatPreset(); if (!p) return;
    p.projectile = sanitizeProjectile({ ...(p.projectile || {}), angle: deg });
    this._syncProjectileAngleControls(deg);
    this._renderProjectilePreview();
  }

  _syncProjectileAngleControls(value = null) {
    const p = this._activeCombatPreset();
    const pj = p?.projectile || {};
    const deg = Math.round(clamp(Number(value ?? pj.angle) || 0, -360, 360));
    document.getElementById('pj_angle_row')?.classList.toggle('hidden', (pj.directionSource || 'cursor') !== 'angle');
    const range = document.getElementById('pj_angle');
    const text = document.getElementById('pj_angle_text');
    if (range) range.value = String(deg);
    if (text) text.value = String(deg);
  }

  _setProjectileHb(field, value) {
    const p = this._activeCombatPreset(); if (!p) return;
    p.projectile = p.projectile || {}; p.projectile.hitbox = p.projectile.hitbox || {};
    p.projectile.hitbox[field] = value;
    if (field === 'shape') {
      document.getElementById('pj_shape_rect')?.classList.toggle('on', value === 'rect');
      document.getElementById('pj_shape_circle')?.classList.toggle('on', value === 'circle');
      document.getElementById('pj_rectFields')?.classList.toggle('hidden', value !== 'rect');
      document.getElementById('pj_circleField')?.classList.toggle('hidden', value !== 'circle');
    }
    this._renderProjectilePreview();
  }
  _syncProjectilePanel(p) {
    const $ = (id) => document.getElementById(id);
    const ranged = !!(p && p.ranged);
    if ($('ms_ranged')) $('ms_ranged').checked = ranged;
    $('meProjectilePanel')?.classList.remove('hidden');
    $('meTeleportPanel')?.classList.remove('hidden');
    const pj = (p && p.projectile) || {};
    const hb = pj.hitbox || {};
    this._populateProjectileSelect(pj.imageId || 'arrow');
    if ($('pj_directionSource')) $('pj_directionSource').value = pj.directionSource || 'cursor';
    const setR = (id, v) => { if ($(id)) { $(id).value = String(v); if ($(id + '_v')) $(id + '_v').textContent = (id === 'pj_scale') ? Number(v).toFixed(2) : v; } };
    setR('pj_speed', pj.speed ?? 600); setR('pj_lifetimeMs', pj.lifetimeMs ?? 1200); setR('pj_scale', pj.scale ?? 1);
    this._syncProjectileAngleControls(pj.angle ?? 0);
    this._syncProjectileRotationControls(pj.rotation ?? 0);
    if ($('pj_pierce')) $('pj_pierce').checked = !!pj.pierce;
    const shape = hb.shape || 'rect';
    $('pj_shape_rect')?.classList.toggle('on', shape === 'rect');
    $('pj_shape_circle')?.classList.toggle('on', shape === 'circle');
    $('pj_rectFields')?.classList.toggle('hidden', shape !== 'rect');
    $('pj_circleField')?.classList.toggle('hidden', shape !== 'circle');
    if ($('pj_hb_width')) $('pj_hb_width').value = String(hb.width ?? 24);
    if ($('pj_hb_height')) $('pj_hb_height').value = String(hb.height ?? 12);
    if ($('pj_hb_radius')) $('pj_hb_radius').value = String(hb.radius ?? 8);
    if ($('tp_distance')) $('tp_distance').value = String(80);
    if ($('tp_directionSource')) $('tp_directionSource').value = 'cursor';
    this._syncFrameEventLists();
    this._renderProjectilePreview();
  }

  _projectileRotationValue() {
    const p = this._activeCombatPreset();
    return Math.round(clamp(Number(p?.projectile?.rotation) || 0, -180, 180));
  }

  _syncProjectileRotationControls(value = this._projectileRotationValue()) {
    const deg = Math.round(clamp(Number(value) || 0, -180, 180));
    const panel = document.getElementById('pj_rotation_v');
    const modal = document.getElementById('pjRotationValue');
    const range = document.getElementById('pjRotationRange');
    const text = document.getElementById('pjRotationText');
    if (panel) panel.textContent = `${deg}°`;
    if (modal) modal.textContent = `${deg}°`;
    if (range) range.value = String(deg);
    if (text) text.value = String(deg);
  }

  _setProjectileRotation(value) {
    const deg = Math.round(clamp(Number(value) || 0, -180, 180));
    const p = this._activeCombatPreset(); if (!p) return;
    p.projectile = sanitizeProjectile({ ...(p.projectile || {}), rotation: deg });
    this._syncProjectileRotationControls(deg);
    this._renderProjectilePreview();
    this._renderProjectileRotationModal();
  }

  _openProjectileRotation() {
    document.getElementById('pjRotationModal')?.classList.remove('hidden');
    this._syncProjectileRotationControls();
    this._renderProjectileRotationModal();
  }

  _closeProjectileRotation() {
    document.getElementById('pjRotationModal')?.classList.add('hidden');
  }

  _renderProjectileRotationModal() {
    const cv = document.getElementById('pjRotationCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const p = this._activeCombatPreset(); const pj = (p && p.projectile) || {};
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0a06'; ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2 + 8;
    ctx.strokeStyle = 'rgba(69,243,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(48, cy); ctx.lineTo(W - 48, cy); ctx.stroke();
    ctx.fillStyle = '#45f3ff';
    ctx.beginPath(); ctx.moveTo(W - 48, cy); ctx.lineTo(W - 62, cy - 7); ctx.lineTo(W - 62, cy + 7); ctx.closePath(); ctx.fill();
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('발사 방향', W / 2, cy + 24);
    this._drawProjectilePreviewShape(ctx, cx, cy - 28, pj.imageId || 'arrow', 64 * (pj.scale || 1), this._projectileRotationValue());
  }

  _populateProjectileSelect(value = 'arrow') {
    const sel = document.getElementById('pj_imageId');
    if (!sel) return;
    const builtins = [
      ['arrow', '화살'], ['bolt', '볼트'], ['magicbolt', '마법탄'],
      ['flame', '불꽃'], ['iceshard', '얼음 파편'], ['bullet', '탄환']
    ].map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    const custom = this.customWeapons.length
      ? `<optgroup label="내 이미지">${this.customWeapons.map(c => `<option value="${escOpt(c.id)}">🖼 ${escOpt(c.name)}</option>`).join('')}</optgroup>`
      : '';
    sel.innerHTML = builtins + custom;
    sel.value = [...sel.options].some(o => o.value === value) ? value : 'arrow';
  }

  _addProjectileEvent() {
    const p = this._activeCombatPreset(); if (!p) return;
    const events = sanitizeProjectileEvents(p.projectileEvents || []);
    if (events.length >= 5) { this._setStatus('투사체 이벤트는 한 모션에 최대 5개입니다.'); return; }
    events.push({ time: Math.max(0, Math.min(1, this.scrubT || 0)), projectile: sanitizeProjectile(p.projectile || {}) });
    p.projectileEvents = sanitizeProjectileEvents(events);
    this._syncFrameEventLists();
    this._setStatus(`현재 프레임에 투사체 발사 이벤트를 추가했습니다 (${this._frameLabelForTime(this.scrubT || 0)}, ${p.projectileEvents.length}/5).`);
  }

  _addTeleportEvent() {
    const p = this._activeCombatPreset(); if (!p) return;
    const $ = (id) => document.getElementById(id);
    const events = sanitizeTeleportEvents(p.teleportEvents || []);
    if (events.length >= 5) { this._setStatus('텔레포트 이벤트는 한 모션에 최대 5개입니다.'); return; }
    events.push({
      time: Math.max(0, Math.min(1, this.scrubT || 0)),
      directionSource: $('tp_directionSource')?.value || 'cursor',
      distance: parseFloat($('tp_distance')?.value || '80')
    });
    p.teleportEvents = sanitizeTeleportEvents(events);
    this._syncFrameEventLists();
    this._setStatus(`현재 프레임에 텔레포트 이벤트를 추가했습니다 (${this._frameLabelForTime(this.scrubT || 0)}, ${p.teleportEvents.length}/5).`);
  }

  _syncFrameEventLists() {
    const p = this._activeCombatPreset();
    const pjList = document.getElementById('pj_event_list');
    const tpList = document.getElementById('tp_event_list');
    const render = (events, type) => events.length ? events.map((ev, i) =>
      `<button type="button" data-event-type="${type}" data-event-index="${i}" class="mr-1 mb-1 px-1 py-0.5 border border-gray-700 hover:border-red-400 text-left">`
      + `${this._frameLabelForTime(ev.time || 0)} ${type === 'projectile' ? '발사' : `이동 ${Math.round(ev.distance || 0)}px`} ✕</button>`).join('') : '<span class="text-gray-600">등록된 이벤트 없음</span>';
    if (pjList) pjList.innerHTML = render(sanitizeProjectileEvents(p?.projectileEvents || []), 'projectile');
    if (tpList) tpList.innerHTML = render(sanitizeTeleportEvents(p?.teleportEvents || []), 'teleport');
    const remove = (e) => this._removeFrameEvent(e);
    if (pjList && !pjList._meBound) { pjList._meBound = true; pjList.addEventListener('click', remove); }
    if (tpList && !tpList._meBound) { tpList._meBound = true; tpList.addEventListener('click', remove); }
  }

  _removeFrameEvent(e) {
    const b = e.target.closest('[data-event-type][data-event-index]');
    const p = this._activeCombatPreset();
    if (!b || !p) return;
    const key = b.dataset.eventType === 'projectile' ? 'projectileEvents' : 'teleportEvents';
    const arr = Array.isArray(p[key]) ? p[key].slice() : [];
    arr.splice(Number(b.dataset.eventIndex), 1);
    p[key] = key === 'projectileEvents' ? sanitizeProjectileEvents(arr) : sanitizeTeleportEvents(arr);
    this._syncFrameEventLists();
  }
  _renderProjectilePreview() {
    const cv = document.getElementById('pjPreview'); if (!cv) return;
    const p = this._activeCombatPreset(); const pj = (p && p.projectile) || {};
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#14100b'; ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    this._drawProjectilePreviewShape(ctx, cx, cy, pj.imageId || 'arrow', 34 * (pj.scale || 1), pj.rotation || 0);
    // translucent hitbox
    const hb = pj.hitbox || {};
    ctx.fillStyle = 'rgba(255,90,60,0.30)'; ctx.strokeStyle = '#ff7a5a'; ctx.lineWidth = 1.5;
    if ((hb.shape || 'rect') === 'circle') {
      ctx.beginPath(); ctx.arc(cx + (hb.x || 0), cy + (hb.y || 0), hb.radius ?? 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      const w = hb.width ?? 24, h = hb.height ?? 12;
      ctx.fillRect(cx + (hb.x || 0) - w / 2, cy + (hb.y || 0) - h / 2, w, h); ctx.strokeRect(cx + (hb.x || 0) - w / 2, cy + (hb.y || 0) - h / 2, w, h);
    }
  }

  _drawProjectilePreviewShape(ctx, x, y, imageId, size, rotationDeg = 0) {
    const angle = (Number(rotationDeg) || 0) * Math.PI / 180;
    const rec = this._customWeapon(imageId);
    if (rec && rec.src) {
      let img = this._wimgCache[rec.id];
      if (!img) {
        img = new Image();
        img.onload = () => { this._renderProjectilePreview(); this._renderProjectileRotationModal(); };
        img.src = rec.src;
        this._wimgCache[rec.id] = img;
      }
      if (img.complete && img.naturalWidth) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.restore();
        return;
      }
    }
    drawProjectileShape(ctx, x, y, angle, imageId, size);
  }

  // ── Frame effects (cosmetic, per preset) ───────────────────────────────────
  _activePreset() { return this._editingV2 && this._editingV2.presets[this._activeKey]; }
  _effectFrameCount() { return Math.max(2, Math.min(64, this.motion?.keyframes?.length || 64)); }
  _effectFrameToTime(frame) {
    const n = this._effectFrameCount();
    return Math.round(clamp(((Number(frame) || 1) - 1) / Math.max(1, n - 1), 0, 1) * 1000) / 1000;
  }
  _effectTimeToFrame(time) {
    const n = this._effectFrameCount();
    return Math.max(1, Math.min(n, Math.round((clamp(Number(time) || 0, 0, 1) * (n - 1)) + 1)));
  }
  _effectDisplayName(id) {
    const built = BUILTIN_EFFECTS.find(([v]) => v === id);
    if (built) return built[1];
    const rec = this._customWeapon(id);
    return rec ? rec.name : id;
  }
  _populateEffectSelect(value = null) {
    const sel = document.getElementById('meEffectAsset'); if (!sel) return;
    const built = BUILTIN_EFFECTS.map(([v, label]) => `<option value="${escOpt(v)}">${escOpt(label)}</option>`).join('');
    const customList = this.customWeapons.filter(c => c && typeof c.id === 'string' && c.id.startsWith('custom:fx_'));
    const custom = customList.length
      ? `<optgroup label="내 이펙트 이미지">${customList.map(c => `<option value="${escOpt(c.id)}">🖼 ${escOpt(c.name)}</option>`).join('')}</optgroup>`
      : '';
    sel.innerHTML = built + custom;
    sel.value = value || sel.value || 'spark';
    if (!sel.value) sel.value = 'spark';
  }
  _onEffectFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!file.type || !/^image\//.test(file.type) || /^(audio|video|text)\//.test(file.type)) {
      this._setStatus('공격 이펙트는 브라우저가 이미지로 읽을 수 있는 파일만 넣을 수 있어요.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this._addEffectImage(String(reader.result), (file.name || '이펙트').replace(/\.[^.]+$/, '').slice(0, 20) || '이펙트');
    reader.onerror = () => this._setStatus('이펙트 파일을 읽지 못했어요.');
    reader.readAsDataURL(file);
  }
  _addEffectImage(dataUrl, name) {
    normalizeCustomImageDataUrl(dataUrl).then(({ src, img }) => {
      const rec = { id: 'custom:fx_' + Date.now().toString(36), name, src, size: 1, anchors: null };
      this.customWeapons.push(rec);
      saveCustomWeapons(this.customWeapons);
      if (img) this._wimgCache[rec.id] = img;
      this._populateEffectSelect(rec.id);
      this._addEffect(rec.id);
      this._setStatus(`이펙트 이미지 "${name}" 추가. 400x400 박스 안에 맞춰 저장했습니다.`);
    }).catch(() => this._setStatus('이펙트 이미지를 불러오지 못했어요.'));
  }
  _addEffect(assetOverride = null) {
    const p = this._activePreset(); if (!p) return;
    p.effects = p.effects || [];
    if (p.effects.length >= 24) { this._setStatus('이펙트는 최대 24개입니다.'); return; }
    const assetId = assetOverride || document.getElementById('meEffectAsset')?.value || 'spark';
    const start = Math.round(this.scrubT * 1000) / 1000;
    const end = Math.min(1, Math.round((start + 0.12) * 1000) / 1000);
    p.effects.push({ time: start, endTime: end, assetId, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, flipX: false, flipY: false, keys: [{ time: start, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, flipX: false, flipY: false }] });
    p.effects.sort((a, b) => a.time - b.time);
    this._selectedEffectIndex = p.effects.findIndex(e => Math.abs(e.time - Math.round(this.scrubT * 1000) / 1000) < 0.001 && e.assetId === assetId);
    this._renderEffectList(); this._renderPreview();
    this._setStatus(`이펙트 "${this._effectDisplayName(assetId)}" 추가 @ ${this._frameLabelForTime(this.scrubT)}.`);
    this._tutEvent('effect');
  }
  _renderEffectList() {
    const host = document.getElementById('meEffectList'); const p = this._activePreset();
    if (!host) return;
    const list = (p && p.effects) || [];
    if (this._selectedEffectIndex >= list.length) this._selectedEffectIndex = list.length - 1;
    host.innerHTML = list.map((e, i) => `<div class="flex items-center gap-1 text-[9px] ${i === this._selectedEffectIndex ? 'text-[#ffd24a]' : 'text-gray-300'}" data-fx="${i}">
      <button class="flex items-center gap-1 flex-1 min-w-0 text-left hover:text-[#ffd24a]" data-fxpick="${i}"><span class="text-[#ffd24a]">${this._effectTimeToFrame(e.time)}-${this._effectTimeToFrame(e.endTime ?? e.time)}</span><span class="truncate">${escOpt(this._effectDisplayName(e.assetId))} ${Number(e.scaleX || 1).toFixed(1)}×${Number(e.scaleY || 1).toFixed(1)}</span></button>
      <button class="text-gray-600 hover:text-red-400 px-1" data-fxdel="${i}">✕</button></div>`).join('') ||
      '<span class="text-[9px] text-gray-600">없음</span>';
    host.querySelectorAll('[data-fxpick]').forEach(b => b.addEventListener('click', () => {
      this._selectedEffectIndex = Number(b.dataset.fxpick);
      this._syncEffectControls();
      this._renderEffectList();
      this._renderPreview();
    }));
    host.querySelectorAll('[data-fxdel]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.fxdel); if (p && p.effects) { p.effects.splice(i, 1); if (this._selectedEffectIndex >= i) this._selectedEffectIndex--; this._renderEffectList(); this._syncEffectControls(); this._renderPreview(); }
    }));
    this._syncEffectControls();
  }
  _syncEffectControls() {
    const p = this._activePreset();
    const e = p && Array.isArray(p.effects) ? p.effects[this._selectedEffectIndex] : null;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = String(v); };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    this._populateEffectSelect(e?.assetId || 'spark');
    set('meEffectAsset', e?.assetId || 'spark');
    set('meEffectStartFrame', this._effectTimeToFrame(e?.time ?? this.scrubT));
    set('meEffectEndFrame', this._effectTimeToFrame(e?.endTime ?? e?.time ?? this.scrubT));
    const sampled = e ? sampleEffectTransform(e, this._currentMotionTime()) : null;
    set('meEffectRot', sampled?.rotation ?? 0);
    set('meEffectAlpha', sampled?.alpha ?? 1);
    setCheck('meEffectFlipX', sampled?.flipX);
    setCheck('meEffectFlipY', sampled?.flipY);
  }
  _updateSelectedEffectFrame(which, frame) {
    const p = this._activePreset();
    if (!p || !Array.isArray(p.effects) || this._selectedEffectIndex < 0 || !p.effects[this._selectedEffectIndex]) return;
    const e = p.effects[this._selectedEffectIndex];
    const t = this._effectFrameToTime(frame);
    if (which === 'start') {
      e.time = t;
      if (!Number.isFinite(Number(e.endTime)) || e.endTime < e.time) e.endTime = e.time;
    } else {
      e.endTime = Math.max(Number(e.time) || 0, t);
    }
    p.effects = sanitizeEffects(p.effects);
    this._selectedEffectIndex = Math.max(0, Math.min(this._selectedEffectIndex, p.effects.length - 1));
    this._renderEffectList();
    this._renderPreview();
  }
  _updateSelectedEffect(field, value) {
    const p = this._activePreset();
    if (!p || !Array.isArray(p.effects) || this._selectedEffectIndex < 0 || !p.effects[this._selectedEffectIndex]) return;
    const effect = p.effects[this._selectedEffectIndex];
    if (field === 'assetId') effect.assetId = value;
    else this._setEffectKeyValue(effect, field, value, this._currentMotionTime());
    p.effects = sanitizeEffects(p.effects);
    this._selectedEffectIndex = Math.max(0, Math.min(this._selectedEffectIndex, p.effects.length - 1));
    this._renderEffectList();
    this._renderPreview();
  }
  _setEffectKeyValue(effect, field, value, time = this._currentMotionTime()) {
    const t = Math.max(Number(effect.time) || 0, Math.min(Number(effect.endTime) || 1, Number(time) || 0));
    const current = sampleEffectTransform(effect, t);
    const keys = (Array.isArray(effect.keys) ? effect.keys : []).filter(k => Math.abs(Number(k.time) - t) > 0.0005);
    keys.push({ ...current, time: Math.round(t * 1000) / 1000, [field]: value });
    effect.keys = keys.sort((a, b) => a.time - b.time);
    if (Math.abs(t - (Number(effect.time) || 0)) < 0.0005) Object.assign(effect, effect.keys[0]);
  }
  /** Draw effects in player-local space, independent from hands and weapons. */
  _drawEffects(ctx, joints, scale) {
    const p = this._activePreset(); if (!p || !Array.isArray(p.effects)) return;
    this._effectScreen = null;
    const t = this.playing ? this.scrubT : (this.motion.keyframes[this.selKf]?.t ?? this.scrubT);
    for (const e of p.effects) {
      const start = Number(e.time) || 0;
      const end = Number.isFinite(Number(e.endTime)) ? Math.max(start, Number(e.endTime)) : Math.min(1, start + 0.12);
      let progress = 0;
      if (this.playing) {
        if (t < start || t > end) continue;
        progress = Math.max(0, Math.min(1, (t - start) / Math.max(0.001, end - start)));
      } else if (t < start - 0.025 || t > end + 0.025) continue;   // show near its frame window
      const state = sampleEffectTransform(e, t);
      const bone = joints.pelvis; if (!bone) continue;
      const unit = scale / 46;
      const x = bone.x + (state.x || 0) * unit, y = bone.y + (state.y || 0) * unit;
      ctx.save(); ctx.globalAlpha = state.alpha ?? 1; ctx.translate(x, y); ctx.rotate((state.rotation || 0) * Math.PI / 180);
      if (state.flipX || state.flipY) ctx.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1);
      const img = this._imageById(e.assetId);
      let drawW = 36 * (state.scaleX || 1) * unit, drawH = 36 * (state.scaleY || 1) * unit;
      if (img && img.complete && img.naturalWidth) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
      } else {
        ctx.scale(state.scaleX || 1, state.scaleY || 1);
        drawFxShape(ctx, e.assetId, 18 * unit);
      }
      ctx.restore();
      if (!this.playing && this._selectedEffectIndex === p.effects.indexOf(e)) {
        const handleScale = this._previewHandleScale();
        ctx.save();
        ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2 * handleScale; ctx.strokeRect(x - drawW / 2, y - drawH / 2, drawW, drawH);
        ctx.fillStyle = '#ff4b4b'; ctx.beginPath(); ctx.arc(x, y, 7 * handleScale, 0, Math.PI * 2); ctx.fill();
        const rx = x + drawW / 2, ry = y + drawH / 2;
        ctx.fillStyle = '#ffd24a'; ctx.fillRect(rx - 6 * handleScale, ry - 6 * handleScale, 12 * handleScale, 12 * handleScale);
        ctx.restore();
        this._effectScreen = { cx: x, cy: y, rx, ry, halfW: drawW / 2, halfH: drawH / 2, pelvisX: bone.x, pelvisY: bone.y, unit, scaleX: state.scaleX || 1, scaleY: state.scaleY || 1 };
      }
    }
  }

  _drawProjectileEvents(ctx, joints, scale) {
    const p = this._activeCombatPreset(); if (!p) return;
    const events = sanitizeProjectileEvents(p.projectileEvents || []);
    if (!events.length) return;
    const t = this.playing ? this.scrubT : this._currentMotionTime();
    const origin = joints.weaponTip || joints.handN || joints.pelvis; if (!origin) return;
    const dur = Math.max(0.12, this.motion?.duration || 0.5);
    for (const ev of events) {
      const dt = t - (ev.time || 0);
      if (this.playing) {
        if (dt < 0 || dt > 0.55) continue;
      } else if (Math.abs(dt) > 0.06) continue;
      const pj = ev.projectile || p.projectile || {};
      const px = origin.x + Math.max(0, dt) * (pj.speed || 600) * (scale / 46) * dur;
      const py = origin.y;
      this._drawProjectilePreviewShape(ctx, px, py, pj.imageId || 'arrow', 22 * (pj.scale || 1), pj.rotation || 0);
    }
  }

  /** Current weapon-flip value shown in the preview (sampled at the scrub time). */
  _currentTimeForFlip() { return this.playing ? this.scrubT : (this.motion.keyframes[this.selKf]?.t ?? this.scrubT); }
  _currentFlip() { return this._currentHandFlip('right', 'x'); }
  _currentFlipY() { return this._currentHandFlip('right', 'y'); }
  _currentHandFlip(hand = 'right', axis = 'x') {
    const keys = hand === 'left'
      ? (axis === 'y' ? this._leftFlipYKeys : this._leftFlipKeys)
      : (axis === 'y' ? this._flipYKeys : this._flipKeys);
    return sampleFlip(keys || [], this._currentTimeForFlip());
  }
  _currentHandSwap() { return sampleFlip(this._handSwapKeys || [], this.playing ? this.scrubT : (this.motion.keyframes[this.selKf]?.t ?? this.scrubT)); }
  /** Toggle the weapon flip at time t: upsert a key with the opposite value. */
  _toggleFlipAt(t, hand = 'right', axis = 'x') {
    if (!this._editingV2) return;
    const tt = Math.round(Math.max(0, Math.min(1, t)) * 1000) / 1000;
    const prop = hand === 'left'
      ? (axis === 'y' ? '_leftFlipYKeys' : '_leftFlipKeys')
      : (axis === 'y' ? '_flipYKeys' : '_flipKeys');
    const cur = sampleFlip(this[prop] || [], tt);
    const keys = (this[prop] || []).filter(k => Math.abs(k.time - tt) > 0.001);
    keys.push({ time: tt, value: !cur });
    this[prop] = sanitizeFlipKeys(keys);
    const handLabel = hand === 'left' ? '왼손' : '오른손';
    const axisLabel = axis === 'y' ? '상하' : '좌우';
    this._setStatus(`${handLabel} 무기 ${axisLabel} 반전 ${!cur ? '켬' : '끔'} @ ${this._frameLabelForTime(tt)}.`);
    this._renderPreview(); this._renderTimeline();
    this._tutEvent('flip');
  }
  _toggleFlipYAt(t) {
    this._toggleFlipAt(t, 'right', 'y');
  }
  _toggleHandSwapAt(t) {
    if (!this._editingV2) return;
    const tt = Math.round(Math.max(0, Math.min(1, t)) * 1000) / 1000;
    const cur = sampleFlip(this._handSwapKeys || [], tt);
    const keys = (this._handSwapKeys || []).filter(k => Math.abs(k.time - tt) > 0.001);
    keys.push({ time: tt, value: !cur });
    this._handSwapKeys = sanitizeFlipKeys(keys);
    this._setStatus(`무기 손 변경 ${!cur ? '켬' : '끔'} @ ${this._frameLabelForTime(tt)}.`);
    this._renderPreview(); this._renderTimeline();
  }
  _renderFrameOverview() {
    const btn = document.getElementById('meFrameOverviewToggle');
    const host = document.getElementById('meFrameOverview');
    const grip = document.getElementById('meFrameOverviewResize');
    if (!host) return;
    if (btn) btn.textContent = `${this._frameOverviewOpen ? '▾' : '▸'} 프레임 몰아보기`;
    this._syncFrameOverviewSizeControls();
    this._syncFrameOverviewHeightControls();
    host.style.maxHeight = `${this._frameOverviewHeight || 144}px`;
    host.classList.toggle('hidden', !this._frameOverviewOpen);
    if (grip) grip.classList.toggle('hidden', !this._frameOverviewOpen);
    if (!this._frameOverviewOpen) return;
    const kfs = this.motion?.keyframes || [];
    const size = this._frameOverviewSize || 72;
    host.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
    host.innerHTML = kfs.map((kf, i) => {
      const hasHb = this._frameHasHitbox(i);
      const borderClass = i === this.selKf
        ? 'border-[#ffd24a] text-[#ffd24a]'
        : (hasHb ? 'border-[#ff5a4f] text-[#ff7a5a]' : 'border-gray-700 text-gray-300');
      return `<button type="button" data-kf="${i}" class="border ${borderClass} bg-[#14100b] hover:border-[#ffd24a] text-[9px] p-1 flex flex-col items-center gap-0.5">
      <img alt="" src="${this._frameThumbData(kf.t)}" class="w-full aspect-square object-contain bg-[#0d0a06] border border-gray-800"/>
      <span class="${hasHb ? 'text-[#ff5a4f] font-bold' : ''}">${i + 1}프레임</span>
    </button>`;
    }).join('');
    host.querySelectorAll('[data-kf]').forEach(b => b.addEventListener('click', () => {
      this.playing = false;
      this.selKf = Number(b.dataset.kf) || 0;
      this.scrubT = this.motion.keyframes[this.selKf]?.t || 0;
      this._selectHitboxForTime(this.scrubT);
      this._renderAll();
    }));
  }

  _nearestFrameIndexForTime(t = this._currentMotionTime()) {
    const kfs = this.motion?.keyframes || [];
    if (!kfs.length) return -1;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs((Number(kfs[i].t) || 0) - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  _hitboxFrameTime(hb) {
    if (!hb || typeof hb !== 'object') return 0;
    if (Number.isFinite(Number(hb.frameTime))) return clamp(Number(hb.frameTime), 0, 1);
    const a = Number(hb.activeStart), b = Number(hb.activeEnd);
    if (Number.isFinite(a) && Number.isFinite(b)) return clamp((a + b) / 2, 0, 1);
    if (Number.isFinite(a)) return clamp(a, 0, 1);
    return 0;
  }
  _hitboxFrameIndex(hb) {
    return this._nearestFrameIndexForTime(this._hitboxFrameTime(hb));
  }
  _frameHasHitbox(index) {
    return index >= 0 && this._hitboxes().some(hb => this._hitboxFrameIndex(hb) === index);
  }

  _setFrameOverviewSize(value) {
    this._frameOverviewSize = clamp(Math.round((Number(value) || 72) / 4) * 4, 48, 128);
    try { localStorage.setItem(FRAME_OVERVIEW_SIZE_KEY, String(this._frameOverviewSize)); } catch {}
    this._renderFrameOverview();
  }
  _syncFrameOverviewSizeControls() {
    const input = document.getElementById('meFrameOverviewSize');
    if (input) input.value = String(this._frameOverviewSize || 72);
  }

  _setFrameOverviewHeight(value) {
    this._frameOverviewHeight = clamp(Math.round((Number(value) || 144) / 12) * 12, 96, 360);
    try { localStorage.setItem(FRAME_OVERVIEW_HEIGHT_KEY, String(this._frameOverviewHeight)); } catch {}
    this._renderFrameOverview();
  }
  _syncFrameOverviewHeightControls() {
    const input = document.getElementById('meFrameOverviewHeight');
    if (input) input.value = String(this._frameOverviewHeight || 144);
  }

  _setDuration(value) {
    if (!this.motion) return;
    if (this._applyFixedPresetDuration()) {
      this._syncDurationControls();
      this._renderTimeline();
      this._setStatus(`${PRESET_LABELS[this._activeKey] || this._activeKey} 프리셋은 게임 동작 시간에 맞춰 길이가 고정됩니다.`);
      return;
    }
    this.motion.duration = Math.round(clamp(Number(value) || 0.5, MOTION_LIMITS.minDuration, MOTION_LIMITS.maxDuration) * 100) / 100;
    this._syncDurationControls();
    this._renderTimeline();
  }
  _fixedDurationForActivePreset() {
    return Object.prototype.hasOwnProperty.call(FIXED_PRESET_DURATIONS, this._activeKey)
      ? FIXED_PRESET_DURATIONS[this._activeKey]
      : null;
  }
  _applyFixedPresetDuration() {
    const fixed = this._fixedDurationForActivePreset();
    if (!this.motion || !Number.isFinite(fixed)) return false;
    this.motion.duration = fixed;
    return true;
  }
  _syncDurationControls() {
    this._applyFixedPresetDuration();
    const fixed = this._fixedDurationForActivePreset();
    const locked = Number.isFinite(fixed);
    const value = Math.round(clamp(Number(this.motion?.duration) || 0.5, MOTION_LIMITS.minDuration, MOTION_LIMITS.maxDuration) * 100) / 100;
    const dur = document.getElementById('meDuration');
    if (dur) { dur.value = String(value); dur.disabled = locked; dur.title = locked ? '게임 동작 시간에 맞춰 고정된 프리셋입니다.' : ''; }
    const text = document.getElementById('meDurationText');
    if (text) { text.value = value.toFixed(2); text.disabled = locked; text.title = locked ? '게임 동작 시간에 맞춰 고정된 프리셋입니다.' : ''; }
    const down = document.getElementById('meDurationDown');
    const up = document.getElementById('meDurationUp');
    if (down) down.disabled = locked;
    if (up) up.disabled = locked;
  }

  _frameThumbData(t) {
    const cv = document.createElement('canvas');
    cv.width = 72; cv.height = 72;
    const ctx = cv.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#14100b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const scale = 13;
    const pose = samplePose(this.motion, t);
    const root = sampleRootOffset(this.motion, t);
    const wrec = this._customWeapon(this.weapon);
    const wimg = this._weaponImage();
    const offId = this._offhandId();
    const offRec = this._customWeapon(offId);
    const solved = solveStickman(pose, scale, cv.width / 2 + root.x * 0.18, cv.height * 0.62 + root.y * 0.18, 1, { rawNearArm: true, weapon: this.weapon, offhandWeapon: offId });
    drawStickFromJoints(ctx, solved.joints, solved.headR, {
      color: this.look.color || WEAPON_STICK_COLOR[this.weapon] || '#cdd3da',
      accent: '#0d0a06',
      lineW: Math.max(2, (this.look.lineW || 3) - 1),
      scale,
      weapon: this.weapon,
      drawWeapon: true,
      aimAngle: 0,
      headShape: this.look.head,
      accessory: this.look.accessory,
      weaponImage: wimg,
      weaponImageSize: wrec?.size ?? 2,
      weaponImageAnchors: wrec?.anchors || null,
      weaponFlip: sampleFlip(this._flipKeys || [], t),
      weaponFlipY: sampleFlip(this._flipYKeys || [], t),
      weaponRightFlip: sampleFlip(this._flipKeys || [], t),
      weaponRightFlipY: sampleFlip(this._flipYKeys || [], t),
      weaponLeftFlip: sampleFlip(this._leftFlipKeys || [], t),
      weaponLeftFlipY: sampleFlip(this._leftFlipYKeys || [], t),
      weaponDual: !!(this._editingV2?.weaponVisual?.dual),
      weaponHandSwapped: sampleFlip(this._handSwapKeys || [], t),
      offhandWeapon: offId,
      offhandImage: offRec ? this._imageById(offId) : null,
      offhandImageSize: this._editingV2?.weaponVisual?.offhand?.scale ?? offRec?.size ?? 2,
      offhandImageAnchors: this._editingV2?.weaponVisual?.offhand?.anchors || offRec?.anchors || null,
      hatImages: this._hatListAt(t).map(h => h?.imageId ? this._imageById(h.imageId) : null),
      hats: this._hatListAt(t),
      layerOrder: this._normalizeLayerOrder(this._hatListAt(t), this._editingV2?.weaponVisual?.layerOrder),
    });
    return cv.toDataURL('image/png');
  }
  _syncBaseSliders() {
    const w = this._editingV2; if (!w) return;
    const $ = (id) => document.getElementById(id);
    if ($('ms_maxHp')) { $('ms_maxHp').value = String(w.baseStats.maxHp); if ($('ms_maxHp_v')) $('ms_maxHp_v').textContent = w.baseStats.maxHp; }
    if ($('ms_moveSpeed')) { $('ms_moveSpeed').value = String(w.baseStats.moveSpeed); if ($('ms_moveSpeed_v')) $('ms_moveSpeed_v').textContent = w.baseStats.moveSpeed; }
  }
  _syncCombatSliders(c) {
    const $ = (id) => document.getElementById(id);
    for (const k of ['damage', 'cooldownMs', 'knockback', 'statusDurationMs', 'ultimateGain', 'airborneHeight']) {
      if ($('ms_' + k)) { $('ms_' + k).value = String(c[k]); if ($('ms_' + k + '_v')) $('ms_' + k + '_v').textContent = c[k]; }
    }
    if ($('ms_status')) $('ms_status').value = c.status;
    $('ms_airborneHeightRow')?.classList.toggle('hidden', c.status !== 'airborne');
    $('meUltimateGainRow')?.classList.toggle('hidden', !['skill1', 'skill2', 'skill3'].includes(this._activeKey));
  }

  _currentFrameTime() {
    return clamp(Number(this.motion?.keyframes?.[this.selKf]?.t ?? this.scrubT ?? 0) || 0, 0, 1);
  }

  _combatForCurrentFrame(p = this._activeCombatPreset()) {
    if (!p) return null;
    return sampleCombatKeys(p.combatKeys, p.combat, this._currentFrameTime(), this._activeKey);
  }

  _upsertCombatKey(p, combat, time = this._currentFrameTime()) {
    if (!p) return;
    const tt = Math.round(clamp(Number(time) || 0, 0, 1) * 1000) / 1000;
    const keys = sanitizeCombatKeys(p.combatKeys || [], p.combat, this._activeKey).map(k => ({ time: k.time, combat: { ...k.combat } }));
    let key = keys.find(k => Math.abs(k.time - tt) < 0.001);
    if (!key) {
      key = { time: tt, combat: this._combatForCurrentFrame(p) || sanitizeCombat(p.combat, this._activeKey) };
      keys.push(key);
    }
    key.combat = sanitizeCombat(combat, this._activeKey);
    keys.sort((a, b) => a.time - b.time);
    p.combatKeys = keys.slice(0, 64);
    if (tt <= 0.001) p.combat = sanitizeCombat(combat, this._activeKey);
  }

  _syncFrameScopedControls() {
    const p = this._activeCombatPreset();
    if (p) this._syncCombatSliders(this._combatForCurrentFrame(p));
    this._syncEffectControls();
    this._syncHitboxDamageControl();
    const dash = this._editingV2?.presets?.[this._activeKey];
    if (dash?.kind === 'dash' && document.getElementById('ms_dashDistance')) {
      document.getElementById('ms_dashDistance').value = String(dash.dashDistance || 120);
      const out = document.getElementById('ms_dashDistance_v');
      if (out) out.textContent = String(dash.dashDistance || 120);
    }
  }

  _syncHitboxDamageControl() {
    const input = document.getElementById('meHitboxDamage');
    if (!input) return;
    const hb = this._hb();
    const enabled = !!(hb && COMBAT_PRESET_KINDS.has(this._activeKey));
    input.disabled = !enabled;
    if (!enabled) {
      input.value = '';
      input.placeholder = '자동';
      return;
    }
    input.value = Number.isFinite(Number(hb.damage)) ? String(Math.round(Number(hb.damage))) : '';
    const total = this._combatForCurrentFrame()?.damage;
    const hbs = this._hitboxes();
    const fallback = (Number.isFinite(Number(total)) ? Number(total) : 0) / Math.max(1, hbs.length || 1);
    input.placeholder = `자동 ${Math.round(fallback)}`;
  }

  _setHitboxDamage(raw) {
    const hb = this._hb();
    if (!hb) { this._setStatus('대미지를 지정할 히트박스가 없습니다.'); this._syncHitboxDamageControl(); return; }
    const text = String(raw ?? '').trim();
    if (!text) {
      delete hb.damage;
      this._setStatus('현재 프레임 대미지를 자동 분배로 되돌렸습니다.');
    } else {
      hb.damage = Math.round(clamp(Number(text) || 0, 0, this._activeKey === 'ultimate' ? 100 : 60));
      this._setStatus(`현재 프레임 대미지를 ${hb.damage}로 설정했습니다.`);
    }
    this._syncHitboxDamageControl();
    this._renderPreview();
  }

  _syncHeavyStats(p) {
    const box = document.getElementById('meHeavyStats');
    const show = !!(p && p.kind === 'heavy');
    box?.classList.toggle('hidden', !show);
    if (!show) return;
    const value = clamp(Math.round(Number(p.comboAfter) || 3), 1, 5);
    const input = document.getElementById('ms_heavyAfter');
    const out = document.getElementById('ms_heavyAfter_v');
    if (input) input.value = String(value);
    if (out) out.textContent = String(value);
  }

  _setHeavyAfter(value) {
    const w = this._editingV2;
    const p = w && w.presets && w.presets[this._activeKey];
    if (!p || p.kind !== 'heavy') return;
    p.comboAfter = clamp(Math.round(Number(value) || 3), 1, 5);
    this._syncHeavyStats(p);
    this._setStatus(`강공격은 평타 ${p.comboAfter}회 후 발동합니다.`);
  }

  /** Live-update one workshop stat → V2 model, blocking any change that pushes the
   *  budget over 100 (except cooldown, which is budget-free). Lower always allowed. */
  _updateStat(key, value) {
    const w = this._editingV2; if (!w) return;
    const $ = (id) => document.getElementById(id);
    if (key === 'maxHp' || key === 'moveSpeed') {
      const prev = w.baseStats[key];
      w.baseStats[key] = key === 'maxHp' ? Math.round(value) : Math.round(value * 100) / 100;
      if (baseStatsCost(w.baseStats) > POINT_BUDGET) { w.baseStats[key] = prev; this._budgetBlocked(); }
      this._syncBaseSliders();
    } else if (key === 'dashDistance') {
      const p = w.presets[this._activeKey];
      if (p) { p.dashDistance = Math.round(Math.max(0, Math.min(320, value))); if ($('ms_dashDistance')) $('ms_dashDistance').value = String(p.dashDistance); if ($('ms_dashDistance_v')) $('ms_dashDistance_v').textContent = p.dashDistance; }
    } else {
      const p = w.presets[this._activeKey]; if (!p || !p.combat) return;
      const prevCombat = { ...p.combat };
      const prevKeys = Array.isArray(p.combatKeys) ? p.combatKeys.map(k => ({ time: k.time, combat: { ...k.combat } })) : [];
      const next = { ...(this._combatForCurrentFrame(p) || p.combat) };
      if (key === 'status') next.status = value;
      else next[key] = value;
      this._upsertCombatKey(p, next);
      if (combatCost(this._combatForCurrentFrame(p), this._activeKey) > POINT_BUDGET || statCostV2(w) > POINT_BUDGET) {
        p.combat = sanitizeCombat(prevCombat, this._activeKey);
        p.combatKeys = prevKeys;
        this._budgetBlocked();
      }
      this._syncCombatSliders(this._combatForCurrentFrame(p));
    }
    this._tutEvent('stat');
    this._renderBudget();
  }
  _budgetBlocked() {
    const bar = document.getElementById('meBudgetBar');
    if (bar) { bar.style.background = '#ff5a5a'; setTimeout(() => this._renderBudget(), 220); }
    this._setStatus('예산 100을 넘어 더 올릴 수 없습니다. 다른 스탯이나 프리셋을 줄여 보세요.');
  }

  _updateBlockCount() {
    const el = document.getElementById('meBlockCount');
    if (el) el.textContent = (this.blocks && this.blocks.events && this.blocks.events.length) ? '(기믹 있음)' : '';
  }

  _renderBudget() {
    let cost = 0;
    if (this._editingV2) {
      const p = this._editingV2.presets?.[this._activeKey];
      cost = p && p.combat ? combatCost(this._combatForCurrentFrame(p) || p.combat, this._activeKey) : baseStatsCost(this._editingV2.baseStats);
    }
    const bar = document.getElementById('meBudgetBar');
    const val = document.getElementById('meBudgetVal');
    if (val) val.textContent = cost;
    if (bar) {
      bar.style.width = Math.min(100, cost) + '%';
      bar.style.background = cost > POINT_BUDGET ? '#ff5a5a' : (cost > POINT_BUDGET * 0.85 ? '#ffd24a' : '#7df09a');
    }
  }
  close() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._tutStop();
    this.root?.classList.add('hidden');
  }

  // --- Custom weapon images --------------------------------------------------
  _populateWeaponSelect() {
    const wsel = document.getElementById('meWeapon'); if (!wsel) return;
    const base = EDITOR_WEAPONS.map(w => `<option value="${w}">${EDITOR_WEAPON_LABEL[w] || w}</option>`).join('');
    const custom = this.customWeapons.length
      ? `<optgroup label="내 무기 이미지">${this.customWeapons.map(c => `<option value="${escOpt(c.id)}">🖼 ${escOpt(c.name)}</option>`).join('')}</optgroup>`
      : '';
    wsel.innerHTML = base + custom;
    wsel.value = this.weapon;
    this._populateDualWeaponSelect();
    this._populateProjectileSelect(document.getElementById('pj_imageId')?.value || 'arrow');
    this._populateEffectSelect(document.getElementById('meEffectAsset')?.value || 'spark');
  }
  _customWeapon(id) { return this.customWeapons.find(c => c.id === id) || null; }
  /** The (lazily loaded) Image for the current weapon, or null for a built-in. */
  _weaponImage() {
    const c = this._customWeapon(this.weapon); if (!c) return null;
    let img = this._wimgCache[c.id];
    if (!img) { img = new Image(); img.onload = () => { if (!this.playing) this._renderPreview(); }; img.src = c.src; this._wimgCache[c.id] = img; }
    return img;
  }
  _imageById(id) {
    const c = this._customWeapon(id); if (!c) return null;
    let img = this._wimgCache[c.id];
    if (!img) { img = new Image(); img.onload = () => { if (!this.playing) this._renderPreview(); }; img.src = c.src; this._wimgCache[c.id] = img; }
    return img;
  }
  /** Show/hide the size slider + delete button for the current weapon. */
  _syncWeaponUI() {
    const c = this._customWeapon(this.weapon);
    const wrap = document.getElementById('meWeaponSizeWrap');
    if (wrap) wrap.classList.toggle('hidden', !c);
    const sl = document.getElementById('meWeaponSize'); if (sl && c) sl.value = String(c.size ?? 2.0);
    this._syncDualControls();
  }
  _populateDualWeaponSelect() {
    const sel = document.getElementById('meDualWeapon'); if (!sel) return;
    const base = EDITOR_WEAPONS.map(w => `<option value="${w}">${EDITOR_WEAPON_LABEL[w] || w}</option>`).join('');
    const custom = this.customWeapons.length
      ? `<optgroup label="내 무기 이미지">${this.customWeapons.map(c => `<option value="${escOpt(c.id)}">🖼 ${escOpt(c.name)}</option>`).join('')}</optgroup>`
      : '';
    sel.innerHTML = base + custom;
    sel.value = this._offhandId() || this.weapon || 'sword';
  }
  _offhandId() {
    const off = this._editingV2?.weaponVisual?.offhand;
    return off?.imageId || this._editingV2?.weaponVisual?.imageId || this.weapon || 'sword';
  }
  _offhandRecord() {
    return this._customWeapon(this._offhandId());
  }
  _syncDualControls() {
    const visual = this._editingV2?.weaponVisual || {};
    const enabled = !!visual.dual;
    const panel = document.getElementById('meDualPanel');
    const controls = document.getElementById('meDualControls');
    const chk = document.getElementById('meDualWield');
    if (chk) chk.checked = enabled;
    if (panel && enabled) panel.open = true;
    if (controls) controls.classList.toggle('hidden', !enabled);
    this._populateDualWeaponSelect();
    const rec = this._offhandRecord();
    const wrap = document.getElementById('meDualSizeWrap');
    if (wrap) wrap.classList.toggle('hidden', !enabled || !rec);
    const sl = document.getElementById('meDualWeaponSize');
    if (sl && rec) sl.value = String(visual.offhand?.scale ?? rec.size ?? 2);
  }
  _setOffhandWeapon(id) {
    if (!this._editingV2) return;
    const visual = { ...(this._editingV2.weaponVisual || {}), dual: true };
    const prevId = visual.offhand?.imageId || null;
    const nextId = id || this.weapon || 'sword';
    visual.offhand = { ...(visual.offhand || {}), imageId: nextId };
    if (prevId && prevId !== nextId) delete visual.offhand.anchors;
    const rec = this._customWeapon(visual.offhand.imageId);
    if (rec) visual.offhand.scale = rec.size || 2;
    this._editingV2.weaponVisual = visual;
    this._syncDualControls();
    this._renderPreview();
  }
  _setOffhandSize(value) {
    const rec = this._offhandRecord(); if (!rec) return;
    const scale = clamp(Number.isFinite(value) ? value : 2, 0.6, 4.5);
    if (this._editingV2) {
      const visual = { ...(this._editingV2.weaponVisual || {}), dual: true };
      visual.offhand = { ...(visual.offhand || {}), imageId: rec.id, scale };
      this._editingV2.weaponVisual = visual;
    }
    this._renderPreview();
  }
  _openDualWeaponPicker() {
    if (!this._editingV2?.weaponVisual?.dual) return;
    document.getElementById('meDualPicker')?.remove();
    const current = this._offhandId();
    const options = [
      ...EDITOR_WEAPONS.map(id => ({ id, name: EDITOR_WEAPON_LABEL[id] || id, custom: false })),
      ...this.customWeapons.map(c => ({ id: c.id, name: c.name, custom: true })),
    ];
    const modal = document.createElement('div');
    modal.id = 'meDualPicker';
    modal.className = 'fixed inset-0 z-[96] bg-black/75 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-[#14100b] border-2 border-[#ffd24a] w-full max-w-[520px] max-h-[80vh] flex flex-col font-mono shadow-[0_0_24px_rgba(0,0,0,.7)]">
        <div class="flex items-center justify-between border-b border-[#5a4320] px-3 py-2">
          <b class="text-[#ffd24a] text-sm">왼손 무기 이미지 선택</b>
          <button type="button" data-dual-close class="text-gray-300 hover:text-white text-lg leading-none px-2">&times;</button>
        </div>
        <div class="p-3 text-[10px] text-gray-400 border-b border-gray-800">선택한 무기는 왼손에 장착되고, 주황색 이도 기준점으로 각도를 따로 조절합니다.</div>
        <div class="grid grid-cols-3 sm:grid-cols-4 gap-2 p-3 overflow-y-auto">
          ${options.map(o => `<button type="button" data-dual-id="${escOpt(o.id)}" class="bg-[#0d0a06] hover:bg-[#22180f] border ${o.id === current ? 'border-[#ffd24a] text-[#ffd24a]' : 'border-gray-700 text-gray-200'} min-h-[58px] p-2 text-[10px] flex flex-col items-center justify-center gap-1">
            <span>${o.custom ? '이미지' : '기본'}</span>
            <b class="break-all text-center">${escOpt(o.name)}</b>
          </button>`).join('')}
        </div>
      </div>`;
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-dual-close]')) { close(); return; }
      const pick = e.target.closest('[data-dual-id]');
      if (!pick) return;
      this._setOffhandWeapon(pick.dataset.dualId);
      close();
    });
    document.body.appendChild(modal);
  }
  _setHat(hat) {
    if (!this._editingV2) return;
    const visual = { ...(this._editingV2.weaponVisual || {}) };
    if (!hat) {
      visual.hats = [];
      visual.hat = null;
      visual.selectedHat = 0;
    } else {
      visual.hats = [hat];
      visual.hat = hat;
      visual.selectedHat = 0;
    }
    this._editingV2.weaponVisual = visual;
    this._syncHatControls();
    this._renderPreview();
  }
  _hatList() {
    const visual = this._editingV2?.weaponVisual || {};
    const list = Array.isArray(visual.hats) ? visual.hats.filter(Boolean) : [];
    if (!list.length && visual.hat && typeof visual.hat === 'object') list.push(visual.hat);
    return list.slice(0, 5).map((h, i) => this._normalizeHat(h, i));
  }
  _normalizeHat(h, i = 0) {
    const gx = Number.isFinite(Number(h?.anchors?.gx)) ? clamp(Number(h.anchors.gx), 0, 1) : (Number.isFinite(Number(h?.anchorX)) ? clamp(Number(h.anchorX), 0, 1) : 0.5);
    const gy = Number.isFinite(Number(h?.anchors?.gy)) ? clamp(Number(h.anchors.gy), 0, 1) : (Number.isFinite(Number(h?.anchorY)) ? clamp(Number(h.anchorY), 0, 1) : 0.5);
    const tx = Number.isFinite(Number(h?.anchors?.tx)) ? clamp(Number(h.anchors.tx), 0, 1) : 0.85;
    const ty = Number.isFinite(Number(h?.anchors?.ty)) ? clamp(Number(h.anchors.ty), 0, 1) : 0.5;
    return {
      id: h?.id || ('decor:' + i),
      imageId: h?.imageId || null,
      name: h?.name || `장식 ${i + 1}`,
      scale: Number.isFinite(Number(h?.scale)) ? Number(h.scale) : 1,
      offsetX: Number.isFinite(Number(h?.offsetX)) ? Number(h.offsetX) : 0,
      offsetY: Number.isFinite(Number(h?.offsetY)) ? Number(h.offsetY) : -18,
      alpha: Number.isFinite(Number(h?.alpha)) ? Number(h.alpha) : 1,
      rotation: Number.isFinite(Number(h?.rotation)) ? Number(h.rotation) : 0,
      anchorX: Number.isFinite(Number(h?.anchorX)) ? clamp(Number(h.anchorX), 0, 1) : 0.5,
      anchorY: Number.isFinite(Number(h?.anchorY)) ? clamp(Number(h.anchorY), 0, 1) : 0.5,
      layer: DECORATION_LAYERS.some(([v]) => v === h?.layer) ? h.layer : 'overPlayer',
      showHandles: h?.showHandles !== false,
      followHead: !!h?.followHead,
      anchors: { gx, gy, tx, ty },
      keys: Array.isArray(h?.keys) ? h.keys.slice(0, 64).map(k => ({
        t: clamp(Number(k.t) || 0, 0, 1),
        offsetX: Number.isFinite(Number(k.offsetX)) ? Number(k.offsetX) : undefined,
        offsetY: Number.isFinite(Number(k.offsetY)) ? Number(k.offsetY) : undefined,
        rotation: Number.isFinite(Number(k.rotation)) ? Number(k.rotation) : undefined,
        scale: Number.isFinite(Number(k.scale)) ? Number(k.scale) : undefined,
        alpha: Number.isFinite(Number(k.alpha)) ? Number(k.alpha) : undefined,
      })).sort((a, b) => a.t - b.t) : [],
    };
  }
  _hatStateAt(hat, t = this._currentMotionTime()) {
    const base = this._normalizeHat(hat);
    const keys = (base.keys || []).filter(k => k && Number.isFinite(k.t));
    if (!keys.length) return base;
    const fields = ['offsetX', 'offsetY', 'rotation', 'scale', 'alpha'];
    const out = { ...base };
    for (const field of fields) {
      const fks = keys.filter(k => Number.isFinite(Number(k[field])));
      if (!fks.length) continue;
      if (t <= fks[0].t) { out[field] = fks[0][field]; continue; }
      if (t >= fks[fks.length - 1].t) { out[field] = fks[fks.length - 1][field]; continue; }
      const b = fks.findIndex(k => k.t >= t);
      const k1 = fks[Math.max(0, b - 1)], k2 = fks[b];
      const span = Math.max(0.0001, k2.t - k1.t);
      const r = (t - k1.t) / span;
      out[field] = k1[field] + (k2[field] - k1[field]) * r;
    }
    return out;
  }
  _hatListAt(t = this._currentMotionTime()) {
    return this._hatList().map(h => this._hatStateAt(h, t));
  }
  _writeHats(hats, selected = null, opts = {}) {
    if (!this._editingV2) return;
    const list = hats.filter(Boolean).slice(0, 5).map((h, i) => this._normalizeHat(h, i));
    const maxIndex = Math.max(0, list.length - 1);
    const sel = list.length ? clamp(Number.isFinite(selected) ? selected : (this._editingV2.weaponVisual?.selectedHat || 0), 0, maxIndex) : 0;
    this._editingV2.weaponVisual = {
      ...(this._editingV2.weaponVisual || {}),
      hats: list,
      hat: list[0] || null,
      selectedHat: sel,
      layerOrder: this._normalizeLayerOrder(list, this._editingV2.weaponVisual?.layerOrder),
    };
    if (opts.sync !== false) this._syncHatControls();
    this._renderPreview();
  }
  _selectedHatIndex() {
    const hats = this._hatList();
    const idx = Number(this._editingV2?.weaponVisual?.selectedHat);
    return hats.length ? clamp(Number.isFinite(idx) ? idx : 0, 0, hats.length - 1) : 0;
  }
  _selectHat(index) {
    const hats = this._hatList();
    if (!hats.length) return;
    this._writeHats(hats, index);
  }
  _removeSelectedHat() {
    const hats = this._hatList();
    if (!hats.length) { this._setHat(null); return; }
    const idx = this._selectedHatIndex();
    hats.splice(idx, 1);
    this._writeHats(hats, Math.min(idx, hats.length - 1));
  }
  _updateHat(field, value) {
    if (!this._editingV2) return;
    this._updateHatAt(this._selectedHatIndex(), field, value);
  }
  _updateHatAt(index, field, value, opts = {}) {
    if (!this._editingV2) return;
    const hats = this._hatList();
    const idx = clamp(Number(index) || 0, 0, Math.max(0, hats.length - 1));
    const cur = hats[idx];
    if (!cur) return;
    if (['offsetX', 'offsetY', 'rotation', 'scale', 'alpha'].includes(field)) {
      hats[idx] = this._setHatKeyValue(cur, field, value);
    } else if (field === 'name') {
      hats[idx] = { ...cur, name: String(value || '').slice(0, 24) || `장식 ${idx + 1}` };
    } else if (field === 'showHandles') {
      hats[idx] = { ...cur, showHandles: !!value };
    } else if (field === 'followHead') {
      hats[idx] = { ...cur, followHead: !!value };
    } else if (field === 'layer') {
      hats[idx] = { ...cur, layer: DECORATION_LAYERS.some(([v]) => v === value) ? value : 'overPlayer' };
    } else if (field === 'anchorX' || field === 'anchorY') {
      const v = clamp(Number(value) || 0, 0, 1);
      const anchors = { ...(cur.anchors || { gx: cur.anchorX, gy: cur.anchorY, tx: 0.85, ty: 0.5 }) };
      if (field === 'anchorX') anchors.gx = v;
      else anchors.gy = v;
      hats[idx] = { ...cur, [field]: v, anchors };
    } else {
      hats[idx] = { ...cur, [field]: value };
    }
    this._writeHats(hats, idx, opts);
  }
  _setHatKeyValue(hat, field, value, t = this._currentMotionTime()) {
    const v = Number(value);
    const tt = Math.round(clamp(Number(t) || 0, 0, 1) * 1000) / 1000;
    const keys = Array.isArray(hat.keys) ? hat.keys.map(k => ({ ...k })) : [];
    let key = keys.find(k => Math.abs(k.t - tt) < 0.001);
    if (!key) {
      key = { t: tt };
      const sampled = this._hatStateAt(hat, tt);
      for (const f of ['offsetX', 'offsetY', 'rotation', 'scale', 'alpha']) key[f] = sampled[f];
      keys.push(key);
    }
    key[field] = Number.isFinite(v) ? v : 0;
    keys.sort((a, b) => a.t - b.t);
    return { ...hat, [field]: key[field], keys: keys.slice(0, 64) };
  }
  _syncHatControls() {
    const hats = this._hatList();
    const idx = this._selectedHatIndex();
    const host = document.getElementById('meHatControls');
    if (host) host.classList.add('hidden');
    const slots = document.getElementById('meHatSlots');
    if (slots) {
      slots.classList.toggle('hidden', !hats.length);
      const states = hats.map(h => this._hatStateAt(h));
      slots.innerHTML = hats.map((h, i) => this._hatControlHtml(h, states[i], i, idx)).join('');
    }
    const layerBlock = document.getElementById('meLayerBlock');
    if (layerBlock) {
      layerBlock.classList.remove('hidden');
      layerBlock.innerHTML = `
        <div class="text-[#ffd24a] font-bold mb-1">레이어</div>
        <div class="flex flex-col gap-0">${this._layerRowsHtml(hats)}</div>
        <div class="text-[8px] text-gray-500 mt-1">장식·플레이어·무기를 잡고 드래그하세요. 아래에 있을수록 뒤에, 위에 있을수록 앞에 그려집니다.</div>`;
    }
  }
  _defaultLayerOrder(hats = this._hatList()) {
    const behind = [], middle = [], front = [];
    const weapons = this._editingV2?.weaponVisual?.dual ? ['weapon:left', 'weapon:right'] : ['weapon'];
    hats.forEach((h, i) => {
      if (h.layer === 'behindPlayer') behind.push(`hat:${i}`);
      else if (h.layer === 'overWeapon') front.push(`hat:${i}`);
      else middle.push(`hat:${i}`);
    });
    return [...behind, 'player', ...middle, ...weapons, ...front];
  }
  _normalizeLayerOrder(hats = this._hatList(), raw = this._editingV2?.weaponVisual?.layerOrder) {
    const dual = !!this._editingV2?.weaponVisual?.dual;
    const weapons = dual ? ['weapon:left', 'weapon:right'] : ['weapon'];
    const allowed = new Set(['player', ...weapons, ...hats.map((_, i) => `hat:${i}`)]);
    const out = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const key = String(item || '');
        if (dual && key === 'weapon') {
          for (const w of weapons) if (!out.includes(w)) out.push(w);
          continue;
        }
        if (!dual && (key === 'weapon:left' || key === 'weapon:right')) {
          if (!out.includes('weapon')) out.push('weapon');
          continue;
        }
        if (allowed.has(key) && !out.includes(key)) out.push(key);
      }
    }
    for (const item of this._defaultLayerOrder(hats)) {
      if (allowed.has(item) && !out.includes(item)) out.push(item);
    }
    return out;
  }
  _hatsWithLayersFromOrder(hats, order = this._normalizeLayerOrder(hats)) {
    const playerPos = order.indexOf('player');
    const weaponPositions = ['weapon', 'weapon:left', 'weapon:right'].map(item => order.indexOf(item)).filter(pos => pos >= 0);
    const frontWeaponPos = weaponPositions.length ? Math.max(...weaponPositions) : -1;
    return hats.map((h, i) => {
      const pos = order.indexOf(`hat:${i}`);
      let layer = 'overPlayer';
      if (pos >= 0 && playerPos >= 0 && pos < playerPos) layer = 'behindPlayer';
      else if (pos >= 0 && frontWeaponPos >= 0 && pos > frontWeaponPos) layer = 'overWeapon';
      return { ...h, layer };
    });
  }
  _layerRowsHtml(hats) {
    const rows = [];
    const order = this._normalizeLayerOrder(hats);
    const row = (item, orderIndex) => {
      if (item === 'player') {
        return `<div draggable="true" data-layer-item="player" data-layer-index="${orderIndex}" class="cursor-grab active:cursor-grabbing flex items-center gap-2 bg-[#101820] border border-[#3b6b82] px-2 py-1">
          <span class="text-[#ffd24a]">☰</span><span class="truncate flex-1">플레이어</span><span class="text-gray-500">몸체</span>
        </div>`;
      }
      if (item === 'weapon' || item === 'weapon:right' || item === 'weapon:left') {
        const label = item === 'weapon:left' ? '왼손 무기' : (item === 'weapon:right' ? '오른손 무기' : '무기');
        const hint = item === 'weapon:left' ? '검집/보조' : (item === 'weapon:right' ? '주무기' : (this._editingV2?.weaponVisual?.dual ? '오른손 / 왼손' : '오른손'));
        return `<div draggable="true" data-layer-item="${item}" data-layer-index="${orderIndex}" class="cursor-grab active:cursor-grabbing flex items-center gap-2 bg-[#201810] border border-[#7a5a24] px-2 py-1">
          <span class="text-[#ffd24a]">☰</span><span class="truncate flex-1">${label}</span><span class="text-gray-500">${hint}</span>
        </div>`;
      }
      const i = Number(item.replace('hat:', ''));
      const h = hats[i];
      if (!h) return '';
      return `<div draggable="true" data-layer-item="hat:${i}" data-layer-index="${orderIndex}" class="cursor-grab active:cursor-grabbing flex items-center gap-2 bg-[#14100b] border border-gray-700 px-2 py-1">
      <span class="text-[#ffd24a]">☰</span><span class="truncate flex-1">${escOpt(h.name || `장식 ${i + 1}`)}</span><span class="text-gray-500">장식</span>
    </div>`;
    };
    order.forEach((item, i) => {
      rows.push(row(item, i));
    });
    return rows.join('');
  }
  _moveLayerItem(item, dropIndex) {
    if (!this._editingV2) return;
    const hats = this._hatList();
    const order = this._normalizeLayerOrder(hats);
    if (!order.includes(item)) return;
    const from = order.indexOf(item);
    order.splice(from, 1);
    const to = clamp(Number(dropIndex) || 0, 0, order.length);
    order.splice(to > from ? to - 1 : to, 0, item);
    const layered = this._hatsWithLayersFromOrder(hats, order);
    this._editingV2.weaponVisual = {
      ...(this._editingV2.weaponVisual || {}),
      hats: layered,
      hat: layered[0] || null,
      selectedHat: this._selectedHatIndex(),
      layerOrder: this._normalizeLayerOrder(layered, order),
    };
    this._syncHatControls();
    this._renderPreview();
  }
  _openHatAnchor(index) {
    const hats = this._hatList();
    const h = hats[index];
    const rec = h?.imageId ? this._customWeapon(h.imageId) : null;
    if (!h || !rec) return;
    this._openAnchorPicker(rec.src, h.name || rec.name || '장식', rec, { hatIndex: index });
  }
  _hatControlHtml(h, state, i, selected) {
    const img = h.imageId ? this._customWeapon(h.imageId)?.src : '';
    const v = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;
    return `<div data-hat-card="${i}" class="border ${i === selected ? 'border-[#ffd24a]' : 'border-gray-700'} bg-[#0d0a06] p-1.5 flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <button type="button" data-hat-slot="${i}" class="w-8 h-8 border border-gray-700 bg-[#14100b] flex items-center justify-center overflow-hidden">${img ? `<img src="${img}" class="max-w-full max-h-full object-contain"/>` : `<span>${i + 1}</span>`}</button>
        <input data-hat-index="${i}" data-hat-field="name" data-hat-text="1" value="${escOpt(h.name || `장식 ${i + 1}`)}" class="flex-1 min-w-0 bg-[#14100b] border border-gray-700 text-white px-1 py-1 text-[10px]"/>
        <label class="flex items-center gap-1 text-[9px]"><input type="checkbox" data-hat-index="${i}" data-hat-field="showHandles" ${h.showHandles !== false ? 'checked' : ''}/>점</label>
        <label class="flex items-center gap-1 text-[9px]"><input type="checkbox" data-hat-index="${i}" data-hat-field="followHead" ${h.followHead ? 'checked' : ''}/>머리</label>
        <button type="button" data-hat-anchor="${i}" class="border border-[#ffa050] text-[#ffa050] px-1 py-1">⚓</button>
        <button type="button" data-hat-remove="${i}" class="border border-red-500 text-red-300 px-1 py-1">삭제</button>
      </div>
      <div class="grid grid-cols-2 gap-1">
        <label> X <input data-hat-index="${i}" data-hat-field="offsetX" type="range" min="-120" max="120" step="1" value="${v(state.offsetX)}" class="w-full"/></label>
        <label> Y <input data-hat-index="${i}" data-hat-field="offsetY" type="range" min="-120" max="120" step="1" value="${v(state.offsetY, -18)}" class="w-full"/></label>
        <label> 회전 <input data-hat-index="${i}" data-hat-field="rotation" type="range" min="-180" max="180" step="1" value="${v(state.rotation)}" class="w-full"/></label>
        <label> 크기 <input data-hat-index="${i}" data-hat-field="scale" type="range" min="0.2" max="4" step="0.05" value="${v(state.scale, 1)}" class="w-full"/></label>
        <label> 투명 <input data-hat-index="${i}" data-hat-field="alpha" type="range" min="0" max="1" step="0.05" value="${v(state.alpha, 1)}" class="w-full"/></label>
      </div>
    </div>`;
  }
  _onHatFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { this._setStatus('장식은 이미지 파일만 넣을 수 있어요.'); return; }
    const reader = new FileReader();
    reader.onload = () => this._addHatImage(String(reader.result), (file.name || '장식').replace(/\.[^.]+$/, '').slice(0, 16) || '장식');
    reader.onerror = () => this._setStatus('장식 파일을 읽지 못했어요.');
    reader.readAsDataURL(file);
  }
  _addHatImage(dataUrl, name) {
    if (this._hatList().length >= 5) { this._setStatus('장식은 최대 5개까지 추가할 수 있어요.'); return; }
    normalizeCustomImageDataUrl(dataUrl).then(({ src, img }) => {
      const rec = { id: 'custom:' + Date.now().toString(36), name, src, size: 1, anchors: null };
      this.customWeapons.push(rec);
      saveCustomWeapons(this.customWeapons);
      if (img) this._wimgCache[rec.id] = img;
      const hats = this._hatList();
      hats.push({ imageId: rec.id, name: rec.name, scale: 1, offsetX: 0, offsetY: -18, alpha: 1 });
      this._writeHats(hats, hats.length - 1);
      this._setStatus('장식 이미지가 400x400 박스 안에 맞춰 추가되었습니다. 위치·회전·크기·투명도를 조절하세요.');
    }).catch(() => this._setStatus('장식 이미지를 불러오지 못했어요.'));
  }
  _onWeaponFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { this._setStatus('이미지 파일만 넣을 수 있어요 (PNG 권장).'); return; }
    const reader = new FileReader();
    // Upload flow: pick the grip/tip anchors FIRST, then register on 확인.
    reader.onload = async () => {
      const normalized = await normalizeCustomImageDataUrl(String(reader.result));
      this._openAnchorPicker(normalized.src, (file.name || '무기').replace(/\.[^.]+$/, '').slice(0, 16) || '무기');
    };
    reader.onerror = () => this._setStatus('파일을 읽지 못했어요.');
    reader.readAsDataURL(file);
  }
  /** Normalize to a 400px square canvas, then register + select. */
  _addWeaponImage(dataUrl, name, anchors) {
    normalizeCustomImageDataUrl(dataUrl).then(({ src, img }) => {
      const rec = { id: 'custom:' + Date.now().toString(36), name, src, size: 2.0, anchors: anchors || null };
      this.customWeapons.push(rec); saveCustomWeapons(this.customWeapons);
      if (img) this._wimgCache[rec.id] = img;
      this.weapon = rec.id;
      this._populateWeaponSelect(); this._populateProjectileSelect(document.getElementById('pj_imageId')?.value || 'arrow'); this._syncWeaponUI();
      this._loadTemplate();
      this._setStatus('무기 이미지 추가됨! 400x400 박스 기준으로 저장했습니다. 주황 점과 ⚓기준점으로 손잡이·끝을 맞출 수 있어요.');
    }).catch(() => this._setStatus('이미지를 불러오지 못했어요.'));
  }

  // --- Grip/tip anchor picker -------------------------------------------------
  /** Open the picker for a fresh upload (rec=null) or an existing weapon (rec). */
  _openAnchorPicker(dataUrl, name, rec = null, opts = {}) {
    const modal = document.getElementById('meAnchorModal');
    const cv = document.getElementById('meAnchorCanvas');
    if (!modal || !cv) return;
    const img = new Image();
    img.onload = () => {
      // New imports are normalized to a square image, so the picker uses the
      // same square coordinate space that will be stored and rendered later.
      const s = Math.min(CUSTOM_IMAGE_BOX_SIZE / img.naturalWidth, CUSTOM_IMAGE_BOX_SIZE / img.naturalHeight, 4);
      cv.width = Math.max(80, Math.round(img.naturalWidth * s));
      cv.height = Math.max(80, Math.round(img.naturalHeight * s));
      const offhand = !!opts.offhand;
      const hatIndex = Number.isFinite(opts.hatIndex) ? opts.hatIndex : -1;
      const off = this._editingV2?.weaponVisual?.offhand;
      const hat = hatIndex >= 0 ? this._hatList()[hatIndex] : null;
      const hatMode = !!hat;
      const raw = (hat && hat.anchors) || (offhand && off?.anchors) || (rec && rec.anchors) || null;
      const a = hatMode
        ? {
            gx: Number.isFinite(Number(raw?.gx)) ? clamp(Number(raw.gx), 0, 1) : 0.5,
            gy: Number.isFinite(Number(raw?.gy)) ? clamp(Number(raw.gy), 0, 1) : 0.5,
            tx: Number.isFinite(Number(raw?.tx)) ? clamp(Number(raw.tx), 0, 1) : 0.85,
            ty: Number.isFinite(Number(raw?.ty)) ? clamp(Number(raw.ty), 0, 1) : 0.5,
          }
        : (raw || { gx: 0.15, gy: 0.5, tx: 0.95, ty: 0.5 });
      this._anchor = {
        img, dataUrl, name, rec, offhand, hatIndex, hatMode,
        g: { x: a.gx, y: a.gy },
        t: { x: a.tx, y: a.ty },
        drag: null,
        cv,
      };
      const title = document.getElementById('meAnchorTitle');
      const help = document.getElementById('meAnchorHelp');
      if (title) title.textContent = hatMode ? '⚓ 장식 앵커 설정' : '⚓ 무기 기준점 설정';
      if (help) {
        help.innerHTML = hatMode
          ? '<b class="text-[#ff5a5a]">🔴 이동</b>과 <b style="color:#ffa050">🟠 기울기</b> 점을 이미지 안에서 맞추세요. 에디팅 화면의 점들은 이 앵커 위치를 실제 장식 이미지 위에 그대로 표시합니다.'
          : '<b style="color:#ffa050">🟠 손잡이</b>와 <b class="text-[#ff5a5a]">🔴 끝부분</b> 점을 끌어(또는 클릭해) 위치를 맞추세요. 손잡이가 스틱맨 <b>손</b>에 붙고, 끝부분이 <b>무기 관절(주황 점)</b> 방향을 향하며, 손잡이~끝 거리가 무기 길이가 됩니다.';
      }
      this._drawAnchorPicker();
      modal.classList.remove('hidden');
    };
    img.onerror = () => this._setStatus('이미지를 불러오지 못했어요.');
    img.src = dataUrl;
  }
  _drawAnchorPicker() {
    const A = this._anchor; if (!A) return;
    const ctx = A.cv.getContext('2d'); const W = A.cv.width, H = A.cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0a06'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(A.img, 0, 0, W, H);
    const g = { x: A.g.x * W, y: A.g.y * H }, t = { x: A.t.x * W, y: A.t.y * H };
    // grip→tip / move→tilt guide line
    ctx.strokeStyle = 'rgba(255,210,74,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(t.x, t.y); ctx.stroke(); ctx.setLineDash([]);
    const dot = (p, fill, label) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = '#0d0a06'; ctx.fillText(label[0], p.x, p.y + 3.5);
      ctx.fillStyle = fill; ctx.fillText(label, p.x, p.y - 13);
    };
    dot(g, A.hatMode ? '#ff5a5a' : '#ffa050', A.hatMode ? '이동' : '손잡이');
    dot(t, '#ffa050', A.hatMode ? '기울기' : '끝');
  }
  _anchorXY(e) {
    const A = this._anchor; const r = A.cv.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  _anchorDown(e) {
    const A = this._anchor; if (!A) return;
    e.preventDefault();
    const p = this._anchorXY(e);
    const dist = (m) => Math.hypot((m.x - p.x) * A.cv.width, (m.y - p.y) * A.cv.height);
    // Grab whichever anchor is closer (drag or tap-to-place).
    A.drag = dist(A.g) <= dist(A.t) ? 'g' : 't';
    A[A.drag] = p; this._drawAnchorPicker();
  }
  _anchorMove(e) {
    const A = this._anchor; if (!A || !A.drag) return;
    e.preventDefault();
    A[A.drag] = this._anchorXY(e); this._drawAnchorPicker();
  }
  _anchorConfirm() {
    const A = this._anchor; if (!A) return this._anchorClose();
    const rnd = (v) => Math.round(v * 1000) / 1000;
    let anchors = { gx: rnd(A.g.x), gy: rnd(A.g.y), tx: rnd(A.t.x), ty: rnd(A.t.y) };
    // Degenerate (same point) → fall back to a sane default axis.
    if (Math.hypot(anchors.tx - anchors.gx, anchors.ty - anchors.gy) < 0.02) {
      anchors = A.hatMode ? { gx: 0.5, gy: 0.5, tx: 0.85, ty: 0.5 } : { gx: 0.15, gy: 0.5, tx: 0.95, ty: 0.5 };
    }
    if (A.rec && A.hatIndex >= 0 && this._editingV2) {
      const hats = this._hatList();
      const hat = hats[A.hatIndex];
      if (hat) {
        hats[A.hatIndex] = { ...hat, anchors, anchorX: anchors.gx, anchorY: anchors.gy };
        this._writeHats(hats, A.hatIndex);
        this._setStatus('장식 앵커를 다시 설정했습니다.');
      }
    } else if (A.rec && A.offhand && this._editingV2) {
      const visual = { ...(this._editingV2.weaponVisual || {}), dual: true };
      visual.offhand = {
        ...(visual.offhand || {}),
        imageId: A.rec.id,
        scale: visual.offhand?.scale ?? A.rec.size ?? 2,
        anchors,
      };
      this._editingV2.weaponVisual = visual;
      this._syncDualControls();
      this._renderPreview();
      this._setStatus('왼손 무기 기준점을 다시 설정했습니다.');
    } else if (A.rec) {                            // editing an existing weapon
      A.rec.anchors = anchors;
      saveCustomWeapons(this.customWeapons);
      delete this._wimgCache[A.rec.id];
      invalidateWeaponImage(A.rec.id);
      this._renderPreview();
      this._setStatus('기준점을 다시 설정했습니다.');
    } else {
      this._addWeaponImage(A.dataUrl, A.name, anchors);
    }
    this._anchorClose();
  }
  _anchorClose() {
    this._anchor = null;
    document.getElementById('meAnchorModal')?.classList.add('hidden');
  }
  _delCustomWeapon() {
    const c = this._customWeapon(this.weapon); if (!c) return;
    this.customWeapons = this.customWeapons.filter(x => x.id !== c.id);
    saveCustomWeapons(this.customWeapons); delete this._wimgCache[c.id];
    this.weapon = 'sword';
    this._populateWeaponSelect(); this._populateProjectileSelect(document.getElementById('pj_imageId')?.value || 'arrow'); this._syncWeaponUI(); this._loadTemplate();
    this._setStatus('무기 이미지를 삭제했습니다.');
  }

  _loadTemplate() {
    // Start from the weapon's current attack swing so users tweak, not start blank.
    // Admin authoring path → keep any canonical hitboxes (allowGameplay).
    const base = resolveMotion(weaponSetId(this.weapon), 'attack');
    this.motion = sanitizeMotion(base, undefined, { allowGameplay: true });
    if (this.motion.keyframes.length > MAX_KF) this.motion.keyframes = this.motion.keyframes.slice(0, MAX_KF);
    this.selKf = 0;
    this.scrubT = this.motion.keyframes[0]?.t || 0;
    this.playing = false;
    this._selectedHitboxIndex = -1;
    this._syncDurationControls();
    this._setStatus('무기 기본 스윙을 불러왔습니다. 관절을 끌어 포즈를 만들고 키프레임을 추가하세요.');
    this._renderAll();
  }

  /** Retarget a library preset onto the current stick (Phase D no-ML path). */
  // --- User preset library (tagged motions → workshop weapon / blockcoding) ---
  /** Save the CURRENT editor motion as a named, tagged preset. The newest preset
   *  of a tag is auto-equipped (one equipped per tag → bundled into the weapon). */
  _savePreset() {
    const tag = document.getElementById('mePresetTag')?.value || 'attack';
    const raw = (document.getElementById('meName')?.value || '').trim() || `${TAG_LABEL[tag]} 모션`;
    const motion = sanitizeMotion(this.motion, undefined, { allowGameplay: true });
    if (!motion.keyframes.length) { this._setStatus('저장할 키프레임이 없습니다.'); return; }
    if (this.userPresets.length >= 40) { this._setStatus('프리셋은 최대 40개입니다. 안 쓰는 것을 삭제해 주세요.'); return; }
    for (const p of this.userPresets) if (p.tag === tag) p.equipped = false;   // one equipped per tag
    this.userPresets.push({ id: 'p' + Date.now().toString(36), name: raw.slice(0, 20), tag, motion, equipped: true });
    saveUserPresets(this.userPresets);
    this._renderPresetList();
    this._setStatus(`프리셋 "${raw}" 저장됨 [${TAG_LABEL[tag]}] — ★장착 상태. 무기 저장 시 이 태그로 함께 실립니다.`);
  }
  /** The equipped motion per tag — bundled into the workshop weapon's motionSet. */
  _equippedTagMotions() {
    const out = {};
    for (const p of this.userPresets) if (p.equipped && p.motion) out[p.tag] = p.motion;
    return out;
  }
  _renderPresetList() {
    const host = document.getElementById('mePresets'); if (!host) return;
    host.innerHTML = '';
    // My presets: [★][name][tag chip][✕]
    for (const p of this.userPresets) {
      const row = document.createElement('span');
      row.className = 'inline-flex items-center gap-1 bg-[#14100b] border px-1.5 py-0.5 text-[10px] cursor-pointer active:scale-95';
      row.style.borderColor = p.equipped ? '#ffd24a' : '#3f3f46';
      const star = document.createElement('b'); star.textContent = p.equipped ? '★' : '☆';
      star.style.color = p.equipped ? '#ffd24a' : '#555'; star.title = '이 태그에 장착 (무기 저장 시 함께 실림)';
      star.addEventListener('click', (e) => { e.stopPropagation(); this._equipPreset(p.id); });
      const nm = document.createElement('span'); nm.textContent = p.name; nm.className = 'text-gray-200';
      const chip = document.createElement('span'); chip.textContent = TAG_LABEL[p.tag] || p.tag;
      chip.className = 'text-[9px] px-1 rounded'; chip.style.cssText += 'background:#1c6b33;color:#aef0c0';
      const del = document.createElement('span'); del.textContent = '✕'; del.className = 'text-gray-500 hover:text-red-400 px-0.5';
      del.addEventListener('click', (e) => { e.stopPropagation(); this._deletePreset(p.id); });
      row.append(star, nm, chip, del);
      row.addEventListener('click', () => this._loadUserPreset(p.id));
      host.appendChild(row);
    }
    if (!this.userPresets.length) {
      const hint = document.createElement('span');
      hint.className = 'text-[9px] text-gray-500';
      hint.textContent = '아직 없음 — 모션을 만들고 태그를 골라 💾 프리셋 저장';
      host.appendChild(hint);
    }
  }
  _equipPreset(id) {
    const target = this.userPresets.find(p => p.id === id); if (!target) return;
    for (const p of this.userPresets) if (p.tag === target.tag) p.equipped = false;
    target.equipped = true;
    saveUserPresets(this.userPresets); this._renderPresetList();
    this._setStatus(`"${target.name}" 를 [${TAG_LABEL[target.tag]}] 태그에 장착했습니다.`);
  }
  _deletePreset(id) {
    this.userPresets = this.userPresets.filter(p => p.id !== id);
    saveUserPresets(this.userPresets); this._renderPresetList();
  }
  /** Load one of MY presets back into the editor for tweaking. */
  _loadUserPreset(id) {
    const p = this.userPresets.find(x => x.id === id); if (!p) return;
    this.motion = sanitizeMotion(p.motion, undefined, { allowGameplay: true });
    this.selKf = 0; this.scrubT = this.motion.keyframes[0]?.t || 0; this.playing = false;
    this._selectedHitboxIndex = -1;
    this._selectHitboxForTime(this.scrubT);
    this._syncDurationControls();
    const nm = document.getElementById('meName'); if (nm) nm.value = p.name;
    const ts = document.getElementById('mePresetTag'); if (ts) ts.value = p.tag;
    this._setStatus(`내 프리셋 "${p.name}" [${TAG_LABEL[p.tag]}] 을 불러왔습니다. 수정 후 다시 저장하세요.`);
    this._renderAll();
  }

  /**
   * Webcam pose capture (Phase D AI path). Records a short clip, retargets it to
   * the stick skeleton, and loads the result as the working motion to tweak/save.
   * Fully fail-soft: any error (no camera, denied, model down, no pose) just
   * shows a message and leaves the editor + presets untouched.
   */
  async _capture() {
    const btn = document.getElementById('meCapture');
    const video = document.getElementById('meVideo');
    if (this._capturing) return;
    this._capturing = true;
    if (btn) { btn.disabled = true; }
    this._setStatus('카메라 준비 중… 화면 앞에서 전신이 보이게 서서 동작을 취해 주세요.');
    try {
      const motion = await captureMotionFromWebcam(video, {
        durationMs: 1400,
        onProgress: (p) => this._setStatus(`포즈 캡처 중… ${Math.round(p * 100)}%`),
      });
      this.motion = motion;
      if (this.motion.keyframes.length > MAX_KF) this.motion.keyframes = this.motion.keyframes.slice(0, MAX_KF);
      this.selKf = 0; this.scrubT = 0; this.playing = false;
      this._syncDurationControls();
      this._setStatus('웹캠 모션을 가져왔습니다! 관절을 끌어 다듬거나 그대로 저장하세요.');
      this._renderAll();
    } catch (err) {
      const msg = {
        'camera-unavailable': '이 브라우저/기기에서 카메라를 쓸 수 없어요. 에디터와 프리셋으로 계속 만들 수 있습니다.',
        'camera-denied': '카메라 권한이 거부됐어요. 에디터와 프리셋은 그대로 사용할 수 있습니다.',
        'model-unavailable': 'AI 모델을 불러오지 못했어요(네트워크?). 에디터와 프리셋으로 계속하세요.',
        'no-pose-detected': '포즈를 인식하지 못했어요. 전신이 보이게 다시 시도하거나 프리셋을 쓰세요.',
      }[err?.message] || '웹캠 캡처에 실패했어요. 에디터와 프리셋은 정상 동작합니다.';
      this._setStatus('⚠ ' + msg);
    } finally {
      this._capturing = false;
      if (btn) btn.disabled = false;
    }
  }

  // --- Hitbox (gameplay, per-frame editable) ---------------------------------
  _currentMotionTime() {
    if (this.playing) return this.scrubT || 0;
    return this.motion?.keyframes?.[this.selKf]?.t ?? this.scrubT ?? 0;
  }
  _hitboxes() {
    if (!this.motion) return [];
    if (!Array.isArray(this.motion.hitboxes)) this.motion.hitboxes = [];
    return this.motion.hitboxes;
  }
  _activeHitboxIndexAt(t = this._currentMotionTime()) {
    const hbs = this._hitboxes();
    const frameIndex = this._nearestFrameIndexForTime(t);
    return hbs.findIndex(hb => this._hitboxFrameIndex(hb) === frameIndex);
  }
  _selectHitboxForTime(t = this._currentMotionTime()) {
    const active = this._activeHitboxIndexAt(t);
    if (active >= 0) this._selectedHitboxIndex = active;
    else this._selectedHitboxIndex = -1;
  }
  _hb() {
    const hbs = this._hitboxes();
    if (!hbs.length) return null;
    if (this._selectedHitboxIndex >= 0 && this._selectedHitboxIndex < hbs.length) return hbs[this._selectedHitboxIndex];
    this._selectHitboxForTime();
    return hbs[this._selectedHitboxIndex] || null;
  }

  _frameLabelForTime(t = this._currentMotionTime()) {
    const kfs = this.motion?.keyframes || [];
    if (!kfs.length) return '0프레임';
    let best = 0, bestD = Infinity;
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs((kfs[i].t || 0) - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return `${best + 1}프레임`;
  }

  _rootForKeyframe(kf) {
    if (!kf) return { x: 0, y: 0 };
    if (!kf.root || typeof kf.root !== 'object') kf.root = { x: 0, y: 0 };
    kf.root.x = clamp(Number(kf.root.x) || 0, -MOTION_LIMITS.rootOffsetMax, MOTION_LIMITS.rootOffsetMax);
    kf.root.y = clamp(Number(kf.root.y) || 0, -MOTION_LIMITS.rootOffsetMax, MOTION_LIMITS.rootOffsetMax);
    return kf.root;
  }

  _currentRootOffset(t = this._currentMotionTime()) {
    if (!this.playing) {
      const kf = this.motion?.keyframes?.[this.selKf];
      if (kf) return this._rootForKeyframe(kf);
    }
    return sampleRootOffset(this.motion, t);
  }

  _teleportPreviewOffset(t = this._currentMotionTime()) {
    const p = this._activeCombatPreset();
    const events = sanitizeTeleportEvents(p?.teleportEvents || []);
    let x = 0, y = 0;
    for (const ev of events) {
      if ((ev.time || 0) > t + 1e-5) continue;
      const dist = Number(ev.distance) || 0;
      let angle = 0;
      if (ev.directionSource === 'back') angle = Math.PI;
      else if (ev.directionSource === 'up') angle = -Math.PI / 2;
      else if (ev.directionSource === 'down') angle = Math.PI / 2;
      else if (ev.directionSource === 'angle' && Number.isFinite(ev.angle)) angle = ev.angle * DEG;
      x += Math.cos(angle) * dist;
      y += Math.sin(angle) * dist;
    }
    return { x, y };
  }

  /** Add/remove a hitbox at the current frame. Multiple hitboxes let one motion
   *  use different geometry on different frames, while the runtime still applies
   *  damage only once per target per swing. */
  _toggleHitbox() {
    const hbs = this._hitboxes();
    const t = clamp(this._currentMotionTime(), 0, 1);
    const active = this._activeHitboxIndexAt(t);
    if (active >= 0) {
      hbs.splice(active, 1);
      this._selectedHitboxIndex = -1;
      this._setStatus(`현재 프레임의 히트박스를 제거했습니다. (${hbs.length}/${MOTION_LIMITS.maxHitboxes})`);
    } else {
      if (hbs.length >= MOTION_LIMITS.maxHitboxes) {
        this._setStatus(`히트박스는 최대 ${MOTION_LIMITS.maxHitboxes}개입니다. 필요 없는 프레임 판정을 먼저 지워 주세요.`);
        return;
      }
      const src = hbs[this._selectedHitboxIndex] || hbs[hbs.length - 1] || { ox: 30, oy: -6, w: 52, h: 44 };
      const span = 0.05;
      const activeStart = clamp(t - span / 2, 0, 1);
      const activeEnd = clamp(t + span / 2, 0, 1);
      hbs.push({ ox: src.ox, oy: src.oy, w: src.w, h: src.h, frameTime: t, activeStart, activeEnd });
      hbs.sort((a, b) => this._hitboxFrameTime(a) - this._hitboxFrameTime(b));
      this._selectedHitboxIndex = hbs.findIndex(hb => Math.abs(this._hitboxFrameTime(hb) - t) < 0.001);
      this._setStatus(`현재 프레임에 히트박스를 추가했습니다. 빨간 상자를 끌어 위치·크기를 조절하세요. (${hbs.length}/${MOTION_LIMITS.maxHitboxes})`);
    }
    const btn = document.getElementById('meAddHitbox');
    if (btn) btn.textContent = this._activeHitboxIndexAt(this._currentMotionTime()) >= 0 ? '－ 현재 판정 제거' : '＋ 현재 프레임 판정';
    this._renderAll();
    this._tutEvent('hitbox');
  }

  // --- Pose helpers ----------------------------------------------------------
  _displayPose() {
    if (this.playing) return samplePose(this.motion, this.scrubT);
    const kf = this.motion.keyframes[this.selKf];
    if (kf) return { ...STICK_NEUTRAL, ...kf.pose };   // exact selected keyframe
    return samplePose(this.motion, this.scrubT);
  }
  _activeHandles() {
    const dual = !!(this._editingV2?.weaponVisual?.dual);
    if (dual) return HANDLES;
    const swapped = this._currentHandSwap();
    return HANDLES.filter(h => swapped ? h.name !== 'weaponTip' : h.name !== 'weaponOffTip');
  }

  // --- Preview canvas --------------------------------------------------------
  _setPreviewZoom(value) {
    this._previewZoom = clamp(Number(value) || 1, 0.35, 3);
    try { localStorage.setItem('psd_me_preview_zoom', String(this._previewZoom)); } catch {}
    const el = document.getElementById('meZoomVal');
    if (el) el.textContent = `${Math.round(this._previewZoom * 100)}%`;
    this._renderPreview();
  }
  _previewHandleScale() {
    return clamp(Math.max(1, Number(this._previewZoom) || 1), 1, 3);
  }
  _previewWheel(e) {
    if (!this.canvas || e.ctrlKey) return;
    e.preventDefault();
    this._setPreviewZoom(this._previewZoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }
  _pinchDist(e) {
    if (!e.touches || e.touches.length < 2) return 0;
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  _previewTouchStart(e) {
    if (e.touches?.length === 2) {
      this._pinch = { dist: this._pinchDist(e), zoom: this._previewZoom };
      e.preventDefault();
    }
  }
  _previewTouchMove(e) {
    if (!this._pinch || e.touches?.length !== 2) return;
    const d = this._pinchDist(e);
    if (d > 4 && this._pinch.dist > 4) this._setPreviewZoom(this._pinch.zoom * (d / this._pinch.dist));
    e.preventDefault();
  }
  _previewPelvisTarget(W, H, W2E, root = { x: 0, y: 0 }, tp = { x: 0, y: 0 }) {
    // Zoom around the authored pelvis, not around the canvas origin. Root and
    // teleport offsets keep a stable screen scale while the character grows.
    const offsetScale = (H * 0.1) / 14;
    return {
      x: W / 2 + ((root.x || 0) + (tp.x || 0)) * offsetScale,
      y: H * 0.58 + ((root.y || 0) + (tp.y || 0)) * offsetScale
    };
  }
  _previewOriginForPelvis(pose, scale, pelvis) {
    const probe = solveStickman(pose, scale, 0, 0, 1, { rawNearArm: true, weapon: this.weapon, offhandWeapon: this._offhandId() });
    return {
      x: pelvis.x,
      y: pelvis.y - (probe?.joints?.pelvis?.y || 0)
    };
  }
  _renderPreview() {
    const ctx = this.ctx; if (!ctx) return;
    const W = this.canvas.width, H = this.canvas.height;
    const zoomEl = document.getElementById('meZoomVal');
    if (zoomEl) zoomEl.textContent = `${Math.round((this._previewZoom || 1) * 100)}%`;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#14100b'; ctx.fillRect(0, 0, W, H);

    const scale = Math.round(H * 0.1 * (this._previewZoom || 1));                  // wider preview: leave room for weapon arcs/root offsets
    const handleScale = this._previewHandleScale();
    const W2E = scale / 14;
    this._lastW2E = W2E;
    const tNow = this._currentMotionTime();
    const root = this._currentRootOffset(tNow);
    const tp = this._teleportPreviewOffset(tNow);
    const pose = this._displayPose();
    const pelvisTarget = this._previewPelvisTarget(W, H, W2E, root, tp);
    const currentOrigin = this._previewOriginForPelvis(pose, scale, pelvisTarget);
    const cx = currentOrigin.x;
    const cyCenter = currentOrigin.y;
    const wrec = this._customWeapon(this.weapon);             // custom weapon record (or null)
    const wimg = this._weaponImage();                         // its image (or null)
    const wsize = wrec?.size ?? 2.0;
    const wanch = wrec?.anchors || null;                      // grip/tip anchors
    const wflip = this._currentFlip();                        // weapon flip at the current time
    const wflipY = this._currentFlipY();
    const leftFlip = this._currentHandFlip('left', 'x');
    const leftFlipY = this._currentHandFlip('left', 'y');
    const handSwapped = this._currentHandSwap();
    const wdual = !!(this._editingV2 && this._editingV2.weaponVisual && this._editingV2.weaponVisual.dual);
    const offId = this._offhandId();
    const offRec = this._customWeapon(offId);
    const offImg = offRec ? this._imageById(offId) : null;
    const offSize = this._editingV2?.weaponVisual?.offhand?.scale ?? offRec?.size ?? 2.0;
    const offAnch = this._editingV2?.weaponVisual?.offhand?.anchors || offRec?.anchors || null;
    const hats = this._hatListAt(tNow);
    const hatImages = hats.map(h => h?.imageId ? this._imageById(h.imageId) : null);

    // Onion skin: the PREVIOUS frame's pose, drawn faint + blue behind the current
    // one, so you can see what the stickman did last and build the next pose from it.
    if (this.onion && !this.playing && this.motion.keyframes[this.selKf] && this.selKf > 0) {
      const prev = this.motion.keyframes[this.selKf - 1];
      if (prev) {
        const prevRoot = sampleRootOffset(this.motion, prev.t);
        const prevTp = this._teleportPreviewOffset(prev.t);
        const prevPose = { ...STICK_NEUTRAL, ...prev.pose };
        const prevPelvis = this._previewPelvisTarget(W, H, W2E, prevRoot, prevTp);
        const prevOrigin = this._previewOriginForPelvis(prevPose, scale, prevPelvis);
        const pj = solveStickman(prevPose, scale, prevOrigin.x, prevOrigin.y, 1, { rawNearArm: true, weapon: this.weapon, offhandWeapon: offId });
        const prevHats = this._hatListAt(prev.t);
        const prevHatImages = prevHats.map(h => h?.imageId ? this._imageById(h.imageId) : null);
        ctx.save(); ctx.globalAlpha = 0.3;
        drawStickFromJoints(ctx, pj.joints, pj.headR, { color: '#6f8cff', accent: '#0d0a06', lineW: this.look.lineW, scale, weapon: this.weapon, drawWeapon: true, aimAngle: 0, headShape: this.look.head, accessory: this.look.accessory, weaponImage: wimg, weaponImageSize: wsize, weaponImageAnchors: wanch, weaponFlip: sampleFlip(this._flipKeys || [], prev.t), weaponFlipY: sampleFlip(this._flipYKeys || [], prev.t), weaponRightFlip: sampleFlip(this._flipKeys || [], prev.t), weaponRightFlipY: sampleFlip(this._flipYKeys || [], prev.t), weaponLeftFlip: sampleFlip(this._leftFlipKeys || [], prev.t), weaponLeftFlipY: sampleFlip(this._leftFlipYKeys || [], prev.t), weaponDual: wdual, weaponHandSwapped: sampleFlip(this._handSwapKeys || [], prev.t), offhandWeapon: offId, offhandImage: offImg, offhandImageSize: offSize, offhandImageAnchors: offAnch, hatImages: prevHatImages, hats: prevHats, layerOrder: this._normalizeLayerOrder(prevHats, this._editingV2?.weaponVisual?.layerOrder) });
        ctx.restore();
      }
    }

    const { joints, headR } = solveStickman(pose, scale, cx, cyCenter, 1, { rawNearArm: true, weapon: this.weapon, offhandWeapon: offId });
    const groundY = Math.max(joints.footN?.y || pelvisTarget.y, joints.footF?.y || pelvisTarget.y);
    ctx.strokeStyle = '#3b3a44'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
    const color = this.look.color || WEAPON_STICK_COLOR[this.weapon] || '#cdd3da';
    drawStickFromJoints(ctx, joints, headR, { color, accent: '#0d0a06', lineW: this.look.lineW, scale, weapon: this.weapon, drawWeapon: true, aimAngle: 0, headShape: this.look.head, accessory: this.look.accessory, weaponImage: wimg, weaponImageSize: wsize, weaponImageAnchors: wanch, weaponFlip: wflip, weaponFlipY: wflipY, weaponRightFlip: wflip, weaponRightFlipY: wflipY, weaponLeftFlip: leftFlip, weaponLeftFlipY: leftFlipY, weaponDual: wdual, weaponHandSwapped: handSwapped, offhandWeapon: offId, offhandImage: offImg, offhandImageSize: offSize, offhandImageAnchors: offAnch, hatImages, hats, layerOrder: this._normalizeLayerOrder(hats, this._editingV2?.weaponVisual?.layerOrder) });
    if (this.mode === 'workshop') {
      this._drawEffects(ctx, joints, scale);   // cosmetic frame FX
      this._drawProjectileEvents(ctx, joints, scale);
    }
    this._drawHatHandles(ctx, joints, headR, scale, hats);

    // Joint handles (only when a keyframe is selected & not playing).
    if (!this.playing && this.motion.keyframes[this.selKf]) {
      for (const h of this._activeHandles()) {
        const p = joints[h.name]; if (!p) continue;
        const isWeapon = h.name === 'weaponTip' || h.name === 'weaponOffTip';
        ctx.beginPath(); ctx.arc(p.x, p.y, (isWeapon ? 7 : 6) * handleScale, 0, Math.PI * 2);
        ctx.fillStyle = this.dragHandle === h.name ? '#ffd24a' : (isWeapon ? 'rgba(255,160,80,0.9)' : 'rgba(125,240,154,0.85)');
        ctx.fill(); ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 1.5 * handleScale; ctx.stroke();
      }
      // Red PELVIS handle → drags this keyframe's root offset.
      const pel = joints.pelvis;
      if (pel) {
        ctx.beginPath(); ctx.arc(pel.x, pel.y, 7 * handleScale, 0, Math.PI * 2);
        ctx.fillStyle = this.dragPelvis ? '#ffd24a' : 'rgba(255,70,70,0.95)';
        ctx.fill(); ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 1.5 * handleScale; ctx.stroke();
        this._pelvisScreen = { x: pel.x, y: pel.y };
      }
    }

    // Hitbox overlay (gameplay). During playback draw every hitbox attached to
    // the current authored frame; while editing draw the selected box with drag
    // handles. This keeps the blink visible on every preview loop.
    this._hbScreen = null;
    const selectedHb = this.playing ? null : this._hb();
    const currentFrame = this._nearestFrameIndexForTime(this._currentMotionTime());
    const hitboxesToDraw = this.playing
      ? this._hitboxes().filter(hb => this._hitboxFrameIndex(hb) === currentFrame)
      : (selectedHb ? [selectedHb] : []);
    for (const hb of hitboxesToDraw) {
      const hcx = cx + hb.ox * W2E, hcy = cyCenter + hb.oy * W2E;
      const hw = hb.w * W2E, hh = hb.h * W2E;
      const selected = hb === selectedHb;
      const active = this.playing || this._hitboxFrameIndex(hb) === currentFrame;
      ctx.fillStyle = active ? 'rgba(255,90,60,0.34)' : 'rgba(255,90,60,0.14)';
      ctx.strokeStyle = active ? '#ff7a5a' : 'rgba(255,122,90,0.6)';
      ctx.lineWidth = selected ? 2.5 : 2;
      ctx.fillRect(hcx - hw / 2, hcy - hh / 2, hw, hh);
      ctx.strokeRect(hcx - hw / 2, hcy - hh / 2, hw, hh);
      if (!this.playing && selected) {
        // Move handle (centre) + resize handle (bottom-right corner).
        ctx.fillStyle = this.dragHitbox === 'move' ? '#ffd24a' : '#ff7a5a';
        ctx.beginPath(); ctx.arc(hcx, hcy, 5 * handleScale, 0, Math.PI * 2); ctx.fill();
        const rx = hcx + hw / 2, ry = hcy + hh / 2;
        ctx.fillStyle = this.dragHitbox === 'resize' ? '#ffd24a' : '#ffb070';
        const resizeHalf = 5 * handleScale;
        ctx.fillRect(rx - resizeHalf, ry - resizeHalf, resizeHalf * 2, resizeHalf * 2);
        this._hbScreen = { hcx, hcy, hw, hh, rx, ry, W2E, cx, cyCenter, handleScale };
      }
    }
    this._jointCache = joints;
  }

  _hatHandlePoints(joints, headR, scale, hat, index) {
    if (!joints?.pelvis || !hat || hat.showHandles === false) return null;
    const W2E = scale / 46;
    const origin = hat.followHead && joints.head
      ? { x: joints.head.x, y: joints.head.y }
      : { x: joints.pelvis.x, y: joints.pelvis.y - 1.66 * scale };
    const move = { x: origin.x + (Number(hat.offsetX) || 0) * W2E, y: origin.y + (Number(hat.offsetY) || -18) * W2E };
    const img = hat.imageId ? this._imageById(hat.imageId) : null;
    const iw = img?.naturalWidth || 1;
    const ih = img?.naturalHeight || 1;
    const aspect = iw / ih;
    const size = headR * 2.4 * (Number(hat.scale) || 1);
    const drawW = aspect >= 1 ? size : size * aspect;
    const drawH = aspect >= 1 ? size / aspect : size;
    const anchors = hat.anchors || {};
    const gx = Number.isFinite(Number(anchors.gx)) ? clamp(Number(anchors.gx), 0, 1) : (Number.isFinite(Number(hat.anchorX)) ? clamp(Number(hat.anchorX), 0, 1) : 0.5);
    const gy = Number.isFinite(Number(anchors.gy)) ? clamp(Number(anchors.gy), 0, 1) : (Number.isFinite(Number(hat.anchorY)) ? clamp(Number(hat.anchorY), 0, 1) : 0.5);
    const tx = Number.isFinite(Number(anchors.tx)) ? clamp(Number(anchors.tx), 0, 1) : 0.85;
    const ty = Number.isFinite(Number(anchors.ty)) ? clamp(Number(anchors.ty), 0, 1) : 0.5;
    const facing = joints._facing < 0 ? -1 : 1;
    const headRot = hat.followHead && joints.head && joints.neck
      ? Math.atan2(joints.head.y - joints.neck.y, (joints.head.x - joints.neck.x) * facing) + Math.PI / 2
      : 0;
    const a = headRot + (Number(hat.rotation) || 0) * Math.PI / 180;
    const mapAnchor = (ax, ay) => {
      const lx = (ax - gx) * drawW;
      const ly = (ay - gy) * drawH;
      return {
        x: move.x + Math.cos(a) * lx - Math.sin(a) * ly,
        y: move.y + Math.sin(a) * lx + Math.cos(a) * ly,
      };
    };
    const rotate = mapAnchor(tx, ty);
    const localAngle = Math.atan2((ty - gy) * drawH, (tx - gx) * drawW) / DEG;
    return { index, origin, move, rotate, W2E, localAngle };
  }
  _drawHatHandles(ctx, joints, headR, scale, hats) {
    this._hatHandleCache = [];
    if (this.playing || !this.motion.keyframes[this.selKf]) return;
    const handleScale = this._previewHandleScale();
    for (let i = 0; i < hats.length; i++) {
      const pts = this._hatHandlePoints(joints, headR, scale, hats[i], i);
      if (!pts) continue;
      this._hatHandleCache.push(pts);
      ctx.save();
      ctx.lineWidth = 2 * handleScale;
      ctx.strokeStyle = 'rgba(255,210,74,0.75)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(pts.move.x, pts.move.y); ctx.lineTo(pts.rotate.x, pts.rotate.y); ctx.stroke();
      ctx.setLineDash([]);
      const dot = (p, r, fill, label) => {
        const rr = r * handleScale;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = '#0d0a06'; ctx.stroke();
        ctx.font = `bold ${Math.round(9 * handleScale)}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#0d0a06'; ctx.fillText(label, p.x, p.y);
      };
      dot(pts.move, 7, this.dragHat?.index === i && this.dragHat?.type === 'move' ? '#ffd24a' : 'rgba(255,70,70,0.95)', '이');
      dot(pts.rotate, 7, this.dragHat?.index === i && this.dragHat?.type === 'rotate' ? '#ffd24a' : 'rgba(255,160,80,0.95)', '각');
      ctx.restore();
    }
  }

  _previewDown(e) {
    if (this.playing) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    const handleScale = this._previewHandleScale();
    // Selected effect handles take priority over pose joints. The red centre
    // moves the effect and the yellow corner resizes it at the current frame.
    const fx = this._effectScreen;
    if (fx) {
      const grab = 13 * handleScale;
      if ((fx.rx - mx) ** 2 + (fx.ry - my) ** 2 < grab * grab) {
        this._pushUndo('effect resize'); this.dragEffect = 'resize'; e.preventDefault(); return;
      }
      if ((fx.cx - mx) ** 2 + (fx.cy - my) ** 2 < grab * grab) {
        this._pushUndo('effect move'); this.dragEffect = 'move'; e.preventDefault(); return;
      }
    }
    // Hitbox handles take priority (resize corner, then move centre).
    const s = this._hbScreen;
    if (s) {
      const hbGrab = 12 * (s.handleScale || handleScale);
      if ((s.rx - mx) ** 2 + (s.ry - my) ** 2 < hbGrab * hbGrab) { this._pushUndo('hitbox resize'); this.dragHitbox = 'resize'; e.preventDefault(); return; }
      if ((s.hcx - mx) ** 2 + (s.hcy - my) ** 2 < hbGrab * hbGrab) { this._pushUndo('hitbox move'); this.dragHitbox = 'move'; e.preventDefault(); return; }
    }
    const hatGrab = 13 * handleScale;
    for (let i = (this._hatHandleCache || []).length - 1; i >= 0; i--) {
      const h = this._hatHandleCache[i];
      if ((h.rotate.x - mx) ** 2 + (h.rotate.y - my) ** 2 < hatGrab * hatGrab) {
        this._pushUndo('decoration rotate');
        this.dragHat = { type: 'rotate', index: h.index };
        this._selectHat(h.index);
        e.preventDefault();
        return;
      }
      if ((h.move.x - mx) ** 2 + (h.move.y - my) ** 2 < hatGrab * hatGrab) {
        this._pushUndo('decoration move');
        this.dragHat = { type: 'move', index: h.index, origin: h.origin, W2E: h.W2E };
        this._selectHat(h.index);
        e.preventDefault();
        return;
      }
    }
    if (!this.motion.keyframes[this.selKf]) return;
    // Red pelvis handle → keyframe root drag (checked before joints, but only if
    // the cursor is genuinely closest to it, so it never steals hand/weapon grabs).
    const pel = this._pelvisScreen;
    const jointGrab = 14 * handleScale;
    let best = null, bestD = jointGrab * jointGrab;
    for (const h of this._activeHandles()) {
      const p = this._jointCache?.[h.name]; if (!p) continue;
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    if (pel) {
      const dp = (pel.x - mx) ** 2 + (pel.y - my) ** 2;
      const pelvisGrab = 12 * handleScale;
      if (dp < pelvisGrab * pelvisGrab && dp <= bestD) {
        this._pushUndo('root move');
        const root = this._rootForKeyframe(this.motion.keyframes[this.selKf]);
        this.dragPelvis = { mx, my, ox: root.x, oy: root.y, W2E: this._lastW2E || 1 };
        e.preventDefault();
        return;
      }
    }
    if (best) { this._pushUndo('pose edit'); this.dragHandle = best.name; e.preventDefault(); }
  }

  _dragHitboxTo(e) {
    const hb = this._hb(), s = this._hbScreen; if (!hb || !s) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    if (this.dragHitbox === 'move') {
      hb.ox = clamp(Math.round((mx - s.cx) / s.W2E), -MOTION_LIMITS.hitboxOffsetMax, MOTION_LIMITS.hitboxOffsetMax);
      hb.oy = clamp(Math.round((my - s.cyCenter) / s.W2E), -MOTION_LIMITS.hitboxOffsetMax, MOTION_LIMITS.hitboxOffsetMax);
    } else if (this.dragHitbox === 'resize') {
      hb.w = clamp(Math.round(Math.abs(mx - s.hcx) * 2 / s.W2E), MOTION_LIMITS.hitboxSizeMin, MOTION_LIMITS.hitboxSizeMax);
      hb.h = clamp(Math.round(Math.abs(my - s.hcy) * 2 / s.W2E), MOTION_LIMITS.hitboxSizeMin, MOTION_LIMITS.hitboxSizeMax);
    }
    this._renderPreview();
  }

  _dragJointTo(e) {
    const h = this._activeHandles().find(x => x.name === this.dragHandle); if (!h) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    const parent = this._jointCache?.[h.parent]; if (!parent) return;
    // Editor is facing +1 / no flip, so screen angle == authored local angle.
    let deg = Math.atan2(my - parent.y, mx - parent.x) / DEG;
    deg = clamp(deg, MOTION_LIMITS.angleMin, MOTION_LIMITS.angleMax);
    const kf = this.motion.keyframes[this.selKf];
    kf.pose[h.joint] = Math.round(deg);
    this._tutEvent('joint');
    this._renderPreview();
  }

  _dragEffectTo(e) {
    const p = this._activePreset();
    const effect = p?.effects?.[this._selectedEffectIndex];
    const s = this._effectScreen;
    if (!effect || !s) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    if (this.dragEffect === 'move') {
      this._setEffectKeyValue(effect, 'x', Math.round((mx - s.pelvisX) / s.unit));
      this._setEffectKeyValue(effect, 'y', Math.round((my - s.pelvisY) / s.unit));
    } else if (this.dragEffect === 'resize') {
      const nextX = clamp((s.scaleX || 1) * Math.abs(mx - s.cx) / Math.max(1, s.halfW), 0.1, 4);
      const nextY = clamp((s.scaleY || 1) * Math.abs(my - s.cy) / Math.max(1, s.halfH), 0.1, 4);
      this._setEffectKeyValue(effect, 'scaleX', Math.round(nextX * 100) / 100);
      this._setEffectKeyValue(effect, 'scaleY', Math.round(nextY * 100) / 100);
    }
    p.effects = sanitizeEffects(p.effects);
    this._renderEffectList();
    this._renderPreview();
  }

  _dragHatTo(e) {
    const d = this.dragHat; if (!d) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    const hats = this._hatList();
    const hat = hats[d.index]; if (!hat) return;
    if (d.type === 'move') {
      const W2E = d.W2E || this._lastW2E || 1;
      hats[d.index] = this._setHatKeyValue(this._setHatKeyValue(hat, 'offsetX', Math.round((mx - d.origin.x) / W2E)), 'offsetY', Math.round((my - d.origin.y) / W2E));
    } else if (d.type === 'rotate') {
      const pts = (this._hatHandleCache || []).find(h => h.index === d.index);
      if (!pts) return;
      let deg = Math.atan2(my - pts.move.y, mx - pts.move.x) / DEG - (Number(pts.localAngle) || 0);
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      deg = Math.round(clamp(deg, -180, 180));
      hats[d.index] = this._setHatKeyValue(hat, 'rotation', deg);
    }
    this._writeHats(hats, d.index);
  }

  // --- Timeline --------------------------------------------------------------
  _renderTimeline() {
    const ctx = this.tctx; if (!ctx) return;
    const W = this.timeline.width, H = this.timeline.height;
    const pad = 10, x0 = pad, x1 = W - pad, span = x1 - x0;
    const tx = (t) => x0 + t * span;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0a06'; ctx.fillRect(0, 0, W, H);
    // Weapon-flip bands. Top pair = right hand, lower pair = left hand.
    const drawFlipBand = (keys, y, h, fill, marker) => {
      const arr = keys || [];
      if (!arr.length) return;
      ctx.fillStyle = fill;
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i].value) continue;
        const segEnd = (i + 1 < arr.length) ? arr[i + 1].time : 1;
        ctx.fillRect(tx(arr[i].time), y, tx(segEnd) - tx(arr[i].time), h);
      }
      for (const k of arr) { const x = tx(k.time); ctx.fillStyle = marker; ctx.fillRect(x - 1, y - 2, 2, h + 4); }
    };
    drawFlipBand(this._flipKeys, H - 10, 5, 'rgba(197,108,255,0.30)', '#c56cff');
    drawFlipBand(this._flipYKeys, H - 17, 5, 'rgba(111,140,255,0.28)', '#6f8cff');
    drawFlipBand(this._leftFlipKeys, H - 24, 5, 'rgba(217,140,255,0.26)', '#d98cff');
    drawFlipBand(this._leftFlipYKeys, H - 31, 5, 'rgba(143,183,255,0.24)', '#8fb7ff');
    const hsks = this._handSwapKeys || [];
    if (hsks.length) {
      ctx.fillStyle = 'rgba(125,240,154,0.25)';
      for (let i = 0; i < hsks.length; i++) {
        if (!hsks[i].value) continue;
        const segEnd = (i + 1 < hsks.length) ? hsks[i + 1].time : 1;
        ctx.fillRect(tx(hsks[i].time), 5, tx(segEnd) - tx(hsks[i].time), 8);
      }
      for (const k of hsks) { const x = tx(k.time); ctx.fillStyle = '#7df09a'; ctx.fillRect(x - 1, 3, 2, 12); }
    }
    // Track line.
    ctx.strokeStyle = '#3b3a44'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, H / 2 - 4); ctx.lineTo(x1, H / 2 - 4); ctx.stroke();
    // Keyframes.
    this.motion.keyframes.forEach((kf, i) => {
      const x = tx(kf.t);
      const hasHb = this._frameHasHitbox(i);
      ctx.fillStyle = hasHb ? (i === this.selKf ? '#ff8a6a' : '#ff5a4f') : (i === this.selKf ? '#ffd24a' : '#e8d5a3');
      ctx.beginPath(); ctx.moveTo(x, H / 2 - 12); ctx.lineTo(x + 5, H / 2 - 4); ctx.lineTo(x - 5, H / 2 - 4); ctx.closePath(); ctx.fill();
    });
    // Playhead.
    if (this.playing) {
      const x = tx(this.scrubT);
      ctx.strokeStyle = '#45f3ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  _timelineT(e) {
    const r = this.timeline.getBoundingClientRect();
    const W = this.timeline.width, pad = 10;
    const x = (e.clientX - r.left) * (W / r.width);
    return clamp((x - pad) / (W - pad * 2), 0, 1);
  }

  _timelineDown(e) {
    const t = this._timelineT(e);
    // Grab the nearest keyframe if close, else scrub.
    let nearest = -1, nd = 0.05;
    this.motion.keyframes.forEach((kf, i) => { const d = Math.abs(kf.t - t); if (d < nd) { nd = d; nearest = i; } });
    if (nearest >= 0) { this._pushUndo('keyframe move'); this.selKf = nearest; this.dragKfIndex = nearest; this.scrubT = this.motion.keyframes[nearest].t; }
    else { this.playing = false; this.scrubT = t; }
    this._selectHitboxForTime(this.scrubT);
    this._renderAll();
  }

  _pointerMove(e) {
    if (this.dragFrameOverviewHeight) {
      this._setFrameOverviewHeight(this.dragFrameOverviewHeight.h + (e.clientY - this.dragFrameOverviewHeight.y));
      return;
    }
    if (this.dragPelvis) {
      const r = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
      const my = (e.clientY - r.top) * (this.canvas.height / r.height);
      const root = this._rootForKeyframe(this.motion.keyframes[this.selKf]);
      const W2E = this.dragPelvis.W2E || this._lastW2E || 1;
      root.x = Math.round(clamp(this.dragPelvis.ox + (mx - this.dragPelvis.mx) / W2E, -MOTION_LIMITS.rootOffsetMax, MOTION_LIMITS.rootOffsetMax));
      root.y = Math.round(clamp(this.dragPelvis.oy + (my - this.dragPelvis.my) / W2E, -MOTION_LIMITS.rootOffsetMax, MOTION_LIMITS.rootOffsetMax));
      this._renderPreview();
      return;
    }
    if (this.dragHat) { this._dragHatTo(e); return; }
    if (this.dragEffect) { this._dragEffectTo(e); return; }
    if (this.dragHandle) { this._dragJointTo(e); return; }
    if (this.dragHitbox === 'move' || this.dragHitbox === 'resize') { this._dragHitboxTo(e); return; }
    if (this.dragKfIndex >= 0) {
      const kf = this.motion.keyframes[this.dragKfIndex];
      kf.t = clamp(this._timelineT(e), 0, 1);
      const hb = this._hb();
      if (hb) {
        const span = Math.max(0.02, Number(hb.activeEnd) - Number(hb.activeStart) || 0.05);
        hb.frameTime = kf.t;
        hb.activeStart = clamp(kf.t - span / 2, 0, 1);
        hb.activeEnd = clamp(kf.t + span / 2, 0, 1);
      }
      this.scrubT = kf.t;
      this._renderAll();
    }
  }
  _pointerUp() {
    if (this.dragKfIndex >= 0) this.motion.keyframes.sort((a, b) => a.t - b.t);
    this.dragHandle = null; this.dragKfIndex = -1; this.dragHitbox = null; this.dragEffect = null; this.dragPelvis = null; this.dragHat = null; this.dragFrameOverviewHeight = null;
  }

  // --- Frame flip (stick-fighter) --------------------------------------------
  /** Flip to the previous/next keyframe (a "page"), keeping its authored pose. */
  _gotoFrame(delta) {
    const n = this.motion?.keyframes.length || 0; if (!n) return;
    this.playing = false;
    if (document.getElementById('mePlay')) document.getElementById('mePlay').textContent = '▶ 재생';
    this.selKf = clamp(this.selKf + delta, 0, n - 1);
    this.scrubT = this.motion.keyframes[this.selKf].t;
    this._selectHitboxForTime(this.scrubT);
    this._renderAll();
  }
  /** Add a new frame AFTER the current one that inherits the current pose exactly,
   *  so you continue the motion from where it was (stick-fighter frame carry). */
  _newFrameCarry() {
    const kfs = this.motion.keyframes;
    if (kfs.length >= MAX_KF) { this._setStatus(`키프레임은 최대 ${MAX_KF}개입니다.`); return; }
    const cur = kfs[this.selKf]; if (!cur) { this._addKeyframe(); return; }
    const next = kfs[this.selKf + 1];
    let t = next ? (cur.t + next.t) / 2 : Math.min(1, cur.t + 0.12);
    while (kfs.some(k => Math.abs(k.t - t) < 0.02) && t < 0.999) t += 0.03;
    const curRoot = cur.root || sampleRootOffset(this.motion, cur.t);
    const kf = {
      t: clamp(t, 0, 1),
      pose: { ...STICK_NEUTRAL, ...cur.pose },
      root: { x: Math.round(curRoot.x || 0), y: Math.round(curRoot.y || 0) }
    };   // carry the current pose/root forward
    kfs.push(kf); kfs.sort((a, b) => a.t - b.t);
    this.selKf = kfs.indexOf(kf); this.scrubT = kf.t; this.playing = false;
    this._selectHitboxForTime(this.scrubT);
    this._setStatus('새 프레임 — 이전 포즈를 그대로 이어받았습니다. 관절을 조금씩 바꿔 다음 동작을 만드세요.');
    this._tutEvent('newframe');
    this._renderAll();
  }
  _syncOnionBtn() { const b = document.getElementById('meOnion'); if (b) { b.style.opacity = this.onion ? '1' : '0.4'; b.style.borderColor = this.onion ? '#6f8cff' : '#555'; } }
  _updateFrameLabel() { const el = document.getElementById('meFrameLabel'); if (el) el.textContent = `${(this.motion?.keyframes.length ? this.selKf + 1 : 0)} / ${this.motion?.keyframes.length || 0}`; }

  // --- Keyframe ops ----------------------------------------------------------
  _copyFrame() {
    const kf = this.motion?.keyframes?.[this.selKf];
    if (!kf) { this._setStatus('복사할 프레임이 없습니다.'); return; }
    const root = kf.root || sampleRootOffset(this.motion, kf.t);
    this._frameClipboard = {
      pose: { ...STICK_NEUTRAL, ...(kf.pose || {}) },
      root: { x: Math.round(root.x || 0), y: Math.round(root.y || 0) },
      sourceKey: this._activeKey || null,
      copiedAt: Date.now(),
    };
    this._setStatus(`프레임 ${this.selKf + 1} 복사됨. 다른 프리셋에서도 Ctrl+V로 붙여넣을 수 있습니다.`);
  }
  _nextFrameInsertTime() {
    const kfs = this.motion?.keyframes || [];
    let t = clamp(this.scrubT, 0, 1);
    const collides = (tt) => kfs.some(k => Math.abs(k.t - tt) < 0.03);
    if (collides(t)) {
      const cur = kfs[this.selKf];
      const next = kfs[this.selKf + 1];
      t = next && cur ? (cur.t + next.t) / 2 : (cur ? Math.min(1, cur.t + 0.12) : t);
      while (collides(t) && t < 0.999) t += 0.03;
      if (collides(t)) {
        const ts = [0, ...kfs.map(k => k.t), 1].sort((a, b) => a - b);
        let bestGap = -1;
        for (let i = 0; i < ts.length - 1; i++) {
          const g = ts[i + 1] - ts[i];
          if (g > bestGap) { bestGap = g; t = (ts[i] + ts[i + 1]) / 2; }
        }
      }
    }
    return clamp(t, 0, 1);
  }
  _pasteFrame() {
    if (!this._frameClipboard) { this._setStatus('붙여넣을 복사 프레임이 없습니다.'); return; }
    const kfs = this.motion?.keyframes;
    if (!Array.isArray(kfs)) return;
    if (kfs.length >= MAX_KF) { this._setStatus(`키프레임은 최대 ${MAX_KF}개입니다.`); return; }
    this._pushUndo('paste frame');
    const t = this._nextFrameInsertTime();
    const kf = {
      t,
      pose: { ...STICK_NEUTRAL, ...(this._frameClipboard.pose || {}) },
      root: { ...(this._frameClipboard.root || { x: 0, y: 0 }) },
    };
    kfs.push(kf);
    kfs.sort((a, b) => a.t - b.t);
    this.selKf = kfs.indexOf(kf);
    this.scrubT = kf.t;
    this.playing = false;
    this._selectHitboxForTime(this.scrubT);
    this._setStatus(`복사한 프레임을 ${this.selKf + 1}번 위치에 붙여넣었습니다.`);
    this._renderAll();
  }
  _addKeyframe() {
    const kfs = this.motion.keyframes;
    if (kfs.length >= MAX_KF) { this._setStatus(`키프레임은 최대 ${MAX_KF}개입니다.`); return; }
    // Insert at the playhead — but if that lands on (or next to) an existing
    // keyframe, drop it in the MIDDLE OF THE LARGEST EMPTY GAP instead. Otherwise
    // a new frame at an existing one's time is an invisible duplicate (the old
    // "add does nothing" bug): samplePose returns the same pose, hidden behind it.
    let t = this._nextFrameInsertTime();
    const pose = { ...samplePose(this.motion, t) };            // snapshot the current look
    const root = sampleRootOffset(this.motion, t);
    const kf = { t, pose, root: { x: Math.round(root.x || 0), y: Math.round(root.y || 0) } };
    kfs.push(kf);
    kfs.sort((a, b) => a.t - b.t);
    this.selKf = kfs.indexOf(kf);
    this.scrubT = t;                                           // move the playhead onto the new frame
    this.playing = false;
    this._selectHitboxForTime(this.scrubT);
    this._setStatus('키프레임 추가됨. 관절을 끌어 이 프레임의 포즈를 편집하세요.');
    this._renderAll();
  }
  _delKeyframe() {
    if (this.motion.keyframes.length <= 2) { this._setStatus('키프레임은 최소 2개 필요합니다.'); return; }
    this.motion.keyframes.splice(this.selKf, 1);
    this.selKf = Math.max(0, this.selKf - 1);
    this.scrubT = this.motion.keyframes[this.selKf]?.t || 0;
    this._selectHitboxForTime(this.scrubT);
    this._renderAll();
  }

  // --- Playback --------------------------------------------------------------
  _togglePlay() {
    this.playing = !this.playing;
    document.getElementById('mePlay') && (document.getElementById('mePlay').textContent = this.playing ? '⏸ 정지' : '▶ 재생');
    if (this.playing) { this.scrubT = 0; this._lastT = performance.now(); this._loop(); this._tutEvent('play'); }
    else if (this._raf) cancelAnimationFrame(this._raf);
    this._renderAll();
  }
  _loop() {
    if (!this.playing) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastT) / 1000); this._lastT = now;
    this.scrubT += dt / (this.motion.duration || 0.5);
    if (this.scrubT >= 1) this.scrubT = 0;   // loop the preview
    this._renderPreview(); this._renderTimeline();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // --- Save / equip ----------------------------------------------------------
  _save() {
    if (this.mode === 'workshop') return this._saveWorkshop();
    const nameInput = document.getElementById('meName');
    const raw = (nameInput?.value || '').trim() || `${this.weapon}-커스텀`;
    const slug = raw.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'custom';
    const id = `user:${this.weapon}:${slug}`;
    // The set overrides ONLY the attack motion; everything else falls back to the
    // weapon default. Admin authoring → keep gameplay fields (hitboxes/active window).
    const set = { attack: sanitizeMotion(this.motion, undefined, { allowGameplay: true }) };
    registerMotionSet(id, set, { allowGameplay: true });
    let store = {};
    try { store = JSON.parse(localStorage.getItem(STORE_SETS) || '{}') || {}; } catch {}
    store[id] = set;
    try {
      localStorage.setItem(STORE_SETS, JSON.stringify(store));
      localStorage.setItem(STORE_EQUIP, id);                 // auto-equip the just-saved motion
    } catch {}

    // Tier-1 canonical: this admin tool's save IS the weapon's official definition
    // (shared by every player of that weapon). Install it + cache it locally now,
    // and let the host wire the Firestore upload (admin-gated) via onSaveCanonical.
    setCanonicalWeapon(this.weapon, set, { allowGameplay: true });
    cacheCanonicalWeapon(this.weapon, set);
    let synced = '';
    try { const r = this.onSaveCanonical?.({ weapon: this.weapon, set }); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch {}
    const hb = this._hb() ? ' (히트박스 정본 포함)' : '';
    this._setStatus(`저장 완료: "${raw}"${hb}. ${this.weapon} 무기의 정본으로 적용됩니다${synced}.`);
  }

  /** Build the current V2 weapon (used by both Save+Equip and Upload). Commits
   *  the active preset first, applies name/color/image, then double-clamps. */
  _buildWorkshopV2() {
    const w = this._editingV2 || makeEmptyWeaponV2({});
    this._ensureAuthoringPresets();
    this._commitActivePreset();
    w.name = (document.getElementById('meName')?.value || '').trim() || w.name || '새 무기';
    w.desc = (document.getElementById('meDesc')?.value || '').trim();
    w.color = this.look.color || null;
    // Capture the equipped custom weapon IMAGE (keeping the dual flag).
    if (this.weapon && this.weapon.startsWith('custom:')) {
      const rec = this._customWeapon(this.weapon);
      w.weaponVisual = { ...(w.weaponVisual || {}), imageId: this.weapon, scale: (rec && rec.size) || 2 };
    }
    const before = statCostV2(w);
    const clamped = clampWorkshopWeaponV2(w);   // double-clamp (budget bleed if needed)
    this._editingV2 = clamped; this._editingId = clamped.id;
    return { w: clamped, overBudget: before > POINT_BUDGET, stats: clamped.baseStats };
  }

  _incompleteWorkshopPresets(w = this._editingV2) {
    if (!w?.presets) return AUTHORING_PRESET_KEYS;
    return AUTHORING_PRESET_KEYS.filter(key => !w.presets[key]?.complete);
  }

  _workshopUploadPayload(w) {
    const source = JSON.parse(JSON.stringify(w || {}));
    const completeKeys = Object.keys(source.presets || {}).filter(key => source.presets[key]?.complete);
    if (!completeKeys.length) return null;
    const upload = clampWorkshopWeaponV2(source);
    for (const key of Object.keys(upload.presets || {})) {
      if (!completeKeys.includes(key)) delete upload.presets[key];
    }
    if (!upload.presets[upload.equippedPresetKey]) {
      upload.equippedPresetKey = upload.presets.basic ? 'basic' : Object.keys(upload.presets)[0];
    }
    return upload;
  }

  /** Tier-2 저장 + 장착: LOCAL only — save to the device store + equip.
   *  NEVER publishes; sharing is the separate 업로드 button. */
  _saveWorkshop() {
    const { w, overBudget, stats } = this._buildWorkshopV2();
    let ok = false;
    try { saveWorkshopWeaponLocal(w); equipWorkshopWeaponLocal(w.id); ok = true; } catch (e) { /* keep editing */ }
    this._lastSaved = ok ? w : null;
    // Reflect any budget bleed / clamped preset back into the sliders.
    this._loadActivePreset();
    if (!ok) { this._setStatus('저장에 실패했습니다 (저장공간 문제일 수 있어요). 잠시 후 다시 시도하세요.'); return; }
    const note = overBudget ? ' (예산 초과분은 자동 차감됨)' : '';
    const incomplete = this._incompleteWorkshopPresets(w).length;
    const completionNote = incomplete ? ` 업로드 전 ${incomplete}개 프리셋을 완성 표시해야 합니다.` : ' 모든 프리셋이 완성 표시되어 업로드할 수 있습니다.';
    this._setStatus(`"${w.name}" 저장 + 장착 완료${note}.${completionNote}`);
    this._tutEvent('save');
    try { this.onWorkshopSaved?.(w); } catch {}
  }

  /** 업로드: the ONLY publish path. Saves locally first (upload never runs on a
   *  save failure); an upload failure never rolls back the local save. */
  async _uploadWorkshop() {
    // Ensure it's saved locally first.
    this._saveWorkshop();
    const w = this._lastSaved;
    if (!w) { this._setStatus('업로드하려면 먼저 저장이 성공해야 합니다.'); return; }
    if (!this.onUploadWorkshop) { this._setStatus('업로드 기능을 사용할 수 없습니다.'); return; }
    const upload = this._workshopUploadPayload(w);
    if (!upload) { this._setStatus('업로드하려면 최소 1개 이상의 프리셋을 완성 표시해야 합니다.'); return; }
    const skipped = this._incompleteWorkshopPresets(w);
    this._setStatus(`"${w.name}" 업로드 중...${skipped.length ? ` 미완성 프리셋 ${skipped.length}개는 제외됩니다.` : ''}`);
    try {
      // Bridge: attach a V1 runtime projection so the existing publish path
      // (stats/motionSet/blocks) stores a usable doc alongside the V2 fields.
      const v1 = v2ToV1Runtime(upload) || {};
      // Carry the custom weapon's actual pixels so RECIPIENTS see the image too
      // (the imageId alone only resolves on the author's device). Shrunk to fit
      // the shared budget rather than silently dropped when the source is large
      // — a detailed image still reaches recipients, just downscaled.
      let weaponImage = null;
      let offhandImage = null;
      let hatImage = null;
      const hatImages = [];
      const effectImages = [];
      const imgId = upload.weaponVisual && upload.weaponVisual.imageId;
      if (imgId && imgId.startsWith('custom:')) {
        const rec = this._customWeapon(imgId);
        if (rec && rec.src) {
          const src = await shrinkDataUrlToBudget(rec.src, WEAPON_IMAGE_BUDGET);
          if (src && src.length <= WEAPON_IMAGE_BUDGET) {
            weaponImage = { id: rec.id, name: rec.name, src, size: rec.size || 2, anchors: rec.anchors || null };
          }
        }
      }
      const offhandId = upload.weaponVisual?.offhand?.imageId;
      if (offhandId && offhandId.startsWith('custom:')) {
        const rec = this._customWeapon(offhandId);
        if (rec && rec.src) {
          const src = await shrinkDataUrlToBudget(rec.src, WEAPON_IMAGE_BUDGET);
          if (src && src.length <= WEAPON_IMAGE_BUDGET) {
            offhandImage = { id: rec.id, name: rec.name, src, size: rec.size || 2, anchors: rec.anchors || null };
          }
        }
      }
      const hats = Array.isArray(upload.weaponVisual?.hats) && upload.weaponVisual.hats.length ? upload.weaponVisual.hats.slice(0, 5) : (upload.weaponVisual?.hat ? [upload.weaponVisual.hat] : []);
      for (const hat of hats) {
        const hatId = hat?.imageId;
        if (!hatId || !hatId.startsWith('custom:')) continue;
        const rec = this._customWeapon(hatId);
        if (rec && rec.src) {
          const src = await shrinkDataUrlToBudget(rec.src, HAT_IMAGE_BUDGET);
          if (src && src.length <= HAT_IMAGE_BUDGET) {
            const payload = { id: rec.id, name: rec.name, src, size: rec.size || 1, anchors: null };
            if (!hatImage) hatImage = payload;
            hatImages.push(payload);
          }
        }
      }
      const effectIds = new Set();
      for (const preset of Object.values(upload.presets || {})) {
        for (const fx of (Array.isArray(preset?.effects) ? preset.effects : [])) {
          if (fx?.assetId && String(fx.assetId).startsWith('custom:fx_')) effectIds.add(fx.assetId);
        }
      }
      for (const fxId of [...effectIds].slice(0, 24)) {
        const rec = this._customWeapon(fxId);
        if (!rec?.src) continue;
        const src = await shrinkDataUrlToBudget(rec.src, EFFECT_IMAGE_BUDGET);
        if (src && src.length <= EFFECT_IMAGE_BUDGET) {
          effectImages.push({ id: rec.id, name: rec.name, src, size: rec.size || 1, anchors: null });
        }
      }
      await this.onUploadWorkshop({ ...upload, stats: v1.stats, motionSet: v1.motionSet, blocks: v1.blocks, weaponImage, offhandImage, hatImage, hatImages, effectImages });
      this._setStatus(`"${w.name}" 업로드 완료!${skipped.length ? ` 미완성 프리셋 ${skipped.length}개는 제외했습니다.` : ' 워크샵에서 다른 유저가 사용할 수 있습니다.'}`);
    } catch (e) {
      // Local save stays intact — only the share failed.
      this._setStatus(`업로드 실패 (${e && e.message ? e.message : '네트워크'}) — 로컬 저장/장착은 그대로예요. 나중에 다시 업로드하세요.`);
    }
  }

  _setStatus(t) { const el = document.getElementById('meStatus'); if (el) el.textContent = t; }
  _renderAll() {
    const btn = document.getElementById('meAddHitbox');
    if (btn) btn.textContent = this._activeHitboxIndexAt(this._currentMotionTime()) >= 0 ? '－ 현재 판정 제거' : '＋ 현재 프레임 판정';
    this._updateFrameLabel();
    this._syncFrameScopedControls();
    this._renderBudget();
    this._renderFrameOverview();
    this._renderPreview(); this._renderTimeline();
  }
}
