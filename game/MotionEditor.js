/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-game motion editor (Phase C of the stickman pivot) — a small Stick-Nodes
 * style tool: drag joints to pose the figure, drop keyframes along a timeline,
 * place the impact marker, preview, and save. Output is PURE COSMETIC motion
 * data (the schema in Motion.js); it can never touch hitboxes/range/damage/
 * cooldown/physics.
 *
 * Guardrails (the whole point):
 *  - The weapon's hit-active window is fixed and DRAWN on the timeline as a band;
 *    the impact marker is clamped inside it, so a user can only choose WHERE in
 *    the cosmetic swing the (already fixed) hit reads from.
 *  - Scope caps keep it light + the data bounded: ≤ 8 keyframes, fixed canvas,
 *    the 10 known joints only.
 *  - Everything is re-sanitized by Motion.sanitizeMotion on save/load/register,
 *    so even a hand-edited localStorage blob can't inject unsafe data.
 */

import { solveStickman, drawStickFromJoints, samplePose, STICK_NEUTRAL, WEAPON_STICK_COLOR } from './Stickman.js';
import { resolveMotion, weaponSetId, sanitizeMotion, registerMotionSet, MOTION_LIMITS, setCanonicalWeapon } from './Motion.js';
import { captureMotionFromWebcam } from './PoseCapture.js';
import { equippedStickLook, saveStickLook } from './StickLook.js';
import { clampWorkshopStats, statCost, enforceBudget, clampWorkshopWeapon, POINT_BUDGET } from './Workshop.js';
import { BlockEditor } from './BlockEditor.js';

const MAX_KF = 16;                                 // editor keyframe budget (admin authoring)
const HIT_WINDOW = { start: 0.3, end: 0.7 };       // fixed cosmetic impact band (normalized)
const STORE_SETS = 'pixelroyale_motionsets_v1';    // { id: { attack: motion } }
const STORE_EQUIP = 'pixelroyale_equipped_motion_v1';
const STORE_CANON = 'pixelroyale_canonical_weapons_v1'; // { weapon: { attack: motion } }
const STORE_WORKSHOP = 'pixelroyale_workshop_equipped_v1'; // clamped workshop weapon def

const STAT_KEYS = ['damage', 'cooldownMs', 'maxHp', 'moveSpeed', 'range', 'knockback', 'statusDurationMs'];

// Editable weapons (those whose stick attack reads clearly). Kept short on purpose.
const EDITOR_WEAPONS = ['sword', 'spear', 'hammer', 'katana', 'axe', 'rapier', 'bow', 'scythe'];

// Fixed motion-tag vocabulary (the bridge between authored motions and gameplay /
// blockcoding). Keys are the engine slot names; labels are what users see.
// attack/run/idle/jump auto-apply via the StickAnimator; dash/skill/hurt/kill are
// trigger tags fired by block programs (모션 재생 블록).
export const MOTION_TAGS = [
  { key: 'attack', label: '공격' }, { key: 'run', label: '걷기' },
  { key: 'idle', label: '대기' }, { key: 'jump', label: '점프' },
  { key: 'dash', label: '대시' }, { key: 'skill', label: '스킬' },
  { key: 'hurt', label: '피격' }, { key: 'kill', label: '처치' },
];
const TAG_LABEL = Object.fromEntries(MOTION_TAGS.map(t => [t.key, t.label]));

// Resizable editor columns: drag threshold below which a block folds shut, and
// the localStorage key persisting per-column widths / collapsed state.
const ME_COLLAPSE_AT = 120;
const ME_LAYOUT_KEY = 'psd_me_layout';

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

/** The equipped workshop weapon def (already envelope-clamped), or null. */
export function equippedWorkshopWeapon() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_WORKSHOP) || 'null');
    return raw ? clampWorkshopWeapon(raw) : null;   // re-clamp defensively
  } catch { return null; }
}

/** Equip a workshop weapon (re-clamped before storing). Returns the safe def. */
export function equipWorkshopWeapon(def) {
  const safe = clampWorkshopWeapon(def);
  try { localStorage.setItem(STORE_WORKSHOP, JSON.stringify(safe)); } catch {}
  return safe;
}

/** Unequip the workshop weapon (back to the base weapon). */
export function clearWorkshopWeapon() {
  try { localStorage.removeItem(STORE_WORKSHOP); } catch {}
}

