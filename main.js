/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NetworkManager } from './multiplayer/NetworkManager.js';
import { Game } from './game/Game.js';
import { Weapons, SkillConfig, AuxSkillConfig, MagicConfig, ComboConfig, getEffectiveWeapon } from './game/Weapons.js';
import { ASSET_VERSION } from './game/SpriteAtlas.js';
import { Renderer } from './game/Renderer.js';
import { Player } from './game/Player.js';
import { Projectile } from './game/Projectile.js';
import { Protocol } from './multiplayer/Protocol.js';
import { ServerLobby } from './multiplayer/ServerLobby.js';
import * as accountUI from './ui/account-ui.js';
import { isMobileDevice, isPhoneDevice } from './game/Device.js';
import { normalizeRoomConfig, roomConfigBadges } from './game/RoomConfig.js';
import { Sound } from './game/Sound.js';
import { MotionEditor, loadStoredMotionSets, equippedMotionSetId, equippedWorkshopWeapon, equipWorkshopWeapon, clearWorkshopWeapon, equippedWorkshopWeaponName } from './game/MotionEditor.js';
import { loadWorkshopWeaponsV2, saveWorkshopWeaponLocal, equipWorkshopWeaponLocal, equippedWorkshopWeaponId, unequipWorkshopWeapon, deleteWorkshopWeaponLocal, importWorkshopWeapon, v2ToV1Runtime } from './game/WorkshopStore.js';
import { PRESET_LABELS, PRIMARY_PRESET_KEYS, COMBAT_PRESET_KINDS, makeEmptyWeaponV2, toWorkshopWeaponV2 } from './game/Workshop.js';
import { equippedStickLook } from './game/StickLook.js';
import { resolveWeaponImage, getCustomWeaponRecord, shrinkDataUrlToBudget, WEAPON_IMAGE_BUDGET } from './game/WeaponImages.js';
import { DEFAULT_KEYBINDS, formatKeyCode, normalizeKeybinds } from './game/Input.js';

// Dom Elements
const authScreen = document.getElementById('authScreen');
const bootScreen = document.getElementById('bootScreen');
const lobbyMenu = document.getElementById('lobbyMenu');
const gameScreen = document.getElementById('gameScreen');
const gameCanvas = document.getElementById('gameCanvas');
const SELECTED_BASE_WEAPON_KEY = 'pixelroyale_selected_base_weapon';

const nicknameInput = document.getElementById('nicknameInput');
const hostRoomInput = document.getElementById('hostRoomInput');
const joinRoomInput = document.getElementById('joinRoomInput');

const hostBtn = document.getElementById('hostBtn');
const dummyBtn = document.getElementById('dummyBtn');
const quickStartBtn = document.getElementById('quickStartBtn');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');

const openRoomCustomBtn = document.getElementById('openRoomCustomBtn');
const roomCustomModal = document.getElementById('roomCustomModal');
const roomCustomClose = document.getElementById('roomCustomClose');
const healingRateRow = document.getElementById('healingRateRow');
const botCountRow = document.getElementById('botCountRow');
const roomCodeRow = document.getElementById('roomCodeRow');
const roomCustomTitle = document.getElementById('roomCustomTitle');

const weaponCards = document.querySelectorAll('.weapon-card');
const weaponStats = document.getElementById('weaponStats');
const weaponPreview = document.getElementById('weaponPreview');
const statusMsg = document.getElementById('statusMsg');
const hostServerIndicator = document.getElementById('hostServerIndicator');

const roomListContainer = document.getElementById('roomListContainer');
const roomListStatus = document.getElementById('roomListStatus');
const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');

let netManager = null;
let activeGame = null;

// --- Sound setup: unlock audio on first gesture, sync mute toggles, UI blips.
(function setupSound() {
  const unlockOnce = () => Sound.unlock();
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  const syncMuteButtons = (muted) => {
    document.querySelectorAll('.mute-toggle').forEach(btn => {
      btn.textContent = muted ? '🔇 음소거' : '🔊 소리';
      btn.classList.toggle('opacity-60', muted);
    });
  };
  syncMuteButtons(Sound.isMuted());
  Sound.onMuteChange(syncMuteButtons);

  // Delegated UI sounds for every button (lobby + HUD). Gameplay action buttons
  // and the mute toggles handle their own audio, so skip them here.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    Sound.unlock();
    if (btn.classList.contains('mute-toggle')) {
      Sound.toggleMute();
      if (!Sound.isMuted()) Sound.play('ui');
      return;
    }
    if (btn.classList.contains('mobile-action-btn')) return; // gameplay, not UI
    Sound.play(btn.id === 'hostBtn' || btn.id === 'dummyBtn' ? 'uiConfirm' : 'ui');
  }, true);
})();

function registerPwa() {
  if (!('serviceWorker' in navigator)) return;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalhost) return;

  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(registration => registration.update())
      .catch(err => {
        console.warn('PWA service worker registration failed', err);
      });
  });
}

// Keep release communication in one place. Update this object whenever a
// public build ships; the lobby notice renders it without duplicating markup.
const LOBBY_PATCH = Object.freeze({
  version: '2026.07.12 · 이동 안정화·FX 좌표 일치 패치',
  items: [
    '방 최초 입장 시 장착한 공방 무기 즉시 적용',
    '대형 공방 데이터의 입장 직후 중복 상태 전송 제거',
    '편도 지연을 포함한 연속 목표점 계산으로 앞뒤 위치 흔들림 제거',
    '커스텀 FX 위치·크기를 공방 미리보기와 같은 단위로 통일',
    '캐릭터 방향에 맞춰 FX 위치·회전·좌우 방향 함께 반전',
  ],
});

function renderLobbyPatchNotice() {
  const version = document.getElementById('lobbyPatchVersion');
  const items = document.getElementById('lobbyPatchItems');
  if (version) version.textContent = LOBBY_PATCH.version;
  if (items) items.textContent = LOBBY_PATCH.items.map(item => `· ${item}`).join('  ');
}
renderLobbyPatchNotice();

// Cross-device room presence (broker-backed, localStorage fallback).
const roomRegistry = new ServerLobby();   // server /rooms list (replaces MQTT)

const UI_ICONS = {
  attack: '<path d="M14.5 3.5l6 6"/><path d="M2.5 21.5l7-7"/><path d="M8.5 13.5l2 2"/><path d="M12.5 9.5l2 2"/><path d="M9.5 14.5l5-5"/>',
  hp: '<path d="M12 21s-7.5-4.8-9.4-9.2C1.1 8.3 3.2 5 6.8 5c2 0 3.4 1.1 4.2 2.3C11.8 6.1 13.2 5 15.2 5c3.6 0 5.7 3.3 4.2 6.8C19.5 16.2 12 21 12 21z" fill="currentColor" stroke="none"/>',
  range: '<path d="M4 18L18 4"/><path d="M8 20l12-12"/><path d="M5 14l5 5"/><path d="M9 10l5 5"/><path d="M13 6l5 5"/>',
  speed: '<path d="M4 13a8 8 0 0 1 15.4-3"/><path d="M12 13l5-5"/><path d="M4 17h5"/><path d="M3 21h8"/>',
  online: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  storage: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.4-4.1 4.2-6 8-6s6.6 1.9 8 6"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21c1-3.5 3.2-5 6-5s5 1.5 6 5"/><path d="M16 11a3 3 0 1 0-1.4-5.7"/><path d="M18 21c-.4-1.7-1.2-3-2.4-3.9"/>'
};

const WEAPON_ICON_VERSION = '20260607c';
const NINJA_WEAPON_SPRITES = new Set(['sword','axe','bow','spear','greatsword','scythe','dagger','rapier','hammer','katana','magicstaff','chakram','harpoon','guardian','minebag','sniper','flamethrower','gauntlet','pistols']);

function uiIcon(name, className = 'inline-block w-3 h-3 align-[-2px] mr-1 shrink-0') {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || ''}</svg>`;
}

function weaponIconRotation(weaponType) {
  if (weaponType === 'bow') return '';
  if (weaponType === 'greatsword') return 'transform:rotate(270deg);';
  return 'transform:rotate(90deg);';
}

function weaponIconMarkup(weaponType, { preview = false, skin = null } = {}) {
  const safeWeapon = encodeURIComponent(String(weaponType || 'sword'));
  const className = preview ? 'weapon-preview-art' : 'w-full h-full object-contain';
  if (NINJA_WEAPON_SPRITES.has(weaponType)) {
    const padding = preview ? 'padding:10%;' : 'padding:14%;';
    // pistols weapon card uses crossbow skin files
    const skinFile = weaponType === 'pistols' ? 'crossbow' : safeWeapon;
    const baseSrc = `/assets/ninja/weapon/${safeWeapon}.png?v=${ASSET_VERSION}`;
    const src = skin
      ? `/assets/ninja/weapon/skins/${encodeURIComponent(skin)}/${skinFile}.png?v=${ASSET_VERSION}`
      : baseSrc;
    const fallback = skin ? ` onerror="this.onerror=null;this.src='${baseSrc}'"` : '';
    return `<img src="${src}" alt="${safeWeapon}" draggable="false" class="${className}" style="image-rendering:pixelated;${padding}"${fallback} />`;
  }
  return `<img src="/assets/weapons/${safeWeapon}.png?v=${WEAPON_ICON_VERSION}" alt="${safeWeapon}" draggable="false" class="${className}" style="image-rendering:pixelated;${weaponIconRotation(weaponType)}" />`;
}

function workshopWeaponImageMarkup(w, { className = 'workshop-weapon-img', fallbackClass = '' } = {}) {
  const visual = w && w.weaponVisual;
  let src = w && w.weaponImage && typeof w.weaponImage.src === 'string' ? w.weaponImage.src : '';
  if (!src && visual && visual.imageId) {
    const rec = resolveWeaponImage(visual.imageId);
    if (rec && rec.img && rec.img.src) src = rec.img.src;
  }
  if (src) {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(w?.name || '공방 무기')}" draggable="false" class="${className}" style="image-rendering:pixelated" />`;
  }
  return `<span class="${fallbackClass}" style="color:${w?.color || '#ffb070'}">🗡</span>`;
}

function refreshWeaponCards() {
  const skins = accountUI.getEquippedWeaponSkins();
  document.querySelectorAll('.weapon-card').forEach(card => {
    const w = card.dataset.weapon;
    const iconBox = card.querySelector('div');
    if (!iconBox || !w) return;
    const skinKey = w === 'pistols' ? 'crossbow' : w;
    iconBox.innerHTML = weaponIconMarkup(w, { skin: skins[skinKey] || null });
  });
}

/**
 * 1. Weapon Selector UI setup
 */
function setupWeaponSelector() {
  weaponCards.forEach(card => {
    card.addEventListener('click', () => {
      // Toggle CSS selection
      weaponCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      const chosenWeapon = card.dataset.weapon;
      try { if (chosenWeapon) localStorage.setItem(SELECTED_BASE_WEAPON_KEY, chosenWeapon); } catch {}
      displayWeaponStats(chosenWeapon);
    });
  });

  // Show the weapon art in each lobby card (replaces the placeholder SVGs).
  // Prefer the new Ninja/RPG-icon sprites (displayed upright like inventory
  // icons); weapons without one fall back to the legacy PNG (rotated upright).
  weaponCards.forEach(card => {
    const w = card.dataset.weapon;
    const iconBox = card.querySelector('div');
    if (!iconBox || !w) return;
    iconBox.style.width = '100%';
    iconBox.style.height = 'auto';
    iconBox.style.aspectRatio = '1 / 1';
    iconBox.style.maxWidth = '5.25rem';
    iconBox.innerHTML = weaponIconMarkup(w);
  });

  let savedWeapon = null;
  try { savedWeapon = localStorage.getItem(SELECTED_BASE_WEAPON_KEY); } catch {}
  const savedCard = savedWeapon ? document.querySelector(`.weapon-card[data-weapon="${savedWeapon}"]`) : null;
  const defaultCard = savedCard || document.querySelector('.weapon-card[data-weapon="sword"]') || weaponCards[0];
  if (defaultCard) defaultCard.click();
}

