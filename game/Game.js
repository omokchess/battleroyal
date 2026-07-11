/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The CLIENT SHELL around the isomorphic simulation core (sim/GameSim.js).
 *
 * Everything here is browser-only: the render loop, the camera, input capture,
 * the HUD, local juice (hitstop, screen shake, particles, damage popups), client
 * interpolation, and the P2P transport wiring. The simulation itself lives in
 * GameSim and knows about none of it.
 *
 * Game extends GameSim, so the host tab both OWNS a simulation and draws it. A
 * guest never ticks the sim — it renders the snapshots the authority sends.
 */

import { Player } from './Player.js';
import { Projectile } from './Projectile.js';
import { Collision } from './Collision.js';
import { Camera } from './Camera.js';
import { Input, formatKeyCode } from './Input.js';
import { Renderer } from './Renderer.js';
import { Weapons, getEffectiveWeapon, SkillConfig, DashConfig, ComboConfig, MagicConfig, AuxSkillConfig } from './Weapons.js';
import { isMobileDevice } from './Device.js';
import { MsgType, Protocol } from '../multiplayer/Protocol.js';
import { normalizeRoomConfig, arenaDimensions, HEAL_RATES } from './RoomConfig.js';
import { Sound } from './Sound.js';
import { BrowserFx } from './BrowserFx.js';
import { generateCover, resolveCover, coverBlocksSegment, coverRayDistance, coverClearOfPoint, coverBlocksCircle } from './Cover.js';
import { buildLevel, PHYS } from './Level.js';
import { BotBrain, BOT_DIFFICULTY } from './Bot.js';
import { resolveMotion, weaponSetId, sanitizeMotionSetId, canonicalWeaponMotion, canonicalWeaponsSnapshot, setCanonicalWeapon } from './Motion.js';
import { STATUS } from './Status.js';
import { sampleCombatKeys } from './Workshop.js';
import {
  GameSim, RESPAWN_MS,
  sanitizeNickname, sanitizeCostume, sanitizeCosmetics,
  dirFromKeys, sanitizeInputKeys, positiveFinite, clamp01, zoneSnapshot, zoneRenderPayload, zoneIsDamaging, zoneIsOutside, hitboxDamageDivisor, damageTier,
} from './sim/GameSim.js';

function escapeHudHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}


export class Game extends GameSim {
  constructor(canvas, networkManager, costume = null, options = {}) {
    super(options);

    this.canvas = canvas;
    this.networkManager = networkManager;
    // Local player's equipped costume colors { color, accentColor } or null.
    this.localCostume = costume;

    // The sim ranks players but has no idea which one is "me" — decorate the
    // results on the way out so the result screen can highlight the player.
    const onMatchOver = typeof options.onMatchOver === 'function' ? options.onMatchOver : null;
    this.onMatchOver = onMatchOver
      ? (results) => onMatchOver(results.map(r => ({ ...r, isLocal: r.id === this.localPlayerId })))
      : null;

    // Floating damage numbers (local render-only, derived from HP deltas).
    this._dmgPopups = [];
    this._prevHpById = {};

    // Hit feedback — all local render-only, never touches the simulation.
    this._hitstopUntil = 0;
    this._hitFlashUntil = 0;
    this._hitFlashStrength = 0;
    this._killFeed = [];
    this._localFx = [];

    this.renderer = new Renderer(canvas);
    this.camera = new Camera();
    this.input = new Input();
    this.input.reloadKeybinds?.();
    this.controlSettings = this._loadControlSettings();

    this.vibratedRailbeamIds = new Set();
    this.shakenSpearThrowIds = new Set();

    this.localPlayerId = null;

    // The simulation's juice reaches the browser through this sink.
    this.fx = new BrowserFx(this);

    this.lastFrameTime = 0;
    this.animationFrameId = null;
    this.backgroundIntervalId = null;
    this._visibilityChangeHandler = null;
    this._hasQuit = false;
    this.lastInputSentAt = 0;
    this.lastInputSignature = '';
    this.visualSettings = this._loadVisualSettings();
    this._visualSettingsCleanup = null;

    this.onQuitCallback = null;

    this._setupNetworkCallbacks();
  }

  /**
   * Enter Host Mode or Guest client mode
   */
  start(onQuit) {
    this.onQuitCallback = onQuit;
    this.isRunning = true;
    this._hasQuit = false;
    this.resetEntities();
    this.vibratedRailbeamIds = new Set();
    this.shakenSpearThrowIds = new Set();
    this.lastInputSentAt = 0;
    this.lastInputSignature = '';

    this.localPlayerId = this.networkManager.localId;
    // This instance owns the simulation only when it is the host. Guests never
    // tick it; they render snapshots.
    this.isAuthority = !!this.networkManager.isHost;
    this.lastFrameTime = performance.now();
    this.matchStartTime = Date.now(); // wall-clock match start (for telemetry duration)

    // Prepare Controls
    this.input.setupListeners(this.canvas);

    // Initial spawner coordinates
    const localNick = document.getElementById('nicknameInput').value.trim() || 'GLADIATOR';
    const localWeapon = document.querySelector('.weapon-card.selected')?.dataset.weapon || 'sword';

    if (this.networkManager.isHost) {
      // Terrain, the host player, dummies and bots all live in the sim.
      this.beginMatch({
        id: this.localPlayerId,
        nickname: localNick,
        weapon: localWeapon,
        costume: this.localCostume,
        isMobile: isMobileDevice(),           // touch players fire instantly
        mobileAimAssist: !!this.controlSettings.mobileAimAssist,
        automaticAttack: !!this.controlSettings.automaticAttack,
      });

      // Freeze the sim while the tab is backgrounded, then compensate the
      // wall-clock timers on return (rAF is paused, so nothing else ticks).
      this._visibilityChangeHandler = () => {
        if (document.hidden) {
          this._hiddenAt = Date.now();
          if (!this.backgroundIntervalId) {
            this.backgroundIntervalId = -1;
          }
        } else {
          const pauseMs = this._hiddenAt ? Math.max(0, Date.now() - this._hiddenAt) : 0;
          if (pauseMs > 0) {
            Object.values(this.players || {}).forEach(p => {
              if (p?.isDead && p.respawnTime) p.respawnTime += pauseMs;
            });
            if (this.countdownUntil > Date.now()) this.countdownUntil += pauseMs;
          }
          this._hiddenAt = 0;
          if (this.backgroundIntervalId && this.backgroundIntervalId !== -1) {
            clearInterval(this.backgroundIntervalId);
          }
          this.backgroundIntervalId = null;
          this.lastFrameTime = performance.now();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityChangeHandler);
      // The tab can ALREADY be hidden when the match starts — sync once.
      this._visibilityChangeHandler();
    } else {
      // Guest client: Wait for HOST to reply with ROOM_JOINED
      this._announce('CONNECTING...');
    }

    // Hide the OS cursor — the game crosshair replaces it.
    this.canvas.style.cursor = 'none';

    // Trigger frame animations
    this._resizeCanvas();
    this._setupVisualSettingsPanel();
    setTimeout(() => { if (this.isRunning) this._updateHUD(); }, 0);
    setTimeout(() => { if (this.isRunning) this._updateHUD(); }, 120);
    this.animationFrameId = requestAnimationFrame((t) => this._gameLoop(t));

    window.addEventListener('resize', this._resizeBound);
    window.visualViewport?.addEventListener('resize', this._resizeBound);
    window.visualViewport?.addEventListener('scroll', this._resizeBound);
  }

  // Bind resize context (class field: must survive the split)
  _resizeBound = () => this._resizeCanvas();


  _resizeCanvas() {
    // Render at the device's true pixel density so phones/retina screens look
    // crisp. The drawing buffer is dpr× the CSS size; Input scales pointer
    // coordinates by the same ratio so aim stays accurate everywhere.
    // Performance mode renders at CSS resolution (dpr 1); otherwise cap at 2 —
    // 3× quadruples the pixel/shadow work for little visible gain.
    const dpr = this.visualSettings?.performanceMode ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const viewport = window.visualViewport;
    const fallbackWidth = document.documentElement.clientWidth || window.innerWidth || 1;
    const fallbackHeight = document.documentElement.clientHeight || window.innerHeight || 1;
    const cssWidth = Math.max(1, Math.round(viewport?.width || fallbackWidth));
    const cssHeight = Math.max(1, Math.round(viewport?.height || fallbackHeight));
    const screen = document.getElementById('gameScreen') || this.canvas.parentElement;

    if (screen) {
      screen.style.width = `${cssWidth}px`;
      screen.style.height = `${cssHeight}px`;
    }

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }


  _setupVisualSettingsPanel() {
    this._cleanupVisualSettingsPanel();
    this.visualSettings = this._loadVisualSettings();

    const bindings = [
      ['settingHideEnemyPreview', 'hideEnemyAttackPreviews'],
      ['settingMinEnemyEffects', 'minimizeEnemyAttackEffects'],
      ['settingPerformanceMode', 'performanceMode'],
      ['settingShowHitboxes', 'showHitboxes']
    ];

    const cleanups = [];
    bindings.forEach(([id, key]) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.checked = Boolean(this.visualSettings[key]);
      const onChange = () => {
        this.visualSettings[key] = Boolean(input.checked);
        this._saveVisualSettings();
        // Performance mode changes the render resolution (dpr) — reapply now.
        if (key === 'performanceMode') this._resizeCanvas();
      };
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    });

    this._visualSettingsCleanup = () => cleanups.forEach(cleanup => cleanup());
  }


  _cleanupVisualSettingsPanel() {
    if (this._visualSettingsCleanup) {
      this._visualSettingsCleanup();
      this._visualSettingsCleanup = null;
    }
  }


  _loadVisualSettings() {
    // When the player has never touched the toggle, default performance mode ON
    // for mobile/tablet devices (they get the worst frame rates) — but an
    // explicit stored choice (true OR false) always wins, so it stays togglable.
    const perfDefault = isMobileDevice();
    try {
      const parsed = JSON.parse(localStorage.getItem('battle_visual_settings_v1') || '{}') || {};
      return {
        hideEnemyAttackPreviews: Boolean(parsed.hideEnemyAttackPreviews),
        minimizeEnemyAttackEffects: Boolean(parsed.minimizeEnemyAttackEffects),
        showHitboxes: parsed.showHitboxes === undefined ? true : Boolean(parsed.showHitboxes),
        performanceMode: parsed.performanceMode === undefined ? perfDefault : Boolean(parsed.performanceMode)
      };
    } catch {
      return {
        hideEnemyAttackPreviews: false,
        minimizeEnemyAttackEffects: false,
        showHitboxes: true,
        performanceMode: perfDefault
      };
    }
  }