/** Name of the currently equipped workshop weapon (or null). */
export function equippedWorkshopWeaponName() {
  const w = equippedWorkshopWeapon();
  return w ? w.name : null;
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
    this.dragImpact = false;
    this.dragHitbox = null;     // 'move' | 'resize' | 'aStart' | 'aEnd'
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
    $('meOnion')?.addEventListener('click', () => { this.onion = !this.onion; this._syncOnionBtn(); this._renderPreview(); });
    // ←/→ flip frames while the editor is open (not while typing / block editor up).
    window.addEventListener('keydown', (e) => {
      if (!this.root || this.root.classList.contains('hidden')) return;
      const be = document.getElementById('blockEditor');
      if (be && !be.classList.contains('hidden')) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
      if (e.key === 'ArrowLeft') { this._gotoFrame(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { this._gotoFrame(1); e.preventDefault(); }
    });
    $('meReset')?.addEventListener('click', () => this._loadTemplate());
    $('meSave')?.addEventListener('click', () => this._save());
    $('meCapture')?.addEventListener('click', () => this._capture());
    $('meAddHitbox')?.addEventListener('click', () => this._toggleHitbox());
    const dur = $('meDuration');
    dur?.addEventListener('input', () => {
      this.motion.duration = clamp(parseFloat(dur.value) || 0.5, MOTION_LIMITS.minDuration, 1.5);
      $('meDurationVal') && ($('meDurationVal').textContent = this.motion.duration.toFixed(2) + 's');
      this._renderTimeline();
    });
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
    $('ms_status')?.addEventListener('change', (e) => this._updateStat('status', e.target.value));
    $('meBlockBtn')?.addEventListener('click', () => {
      if (!this.blockEditor) this.blockEditor = new BlockEditor();
      this.blockEditor.open(this.blocks, 'workshop', (ast) => { this.blocks = ast; this._updateBlockCount(); }, this.stats);
    });

    $('meColor')?.addEventListener('input', (e) => applyLook({ color: e.target.value }));
    $('meColorClear')?.addEventListener('click', () => applyLook({ color: null }));
    $('meLineW')?.addEventListener('input', (e) => applyLook({ lineW: parseInt(e.target.value, 10) }));
    $('meHead')?.addEventListener('change', (e) => applyLook({ head: e.target.value }));
    $('meAccessory')?.addEventListener('change', (e) => applyLook({ accessory: e.target.value }));

    // Preview canvas: drag joint handles.
    this.canvas?.addEventListener('pointerdown', (e) => this._previewDown(e));
    window.addEventListener('pointermove', (e) => this._pointerMove(e));
    window.addEventListener('pointerup', () => this._pointerUp());
    // Timeline: scrub / select / drag keyframe + impact.
    this.timeline?.addEventListener('pointerdown', (e) => this._timelineDown(e));
    // Resizable columns: drag splitters, collapse under threshold, header chips.
    this._initLayout();
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
    .me-expand-rail .vlabel{writing-mode:vertical-rl;font-size:10px;color:#9ca3af;letter-spacing:2px}`;
    document.head.appendChild(st);
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
    const title = this.root.querySelector('h2'); if (title) title.textContent = ws ? '🔧 무기 공방' : '🎬 모션 에디터';
    if (ws) {
      this.stats = clampWorkshopStats({});
      this.blocks = null;
      STAT_KEYS.forEach(k => { const el = $('ms_' + k); if (el) el.value = String(this.stats[k]); const v = $('ms_' + k + '_v'); if (v) v.textContent = this.stats[k]; });
      if ($('ms_status')) $('ms_status').value = this.stats.status;
      this._renderBudget();
      this._updateBlockCount();
    }
    this._populateWeaponSelect();
    this._syncWeaponUI();
    this._loadTemplate();
    this._syncOnionBtn();
    this.root.classList.remove('hidden');
  }

  /** Live-update one workshop stat: clamp into the envelope, reflect the clamped
   *  value back into the slider, and refresh the budget bar. */
  _updateStat(key, value) {
    const next = { ...this.stats, [key]: value };
    this.stats = clampWorkshopStats(next);
    const el = document.getElementById('ms_' + key);
    if (el && key !== 'status' && Number(el.value) !== this.stats[key]) el.value = String(this.stats[key]);
    const v = document.getElementById('ms_' + key + '_v'); if (v) v.textContent = this.stats[key];
    if (document.getElementById('ms_status')) document.getElementById('ms_status').value = this.stats.status;
    this._renderBudget();
  }

  _updateBlockCount() {
    const el = document.getElementById('meBlockCount');
    if (el) el.textContent = (this.blocks && this.blocks.events && this.blocks.events.length) ? '(기믹 있음)' : '';
  }

  _renderBudget() {
    const cost = statCost(this.stats);
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
    this.root?.classList.add('hidden');
  }

  // --- Custom weapon images --------------------------------------------------
  _populateWeaponSelect() {
    const wsel = document.getElementById('meWeapon'); if (!wsel) return;
    const base = EDITOR_WEAPONS.map(w => `<option value="${w}">${w}</option>`).join('');
    const custom = this.customWeapons.length
      ? `<optgroup label="내 무기 이미지">${this.customWeapons.map(c => `<option value="${escOpt(c.id)}">🖼 ${escOpt(c.name)}</option>`).join('')}</optgroup>`
      : '';
    wsel.innerHTML = base + custom;
    wsel.value = this.weapon;
  }
  _customWeapon(id) { return this.customWeapons.find(c => c.id === id) || null; }
  /** The (lazily loaded) Image for the current weapon, or null for a built-in. */
  _weaponImage() {
    const c = this._customWeapon(this.weapon); if (!c) return null;
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
  }
  _onWeaponFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { this._setStatus('이미지 파일만 넣을 수 있어요 (PNG 권장).'); return; }
    const reader = new FileReader();
    // Upload flow: pick the grip/tip anchors FIRST, then register on 확인.
    reader.onload = () => this._openAnchorPicker(String(reader.result), (file.name || '무기').replace(/\.[^.]+$/, '').slice(0, 16) || '무기');
    reader.onerror = () => this._setStatus('파일을 읽지 못했어요.');
    reader.readAsDataURL(file);
  }
  /** Downscale (≤256px, keeps localStorage small) then register + select. */
  _addWeaponImage(dataUrl, name, anchors) {
    const img = new Image();
    img.onload = () => {
      const max = 256; let w = img.naturalWidth || 64, h = img.naturalHeight || 64;
      if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      let src = dataUrl; try { src = cv.toDataURL('image/png'); } catch { /* tainted? keep original */ }
      const rec = { id: 'custom:' + Date.now().toString(36), name, src, size: 2.0, anchors: anchors || null };
      this.customWeapons.push(rec); saveCustomWeapons(this.customWeapons);
      this.weapon = rec.id;
      this._populateWeaponSelect(); this._syncWeaponUI();
      this._loadTemplate();
      this._setStatus('무기 이미지 추가됨! 주황 점을 끌어 방향을, 슬라이더로 크기를, ⚓기준점으로 손잡이·끝을 다시 맞출 수 있어요.');
    };
    img.onerror = () => this._setStatus('이미지를 불러오지 못했어요.');
    img.src = dataUrl;
  }

  // --- Grip/tip anchor picker -------------------------------------------------
  /** Open the picker for a fresh upload (rec=null) or an existing weapon (rec). */
  _openAnchorPicker(dataUrl, name, rec = null) {
    const modal = document.getElementById('meAnchorModal');
    const cv = document.getElementById('meAnchorCanvas');
    if (!modal || !cv) return;
    const img = new Image();
    img.onload = () => {
      // Fit the canvas to the image (≤380×300) so clicks map 1:1.
      const s = Math.min(380 / img.naturalWidth, 300 / img.naturalHeight, 4);
      cv.width = Math.max(80, Math.round(img.naturalWidth * s));
      cv.height = Math.max(80, Math.round(img.naturalHeight * s));
      const a = (rec && rec.anchors) || { gx: 0.15, gy: 0.5, tx: 0.95, ty: 0.5 };
      this._anchor = { img, dataUrl, name, rec, g: { x: a.gx, y: a.gy }, t: { x: a.tx, y: a.ty }, drag: null, cv };
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
    // grip→tip guide line
    ctx.strokeStyle = 'rgba(255,210,74,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(t.x, t.y); ctx.stroke(); ctx.setLineDash([]);
    const dot = (p, fill, label) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = '#0d0a06'; ctx.fillText(label[0], p.x, p.y + 3.5);
      ctx.fillStyle = fill; ctx.fillText(label, p.x, p.y - 13);
    };
    dot(g, '#ffa050', '손잡이');
    dot(t, '#ff5a5a', '끝');
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
    if (Math.hypot(anchors.tx - anchors.gx, anchors.ty - anchors.gy) < 0.02) anchors = { gx: 0.15, gy: 0.5, tx: 0.95, ty: 0.5 };
    if (A.rec) {                                   // editing an existing weapon
      A.rec.anchors = anchors;
      saveCustomWeapons(this.customWeapons);
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
    this._populateWeaponSelect(); this._syncWeaponUI(); this._loadTemplate();
    this._setStatus('무기 이미지를 삭제했습니다.');
  }

  _loadTemplate() {
    // Start from the weapon's current attack swing so users tweak, not start blank.
    // Admin authoring path → keep any canonical hitboxes (allowGameplay).
    const base = resolveMotion(weaponSetId(this.weapon), 'attack');
    this.motion = sanitizeMotion(base, undefined, { allowGameplay: true });
    if (this.motion.keyframes.length > MAX_KF) this.motion.keyframes = this.motion.keyframes.slice(0, MAX_KF);
    if (!this.motion.events.some(e => e.type === 'impact')) {
      this.motion.events.push({ t: (HIT_WINDOW.start + HIT_WINDOW.end) / 2, type: 'impact' });
    }
    // Clamp any impact into the window up front (guardrail).
    for (const e of this.motion.events) if (e.type === 'impact') e.t = clamp(e.t, HIT_WINDOW.start, HIT_WINDOW.end);
    this.selKf = 0;
    this.scrubT = this.motion.keyframes[0]?.t || 0;
    this.playing = false;
    const dur = document.getElementById('meDuration');
    if (dur) { dur.value = String(this.motion.duration); }
    const dv = document.getElementById('meDurationVal'); if (dv) dv.textContent = this.motion.duration.toFixed(2) + 's';
    this._setStatus('무기 기본 스윙을 불러왔습니다. 관절을 끌어 포즈를 만들고 키프레임을 추가하세요.');
    this._renderAll();
  }

  /** Retarget a library preset onto the current stick (Phase D no-ML path). The
   *  preset is sanitized + its impact re-clamped into the window, exactly like
   *  any other motion, then becomes the working motion to tweak or save. */
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
    if (!this.motion.events.some(e => e.type === 'impact')) this.motion.events.push({ t: (HIT_WINDOW.start + HIT_WINDOW.end) / 2, type: 'impact' });
    this.selKf = 0; this.scrubT = this.motion.keyframes[0]?.t || 0; this.playing = false;
    const dur = document.getElementById('meDuration'); if (dur) dur.value = String(this.motion.duration);
    const dv = document.getElementById('meDurationVal'); if (dv) dv.textContent = this.motion.duration.toFixed(2) + 's';
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
      for (const e of this.motion.events) if (e.type === 'impact') e.t = clamp(e.t, HIT_WINDOW.start, HIT_WINDOW.end);
      this.selKf = 0; this.scrubT = 0; this.playing = false;
      const dur = document.getElementById('meDuration'); if (dur) dur.value = String(this.motion.duration);
      const dv = document.getElementById('meDurationVal'); if (dv) dv.textContent = this.motion.duration.toFixed(2) + 's';
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

  // --- Hitbox (admin canonical gameplay) -------------------------------------
  _hb() { return (this.motion.hitboxes && this.motion.hitboxes[0]) || null; }

  /** Add a default hitbox to the attack motion, or remove the existing one
   *  (MVP = a single hitbox). World px relative to the player centre. */
  _toggleHitbox() {
    if (!Array.isArray(this.motion.hitboxes)) this.motion.hitboxes = [];
    if (this.motion.hitboxes.length) {
      this.motion.hitboxes = [];
      this._setStatus('히트박스 제거됨. 이 무기는 기본 판정으로 돌아갑니다.');
    } else {
      this.motion.hitboxes = [{ ox: 30, oy: -6, w: 52, h: 44, activeStart: 0.35, activeEnd: 0.6 }];
      this._setStatus('히트박스 추가됨. 빨간 상자를 끌어 위치·크기를, 타임라인 주황 띠로 활성 구간을 잡으세요.');
    }
    const btn = document.getElementById('meAddHitbox');
    if (btn) btn.textContent = this.motion.hitboxes.length ? '－ 제거' : '＋ 추가';
    this._renderAll();
  }

  // --- Pose helpers ----------------------------------------------------------
  _displayPose() {
    if (this.playing) return samplePose(this.motion, this.scrubT);
    const kf = this.motion.keyframes[this.selKf];
    if (kf) return { ...STICK_NEUTRAL, ...kf.pose };   // exact selected keyframe
    return samplePose(this.motion, this.scrubT);
  }

  // --- Preview canvas --------------------------------------------------------
  _renderPreview() {
    const ctx = this.ctx; if (!ctx) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#14100b'; ctx.fillRect(0, 0, W, H);
    // ground line
    ctx.strokeStyle = '#3b3a44'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, H - 30); ctx.lineTo(W, H - 30); ctx.stroke();

    const scale = Math.round(H * 0.114);                // stickman scales with the canvas (404→46)
    const cx = W / 2, cyCenter = H - 30 - scale * 1.28; // body centre so feet sit on the ground line
    const wrec = this._customWeapon(this.weapon);             // custom weapon record (or null)
    const wimg = this._weaponImage();                         // its image (or null)
    const wsize = wrec?.size ?? 2.0;
    const wanch = wrec?.anchors || null;                      // grip/tip anchors

    // Onion skin: the PREVIOUS frame's pose, drawn faint + blue behind the current
    // one, so you can see what the stickman did last and build the next pose from it.
    if (this.onion && !this.playing && this.motion.keyframes[this.selKf] && this.selKf > 0) {
      const prev = this.motion.keyframes[this.selKf - 1];
      if (prev) {
        const pj = solveStickman({ ...STICK_NEUTRAL, ...prev.pose }, scale, cx, cyCenter, 1, { rawNearArm: true, weapon: this.weapon });
        ctx.save(); ctx.globalAlpha = 0.3;
        drawStickFromJoints(ctx, pj.joints, pj.headR, { color: '#6f8cff', accent: '#0d0a06', lineW: this.look.lineW, scale, weapon: this.weapon, drawWeapon: true, aimAngle: 0, headShape: this.look.head, accessory: this.look.accessory, weaponImage: wimg, weaponImageSize: wsize, weaponImageAnchors: wanch });
        ctx.restore();
      }
    }

    const pose = this._displayPose();
    const { joints, headR } = solveStickman(pose, scale, cx, cyCenter, 1, { rawNearArm: true, weapon: this.weapon });
    const color = this.look.color || WEAPON_STICK_COLOR[this.weapon] || '#cdd3da';
    drawStickFromJoints(ctx, joints, headR, { color, accent: '#0d0a06', lineW: this.look.lineW, scale, weapon: this.weapon, drawWeapon: true, aimAngle: 0, headShape: this.look.head, accessory: this.look.accessory, weaponImage: wimg, weaponImageSize: wsize, weaponImageAnchors: wanch });

    // Joint handles (only when a keyframe is selected & not playing).
    if (!this.playing && this.motion.keyframes[this.selKf]) {
      for (const h of HANDLES) {
        const p = joints[h.name]; if (!p) continue;
        const isWeapon = h.name === 'weaponTip';
        ctx.beginPath(); ctx.arc(p.x, p.y, isWeapon ? 7 : 6, 0, Math.PI * 2);
        ctx.fillStyle = this.dragHandle === h.name ? '#ffd24a' : (isWeapon ? 'rgba(255,160,80,0.9)' : 'rgba(125,240,154,0.85)');
        ctx.fill(); ctx.strokeStyle = '#0d0a06'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // Hitbox overlay (admin gameplay). World px → editor px by scale/14, anchored
    // at the body centre. Brighter while the playhead is inside its active window.
    const hb = this._hb();
    if (hb) {
      const W2E = scale / 14;
      const hcx = cx + hb.ox * W2E, hcy = cyCenter + hb.oy * W2E;
      const hw = hb.w * W2E, hh = hb.h * W2E;
      const active = this.scrubT >= hb.activeStart && this.scrubT <= hb.activeEnd;
      ctx.fillStyle = active ? 'rgba(255,90,60,0.34)' : 'rgba(255,90,60,0.14)';
      ctx.strokeStyle = active ? '#ff7a5a' : 'rgba(255,122,90,0.6)';
      ctx.lineWidth = 2;
      ctx.fillRect(hcx - hw / 2, hcy - hh / 2, hw, hh);
      ctx.strokeRect(hcx - hw / 2, hcy - hh / 2, hw, hh);
      // Move handle (centre) + resize handle (bottom-right corner).
      ctx.fillStyle = this.dragHitbox === 'move' ? '#ffd24a' : '#ff7a5a';
      ctx.beginPath(); ctx.arc(hcx, hcy, 5, 0, Math.PI * 2); ctx.fill();
      const rx = hcx + hw / 2, ry = hcy + hh / 2;
      ctx.fillStyle = this.dragHitbox === 'resize' ? '#ffd24a' : '#ffb070';
      ctx.fillRect(rx - 5, ry - 5, 10, 10);
      this._hbScreen = { hcx, hcy, hw, hh, rx, ry, W2E, cx, cyCenter };
    } else {
      this._hbScreen = null;
    }
    this._jointCache = joints;
  }

  _previewDown(e) {
    if (this.playing) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    // Hitbox handles take priority (resize corner, then move centre).
    const s = this._hbScreen;
    if (s) {
      if ((s.rx - mx) ** 2 + (s.ry - my) ** 2 < 12 * 12) { this.dragHitbox = 'resize'; e.preventDefault(); return; }
      if ((s.hcx - mx) ** 2 + (s.hcy - my) ** 2 < 12 * 12) { this.dragHitbox = 'move'; e.preventDefault(); return; }
    }
    if (!this.motion.keyframes[this.selKf]) return;
    let best = null, bestD = 14 * 14;
    for (const h of HANDLES) {
      const p = this._jointCache?.[h.name]; if (!p) continue;
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best) { this.dragHandle = best.name; e.preventDefault(); }
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
    const h = HANDLES.find(x => x.name === this.dragHandle); if (!h) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
    const my = (e.clientY - r.top) * (this.canvas.height / r.height);
    const parent = this._jointCache?.[h.parent]; if (!parent) return;
    // Editor is facing +1 / no flip, so screen angle == authored local angle.
    let deg = Math.atan2(my - parent.y, mx - parent.x) / DEG;
    deg = clamp(deg, MOTION_LIMITS.angleMin, MOTION_LIMITS.angleMax);
    const kf = this.motion.keyframes[this.selKf];
    kf.pose[h.joint] = Math.round(deg);
    this._renderPreview();
  }

  // --- Timeline --------------------------------------------------------------
  _renderTimeline() {
    const ctx = this.tctx; if (!ctx) return;
    const W = this.timeline.width, H = this.timeline.height;
    const pad = 10, x0 = pad, x1 = W - pad, span = x1 - x0;
    const tx = (t) => x0 + t * span;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0a06'; ctx.fillRect(0, 0, W, H);
    // Hit window band (fixed; guardrail).
    ctx.fillStyle = 'rgba(125,240,154,0.16)';
    ctx.fillRect(tx(HIT_WINDOW.start), 6, tx(HIT_WINDOW.end) - tx(HIT_WINDOW.start), H - 24);
    ctx.strokeStyle = 'rgba(125,240,154,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(tx(HIT_WINDOW.start), 6, tx(HIT_WINDOW.end) - tx(HIT_WINDOW.start), H - 24);
    ctx.fillStyle = '#7df09a'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('판정 창', (tx(HIT_WINDOW.start) + tx(HIT_WINDOW.end)) / 2, H - 4);
    // Track line.
    ctx.strokeStyle = '#3b3a44'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, H / 2 - 4); ctx.lineTo(x1, H / 2 - 4); ctx.stroke();
    // Keyframes.
    this.motion.keyframes.forEach((kf, i) => {
      const x = tx(kf.t);
      ctx.fillStyle = i === this.selKf ? '#ffd24a' : '#e8d5a3';
      ctx.beginPath(); ctx.moveTo(x, H / 2 - 12); ctx.lineTo(x + 5, H / 2 - 4); ctx.lineTo(x - 5, H / 2 - 4); ctx.closePath(); ctx.fill();
    });
    // Hitbox active-window band (admin) — orange band + start/end handles. No
    // HIT_WINDOW clamp for the canonical authoring path.
    const hb = this._hb();
    if (hb) {
      const xs = tx(hb.activeStart), xe = tx(hb.activeEnd);
      ctx.fillStyle = 'rgba(255,122,90,0.22)';
      ctx.fillRect(xs, 18, xe - xs, H - 40);
      ctx.fillStyle = '#ff7a5a';
      ctx.fillRect(xs - 2, 14, 4, H - 30);   // start handle
      ctx.fillRect(xe - 2, 14, 4, H - 30);   // end handle
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText('활성', (xs + xe) / 2, 22);
    }
    // Impact marker.
    const imp = this.motion.events.find(e => e.type === 'impact');
    if (imp) {
      const x = tx(imp.t);
      ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - 16); ctx.stroke();
      ctx.fillStyle = '#ff5a5a'; ctx.beginPath(); ctx.arc(x, 6, 4, 0, Math.PI * 2); ctx.fill();
    }
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
    // Grab a hitbox active-window handle first (admin).
    const hb = this._hb();
    if (hb) {
      if (Math.abs(hb.activeStart - t) < 0.04) { this.dragHitbox = 'aStart'; return; }
      if (Math.abs(hb.activeEnd - t) < 0.04) { this.dragHitbox = 'aEnd'; return; }
    }
    const imp = this.motion.events.find(ev => ev.type === 'impact');
    // Grab the impact marker if close.
    if (imp && Math.abs(imp.t - t) < 0.04) { this.dragImpact = true; return; }
    // Grab the nearest keyframe if close, else scrub.
    let nearest = -1, nd = 0.05;
    this.motion.keyframes.forEach((kf, i) => { const d = Math.abs(kf.t - t); if (d < nd) { nd = d; nearest = i; } });
    if (nearest >= 0) { this.selKf = nearest; this.dragKfIndex = nearest; this.scrubT = this.motion.keyframes[nearest].t; }
    else { this.playing = false; this.scrubT = t; }
    this._renderAll();
  }

  _pointerMove(e) {
    if (this.dragHandle) { this._dragJointTo(e); return; }
    if (this.dragHitbox === 'move' || this.dragHitbox === 'resize') { this._dragHitboxTo(e); return; }
    if (this.dragHitbox === 'aStart' || this.dragHitbox === 'aEnd') {
      const hb = this._hb(); if (hb) {
        const t = this._timelineT(e);
        if (this.dragHitbox === 'aStart') hb.activeStart = clamp(Math.min(t, hb.activeEnd), 0, 1);
        else hb.activeEnd = clamp(Math.max(t, hb.activeStart), 0, 1);
      }
      this._renderTimeline();
      return;
    }
    if (this.dragImpact) {
      const t = clamp(this._timelineT(e), HIT_WINDOW.start, HIT_WINDOW.end); // guardrail clamp
      const imp = this.motion.events.find(ev => ev.type === 'impact'); if (imp) imp.t = t;
      this._renderTimeline();
      return;
    }
    if (this.dragKfIndex >= 0) {
      const kf = this.motion.keyframes[this.dragKfIndex];
      kf.t = clamp(this._timelineT(e), 0, 1);
      this.scrubT = kf.t;
      this._renderAll();
    }
  }
  _pointerUp() {
    if (this.dragKfIndex >= 0) this.motion.keyframes.sort((a, b) => a.t - b.t);
    this.dragHandle = null; this.dragImpact = false; this.dragKfIndex = -1; this.dragHitbox = null;
  }

  // --- Frame flip (stick-fighter) --------------------------------------------
  /** Flip to the previous/next keyframe (a "page"), keeping its authored pose. */
  _gotoFrame(delta) {
    const n = this.motion?.keyframes.length || 0; if (!n) return;
    this.playing = false;
    if (document.getElementById('mePlay')) document.getElementById('mePlay').textContent = '▶ 재생';
    this.selKf = clamp(this.selKf + delta, 0, n - 1);
    this.scrubT = this.motion.keyframes[this.selKf].t;
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
    const kf = { t: clamp(t, 0, 1), pose: { ...STICK_NEUTRAL, ...cur.pose } };   // carry the current pose forward
    kfs.push(kf); kfs.sort((a, b) => a.t - b.t);
    this.selKf = kfs.indexOf(kf); this.scrubT = kf.t; this.playing = false;
    this._setStatus('새 프레임 — 이전 포즈를 그대로 이어받았습니다. 관절을 조금씩 바꿔 다음 동작을 만드세요.');
    this._renderAll();
  }
  _syncOnionBtn() { const b = document.getElementById('meOnion'); if (b) { b.style.opacity = this.onion ? '1' : '0.4'; b.style.borderColor = this.onion ? '#6f8cff' : '#555'; } }
  _updateFrameLabel() { const el = document.getElementById('meFrameLabel'); if (el) el.textContent = `${(this.motion?.keyframes.length ? this.selKf + 1 : 0)} / ${this.motion?.keyframes.length || 0}`; }

  // --- Keyframe ops ----------------------------------------------------------
  _addKeyframe() {
    const kfs = this.motion.keyframes;
    if (kfs.length >= MAX_KF) { this._setStatus(`키프레임은 최대 ${MAX_KF}개입니다.`); return; }
    // Insert at the playhead — but if that lands on (or next to) an existing
    // keyframe, drop it in the MIDDLE OF THE LARGEST EMPTY GAP instead. Otherwise
    // a new frame at an existing one's time is an invisible duplicate (the old
    // "add does nothing" bug): samplePose returns the same pose, hidden behind it.
    let t = clamp(this.scrubT, 0, 1);
    const collides = (tt) => kfs.some(k => Math.abs(k.t - tt) < 0.03);
    if (collides(t)) {
      const ts = [0, ...kfs.map(k => k.t), 1].sort((a, b) => a - b);
      let bestGap = -1;
      for (let i = 0; i < ts.length - 1; i++) {
        const g = ts[i + 1] - ts[i];
        if (g > bestGap) { bestGap = g; t = (ts[i] + ts[i + 1]) / 2; }
      }
    }
    const pose = { ...samplePose(this.motion, t) };            // snapshot the current look
    const kf = { t, pose };
    kfs.push(kf);
    kfs.sort((a, b) => a.t - b.t);
    this.selKf = kfs.indexOf(kf);
    this.scrubT = t;                                           // move the playhead onto the new frame
    this.playing = false;
    this._setStatus('키프레임 추가됨. 관절을 끌어 이 프레임의 포즈를 편집하세요.');
    this._renderAll();
  }
  _delKeyframe() {
    if (this.motion.keyframes.length <= 2) { this._setStatus('키프레임은 최소 2개 필요합니다.'); return; }
    this.motion.keyframes.splice(this.selKf, 1);
    this.selKf = Math.max(0, this.selKf - 1);
    this._renderAll();
  }

  // --- Playback --------------------------------------------------------------
  _togglePlay() {
    this.playing = !this.playing;
    document.getElementById('mePlay') && (document.getElementById('mePlay').textContent = this.playing ? '⏸ 정지' : '▶ 재생');
    if (this.playing) { this.scrubT = 0; this._lastT = performance.now(); this._loop(); }
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

  /** Tier-2 workshop save: build a workshop weapon from the stats + motion, run
   *  it through the balance envelope + budget, persist it as the equipped weapon,
   *  and let the host wire publish/Firestore via onSaveWorkshop. */
  _saveWorkshop() {
    const raw = (document.getElementById('meName')?.value || '').trim() || `${this.weapon} 공방무기`;
    const { stats, overBudget } = enforceBudget(this.stats);
    // Bundle the equipped preset of each tag; the editor's current motion stays
    // the attack unless an 공격-tag preset is explicitly equipped.
    const tagged = this._equippedTagMotions();
    const def = clampWorkshopWeapon({
      name: raw, color: this.look.color || null, stats,
      motionSet: { attack: this.motion, ...tagged },
      blocks: this.blocks,
    });
    try { localStorage.setItem(STORE_WORKSHOP, JSON.stringify(def)); } catch {}
    try { const r = this.onSaveWorkshop?.(def); if (r && typeof r.then === 'function') r.catch(() => {}); } catch {}
    // Reflect any budget bleed back into the sliders.
    this.stats = def.stats;
    STAT_KEYS.forEach(k => { const v = document.getElementById('ms_' + k + '_v'); if (v) v.textContent = def.stats[k]; const el = document.getElementById('ms_' + k); if (el) el.value = String(def.stats[k]); });
    this._renderBudget();
    const note = overBudget ? ' (예산 초과분은 데미지에서 자동 차감됨)' : '';
    this._setStatus(`공방 무기 "${def.name}" 저장 + 장착 완료${note}. 다음 매치부터 적용됩니다.`);
  }

  _setStatus(t) { const el = document.getElementById('meStatus'); if (el) el.textContent = t; }
  _renderAll() {
    const btn = document.getElementById('meAddHitbox');
    if (btn) btn.textContent = this._hb() ? '－ 제거' : '＋ 추가';
    this._updateFrameLabel();
    this._renderPreview(); this._renderTimeline();
  }
}