function displayWeaponStats(weaponType) {
  const cfg = Weapons[weaponType];
  if (!cfg) return;

  let extraDetails = '';
  if (cfg.type === 'melee_arc') {
    extraDetails = `• 범위: 전방 부채꼴 (${cfg.angle}° 각도)`;
  } else if (cfg.type === 'melee_circle') {
    extraDetails = '• 범위: 주변 360° 회전';
  } else if (cfg.type === 'melee_line') {
    extraDetails = `• 범위: 정방향 직선 (${cfg.width}px 폭)`;
  } else if (cfg.type === 'melee_heavy_arc') {
    extraDetails = `범위: 예열 후 중량 베기 (${cfg.angle}도)`;
  } else if (cfg.type === 'melee_sweet_arc') {
    extraDetails = `범위: 바깥날 강화 (${cfg.innerRange}px 밖)`;
  } else if (cfg.type === 'melee_backstab') {
    extraDetails = `범위: 전방 공격, 배후 피해 ${cfg.backstabDamage}`;
  } else if (cfg.type === 'melee_precise_line') {
    extraDetails = `범위: 정밀 직선 (${cfg.width}px), 중심 피해 ${cfg.critDamage}`;
  } else if (cfg.type === 'melee_slam') {
    extraDetails = `범위: 지연 원형 충격파 (${cfg.innerRange}px 안쪽 강화)`;
  } else if (cfg.type === 'projectile') {
    extraDetails = Number.isFinite(cfg.speed) ? `• 투사체 속도: ${cfg.speed}px/s` : '• 투사체 속도: ∞ (즉시 명중)';
  }
  const rangeLabel = Number.isFinite(cfg.range) ? `${cfg.range}px` : '벽까지';
  const moveSpeedLabel = formatSpeedRatio(cfg.moveSpeed);
  const autoAttackDisabled = cfg.automaticAttack === false;
  const cooldownLabel = autoAttackDisabled ? '평타 없음' : `재사용 대기시간: ${(cfg.cooldown / 1000).toFixed(2)}초`;
  const damageLabel = Number.isFinite(cfg.damage) ? cfg.damage : '∞ (즉사)';
  const attackLabel = autoAttackDisabled
    ? `${uiIcon('attack')}평타: <strong class="text-white">없음</strong>`
    : `${uiIcon('attack')}공격력: <strong class="text-white">${damageLabel}</strong>`;

  weaponStats.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[#e6c75a] font-bold mb-1">
      <span class="whitespace-nowrap">${cfg.name.toUpperCase()}</span>
      <span class="whitespace-nowrap">${cooldownLabel}</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-gray-300 leading-snug">
      <span class="min-w-0 whitespace-nowrap">${attackLabel}</span>
      <span class="min-w-0 whitespace-nowrap">${uiIcon('hp')}체력: <strong class="text-white">${cfg.maxHp || 100}</strong></span>
      <span class="min-w-0 whitespace-nowrap">${uiIcon('range')}사거리: <strong class="text-white">${rangeLabel}</strong></span>
      <span class="min-w-0 whitespace-nowrap">${uiIcon('speed')}이동속도: <strong class="text-white">${moveSpeedLabel}</strong></span>
      <span class="min-w-0 break-keep whitespace-normal">${extraDetails}</span>
    </div>
    <div class="skill-preview mt-2 pt-2 border-t border-gray-700 text-[10px] leading-snug break-keep">${renderSkillPreview(cfg.skill)}</div>
  `;

  if (weaponPreview) setWeaponPreview(weaponType, cfg);
}

// Live weapon preview — runs the REAL game renderer on a tiny gameState so the
// picker shows the exact in-game motion + effects for the selected weapon.
let _previewState = null;
function _ensurePreview() {
  if (_previewState) return _previewState;
  const cv = document.createElement('canvas');
  cv.width = 400; cv.height = 400;
  cv.style.cssText = 'width:400px;height:400px;max-width:400px;max-height:400px;image-rendering:pixelated';
  const controls = document.createElement('div');
  controls.className = 'weapon-preview-controls';
  controls.innerHTML = [
    ['basic', '평'],
    ['strong', '강'],
    ['f', 'F'],
    ['r', 'R'],
    ['lmb', 'L']
  ].map(([action, label]) => `<button type="button" class="weapon-preview-action" data-preview-action="${action}">${label}</button>`).join('');
  const renderer = new Renderer(cv);
  const PX = 300, PY = 300, MAP = 600;
  const dummy = new Player('preview', '', 'sword', PX, PY);
  dummy.angle = 0;
  const camera = {
    zoom: 1.5, tracking: false,
    toScreen(x, y, cw, ch) { return { x: cw / 2 + (x - PX) * this.zoom, y: ch / 2 + (y - PY) * this.zoom }; },
    getShakeOffset() { return { x: 0, y: 0 }; },
  };
  _previewState = { cv, controls, renderer, dummy, camera, PX, PY, MAP, effects: [], projectiles: [], mines: [], firePatches: [], pendingSniperShots: [], pendingMagicShards: [], pendingPreviewActions: [], lastFire: 0, swing: -1, raf: 0, last: performance.now(), weaponType: 'sword', greatswordCharge: null };
  controls.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preview-action]');
    if (!btn) return;
    if (btn.dataset.previewSkipClick === '1') {
      btn.dataset.previewSkipClick = '';
      return;
    }
    _previewTrigger(_previewState, btn.dataset.previewAction, Date.now());
  });
  controls.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-preview-action="f"]');
    if (!btn || _previewState?.weaponType !== 'greatsword') return;
    btn.dataset.previewSkipClick = '1';
    _previewGreatswordChargeStart(_previewState, Date.now());
  });
  controls.addEventListener('pointerup', (e) => {
    const btn = e.target.closest('[data-preview-action="f"]');
    if (!btn || _previewState?.weaponType !== 'greatsword') return;
    _previewGreatswordChargeRelease(_previewState, Date.now());
  });
  controls.addEventListener('pointercancel', () => {
    if (_previewState?.weaponType === 'greatsword') _previewGreatswordChargeRelease(_previewState, Date.now());
  });
  return _previewState;
}

function _updatePreviewControls(p, weaponType) {
  const weapon = Weapons[weaponType] || {};
  const combo = ComboConfig[weaponType];
  const canBasic = weapon.automaticAttack !== false;
  const canStrong = canBasic && Boolean(combo?.finisher);
  p.controls.querySelector('[data-preview-action="basic"]')?.toggleAttribute('hidden', !canBasic);
  p.controls.querySelector('[data-preview-action="strong"]')?.toggleAttribute('hidden', !canStrong);
}
function setWeaponPreview(weaponType, cfg) {
  if (!weaponPreview) return;
  const p = _ensurePreview();
  cancelAnimationFrame(p.raf);
  weaponPreview.innerHTML = '';
  p.weaponType = weaponType;
  const stage = document.createElement('div');
  stage.className = 'weapon-preview-stage';
  stage.appendChild(p.cv);
  stage.appendChild(p.controls);
  weaponPreview.appendChild(stage);
  const name = document.createElement('div');
  name.className = 'weapon-preview-name';
  name.textContent = cfg.name || weaponType;
  weaponPreview.appendChild(name);
  _updatePreviewControls(p, weaponType);

  const d = p.dummy;
  d.weapon = weaponType; d.angle = 0;
  d.weaponSkins = accountUI.getEquippedWeaponSkins();
  d.color = cfg.color || '#9aa2ad';
  d.accentColor = cfg.color || '#c9a227';
  d.maxHp = cfg.maxHp || 100; d.hp = d.maxHp;
  d.isDead = false;
  d.flameSpraying = (weaponType === 'flamethrower');
  d.buffType = null;
  d.pendingIcicles = 0;
  d.chakramOrbitUntil = 0;
  d.heatShieldUntil = 0;
  d.guardianStanceUntil = 0;
  d.guardianSurgeUntil = 0;
  p.effects.length = 0; p.projectiles.length = 0; p.mines.length = 0; p.firePatches.length = 0; p.pendingSniperShots.length = 0; p.pendingMagicShards.length = 0; p.pendingPreviewActions.length = 0; p.greatswordCharge = null; p.lastFire = 0; p.last = performance.now();

  const loop = (t) => {
    const dt = Math.min((t - p.last) / 1000, 0.05); p.last = t; const now = Date.now();
    _previewAutoReleaseGreatsword(p, now);
    _previewReleasePending(p, now);
    p.effects = p.effects.filter(e => { e.progress = (now - e.timestamp) / (e.lifetime || 400); return e.progress < 1; });
    for (const pr of p.projectiles) { if (pr.update) pr.update(dt); }
    p.projectiles = p.projectiles.filter(pr => !pr.isDead && Math.hypot(pr.x - p.PX, pr.y - p.PY) < p.MAP * 0.7);
    p.mines = p.mines.filter(m => !m.expireAt || now < m.expireAt);
    p.firePatches = p.firePatches.filter(fp => !fp.expireAt || now < fp.expireAt);
    const gs = { players: { preview: d }, projectiles: p.projectiles, effects: p.effects,
      mines: p.mines, firePatches: p.firePatches, healingItems: [], cover: [], damagePopups: [], storm: null };
    try { p.renderer.render(gs, null, p.camera, p.MAP, p.MAP, {}); } catch (_) {}
    p.raf = requestAnimationFrame(loop);
  };
  p.raf = requestAnimationFrame(loop);
}
function _previewTrigger(p, action, now) {
  const weaponType = p.weaponType || p.dummy.weapon || 'sword';
  const base = getEffectiveWeapon(weaponType) || Weapons[weaponType] || {};
  if (action === 'basic') {
    _previewFire(p, weaponType, base, now);
  } else if (action === 'strong') {
    _previewStrongAttack(p, weaponType, base, now);
  } else if (action === 'f') {
    if (weaponType === 'greatsword') return _previewGreatswordChargeTap(p, now);
    if (weaponType === 'magicstaff') return _previewMagicFireball(p, now);
    _previewSkill(p, weaponType, SkillConfig[weaponType], now);
  } else if (action === 'r') {
    if (weaponType === 'katana') return _previewKatanaIaijutsu(p, now);
    if (weaponType === 'magicstaff') return _previewMagicLifebound(p, now);
    _previewSkill(p, weaponType, AuxSkillConfig[weaponType]?.alt, now);
  } else if (action === 'lmb') {
    if (weaponType === 'magicstaff') return _previewMagicIce(p, now);
    _previewSkill(p, weaponType, AuxSkillConfig[weaponType]?.target, now);
  }
}

function _previewSkill(p, weaponType, cfg, now) {
  if (!cfg) return _previewTrigger(p, 'strong', now);
  const base = getEffectiveWeapon(weaponType) || Weapons[weaponType] || {};
  if (weaponType === 'sword' && cfg === SkillConfig.sword) {
    _previewSwordSkill(p, now);
    return;
  }
  if (weaponType === 'sniper' && cfg === SkillConfig.sniper) {
    _previewSniperShot(p, now);
    return;
  }
  if (weaponType === 'magicstaff') {
    if (cfg === SkillConfig.magicstaff || cfg === MagicConfig.fireball) return _previewMagicFireball(p, now);
    if (cfg === AuxSkillConfig.magicstaff?.alt || cfg === MagicConfig.lifebound) return _previewMagicLifebound(p, now);
    if (cfg === AuxSkillConfig.magicstaff?.target || cfg === MagicConfig.iceShard) return _previewMagicIce(p, now);
  }
  if (weaponType === 'guardian' && cfg === SkillConfig.guardian) {
    p.dummy.guardianSurgeUntil = now + 1200;
    return;
  }
  switch (cfg.type) {
    case 'hitscan':
      _previewSniperBeam(p, now, { weapon: weaponType, range: cfg.range });
      return;
    case 'aimed_shot':
      _previewAimedShot(p, cfg, now);
      return;
    case 'guardian_launch':
      _previewGuardianLaunch(p, cfg, now);
      return;
    case 'guardian_homing':
      _previewGuardianHoming(p, cfg, now);
      return;
    case 'chakram_throw':
      _previewProjectileFan(p, weaponType, cfg, base, now, 'chakram');
      return;
    case 'chakram_orbit':
      p.dummy.chakramOrbitUntil = now + (cfg.durationMs || 1500);
      p.dummy.chakramOrbitRadius = cfg.orbitRadius || 46;
      return;
    case 'fire_bomb':
      _previewExplosion(p, weaponType, cfg, now, cfg.range || 88);
      return;
    case 'heat_shield':
      p.dummy.heatShieldUntil = now + (cfg.durationMs || 1500);
      p.dummy.heatShieldRadius = cfg.contactRadius || 34;
      return;
    case 'place_mine':
      _previewPlaceMine(p, cfg, now);
      return;
    case 'tracer_mine':
      _previewTracerMine(p, cfg, now);
      return;
    case 'dodge_reload':
      _previewDodgeReload(p, cfg, now);
      return;
    default:
      break;
  }
  if (cfg.type === 'projectile' || Number.isFinite(cfg.speed) || Number.isFinite(cfg.waveSpeed) || cfg.projectileKind || cfg.waveCount || cfg.fanCount || cfg.burstCount) {
    _previewProjectileFan(p, weaponType, cfg, base, now);
    return;
  }
  if (weaponType === 'minebag' && cfg === SkillConfig.minebag) {
    _previewExplosion(p, weaponType, { radius: cfg.blastRadius || 60 }, now, 54);
    return;
  }
  if (weaponType === 'flamethrower' && cfg === SkillConfig.flamethrower) {
    const d = p.dummy;
    p.firePatches.push({
      id: `preview-patch-${now}`,
      ownerId: 'preview',
      x: d.x + Math.cos(d.angle) * (cfg.patchRange || 76),
      y: d.y + Math.sin(d.angle) * (cfg.patchRange || 76),
      expireAt: now + (cfg.patchMs || 2500),
      nextTickAt: now
    });
    return;
  }
  if (weaponType === 'axe' && cfg === SkillConfig.axe) {
    p.dummy.buffType = 'axe_rage';
    p.dummy.buffTimeLeft = (cfg.buffMs || 4000) / 1000;
    p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, weapon: weaponType, type: 'buff_activate', buffType: 'axe_rage', progress: 0, timestamp: now, lifetime: 520 });
    return;
  }
  if (weaponType === 'gauntlet' && cfg === SkillConfig.gauntlet) {
    p.dummy.buffType = 'gauntlet_lance';
    p.dummy.buffTimeLeft = (cfg.buffMs || 4000) / 1000;
    p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, weapon: weaponType, type: 'buff_activate', buffType: 'gauntlet_lance', progress: 0, timestamp: now, lifetime: 520 });
    return;
  }
  if (weaponType === 'rapier' && cfg === SkillConfig.rapier) {
    p.dummy.buffType = 'rapier_riposte';
    p.dummy.buffTimeLeft = (cfg.buffMs || 5000) / 1000;
    p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, weapon: weaponType, type: 'buff_activate', buffType: 'rapier_riposte', progress: 0, timestamp: now, lifetime: 520 });
    return;
  }
  if (weaponType === 'hammer' && cfg === SkillConfig.hammer) {
    p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, angle: p.dummy.angle, weapon: weaponType, type: 'hammer_windup', range: cfg.waves?.at(-1)?.range || 156, progress: 0, timestamp: now, lifetime: cfg.previewMs || 1000 });
    (cfg.waves || []).forEach((wave, i) => {
      p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, angle: p.dummy.angle, weapon: weaponType, type: 'melee_slam', range: wave.range, innerRange: i ? (cfg.waves[i - 1].range || 0) : 0, progress: 0, timestamp: now + (cfg.previewMs || 1000) + i * 180, lifetime: 620 });
    });
    return;
  }
  if (weaponType === 'katana' && cfg === SkillConfig.katana) {
    for (let i = 0; i < (cfg.slashCount || 2); i++) {
      _previewFire(p, weaponType, { ...base, type: 'melee_arc', range: cfg.directRange || 82, angle: cfg.directAngle || 130, damage: cfg.directDamage || 40 }, now + i * (cfg.slashIntervalMs || 150), { finisher: true, lifetime: 500 });
      _previewFire(p, weaponType, { type: 'projectile', projectileKind: 'swordwave', projectileWeapon: weaponType, speed: cfg.waveSpeed || 832, range: 260, damage: cfg.waveDamage || 30 }, now + 20 + i * (cfg.slashIntervalMs || 150));
    }
    return;
  }
  if (weaponType === 'dagger' && cfg === SkillConfig.dagger) {
    p.effects.push({ attackerId: 'preview', x: p.dummy.x, y: p.dummy.y, angle: p.dummy.angle, weapon: weaponType, type: 'dagger_qte_lock', progress: 0, timestamp: now, lifetime: cfg.windowMs || 900 });
    p.effects.push({ attackerId: 'preview', x: p.dummy.x + Math.cos(p.dummy.angle) * 54, y: p.dummy.y + Math.sin(p.dummy.angle) * 54, angle: p.dummy.angle, weapon: weaponType, type: 'dagger_qte_hit', progress: 0, timestamp: now + (cfg.perfectMs || 560), lifetime: 360 });
    return;
  }
  if (weaponType === 'spear' && cfg === SkillConfig.spear) {
    _previewSpearThrow(p, cfg, now);
    return;
  }
  if (weaponType === 'harpoon' && cfg === SkillConfig.harpoon) {
    _previewFire(p, weaponType, { type: 'projectile', projectileKind: 'harpoon', projectileWeapon: weaponType, speed: 760, range: cfg.pullRange || 360, damage: Weapons.harpoon?.damage || 16 }, now);
    return;
  }
  if (weaponType === 'pistols' && cfg === SkillConfig.pistols) {
    _previewProjectileFan(p, weaponType, { ...cfg, projectileKind: 'pistol', projectileWeapon: 'pistols' }, base, now);
    return;
  }
  _previewFire(p, weaponType, {
    ...base,
    type: cfg.type || base.type || 'melee_arc',
    range: cfg.range || base.range,
    width: cfg.width || base.width,
    innerRange: cfg.innerRange || base.innerRange,
    angle: cfg.angle || base.angle,
    damage: cfg.damage || base.damage
  }, now, { finisher: false, lifetime: 560 });
}

function _previewStrongAttack(p, weaponType, base, now) {
  const finisher = ComboConfig[weaponType]?.finisher;
  if (!finisher) return;
  _previewFire(p, weaponType, {
    ...base,
    ...finisher,
    cooldown: finisher.cooldown || base.cooldown
  }, now, { finisher: true, lifetime: weaponType === 'sword' ? 940 : 700 });
}

function _previewSwordSkill(p, now) {
  const sk = SkillConfig.sword;
  const base = Weapons.sword;
  _previewFire(p, 'sword', { ...base, type: 'melee_circle', angle: 360, range: 78, damage: base.damage }, now, { finisher: true, lifetime: 760 });
  const count = Math.max(1, sk.waveCount || 3);
  const interval = Math.max(0, sk.waveIntervalMs || 250);
  for (let i = 0; i < count; i++) {
    const fire = releaseNow => _previewFire(p, 'sword', {
      type: 'projectile',
      projectileKind: 'swordwave',
      projectileWeapon: 'sword',
      speed: sk.waveSpeed || 800,
      range: Infinity,
      damage: sk.directDamage || 24
    }, releaseNow);
    const delay = interval * i;
    if (delay > 0) _previewDelay(p, now + delay, fire);
    else fire(now);
  }
}

function _previewSpearThrow(p, cfg, now) {
  const d = p.dummy;
  const windup = 240;
  p.effects.push({
    attackerId: 'preview',
    x: d.x,
    y: d.y,
    angle: d.angle,
    weapon: 'spear',
    type: 'spear_windup',
    progress: 0,
    timestamp: now,
    lifetime: windup
  });
  _previewDelay(p, now + windup, releaseNow => {
    const dirX = Math.cos(d.angle);
    const dirY = Math.sin(d.angle);
    const dist = p.MAP * 0.46;
    const endX = d.x + dirX * dist;
    const endY = d.y + dirY * dist;
    p.effects.push({
      id: `preview-spear-rail-${releaseNow}`,
      attackerId: 'preview',
      x: d.x,
      y: d.y,
      x2: endX,
      y2: endY,
      angle: d.angle,
      weapon: 'spear',
      type: 'railbeam',
      progress: 0,
      timestamp: releaseNow,
      lifetime: 260
    });
    const proj = new Projectile(
      `preview-thrownspear-${releaseNow}`,
      'preview',
      endX,
      endY,
      d.angle + Math.PI,
      cfg.returnSpeed || 760,
      Infinity,
      cfg.returnDamage || cfg.damage || 35,
      'thrownspear'
    );
    proj.weapon = 'spear';
    p.projectiles.push(proj);
  });
}

function _previewGreatswordChargeStart(p, now) {
  if (p.greatswordCharge) return;
  const sk = SkillConfig.greatsword;
  const chargeId = `${now}-${Math.random()}`;
  p.greatswordCharge = { startedAt: now, id: chargeId, releaseAt: now + (sk.chargeMaxMs || 1000) };
  p.effects.push({
    attackerId: 'preview',
    x: p.dummy.x,
    y: p.dummy.y,
    angle: p.dummy.angle,
    weapon: 'greatsword',
    type: 'greatsword_charge',
    range: sk.range,
    angleDeg: sk.angle,
    progress: 0,
    timestamp: now,
    lifetime: (sk.chargeMaxMs || 1000) + 120
  });
  _previewDelay(p, now + (sk.chargeMaxMs || 1000), releaseNow => {
    if (p.greatswordCharge?.id !== chargeId) return;
    _previewGreatswordChargeRelease(p, releaseNow);
  });
}

function _previewAutoReleaseGreatsword(p, now) {
  const charge = p.greatswordCharge;
  if (!charge || p.weaponType !== 'greatsword') return;
  if (now >= charge.releaseAt) _previewGreatswordChargeRelease(p, now);
}

function _previewGreatswordChargeRelease(p, now) {
  if (!p.greatswordCharge) return;
  const sk = SkillConfig.greatsword;
  const held = Math.max(0, now - p.greatswordCharge.startedAt);
  p.greatswordCharge = null;
  const chargeT = Math.min(1, held / (sk.chargeMaxMs || 1000));
  _previewFire(p, 'greatsword', {
    ...Weapons.greatsword,
    type: 'melee_heavy_arc',   // same effect the in-game charged release renders
    range: (sk.range || 128) * (0.38 + 0.62 * chargeT),
    angle: sk.angle || 210,
    bladeHalfWidth: sk.bladeHalfWidth,
    damage: chargeT >= 1 ? sk.damage : (chargeT >= (sk.chargeThreshold || 0.5) ? sk.thresholdDamage : sk.minDamage)
  }, now, { finisher: true, lifetime: 780 });
}

function _previewGreatswordChargeTap(p, now) {
  _previewGreatswordChargeStart(p, now);
}

function _previewKatanaIaijutsu(p, now) {
  const sk = SkillConfig.katana;
  const chargeMs = sk.iaijutsuChargeMs || 1000;
  p.effects.push({
    attackerId: 'preview',
    x: p.dummy.x,
    y: p.dummy.y,
    angle: p.dummy.angle,
    weapon: 'katana',
    type: 'katana_charge',
    range: sk.iaijutsuRange || 150,
    width: sk.iaijutsuWidth || 40,
    progress: 0,
    timestamp: now,
    lifetime: chargeMs
  });
  _previewDelay(p, now + chargeMs, releaseNow => {
    p.effects.push({
      attackerId: 'preview',
      x: p.dummy.x,
      y: p.dummy.y,
      angle: p.dummy.angle,
      weapon: 'katana',
      type: 'melee_heavy_line',
      range: sk.iaijutsuRange || 150,
      width: sk.iaijutsuWidth || 40,
      isSkill: true,
      progress: 0,
      timestamp: releaseNow,
      lifetime: 420
    });
  });
}

function _previewReleasePending(p, now) {
  if (p.pendingPreviewActions.length) {
    const waiting = [];
    for (const action of p.pendingPreviewActions) {
      if (action.releaseAt > now) { waiting.push(action); continue; }
      action.run(now);
    }
    p.pendingPreviewActions = waiting;
  }
  if (p.pendingSniperShots.length) {
    const waiting = [];
    for (const shot of p.pendingSniperShots) {
      if (shot.releaseAt > now) { waiting.push(shot); continue; }
      _previewSniperBeam(p, now, shot);
    }
    p.pendingSniperShots = waiting;
  }
  if (p.pendingMagicShards.length) {
    const waiting = [];
    for (const shard of p.pendingMagicShards) {
      if (shard.releaseAt > now) { waiting.push(shard); continue; }
      _previewMagicShard(p, now, shard.sequence);
    }
    p.pendingMagicShards = waiting;
  }
}

function _previewDelay(p, releaseAt, run) {
  p.pendingPreviewActions.push({ releaseAt, run });
}

function _previewSniperShot(p, now) {
  const d = p.dummy;
  const telegraphMs = Math.max(0, SkillConfig.sniper?.telegraphMs ?? 500);
  p.pendingSniperShots.push({ releaseAt: now + telegraphMs, weapon: 'sniper', range: Infinity });
  p.effects.push({
    id: `preview-snipertelegraph-${now}`,
    attackerId: 'preview',
    x: d.x, y: d.y,
    angle: d.angle,
    beamDist: p.MAP,
    weapon: 'sniper',
    type: 'sniper_telegraph',
    progress: 0,
    timestamp: now,
    lifetime: telegraphMs
  });
}

function _previewSniperBeam(p, now, shot = {}) {
  const d = p.dummy;
  const dist = Number.isFinite(shot.range) ? shot.range : p.MAP * 0.48;
  const weapon = shot.weapon || 'sniper';
  p.effects.push({
    id: `preview-railbeam-${weapon}-${now}`,
    attackerId: 'preview',
    x: d.x, y: d.y,
    x2: d.x + Math.cos(d.angle) * dist,
    y2: d.y + Math.sin(d.angle) * dist,
    angle: d.angle,
    weapon,
    type: 'railbeam',
    progress: 0,
    timestamp: now,
    lifetime: 320
  });
}

function _previewProjectileFan(p, weaponType, cfg, base, now, fallbackKind = null) {
  const count = Math.max(1, cfg.count || cfg.waveCount || cfg.fanCount || cfg.burstCount || 1);
  const spread = ((cfg.spreadDeg || cfg.fanSpreadDeg || 0) * Math.PI) / 180;
  for (let i = 0; i < Math.min(count, 10); i++) {
    const t = count <= 1 ? 0 : (i / (count - 1)) - 0.5;
    const delay = cfg.burstMs && count > 1 ? (cfg.burstMs / (count - 1)) * i : i;
    const fire = releaseNow => _previewFire(p, weaponType, {
      ...base,
      type: 'projectile',
      projectileKind: cfg.projectileKind || fallbackKind || (weaponType === 'sword' || weaponType === 'katana' ? 'swordwave' : 'arrow'),
      projectileWeapon: cfg.projectileWeapon || weaponType,
      speed: cfg.speed || cfg.waveSpeed || cfg.throwSpeed || 680,
      range: cfg.range || cfg.pullRange || base.range || 280,
      damage: cfg.damage || cfg.directDamage || base.damage || 1,
      radius: cfg.radius,
      previewAngleOffset: t * spread
    }, releaseNow);
    if (delay > 0) _previewDelay(p, now + delay, fire);
    else fire(now);
  }
}

function _previewAimedShot(p, cfg, now) {
  const windup = Math.max(0, cfg.windupMs || 400);
  p.pendingSniperShots.push({ releaseAt: now + windup, weapon: 'pistols', range: cfg.range || 520 });
  p.effects.push({
    id: `preview-aimed-${now}`,
    attackerId: 'preview',
    x: p.dummy.x,
    y: p.dummy.y,
    angle: p.dummy.angle,
    beamDist: cfg.range || 520,
    weapon: 'pistols',
    type: 'matchlock_telegraph',
    progress: 0,
    timestamp: now,
    lifetime: windup
  });
}

// R: 3개 검을 120도 부채꼴(-60°/0°/+60°)로 발사.
function _previewGuardianLaunch(p, cfg, now) {
  const sk = SkillConfig.guardian;
  for (let i = 0; i < 3; i++) {
    const offset = (i - 1) * (Math.PI / 3); // -60°, 0°, +60°
    _previewFire(p, 'guardian', {
      type: 'projectile',
      projectileKind: 'guardianlaunch',
      projectileWeapon: 'guardian',
      speed: sk.launchSpeed || 560,
      range: sk.launchRange || 200,
      damage: sk.launchDamage || 24,
      previewAngleOffset: offset
    }, now + i);
  }
}

function _previewGuardianHoming(p, cfg, now) {
  const sk = SkillConfig.guardian;
  _previewFire(p, 'guardian', {
    type: 'projectile',
    projectileKind: 'guardiandart',
    projectileWeapon: 'guardian',
    speed: sk.homingSpeed || 360,
    range: 260,
    damage: sk.homingDamage || 14
  }, now);
}

function _previewExplosion(p, weaponType, cfg, now, distance = 0) {
  const d = p.dummy;
  p.effects.push({
    attackerId: 'preview',
    x: d.x + Math.cos(d.angle) * distance,
    y: d.y + Math.sin(d.angle) * distance,
    weapon: weaponType,
    type: cfg.type === 'mine_blast' ? 'mine_blast' : 'explosion',
    radius: cfg.radius || cfg.blastRadius || cfg.range || 55,
    range: cfg.radius || cfg.blastRadius || cfg.range || 55,
    progress: 0,
    timestamp: now,
    lifetime: 420
  });
}

function _previewPlaceMine(p, cfg, now) {
  p.mines.push({
    id: `preview-mine-${now}`,
    ownerId: 'preview',
    x: p.dummy.x,
    y: p.dummy.y + 32,
    armAt: now + (SkillConfig.minebag?.armMs || 1000),
    expireAt: now + 2600
  });
}

function _previewTracerMine(p, cfg, now) {
  const d = p.dummy;
  const x = d.x + Math.cos(d.angle) * 72;
  const y = d.y + Math.sin(d.angle) * 72;
  p.mines.push({
    id: `preview-tracer-${now}`,
    ownerId: 'preview',
    tracer: true,
    x,
    y,
    armAt: now,
    expireAt: now + (SkillConfig.minebag?.tracerFuseMs || 2000)
  });
  p.effects.push({ attackerId: 'preview', x, y, weapon: 'minebag', type: 'mine_blast', range: SkillConfig.minebag?.blastRadius || 60, progress: 0, timestamp: now + (SkillConfig.minebag?.tracerFuseMs || 2000), lifetime: 460 });
}

function _previewDodgeReload(p, cfg, now) {
  const d = p.dummy;
  d.dashDirX = Math.cos(d.angle);
  d.dashDirY = Math.sin(d.angle);
  d.dashTimeLeft = 0.18;
  p.effects.push({ attackerId: 'preview', x: d.x, y: d.y, weapon: 'pistols', type: 'buff_activate', buffType: 'pistol_reload', progress: 0, timestamp: now, lifetime: 520 });
}

function _previewMagicFireball(p, now) {
  const cfg = MagicConfig.fireball;
  _previewFire(p, 'magicstaff', {
    type: 'projectile',
    projectileKind: 'fireball',
    projectileWeapon: 'magicstaff',
    speed: cfg.speed,
    range: Infinity,
    damage: cfg.damage,
    radius: cfg.radius
  }, now);
}

function _previewMagicLifebound(p, now) {
  const cfg = MagicConfig.lifebound;
  p.dummy.hp = Math.min(p.dummy.maxHp, p.dummy.hp + (cfg.heal || 25));
  p.effects.push({
    attackerId: 'preview',
    x: p.dummy.x,
    y: p.dummy.y,
    weapon: 'magicstaff',
    type: 'lifebound_heal',
    progress: 0,
    timestamp: now,
    lifetime: 620
  });
}

function _previewMagicIce(p, now) {
  const cfg = MagicConfig.iceShard;
  const count = Math.max(1, Math.floor(cfg.count || 4));
  const interval = Math.max(0, cfg.intervalMs || 0);
  p.dummy.pendingIcicles = count;
  p.effects.push({
    attackerId: 'preview',
    x: p.dummy.x + Math.cos(p.dummy.angle) * 120,
    y: p.dummy.y + Math.sin(p.dummy.angle) * 120,
    weapon: 'magicstaff',
    type: 'icicle_load',
    worldAnchored: true,
    progress: 0,
    timestamp: now,
    lifetime: Math.max(260, interval * count)
  });
  for (let i = 0; i < count; i++) {
    p.pendingMagicShards.push({ releaseAt: now + interval * i, sequence: i });
  }
}

function _previewMagicShard(p, now, sequence = 0) {
  const cfg = MagicConfig.iceShard;
  const d = p.dummy;
  const count = Math.max(1, Math.floor(cfg.count || 4));
  const off = (sequence - (count - 1) / 2) * 11;
  const a = d.angle;
  const ux = Math.cos(a), uy = Math.sin(a);
  const spawnDist = d.radius + 4;
  const proj = new Projectile(
    `preview-iceshard-${now}-${sequence}`,
    'preview',
    d.x + ux * spawnDist - uy * off,
    d.y + uy * spawnDist + ux * off,
    a,
    cfg.speed,
    Infinity,
    cfg.damage,
    'iceshard'
  );
  proj.weapon = 'magicstaff';
  proj.radius = cfg.radius;
  p.projectiles.push(proj);
  p.dummy.pendingIcicles = Math.max(0, (p.dummy.pendingIcicles || 0) - 1);
  p.effects.push({
    attackerId: 'preview',
    x: d.x,
    y: d.y,
    angle: a,
    weapon: 'magicstaff',
    type: 'projectile_shot',
    projectileKind: 'iceshard',
    progress: 0,
    timestamp: now,
    lifetime: 200
  });
}

function _previewFire(p, weaponType, wc, now, options = {}) {
  const d = p.dummy;
  if (wc.type === 'projectile') {
    const kind = wc.projectileKind || 'arrow';
    const angle = d.angle + (wc.previewAngleOffset || 0);
    if (kind !== 'chakram') {
      p.effects.push({ attackerId: 'preview', x: d.x, y: d.y, angle, weapon: weaponType,
        type: 'projectile_shot', projectileKind: kind, progress: 0, timestamp: now, lifetime: 220 });
    }
    const proj = new Projectile(`prev-${now}-${p.projectiles.length}`, 'preview', d.x + Math.cos(angle) * 18, d.y + Math.sin(angle) * 18,
      angle, wc.speed || 600, wc.range || 300, wc.damage || 1, kind);
    proj.weapon = wc.projectileWeapon || weaponType;
    if (Number.isFinite(wc.radius)) proj.radius = wc.radius;
    if (kind === 'chakram') {
      proj.maxRange = 130; // cap so the full arc stays within the 400px preview canvas at zoom 1.5
      const ownerX = d.x, ownerY = d.y;
      let phase = 'out';
      proj.update = function(dt) {
        if (this.isDead) return;
        if (phase === 'out') {
          this.x += this.vx * dt;
          this.y += this.vy * dt;
          if (Math.hypot(this.x - this.startX, this.y - this.startY) >= this.maxRange) phase = 'return';
        } else {
          const dx = ownerX - this.x, dy = ownerY - this.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 18) { this.isDead = true; return; }
          const s = 720 / dist;
          this.x += dx * s * dt;
          this.y += dy * s * dt;
          this.angle = Math.atan2(dy, dx);
        }
      };
    }
    p.projectiles.push(proj);
  } else {
    p.swing = -p.swing;
    p.effects.push({ attackerId: 'preview', x: d.x, y: d.y, angle: d.angle, weapon: weaponType, buffType: null,
      type: wc.type || 'melee_arc', range: wc.range, width: wc.width, innerRange: wc.innerRange, angleDeg: wc.angle,
      comboStep: 0, comboCycle: 0, comboFinisher: Boolean(options.finisher), swingDirection: p.swing,
      progress: 0, timestamp: now, lifetime: options.lifetime || 420 });
  }
}

function renderSkillPreview(skillText = '') {
  return String(skillText || '').split('\n').filter(Boolean).map(line => {
    const match = line.match(/^(F|R|LMB):(.*)$/);
    if (!match) {
      return `<div class="skill-preview-line skill-preview-line-plain"><span class="skill-preview-body">${highlightSkillValues(line)}</span></div>`;
    }
    const key = match[1];
    return [
      '<div class="skill-preview-line">',
      `<span class="skill-preview-label skill-preview-label-${key.toLowerCase()}">${key}:</span>`,
      `<span class="skill-preview-body">${highlightSkillValues(match[2].trimStart())}</span>`,
      '</div>'
    ].join('');
  }).join('');
}

function highlightSkillValues(text) {
  return escapeHtml(text).replace(
    /([+-]?\d+(?:\.\d+)?(?:\/[+-]?\d+(?:\.\d+)?)*(?:\/s)?(?:\s?(?:초|ms|px|도|%|배|개|발))?|∞|벽까지)/g,
    '<span class="skill-preview-value">$1</span>'
  );
}

function formatSpeedRatio(value) {
  const ratio = Number.isFinite(value) ? value : 1;
  return `${Number.isInteger(ratio) ? ratio.toFixed(0) : ratio.toFixed(1)}x`;
}

/**
 * 2. Room codes validation (letters, numbers only)
 */
[hostRoomInput, joinRoomInput].forEach(inp => {
  inp.addEventListener('input', () => {
    inp.value = inp.value.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    hideError();
  });
});

nicknameInput.addEventListener('input', () => {
  nicknameInput.value = nicknameInput.value.replace(/[^\p{L}\p{N}_ -]/gu, '');
  hideError();
});

function showError(msg) {
  statusMsg.textContent = msg;
  statusMsg.classList.remove('hidden');
}

function hideError() {
  statusMsg.classList.add('hidden');
}

/**
 * 3. Room custom modal — arena size / storm / cover / healing.
 * Segmented option groups: clicking a button selects it within its group.
 */
let roomCustomMode = 'host';
function activeRoomConfigRoot() {
  return document.querySelector('[data-room-config-root="active"]') || roomCustomModal;
}

function activeRoomConfigState() {
  const raw = activeRoomConfigRoot()?.dataset.roomConfigState;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
function openRoomCustom(mode = 'host') {
  if (!roomCustomModal) return;
  // The modal is declared inside the legacy lobby panel, which can be hidden
  // while the current hub is active. Move it to the app root before showing so
  // Quick Play/Create always exposes real clickable controls.
  if (roomCustomModal.parentElement !== document.body) document.body.appendChild(roomCustomModal);
  roomCustomMode = mode === 'quickplay' ? 'quickplay' : 'host';
  hideError();
  if (roomCustomTitle) roomCustomTitle.textContent = roomCustomMode === 'quickplay' ? '바로 플레이 커스텀' : '방 커스텀';
  roomCodeRow?.classList.toggle('hidden', roomCustomMode === 'quickplay');
  botCountRow?.classList.toggle('hidden', roomCustomMode !== 'quickplay');
  hostBtn?.classList.toggle('hidden', roomCustomMode === 'quickplay');
  dummyBtn?.classList.toggle('hidden', roomCustomMode === 'quickplay');
  quickStartBtn?.classList.toggle('hidden', roomCustomMode !== 'quickplay');
  roomCustomModal.classList.remove('hidden');
  // Prefill the room code from whatever the user may have typed before.
  const codeInput = document.getElementById('hostRoomInput');
  if (codeInput && !codeInput.value && roomCustomMode !== 'quickplay') codeInput.focus();
}
function closeRoomCustom() {
  if (roomCustomModal) roomCustomModal.classList.add('hidden');
  emitLobbyTutorialEvent('roomCustomClosed');
}

if (openRoomCustomBtn) openRoomCustomBtn.addEventListener('click', () => openRoomCustom('host'));
if (roomCustomClose) roomCustomClose.addEventListener('click', closeRoomCustom);
if (roomCustomModal) roomCustomModal.addEventListener('click', (e) => {
  if (e.target === roomCustomModal) closeRoomCustom(); // tap backdrop = cancel
});

// Segmented-group selection: one active option per [data-config-group].
if (roomCustomModal) roomCustomModal.addEventListener('click', (e) => {
  const opt = e.target.closest('.cfg-opt');
  if (!opt) return;
  const group = opt.closest('[data-config-group]');
  if (!group) return;
  group.querySelectorAll('.cfg-opt').forEach(b => b.classList.toggle('selected', b === opt));
  // Healing rate row only matters when healing is ON.
  if (group.dataset.configGroup === 'healing' && healingRateRow) {
    healingRateRow.classList.toggle('hidden', opt.dataset.value !== 'on');
  }
});

/** Read the currently selected room settings out of the modal. */
function readRoomConfig() {
  const root = activeRoomConfigRoot();
  const state = activeRoomConfigState();
  const pick = (group, fallback) => {
    if (state[group] != null) return state[group];
    const el = root?.querySelector(`[data-config-group="${group}"] .cfg-opt.selected`)
      || root?.querySelector(`.create-pill.on[data-g="${group}"]`);
    return el ? el.dataset.value : fallback;
  };
  return normalizeRoomConfig({
    arenaSize: pick('arenaSize', 'medium'),
    storm: false,
    cover: pick('cover', 'none'),
    platforms: pick('platforms', 'some'),
    platformShape: pick('platformShape', 'balanced'),
    healing: pick('healing', 'off') === 'on',
    healingRate: pick('healingRate', 'normal'),
    allowWorkshop: true,
  });
}

function readBotCount() {
  const root = activeRoomConfigRoot();
  const raw = activeRoomConfigState().botCount
    || root?.querySelector('[data-config-group="botCount"] .cfg-opt.selected')?.dataset.value
    || root?.querySelector('.create-pill.on[data-g="botCount"]')?.dataset.value;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.round(n))) : 3;
}

function readBotDifficulty() {
  const root = activeRoomConfigRoot();
  const raw = activeRoomConfigState().botDifficulty
    || root?.querySelector('[data-config-group="botDifficulty"] .cfg-opt.selected')?.dataset.value
    || root?.querySelector('.create-pill.on[data-g="botDifficulty"]')?.dataset.value
    || 'normal';
  return ['easy', 'normal', 'hard'].includes(raw) ? raw : 'normal';
}

// The local player's full appearance: equipped costume colors + the cosmetic
// loadout (weapon skin / kill fx / dash trail / respawn fx / title). Passed to
// Game and into JOIN_ROOM so everyone renders it.
function attachLocalWorkshopImagePayload(workshopWeapon) {
  if (!workshopWeapon) return workshopWeapon;
  const imageId = workshopWeapon?.weaponVisual?.imageId;
  const weaponImage = getCustomWeaponRecord(imageId);
  if (workshopWeapon && weaponImage) workshopWeapon.weaponImage = weaponImage;
  const offhandId = workshopWeapon?.weaponVisual?.offhand?.imageId;
  const offhandImage = getCustomWeaponRecord(offhandId);
  if (workshopWeapon && offhandImage) workshopWeapon.offhandImage = offhandImage;
  const hatId = workshopWeapon?.weaponVisual?.hat?.imageId;
  const hatImage = getCustomWeaponRecord(hatId);
  if (workshopWeapon && hatImage) workshopWeapon.hatImage = hatImage;
  const hats = Array.isArray(workshopWeapon?.weaponVisual?.hats) ? workshopWeapon.weaponVisual.hats.slice(0, 5) : [];
  const hatImages = hats.map(h => getCustomWeaponRecord(h?.imageId)).filter(Boolean);
  if (workshopWeapon && hatImages.length) workshopWeapon.hatImages = hatImages;
  const effectIds = new Set();
  for (const motion of Object.values(workshopWeapon?.motionSet || {})) {
    for (const fx of (Array.isArray(motion?.effects) ? motion.effects : [])) {
      if (fx?.assetId && String(fx.assetId).startsWith('custom:fx_')) effectIds.add(fx.assetId);
    }
  }
  for (const preset of Object.values(workshopWeapon?.presets || {})) {
    for (const fx of (Array.isArray(preset?.effects) ? preset.effects : [])) {
      if (fx?.assetId && String(fx.assetId).startsWith('custom:fx_')) effectIds.add(fx.assetId);
    }
  }
  const effectImages = [...effectIds].map(id => getCustomWeaponRecord(id)).filter(Boolean);
  if (workshopWeapon && effectImages.length) workshopWeapon.effectImages = effectImages;
  return workshopWeapon;
}

async function workshopWeaponAccountPayload(raw) {
  const payload = attachLocalWorkshopImagePayload(JSON.parse(JSON.stringify(raw || {})));
  const shrinkField = async (field, budget) => {
    if (!payload?.[field]?.src) return;
    const src = await shrinkDataUrlToBudget(payload[field].src, budget);
    payload[field] = { ...payload[field], src };
  };
  await shrinkField('weaponImage', WEAPON_IMAGE_BUDGET);
  await shrinkField('offhandImage', WEAPON_IMAGE_BUDGET);
  await shrinkField('hatImage', Math.floor(WEAPON_IMAGE_BUDGET / 5));
  if (Array.isArray(payload.hatImages)) {
    payload.hatImages = await Promise.all(payload.hatImages.slice(0, 5).map(async img => img?.src
      ? { ...img, src: await shrinkDataUrlToBudget(img.src, Math.floor(WEAPON_IMAGE_BUDGET / 5)) }
      : img));
  }
  if (Array.isArray(payload.effectImages)) {
    payload.effectImages = await Promise.all(payload.effectImages.slice(0, 24).map(async img => img?.src
      ? { ...img, src: await shrinkDataUrlToBudget(img.src, Math.floor(WEAPON_IMAGE_BUDGET / 5)) }
      : img));
  }
  return payload;
}

// The local player's full appearance: equipped costume colors + the cosmetic
// loadout (weapon skin / kill fx / dash trail / respawn fx / title). Passed to
// Game and into JOIN_ROOM so everyone renders it.
function localAppearance() {
  const workshopWeapon = attachLocalWorkshopImagePayload(equippedWorkshopWeapon());
  return Object.assign({}, accountUI.getEquippedCostume() || {}, {
    cosmetics: accountUI.getEquippedCosmetics(),
    motionSetId: equippedMotionSetId(),   // equipped custom stickman motion (cosmetic, id only)
    stick: equippedStickLook(),           // stick appearance (color/lineW/head/accessory)
    workshopWeapon,                       // equipped Tier-2 workshop weapon (envelope-clamped + image pixels)
  });
}

async function networkAppearance() {
  const appearance = localAppearance();
  if (!appearance.workshopWeapon) return appearance;
  return {
    ...appearance,
    workshopWeapon: await workshopWeaponAccountPayload(appearance.workshopWeapon),
  };
}

function runtimeWorkshopWeaponForBot(raw) {
  try {
    const rt = v2ToV1Runtime(toWorkshopWeaponV2(raw));
    if (!rt || !rt.stats || !rt.motionSet) return null;
    const imageId = rt.weaponVisual?.imageId || raw?.weaponVisual?.imageId;
    const weaponImage = raw?.weaponImage || getCustomWeaponRecord(imageId);
    if (weaponImage) rt.weaponImage = weaponImage;
    const offhandId = rt.weaponVisual?.offhand?.imageId || raw?.weaponVisual?.offhand?.imageId;
    const offhandImage = raw?.offhandImage || getCustomWeaponRecord(offhandId);
    if (offhandImage) rt.offhandImage = offhandImage;
    const hatId = rt.weaponVisual?.hat?.imageId || raw?.weaponVisual?.hat?.imageId;
    const hatImage = raw?.hatImage || getCustomWeaponRecord(hatId);
    if (hatImage) rt.hatImage = hatImage;
    const hats = Array.isArray(rt.weaponVisual?.hats) ? rt.weaponVisual.hats.slice(0, 5) : [];
    const localHatImages = hats.map(h => getCustomWeaponRecord(h?.imageId)).filter(Boolean);
    if (Array.isArray(raw?.hatImages) && raw.hatImages.length) rt.hatImages = raw.hatImages.slice(0, 5);
    else if (localHatImages.length) rt.hatImages = localHatImages;
    if (Array.isArray(raw?.effectImages)) rt.effectImages = raw.effectImages.slice(0, 24);
    const hasVisual = Boolean(rt.weaponVisual?.imageId || rt.weaponImage || rt.offhandImage);
    const hasAuthoredAttack = Boolean(
      rt.ranged ||
      rt.blocks ||
      rt.motionSet?.attack?.projectileEvents?.length ||
      rt.motionSet?.attack?.teleportEvents?.length ||
      rt.motionSet?.attack?.hitboxes?.length
    );
    if (!hasVisual && !hasAuthoredAttack) return null;
    return rt;
  } catch {
    return null;
  }
}

async function loadBotWorkshopWeapons() {
  let items = [];
  try {
    items = await accountUI.browseWorkshopWeapons?.('likes', 80) || [];
  } catch {}
  if (!items.length) {
    try { items = loadWorkshopWeaponsV2(); } catch { items = []; }
  }
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const rt = runtimeWorkshopWeaponForBot(raw);
    if (!rt) continue;
    const key = rt.id || `${rt.name}:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rt);
  }
  return out;
}