  _saveVisualSettings() {
    try {
      localStorage.setItem('battle_visual_settings_v1', JSON.stringify(this.visualSettings));
    } catch {
      // Visual preferences are optional; ignore blocked storage.
    }
  }


  /**
   * Local physics loop executing at client frame speeds
   */
  _gameLoop(timestamp) {
    if (!this.isRunning) return;
    if (document.hidden) {
      this.lastFrameTime = timestamp;
      this.animationFrameId = requestAnimationFrame((t) => this._gameLoop(t));
      return;
    }

    const deltaTime = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1); // Cap deltaTime to prevent quantum tunneling on lags
    this.lastFrameTime = timestamp;

    const now = this.now();

    if (this.networkManager.isHost) {
      // --- HOST (AUTHORITATIVE) ROUTE ---
      // Update camera over host coordinates
      const hp = this.players[this.localPlayerId];
      if (hp) {
        this.input.setLocalWeapon(hp.weapon);
        this.camera.updateAction(this._cameraFocusPoints(), this.canvas.width, this.canvas.height, this.level);
        if (!hp.isDead) {
          this.input.updateAimAngle(hp, this.camera, this.canvas.width, this.canvas.height, this.mapWidth, this.mapHeight);
          // Feed the local device's input into the sim exactly like a remote
          // client's PLAYER_INPUT/PLAYER_AIM packet would.
          this.applyAim(this.localPlayerId, this.input.aimAngle);
          this.applyInput(this.localPlayerId, this.input.keys);
          // Host applies its own dash/skill directly (it is authoritative).
          const dash = this.input.consumeDash();
          if (dash) {
            const { dx, dy } = this._resolveInputDashVector(dash);
            this._tryDash(hp, dx, dy);
          }
          if (this.input.consumeSkillDown()) {
            Sound.play('skill');
            this._handleSkillPressed(hp, now);
          }
          if (this.input.consumeSkillUp()) {
            this._handleSkillReleased(hp, now);
          }
          if (this.input.consumeTeleport()) {
            this._handleAltSkillPressed(hp, now);
          }
          if (this.input.consumeTeleportUp()) {
            this._handleAltSkillReleased(hp, now);
          }
          if (this.input.consumeBasicAttack()) {
            this._applyMobileAimAssistForAttack(hp, 'basic');
            this._performBasicAttack(hp, getEffectiveWeapon(hp.weapon, hp.buffType), now);
          }
          if (this.input.consumeUltimate()) {
            this._handleUltimatePressed(hp, now);
          }
          const targetCast = this._consumeTargetCastWorld(hp);
          if (targetCast) {
            this._handleTargetCast(hp, targetCast.x, targetCast.y, now);
          }
        }
      }

      // Freeze the simulation once the round is over (the result screen holds
      // the final tableau); the render below keeps drawing the frozen scene.
      // Also frozen while the onboarding card holds the match / countdown runs.
      const holding = this.matchHold || now < this.countdownUntil;
      if (!this.matchOver && !holding) {
        this._updateHostPhysics(deltaTime, now);
        this._updateHUD();    // shell-side; the sim tick must not touch the DOM
      }
      // Deliver whatever the sim queued (state ticks, kill events). Runs every
      // frame, not just ticking ones: kills credited while handling a client
      // action — or during the countdown/hold — must not be stranded.
      this._flushOutbox();

      // Render frame
      this._renderFrame();

    } else {
      // --- CLIENT ROUTE ---
      this._updateClientInterpolations(deltaTime);

      // Transmit inputs to host
      const localPlayer = this.players[this.localPlayerId];
      if (localPlayer && !localPlayer.isDead) {
        this.input.setLocalWeapon(localPlayer.weapon);
        // Update camera position to follow local player (2D platformer follow)
        this.camera.updateAction(this._cameraFocusPoints(), this.canvas.width, this.canvas.height, this.level);

        // Calibrate accurate aiming angle taking camera boundaries into account
        this.input.updateAimAngle(localPlayer, this.camera, this.canvas.width, this.canvas.height, this.mapWidth, this.mapHeight);
        localPlayer.angle = this.input.aimAngle;

        // Dash is applied optimistically for snappy feel, then reconciled by
        // the host. Skills are host-authoritative (they spawn shared entities).
        const dash = this.input.consumeDash();
        if (dash) {
          const { dx, dy } = this._resolveInputDashVector(dash);
          if (localPlayer.startDash(dx, dy)) Sound.play('dash');
          this.networkManager.sendToHost(Protocol.clientAction('dash', dx, dy));
        }
        if (this.input.consumeSkillDown()) {
          Sound.play('skill');
          this.networkManager.sendToHost(Protocol.clientAction('skillDown'));
        }
        if (this.input.consumeSkillUp()) {
          this.networkManager.sendToHost(Protocol.clientAction('skillUp'));
        }
        if (this.input.consumeTeleport()) {
          this.networkManager.sendToHost(Protocol.clientAction('teleport'));
        }
        if (this.input.consumeTeleportUp()) {
          this.networkManager.sendToHost(Protocol.clientAction('teleportUp'));
        }
        if (this.input.consumeBasicAttack()) {
          this._applyMobileAimAssistForAttack(localPlayer, 'basic');
          this.networkManager.sendToHost(Protocol.clientAim(localPlayer.angle));
          this.networkManager.sendToHost(Protocol.clientAction('basicAttack'));
        }
        if (this.input.consumeUltimate()) {
          this.networkManager.sendToHost(Protocol.clientAction('ultimate'));
        }
        const targetCast = this._consumeTargetCastWorld(localPlayer);
        if (targetCast) {
          this.networkManager.sendToHost(Protocol.clientAction('targetCast', 0, 0, targetCast));
        }

        // Optimistic local platformer update for zero input latency feel.
        localPlayer.angle = this.input.aimAngle;
        localPlayer.updatePosition(deltaTime, this.input.keys, this.level);

        this._sendLocalInput(now);
      }

      this._renderFrame();
    }