/**
 * 3. Match Hosting workflow
 */
async function doHost(dummy = false, triggerBtn = null) {
  const nickname = nicknameInput.value.trim();
  const roomCode = hostRoomInput.value.trim();
  const btn = triggerBtn || (dummy ? dummyBtn : hostBtn);
  const idleLabel = dummy ? '더미방 생성' : '방 생성';
  const roomConfig = readRoomConfig();

  if (!nickname) {
    showError('방을 만들기 전에 닉네임을 입력해 주세요.');
    return;
  }
  if (!roomCode || roomCode.length < 3) {
    showError('방 코드는 최소 3글자 이상이어야 합니다.');
    return;
  }

  hideError();
  closeRoomCustom();
  if (btn) { btn.disabled = true; btn.textContent = dummy ? '연습장 준비 중...' : '서버 연결 중...'; }

  netManager = new NetworkManager({ getAuthToken: accountUI.getAuthToken });

  netManager.on('onError', (err) => {
    if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
    showError(err);
    netManager.stop();
  });

  const chosenWeapon = document.querySelector('.weapon-card.selected')?.dataset.weapon || 'sword';

  if (dummy) {
    // 더미방 = OFFLINE practice: the browser is its own authoritative host and
    // spawns training dummies. No server involved (LocalTransport → onInit).
    netManager.on('onInit', () => {
      if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
      enterGameScreen(true);
      activeGame = new Game(gameCanvas, netManager, localAppearance(), { dummyRoom: true, roomConfig });
      activeGame.start((stats) => handleMatchEnd(stats));
    });
    netManager.hostLocal(roomCode);
    return;
  }

  // A real online room: create it ON THE SERVER by being the first to join. The
  // server is authoritative, so we join as a GUEST; the creator carries the
  // arena settings in its payload for the server to build the room with.
  let appearance;
  try {
    appearance = await networkAppearance();
  } catch {
    appearance = localAppearance();
  }
  const joinPayload = Protocol.joinRoom(nickname, chosenWeapon, appearance, isMobileDevice(), readControls());
  joinPayload.roomConfig = roomConfig;

  netManager.on('onConnected', () => {
    if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
    enterGameScreen(false);   // guest render path — the server drives the sim
    activeGame = new Game(gameCanvas, netManager, localAppearance(), { roomConfig });
    activeGame.start((stats) => handleMatchEnd(stats));
  });

  netManager.hostRoom(roomCode, joinPayload);
}

hostBtn.addEventListener('click', () => doHost(false));
if (dummyBtn) dummyBtn.addEventListener('click', () => doHost(true));

/**
 * One-click bot match: an offline, host-only fight against AI bots. No room
 * code, no lobby wait, no MQTT/PeerJS broker — NetworkManager.hostLocal() makes
 * us the authoritative host with no signaling peer. Defaults to a punchy small
 * arena with the storm + healing on so the game's hooks show fast.
 */
async function doBotMatch(triggerBtn = null) {
  let nickname = nicknameInput.value.trim();
  if (!nickname) { nickname = '용사'; nicknameInput.value = nickname; }

  // Read every quick-play control while its module is still mounted. Closing
  // the module removes the active room-config root, which used to make bot
  // matches silently fall back to defaults.
  const demoConfig = normalizeRoomConfig({
    ...readRoomConfig(),
    arenaSize: 'medium',
    storm: false,
    allowWorkshop: true
  });
  const botCount = readBotCount();
  const botDifficulty = readBotDifficulty();

  hideError();
  closeRoomCustom();
  const btn = triggerBtn || document.getElementById('quickPlayBtn');
  const startBtn = document.getElementById('quickStartBtn');
  const btnIdleHtml = btn?.innerHTML || '봇전 시작';
  if (btn) { btn.disabled = true; btn.textContent = '전장 준비 중...'; }
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '전장 준비 중...'; }

  const botWorkshopWeapons = await loadBotWorkshopWeapons();

  netManager = new NetworkManager({ getAuthToken: accountUI.getAuthToken });
  netManager.on('onInit', () => {
    if (btn) { btn.disabled = false; btn.innerHTML = btnIdleHtml; }
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '봇전 시작'; }
    enterGameScreen(true);
    activeGame = new Game(gameCanvas, netManager, localAppearance(), {
      botMatch: true, botCount, botDifficulty, botWorkshopWeapons, roomConfig: demoConfig,
      matchDurationMs: 120000, killTarget: 12,
      holdAtStart: true, // frozen behind the controls card; 시작하기 → 3·2·1 (P2)
      onMatchOver: (results) => showMatchResult(results)
    });
    activeGame.start((stats) => handleMatchEnd(stats));
    showOnboardCard('🎯 목표 — 2분 안에 최다 킬! (먼저 12킬 시 즉시 승리)');
    // If the card can't show (missing DOM), never leave the match frozen.
    if (!document.getElementById('onboardCard')) activeGame.releaseMatchHold?.();
  });
  netManager.on('onError', (err) => {
    if (btn) { btn.disabled = false; btn.innerHTML = btnIdleHtml; }
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '봇전 시작'; }
    showError(err);
    netManager.stop();
  });
  netManager.hostLocal('SOLO');
}

const quickPlayBtn = document.getElementById('quickPlayBtn');
if (quickPlayBtn) quickPlayBtn.addEventListener('click', () => {
  if (typeof window.openLobbyModule === 'function') window.openLobbyModule('quickplay');
  else openRoomCustom('quickplay');
});
if (quickStartBtn) quickStartBtn.addEventListener('click', () => doBotMatch());

// --- Stickman motion sets ------------------------------------------------------
// Cosmetic motion sets from localStorage. The admin-canonical Firestore layer
// (weapon_motions fetch/save + its cache) was removed with the admin motion
// workshop: 검/대검 motions are baked into Motion.js, and workshop weapons carry
// their own motion sets (distributed per match via ROOM_JOINED).
loadStoredMotionSets();

let motionEditor = null;
function ensureMotionEditor() {
  if (motionEditor) return motionEditor;
  motionEditor = new MotionEditor();
  // Upload (NOT save) → publish to the shared catalog. Throws on failure so the
  // editor can report it; the local save/equip already happened and is untouched.
  motionEditor.onUploadWorkshop = async (def) => {
    if (!accountUI.publishMyWorkshopWeapon) throw new Error('로그인이 필요합니다');
    return accountUI.publishMyWorkshopWeapon(def);
  };
  // Keep the workshop grid + armory in sync after a local save.
  motionEditor.onWorkshopSaved = (weapon) => {
    if (_wsGridEl && !_wsGridEl.classList.contains('hidden')) renderWorkshopGrid();
    document.querySelector('#armoryBody')?._armoryRefresh?.();
    if (weapon && accountUI.saveMyPrivateWorkshopWeapon) {
      workshopWeaponAccountPayload(weapon)
        .then(payload => accountUI.saveMyPrivateWorkshopWeapon(payload))
        .catch(err => console.warn('[workshop] private account save failed', err));
    }
  };
  return motionEditor;
}
// Shop 🔧 워크샵 tab: browse/equip other players' workshop weapons in the shop.
accountUI.setWorkshopTabRenderer?.((el) => renderWorkshopList(el));

// Workshop weapon creator (all users) — opens the SAVED WEAPON GRID first
// (첫 칸 = 새 무기 만들기, 나머지 = 저장된 공방 무기). Editing a specific saved
// weapon is also routed here from the armory via pendingWorkshopEditId.
const workshopBtn = document.getElementById('workshopBtn');
if (workshopBtn) workshopBtn.addEventListener('click', () => {
  Sound.play('ui');
  if (pendingWorkshopEditId) { const id = pendingWorkshopEditId; pendingWorkshopEditId = null; editWorkshopWeapon(id); return; }
  openWorkshopGrid();
});

// ── Workshop weapon grid (entry screen) ─────────────────────────────────────
let _wsGridEl = null;
function ensureWorkshopGrid() {
  if (_wsGridEl) return _wsGridEl;
  const el = document.createElement('div');
  el.id = 'workshopGrid';
  el.className = 'hidden absolute inset-0 z-[76] flex flex-col bg-[#14100b] font-mono';
  el.innerHTML = `
    <div class="flex items-center justify-between px-4 pt-3 pb-2 border-b border-[#7df09a]/30">
      <h2 class="font-display text-xl text-[#7df09a] font-bold uppercase tracking-widest">🔧 무기 공방</h2>
      <div class="flex items-center gap-2">
        <button id="wsGridTutorialBtn" class="bg-[#14100b] hover:bg-gray-800 border border-[#ffd24a] text-[#ffd24a] text-[10px] px-2 py-1 cursor-pointer active:scale-95">튜토리얼 보기</button>
        <button id="wsGridClose" class="text-gray-400 hover:text-white text-lg leading-none px-2 cursor-pointer">✕</button>
      </div>
    </div>
    <p class="text-[10px] text-gray-400 px-4 py-2">내가 만든 무기를 편집하거나, <b class="text-[#7df09a]">＋ 새 무기 만들기</b>로 처음부터 만들어 보세요. 저장하면 무기고에, 업로드하면 워크샵에 올라갑니다.</p>
    <div id="wsMobileWarn" class="hidden mx-4 mb-2 border border-[#ffd24a]/70 bg-[#2c2016] text-[#ffd24a] text-[10px] px-3 py-2 leading-relaxed">휴대폰에서는 무기 공방 제작이 어렵습니다. 세부 프레임 편집은 PC 또는 태블릿을 권장합니다.</div>
    <div id="wsGridBody" class="flex-1 overflow-y-auto p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 content-start"></div>`;
  document.getElementById('motionEditor')?.parentElement?.appendChild(el);
  el.querySelector('#wsGridClose').addEventListener('click', () => el.classList.add('hidden'));
  el.querySelector('#wsGridTutorialBtn').addEventListener('click', () => openWorkshopTutorial());
  _wsGridEl = el;
  return el;
}
function openWorkshopGrid() {
  const el = ensureWorkshopGrid();
  el.querySelector('#wsMobileWarn')?.classList.toggle('hidden', !isPhoneDevice());
  renderWorkshopGrid();
  el.classList.remove('hidden');
}
function renderWorkshopGrid() {
  const el = ensureWorkshopGrid();
  const body = el.querySelector('#wsGridBody');
  const list = loadWorkshopWeaponsV2();
  const equippedId = equippedWorkshopWeaponId();
  const newCard = `<button id="wsNewCard" class="aspect-square flex flex-col items-center justify-center gap-2 bg-[#0d0a06] border-2 border-dashed border-[#7df09a] text-[#7df09a] hover:bg-[#1c6b33]/20 cursor-pointer active:scale-95 rounded">
    <span class="text-3xl">＋</span><span class="text-xs">새 무기 만들기</span></button>`;
  const cards = list.map(w => {
    const eq = w.id === equippedId;
    const presets = PRIMARY_PRESET_KEYS.filter(k => w.presets[k]).length;
    return `<div class="aspect-square flex flex-col bg-[#0d0a06] border ${eq ? 'border-[#ffd24a]' : 'border-gray-700'} rounded p-2 cursor-pointer hover:border-[#7df09a] active:scale-95" data-edit="${w.id}">
      <div class="flex-1 flex items-center justify-center min-h-0">${workshopWeaponImageMarkup(w, { className: 'workshop-card-img', fallbackClass: 'text-3xl' })}</div>
      <div class="text-[11px] text-white truncate">${escapeHtml(w.name)}${eq ? ' <span style="color:#ffd24a">★</span>' : ''}</div>
      <div class="text-[9px] text-gray-500">${WS_CAT_KO[w.category] || '근접'} · 프리셋 ${presets}</div>
    </div>`;
  }).join('');
  body.innerHTML = newCard + cards;
  body.querySelector('#wsNewCard').addEventListener('click', () => showNewWeaponModal());
  body.querySelectorAll('[data-edit]').forEach(c => c.addEventListener('click', () => editWorkshopWeapon(c.dataset.edit)));
}

function editWorkshopWeapon(id) {
  const w = loadWorkshopWeaponsV2().find(x => x.id === id);
  if (!w) { showToast('무기를 찾을 수 없습니다'); return; }
  _wsGridEl?.classList.add('hidden');
  ensureMotionEditor().openWorkshopV2(w);
}

function openWorkshopTutorial() {
  if (isPhoneDevice()) {
    const ok = window.confirm('휴대폰에서는 무기 공방 제작이 매우 불편할 수 있습니다. 튜토리얼은 계속 볼까요?');
    if (!ok) return;
  }
  const w = makeEmptyWeaponV2({
    name: '튜토리얼 무기',
    desc: '무기 공방 기능을 익히기 위한 임시 무기입니다.',
    category: 'melee',
    firstPresetKind: 'basic',
  });
  _wsGridEl?.classList.add('hidden');
  const editor = ensureMotionEditor();
  editor.openWorkshopV2(w);
  setTimeout(() => editor.replayTutorial?.(), 80);
  emitLobbyTutorialEvent('workshopTutorialStarted');
}

// New-weapon modal: name / desc / category / first preset → empty V2 weapon.
let _wsNewEl = null;
function showNewWeaponModal() {
  if (!_wsNewEl) {
    const el = document.createElement('div');
    el.id = 'wsNewModal';
    el.className = 'hidden absolute inset-0 z-[86] flex items-center justify-center bg-black/80 p-4 font-mono';
    el.innerHTML = `
      <div class="bg-[#2c2016] border-2 border-[#7df09a] p-4 w-full max-w-sm">
        <div class="text-[#7df09a] text-sm font-bold mb-3">＋ 새 무기 만들기</div>
        <label class="block text-[10px] text-gray-300 mb-1">이름</label>
        <input id="wsnName" maxlength="24" placeholder="무기 이름" class="w-full bg-[#14100b] border border-gray-600 text-white text-xs px-2 py-1.5 mb-2"/>
        <label class="block text-[10px] text-gray-300 mb-1">설명</label>
        <input id="wsnDesc" maxlength="80" placeholder="설명 (선택)" class="w-full bg-[#14100b] border border-gray-600 text-white text-xs px-2 py-1.5 mb-2"/>
        <label class="block text-[10px] text-gray-300 mb-1">분류</label>
        <div id="wsnCat" class="flex gap-1.5 mb-3">
          <button data-cat="melee" class="flex-1 med-btn text-[11px] py-1.5 on">근접</button>
          <button data-cat="ranged" class="flex-1 med-btn text-[11px] py-1.5">원거리</button>
          <button data-cat="special" class="flex-1 med-btn text-[11px] py-1.5">특수</button>
        </div>
        <label class="block text-[10px] text-gray-300 mb-1">첫 프리셋</label>
        <select id="wsnPreset" class="w-full bg-[#14100b] border border-gray-600 text-white text-xs px-2 py-1.5 mb-4">
          <option value="basic">평타</option><option value="heavy">강공격</option><option value="dash">대시</option>
          <option value="skill1">스킬 1</option><option value="skill2">스킬 2</option><option value="skill3">스킬 3</option><option value="ultimate">궁극기</option>
        </select>
        <div class="flex gap-2">
          <button id="wsnCreate" class="flex-1 bg-gradient-to-r from-[#3aa856] to-[#1c6b33] border-2 border-[#7df09a] text-white text-xs px-4 py-2 uppercase font-extrabold cursor-pointer active:scale-95">만들기</button>
          <button id="wsnCancel" class="med-btn text-xs px-4 py-2">취소</button>
        </div>
      </div>`;
    document.getElementById('motionEditor')?.parentElement?.appendChild(el);
    el.querySelector('#wsnCat').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      el.querySelectorAll('#wsnCat button').forEach(x => x.classList.toggle('on', x === b));
    });
    el.querySelector('#wsnCancel').addEventListener('click', () => el.classList.add('hidden'));
    el.querySelector('#wsnCreate').addEventListener('click', () => {
      const name = el.querySelector('#wsnName').value.trim() || '새 무기';
      const desc = el.querySelector('#wsnDesc').value.trim();
      const category = el.querySelector('#wsnCat .on')?.dataset.cat || 'melee';
      const firstPresetKind = el.querySelector('#wsnPreset').value;
      const w = makeEmptyWeaponV2({ name, desc, category, firstPresetKind });
      saveWorkshopWeaponLocal(w);      // brand-new empty weapon — no carry-over
      el.classList.add('hidden');
      editWorkshopWeapon(w.id);
    });
    _wsNewEl = el;
  }
  // reset fields each open
  _wsNewEl.querySelector('#wsnName').value = '';
  _wsNewEl.querySelector('#wsnDesc').value = '';
  _wsNewEl.querySelector('#wsnPreset').value = 'basic';
  _wsNewEl.querySelectorAll('#wsnCat button').forEach((x, i) => x.classList.toggle('on', i === 0));
  _wsNewEl.classList.remove('hidden');
}

// --- Onboarding controls card -------------------------------------------------
function showOnboardCard(objective) {
  const card = document.getElementById('onboardCard');
  if (!card) return;
  if (objective) {
    const obj = document.getElementById('onboardObjective');
    if (obj) obj.textContent = objective;
  }
  card.classList.remove('hidden');
}
function hideOnboardCard() {
  document.getElementById('onboardCard')?.classList.add('hidden');
}
document.getElementById('onboardCloseBtn')?.addEventListener('click', () => {
  Sound.play('uiConfirm');
  hideOnboardCard();
  // Quick-play holds the sim behind this card — dismissing it starts the 3·2·1
  // countdown (no-op when the match is already running, e.g. pause-menu reopen).
  activeGame?.releaseMatchHold?.();
});
document.getElementById('pauseHelpBtn')?.addEventListener('click', () => {
  Sound.play('ui');
  document.getElementById('pauseMenu')?.classList.add('hidden'); // close the menu behind it
  showOnboardCard();
});

// --- Match result scoreboard (timed bot match) --------------------------------
function showMatchResult(results) {
  const card = document.getElementById('matchResultCard');
  if (!card || !Array.isArray(results)) return;
  // The round can end while the local player is mid-respawn — hide the death
  // overlay so it never stacks under/over the scoreboard (its "0.5s" text would
  // otherwise sit frozen behind the results).
  document.getElementById('respawnOverlay')?.classList.add('hidden');
  const localR = results.find(r => r.isLocal);
  const headline = document.getElementById('matchResultHeadline');
  if (headline) {
    headline.textContent = (localR && localR.rank === 1)
      ? '🏆 승리! 당신이 1위입니다'
      : (localR ? `${localR.rank}위 — 다음엔 정상을 노려보세요!` : '결과');
  }
  const list = document.getElementById('matchResultList');
  if (list) {
    list.innerHTML = results.map(r => `
      <div class="flex items-center justify-between px-3 py-2 ${r.isLocal ? 'bg-[#3a2e16] border border-[#c9a227]' : 'bg-[#14100b] border border-gray-700'}">
        <span class="flex items-center gap-2 text-[13px] ${r.rank === 1 ? 'text-[#ffd24a] font-bold' : 'text-gray-200'}">
          <span class="w-5 text-center">${r.rank === 1 ? '👑' : r.rank}</span>
          <span class="truncate max-w-[160px]">${escapeHtml(r.name)}</span>
        </span>
        <span class="text-[12px] text-gray-300 shrink-0">처치 <b class="text-[#e8d5a3]">${r.kills}</b> · 사망 ${r.deaths}</span>
      </div>`).join('');
  }
  Sound.play(localR && localR.rank === 1 ? 'kill' : 'uiConfirm');
  card.classList.remove('hidden');
}
function hideMatchResult() { document.getElementById('matchResultCard')?.classList.add('hidden'); }
document.getElementById('matchRestartBtn')?.addEventListener('click', () => {
  Sound.play('uiConfirm');
  hideMatchResult();
  if (activeGame) activeGame.quit();   // tears down the finished match (→ lobby)
  doBotMatch();                        // …then immediately launch a fresh one
});
document.getElementById('matchLeaveBtn')?.addEventListener('click', () => {
  Sound.play('ui');
  hideMatchResult();
  if (activeGame) activeGame.quit();
});

/**
 * 4. Match Joining workflow (shared by the Join button and room-list clicks)
 */
async function startJoin(rawCode, triggerBtn = joinBtn) {
  const nickname = nicknameInput.value.trim();
  const roomCode = String(rawCode || '').trim();
  const chosenWeapon = document.querySelector('.weapon-card.selected')?.dataset.weapon || 'sword';
  const setJoinBusy = (busy) => {
    if (joinBtn) {
      joinBtn.disabled = busy;
      joinBtn.textContent = busy ? '연결 중...' : '참가';
    }
    if (triggerBtn && triggerBtn !== joinBtn) {
      triggerBtn.disabled = busy;
      triggerBtn.textContent = busy ? '연결 중...' : (triggerBtn.dataset.idleLabel || '결투장 입장');
    }
  };

  if (!nickname) {
    showError('방에 참가하기 전에 닉네임을 입력해 주세요.');
    return;
  }
  if (!roomCode || roomCode.length < 3) {
    showError('방 코드는 최소 3글자 이상이어야 합니다.');
    return;
  }

  hideError();
  setJoinBusy(true);

  netManager = new NetworkManager({ getAuthToken: accountUI.getAuthToken });

  // Create registration payload frame (carry costume so the host paints us
  // correctly, and isMobile so the host gives touch players instant-fire).
  let appearance;
  try {
    appearance = await networkAppearance();
  } catch {
    appearance = localAppearance();
  }
  const joinPayload = Protocol.joinRoom(nickname, chosenWeapon, appearance, isMobileDevice(), readControls());

  netManager.on('onConnected', () => {
    setJoinBusy(false);

    enterGameScreen(false);

    activeGame = new Game(gameCanvas, netManager, localAppearance());
    activeGame.start((stats) => {
      handleMatchEnd(stats);
    });
  });

  netManager.on('onError', (err) => {
    setJoinBusy(false);
    showError(err);
    netManager.stop();
  });

  // Query and join room code
  netManager.joinRoom(roomCode, joinPayload);
}

joinBtn.addEventListener('click', () => startJoin(joinRoomInput.value.trim()));

/**
 * 5. Lobby / game screen transitions
 */
/**
 * On mobile, force the arena into landscape so the wide battlefield fits. This
 * is best-effort: orientation lock needs fullscreen on most browsers and is
 * unsupported on iOS Safari, so every call is guarded and never throws.
 */
async function lockLandscapeForArena() {
  if (!isMobileDevice()) return;
  try {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
  } catch (_) { /* unsupported — leave orientation as-is */ }
}

function releaseLandscapeLock() {
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } catch (_) {}
}

/**
 * Phones (NOT tablets) lock to portrait while in the lobby so the stacked menu
 * reads naturally. Best-effort: orientation lock needs an installed PWA /
 * fullscreen on most browsers and is unsupported on iOS Safari, so it never
 * throws and silently no-ops where the platform disallows it.
 */
async function lockPortraitForLobby() {
  if (!isPhoneDevice()) { releaseLandscapeLock(); return; }
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('portrait').catch(() => {});
    } else {
      releaseLandscapeLock();
    }
  } catch (_) {
    releaseLandscapeLock();
  }
}

function enterGameScreen(isHost) {
  lobbyMenu.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.getElementById('onboardCard')?.classList.add('hidden'); // never carry the card across matches
  document.getElementById('matchResultCard')?.classList.add('hidden');
  hostServerIndicator?.classList.toggle('hidden', !isHost);
  stopLobbyBrowsing();
  lockLandscapeForArena();
}

function showLobbyScreen() {
  lobbyMenu.classList.remove('hidden');
  if (typeof window.showLobbyHub === 'function') window.showLobbyHub();
  gameScreen.classList.add('hidden');
  hostServerIndicator?.classList.add('hidden');
  lockPortraitForLobby();

  // Tear down any room advertisement and resume browsing the list.
  roomRegistry.stopHosting();

  if (activeGame) {
    activeGame = null;
  }
  if (netManager) {
    netManager = null;
  }

  startLobbyBrowsing();
}

const leaveConfirmModal = document.getElementById('leaveConfirmModal');
const leaveConfirmYes = document.getElementById('leaveConfirmYes');
const leaveConfirmNo = document.getElementById('leaveConfirmNo');

function openLeaveConfirm() {
  if (!leaveConfirmModal) {            // fallback if markup is missing
    if (activeGame) activeGame.quit();
    return;
  }
  leaveConfirmModal.classList.remove('hidden');
}
function closeLeaveConfirm() {
  if (leaveConfirmModal) leaveConfirmModal.classList.add('hidden');
}

// Small in-game pause menu (D): the ⚙ button (or ESC) opens a tiny menu with
// 소리 토글 + 게임 나가기. Leave still routes through leaveConfirmModal.
const pauseMenu = document.getElementById('pauseMenu');
const pauseMenuBtn = document.getElementById('pauseMenuBtn');
function setPauseMenu(open) {
  if (!pauseMenu) return;
  pauseMenu.classList.toggle('hidden', !open);
  pauseMenu.classList.toggle('flex', open);
}
pauseMenuBtn?.addEventListener('click', () => setPauseMenu(pauseMenu?.classList.contains('hidden')));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // ESC closes the leave dialog first, else toggles the pause menu (in-game only).
  if (leaveConfirmModal && !leaveConfirmModal.classList.contains('hidden')) { closeLeaveConfirm(); return; }
  if (!gameScreen.classList.contains('hidden')) setPauseMenu(pauseMenu?.classList.contains('hidden'));
});

leaveBtn.addEventListener('click', () => { setPauseMenu(false); openLeaveConfirm(); });
if (leaveConfirmYes) leaveConfirmYes.addEventListener('click', () => {
  closeLeaveConfirm();
  if (activeGame) activeGame.quit();
});
if (leaveConfirmNo) leaveConfirmNo.addEventListener('click', closeLeaveConfirm);
if (leaveConfirmModal) leaveConfirmModal.addEventListener('click', (e) => {
  if (e.target === leaveConfirmModal) closeLeaveConfirm(); // tap backdrop = cancel
});

/**
 * 6. Room list browser
 */
function startLobbyBrowsing() {
  roomRegistry.startBrowsing(renderRoomList);
  updateRoomListStatus();
}

function stopLobbyBrowsing() {
  roomRegistry.stopBrowsing();
  lastRoomSig = null; // force a fresh render next time the lobby opens
}

function updateRoomListStatus() {
  if (!roomListStatus) return;
  roomListStatus.innerHTML = roomRegistry.online
    ? `${uiIcon('online')}온라인 - 다른 기기의 방도 표시됩니다`
    : `${uiIcon('storage')}로컬 모드 - 같은 브라우저 탭만 표시`;
}

let lastRoomSig = null;

function renderRoomList(rooms) {
  if (!roomListContainer) return;
  updateRoomListStatus();

  // Skip rebuilding identical DOM (the prune timer fires every 2.5s).
  const sig = rooms.map(r => `${r.code}|${r.host}|${r.weapon}|${r.players}|${r.dummy ? 1 : 0}|${roomConfigBadges(r.config).join(',')}`).join(';');
  if (sig === lastRoomSig) return;
  lastRoomSig = sig;

  if (!rooms.length) {
    roomListContainer.innerHTML =
      '<div class="text-gray-500 font-mono text-[11px] text-center py-8">열려 있는 방이 없습니다.<br>왼쪽에서 방을 만들어 보세요!</div>';
    return;
  }

  roomListContainer.innerHTML = rooms.map(room => {
    const cfg = Weapons[room.weapon] || Weapons.sword;
    const code = escapeHtml(room.code);
    const host = escapeHtml(room.host || room.code);
    const players = Number.isFinite(room.players) ? room.players : 1;
    const isDummy = !!room.dummy;
    // Dummy (practice) rooms get a bold red border + badge so they're obvious.
    const borderCls = isDummy
      ? 'border-red-500 hover:border-red-400 shadow-[0_0_10px_rgba(239,68,68,0.35)]'
      : 'border-gray-700 hover:border-[#c9a227]';
    const dummyBadge = isDummy
      ? '<span class="font-mono text-[9px] text-red-300 border border-red-500 px-1 py-0.5 uppercase shrink-0">더미방</span>'
      : '';
    // Room-setting badges (arena size always shown; storm/cover/healing when on).
    const badges = roomConfigBadges(room.config)
      .map(b => `<span class="font-mono text-[9px] text-[#e6c75a] border border-[#7a5a28] bg-[#1a120a] px-1 py-0.5 uppercase">${escapeHtml(b)}</span>`)
      .join('');
    const badgeRow = badges
      ? `<div class="flex flex-wrap gap-1 mt-1">${badges}</div>`
      : '';
    return `
      <button class="room-row w-full text-left bg-[#1a120a] border-2 ${borderCls} p-2.5 transition-all active:scale-[0.98] cursor-pointer flex items-center justify-between gap-2" data-code="${code}">
        <div class="min-w-0">
          <div class="font-mono text-sm text-white font-bold truncate flex items-center gap-1.5">${dummyBadge}<span class="truncate">${code}</span></div>
          <div class="font-mono text-[10px] text-gray-400 truncate">${uiIcon('user')} ${host} · <span style="color:${cfg.color}">${cfg.name}</span></div>
          ${badgeRow}
        </div>
        <div class="text-right shrink-0">
          <div class="font-mono text-[10px] ${isDummy ? 'text-red-300' : 'text-[#e6c75a]'} font-bold">${uiIcon('play')}참가</div>
          <div class="font-mono text-[10px] text-green-400">${uiIcon('users')}${players}명</div>
        </div>
      </button>`;
  }).join('');
}

if (roomListContainer) {
  roomListContainer.addEventListener('click', (e) => {
    const row = e.target.closest('.room-row');
    if (!row) return;
    const code = row.dataset.code;
    if (joinRoomInput) joinRoomInput.value = code;
    startJoin(code);
  });
}