    // Capture next frame
    this.animationFrameId = requestAnimationFrame((t) => this._gameLoop(t));
  }


  /**
   * Append a kill-feed notice (used by the host on a kill and by clients when
   * they receive a KILL_EVENT). Render-only; expires in the renderer/HUD.
   */
  /**
   * Derive sound cues from synced state (effects + projectiles), so attack/
   * warning sounds play identically on the host and every client with no extra
   * netcode — the same trick the damage popups use.
   */
  _trackSoundCues() {
    if (!this._seenSfxIds) this._seenSfxIds = new Set();
    const seen = this._seenSfxIds;
    const local = this.localPlayerId;

    for (const e of this.effects) {
      const key = 'fx:' + (e.id || `${e.attackerId}-${e.timestamp}-${e.type}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const type = e.type || '';
      if (type === 'sniper_telegraph' || type === 'matchlock_telegraph') {
        // Warning beep for the targets/bystanders — gives a chance to dodge.
        if (e.attackerId !== local) Sound.play('warn');
      } else if (type.startsWith('melee_')) {
        if (e.attackerId === local) {
          const fam = type.includes('slam') ? 'slam' : type.includes('line') ? 'thrust' : 'slash';
          Sound.play(fam);
        }
      }
    }

    for (const p of this.projectiles) {
      const key = 'pj:' + p.id;
      if (!p.id || seen.has(key)) continue;
      seen.add(key);
      if (p.ownerId === local) Sound.play('shoot');
    }

    if (seen.size > 500) this._seenSfxIds = new Set([...seen].slice(-200));

    // Storm warning beep when the zone enters its warning / shrinking phases.
    if (this.zone) {
      const phase = this.zone.phase;
      if (this._prevZonePhase && this._prevZonePhase !== phase &&
          (phase === 'warning' || phase === 'shrinking')) {
        Sound.play('warn');
      }
      this._prevZonePhase = phase;
    }
  }


  _loadControlSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem('battle_control_settings_v1') || '{}') || {};
      return {
        automaticAttack: parsed.automaticAttack === undefined ? false : Boolean(parsed.automaticAttack),
        mobileAimAssist: parsed.mobileAimAssist === undefined ? true : Boolean(parsed.mobileAimAssist)
      };
    } catch {
      return { automaticAttack: false, mobileAimAssist: true };
    }
  }

  /**
   * Focus points for the action camera: the local player (with a small facing
   * look-ahead so the view leads the action) plus every other living player
   * within range, so a 1v1 frames both fighters and zooms by their distance.
   * Far-off players are excluded so a single distant target can't yank the zoom.
   */
  _cameraFocusPoints() {
    const lp = this.players[this.localPlayerId];
    const ax = lp ? lp.x : this.mapWidth / 2;
    const ay = lp ? lp.y : this.mapHeight / 2;
    const pts = [];
    if (lp) pts.push({ x: ax + (lp.isDead ? 0 : (lp.facing || 1) * 70), y: ay });
    const livingCount = Object.values(this.players).filter(p => p && !p.isDead).length;
    if (livingCount >= 3) return pts.length ? pts : [{ x: ax, y: ay }];
    const MAX_SPREAD = 1250;
    for (const id in this.players) {
      if (id === this.localPlayerId) continue;
      const p = this.players[id];
      if (!p || p.isDead) continue;
      if (Math.hypot(p.x - ax, p.y - ay) > MAX_SPREAD) continue;   // ignore far targets
      pts.push({ x: p.x, y: p.y });
    }
    if (!pts.length) pts.push({ x: ax, y: ay });
    return pts;
  }


  _pushKillFeed(evt) {
    if (!this._killFeed) this._killFeed = [];
    const involvesLocal = evt.killerId === this.localPlayerId || evt.victimId === this.localPlayerId;
    if (evt.killerId === this.localPlayerId) Sound.play('kill');
    this._killFeed.push({
      killerName: evt.killerName,
      victimName: evt.victimName,
      weapon: evt.weapon,
      via: evt.via || '',
      killerTitle: evt.killerTitle || null,
      victimTitle: evt.victimTitle || null,
      involvesLocal,
      isLocalKill: evt.killerId === this.localPlayerId,
      born: Date.now()
    });
    if (this._killFeed.length > 6) this._killFeed.shift();
  }


  /**
   * Rebuild the top-right kill-feed DOM. Entries live ~3.5s and fade out near
   * the end. Lines involving the local player are highlighted.
   */
  _renderKillFeed(now) {
    const el = document.getElementById('killFeed');
    if (!el) return;
    const LIFE = 3500;
    this._killFeed = this._killFeed.filter(e => now - e.born < LIFE);
    if (!this._killFeed.length) {
      if (el.childElementCount) el.replaceChildren();
      return;
    }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = this._killFeed.map(e => {
      const age = (now - e.born) / LIFE;
      const opacity = age > 0.8 ? Math.max(0, (1 - age) / 0.2) : 1;
      const wName = (Weapons[e.weapon]?.name) || e.weapon || '';
      const wColor = Weapons[e.weapon]?.color || '#9ca3af';
      const border = e.involvesLocal ? '#facc15' : '#2b3540';
      const killerColor = e.isLocalKill ? '#66fcf1' : '#e5e7eb';
      const victimColor = (e.involvesLocal && !e.isLocalKill) ? '#ff6b6b' : '#9ca3af';
      const via = e.via ? `<span class="text-gray-500">${esc(e.via)}</span> ` : '';
      const title = (t) => (t && t.text)
        ? `<span style="color:${t.color || '#9ca3af'}" class="text-[9px] mr-0.5">${esc(t.text)}</span>` : '';
      return `<div class="bg-[#1f2833]/85 border-2 px-2 py-1 text-[11px] leading-tight drop-shadow"
        style="opacity:${opacity.toFixed(2)};border-color:${border}">
        ${title(e.killerTitle)}<span style="color:${killerColor}" class="font-bold">${esc(e.killerName)}</span>
        <span class="text-gray-500 mx-1">${via}»</span>
        <span style="color:${wColor}" class="font-bold">${esc(wName)}</span>
        <span class="text-gray-500 mx-1">»</span>
        ${title(e.victimTitle)}<span style="color:${victimColor}">${esc(e.victimName)}</span>
      </div>`;
    });
    el.innerHTML = rows.join('');
  }


  /**
   * Queue a weapon swap for the local player — applied on the next respawn.
   * Host applies directly; guests notify the host.
   */
  requestWeaponChange(weapon, workshopWeapon = null, label = '') {
    const isWorkshop = typeof weapon === 'string' && weapon.startsWith('ws:') && workshopWeapon;
    if (!isWorkshop && !Weapons[weapon]) return;
    this.pendingWeaponChoice = weapon; // local UI hint key (shown until respawn)
    this.pendingWeaponChoiceLabel = isWorkshop ? (label || workshopWeapon.name || '공방 무기') : '';
    if (this.networkManager.isHost) {
      const local = this.players[this.localPlayerId];
      if (!local) return;
      // Dummy (practice) room: swap instantly so weapons can be tried back to
      // back. Normal matches still queue the swap until the next respawn.
      if (this.dummyRoom && !local.isDead) {
        if (isWorkshop) this._applyWorkshopWeaponNow(local, workshopWeapon);
        else this._applyWeaponNow(local, weapon);
        this.pendingWeaponChoice = null;
        this.pendingWeaponChoiceLabel = '';
      } else {
        if (isWorkshop) { local.pendingWorkshopWeapon = workshopWeapon; local.pendingWeapon = null; }
        else { local.pendingWeapon = weapon; local.pendingWorkshopWeapon = null; }
      }
    } else {
      this.networkManager.sendToHost(Protocol.selectWeapon(weapon, isWorkshop ? workshopWeapon : null, label));
    }
  }


  _resolveInputDashVector(dash) {
    if (dash && dash !== true && Number.isFinite(dash.dx) && Number.isFinite(dash.dy)) {
      return { dx: dash.dx, dy: dash.dy };
    }
    return this.input.getMoveVector();
  }


  _consumeTargetCastWorld(player = null) {
    const pointer = this.input?.consumeTargetCast?.();
    if (pointer && this.camera && typeof this.camera.toWorld === 'function') {
      const world = this.camera.toWorld(pointer.x, pointer.y, this.canvas.width, this.canvas.height);
      return {
        x: Math.max(0, Math.min(this.mapWidth, world.x)),
        y: Math.max(0, Math.min(this.mapHeight, world.y))
      };
    }

    const directionAngle = this.input?.consumeTargetCastDirection?.();
    if (!Number.isFinite(directionAngle) || !player) return null;
    const dirX = Math.cos(directionAngle);
    const dirY = Math.sin(directionAngle);
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    const dist = Number.isFinite(wallDist) ? Math.max(0, wallDist) : Math.max(this.mapWidth, this.mapHeight);
    const target = {
      x: Math.max(0, Math.min(this.mapWidth, player.x + dirX * dist)),
      y: Math.max(0, Math.min(this.mapHeight, player.y + dirY * dist))
    };
    if (this.input && this.camera && typeof this.camera.toScreen === 'function' && this.canvas) {
      const screen = this.camera.toScreen(target.x, target.y, this.canvas.width, this.canvas.height);
      if (Number.isFinite(screen?.x) && Number.isFinite(screen?.y)) {
        this.input.mouse = { x: screen.x, y: screen.y };
      }
    }
    return target;
  }


  _triggerLocalBowSkillVibrations(effects) {
    effects.forEach(effect => this._triggerLocalBowSkillVibration(effect));
  }


  _triggerLocalBowSkillVibration(effect) {
    if (!effect || effect.type !== 'railbeam' || effect.weapon !== 'bow' || effect.attackerId !== this.localPlayerId) return;

    if (!this.vibratedRailbeamIds) this.vibratedRailbeamIds = new Set();
    const effectId = effect.id || `${effect.attackerId}-${effect.timestamp}`;
    if (this.vibratedRailbeamIds.has(effectId)) return;

    this.vibratedRailbeamIds.add(effectId);
    if (this.vibratedRailbeamIds.size > 64) {
      const oldest = this.vibratedRailbeamIds.values().next().value;
      this.vibratedRailbeamIds.delete(oldest);
    }
    this._vibrateDevice([35, 20, 55]);
  }


  _triggerLocalSpearThrowFeedbacks(effects) {
    effects.forEach(effect => this._triggerLocalSpearThrowFeedback(effect));
  }


  _triggerLocalSpearThrowFeedback(effect) {
    if (!effect || effect.type !== 'railbeam' || effect.weapon !== 'spear' || effect.attackerId !== this.localPlayerId) return;

    if (!this.shakenSpearThrowIds) this.shakenSpearThrowIds = new Set();
    const effectId = effect.id || `${effect.attackerId}-${effect.timestamp}`;
    if (this.shakenSpearThrowIds.has(effectId)) return;

    this.shakenSpearThrowIds.add(effectId);
    if (this.shakenSpearThrowIds.size > 64) {
      const oldest = this.shakenSpearThrowIds.values().next().value;
      this.shakenSpearThrowIds.delete(oldest);
    }

    if (this.camera && typeof this.camera.startShake === 'function') {
      this.camera.startShake(9, 260);
    }
    this._vibrateDevice([45, 25, 35]);
  }


  _vibrateDevice(pattern) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Some browsers expose the API but block vibration by policy.
      }
    }
  }


  _sendLocalInput(now) {
    const keys = sanitizeInputKeys(this.input.keys);
    const aimAngle = Number.isFinite(this.input.aimAngle) ? this.input.aimAngle : 0;
    const signature = [
      keys.w ? 1 : 0,
      keys.a ? 1 : 0,
      keys.s ? 1 : 0,
      keys.d ? 1 : 0,
      keys.ArrowUp ? 1 : 0,
      keys.ArrowDown ? 1 : 0,
      keys.ArrowLeft ? 1 : 0,
      keys.ArrowRight ? 1 : 0,
      aimAngle.toFixed(3)
    ].join('');

    if (signature === this.lastInputSignature && now - this.lastInputSentAt < 50) {
      return;
    }

    this.lastInputSignature = signature;
    this.lastInputSentAt = now;
    this.networkManager.sendToHost(Protocol.clientInput(keys));
    this.networkManager.sendToHost(Protocol.clientAim(aimAngle));
  }


  /**
   * Client-side Coordinate linear interpolations for buffer frames
   */
  _updateClientInterpolations(deltaTime) {
    const now = this.now();

    // Locally drain i-frame / buff timers so the white dash flash and buff aura
    // fade smoothly at 60fps between the ~22Hz host snapshots.
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.iframeTimeLeft > 0) p.iframeTimeLeft = Math.max(0, p.iframeTimeLeft - deltaTime);
      if (p.buffTimeLeft > 0) p.buffTimeLeft = Math.max(0, p.buffTimeLeft - deltaTime);
      if (p.stunTimeLeft > 0) p.stunTimeLeft = Math.max(0, p.stunTimeLeft - deltaTime);
      if (p.burnTimeLeft > 0) p.burnTimeLeft = Math.max(0, p.burnTimeLeft - deltaTime);
      if (p.bleedTimeLeft > 0) p.bleedTimeLeft = Math.max(0, p.bleedTimeLeft - deltaTime);
      if (p.slowTimeLeft > 0) p.slowTimeLeft = Math.max(0, p.slowTimeLeft - deltaTime);
      if (p.altSkillCdLeft > 0) p.altSkillCdLeft = Math.max(0, p.altSkillCdLeft - deltaTime);
      if (p.targetSkillCdLeft > 0) p.targetSkillCdLeft = Math.max(0, p.targetSkillCdLeft - deltaTime);
      this._tickMagicCooldowns(p, deltaTime);
    });

    // Smoothly drag and interpolate positions
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.isDead || id === this.localPlayerId) return; // Wait, allow server correction directly, except local player has prediction

      // Frame-rate-INDEPENDENT smoothing: the fraction is derived from the real
      // elapsed time, so remote players converge in the same wall-clock time at
      // 144fps or 25fps. (The old fixed 0.3/frame made low FPS rubber-band.)
      if (p.targetX !== undefined) {
        const posT = 1 - Math.exp(-22 * deltaTime); // ≈0.30 per frame at 60fps
        const angT = 1 - Math.exp(-26 * deltaTime);
        p.x += (p.targetX - p.x) * posT;
        p.y += (p.targetY - p.y) * posT;
        p.angle = lerpAngle(p.angle, p.targetAngle, angT);
      }
    });

    // Client ticks local projectile moves
    this.projectiles.forEach(p => {
      p.update(deltaTime);
      p.checkWallCollision(this.mapWidth, this.mapHeight);
      // Cover stops projectiles client-side too (host is authoritative, this
      // just avoids a visible pass-through before the next snapshot).
      if (this.cover.length && coverBlocksCircle(this.cover, p.x, p.y, p.radius || 4)) p.isDead = true;
    });
    this.projectiles = this.projectiles.filter(p => !p.isDead);

    // Client decays melee overlay effects locally for perfect visuals
    this.effects.forEach(e => {
      const elapsed = now - e.timestamp;
      e.progress = Math.min(elapsed / e.lifetime, 1);
    });
    this.effects = this.effects.filter(e => e.progress < 1);

    this._updateHUD();
  }


  /**
   * Render composite scene
   */
  _renderFrame() {
    const now = this.now();
    // Always track HP deltas, even during hitstop, so no damage number is lost.
    this._trackDamagePopups(now);
    this._trackSoundCues();

    // Expire local-only juice particles (own lifetime, never broadcast).
    if (this._localFx.length) {
      this._localFx = this._localFx.filter(e => now - e.timestamp < e.lifetime);
    }

    // Hitstop: hold the previously drawn frame (skip re-render). Simulation has
    // already advanced above/around this — only the picture pauses.
    if (now < this._hitstopUntil) return;

    // Local-player damage vignette intensity (fades out over its window).
    const flashLeft = this._hitFlashUntil - now;
    const hitFlash = flashLeft > 0
      ? this._hitFlashStrength * Math.min(1, flashLeft / 220)
      : 0;

    // Storm zone: host owns an instance, clients keep the serialized payload.
    const z = this.zone;
    const storm = zoneRenderPayload(z);
    // Lava-phase banner (P4). Detected here because BOTH host and clients pass
    // through this frame path — clients never run zone.update(), they only
    // receive the serialized phase.
    const stormPhase = storm ? storm.phase : null;
    if (stormPhase !== this._lastStormPhase) {
      if (stormPhase === 'warning') this._announce('⚠ 곧 용암이 차오릅니다!');
      else if (stormPhase === 'shrinking') this._announce('🔥 용암 상승 — 위로 올라가세요!');
      this._lastStormPhase = stormPhase;
    }
    const localP = this.players[this.localPlayerId];
    const zoneOutside = !!(z && localP && !localP.isDead &&
      zoneIsDamaging(z) && zoneIsOutside(z, localP.x, localP.y));

    // Generate simple state packet to supply to standard renderer
    const state = {
      players: this.players,
      projectiles: this.projectiles,
      effects: this.effects,
      localFx: this._localFx,
      damagePopups: this._dmgPopups,
      hitFlash,
      killFeed: this._killFeed,
      cover: this.cover,
      healingItems: this.healingItems,
      mines: this.mines,
      firePatches: this.firePatches,
      storm,
      zoneOutside,
      level: this.level,
      // In mobile joystick mode, the cursor is only flashed for actual target casts.
      cursorPos: this.input ? this.input.getCursorPos() : null
    };

    this.renderer.renderPlatformer(
      state,
      this.localPlayerId,
      this.camera,
      this.level,
      this.visualSettings
    );
  }


  /**
   * Spawn floating damage numbers by watching each player's HP drop frame to
   * frame. Render-only and derived from the synced HP, so it shows on the host
   * AND every client for any character (dummy or player) with no extra netcode.
   */
  _trackDamagePopups(now) {
    const players = this.players || {};
    Object.keys(players).forEach(id => {
      const p = players[id];
      if (!p) return;
      const prev = this._prevHpById[id];
      const cur = p.hp;
      if (prev !== undefined && cur < prev - 0.5) {
        const dmg = Math.round(prev - cur);
        if (dmg > 0) {
          const isLocal = id === this.localPlayerId;
          // Merge rapid hits / DoT ticks on the same target into one number.
          const recent = this._dmgPopups.find(d => d.targetId === id && now - d.born < 140);
          if (recent) {
            recent.amount += dmg;
            recent.born = now;
            recent.x = p.x;
            recent.y = p.y;
            recent.tier = damageTier(recent.amount);
          } else {
            // A small drop on a target with an active DoT is shown as a tick in
            // the DoT's color (burn=orange, bleed=dark red), distinct from hits.
            let dotColor = null;
            if (dmg <= 6) {
              if (p.burnTimeLeft > 0) dotColor = '#fb923c';
              else if (p.bleedTimeLeft > 0) dotColor = '#c0392b';
            }
            this._dmgPopups.push({
              targetId: id, amount: dmg, x: p.x, y: p.y,
              born: now, isLocal,
              tier: damageTier(dmg),
              dotColor,
              // Random horizontal drift so stacked numbers fan out instead of
              // overlapping into an unreadable blob.
              vx: (Math.random() - 0.5) * 2
            });
            if (this._dmgPopups.length > 60) this._dmgPopups.shift();
            // Juice: flash the struck body white + spit a pixel spark burst at the
            // impact. DoT ticks (dmg ≤ 6) get only a faint flash, not a full spark.
            p._hurtFlashUntil = now + (dmg > 6 ? 130 : 70);
            if (dmg > 6 && !dotColor) {
              this._spawnHitSpark(p.x, p.y - (p.halfH || 20) * 0.4, dmg, p.color, now);
            }
          }
          // Local player took damage → screen-edge vignette + camera shake,
          // scaled by how hard the hit was (instakills hit hardest).
          if (isLocal) this._onLocalDamaged(dmg, now);
          // Impact sound for any non-dummy hit you can see (throttled in Sound).
          if (!p.isDummy || isLocal) Sound.play('hit');
        }
      } else if (prev !== undefined && cur > prev + 0.5 && id === this.localPlayerId
                 && (cur - prev) < p.maxHp * 0.4) {
        // Modest HP rise on the local player = healing item pickup (not respawn).
        Sound.play('ready');
      }

      // Death / respawn cues for the local player (isDead transitions).
      const wasDead = this._prevDeadById?.[id];
      if (wasDead !== undefined && wasDead !== p.isDead && id === this.localPlayerId) {
        Sound.play(p.isDead ? 'death' : 'respawn');
      }
      // Juice: a pixel death-burst when anyone you can see dies (derived from the
      // synced isDead flip → fires on host and clients alike). Kill sound + the
      // killer's hitstop/shake are handled host-side in _creditKill.
      if (wasDead === false && p.isDead === true && !p.isDummy) {
        this._spawnDeathBurst(p.x, p.y, p.color, now);
        if (id !== this.localPlayerId) Sound.play('kill');
      }
      if (!this._prevDeadById) this._prevDeadById = {};
      this._prevDeadById[id] = p.isDead;

      this._prevHpById[id] = cur;
    });

    // Drop tracking for players who left, and expire popups after ~900ms.
    Object.keys(this._prevHpById).forEach(id => { if (!players[id]) delete this._prevHpById[id]; });
    this._dmgPopups = this._dmgPopups.filter(d => now - d.born < 900);
  }


  /**
   * Local player got hit — fire the screen-edge vignette and a camera shake,
   * scaled by the hit size. Pure local feedback; simulation is untouched.
   */
  _onLocalDamaged(dmg, now) {
    const strength = clamp01(dmg / 70); // ~full at a 70+ blow (instakills max out)
    this._hitFlashStrength = Math.max(this._hitFlashStrength, 0.4 + strength * 0.6);
    this._hitFlashUntil = now + 260;
    if (this.camera && typeof this.camera.startShake === 'function') {
      this.camera.startShake(5 + strength * 9, 180 + strength * 160);
    }
    this._vibrateDevice(dmg >= 60 ? [60, 30, 60] : [30]);
  }


  /**
   * Freeze the *displayed* frame for a few ms on a landed hit (juice). The
   * simulation keeps running — only rendering pauses. Capped + non-extending so
   * rapid-fire weapons can't stack it into a stutter.
   */
  _triggerHitstop(now, ms = 40) {
    if (now < this._hitstopUntil) return; // already stopping → don't accumulate
    this._hitstopUntil = now + Math.min(70, Math.max(20, ms));
  }


  /** Pixel spark burst at an impact point (local render-only). Particle count +
   *  speed scale with the damage so big blows pop harder. */
  _spawnHitSpark(x, y, dmg, color, now) {
    const n = Math.min(10, 3 + Math.round(dmg / 9));
    const power = Math.min(1.6, 0.6 + dmg / 60);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 180) * power;
      parts.push({ ox: Math.cos(a), oy: Math.sin(a) - 0.4, sp, sz: 2 + Math.random() * 2 });
    }
    this._localFx.push({
      type: 'hit_spark', x, y, parts, color: color || '#ffe9a8',
      timestamp: now, lifetime: 260 + power * 120
    });
    if (this._localFx.length > 80) this._localFx.shift();
  }


  /** Pixel death-burst: a bigger, slower-decaying shower in the victim's color. */
  _spawnDeathBurst(x, y, color, now) {
    const parts = [];
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 320;
      parts.push({ ox: Math.cos(a), oy: Math.sin(a) - 0.5, sp, sz: 2 + Math.random() * 3 });
    }
    this._localFx.push({
      type: 'death_burst', x, y: y - 6, parts, color: color || '#ff5a5a',
      timestamp: now, lifetime: 560
    });
    if (this._localFx.length > 80) this._localFx.shift();
  }


  /**
   * Sync stats to overlay HUD displays
   */
  _updateHUD() {
    this._renderKillFeed(Date.now());

    const local = this.players[this.localPlayerId];
    if (!local) return;
    const hudNow = Date.now();
    if (!this._lastKeybindHudReloadAt || hudNow - this._lastKeybindHudReloadAt > 500) {
      this.input?.reloadKeybinds?.();
      this._lastKeybindHudReloadAt = hudNow;
    }
    this.input?.setLocalWeapon?.(local.weapon);

    // Subtle chime when the main skill cooldown finishes (transition >0 → 0).
    const skillReady = (local.skillCdLeft || 0) <= 0 && !local.isDead;
    if (this._prevSkillReady === false && skillReady) Sound.play('ready');
    this._prevSkillReady = skillReady;

    // Weapon switch panel: mark the equipped weapon and the queued (pending) one.
    const wsp = document.getElementById('weaponSwitchPanel');
    if (wsp) {
      const cur = local.weapon;
      const pend = this.pendingWeaponChoice;
      const curWs = local.workshopWeapon?.id ? `ws:${local.workshopWeapon.id}` : null;
      wsp.querySelectorAll('.weapon-switch').forEach(btn => {
        const w = btn.dataset.ws ? `ws:${btn.dataset.ws}` : btn.dataset.weapon;
        btn.classList.toggle('weapon-current', w === (curWs || cur));
        btn.classList.toggle('weapon-pending', Boolean(pend) && w === pend && pend !== (curWs || cur));
      });
      // Mobile toggle button reflects the equipped (or queued) weapon at a glance.
      const toggleLabel = document.getElementById('weaponToggleCurrent');
      if (toggleLabel) {
        const curName = local.workshopWeapon?.name || Weapons[cur]?.name || '';
        const pendName = this.pendingWeaponChoiceLabel || Weapons[pend]?.name || '';
        toggleLabel.textContent = (pend && pend !== (curWs || cur))
          ? '→' + pendName
          : curName;
      }
    }

    // Mobile skill button: only show it when the equipped weapon actually has a
    // skill (e.g. magicstaff has none), so players never see a dead button.
    const skillBtnEl = document.getElementById('skillBtn');
    if (skillBtnEl) {
      skillBtnEl.classList.toggle('hidden', !this._playerHasVisibleFSkill(local));
    }
    const altSkillBtnEl = document.getElementById('altSkillBtn');
    if (altSkillBtnEl) {
      altSkillBtnEl.classList.toggle('hidden', !this._playerHasVisibleESkill(local));
    }
    const lmbBtnEl = document.getElementById('lmbBtn');
    if (lmbBtnEl) {
      lmbBtnEl.classList.toggle('hidden', !this._playerHasVisibleRSkill(local));
    }

    // HP Bar
    const hpBar = document.getElementById('hudHpBar');
    const hpText = document.getElementById('hudHpText');
    const hpPct = Math.max(0, local.hp / local.maxHp) * 100;
    
    if (hpBar) hpBar.style.width = `${hpPct}%`;
    if (hpText) hpText.textContent = `${Math.ceil(local.hp)} / ${local.maxHp}`;

    // Stats counts
    const killsEl = document.getElementById('hudKills');
    // HUD shows total takedowns (real + practice dummies) so practice still feels
    // rewarding; only `local.kills` (real) is ever reported to the server.
    if (killsEl) killsEl.textContent = local.kills + (local.dummyKills || 0);

    // Round timer / objective pill (only when the match has a limit — bot match).
    const matchInfo = document.getElementById('hudMatchInfo');
    if (matchInfo) {
      if (this.matchDurationMs || this.killTarget) {
        matchInfo.classList.remove('hidden');
        const leftMs = this.matchTimeLeftMs();
        const timeEl = document.getElementById('hudMatchTime');
        if (timeEl && Number.isFinite(leftMs)) {
          const s = Math.ceil(leftMs / 1000);
          timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          timeEl.classList.toggle('text-red-400', s <= 15);
        }
        const objEl = document.getElementById('hudMatchObjective');
        if (objEl) {
          const top = Object.values(this.players).filter(p => !p.isDummy)
            .reduce((m, p) => Math.max(m, p.kills || 0), 0);
          objEl.textContent = this.killTarget ? `최다킬 ${top}/${this.killTarget}` : `최다킬 ${top}`;
        }
      } else {
        matchInfo.classList.add('hidden');
      }
    }

    // Minimal HUD (C-4): only the local player's name + HP + kills remain.
    // Survivor count, weapon badge, room code and ping panels were removed.
    const nameEl = document.getElementById('hudName');
    if (nameEl) nameEl.textContent = local.nickname.toUpperCase();

    // Skill (F) + Dash (Shift) cooldown indicators
    this._updateAbilityHud(local);

    // Respawn Countdown Overlay
    const respawnOverlay = document.getElementById('respawnOverlay');
    const respawnProgressBar = document.getElementById('respawnProgressBar');
    const respawnTimerText = document.getElementById('respawnTimerText');
    
    if (respawnOverlay) {
      if (local.isDead) {
        respawnOverlay.classList.remove('hidden');
        if (respawnTimerText) {
          const remainingSec = ((local.respawnRemainingMs || 0) / 1000).toFixed(1);
          respawnTimerText.textContent = `${remainingSec}s`;
        }
        if (respawnProgressBar) {
          const pct = Math.min(100, Math.max(0, ((local.respawnRemainingMs || 0) / RESPAWN_MS) * 100));
          respawnProgressBar.style.width = `${pct}%`;
        }
      } else {
        respawnOverlay.classList.add('hidden');
      }
    }
  }


  _keyLabel(action) {
    return formatKeyCode(this.input?.keybinds?.[action]);
  }


  _keyStrong(action, className) {
    return `<strong class="${className}">${escapeHudHtml(this._keyLabel(action))}</strong>`;
  }


  _setRowLabel(row, html) {
    const label = row?.querySelector?.('[data-hud-label]') || row?.querySelector?.('span');
    if (label) label.innerHTML = html;
  }


  /**
   * Update the F-skill and Shift-dash readiness widgets.
   */
  _updateAbilityHud(local) {
    const weaponColor = Weapons[local.weapon]?.color || '#d4af37';

    const skillRow = document.getElementById('hudSkillRow');
    const skillState = document.getElementById('hudSkillState');
    const skillBar = document.getElementById('hudSkillBar');
    const hasFSkill = this._playerHasVisibleFSkill(local);
    if (skillRow) skillRow.classList.toggle('hidden', !hasFSkill);
    if (skillRow) this._setRowLabel(skillRow, `${this._keyStrong('skill1', 'text-[#c9a227]')} ${escapeHudHtml(this._workshopSkillName(local, 'skill', '스킬'))}`);
    if (skillState && skillBar && hasFSkill) {
      const sk = SkillConfig[local.weapon];
      const wsSkill = this._workshopSkillCooldownInfo(local, 'skill');
      if (wsSkill) {
        if (wsSkill.left > 0) {
          skillState.textContent = `${wsSkill.left.toFixed(1)}s`;
          skillBar.style.width = `${clamp01(1 - wsSkill.left / wsSkill.total) * 100}%`;
          skillBar.style.background = wsSkill.color;
        } else {
          skillState.textContent = '준비!';
          skillBar.style.width = '100%';
          skillBar.style.background = wsSkill.color;
        }
      } else if (local.weapon === 'magicstaff') {
        const fireCd = local.magicCooldowns?.fireball || 0;
        const total = (MagicConfig.fireball?.cooldownMs || MagicConfig.cooldownMs || 2000) / 1000;
        if (fireCd > 0) {
          skillState.textContent = `${fireCd.toFixed(1)}s`;
          skillBar.style.width = `${clamp01(1 - fireCd / total) * 100}%`;
          skillBar.style.background = '#60a5fa';
        } else {
          skillState.textContent = 'FIRE';
          skillBar.style.width = '100%';
          skillBar.style.background = weaponColor;
        }
      } else if (local.buffTimeLeft > 0) {
        const total = (sk?.buffMs || 1) / 1000;
        skillState.textContent = `버프 ${local.buffTimeLeft.toFixed(1)}s`;
        skillBar.style.width = `${clamp01(local.buffTimeLeft / total) * 100}%`;
        skillBar.style.background = weaponColor;
      } else if (local.greatswordChargeStart > 0) {
        const totalMs = sk?.chargeMaxMs || 3000;
        const chargedMs = Date.now() - local.greatswordChargeStart;
        skillState.textContent = `차지 ${(Math.min(totalMs, chargedMs) / 1000).toFixed(1)}s`;
        skillBar.style.width = `${clamp01(chargedMs / totalMs) * 100}%`;
        skillBar.style.background = weaponColor;
      } else if (local.daggerQte) {
        skillState.textContent = local.daggerQte.phase === 'window' ? 'QTE!' : '표식';
        skillBar.style.width = '100%';
        skillBar.style.background = weaponColor;
      } else if (local.stunTimeLeft > 0) {
        skillState.textContent = `스턴 ${local.stunTimeLeft.toFixed(1)}s`;
        skillBar.style.width = '100%';
        skillBar.style.background = '#f97316';
      } else if (local.spearThrown) {
        skillState.textContent = '비행 중';
        skillBar.style.width = '100%';
        skillBar.style.background = weaponColor;
      } else if (local.skillCdLeft > 0) {
        const total = (sk?.cooldownMs || 1) / 1000;
        skillState.textContent = `${local.skillCdLeft.toFixed(1)}s`;
        skillBar.style.width = `${clamp01(1 - local.skillCdLeft / total) * 100}%`;
        skillBar.style.background = weaponColor;
      } else if (local.weapon === 'bow') {
        const stacks = Math.min(sk?.maxStacks || 5, local.arrowStacks || 0);
        skillState.textContent = `${stacks}/${sk?.maxStacks || 5} 스택`;
        skillBar.style.width = `${clamp01(stacks / (sk?.maxStacks || 5)) * 100}%`;
        skillBar.style.background = stacks > 0 ? weaponColor : '#4b5563';
      } else {
        skillState.textContent = '준비!';
        skillBar.style.width = '100%';
        skillBar.style.background = weaponColor;
      }
    }

    const dashState = document.getElementById('hudDashState');
    const dashBar = document.getElementById('hudDashBar');
    const dashRow = dashState?.closest?.('.mb-2');
    if (dashRow) this._setRowLabel(dashRow, `${this._keyStrong('dash', 'text-[#22d3ee]')} 대시`);
    if (dashState && dashBar) {
      if (local.dashCdLeft > 0) {
        const total = DashConfig.cooldownMs / 1000;
        dashState.textContent = `${local.dashCdLeft.toFixed(1)}s`;
        dashBar.style.width = `${clamp01(1 - local.dashCdLeft / total) * 100}%`;
        dashBar.style.background = '#22d3ee';
      } else {
        dashState.textContent = '준비!';
        dashBar.style.width = '100%';
        dashBar.style.background = '#c9a227';
      }
    }

    const ultimateState = document.getElementById('hudUltimateState');
    const ultimateBar = document.getElementById('hudUltimateBar');
    const ultimateRow = document.getElementById('hudUltimateRow');
    const hasUltimate = this._playerHasWorkshopSkill(local, 'ultimate');
    if (ultimateRow) ultimateRow.classList.toggle('hidden', !hasUltimate);
    if (ultimateRow) this._setRowLabel(ultimateRow, `${this._keyStrong('ultimate', 'text-[#facc15]')} ${escapeHudHtml(this._workshopSkillName(local, 'ultimate', '궁극기'))}`);
    if (ultimateState && ultimateBar && hasUltimate) {
      const gauge = Math.max(0, Math.min(100, Math.round(Number(local.ultimateGauge) || 0)));
      ultimateState.textContent = gauge >= 100 ? '준비!' : `${gauge}/100`;
      ultimateBar.style.width = `${gauge}%`;
      ultimateBar.style.background = gauge >= 100 ? '#facc15' : '#a16207';
    }

    // R teleport cooldown — only the sniper has it, so the row is hidden otherwise.
    const teleportRow = document.getElementById('hudTeleportRow');
    const teleportState = document.getElementById('hudTeleportState');
    const teleportBar = document.getElementById('hudTeleportBar');
    if (teleportRow && teleportState && teleportBar) {
      if (local.weapon === 'sniper') {
        teleportRow.classList.remove('hidden');
        const total = SkillConfig.sniper?.teleportCooldownMs || 4000;
        const leftMs = Math.max(0, (local.teleportReadyAt || 0) - Date.now());
        if (leftMs > 0) {
          teleportState.textContent = `${(leftMs / 1000).toFixed(1)}s`;
          teleportBar.style.width = `${clamp01(1 - leftMs / total) * 100}%`;
          teleportBar.style.background = '#22c55e';
        } else {
          teleportState.textContent = '준비!';
          teleportBar.style.width = '100%';
          teleportBar.style.background = '#22c55e';
        }
      } else {
        teleportRow.classList.add('hidden');
      }
    }
    this._updateExtendedAbilityHud(local);
  }


  _updateExtendedAbilityHud(local) {
    const teleportRow = document.getElementById('hudTeleportRow');
    const teleportState = document.getElementById('hudTeleportState');
    const teleportBar = document.getElementById('hudTeleportBar');
    if (teleportRow && teleportState && teleportBar) {
      const wsSkill2 = this._workshopSkillCooldownInfo(local, 'skill2');
      const usesRRow = this._playerUsesWorkshopWeapon(local)
        ? Boolean(wsSkill2)
        : Boolean(wsSkill2) || this._weaponHasAltSkill(local.weapon);
      if (usesRRow) {
        teleportRow.classList.remove('hidden');
        const label = teleportRow.querySelector('span');
        if (label) {
          if (wsSkill2) label.innerHTML = `${this._keyStrong('skill2', 'text-[#22c55e]')} ${escapeHudHtml(this._workshopSkillName(local, 'skill2', '스킬'))}`;
          else if (local.weapon === 'magicstaff') label.innerHTML = `${this._keyStrong('skill2', 'text-[#a855f7]')} HEAL`;
          else if (local.weapon === 'katana') label.innerHTML = `${this._keyStrong('skill2', 'text-[#f43f5e]')} IAI`;
          else {
            const altLabel = local.weapon === 'sniper'
              ? 'BLINK'
              : AuxSkillConfig[local.weapon]?.alt?.label || '보조 스킬';
            label.innerHTML = `${this._keyStrong('skill2', 'text-[#22c55e]')} ${escapeHudHtml(altLabel)}`;
          }
        }

        const total = wsSkill2 ? wsSkill2.total
          : local.weapon === 'sniper'
          ? SkillConfig.sniper?.teleportCooldownMs || 2000
          : local.weapon === 'katana'
            ? SkillConfig.katana?.iaijutsuCooldownMs || 3000
            : local.weapon === 'magicstaff'
              ? MagicConfig.lifebound?.cooldownMs || MagicConfig.cooldownMs || 2000
              : AuxSkillConfig[local.weapon]?.alt?.cooldownMs || 1000;
        const leftMs = wsSkill2 ? wsSkill2.left * 1000
          : local.weapon === 'magicstaff'
          ? Math.max(0, (local.magicCooldowns?.lifebound || 0) * 1000)
          : local.weapon === 'sniper' || local.weapon === 'katana'
            ? Math.max(0, (local.teleportReadyAt || 0) - Date.now())
            : Math.max(0, (local.altSkillCdLeft || 0) * 1000);

        if (local.weapon === 'sniper' && local.sniperTeleportTargetUntil > Date.now()) {
          teleportState.textContent = 'TARGET';
          teleportBar.style.width = '100%';
          teleportBar.style.background = '#ffffff';
        } else if (local.weapon === 'katana' && local.katanaChargeStart > 0) {
          const chargeTotal = SkillConfig.katana?.iaijutsuChargeMs || 1000;
          const chargedMs = Date.now() - local.katanaChargeStart;
          teleportState.textContent = `${(Math.min(chargeTotal, chargedMs) / 1000).toFixed(1)}s`;
          teleportBar.style.width = `${clamp01(chargedMs / chargeTotal) * 100}%`;
          teleportBar.style.background = '#f43f5e';
        } else if (leftMs > 0) {
          teleportState.textContent = `${(leftMs / 1000).toFixed(1)}s`;
          teleportBar.style.width = `${clamp01(1 - leftMs / (wsSkill2 ? total * 1000 : total)) * 100}%`;
          teleportBar.style.background = wsSkill2 ? wsSkill2.color : (Weapons[local.weapon]?.color || '#22c55e');
        } else {
          teleportState.textContent = local.weapon === 'katana' && !wsSkill2 ? 'HOLD' : '준비!';
          teleportBar.style.width = '100%';
          teleportBar.style.background = wsSkill2 ? wsSkill2.color : local.weapon === 'magicstaff'
            ? '#a855f7'
            : local.weapon === 'katana'
              ? '#f43f5e'
              : Weapons[local.weapon]?.color || '#22c55e';
        }
      } else {
        teleportRow.classList.add('hidden');
      }
    }

    const clickSkillRow = document.getElementById('hudClickSkillRow');
    const clickSkillState = document.getElementById('hudClickSkillState');
    const clickSkillBar = document.getElementById('hudClickSkillBar');
    if (clickSkillRow && clickSkillState && clickSkillBar) {
      const wsSkill3 = this._workshopSkillCooldownInfo(local, 'skill3');
      const usesClickRow = this._playerUsesWorkshopWeapon(local)
        ? Boolean(wsSkill3)
        : Boolean(wsSkill3) || this._weaponHasTargetSkill(local.weapon);
      if (usesClickRow) {
        clickSkillRow.classList.remove('hidden');
        const label = clickSkillRow.querySelector('span');
        if (label) {
          const tLabel = AuxSkillConfig[local.weapon]?.target?.label || '스킬';
          label.innerHTML = wsSkill3
            ? `${this._keyStrong('skill3', 'text-[#93c5fd]')} ${escapeHudHtml(this._workshopSkillName(local, 'skill3', '스킬'))}`
            : local.weapon === 'magicstaff'
            ? `${this._keyStrong('skill3', 'text-[#93c5fd]')} ICE`
            : `${this._keyStrong('skill3', 'text-[#93c5fd]')} ${escapeHudHtml(tLabel)}`;
        }
        const iceCd = wsSkill3 ? wsSkill3.left
          : local.weapon === 'magicstaff'
          ? local.magicCooldowns?.iceShard || 0
          : local.targetSkillCdLeft || 0;
        const total = wsSkill3 ? wsSkill3.total
          : local.weapon === 'magicstaff'
          ? (MagicConfig.iceShard?.cooldownMs || MagicConfig.cooldownMs || 2000) / 1000
          : (AuxSkillConfig[local.weapon]?.target?.cooldownMs || 1000) / 1000;
        if (iceCd > 0) {
          clickSkillState.textContent = `${iceCd.toFixed(1)}s`;
          clickSkillBar.style.width = `${clamp01(1 - iceCd / total) * 100}%`;
          clickSkillBar.style.background = wsSkill3 ? wsSkill3.color : (Weapons[local.weapon]?.color || '#93c5fd');
        } else {
          clickSkillState.textContent = local.weapon === 'magicstaff' && !wsSkill3 ? 'TARGET' : '준비!';
          clickSkillBar.style.width = '100%';
          clickSkillBar.style.background = wsSkill3 ? wsSkill3.color : local.weapon === 'magicstaff' ? '#93c5fd' : (Weapons[local.weapon]?.color || '#93c5fd');
        }
      } else {
        clickSkillRow.classList.add('hidden');
      }
    }
  }


  /**
   * Display floating text notifications
   */
  /** SHELL: deliver everything the simulation queued this tick over P2P. The
   *  game server will do the same with its room's sockets. A solo/offline match
   *  has no peers, so broadcast is a harmless no-op. */
  _flushOutbox() {
    const msgs = this.drainOutbox();
    if (!msgs.length || !this.networkManager) return;
    for (const msg of msgs) this.networkManager.broadcast(msg);
  }


  /**
   * Leave Game Cleanup
   */
  quit() {
    if (this._hasQuit) return;

    // Snapshot this session's stats before teardown (used to award coins + log).
    const local = this.players[this.localPlayerId];
    const matchStats = {
      kills: local?.kills || 0,          // real-opponent kills only (dummies excluded)
      deaths: local?.deaths || 0,
      weapon: local?.weapon || 'sword',
      durationMs: Math.max(0, Date.now() - (this.matchStartTime || Date.now())),
      // Practice & offline bot matches are never reported to the server (no rank/coins).
      dummy: !!this.dummyRoom || !!this.botMatch,
      serverAuthoritative: !this.networkManager?.isHost
    };

    this._hasQuit = true;
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    window.removeEventListener('resize', this._resizeBound);
    window.visualViewport?.removeEventListener('resize', this._resizeBound);
    window.visualViewport?.removeEventListener('scroll', this._resizeBound);
    this._cleanupVisualSettingsPanel();
    
    // Clear background tab active preservation loops
    if (this._visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this._visibilityChangeHandler);
      this._visibilityChangeHandler = null;
    }
    if (this.backgroundIntervalId) {
      clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }

    this.pendingSwordWaves = [];
    this.pendingRailguns = [];
    this.pendingKatanaSlashes = [];
    this.pendingSniperShots = [];
    this.pendingMatchlockShots = [];
    this.pendingMagicShards = [];
    this.pendingSpearThrows = [];
    this.pendingChakrams = [];
    this.pendingMeleeHits = [];    this.pendingHammerSlams = [];
    this.vibratedRailbeamIds = new Set();
    this.shakenSpearThrowIds = new Set();
    this.canvas.style.cursor = '';
    this.input.cleanUp(this.canvas);
    if (this.networkManager) {
      this.networkManager.stop();
    }

    if (this.onQuitCallback) {
      this.onQuitCallback(matchStats);
    }
  }


  /**
   * Wire network listeners to coordinate mutations
   */
  _setupNetworkCallbacks() {
    // HOST RECEIVES PLAYER DATA EXCHANGES
    this.networkManager.on('onPlayerJoined', (remoteId, joinPayload) => {
      if (!this.networkManager.isHost || !this.isRunning) return;

      // Seat the newcomer through the shared, transport-free sim seam (the game
      // server uses the exact same addPlayer). Null = duplicate id → ignore.
      const guestPlayer = this.addPlayer(remoteId, joinPayload);
      if (!guestPlayer) return;

      // Hand-shake ROOM_JOINED to the guest (existing players + arena + seed +
      // canonical weapon defs), then tell everyone else a player joined.
      this.networkManager.sendTo(remoteId, Protocol.roomJoined(
        remoteId,
        this.snapshotPlayers(),
        this.mapWidth,
        this.mapHeight,
        this.roomConfig,
        this.coverSeed,
        canonicalWeaponsSnapshot()   // host-authoritative canonical weapon defs (T1-F)
      ));
      this.networkManager.broadcast({
        type: MsgType.PLAYER_JOINED,
        player: guestPlayer.serialize()
      });
    });

    // GUEST JOINS SUCCESSFULLY
    this.networkManager.on('onConnected', () => {
      this._announce('서버 연결 성공! 동기화 중...');
    });

    // NETWORK EXCHANGES (CLIENT + HOST ROUTING SEPARATIONS)
    this.networkManager.on('onData', (fromId, data) => {
      const now = this.now();

      if (this.networkManager.isHost) {
        // --- HOST HANDLERS ---
        const player = this.players[fromId];
        if (!player) return;

        // Weapon swaps are accepted even while dead (applied on next respawn).
        if (data.type === MsgType.WEAPON_SELECT) {
          this.applyWeaponSelect(player.id, data);
          return;
        }

        if (player.isDead) return;

        if (data.type === MsgType.PLAYER_INPUT) {
          this.applyInput(player.id, data.keys);
        } else if (data.type === MsgType.PLAYER_AIM) {
          this.applyAim(player.id, data.angle);
        } else if (data.type === MsgType.PLAYER_ACTION) {
          this.applyAction(player.id, data, now);
        }
      }
      
      else {
        // --- CLIENT HANDLERS ---
        if (data.type === MsgType.ROOM_JOINED) {
          this.localPlayerId = data.id;
          // Adopt the host's room settings, then trust the explicit map dims it
          // sent (falling back to the size derived from the config).
          this.roomConfig = normalizeRoomConfig(data.roomConfig);
          // Rebuild the identical side-scroller level from the synced config.
          this._buildLevel();
          // Regenerate the host's terrain locally from the shared seed
          // (grass-style deterministic generation — no per-tile data synced).
          this.coverSeed = Number.isFinite(data.coverSeed) ? data.coverSeed : 0;

          // Adopt the host's canonical weapon defs so every peer simulates/renders
          // identically (host authority). Re-sanitized with allowGameplay → clamped,
          // never trusting the raw blob (T1-F).
          if (data.weaponMotions && typeof data.weaponMotions === 'object') {
            for (const weapon in data.weaponMotions) {
              setCanonicalWeapon(weapon, data.weaponMotions[weapon], { allowGameplay: true });
            }
          }

          // Reconstitute players list
          this.players = {};
          Object.keys(data.initialPlayers).forEach(id => {
            const snap = data.initialPlayers[id];
            const p = new Player(snap.id, snap.nickname, snap.weapon, snap.x, snap.y);
            p.deserialize(snap);
            this.players[id] = p;
          });
          // The guest shell spent its connection time at the camera default
          // (0,0). Snap once to the authoritative spawn before normal easing so
          // a newly created/joined room never opens pinned to the arena corner.
          this.camera.snapAction?.(
            this._cameraFocusPoints(),
            this.canvas.width,
            this.canvas.height,
            this.level
          );

          this._announce('전투가 시작되었습니다!');
        } 
        
        else if (data.type === MsgType.PLAYER_JOINED) {
          const snap = data.player;
          if (!this.players[snap.id]) {
            const newcomer = new Player(snap.id, snap.nickname, snap.weapon, snap.x, snap.y);
            newcomer.deserialize(snap);
            this.players[snap.id] = newcomer;
            this._announce(`${newcomer.nickname}님이 전장에 입장했습니다!`);
          }
        } 
        
        else if (data.type === MsgType.KILL_EVENT) {
          this._pushKillFeed(data);
        }

        else if (data.type === MsgType.HOST_CHANGED) {
          this.roomHostId = data.hostId || null;
          if (this.roomHostId === this.localPlayerId) this._announce('방 설정 권한을 이어받았습니다.');
        }

        else if (data.type === MsgType.SERVER_SHUTDOWN) {
          this._announce(data.message || '게임 서버가 재시작됩니다.');
        }

        else if (data.type === MsgType.GAME_STATE) {
          // Reconcile and snap correct positions
          this.remainingPlayersCount = data.remainingPlayersCount;

          // 1. Synchronize other players
          Object.keys(data.players).forEach(id => {
            const snap = data.players[id];
            let p = this.players[id];
            
            if (!p) {
              p = new Player(id, snap.nickname, snap.weapon, snap.x, snap.y);
              this.players[id] = p;
            }

            const isLocalSnapshot = id === this.localPlayerId;
            const wasDead = !!p.isDead;

            p.kills = snap.kills;
            p.isDead = snap.isDead;
            p.nickname = snap.nickname || p.nickname;
            p.weapon = Weapons[snap.weapon] ? snap.weapon : p.weapon;
            p.maxHp = positiveFinite(snap.maxHp) ? snap.maxHp : (Weapons[p.weapon]?.maxHp || p.maxHp || 100);
            p.hp = Number.isFinite(snap.hp) ? Math.min(snap.hp, p.maxHp) : p.maxHp;
            if (!isLocalSnapshot) {
              if (Number.isFinite(snap.vx)) p.vx = snap.vx;
              if (Number.isFinite(snap.vy)) p.vy = snap.vy;
              p.grounded = Boolean(snap.grounded);
            }
            p.respawnRemainingMs = snap.respawnRemainingMs || 0;
            p.iframeTimeLeft = (snap.iframeMs || 0) / 1000;
            p.buffType = snap.buffType || null;
            p.buffTimeLeft = (snap.buffMs || 0) / 1000;
            p.skillCdLeft = (snap.skillCdMs || 0) / 1000;
            p.dashCdLeft = (snap.dashCdMs || 0) / 1000;
            p.stunTimeLeft = (snap.stunMs || 0) / 1000;
            p.spearThrown = Boolean(snap.spearThrown);
            p.flameSpraying = Boolean(snap.flameSpraying);
            p.isMobile = Boolean(snap.isMobile);
            if (Number.isFinite(snap.lastAttackTime)) p.lastAttackTime = snap.lastAttackTime;
            p.attackMotionTag = typeof snap.attackMotionTag === 'string' ? snap.attackMotionTag : null;
            p.lastAttackMotionTag = typeof snap.lastAttackMotionTag === 'string'
              ? snap.lastAttackMotionTag
              : (p.attackMotionTag || p.lastAttackMotionTag || 'attack');
            p.arrowStacks = Math.max(0, Math.floor(snap.arrowStacks || 0));
            p.greatswordChargeStart = snap.greatswordChargeMs > 0 ? Date.now() - snap.greatswordChargeMs : 0;
            p.katanaChargeStart = snap.katanaChargeMs > 0 ? Date.now() - snap.katanaChargeMs : 0;
            p.daggerQte = snap.daggerQte ? {
              targetId: snap.daggerQte.targetId,
              phase: snap.daggerQte.phase || 'lock',
              actionAt: Date.now() + Math.max(0, Math.round(snap.daggerQte.actionMs || 0)),
              perfectAt: Date.now() + Math.max(0, Math.round(snap.daggerQte.perfectMs || 0)),
              expiresAt: Date.now() + Math.max(0, Math.round(snap.daggerQte.expiresMs || 0))
            } : null;
            p.comboStep = Math.max(0, Math.floor(snap.comboStep || 0));
            p.comboDelayUntil = Date.now() + Math.max(0, Math.round(snap.comboDelayMs || 0));
            p.pendingIcicles = Math.max(0, Math.floor(snap.pendingIcicles || 0));
            p.magicCooldowns = deserializeMagicCooldowns(snap.magicCdMs);
            p.wsSkillCd = deserializeWorkshopCooldowns(snap.wsSkillCdMs);
            p.burnTimeLeft = Math.max(0, (snap.burnMs || 0) / 1000);
            p.bleedTimeLeft = Math.max(0, (snap.bleedMs || 0) / 1000);
            p.slowTimeLeft = Math.max(0, (snap.slowMs || 0) / 1000);
            p.ultimateGauge = Math.max(0, Math.min(100, Math.round(Number(snap.ultimateGauge) || 0)));
            p.teleportReadyAt = Date.now() + Math.max(0, Math.round(snap.teleportCdMs || 0));
            p.color = snap.color;
            p.accentColor = snap.accentColor;
            p.costumeDecoration = snap.costumeDecoration || null;
            p.costumeEffect = snap.costumeEffect || null;
            p.motionLockUntil = snap.motionLockMs > 0 ? Date.now() + Math.max(0, Math.round(snap.motionLockMs || 0)) : 0;
            p.motionRootUntil = snap.rootMotionMs > 0 ? Date.now() + Math.max(0, Math.round(snap.rootMotionMs || 0)) : 0;
            p.activeHitboxes = Array.isArray(snap.activeHitboxes) ? snap.activeHitboxes.slice(0, 64) : [];
            if (snap.wsw) {
              const motionSetSig = (() => { try { return JSON.stringify(snap.wsw.motionSet || {}).length; } catch { return 0; } })();
              const visualSig = (() => { try { return JSON.stringify(snap.wsw.weaponVisual || {}).length; } catch { return 0; } })();
              const hatSig = Array.isArray(snap.wsw.hatImages) ? snap.wsw.hatImages.map(h => `${h?.id || ''}:${h?.src?.length || 0}`).join('|') : '';
              const effectSig = Array.isArray(snap.wsw.effectImages) ? snap.wsw.effectImages.map(h => `${h?.id || ''}:${h?.src?.length || 0}`).join('|') : '';
              const nextWsKey = `${snap.wsw.id || ''}:${snap.wsw.name || ''}:${visualSig}:${snap.wsw.weaponImage?.src?.length || 0}:${snap.wsw.offhandImage?.src?.length || 0}:${snap.wsw.hatImage?.src?.length || 0}:${hatSig}:${effectSig}:${motionSetSig}`;
              if (p._wsSnapshotKey !== nextWsKey) {
                p._applyWorkshopWeapon(snap.wsw);
                p._wsSnapshotKey = nextWsKey;
              }
            } else if (p.workshopWeapon) {
              p.workshopWeapon = null;
              p.blockVM = null;
              p._wsSnapshotKey = '';
            }
            p.applyCosmeticsSnapshot(snap.cos);

            if (!isLocalSnapshot) {
              // Soft buffer coordinates for smooth client interpolation
              p.targetX = snap.x;
              p.targetY = snap.y;
              p.targetAngle = snap.angle;
            } else {
              // The snapshot is roughly half an RTT old when it arrives. Compare
              // local prediction against a short velocity projection instead of
              // dragging the player back to that stale position every packet.
              const projected = projectServerSnapshot(snap, this.networkManager.latency);
              const correctionDistance = localCorrectDist(p.x, p.y, projected.x, projected.y);
              const respawned = wasDead && !p.isDead;
              const snapRevision = Number.isSafeInteger(snap.posRev) && snap.posRev >= 0 ? snap.posRev : 0;
              const positionDiscontinuity = p._serverPositionRevision !== undefined
                && p._serverPositionRevision !== snapRevision;
              p._serverPositionRevision = snapRevision;
              if (p.isDead || respawned || positionDiscontinuity) {
                p.x = snap.x;
                p.y = snap.y;
                if (Number.isFinite(snap.vx)) p.vx = snap.vx;
                if (Number.isFinite(snap.vy)) p.vy = snap.vy;
                p.grounded = Boolean(snap.grounded);
              } else {
                if (correctionDistance > 8) {
                  const correction = correctionDistance > 90 ? 0.18 : 0.08;
                  const step = boundedPositionCorrection(
                    projected.x - p.x,
                    projected.y - p.y,
                    correction,
                    18
                  );
                  p.x += step.x;
                  p.y += step.y;
                }
                if (Number.isFinite(snap.vx)) p.vx += (snap.vx - p.vx) * 0.12;
                if (Number.isFinite(snap.vy)) p.vy += (snap.vy - p.vy) * 0.12;
                if (!snap.grounded) p.grounded = false;
                else if (Math.abs(p.y - snap.y) < 14) p.grounded = true;
              }
              if (p.isDead && Number.isFinite(snap.angle)) {
                p.angle = snap.angle;
              }
            }
          });

          // Delete clients that left server state
          Object.keys(this.players).forEach(id => {
            if (!data.players[id]) {
              delete this.players[id];
            }
          });

          // Storm zone + healing items + mines are host-owned; clients just store them.
          this.zone = data.zone || null;
          this.healingItems = Array.isArray(data.healingItems) ? data.healingItems : [];
          this.mines = Array.isArray(data.mines) ? data.mines : [];
          this.firePatches = Array.isArray(data.firePatches) ? data.firePatches : [];

          // 2. Synchronize projectiles: recreate Projectile instances
          this.projectiles = data.projectiles.map(snap => {
            // Prefer the host's explicit heading (a stuck spear has zero velocity).
            const angle = Number.isFinite(snap.angle) ? snap.angle : Math.atan2(snap.vy, snap.vx);
            const proj = new Projectile(
              snap.id,
              snap.ownerId,
              snap.x,
              snap.y,
              angle,
              snap.speed || Weapons.bow?.speed || 640,
              snap.maxRange === null ? Infinity : (snap.maxRange ?? Weapons.bow?.range ?? Infinity),
              snap.damage || Weapons.bow?.damage || 30,
              snap.kind || 'arrow'
            );
            // Keep the host's exact velocity so client extrapolation matches.
            if (Number.isFinite(snap.vx)) proj.vx = snap.vx;
            if (Number.isFinite(snap.vy)) proj.vy = snap.vy;
            proj.weapon = snap.weapon || (snap.kind === 'greatswordwave' ? 'greatsword' : proj.weapon);
            proj.wsImageId = snap.wsImageId || null;
            proj.wsScale = snap.wsScale || 1;
            proj.wsRotation = Number.isFinite(Number(snap.wsRotation)) ? Number(snap.wsRotation) : 0;
            proj.piercing = !!snap.piercing;
            proj.isDead = snap.isDead;
            return proj;
          });

          // 3. Reconcile active effects against this client's own clock.
          this.effects = (data.effects || [])
            .map(effectSnap => rebaseEffectSnapshot(effectSnap, now))
            .filter(effect => effect.progress < 1);
          this._triggerLocalBowSkillVibrations(this.effects);
          this._triggerLocalSpearThrowFeedbacks(this.effects);

          // 4. Removed Legacy Battle Royale Victory/Elimination triggers
          // (Now operating in dynamic infinite deathmatch respawn loop)
        } 
        
        else if (data.type === MsgType.ERROR) {
          const statusEl = document.getElementById('statusMsg');
          if (statusEl) {
            statusEl.textContent = data.message;
            statusEl.classList.remove('hidden');
          }
          this.quit();
        }
      }
    });

    // GUEST LEVEL VANISHED
    this.networkManager.on('onPlayerLeft', (remoteId) => {
      const p = this.players[remoteId];
      if (p) {
        this._announce(`${p.nickname}님이 전장에서 후퇴했습니다.`);
        // If Host, kill player object
        if (this.networkManager.isHost) {
          p.isDead = true;
          // Trigger broadcast change so other guests see death state / remove player
          delete this.players[remoteId];
          this._broadcastState();
        } else {
          delete this.players[remoteId];
        }
      }
    });

    // A transient drop keeps the match shell alive while WsTransport retries.
    this.networkManager.on('onReconnecting', ({ remainingMs } = {}) => {
      const seconds = Math.max(1, Math.ceil((remainingMs || 0) / 1000));
      this._announce(`서버 재연결 중... ${seconds}초`);
    });

    // GUEST COLD DROP
    this.networkManager.on('onDisconnected', (reason) => {
      const errMsg = reason || '매치메이킹 서버와의 연결이 끊어졌습니다.';
      const statusEl = document.getElementById('statusMsg');
      if (statusEl) {
        statusEl.textContent = errMsg;
        statusEl.classList.remove('hidden');
      }
      this.quit();
    });

    // PEER CONFIG OR ACCESS REGISTRATION ERROR
    this.networkManager.on('onError', (errMsg) => {
      const statusEl = document.getElementById('statusMsg');
      if (statusEl) {
        statusEl.textContent = errMsg;
        statusEl.classList.remove('hidden');
      }
    });
  }
}


// Top-level helper (not a method): it has no `this`, so it keeps the real clock.
// Callers inside the sim pass their injected `now` explicitly.
export function rebaseEffectSnapshot(effectSnap, now = Date.now()) {
  const lifetime = positiveFinite(effectSnap?.lifetime) ? effectSnap.lifetime : 300;
  let progress = Number.isFinite(effectSnap?.progress) ? effectSnap.progress : 0;

  if (!Number.isFinite(effectSnap?.progress) && Number.isFinite(effectSnap?.timestamp)) {
    progress = (now - effectSnap.timestamp) / lifetime;
  }

  progress = clamp01(progress);

  // Spread the snapshot so newer effect fields (x2/y2, radius, buffType)
  // survive the rebase, then override only the timing fields.
  return {
    ...(effectSnap || {}),
    progress,
    timestamp: now - progress * lifetime,
    lifetime
  };
}


function lerpAngle(current, target, amount) {
  if (!Number.isFinite(target)) return current;

  let delta = target - current;
  while (delta < -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return current + delta * amount;
}


function localCorrectDist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}


export function projectServerSnapshot(snapshot, roundTripMs = 0) {
  const oneWayMs = Math.max(0, Math.min(120, (Number(roundTripMs) || 0) * 0.5 + (1000 / 60)));
  const seconds = oneWayMs / 1000;
  return {
    x: (Number(snapshot?.x) || 0) + (Number(snapshot?.vx) || 0) * seconds,
    // Vertical prediction is unstable around landings, one-way platforms and
    // jump cuts. Keep authoritative Y and reconcile it with a bounded step.
    y: Number(snapshot?.y) || 0,
  };
}


export function boundedPositionCorrection(dx, dy, factor = 0.08, maxStep = 18) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  const distance = Math.hypot(x, y);
  if (distance <= 0) return { x: 0, y: 0 };
  const requested = Math.max(0, distance * Math.max(0, Number(factor) || 0));
  const scale = Math.min(requested, Math.max(0, Number(maxStep) || 0)) / distance;
  return { x: x * scale, y: y * scale };
}


function deserializeMagicCooldowns(cooldowns = {}) {
  return {
    fireball: Math.max(0, (cooldowns.fireball || 0) / 1000),
    iceShard: Math.max(0, (cooldowns.iceShard || 0) / 1000),
    lifebound: Math.max(0, (cooldowns.lifebound || 0) / 1000)
  };
}


function deserializeWorkshopCooldowns(cooldowns = {}) {
  return {
    skill: Math.max(0, (cooldowns.skill || 0) / 1000),
    skill2: Math.max(0, (cooldowns.skill2 || 0) / 1000),
    skill3: Math.max(0, (cooldowns.skill3 || 0) / 1000),
    ultimate: Math.max(0, (cooldowns.ultimate || 0) / 1000)
  };
}