if (refreshRoomsBtn) {
  refreshRoomsBtn.addEventListener('click', () => {
    renderRoomList(roomRegistry.list());
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * In-game weapon switch panel (applied on next respawn).
 */
function setWeaponPanelOpen(open) {
  const panel = document.getElementById('weaponSwitchPanel');
  const backdrop = document.getElementById('weaponPanelBackdrop');
  if (panel) panel.classList.toggle('open', open);
  if (backdrop) backdrop.classList.toggle('open', open);
}

function buildWeaponSwitchPanel() {
  const list = document.getElementById('weaponSwitchList');
  if (!list) return;
  const baseHtml = '';
  const workshopHtml = loadWorkshopWeaponsV2().map(w => (
    `<button type="button" data-ws="${escapeHtml(w.id)}" class="weapon-switch" style="color:${w.color || '#ffb070'}">`
      + `<span class="ws-accent" aria-hidden="true"></span>`
      + `<span class="ws-name">${escapeHtml(w.name)} <small style="color:#ffd7a8">공방</small></span>`
      + `</button>`
  )).join('');
  list.innerHTML = baseHtml + workshopHtml;

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.weapon-switch');
    if (!btn || !activeGame) return;
    if (btn.dataset.ws) {
      const w = loadWorkshopWeaponsV2().find(x => x.id === btn.dataset.ws);
      if (w) activeGame.requestWeaponChange(`ws:${w.id}`, attachLocalWorkshopImagePayload(v2ToV1Runtime(w)), w.name);
    } else {
      activeGame.requestWeaponChange(btn.dataset.weapon);
    }
    setWeaponPanelOpen(false); // mobile: dismiss after picking (desktop bar stays open via CSS)
  });

  const toggle = document.getElementById('weaponPanelToggle');
  if (toggle) toggle.addEventListener('click', () => {
    const panel = document.getElementById('weaponSwitchPanel');
    setWeaponPanelOpen(!(panel && panel.classList.contains('open')));
  });
  const backdrop = document.getElementById('weaponPanelBackdrop');
  if (backdrop) backdrop.addEventListener('click', () => setWeaponPanelOpen(false));
}


/**
 * Limbus-style hub navigation. The hub is the lobby landing (resource bar +
 * profile + 6-module grid + notice). Picking a module either opens an overlay
 * (shop/rank reuse the existing buttons) or reveals the existing functional
 * panel in single-panel "module mode" by driving the same lobby-tab switch the
 * mobile nav already uses — so no account/matchmaking hook is moved or rewired.
 */
// Tier score → ladder (금장 = gold). Score = kills*4 − deaths*10 (see account-ui
// getTierScore). Each tier splits into III/II/I by progress within the band.
function tierFromScore(score) {
  const T = [
    { n: '목장', min: 0, c: '#8a6f47' }, { n: '철장', min: 40, c: '#9aa0a8' },
    { n: '동장', min: 120, c: '#b87333' }, { n: '은장', min: 240, c: '#c0c0c0' },
    { n: '금장', min: 480, c: '#d4af37' }, { n: '백금장', min: 1200, c: '#7fd4d4' },
  ];
  let i = 0; for (let k = 0; k < T.length; k++) if (score >= T[k].min) i = k;
  const cur = T[i], next = T[i + 1];
  const span = (next ? next.min : cur.min * 2 + 40) - cur.min;
  const prog = Math.min(0.999, Math.max(0, (score - cur.min) / Math.max(1, span)));
  return { label: `${cur.n} ${['III', 'II', 'I'][Math.floor(prog * 3)]}`, color: cur.c };
}

/* ===== UI interaction motion helpers (lobby / meta UI; transform+opacity only).
   All effects are additive: when motion is reduced (perf mode or OS reduced-
   motion) they no-op and the layout/values are set instantly. ===== */
function motionReduced() {
  return document.documentElement.classList.contains('motion-reduced') ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
/** Read a duration CSS token (e.g. '--dur-bar') as milliseconds. Single source
    of truth so JS-driven rollups stay in sync with the CSS transitions. */
function durMs(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : fallback;
}
/** Interpolate a numeric label from→to (easeOutCubic) over --dur-bar.
    `dec` = decimal places (0 = integer). Rounds each frame to kill fp noise. */
function rollStat(el, from, to, dec) {
  if (!el) return;
  const fmt = (v) => (dec ? v.toFixed(dec) : String(Math.round(v)));
  if (motionReduced() || from === to) { el.textContent = fmt(to); return; }
  const dur = durMs('--dur-bar', 700), t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}
/** Replay a screen-enter animation by restarting it with a forced reflow. */
function playEnter(el, cls) {
  if (!el) return;
  el.classList.remove('screen-in', 'screen-back');
  if (motionReduced()) return;
  void el.offsetWidth;                 // reflow → restart the keyframes
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
/** (Re)trigger the entrance stagger on a wrapper's direct children. */
function playStagger(wrapper) {
  if (!wrapper || motionReduced()) return;
  wrapper.classList.remove('stagger-group');
  void wrapper.offsetWidth;
  wrapper.classList.add('stagger-group');
}
/** Opacity-only crossfade for scroll containers (no translate → no scrollbar). */
function crossfade(el) {
  if (!el || motionReduced()) return;
  el.classList.remove('med-fade');
  void el.offsetWidth;
  el.classList.add('med-fade');
  el.addEventListener('animationend', () => el.classList.remove('med-fade'), { once: true });
}
/** Brief slide-in toast that fades out on its own. */
function showToast(msg) {
  let wrap = document.getElementById('medToastWrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'medToastWrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'med-toast';
  t.textContent = msg;
  wrap.appendChild(t);
  if (motionReduced()) { setTimeout(() => t.remove(), 1400); return; }
  t.addEventListener('animationend', (e) => { if (e.animationName === 'med-toast-out') t.remove(); });
  setTimeout(() => { if (t.isConnected) t.remove(); }, 2200);   // safety net
}
/** Count-up a numeric element to `target`, with a small pop at the end. */
function rollNumber(el, target) {
  if (!el) return;
  const to = Number(target) || 0;
  const from = Number(String(el.textContent).replace(/[^\d.-]/g, '')) || 0;
  if (motionReduced() || from === to) { el.textContent = to.toLocaleString(); return; }
  const dur = durMs('--dur-bar', 700), t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    el.textContent = v.toLocaleString();
    if (k < 1) { requestAnimationFrame(step); return; }
    el.textContent = to.toLocaleString();
    el.classList.remove('med-roll-pop'); void el.offsetWidth; el.classList.add('med-roll-pop');
  };
  requestAnimationFrame(step);
}
/** One-shot pop on an element (equip/save confirm kick). */
function popElement(el) {
  if (!el || motionReduced()) return;
  el.classList.remove('med-pop-anim'); void el.offsetWidth; el.classList.add('med-pop-anim');
  el.addEventListener('animationend', () => el.classList.remove('med-pop-anim'), { once: true });
}

function setupLobbyHub() {
  const hub = document.getElementById('lobbyHub');
  const layout = document.getElementById('lobbyLayout');
  const back = document.getElementById('lobbyBack');
  const modules = document.getElementById('hubModules');
  if (!hub || !layout) return;

  const setText = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.textContent = val; };

  const shell = document.getElementById('moduleShell');
  const shellBody = document.getElementById('moduleBody');
  const track = document.getElementById('lobbyTrack');
  const hubScreen = hub.closest('.lobby-scr');     // the two sliding screens
  const shellScreen = shell?.closest('.lobby-scr');
  // Per-side entry direction: left-column buttons (무기고/방 제작/랭킹) push the
  // module in FROM THE LEFT; the right column enters from the right.
  const LEFT_MODULES = new Set(['armory', 'create', 'rank']);
  let navState = 'hub';     // 'hub' | 'shell'
  let lastFromLeft = false; // direction the current module entered from (to reverse on back)

  // Slide so `incoming` reveals while `outgoing` exits. The track is reordered so
  // the incoming screen sits on the side it should enter from, then we set the
  // start transform (still showing `outgoing` — no visual jump) and animate.
  // Transform-only; both screens stay mounted, so there is never a blank frame.
  function pushTo(incoming, outgoing, fromLeft) {
    if (!track || !incoming || !outgoing) return;
    if (fromLeft) {
      track.append(incoming, outgoing);              // [incoming, outgoing]
      track.style.transition = 'none';
      track.style.transform = 'translateX(-50%)';    // show outgoing (2nd)
      void track.offsetWidth;
      track.style.transition = '';
      track.style.transform = 'translateX(0)';       // → incoming (1st): enters from left
    } else {
      track.append(outgoing, incoming);              // [outgoing, incoming]
      track.style.transition = 'none';
      track.style.transform = 'translateX(0)';       // show outgoing (1st)
      void track.offsetWidth;
      track.style.transition = '';
      track.style.transform = 'translateX(-50%)';    // → incoming (2nd): enters from right
    }
  }
  // After the track finishes sliding back to the hub, tidy up the (now off-screen)
  // shell — restoring the moved shop/rank card. Doing it here (not mid-slide) keeps
  // the outgoing screen intact while it slides away (no flash, no end-jump).
  track?.addEventListener('transitionend', (e) => {
    if (e.target !== track || e.propertyName !== 'transform') return;
    if (navState === 'hub') restoreMovedCard();
  });

  // Shop/rank: relocate the existing account-ui modal card into the shell (its
  // listeners + shopBody/leaderboardBody IDs move with the subtree, so the
  // Firebase-wired purchase/ranking logic is untouched). Restored on leave.
  let movedCard = null;
  function restoreMovedCard() {
    if (!movedCard) return;
    movedCard.obs?.disconnect();
    if (movedCard.node && movedCard.parent) movedCard.parent.appendChild(movedCard.node);
    movedCard.panel?.remove();
    movedCard.modal?.classList.add('hidden');
    movedCard = null;
  }
  // List reveal: rank table rows / shop cards slide in from the left, fading up,
  // staggered — so opacity rises starting from the left. Re-applied on internal
  // re-renders (e.g. the shop's category tabs replace shopBody's contents).
  function revealList(root) {
    if (!root || motionReduced()) return;
    let items = [...root.querySelectorAll('tbody tr')];
    if (!items.length) items = [...root.querySelectorAll('[class*="bg-[#0b0c10]"]')];
    items.forEach((el, i) => {
      el.classList.remove('med-list-item'); void el.offsetWidth;
      el.style.animationDelay = Math.min(i * 75, 600) + 'ms';
      el.classList.add('med-list-item');
    });
  }
  // Prepare the (off-screen) shell: header text + a cleared body. Content is
  // built into it BEFORE the slide, so the module is fully rendered on arrival.
  function prepShell(crumbKo, crumbEn) {
    restoreMovedCard();
    if (window.__clearArenaTimer) window.__clearArenaTimer();
    setText('moduleCrumbKo', crumbKo);
    setText('moduleCrumbEn', crumbEn);
    setText('moduleCoins', (Number(String(document.getElementById('accountCoins')?.textContent ?? '0').replace(/,/g, '')) || 0).toLocaleString());
    layout.classList.add('hidden');
    if (shellBody) shellBody.innerHTML = '';
  }
  function slideToShell(fromLeft) {
    navState = 'shell';
    lastFromLeft = !!fromLeft;
    pushTo(shellScreen, hubScreen, lastFromLeft);
  }

  // Move just the rendered BODY (shopBody / leaderboardBody) into a fresh
  // parchment panel — moving the whole modal card dragged in a stale composited
  // layer that refused to repaint the parchment. account-ui re-queries the body
  // by id, so its render + listeners stay intact. Built off-screen, THEN slid in.
  function openShellMove(ko, en, modalId, triggerId, bodyId, fromLeft) {
    prepShell(ko, en);
    const modal = document.getElementById(modalId);
    document.getElementById(triggerId)?.click();   // account-ui renders into bodyId
    const bodyEl = document.getElementById(bodyId);
    if (bodyEl && shellBody) {
      const panel = document.createElement('div');
      panel.className = 'med-parch med-moved-card relative p-4';
      movedCard = { node: bodyEl, parent: bodyEl.parentElement, panel, modal };
      panel.appendChild(bodyEl);
      shellBody.appendChild(panel);
      revealList(bodyEl);
      // Re-reveal when account-ui re-renders the list in place (shop category tabs).
      const obs = new MutationObserver(() => revealList(bodyEl));
      obs.observe(bodyEl, { childList: true });
      movedCard.obs = obs;
    } else {
      movedCard = { modal };
    }
    modal?.classList.add('hidden');
    slideToShell(fromLeft);
  }

  function showHub() {
    if (window.__clearArenaTimer) window.__clearArenaTimer();
    // Mirror the live account values into the parchment profile card.
    const profile = accountUI.getProfile?.() || null;
    const name = document.getElementById('accountName')?.textContent?.trim();
    setText('hubName', name && name !== '-' ? name : (document.getElementById('nicknameInput')?.value || '플레이어'));
    const coinsRaw = profile?.coins ?? document.getElementById('accountCoins')?.textContent?.trim() ?? 0;
    const coinsNum = Number(String(coinsRaw).replace(/,/g, '')) || 0;
    rollNumber(document.getElementById('hubCoins'), coinsNum);   // coin tick + pop
    setText('moduleCoins', coinsNum.toLocaleString());
    // Stats + score-based tier (kills*4 − deaths*10).
    const kills = accountUI.getTotalKills?.() ?? 0;
    const deaths = accountUI.getTotalDeaths?.() ?? 0;
    rollNumber(document.getElementById('hubKills'), kills);
    rollNumber(document.getElementById('hubDeaths'), deaths);
    setText('hubLoadout', document.querySelector('.weapon-card.selected span')?.textContent?.trim() || '검');
    const tier = tierFromScore(accountUI.getTierScore?.() ?? 0);
    const tierEl = document.getElementById('hubTier');
    if (tierEl) { tierEl.textContent = tier.label; tierEl.style.color = tier.color; }
    // Google profile photo (falls back to the icon for id/password logins).
    const photo = accountUI.getAvatarUrl?.();
    const avatar = document.getElementById('hubAvatar');
    const fallback = document.getElementById('hubAvatarFallback');
    if (avatar && fallback) {
      if (photo) { avatar.src = photo; avatar.classList.remove('hidden'); fallback.classList.add('hidden'); avatar.onerror = () => { avatar.classList.add('hidden'); fallback.classList.remove('hidden'); }; }
      else { avatar.classList.add('hidden'); fallback.classList.remove('hidden'); }
    }
    layout.classList.add('hidden');
    back?.classList.add('hidden');
    // Slide back to the hub, REVERSING the direction the module entered from
    // (entered from left → hub returns from the right, and vice-versa). The shell
    // stays mounted and slides off; cleanup runs on transitionend (or now, if
    // motion is reduced / first paint, since no transition fires).
    const wasShell = navState === 'shell';
    navState = 'hub';
    if (wasShell && !motionReduced() && track) {
      pushTo(hubScreen, shellScreen, !lastFromLeft);
    } else if (track) {
      // Instant: ensure the hub screen is the one shown (order [hub, shell] @ 0).
      track.append(hubScreen, shellScreen);
      track.style.transition = 'none';
      track.style.transform = 'translateX(0)';
      void track.offsetWidth;
      track.style.transition = '';
      restoreMovedCard();
    }
    // Re-play the module buttons' directional entrance (left col ← left, right col ← right).
    if (modules && !motionReduced()) { modules.classList.remove('reveal'); void modules.offsetWidth; modules.classList.add('reveal'); }
    emitLobbyTutorialEvent('hub');
  }
  window.showLobbyHub = showHub;

  // Modules built into the common parchment shell (header + body). The shell is
  // ALWAYS mounted (screen 1); we build the module into it while it is still
  // off-screen, then slide the track — so the incoming screen is fully rendered
  // before it appears (no blank-frame flash, no in-place swap of a visible node).
  function openShellModule(crumbKo, crumbEn, builder, fromLeft) {
    prepShell(crumbKo, crumbEn);
    if (shellBody) builder?.(shellBody);
    playStagger(shellBody?.firstElementChild); // cards/rows rise in sequence
    slideToShell(fromLeft);                    // slide the (already-built) module in
  }

  function openModule(mod) {
    const fromLeft = LEFT_MODULES.has(mod);   // 무기고/방 제작/랭킹 enter from the left
    // Quick play (offline bot match) + weapon workshop reuse their existing
    // (hidden legacy-layout) buttons' handlers — the hub card forwards the click.
    if (mod === 'quickplay') { openShellModule('바로 플레이', 'QUICK PLAY', (body) => buildCreateInto(body, 'quickplay'), false); emitLobbyTutorialEvent('module:quickplay'); return; }
    if (mod === 'workshop') { document.getElementById('workshopBtn')?.click(); emitLobbyTutorialEvent('module:workshop'); return; }  // user weapon workshop (all users)
    if (mod === 'shop') { openShellMove('워크샵', 'WORKSHOP', 'shopModal', 'shopBtn', 'shopBody', fromLeft); emitLobbyTutorialEvent('module:shop'); return; }
    if (mod === 'rank') { openShellMove('랭킹', 'RANK', 'leaderboardModal', 'rankBtn', 'leaderboardBody', fromLeft); emitLobbyTutorialEvent('module:rank'); return; }
    if (mod === 'armory') {
      const hasBase = !!document.querySelector('.weapon-card');
      const hasWorkshop = loadWorkshopWeaponsV2().length > 0;
      if (!hasBase && !hasWorkshop) { document.getElementById('workshopBtn')?.click(); return; }
      openShellModule('무기고', 'ARMORY', buildArmoryInto, fromLeft); emitLobbyTutorialEvent('module:armory'); return;
    }
    if (mod === 'options') { openShellModule('설정', 'OPTIONS', buildOptionsInto, fromLeft); emitLobbyTutorialEvent('module:options'); return; }
    if (mod === 'create') { openShellModule('방 제작', 'CREATE', buildCreateInto, fromLeft); emitLobbyTutorialEvent('module:create'); return; }
    if (mod === 'arena') { openShellModule('결투장', 'ARENA', buildArenaInto, fromLeft); emitLobbyTutorialEvent('module:arena'); return; }
  }
  window.openLobbyModule = openModule;

  modules?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-module]');
    if (btn) openModule(btn.dataset.module);
  });
  back?.addEventListener('click', showHub);
  document.getElementById('moduleBackBtn')?.addEventListener('click', showHub);
  showHub();
}

/* ===== [01] ARMORY module — parchment list + data-driven detail =====
   Reads weapon stats straight from Weapons.js (no hardcoded numbers); the KO
   names come from the existing weapon cards; 장착하기 just drives the existing
   .weapon-card selection so the match-start read is untouched. */
const ARMORY_SPECIAL = new Set(['gauntlet', 'guardian', 'minebag', 'flamethrower']);
function armoryCategory(w) {
  if (ARMORY_SPECIAL.has(w)) return '특수';
  return (Weapons[w]?.type === 'projectile') ? '원거리' : '근접';
}
// V2 workshop category → armory filter label.
const WS_CAT_KO = { melee: '근접', ranged: '원거리', special: '특수' };

// Persisted set of workshop weapons THIS device has already recommended (♥).
// Liking is idempotent against it, so re-rendering the list — or returning to
// the tab from another one — can never re-bump a weapon's count a second time.
const LIKED_WS_KEY = 'pixelroyale_liked_ws';
const WS_FREE_CLAIM_KEY = 'craftroyale_first_workshop_weapon_claimed_v1';
const WORKSHOP_WEAPON_PRICE = 100;
const LOBBY_WEAPON_TUTORIAL_KEY = 'craftroyale_weapon_tutorial_seen_v1';
function likedWsSet() {
  try { const a = JSON.parse(localStorage.getItem(LIKED_WS_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
}
function markWsLiked(id) {
  const s = likedWsSet(); if (s.has(id)) return false;
  s.add(id);
  try { localStorage.setItem(LIKED_WS_KEY, JSON.stringify([...s])); } catch {}
  return true;
}

const LOBBY_TUTORIAL_STEPS = [
  {
    title: '워크샵에서 첫 무기 얻기',
    text: '워크샵은 다른 플레이어가 업로드한 공개 창작 무기를 둘러보는 공간입니다.\n\n여기에서 무기를 추가하면 내 무기고에 들어가고, 전투에서 사용할 수 있습니다.\n\n첫 무기는 무료이고, 그 이후 워크샵 무기는 100화폐가 필요합니다.',
    target: '[data-module="shop"]',
    advanceOn: 'module:shop',
  },
  {
    title: '무기 하나 추가하기',
    text: '＋ 추가 버튼은 해당 창작 무기를 내 계정의 무기고로 가져오는 기능입니다.\n\n추가가 끝나야 장착과 전투 사용이 가능합니다.\n\n실제 저장이 확인되면 다음 안내로 넘어갑니다.',
    target: '#shopBody [data-act="add"]',
    auto: 'workshopWeaponAdded',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '무기를 하나 얻었다면 왼쪽 위의 화살표로 게시판으로 돌아가세요.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '랭킹 확인',
    text: '랭킹은 누적 처치 순위와 내 전적을 확인하는 메뉴입니다.\n\n전투 결과가 얼마나 쌓였는지 보고, 현재 계정의 진행 상황을 확인할 때 사용합니다.',
    target: '[data-module="rank"]',
    advanceOn: 'module:rank',
  },
  {
    title: '랭킹 목록',
    text: '랭킹 목록에는 플레이어별 누적 기록이 표시됩니다.\n\n전투를 많이 하거나 처치 수가 높은 플레이어일수록 위쪽에 보입니다.\n\n목록 아무 곳이나 눌러 다음으로 넘어갑니다.',
    target: '#leaderboardBody',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '랭킹 화면을 확인했다면 다시 게시판으로 돌아갑니다.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '설정 확인',
    text: '설정은 계정, 그래픽, 음향, 조작, 키 설정을 한 곳에서 바꾸는 메뉴입니다.\n\n모바일 조작이 불편하거나 PC 키가 맞지 않으면 전투 전에 여기에서 먼저 조정합니다.',
    target: '[data-module="options"]',
    advanceOn: 'module:options',
  },
  {
    title: '계정과 그래픽 설정',
    text: '닉네임과 구글 연동 같은 계정 기능을 관리합니다.\n\n성능 모드, 적 공격 미리보기, 이펙트 최소화, 히트박스 표시 같은 전투 가시성 옵션도 여기 있습니다.\n\n이 블록 아무 곳이나 누르면 다음으로 넘어갑니다.',
    target: '[data-tutorial="options-account-graphics"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '음향 설정',
    text: '전체 음소거와 볼륨을 조절합니다.\n\n전체 음소거는 모든 효과음을 즉시 끄고, 볼륨은 전투음과 UI 소리의 크기를 조절합니다.\n\n이 블록 아무 곳이나 누르면 다음으로 넘어갑니다.',
    target: '[data-tutorial="options-sound"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '조작과 키 설정',
    text: '모바일 조이스틱, 자동 조준 보조, 자동 공격 보조, 키 설정을 바꿉니다.\n\n키 설정 버튼을 누르면 점프, 대시, 스킬, 궁극기 키를 직접 지정할 수 있습니다.\n\n이 블록 아무 곳이나 누르면 다음으로 넘어갑니다.',
    target: '[data-tutorial="options-controls"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '설정에서 키설정과 모바일 옵션을 확인했다면 다시 게시판으로 돌아갑니다.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '바로 플레이 확인',
    text: '바로 플레이는 방을 만들거나 대기하지 않고 AI와 즉시 전투를 시작하는 봇전 진입 메뉴입니다.\n\n전투 감각, 조작, 새로 받은 무기의 동작을 빠르게 확인할 때 사용합니다.',
    target: '[data-module="quickplay"]',
    advanceOn: 'module:quickplay',
  },
  {
    title: '바로 플레이 규칙',
    text: '바로 플레이는 방 제작과 같은 설정 UI를 사용합니다.\n\nAI 수와 AI 난이도는 바로 플레이에서만 쓰는 전용 설정입니다.\n\n플랫폼, 엄폐물, 회복 아이템도 봇전에 맞게 조절할 수 있습니다.',
    target: '[data-tutorial="quickplay-rules"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '봇전 요약과 시작',
    text: '오른쪽 블록은 현재 봇전 설정을 요약하고 시작 버튼을 제공합니다.\n\n방 코드나 대기 없이 바로 전투에 들어갑니다.\n\n지금은 설정 확인만 하고 게시판으로 돌아갑니다.',
    target: '[data-tutorial="quickplay-summary"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '바로 플레이에서 돌아가기',
    text: '바로 플레이 설정을 확인했습니다.\n\n게시판으로 돌아가기 버튼을 눌러 로비로 돌아갑니다.',
    target: '#createQuickBack',
    advanceOn: 'hub',
    waitForTarget: true,
    progress: false,
  },
  {
    title: '무기고 확인',
    text: '무기고는 워크샵에서 추가한 무기와 직접 만든 무기를 확인하고 장착하는 곳입니다.\n\n전투에 들어갈 때 어떤 무기를 들고 시작할지 정하는 핵심 메뉴입니다.',
    target: '[data-module="armory"]',
    advanceOn: 'module:armory',
  },
  {
    title: '무기 목록',
    text: '왼쪽 목록에는 보유한 공방 무기들이 표시됩니다.\n\n근접, 원거리, 특수 필터로 원하는 무기 종류를 좁혀 볼 수 있습니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="armory-list"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '무기 상세',
    text: '오른쪽 상세 블록에는 선택한 무기의 이미지, 설명, 프리셋, 장착 버튼이 표시됩니다.\n\n여기에서 실제 전투에 들고 갈 무기를 장착합니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="armory-detail"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '무기고 목록과 장착 위치를 확인했다면 다시 게시판으로 돌아갑니다.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '결투장 입장',
    text: '결투장 입장은 다른 플레이어가 만든 방을 탐색하고 참가하는 메뉴입니다.\n\n방 목록에서 상태와 설정을 확인하고, 방 코드가 있다면 직접 입력해서 들어갈 수도 있습니다.',
    target: '[data-module="arena"]',
    advanceOn: 'module:arena',
  },
  {
    title: '방 목록과 코드 입장',
    text: '왼쪽 블록은 방 코드 입력, 새로고침, 열린 방 목록을 담당합니다.\n\n친구에게 받은 방 코드가 있으면 직접 입력하고, 공개 방은 목록에서 선택합니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="arena-list"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '방 상세 정보',
    text: '오른쪽 블록은 선택한 방의 설정과 입장 버튼을 보여줍니다.\n\n플랫폼, 엄폐물, 회복 여부를 확인한 뒤 입장할 수 있습니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="arena-detail"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '결투장 입장 화면을 확인했다면 다시 게시판으로 돌아갑니다.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '방 제작',
    text: '방 제작은 서버에 경기장을 개설하는 메뉴입니다.\n\n플랫폼, 엄폐물, 회복 아이템 같은 경기 규칙을 직접 정하고 방을 만들 수 있습니다.',
    target: '[data-module="create"]',
    advanceOn: 'module:create',
  },
  {
    title: '경기 규칙 블록',
    text: '왼쪽 블록은 플랫폼, 플랫폼 모양, 엄폐물, 회복 아이템을 설정합니다.\n\n방을 만들기 전에 경기의 구조와 난이도를 정하는 곳입니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="create-rules"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '개설 요약 블록',
    text: '오른쪽 블록은 현재 설정 요약, 방 코드, 방 개설 버튼을 보여줍니다.\n\n설정을 확인한 뒤 실제 방을 만들거나 더미방으로 연습할 수 있습니다.\n\n이 블록을 눌러 다음으로 넘어갑니다.',
    target: '[data-tutorial="create-summary"]',
    advanceOn: 'targetClick',
    waitForTarget: true,
  },
  {
    title: '로비로 돌아가기',
    text: '방 제작을 확인했다면 게시판 버튼으로 다시 로비 메뉴로 돌아옵니다.',
    target: '#moduleBackBtn',
    advanceOn: 'hub',
    progress: false,
  },
  {
    title: '무기 공방으로 이동',
    text: '무기 공방은 직접 창작 무기를 만드는 편집기입니다.\n\n프레임별 모션, 히트박스, 투사체, 텔레포트, 이펙트, 장식, 예산 스탯을 조정해서 나만의 무기를 만들 수 있습니다.',
    target: '[data-module="workshop"]',
    advanceOn: 'module:workshop',
  },
  {
    title: '공방 튜토리얼 보기',
    text: '무기 공방 화면의 튜토리얼 보기 버튼을 누르면 제작 편집기 안에서 순서대로 배웁니다.\n\n프리셋, 관절점, 프레임, 판정, 이펙트, 저장 과정을 직접 따라갑니다.\n\n휴대폰에서는 세밀한 제작이 어려우니 PC 또는 태블릿을 권장합니다.',
    target: '#wsGridTutorialBtn',
    advanceOn: 'workshopTutorialStarted',
  },
];
let lobbyTutorialState = null;
let lobbyTutorialSpotlightToken = 0;

function ensureLobbyTutorialStyles() {
  if (document.getElementById('lobbyTutorialStyles')) return;
  const st = document.createElement('style');
  st.id = 'lobbyTutorialStyles';
  st.textContent = `
    #lobbyTutorialScrim{position:fixed;inset:0;z-index:94;pointer-events:none}
    #lobbyTutorialScrim .tut-block{position:fixed;background:rgba(0,0,0,.72);pointer-events:auto;transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease,opacity .12s ease}
    #lobbyTutorialScrim .tut-ring{position:fixed;z-index:1;pointer-events:none;box-sizing:border-box;border:4px solid #ffd24a;border-radius:10px;box-shadow:0 0 24px rgba(255,210,74,.82),inset 0 0 0 1px rgba(255,210,74,.45);transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease,opacity .16s ease;opacity:0}
    #lobbyTutorialCard{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:98;width:min(660px,calc(100vw - 24px));background:#1a1410;border:2px solid #ffd24a;border-radius:8px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.7);font-family:monospace;transition:left .22s ease,top .22s ease,bottom .18s ease,transform .22s ease,opacity .16s ease;opacity:0}
    .lobby-tutorial-active :where(#hubModules.reveal > button,.med-list-item){animation:none!important;opacity:1!important;transform:none!important}
    .lobby-tut-hi{position:relative !important;z-index:97 !important;border-radius:8px}
    .tut-title{color:#ffd24a;font-size:13px;font-weight:800}
    .tut-text{color:#efe7d8;font-size:12px;line-height:1.62}
    .tut-line{margin:0 0 7px 0}
    .tut-line:last-child{margin-bottom:0}
    .tut-em{color:#ffe36a;background:rgba(255,210,74,.14);border:1px solid rgba(255,210,74,.28);border-radius:4px;padding:0 3px;font-weight:800}
    .tut-anim{animation:tutTextIn .24s ease both}
    @keyframes tutTextIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    @media(max-width:640px){
      #lobbyTutorialCard{bottom:10px;padding:12px;width:calc(100vw - 16px)}.tut-text{font-size:11.5px}
      body.lobby-tutorial-active #lobbyMenu,body.lobby-tutorial-active #hubModules{padding-bottom:55vh!important}
      body.lobby-tutorial-active :where(#wsList,#shopBody,#leaderboardBody,#armoryBody,#roomCustomBody,.overflow-y-auto){scroll-padding-top:18vh;scroll-padding-bottom:42vh}
    }
  `;
  document.head.appendChild(st);
}

function formatLobbyTutorialText(text) {
  const terms = [
    '튜토리얼 보기', '무기 공방', '방 제작', '첫 무기', '100화폐', '＋ 추가',
    '워크샵', '무기고', '게시판', '랭킹', '설정', '키설정', '모바일',
    'PC', '태블릿', '결투장', 'AI 수', '플랫폼', '엄폐물', '무료',
    '바로 플레이', '봇전', '방 코드', '장착', '호스트', '업로드',
    '프레임별 모션', '투사체', '텔레포트', '장식', '예산 스탯',
    '닉네임', '구글 연동', '성능 모드', '적 공격 미리보기', '이펙트 최소화',
    '히트박스 표시', '전체 음소거', '볼륨', '모바일 조이스틱',
    '자동 조준 보조', '자동 공격 보조', '키 설정',
  ];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|\\d+화폐)`, 'g');
  return escapeHtml(text)
    .replace(pattern, '<strong class="tut-em">$1</strong>')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="tut-line">${line}</p>`)
    .join('');
}

function lobbyTutorialScrimParts() {
  const scrim = document.getElementById('lobbyTutorialScrim');
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

function setLobbyTutorialSpotlight(target) {
  const scrim = document.getElementById('lobbyTutorialScrim');
  if (!scrim) return;
  const { blocks, ring } = lobbyTutorialScrimParts();
  if (blocks.length !== 4) return;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!target) {
    Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${viewportW}px`, height: `${viewportH}px` });
    for (let i = 1; i < 4; i++) Object.assign(blocks[i].style, { left: '0px', top: '0px', width: '0px', height: '0px' });
    if (ring) ring.style.opacity = '0';
    positionLobbyTutorialCard(null);
    return;
  }
  const rect = lobbyTutorialTargetRect(target);
  if (!rect) {
    setLobbyTutorialSpotlight(null);
    return;
  }
  const pad = 12;
  const left = Math.max(0, rect.left - pad);
  const top = Math.max(0, rect.top - pad);
  const right = Math.min(viewportW, rect.right + pad);
  const bottom = Math.min(viewportH, rect.bottom + pad);
  const holeW = Math.max(0, right - left);
  const holeH = Math.max(0, bottom - top);
  Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${viewportW}px`, height: `${top}px` });
  Object.assign(blocks[1].style, { left: '0px', top: `${bottom}px`, width: `${viewportW}px`, height: `${Math.max(0, viewportH - bottom)}px` });
  Object.assign(blocks[2].style, { left: '0px', top: `${top}px`, width: `${left}px`, height: `${holeH}px` });
  Object.assign(blocks[3].style, { left: `${right}px`, top: `${top}px`, width: `${Math.max(0, viewportW - right)}px`, height: `${holeH}px` });
  if (!holeW || !holeH) Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${viewportW}px`, height: `${viewportH}px` });
  if (ring) Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${holeW}px`, height: `${holeH}px`, opacity: holeW && holeH ? '1' : '0' });
  positionLobbyTutorialCard({ left, top, right, bottom });
  const card = document.getElementById('lobbyTutorialCard');
  if (card) {
    card.dataset.tutorialPlaced = '1';
    requestAnimationFrame(() => { card.style.opacity = '1'; });
  }
}

function prepareLobbyTutorialPendingOverlay() {
  const scrim = document.getElementById('lobbyTutorialScrim');
  if (!scrim) return;
  const { blocks, ring } = lobbyTutorialScrimParts();
  if (blocks.length !== 4) return;
  const card = document.getElementById('lobbyTutorialCard');
  const hasPlacedCard = card?.dataset.tutorialPlaced === '1';
  const hasVisibleRing = ring && ring.style.opacity === '1';
  if (hasPlacedCard || hasVisibleRing) return;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  Object.assign(blocks[0].style, { left: '0px', top: '0px', width: `${viewportW}px`, height: `${viewportH}px` });
  for (let i = 1; i < 4; i++) Object.assign(blocks[i].style, { left: '0px', top: '0px', width: '0px', height: '0px' });
  if (ring) ring.style.opacity = '0';
  if (card) card.style.opacity = '0';
}

function lobbyTutorialHost() {
  return document.body;
}

function lobbyTutorialTargetRect(target) {
  if (!target) return null;
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
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);
  const right = Math.round(rect.right);
  const bottom = Math.round(rect.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function positionLobbyTutorialCard(rect) {
  const card = document.getElementById('lobbyTutorialCard');
  if (!card) return;
  if (!rect) {
    Object.assign(card.style, { left: '50%', top: '', bottom: '18px', transform: 'translateX(-50%)' });
    return;
  }
  const gap = 16;
  const margin = 12;
  const cr = card.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportTop = 0;
  const viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
  const width = Math.min(cr.width || 560, viewportW - margin * 2);
  const height = cr.height || 120;
  let x = (rect.left + rect.right) / 2 - width / 2;
  x = Math.max(margin, Math.min(viewportW - width - margin, x));
  let y = rect.bottom + gap;
  if (y + height > viewportBottom - margin) y = rect.top - height - gap;
  if (y < viewportTop + margin) y = Math.max(viewportTop + margin, viewportBottom - height - margin);
  Object.assign(card.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', transform: 'none' });
}

function emitLobbyTutorialEvent(kind, detail = {}) {
  window.dispatchEvent(new CustomEvent('pixelroyale:lobby-tutorial-event', { detail: { ...detail, kind } }));
}

function keepLobbyTutorialXStable() {
  try {
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
    window.scrollTo(0, window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0);
  } catch {}
}

function scrollLobbyTutorialTargetY(target) {
  if (!target) return;
  keepLobbyTutorialXStable();
  if (isPhoneDevice()) {
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }
  const scroller = target.closest('#wsList, #shopBody, #leaderboardBody, #armoryBody, #roomCustomBody, .overflow-y-auto');
  if (scroller) {
    const sr = scroller.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    if (tr.top < sr.top + 8) scroller.scrollTop -= (sr.top + 8) - tr.top;
    else if (tr.bottom > sr.bottom - 8) scroller.scrollTop += tr.bottom - (sr.bottom - 8);
  }
  keepLobbyTutorialXStable();
}

function scheduleLobbyTutorialSpotlight(target, step) {
  const stepIndex = lobbyTutorialState?.step;
  const token = ++lobbyTutorialSpotlightToken;
  let lastRect = null;
  let stableFrames = 0;
  const startedAt = performance.now();
  prepareLobbyTutorialPendingOverlay();
  const sync = () => {
    if (!lobbyTutorialState || lobbyTutorialState.step !== stepIndex || token !== lobbyTutorialSpotlightToken) return;
    document.querySelectorAll('.lobby-tut-hi').forEach((n) => n.classList.remove('lobby-tut-hi'));
    const activeStep = LOBBY_TUTORIAL_STEPS[lobbyTutorialState.step];
    if (step && activeStep !== step) return;
    const current = step?.target ? document.querySelector(step.target) : null;
    scrollLobbyTutorialTargetY(current || target);
    current?.classList.add('lobby-tut-hi');
    const focus = current || target || null;
    const rect = focus ? lobbyTutorialTargetRect(focus) : null;
    const stable = rect && lastRect
      && Math.abs(rect.left - lastRect.left) < 1
      && Math.abs(rect.top - lastRect.top) < 1
      && Math.abs(rect.right - lastRect.right) < 1
      && Math.abs(rect.bottom - lastRect.bottom) < 1;
    stableFrames = stable ? stableFrames + 1 : 0;
    lastRect = rect;
    const elapsed = performance.now() - startedAt;
    if (!focus || (elapsed >= 48 && stableFrames >= 2) || elapsed > 620) {
      setLobbyTutorialSpotlight(focus);
      keepLobbyTutorialXStable();
      return;
    }
    keepLobbyTutorialXStable();
    requestAnimationFrame(sync);
  };
  requestAnimationFrame(() => requestAnimationFrame(sync));
}

function lobbyTutorialProgressInfo(stepIndex) {
  const visibleSteps = LOBBY_TUTORIAL_STEPS
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.progress !== false);
  const currentVisible = visibleSteps.findIndex(({ index }) => index === stepIndex);
  const current = currentVisible >= 0
    ? currentVisible
    : visibleSteps.filter(({ index }) => index < stepIndex).length - 1;
  return {
    current: Math.max(0, current),
    total: visibleSteps.length,
    visibleSteps,
  };
}

function handleLobbyTutorialEvent(ev) {
  if (!lobbyTutorialState) return;
  const step = LOBBY_TUTORIAL_STEPS[lobbyTutorialState.step];
  const kind = ev?.detail?.kind || ev;
  const expected = step?.auto || step?.advanceOn;
  if (!expected || expected !== kind) return;
  lobbyTutorialState.step++;
  if (lobbyTutorialState.step >= LOBBY_TUTORIAL_STEPS.length) {
    finishLobbyTutorial(true);
    return;
  }
  setTimeout(renderLobbyTutorial, 180);
}

function finishLobbyTutorial(markSeen = true) {
  window.removeEventListener('pixelroyale:lobby-tutorial-event', handleLobbyTutorialEvent);
  lobbyTutorialState = null;
  lobbyTutorialSpotlightToken++;
  document.body.classList.remove('lobby-tutorial-active');
  document.getElementById('lobbyTutorialCard')?.remove();
  document.getElementById('lobbyTutorialScrim')?.remove();
  document.querySelectorAll('.lobby-tut-hi').forEach((n) => n.classList.remove('lobby-tut-hi'));
  if (markSeen) {
    try { localStorage.setItem(LOBBY_WEAPON_TUTORIAL_KEY, '1'); } catch {}
  }
}

function renderLobbyTutorial() {
  if (!lobbyTutorialState) return;
  ensureLobbyTutorialStyles();
  const step = LOBBY_TUTORIAL_STEPS[lobbyTutorialState.step];
  if (!step) { finishLobbyTutorial(true); return; }

  let scrim = document.getElementById('lobbyTutorialScrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'lobbyTutorialScrim';
    lobbyTutorialHost().appendChild(scrim);
  } else if (scrim.parentElement !== lobbyTutorialHost()) {
    lobbyTutorialHost().appendChild(scrim);
  }
  let card = document.getElementById('lobbyTutorialCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'lobbyTutorialCard';
    lobbyTutorialHost().appendChild(card);
  } else if (card.parentElement !== lobbyTutorialHost()) {
    lobbyTutorialHost().appendChild(card);
  }
  const progress = lobbyTutorialProgressInfo(lobbyTutorialState.step);
  const dots = progress.visibleSteps.map(({ index }, i) => {
    const color = index < lobbyTutorialState.step ? '#7df09a' : i === progress.current ? '#ffd24a' : '#4b4237';
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${color}"></span>`;
  }).join('');
  const isWorkshopTutorialPrompt = step.advanceOn === 'workshopTutorialStarted';
  const skipLabel = isWorkshopTutorialPrompt ? '무기 공방 튜토리얼 보지 않기' : '건너뛰기';
  const skipClass = isWorkshopTutorialPrompt
    ? 'flex-1 bg-[#2a0f12] hover:bg-[#4a151b] border border-[#ff5a5a] text-[#ffd6d6] text-[11px] px-3 py-2 cursor-pointer active:scale-95 transition-colors'
    : 'flex-1 bg-[#14100b] border border-[#6b6156] text-[#8a8175] text-[11px] px-3 py-2 cursor-pointer active:scale-95';
  card.innerHTML = `
    <div class="flex items-center gap-2 mb-1 tut-anim">
      <span>${dots}</span>
      <b class="tut-title">${escapeHtml(step.title)}</b>
      <span class="ml-auto text-[10px] text-[#8a8175]">${progress.current + 1} / ${progress.total}</span>
    </div>
    <div class="tut-text tut-anim">${formatLobbyTutorialText(step.text)}</div>
    <div class="flex gap-2 mt-2">
      <button id="lobbyTutSkip" class="${skipClass}"><span class="tut-anim">${skipLabel}</span></button>
    </div>`;
  card.querySelector('#lobbyTutSkip')?.addEventListener('click', () => finishLobbyTutorial(true));

  document.querySelectorAll('.lobby-tut-hi').forEach((n) => n.classList.remove('lobby-tut-hi'));
  const target = document.querySelector(step.target);
  if (target) {
    if (step.advanceOn === 'targetClick') {
      const onTargetClick = () => emitLobbyTutorialEvent('targetClick');
      target.addEventListener('click', onTargetClick, { once: true });
    }
    scrollLobbyTutorialTargetY(target);
    scheduleLobbyTutorialSpotlight(target, step);
  } else {
    if (step.waitForTarget) {
      prepareLobbyTutorialPendingOverlay();
      const card = document.getElementById('lobbyTutorialCard');
      if (card && card.dataset.tutorialPlaced !== '1') card.style.opacity = '0';
      setTimeout(() => {
        if (lobbyTutorialState && LOBBY_TUTORIAL_STEPS[lobbyTutorialState.step] === step) renderLobbyTutorial();
      }, 320);
    } else {
      setLobbyTutorialSpotlight(null);
    }
  }
}

function startLobbyTutorial({ force = false } = {}) {
  try {
    if (!force && localStorage.getItem(LOBBY_WEAPON_TUTORIAL_KEY) === '1') return;
  } catch {}
  finishLobbyTutorial(false);
  if (isPhoneDevice()) {
    showToast('휴대폰에서는 무기 공방 제작이 어렵습니다. 제작은 PC 또는 태블릿을 권장합니다.');
  }
  window.showLobbyHub?.();
  document.body.classList.add('lobby-tutorial-active');
  lobbyTutorialState = { step: 0 };
  window.removeEventListener('pixelroyale:lobby-tutorial-event', handleLobbyTutorialEvent);
  window.addEventListener('pixelroyale:lobby-tutorial-event', handleLobbyTutorialEvent);
  renderLobbyTutorial();
}

/** Open the workshop editor to edit a saved V2 weapon (full load in the grid task). */
function openWorkshopWeaponForEdit(id) {
  pendingWorkshopEditId = id;
  document.getElementById('workshopBtn')?.click();
}
let pendingWorkshopEditId = null;

/**
 * Tier-2 workshop weapons tab: browse published creations (re-clamped on fetch),
 * equip/unequip, like/report, and (admin) hide. Equipping just stores the def
 * locally → localAppearance → Player.
 */
async function renderWorkshopList(el) {
  if (!el) return;
  const isAdmin = !!accountUI.isAdminUser?.();
  const equippedName = equippedWorkshopWeaponName();
  el.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <span class="font-mono text-[11px] text-[#ffb070] uppercase font-bold">🔧 공방 무기 둘러보기</span>
      <span class="font-mono text-[10px] med-muted">${equippedName ? '장착: <b style="color:#7df09a">' + escapeHtml(equippedName) + '</b>' : '장착 안 함 (기본 무기)'}</span>
    </div>
    <div class="flex gap-1.5 mb-2">
      <button id="wsSortLikes" class="med-btn font-mono text-[10px] px-2 py-1 on">인기</button>
      <button id="wsSortNew" class="med-btn font-mono text-[10px] px-2 py-1">최신</button>
      ${equippedName ? '<button id="wsUnequip" class="med-btn font-mono text-[10px] px-2 py-1" style="color:#c0392b;border-color:#c0392b;margin-left:auto">장착 해제</button>' : ''}
    </div>
    <div id="wsList" class="space-y-2 max-h-[44vh] overflow-y-auto pr-1"><div class="text-center py-6 med-muted font-mono text-[11px]">불러오는 중...</div></div>`;

  el.querySelector('#wsUnequip')?.addEventListener('click', () => { clearWorkshopWeapon(); renderWorkshopList(el); });
  const load = async (sort) => {
    const listEl = el.querySelector('#wsList');
    let items = [];
    try { items = await accountUI.browseWorkshopWeapons?.(sort, 40) || []; } catch {}
    if (!items.length) {
      listEl.innerHTML = `<div class="text-center py-6 med-muted font-mono text-[11px]">게시된 공방 무기가 없습니다.<br>무기 공방에서 만들어 게시해 보세요!</div>`;
      return;
    }
    const eqName = equippedWorkshopWeaponName();
    const liked = likedWsSet();
    listEl.innerHTML = items.map((w, i) => {
      const s = w.stats || {};
      const equipped = w.name === eqName;
      const isLiked = liked.has(w.id);
      return `<div class="med-parch p-2.5 flex items-center justify-between gap-2" data-i="${i}">
        <div class="workshop-list-thumb med-cell shrink-0">${workshopWeaponImageMarkup(w, { className: 'workshop-list-img', fallbackClass: 'text-lg' })}</div>
        <div class="min-w-0 flex-1">
          <div class="font-mono text-[12px] text-white truncate"><span style="color:${w.color || '#ffb070'}">●</span> ${escapeHtml(w.name)} <span class="med-muted text-[9px]">by ${escapeHtml(w.author_name || '익명')}</span></div>
          <div class="font-mono text-[9px] med-muted">⚔${s.damage} · ⏱${s.cooldownMs}ms · ❤${s.maxHp} · 🏃${s.moveSpeed} · ♥${w.likes||0}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button class="med-btn font-mono text-[10px] px-1.5 py-1" data-act="like" title="좋아요" ${isLiked ? 'disabled style="color:#c0392b;opacity:.6"' : ''}>♥</button>
          <button class="med-btn font-mono text-[10px] px-1.5 py-1" data-act="report" title="신고">⚑</button>
          ${isAdmin ? '<button class="med-btn font-mono text-[10px] px-1.5 py-1" data-act="hide" title="숨김(어드민)" style="color:#c0392b">숨김</button>' : ''}
          <button class="med-btn med-btn--blood font-mono text-[10px] px-2 py-1" data-act="add" title="내 무기고에 추가">＋ 추가</button>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-i]').forEach(row => {
      const w = items[Number(row.dataset.i)];
      row.querySelector('[data-act="add"]')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        const freeClaimed = localStorage.getItem(WS_FREE_CLAIM_KEY) === '1';
        const price = freeClaimed ? WORKSHOP_WEAPON_PRICE : 0;
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = price ? '구매 중...' : '추가 중...';
        try {
          if (price > 0) await accountUI.spendWorkshopWeaponCoins?.(price);
          const imported = await importWorkshopWeapon(w);
          const importedId = imported?.id;
          if (!importedId || !loadWorkshopWeaponsV2().some(item => item.id === importedId)) {
            throw new Error('무기고에 추가되지 않았습니다. 저장공간을 확인해 주세요.');
          }
          if (_wsGridEl) renderWorkshopGrid();
          document.querySelector('#armoryBody')?._armoryRefresh?.();
          localStorage.setItem(WS_FREE_CLAIM_KEY, '1');
          Sound.play('uiConfirm');
          btn.textContent = '추가됨 ✓';
          showToast(price > 0
            ? `"${w.name}" 구매 완료 (-${price}화폐)`
            : `"${w.name}" 첫 무기 무료 추가 완료`);
          emitLobbyTutorialEvent('workshopWeaponAdded', { weaponId: importedId });
        } catch (err) {
          btn.disabled = false;
          btn.textContent = oldText;
          showToast(err?.message || '무기 추가 실패');
        }
      });
      row.querySelector('[data-act="like"]')?.addEventListener('click', (ev) => {
        ev.currentTarget.disabled = true;
        ev.currentTarget.style.color = '#c0392b'; ev.currentTarget.style.opacity = '.6';
        if (markWsLiked(w.id)) accountUI.likeWorkshop?.(w.id);   // idempotent: bump the server only on the FIRST like
      });
      row.querySelector('[data-act="report"]')?.addEventListener('click', (ev) => { ev.currentTarget.disabled = true; accountUI.reportWorkshop?.(w.id); ev.currentTarget.textContent = '신고됨'; });
      row.querySelector('[data-act="hide"]')?.addEventListener('click', () => { accountUI.moderateWorkshop?.(w.id, 'hidden'); load(el._wsSort || 'likes'); });
    });
  };
  el._wsSort = 'likes';
  el.querySelector('#wsSortLikes')?.addEventListener('click', (e) => { el._wsSort = 'likes'; e.currentTarget.classList.add('on'); el.querySelector('#wsSortNew')?.classList.remove('on'); load('likes'); });
  el.querySelector('#wsSortNew')?.addEventListener('click', (e) => { el._wsSort = 'created_at'; e.currentTarget.classList.add('on'); el.querySelector('#wsSortLikes')?.classList.remove('on'); load('created_at'); });
  load('likes');
}
function armoryStatusTags(w) {
  const cfg = Weapons[w] || {};
  const text = `${cfg.description || ''} ${cfg.skill || ''} ${Object.keys(cfg).join(' ')}`;
  const tags = [];
  if (cfg.onHitBleed || cfg.sweetBleed || cfg.bleed || /출혈/.test(text)) tags.push(['출혈', '#b32d2d']);
  if (w === 'flamethrower' || /화상|점화|불태|화염 장판/.test(text)) tags.push(['화상', '#d2691e']);
  if (cfg.slow || /둔화/.test(text)) tags.push(['둔화', '#3a6ea5']);
  if (/기절/.test(text)) tags.push(['기절', '#8a6f47']);
  return tags;
}
function armoryWeaponName(w) {
  const card = document.querySelector(`.weapon-card[data-weapon="${w}"] span`);
  return card?.textContent?.trim() || w;
}
function buildArmoryInto(body) {
  const cards = [...document.querySelectorAll('.weapon-card')];
  const weapons = cards.map(c => c.dataset.weapon).filter(w => w && Weapons[w]);
  // Normalisers for the stat bars (compare across the whole arsenal).
  const dps = (w) => { const c = Weapons[w]; if (!Number.isFinite(c.damage)) return 0; return c.automaticAttack === false ? c.damage : c.damage / Math.max(0.2, (c.cooldown || 600) / 1000); };
  const finiteRange = (w) => Number.isFinite(Weapons[w].range) ? Weapons[w].range : 0;
  const max = (fn) => Math.max(...weapons.map(fn), 1);
  const maxDps = max(dps), maxHp = max(w => Weapons[w].maxHp || 0), maxMove = max(w => Weapons[w].moveSpeed || 1), maxRange = max(finiteRange);

  body.innerHTML = `
    <div id="armoryBase">
      <div class="armory-grid">
        <div class="med-parch relative p-3" data-tutorial="armory-list">
          <div class="armory-filter" id="armoryFilter">
            <button class="on" data-cat="전체">전체</button><button data-cat="근접">근접</button>
            <button data-cat="원거리">원거리</button><button data-cat="특수">특수</button>
          </div>
          <div class="armory-chips" id="armoryChips"></div>
          <div class="font-mono text-[10px] med-muted mt-2 text-center" id="armoryCount"></div>
        </div>
        <div class="med-parch med-parch--hi med-ticks relative p-4" id="armoryDetail" data-tutorial="armory-detail"></div>
      </div>
    </div>`;

  const chipsEl = body.querySelector('#armoryChips');
  const detailEl = body.querySelector('#armoryDetail');
  let activeCat = '전체';
  // Selection is either a base weapon key or a workshop weapon id ('ws:<id>').
  let wsList = loadWorkshopWeaponsV2();
  const equippedWsId = () => equippedWorkshopWeaponId();
  if (!weapons.length && !wsList.length) {
    openWorkshopWeaponForEdit(null);
    return;
  }
  let selected = equippedWsId() ? ('ws:' + equippedWsId()) : (wsList[0] ? 'ws:' + wsList[0].id : null);
  const openWorkshopFromEmptyArmory = () => {
    document.getElementById('workshopBtn')?.click();
  };

  // Build every chip ONCE (base arsenal + local workshop weapons). Workshop
  // chips carry a 공방 badge; both share the 근접/원거리/특수 category filter.
  function buildChips() {
    const baseHtml = '';
    const wsHtml = wsList.map(x => `<button class="armory-chip ${('ws:' + x.id) === selected ? 'on' : ''}" data-ws="${x.id}" data-cat="${WS_CAT_KO[x.category] || '근접'}">
        <span class="dot" style="background:${x.color || '#ffb070'}"></span>${escapeHtml(x.name)}<span class="ml-1 text-[8px] px-1 rounded" style="background:#5a3a1a;color:#ffd7a8">공방</span></button>`).join('');
    chipsEl.innerHTML = baseHtml + wsHtml;
    const countEl = body.querySelector('#armoryCount');
    if (countEl) countEl.textContent = `▼ 공방 ${wsList.length}`;
  }
  function applyFilter() {
    chipsEl.querySelectorAll('.armory-chip').forEach(chip => {
      const match = activeCat === '전체' || chip.dataset.cat === activeCat;
      chip.classList.toggle('chip-hidden', !match);
    });
  }
  function markSelected() {
    chipsEl.querySelectorAll('.armory-chip').forEach(chip => {
      const key = chip.dataset.ws ? ('ws:' + chip.dataset.ws) : chip.dataset.w;
      chip.classList.toggle('on', key === selected);
    });
  }
  // Persistent stat bars: the four <fill> elements are created ONCE and only
  // their scaleX/value update on weapon switch, so the CSS transition
  // interpolates prev-weapon → new-weapon in one motion (no DOM regen / 0-reset).
  const BAR_DEFS = [['dmg', '피해', 'var(--med-blood)'], ['hp', '체력', '#5a8f3c'],
    ['spd', '이동', '#c9a227'], ['rng', '사거리', '#8a6f47']];
  const curStat = { dmg: 0, hp: 0, spd: 0, rng: 0 };
  const fadeIn = (el) => { if (!el || motionReduced()) return; el.classList.remove('armory-fade'); void el.offsetWidth; el.classList.add('armory-fade'); };

  function ensureDetailShell() {
    if (detailEl.querySelector('#armoryBars')) return false;
    const bars = BAR_DEFS.map(([k, lbl, col]) =>
      `<div class="armory-stat"><span class="lbl" data-lbl="${k}">${lbl}</span><span class="track"><span class="fill" data-fill="${k}" style="background:${col}"></span></span><span class="val" data-val="${k}">0</span></div>`).join('');
    detailEl.innerHTML = `<div id="armoryHead"></div><div id="armoryBars" class="mt-3">${bars}</div><div id="armoryMeta"></div>`;
    return true;
  }

  // Dispatch: workshop weapon detail vs the base-weapon stat-bar detail.
  function renderDetail() {
    if (!selected && !weapons.length && !wsList.length) {
      detailEl.innerHTML = `
        <div class="h-full min-h-[220px] flex flex-col items-center justify-center text-center gap-3">
          <div class="font-bold text-[#ffd24a]">보유한 무기가 없습니다.</div>
          <div class="font-mono text-[11px] med-muted">무기 공방에서 새 무기를 만들거나 워크샵 무기를 받아오세요.</div>
          <button id="armoryGoWorkshop" class="med-btn med-btn--blood font-mono text-xs px-5 py-2">무기 공방으로 이동</button>
        </div>`;
      detailEl.querySelector('#armoryGoWorkshop')?.addEventListener('click', openWorkshopFromEmptyArmory);
      return;
    }
    if (typeof selected === 'string' && selected.startsWith('ws:')) return renderWorkshopDetail(selected.slice(3));
    selected = wsList[0] ? 'ws:' + wsList[0].id : null;
    if (selected) return renderWorkshopDetail(selected.slice(3));
    return renderDetail();
  }

  /** Workshop weapon detail: identity, preset summary, equip / edit / delete. */
  function renderWorkshopDetail(id) {
    const w = wsList.find(x => x.id === id);
    if (!w) { selected = weapons[0] || (wsList[0] ? 'ws:' + wsList[0].id : null); buildChips(); markSelected(); return renderDetail(); }
    const equipped = equippedWsId() === id;
    const presetChips = PRIMARY_PRESET_KEYS.filter(k => w.presets[k]).map(k => {
      const p = w.presets[k]; const c = p.combat;
      const info = COMBAT_PRESET_KINDS.has(p.kind) && c ? `⚔${c.damage}${p.ranged ? ' 🏹' : ''}` : '';
      return `<span class="armory-tag" style="color:#e8d5a3">${PRESET_LABELS[k] || k}${info ? ' ' + info : ''}</span>`;
    }).join(' ');
    detailEl.innerHTML = `
      <div class="armory-head">
        <div class="armory-sprite med-cell">${workshopWeaponImageMarkup(w, { className: 'armory-workshop-img', fallbackClass: 'text-[26px]' })}</div>
        <div class="min-w-0">
          <div class="font-bold text-lg leading-tight">${escapeHtml(w.name)}<span class="ml-2 text-[9px] px-1 rounded" style="background:#5a3a1a;color:#ffd7a8">공방</span></div>
          <div class="font-mono text-[10px] med-muted">${WS_CAT_KO[w.category] || '근접'} · 체력 ${w.baseStats.maxHp} · 이속 ${w.baseStats.moveSpeed}</div>
        </div>
      </div>
      <div class="font-mono text-[11px] med-desc mt-3 leading-snug" style="border-top:1px dashed var(--med-wood);padding-top:8px">${escapeHtml(w.desc || '설명 없음')}</div>
      <div class="mt-3 flex flex-wrap gap-1">${presetChips || '<span class="med-muted text-[10px]">프리셋 없음</span>'}</div>
      <div class="mt-4 flex items-center gap-2 flex-wrap">
        <button id="wsEquip" class="med-btn ${equipped ? '' : 'med-btn--blood'} font-mono text-xs px-4 py-2">${equipped ? '장착됨 ✓' : '장착하기'}</button>
        <button id="wsEdit" class="med-btn font-mono text-xs px-3 py-2">✏ 편집</button>
        <button id="wsDelete" class="med-btn font-mono text-xs px-3 py-2" style="color:#c0392b;border-color:#c0392b">삭제</button>
        ${equipped ? '<button id="wsUnequipOne" class="med-btn font-mono text-[10px] px-2 py-2" style="color:#8a8175">장착 해제</button>' : ''}
      </div>
      <div class="font-mono text-[10px] med-muted mt-2">장착 시 다음 부활부터 적용됩니다.</div>`;
    detailEl.querySelector('#wsEquip')?.addEventListener('click', () => {
      equipWorkshopWeaponLocal(id); Sound.play('uiConfirm');
      showToast(`${w.name} 장착 완료`); renderDetail(); markSelected();
    });
    detailEl.querySelector('#wsUnequipOne')?.addEventListener('click', () => { unequipWorkshopWeapon(); renderDetail(); });
    detailEl.querySelector('#wsEdit')?.addEventListener('click', () => { openWorkshopWeaponForEdit(id); });
    detailEl.querySelector('#wsDelete')?.addEventListener('click', () => {
      if (!confirm(`"${w.name}" 을(를) 삭제할까요?`)) return;
      deleteWorkshopWeaponLocal(id);
      wsList = loadWorkshopWeaponsV2();
      selected = weapons[0] || (wsList[0] ? 'ws:' + wsList[0].id : null); buildChips(); applyFilter(); markSelected(); renderDetail();
      showToast('삭제되었습니다');
    });
  }

  function renderBaseDetail() {
    const w = selected, c = Weapons[w];
    if (!c) { selected = wsList[0] ? 'ws:' + wsList[0].id : null; return renderDetail(); }
    const skins = accountUI.getEquippedWeaponSkins?.() || {};
    const skinKey = w === 'pistols' ? 'crossbow' : w;
    const tags = armoryStatusTags(w).map(([t, col]) => `<span class="armory-tag" style="color:${col}">${t}</span>`).join(' ');
    const auto = c.automaticAttack !== false;
    const dmgLabel = auto ? '피해/초' : '피해';
    const dmgVal = auto ? dps(w) : c.damage;
    const parsed = {};
    (c.skill || '').split('\n').forEach(line => {
      const m = line.match(/^\s*(LMB|F|R)\s*:\s*(.+)$/);
      if (m) parsed[m[1]] = m[2].split('·')[0].trim();
    });
    const abilities = [['기본', auto ? `자동 평타 · 쿨타임 ${(c.cooldown/1000).toFixed(2)}초` : '평타 없음 (차징형)', 'wood']];
    if (parsed.LMB) abilities.push(['좌클릭', parsed.LMB, 'wood']);
    if (parsed.F) abilities.push(['F', parsed.F, 'blood']);
    if (parsed.R) abilities.push(['R', parsed.R, 'blood']);

    const first = ensureDetailShell();

    // --- head (sprite + name + tags): crossfade ---
    const head = detailEl.querySelector('#armoryHead');
    head.innerHTML = `
      <div class="armory-head">
        <div class="armory-sprite med-cell">${weaponIconMarkup(w, { skin: skins[skinKey] || null })}</div>
        <div class="min-w-0">
          <div class="font-bold text-lg leading-tight">${armoryWeaponName(w)}</div>
          <div class="font-mono text-[10px] med-muted">${w.toUpperCase()} · ${armoryCategory(w)}</div>
          <div class="mt-1 flex gap-1 flex-wrap">${tags}</div>
        </div>
      </div>`;
    fadeIn(head);

    // --- meta (desc + abilities + skins + equip): crossfade ---
    const meta = detailEl.querySelector('#armoryMeta');
    meta.innerHTML = `
      <div class="font-mono text-[11px] med-desc mt-3 leading-snug" style="border-top:1px dashed var(--med-wood);padding-top:8px">${c.description || ''}</div>
      <div class="mt-3 space-y-0.5">
        ${abilities.map(([k, d, cls]) => `<div class="armory-abil"><span class="armory-key ${cls}">${k}</span><span>${d}</span></div>`).join('')}
      </div>
      <div class="mt-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <span class="font-mono text-[10px] med-muted">스킨</span>
          ${['ember','frost','void'].map(s => {
            const col = s === 'ember' ? '#d2691e' : s === 'frost' ? '#3a6ea5' : '#6b3fa0';
            const on = (skins[skinKey] === s) ? 'on' : '';
            return `<span class="armory-skin ${on}" title="${s}" style="background:${col}"></span>`;
          }).join('')}
        </div>
        <button id="armoryEquip" class="med-btn med-btn--blood font-mono text-xs px-5 py-2">장착하기</button>
      </div>
      <div id="armoryEquipNote" class="font-mono text-[10px] med-muted mt-2 hidden">다음 부활 시 적용됩니다.</div>`;
    fadeIn(meta);
    meta.querySelector('#armoryEquip')?.addEventListener('click', () => {
      document.querySelector(`.weapon-card[data-weapon="${w}"]`)?.click();
      unequipWorkshopWeapon();   // picking a base weapon clears the workshop overlay
      meta.querySelector('#armoryEquipNote')?.classList.remove('hidden');
      const b = meta.querySelector('#armoryEquip'); if (b) { b.textContent = '장착됨 ✓'; popElement(b); }
      showToast(`${armoryWeaponName(w)} 장착 완료`);
    });
    meta.querySelectorAll('.armory-skin').forEach(sw => sw.addEventListener('click', () => document.getElementById('shopBtn')?.click()));

    // --- bars (persistent): update scaleX + roll values from previous weapon ---
    const specs = [
      { key: 'dmg', label: dmgLabel, frac: (auto ? dps(w) / maxDps : c.damage / maxDps), to: Number.isFinite(dmgVal) ? dmgVal : null, dec: 0, fallback: '∞' },
      { key: 'hp', label: '체력', frac: (c.maxHp || 0) / maxHp, to: (c.maxHp != null) ? c.maxHp : null, dec: 0, fallback: '-' },
      { key: 'spd', label: '이동', frac: (c.moveSpeed || 1) / maxMove, to: (c.moveSpeed ?? 1), dec: 2, fallback: null },
      { key: 'rng', label: '사거리', frac: Number.isFinite(c.range) ? finiteRange(w) / maxRange : 1, to: Number.isFinite(c.range) ? finiteRange(w) : null, dec: 0, fallback: '벽까지' },
    ];
    const applyBars = () => specs.forEach(s => {
      const fill = detailEl.querySelector(`[data-fill="${s.key}"]`);
      const val = detailEl.querySelector(`[data-val="${s.key}"]`);
      const lbl = detailEl.querySelector(`[data-lbl="${s.key}"]`);
      if (lbl) lbl.textContent = s.label;
      if (fill) fill.style.transform = `scaleX(${Math.max(0.04, Math.min(1, s.frac || 0))})`;
      if (!val) return;
      if (s.to == null) { val.textContent = s.fallback; return; }
      rollStat(val, curStat[s.key] ?? 0, s.to, s.dec);
      curStat[s.key] = s.to;
    });
    // First paint: defer one frame so the 0→value fill transition runs.
    if (first && !motionReduced()) requestAnimationFrame(applyBars); else applyBars();
  }

  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w],[data-ws]'); if (!b) return;
    selected = b.dataset.ws ? ('ws:' + b.dataset.ws) : b.dataset.w;
    markSelected(); renderDetail();
  });
  // Let the workshop editor (Task 4) refresh this grid after save/create/delete.
  body._armoryRefresh = () => { wsList = loadWorkshopWeaponsV2(); buildChips(); applyFilter(); markSelected(); renderDetail(); };
  const onWorkshopStoreChanged = () => body._armoryRefresh?.();
  if (window.__pixelroyaleArmoryStoreListener) window.removeEventListener('pixelroyale:workshop-store-changed', window.__pixelroyaleArmoryStoreListener);
  window.__pixelroyaleArmoryStoreListener = onWorkshopStoreChanged;
  window.addEventListener('pixelroyale:workshop-store-changed', onWorkshopStoreChanged);
  body.querySelector('#armoryFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    activeCat = b.dataset.cat;
    body.querySelectorAll('#armoryFilter button').forEach(x => x.classList.toggle('on', x === b));
    applyFilter();        // visibility toggle only — no re-render
    crossfade(chipsEl);   // tab switch → short opacity crossfade
  });
  buildChips();
  applyFilter();
  renderDetail();
}

/* ===== [06] OPTIONS module — consolidates the scattered lobby settings ===== */
// Visual + control settings moved out of the in-game HUD (C-2). The lobby writes
// localStorage; Game.js / Input.js read it on battle entry (read-only in-match).
const VIS_KEY = 'battle_visual_settings_v1';
const CTRL_KEY = 'battle_control_settings_v1';
function readVisual() { try { return JSON.parse(localStorage.getItem(VIS_KEY) || '{}') || {}; } catch { return {}; } }
function writeVisual(patch) {
  const s = readVisual(); Object.assign(s, patch);
  try { localStorage.setItem(VIS_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}
function readControls() {
  try {
    const s = JSON.parse(localStorage.getItem(CTRL_KEY) || '{}') || {};
    return {
      automaticAttack: s.automaticAttack === undefined ? false : !!s.automaticAttack,
      mobileAimAssist: s.mobileAimAssist === undefined ? true : !!s.mobileAimAssist,
      keybinds: normalizeKeybinds(s.keybinds)
    };
  } catch {
    return { automaticAttack: false, mobileAimAssist: true, keybinds: normalizeKeybinds() };
  }
}
function writeControls(patch) {
  const s = readControls(); Object.assign(s, patch);
  try { localStorage.setItem(CTRL_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'keybinds')) {
    activeGame?.input?.reloadKeybinds?.();
  }
}
// Joystick (Input.js key). Default ON for touch devices when never set.
function readJoystick() { const v = localStorage.getItem('joystick_enabled'); return v === null ? isMobileDevice() : v === 'true'; }
function writeJoystick(on) { try { localStorage.setItem('joystick_enabled', on ? 'true' : 'false'); } catch { /* storage blocked */ } }

function buildOptionsInto(body) {
  const nick = document.getElementById('nicknameInput');
  const perf = document.getElementById('lobbyPerfMode');
  const vis = readVisual();
  const ctrl = readControls();
  // Sliding ON/OFF switch (label + knob). The knob slides + track recolors on toggle.
  const swit = (on) =>
    `<span class="flex items-center gap-2"><span class="med-switch-label font-mono text-[11px]" data-swlbl style="width:30px;text-align:right;color:${on ? 'var(--med-blood)' : 'var(--med-ink-mute)'}">${on ? '켜짐' : '꺼짐'}</span><button class="med-switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="토글"><span class="med-switch-knob"></span></button></span>`;
  const setSwitch = (wrap, on) => {
    const sw = wrap?.querySelector('.med-switch'); const lbl = wrap?.querySelector('[data-swlbl]');
    if (sw) { sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); }
    if (lbl) { lbl.textContent = on ? '켜짐' : '꺼짐'; lbl.style.color = on ? 'var(--med-blood)' : 'var(--med-ink-mute)'; }
  };
  const keyRows = [
    ['left', '왼쪽'],
    ['right', '오른쪽'],
    ['down', '아래/내려가기'],
    ['jump', '점프'],
    ['dash', '대시'],
    ['skill1', '스킬 1'],
    ['skill2', '스킬 2'],
    ['skill3', '스킬 3'],
    ['ultimate', '궁극기'],
  ];

  body.innerHTML = `
    <div class="opts-grid">
      <div class="med-parch relative p-4" data-tutorial="options-account-graphics">
        <div class="opt-head">계정</div>
        <div class="med-muted text-[12px] mb-1">닉네임</div>
        <div class="flex gap-2 mb-3">
          <input id="optNick" class="opt-input flex-1" maxlength="12" value="${(nick?.value || '').replace(/"/g, '&quot;')}" placeholder="플레이어" />
          <button id="optNickSave" class="med-btn font-mono text-[11px] px-3">저장</button>
        </div>
        <button id="optLinkGoogle" class="med-btn w-full font-mono text-[12px] py-2 mb-4 flex items-center justify-center gap-2">
          ${accountUI.isGoogleLinked?.() ? '구글 연동됨 ✓' : '<svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.9 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 2.9-2.2 5.4-4.7 7.1l7.3 5.7c4.3-3.9 6.8-9.7 6.8-17.3z"/><path fill="#FBBC05" d="M10.4 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.3-5.7c-2 1.4-4.6 2.2-7.7 2.2-6.3 0-11.7-3.7-13.6-9.4l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>구글 계정에 연동'}
        </button>
        <div id="optLinkNote" class="hidden font-mono text-[10px] mb-3" style="color:var(--med-blood)"></div>
        <div class="opt-head" style="border-top:1px dashed var(--med-wood);padding-top:12px">그래픽</div>
        <div class="flex justify-between items-center mb-2.5">
          <span class="text-[13px]" style="color:var(--med-ink)">성능 모드 (저사양)</span>
          <span id="optPerf">${swit(!!perf?.checked)}</span>
        </div>
        <div class="flex justify-between items-center mb-2.5">
          <span class="text-[13px]" style="color:var(--med-ink)">적 공격 미리보기 끄기</span>
          <span id="optHidePreview">${swit(!!vis.hideEnemyAttackPreviews)}</span>
        </div>
        <div class="flex justify-between items-center mb-2.5">
          <span class="text-[13px]" style="color:var(--med-ink)">적 이펙트 최소화</span>
          <span id="optMinFx">${swit(!!vis.minimizeEnemyAttackEffects)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-[13px]" style="color:var(--med-ink)">인게임 히트박스 보기</span>
          <span id="optShowHitboxes">${swit(vis.showHitboxes === undefined ? true : !!vis.showHitboxes)}</span>
        </div>
      </div>

      <div class="med-parch relative p-4" data-tutorial="options-sound">
        <div class="opt-head">음향</div>
        <div class="flex justify-between items-center mb-3">
          <span class="text-[13px]" style="color:var(--med-ink)">전체 음소거</span>
          <span id="optMute">${swit(Sound.isMuted())}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="med-muted text-[12px]" style="width:54px">볼륨</span>
          <input id="optVol" type="range" min="0" max="100" step="1" value="${Math.round(Sound.getVolume() * 100)}" class="opt-range flex-1" />
          <span id="optVolVal" class="font-mono text-[11px]" style="width:30px;text-align:right;color:var(--med-ink)">${Math.round(Sound.getVolume() * 100)}</span>
        </div>
      </div>

      <div class="med-parch relative p-4" data-tutorial="options-controls" style="grid-column:1 / -1">
        <div class="opt-head">조작</div>
        <div class="flex justify-between items-center mb-3">
          <span class="text-[13px]" style="color:var(--med-ink)">조이스틱 (모바일 가상 조작)</span>
          <span id="optJoystick">${swit(readJoystick())}</span>
        </div>
        <div class="flex justify-between items-center mb-3">
          <span class="text-[13px]" style="color:var(--med-ink)">모바일 자동 조준 보조</span>
          <span id="optMobileAimAssist">${swit(ctrl.mobileAimAssist)}</span>
        </div>
        <div class="flex justify-between items-center mb-3">
          <span class="text-[13px]" style="color:var(--med-ink)">자동 공격 보조</span>
          <span id="optAutoAttack">${swit(ctrl.automaticAttack)}</span>
        </div>
        <div class="opt-head" style="border-top:1px dashed var(--med-wood);padding-top:12px">키 설정</div>
        <div class="opt-keys">
          ${keyRows.map(([action, label]) => `<div class="flex justify-between items-center gap-2"><span class="med-muted text-[12px]">${label}</span><button class="opt-key opt-keybind" data-keybind="${action}" type="button">${formatKeyCode(ctrl.keybinds[action])}</button></div>`).join('')}
        </div>
        <div class="med-muted text-[11px] mt-2">키 버튼을 누른 뒤 원하는 키를 입력하세요. 조준은 마우스, 평타는 좌클릭/모바일 평 버튼을 사용합니다.</div>
        <button id="optKeyReset" class="med-btn font-mono text-[11px] px-3 mt-3">기본 키로 초기화</button>
        <div class="flex justify-end mt-4">
          <button id="optLogout" class="med-btn font-mono text-[12px] px-5" style="border-color:var(--med-blood);box-shadow:inset 0 0 0 2px var(--med-blood)">로그아웃</button>
        </div>
      </div>
    </div>`;

  // Nickname save → mirror into the real input the match reads.
  body.querySelector('#optNickSave')?.addEventListener('click', async () => {
    const val = body.querySelector('#optNick').value.trim();
    if (!val) return;
    if (nick) nick.value = val;
    const b = body.querySelector('#optNickSave');
    if (b) b.textContent = '저장 중...';
    try {
      await accountUI.saveUsername(val);   // persist to the account (survives reload)
      if (b) { b.textContent = '저장됨 ✓'; popElement(b); setTimeout(() => { if (b) b.textContent = '저장'; }, 1200); }
      showToast('닉네임이 저장됐어요');
    } catch (e) {
      if (b) { b.textContent = '저장 실패'; setTimeout(() => { if (b) b.textContent = '저장'; }, 1500); }
      console.error('username save failed', e);
    }
  });
  // Performance mode → drive the existing checkbox (its change handler persists it).
  body.querySelector('#optPerf')?.addEventListener('click', (e) => {
    if (!e.target.closest('.med-switch') || !perf) return;
    perf.checked = !perf.checked;
    perf.dispatchEvent(new Event('change', { bubbles: true }));
    setSwitch(body.querySelector('#optPerf'), perf.checked);
  });
  // Moved visual settings → localStorage (read by Game.js on battle entry).
  const visToggle = (wrapId, key, defaultValue = false) => body.querySelector(`#${wrapId}`)?.addEventListener('click', (e) => {
    if (!e.target.closest('.med-switch')) return;
    const cur = readVisual()[key];
    const on = !(cur === undefined ? defaultValue : !!cur);
    writeVisual({ [key]: on });
    setSwitch(body.querySelector(`#${wrapId}`), on);
  });
  visToggle('optHidePreview', 'hideEnemyAttackPreviews');
  visToggle('optMinFx', 'minimizeEnemyAttackEffects');
  visToggle('optShowHitboxes', 'showHitboxes', true);
  // Joystick (mobile virtual controls) → Input.js key, applied next battle.
  body.querySelector('#optJoystick')?.addEventListener('click', (e) => {
    if (!e.target.closest('.med-switch')) return;
    const on = !readJoystick();
    writeJoystick(on);
    setSwitch(body.querySelector('#optJoystick'), on);
  });
  const ctrlToggle = (wrapId, key) => body.querySelector(`#${wrapId}`)?.addEventListener('click', (e) => {
    if (!e.target.closest('.med-switch')) return;
    const on = !readControls()[key];
    writeControls({ [key]: on });
    setSwitch(body.querySelector(`#${wrapId}`), on);
  });
  ctrlToggle('optMobileAimAssist', 'mobileAimAssist');
  ctrlToggle('optAutoAttack', 'automaticAttack');
  const refreshKeybindButtons = () => {
    const binds = readControls().keybinds;
    body.querySelectorAll('[data-keybind]').forEach((btn) => {
      btn.textContent = formatKeyCode(binds[btn.dataset.keybind]);
      btn.classList.remove('listening');
    });
  };
  body.querySelector('.opt-keys')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-keybind]');
    if (!btn) return;
    const action = btn.dataset.keybind;
    body.querySelectorAll('[data-keybind]').forEach((b) => b.classList.remove('listening'));
    btn.classList.add('listening');
    btn.textContent = '입력...';
    const onKey = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.code === 'Escape') { refreshKeybindButtons(); return; }
      const code = ev.code || ev.key;
      if (!code) { refreshKeybindButtons(); return; }
      const ctrlNow = readControls();
      const next = normalizeKeybinds(ctrlNow.keybinds);
      const prev = next[action];
      const conflict = Object.entries(next).find(([k, v]) => k !== action && v === code);
      next[action] = code;
      if (conflict) next[conflict[0]] = prev;
      writeControls({ keybinds: next });
      refreshKeybindButtons();
      showToast(`${btn.previousElementSibling?.textContent || '키'}: ${formatKeyCode(code)} 설정`);
    };
    document.addEventListener('keydown', onKey, { once: true, capture: true });
  });
  body.querySelector('#optKeyReset')?.addEventListener('click', () => {
    writeControls({ keybinds: { ...DEFAULT_KEYBINDS } });
    refreshKeybindButtons();
    showToast('키 설정을 기본값으로 되돌렸어요');
  });
  // Mute → Sound engine (stays in sync with the other mute toggles).
  const syncMute = (m) => setSwitch(body.querySelector('#optMute'), m);
  body.querySelector('#optMute')?.addEventListener('click', (e) => {
    if (!e.target.closest('.med-switch')) return;
    Sound.setMuted(!Sound.isMuted());
  });
  const offMute = Sound.onMuteChange(syncMute);
  // Volume.
  const vol = body.querySelector('#optVol');
  vol?.addEventListener('input', () => {
    Sound.setVolume(vol.value / 100);
    body.querySelector('#optVolVal').textContent = vol.value;
  });
  body.querySelector('#optLogout')?.addEventListener('click', () => { offMute(); document.getElementById('logoutBtn')?.click(); });
  // Link a Google account → enables the profile photo for id/password users.
  const linkBtn = body.querySelector('#optLinkGoogle');
  const linkNote = body.querySelector('#optLinkNote');
  if (linkBtn && !accountUI.isGoogleLinked?.()) {
    linkBtn.addEventListener('click', async () => {
      linkBtn.textContent = '연동 중...';
      if (linkNote) linkNote.classList.add('hidden');
      try {
        await accountUI.linkGoogleAccount();
        linkBtn.textContent = '구글 연동됨 ✓';
      } catch (e) {
        linkBtn.textContent = '구글 계정에 연동 (다시 시도)';
        const code = e?.code || '';
        const msg = {
          'auth/operation-not-allowed': 'Firebase 콘솔에서 Google 로그인이 비활성화돼 있어요.',
          'auth/credential-already-in-use': '이 구글 계정은 이미 다른 계정에 연결돼 있어요.',
          'auth/provider-already-linked': '이미 구글이 연동돼 있어요.',
          'auth/popup-blocked': '팝업이 차단됐어요. 팝업 허용 후 다시 시도하세요.',
          'auth/popup-closed-by-user': '팝업을 닫았어요. 다시 시도하세요.',
          'auth/unauthorized-domain': '이 도메인이 Firebase 승인 목록에 없어요.',
        }[code] || (`${code || '오류'} ${e?.message || ''}`).trim();
        if (linkNote) { linkNote.textContent = msg; linkNote.classList.remove('hidden'); }
        console.error('google link failed', e);
      }
    });
  }
}

/* ===== [03] CREATE module — parchment room-setup form ===== */
/* Drives the existing roomCustomModal cfg-opt groups (the source of truth that
   readRoomConfig reads) + hostBtn/dummyBtn, so room creation is untouched. */
function buildCreateInto(body, mode = 'host') {
  const isQuickplay = mode === 'quickplay';
  document.querySelectorAll('[data-room-config-root="active"]').forEach(el => { delete el.dataset.roomConfigRoot; });
  body.dataset.roomConfigRoot = 'active';
  const modal = document.getElementById('roomCustomModal');
  const groupEl = (g) => modal?.querySelector(`[data-config-group="${g}"]`);
  const manualOpts = {
    botDifficulty: [
      { label: '쉬움', value: 'easy', on: false },
      { label: '보통', value: 'normal', on: true },
      { label: '어려움', value: 'hard', on: false },
    ],
  };
  const state = {};
  const opts = (g) => {
    const base = groupEl(g)
      ? [...(groupEl(g)?.querySelectorAll('.cfg-opt') || [])].map(b => ({ label: b.textContent.trim(), value: b.dataset.value, on: b.classList.contains('selected') }))
      : (manualOpts[g] || []);
    return base.map((o, i) => ({ ...o, on: state[g] ? o.value === state[g] : (o.on || (!base.some(x => x.on) && i === 0)) }));
  };
  const selectedOf = (g) => opts(g).find(o => o.on) || opts(g)[0];
  const pickHidden = (g, value) => {
    state[g] = value;
    [...(groupEl(g)?.querySelectorAll('.cfg-opt') || [])].find(b => b.dataset.value === value)?.click();
  };
  const GROUPS = isQuickplay
    ? [['botCount', 'AI 수'], ['botDifficulty', 'AI 난이도'], ['platforms', '플랫폼'], ['platformShape', '플랫폼 모양'], ['cover', '엄폐물'], ['healing', '회복 아이템']]
    : [['platforms', '플랫폼'], ['platformShape', '플랫폼 모양'], ['cover', '엄폐물'], ['healing', '회복 아이템']];
  const stateGroups = new Set([...GROUPS.map(([g]) => g), 'healingRate']);
  for (const group of stateGroups) {
    const selected = selectedOf(group);
    if (selected) state[group] = selected.value;
  }
  const persistState = () => { body.dataset.roomConfigState = JSON.stringify(state); };
  persistState();
  const ONOFF = new Set(['healing']);
  const healingOn = () => selectedOf('healing')?.value === 'on';
  const PLATFORM_COUNT = { none: 0, few: 2, some: 4, many: 6 };
  const PLATFORM_DESC = { none: '발판 없음', few: '발판 2개', some: '발판 4개', many: '발판 6개' };
  const PLATFORM_SHAPE_DESC = { balanced: '좌우 대칭 계층', stairs: '오르내리는 계단형', towers: '양쪽 타워형' };

  const pillInner = (_g, o) => o.label;
  // Segment group: pills + a sliding indicator that glides prev→new selection.
  const segRow = (g) => `<div class="create-seg" data-group="${g}">${opts(g).map(o =>
    `<button class="create-pill ${o.on ? 'on' : ''}" data-g="${g}" data-v="${o.value}">${pillInner(g, o)}</button>`).join('')}<span class="create-seg-ind"></span></div>`;
  // Inline ON/OFF switch markup (knob slides, track recolors, label updates).
  const switchMarkup = (g) => {
    const on = selectedOf(g)?.value === 'on';
    return `<span class="flex items-center gap-2"><span class="med-switch-label font-mono text-[11px]" data-swlbl style="color:${on ? 'var(--med-blood)' : 'var(--med-ink-mute)'}">${on ? '켜짐' : '꺼짐'}</span><button class="med-switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-g="${g}"><span class="med-switch-knob"></span></button></span>`;
  };

  body.innerHTML = `
    <div class="create-grid">
      <div class="med-parch relative p-4" data-tutorial="${isQuickplay ? 'quickplay-rules' : 'create-rules'}">
        ${GROUPS.map(([g, label]) => ONOFF.has(g)
          ? `<div class="mb-3.5 flex items-center justify-between" data-switch-group="${g}">
               <span class="med-muted text-[12px]">${label}</span>${switchMarkup(g)}
             </div>`
          : `<div class="mb-3.5">
               <div class="med-muted text-[12px] mb-1.5">${label}</div>
               ${segRow(g)}
               ${g === 'platformShape' ? '<div id="platformPreview" class="platform-preview"></div>' : ''}
             </div>`).join('')}
        <div id="createHealRate" class="${healingOn() ? '' : 'hidden'}">
          <div class="med-muted text-[12px] mb-1.5">회복 스폰 주기</div>
          ${segRow('healingRate')}
        </div>
      </div>

      <div class="med-parch relative p-4 flex flex-col" data-tutorial="${isQuickplay ? 'quickplay-summary' : 'create-summary'}">
        <div class="opt-head">${isQuickplay ? '봇전 요약' : '개설 요약'}</div>
        <div id="createSummary" class="space-y-1.5 mb-3"></div>
        <div style="height:1px;background:var(--med-gold-dk);opacity:.5;margin:6px 0 12px"></div>
        ${isQuickplay
          ? `<div class="med-muted text-[11px] leading-snug mb-3">방 코드와 대기 없이 즉시 봇전을 시작합니다. AI 수와 난이도는 바로 플레이 전용 설정입니다.</div>
             <button id="createQuickStart" class="med-btn med-btn--blood font-mono text-sm py-2.5 mb-2">봇전 시작</button>
             <button id="createQuickBack" class="med-btn font-mono text-[12px] py-2">게시판으로 돌아가기</button>`
          : `<div class="med-muted text-[11px] mb-1.5">방 코드</div>
             <input id="createCode" class="opt-input mb-3" maxlength="10" placeholder="3글자 이상" value="${(document.getElementById('hostRoomInput')?.value || '').replace(/"/g, '&quot;')}" />
             <button id="createHost" class="med-btn med-btn--blood font-mono text-sm py-2.5 mb-2">방 개설</button>
             <button id="createDummy" class="med-btn font-mono text-[12px] py-2" style="color:#7a3326;border-color:var(--med-blood)">더미방으로 연습</button>`}
      </div>
    </div>`;

  function platformPreviewSlots(shape, count) {
    if (count <= 0) return [];
    const balanced = [
      [22, 68, 23], [55, 68, 23],
      [32, 47, 22], [51, 47, 22],
      [39, 27, 22], [39, 14, 22]
    ];
    const stairs = [
      [13, 72, 22], [27, 58, 22], [43, 44, 22],
      [59, 30, 22], [72, 18, 20], [50, 12, 20]
    ];
    const towers = [
      [17, 68, 22], [61, 68, 22],
      [17, 46, 22], [61, 46, 22],
      [17, 24, 22], [61, 24, 22]
    ];
    const source = ({ stairs, towers, balanced })[shape] || balanced;
    return source.slice(0, count).map(([left, top, width]) => ({ left, top, width }));
  }

  function renderPlatformPreview() {
    const el = body.querySelector('#platformPreview');
    if (!el) return;
    const density = selectedOf('platforms')?.value || 'some';
    const shape = selectedOf('platformShape')?.value || 'balanced';
    const count = PLATFORM_COUNT[density] ?? 4;
    const platforms = platformPreviewSlots(shape, count)
      .map(p => `<span class="platform-preview-step" style="left:${p.left}%;top:${p.top}%;width:${p.width}%"></span>`)
      .join('');
    el.innerHTML = `
      <div class="platform-preview-head">
        <span>${PLATFORM_DESC[density] || density}</span>
        <span>${PLATFORM_SHAPE_DESC[shape] || shape}</span>
      </div>
      <div class="platform-preview-stage" aria-hidden="true">
        <span class="platform-preview-ground"></span>
        ${platforms || '<span class="platform-preview-empty">발판 없음</span>'}
      </div>
      <div class="platform-preview-note">실제 방 생성 시 같은 밀도와 형태 기준으로 배치됩니다.</div>`;
  }

  const summaryEl = body.querySelector('#createSummary');
  function renderSummary() {
    const rows = [
      ...(isQuickplay ? [['AI 수', selectedOf('botCount')?.label], ['AI 난이도', selectedOf('botDifficulty')?.label]] : []),
      ['플랫폼', selectedOf('platforms')?.label], ['플랫폼 모양', selectedOf('platformShape')?.label],
      ['엄폐물', selectedOf('cover')?.label],
      ['회복', healingOn() ? `${selectedOf('healing')?.label}·${selectedOf('healingRate')?.label || '보통'}` : selectedOf('healing')?.label]
    ];
    summaryEl.innerHTML = rows.map(([k, v]) => `<div class="flex justify-between text-[12px]"><span class="med-muted">${k}</span><span style="color:var(--med-ink)">${v || '-'}</span></div>`).join('');
  }
  // Move a segment's indicator over its selected pill. `instant` skips the
  // transition (used for the very first placement so it doesn't grow from 0).
  function placeIndicator(seg, instant) {
    const ind = seg?.querySelector('.create-seg-ind');
    const on = seg?.querySelector('.create-pill.on') || seg?.querySelector('.create-pill');
    if (!ind || !on) return;
    if (instant) ind.style.transition = 'none';
    ind.style.left = on.offsetLeft + 'px';
    ind.style.top = on.offsetTop + 'px';
    ind.style.width = on.offsetWidth + 'px';
    ind.style.height = on.offsetHeight + 'px';
    ind.classList.add('placed');
    if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
  }
  function syncControls(instant) {
    body.querySelectorAll('.create-seg').forEach(seg => {
      const g = seg.dataset.group; const sel = selectedOf(g)?.value;
      seg.querySelectorAll('.create-pill').forEach(p => p.classList.toggle('on', p.dataset.v === sel));
      placeIndicator(seg, instant);
    });
    body.querySelectorAll('[data-switch-group]').forEach(row => {
      const g = row.dataset.switchGroup; const on = selectedOf(g)?.value === 'on';
      const sw = row.querySelector('.med-switch'); const lbl = row.querySelector('[data-swlbl]');
      if (sw) { sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); }
      if (lbl) { lbl.textContent = on ? '켜짐' : '꺼짐'; lbl.style.color = on ? 'var(--med-blood)' : 'var(--med-ink-mute)'; }
    });
    body.querySelector('#createHealRate')?.classList.toggle('hidden', !healingOn());
    renderPlatformPreview();
    renderSummary();
  }

  body.addEventListener('click', (e) => {
    const pill = e.target.closest('.create-pill');
    if (pill) { pickHidden(pill.dataset.g, pill.dataset.v); persistState(); syncControls(false); return; }
    const sw = e.target.closest('.med-switch');
    if (sw?.dataset.g) {
      const on = selectedOf(sw.dataset.g)?.value === 'on';
      pickHidden(sw.dataset.g, on ? 'off' : 'on');
      persistState();
      syncControls(false);
      // The healing-rate segment may have just un-hidden → place its indicator.
      requestAnimationFrame(() => placeIndicator(body.querySelector('#createHealRate .create-seg'), true));
    }
  });
  // First placement needs layout — defer one frame, place without animating.
  requestAnimationFrame(() => body.querySelectorAll('.create-seg').forEach(s => placeIndicator(s, true)));
  renderPlatformPreview();
  const mirrorCode = () => { const h = document.getElementById('hostRoomInput'); if (h) h.value = body.querySelector('#createCode').value.trim(); };
  body.querySelector('#createCode')?.addEventListener('input', mirrorCode);
  body.querySelector('#createHost')?.addEventListener('click', (e) => { mirrorCode(); doHost(false, e.currentTarget); });
  body.querySelector('#createDummy')?.addEventListener('click', (e) => { mirrorCode(); doHost(true, e.currentTarget); });
  body.querySelector('#createQuickStart')?.addEventListener('click', (e) => doBotMatch(e.currentTarget));
  body.querySelector('#createQuickBack')?.addEventListener('click', () => window.showLobbyHub?.());
  renderSummary();
}

/* ===== [02] ARENA module — live room list + detail + join ===== */
const COVER_KO = { none: '없음', few: '적음', some: '보통', many: '많음' };
const PLATFORM_KO = { none: '없음', few: '적음', some: '보통', many: '많음' };
const PLATFORM_SHAPE_KO = { balanced: '균형형', stairs: '계단형', towers: '타워형' };
const RATE_KO = { fast: '빠름', normal: '보통', slow: '느림' };
function buildArenaInto(body) {
  if (window.__clearArenaTimer) window.__clearArenaTimer();
  body.innerHTML = `
    <div class="arena-grid">
      <div class="med-parch relative p-3" data-tutorial="arena-list">
        <div class="flex gap-1.5 mb-2.5">
          <input id="arenaCode" class="opt-input flex-1" maxlength="10" placeholder="방 코드 입장" style="text-transform:uppercase" />
          <button id="arenaJoinCode" class="med-btn font-mono text-[11px] px-3">입장</button>
          <button id="arenaRefresh" class="med-btn font-mono text-[11px] px-2" aria-label="새로고침">⟳</button>
        </div>
        <div id="arenaList" class="arena-list">
          ${'<div class="med-skeleton" style="height:62px;margin-bottom:6px"></div>'.repeat(3)}
        </div>
      </div>
      <div id="arenaDetail" class="med-parch med-parch--hi med-ticks relative p-4" data-tutorial="arena-detail"></div>
    </div>`;

  const listEl = body.querySelector('#arenaList');
  const detailEl = body.querySelector('#arenaDetail');
  let selectedCode = null;
  let rooms = [];

  function applyRooms(nextRooms) {
    rooms = nextRooms || [];
    if (selectedCode && !rooms.some(r => r.code === selectedCode)) selectedCode = null;
    if (!selectedCode && rooms.length) selectedCode = rooms[0].code;
    renderList(); renderDetail();
  }
  function refresh() {
    applyRooms(roomRegistry.list() || []);
  }
  function renderList() {
    if (!rooms.length) {
      listEl.innerHTML = `<div class="text-center py-10 med-muted font-mono text-[11px]">진행 중인 방이 없습니다.<br>방 제작에서 개설해 보세요.</div>`;
      return;
    }
    listEl.innerHTML = rooms.map(r => {
      const cfg = Weapons[r.weapon] || Weapons.sword;
      const badges = roomConfigBadges(r.config).map(b => `<span class="arena-badge">${escapeHtml(b)}</span>`).join('');
      const sel = r.code === selectedCode ? 'on' : '';
      const dummy = r.dummy ? '<span class="arena-badge" style="border-color:var(--med-blood);color:#7a3326">더미방</span>' : '';
      return `<button class="arena-card ${sel}" data-code="${escapeHtml(r.code)}">
        <div class="flex justify-between items-center mb-0.5"><span class="font-mono text-sm" style="color:var(--med-ink);letter-spacing:1px">${escapeHtml(r.code)}</span><span class="font-mono text-[12px]" style="color:var(--med-ink)">${r.players ?? 1}명</span></div>
        <div class="med-muted text-[11px] mb-1">방장 · ${escapeHtml(r.host || r.code)} · <span style="color:${cfg.color}">${cfg.name}</span></div>
        <div class="flex gap-1 flex-wrap">${dummy}${badges}</div>
      </button>`;
    }).join('');
  }
  function renderDetail() {
    const r = rooms.find(x => x.code === selectedCode);
    if (!r) { detailEl.innerHTML = `<div class="med-muted font-mono text-[11px] text-center py-12">방을 선택하세요.</div>`; return; }
    const cfg = Weapons[r.weapon] || Weapons.sword;
    const c = normalizeRoomConfig(r.config);
    const rows = [['플랫폼', PLATFORM_KO[c.platforms] || c.platforms], ['플랫폼 모양', PLATFORM_SHAPE_KO[c.platformShape] || c.platformShape],
      ['엄폐물', COVER_KO[c.cover] || c.cover],
      ['회복', c.healing ? `켜짐 · ${RATE_KO[c.healingRate] || ''}` : '꺼짐']];
    detailEl.innerHTML = `
      <div class="flex justify-between items-start mb-1">
        <span class="font-mono" style="color:var(--med-ink);font-size:22px;letter-spacing:2px">${escapeHtml(r.code)}</span>
        <span class="arena-badge" style="${r.dummy ? 'border-color:var(--med-blood);color:#7a3326' : 'border-color:#8aa050;color:#4a5a20;background:#d7e3b8'}">${r.dummy ? '연습방' : '대기 중'}</span>
      </div>
      <div class="med-muted text-[12px] mb-3">방장 · ${escapeHtml(r.host || r.code)} · 무기 <span style="color:${cfg.color}">${cfg.name}</span> · 인원 ${r.players ?? 1}</div>
      <div style="border-top:1px dashed var(--med-wood);padding-top:10px;margin-bottom:14px">
        <div style="color:var(--med-gold-dk);font-size:11px;letter-spacing:1px;margin-bottom:7px">방 설정</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:12px">
          ${rows.map(([k, v]) => `<div class="flex justify-between"><span class="med-muted">${k}</span><span style="color:var(--med-ink)">${v}</span></div>`).join('')}
        </div>
      </div>
      <button id="arenaJoin" class="med-btn med-btn--blood w-full font-mono text-sm py-2.5" data-idle-label="결투장 입장">결투장 입장</button>`;
    detailEl.querySelector('#arenaJoin')?.addEventListener('click', (e) => startJoin(r.code, e.currentTarget));
  }

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('[data-code]'); if (!card) return;
    selectedCode = card.dataset.code; renderList(); renderDetail();
  });
  body.querySelector('#arenaRefresh')?.addEventListener('click', refresh);
  const codeInput = body.querySelector('#arenaCode');
  const codeBtn = body.querySelector('#arenaJoinCode');
  if (codeBtn) codeBtn.dataset.idleLabel = '입장';
  codeBtn?.addEventListener('click', (e) => { const v = codeInput.value.trim(); if (v) startJoin(v, e.currentTarget); });

  roomRegistry.stopBrowsing();
  roomRegistry.startBrowsing(applyRooms);
  // Let the skeleton paint one frame before the first local fill. The registry's
  // own browse loop handles cross-tab/broker updates after this.
  requestAnimationFrame(refresh);
  window.__clearArenaTimer = () => {
    roomRegistry.stopBrowsing();
    window.__clearArenaTimer = null;
    if (!gameScreen || gameScreen.classList.contains('hidden')) startLobbyBrowsing();
  };
}

/**
 * Low Detail (performance mode) toggle surfaced in the lobby's 내 페이지 tab so
 * mobile players can enable it without entering a match first. Persists to the
 * same localStorage key the in-game Renderer reads on start.
 */
function setupLobbyPerfToggle() {
  const box = document.getElementById('lobbyPerfMode');
  if (!box) return;
  const KEY = 'battle_visual_settings_v1';
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
  };
  box.checked = read().performanceMode === undefined ? isMobileDevice() : Boolean(read().performanceMode);
  // Perf mode also gates decorative UI motion (see styles.css .motion-reduced).
  const applyMotion = () => document.documentElement.classList.toggle('motion-reduced', box.checked);
  applyMotion();
  // If we're defaulting it ON for mobile, persist that once so the in-game panel
  // and Renderer agree on first entry (still fully togglable afterwards).
  if (read().performanceMode === undefined && box.checked) {
    const s = read();
    s.performanceMode = true;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  }
  box.addEventListener('change', () => {
    const s = read();
    s.performanceMode = box.checked;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
    applyMotion();
    // Keep the in-game settings checkbox in sync if it's already in the DOM.
    const inGame = document.getElementById('settingPerformanceMode');
    if (inGame) inGame.checked = box.checked;
  });
}

/**
 * Match end: record this session's stats (kills → coins, +completion/daily bonus)
 * for the logged-in player, then return to the lobby. `stats` is passed by
 * Game.quit(): { kills, deaths, weapon, durationMs, dummy }.
 * Practice (dummy) rooms are never reported — their kills are excluded server-side
 * anyway, and skipping the report avoids farming the completion/daily bonuses.
 */
async function handleMatchEnd(stats) {
  showLobbyScreen();
  if (stats && stats.dummy) return; // 연습방은 보고하지 않음
  if (stats && stats.serverAuthoritative) {
    setTimeout(() => accountUI.refreshProfile?.().catch(() => {}), 1200);
    return;
  }
  try {
    await accountUI.reportMatch(stats || { kills: 0 });
  } catch (e) {
    console.error('reportMatch failed', e);
  }
}

async function syncPrivateWorkshopWeaponsFromAccount() {
  if (!accountUI.myPrivateWorkshopWeapons) return;
  try {
    const items = await accountUI.myPrivateWorkshopWeapons();
    let changed = false;
    for (const item of items || []) {
      const saved = await importWorkshopWeapon(item);
      if (saved) changed = true;
    }
    if (changed) {
      if (_wsGridEl && !_wsGridEl.classList.contains('hidden')) renderWorkshopGrid();
      document.querySelector('#armoryBody')?._armoryRefresh?.();
      refreshWeaponCards();
    }
  } catch (e) {
    console.warn('[workshop] private account sync failed', e);
  }
}

// Run Setup on page launch
// Touch devices (phones AND large tablets like the Galaxy Tab) must use the
// mobile layout regardless of CSS width — pin it via a root class the stylesheet
// keys off, since the lg/md width breakpoints alone misclassify wide tablets.
if (isMobileDevice()) document.documentElement.classList.add('touch-ui');
registerPwa();
setupWeaponSelector();
buildWeaponSwitchPanel();
setupLobbyHub();
document.getElementById('lobbyTutorialReplay')?.addEventListener('click', () => startLobbyTutorial({ force: true }));
setupLobbyPerfToggle();

// Auth gate: account-ui resolves the session and tells us which screen to show.
accountUI.init({
  onEnterLobby: (profile) => {
    // If a match is already running (e.g. a token-refresh auth event fired),
    // don't yank the player out of the game.
    if (activeGame) return;

    bootScreen?.classList.add('hidden');
    authScreen?.classList.add('hidden');
    lobbyMenu.classList.remove('hidden');
    if (typeof window.showLobbyHub === 'function') window.showLobbyHub();

    // Prefill the nickname from the account, unless the user already typed one.
    if (profile && nicknameInput && !nicknameInput.value.trim()) {
      nicknameInput.value = profile.username || '';
    }

    syncPrivateWorkshopWeaponsFromAccount();
    refreshWeaponCards();
    startLobbyBrowsing();
    setTimeout(() => startLobbyTutorial(), 500);
  },
  onRequireLogin: () => {
    bootScreen?.classList.add('hidden');
    authScreen?.classList.remove('hidden');
    lobbyMenu.classList.add('hidden');
    gameScreen.classList.add('hidden');
    stopLobbyBrowsing();
  },
  onEquip: () => {
    refreshWeaponCards();
  },
});

// Guest entry (P5): skip login entirely and drop straight into the lobby. No
// auth state changes, so account-ui never yanks us back to the login screen.
// Everything gameplay works offline; the shop/rank screens nudge a login on
// their own ("게임 플레이는 로그인 없이도 가능합니다").
document.getElementById('guestPlayBtn')?.addEventListener('click', () => {
  Sound.play('uiConfirm');
  bootScreen?.classList.add('hidden');
  authScreen?.classList.add('hidden');
  lobbyMenu.classList.remove('hidden');
  if (typeof window.showLobbyHub === 'function') window.showLobbyHub();
  if (nicknameInput && !nicknameInput.value.trim()) nicknameInput.value = '용사';
  refreshWeaponCards();
  startLobbyBrowsing();
});
