/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
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
import { NULL_FX } from './sim/Fx.js';
import { generateCover, resolveCover, coverBlocksSegment, coverRayDistance, coverClearOfPoint, coverBlocksCircle } from './Cover.js';
import { generateWater, emptyWater } from './Water.js';
import { buildLevel, PHYS } from './Level.js';
import { BotBrain, BOT_DIFFICULTY } from './Bot.js';
import { resolveMotion, weaponSetId, sanitizeMotionSetId, canonicalWeaponMotion, canonicalWeaponsSnapshot, setCanonicalWeapon } from './Motion.js';
import { STATUS } from './Status.js';
import { sampleCombatKeys } from './Workshop.js';

// Time a dead player waits before respawning. Keep the combat tempo fast, but
// avoid the "blink and die again" loop from a 0.5s death turn.
const RESPAWN_MS = 1500;
const RESPAWN_PROTECTION_MS = 2000;

function escapeHudHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function clampSkillLabel(value, fallback = '스킬') {
  const text = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return text || fallback;
}

export class Game {
  constructor(canvas, networkManager, costume = null, options = {}) {
    this.canvas = canvas;
    this.networkManager = networkManager;
    // Local player's equipped costume colors { color, accentColor } or null.
    this.localCostume = costume;

    // Dummy (practice) room: the host spawns stationary training dummies.
    this.dummyRoom = !!options.dummyRoom;
    this.dummyCount = Number.isFinite(options.dummyCount) ? options.dummyCount : 3;

    // Bot match: the host fills the arena with AI bots (synthetic-input Players).
    // Used by the one-click offline "바로 플레이". `botFill` tops the lobby up to
    // a target headcount; `botCount` is an explicit number of bots to spawn.
    this.botMatch = !!options.botMatch;
    this.botCount = Number.isFinite(options.botCount) ? options.botCount : 3;
    this.botFill = Number.isFinite(options.botFill) ? options.botFill : 0;
    this.botDifficulty = BOT_DIFFICULTY[options.botDifficulty] ? options.botDifficulty : 'normal';
    this.botWorkshopWeapons = Array.isArray(options.botWorkshopWeapons)
      ? options.botWorkshopWeapons.filter(w => w && typeof w === 'object')
      : [];
    this._botSeq = 0;
    this._bots = [];   // BotBrain instances (host only)

    // Short-round support (demo bot match): an optional time limit and/or kill
    // target end the match with a result screen. 0/unset = endless (the normal
    // respawn deathmatch, unchanged). onMatchOver(results) is fired once on end.
    this.matchDurationMs = Number.isFinite(options.matchDurationMs) ? options.matchDurationMs : 0;
    this.killTarget = Number.isFinite(options.killTarget) ? options.killTarget : 0;
    // Quick-play onboarding hold: freeze the whole host sim (physics, bots, zone,
    // match timer) while the controls card is up, then release into a 3·2·1
    // countdown — reading the card must not cost the player match time (P2).
    this.matchHold = !!options.holdAtStart;
    this.countdownUntil = 0;
    this.onMatchOver = typeof options.onMatchOver === 'function' ? options.onMatchOver : null;
    this.matchOver = false;

    // Room custom settings (arena size / storm / cover / healing). The host owns
    // these; clients overwrite them from the ROOM_JOINED handshake. Defaults match
    // current behavior so an untouched config plays identically to before.
    this.roomConfig = normalizeRoomConfig(options.roomConfig);

    // Floating damage numbers (local render-only, derived from HP deltas so they
    // work the same on host and clients without any extra netcode).
    this._dmgPopups = [];
    this._prevHpById = {};

    // Hit feedback (Task 8) — all local render-only, never touches simulation.
    this._hitstopUntil = 0;     // freeze the displayed frame until this time
    this._hitFlashUntil = 0;    // local-player damage vignette end time
    this._hitFlashStrength = 0; // 0..1 vignette intensity
    this._killFeed = [];        // recent kill notices (synced via Protocol)
    // Local-only juice particles (hit sparks / death bursts). Derived from synced
    // HP so they fire on host AND clients without netcode; kept OUT of this.effects
    // so the host never broadcasts them (clients derive their own copy).
    this._localFx = [];

    // Cover tiles (Task 9): static obstacles. Host picks one per-match seed and
    // ships only that number via ROOM_JOINED; clients regenerate the identical
    // layout locally from it (grass-style deterministic generation).
    this.cover = [];
    this.coverSeed = 0;
    // Biome (visual theme) + water (special obstacle). Water blocks player
    // MOVEMENT but lets projectiles/attacks pass over; on the snow biome it is
    // frozen, so it blocks nothing. `moveTiles` is the combined movement blocker
    // (cover + non-frozen water); `cover` alone still gates projectiles/LOS.
    this.biome = 'day';
    this.water = emptyWater();
    this.frozen = false;
    this.moveTiles = [];
    // Healing items (Task 9): host spawns on a timer, syncs via GAME_STATE.
    this.healingItems = [];
    this._healingSeq = 0;
    this._nextHealAt = 0;
    // Mines (mine-bag weapon): host owns/explodes them, synced via GAME_STATE.
    this.mines = [];
    this._mineSeq = 0;
    // Fire patches (flamethrower F): timed ground burn, synced via GAME_STATE.
    this.firePatches = [];
    this._patchSeq = 0;
    // Side-scroller level (platformer pivot). buildLevel derives a deterministic
    // layered level from the arena-size preset; mapWidth/mapHeight follow the
    // level's pixel size. Clients rebuild the identical level from ROOM_JOINED.
    this.level = null;
    this._buildLevel();

    // The rising-lava / hazard zone was removed: it caused too many unfair
    // respawn-into-death loops and pushed matches toward survival over combat.
    // The sim keeps a null zone so every zone-aware guard simply no-ops.
    this.zone = null;

    this.renderer = new Renderer(canvas);
    this.camera = new Camera();
    this.input = new Input();
    this.input.reloadKeybinds?.();
    this.controlSettings = this._loadControlSettings();

    // Game state entities
    this.players = {};
    this.projectiles = [];
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
    this.effects = []; // Visual overlays: { attackerId, x, y, angle, weapon, type, progress, timestamp }

    // Flags
    this.isRunning = false;
    this.localPlayerId = null;
    this.remainingPlayersCount = 0;

    // Presentation sink for the SIMULATION half of this class (see sim/Fx.js).
    // Simulation code must route juice through this instead of touching Sound /
    // camera / document, so the same code can run headless on the game server.
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

    // Server-Auth Tick parameters
    this.serverTickTimer = 0;
    this.serverTickInterval = 1000 / 22; // ~22 ticks per second

    // Callback when game ends or disconnects
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
    this.players = {};
    this.projectiles = [];
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
    this.effects = [];
    this.lastInputSentAt = 0;
    this.lastInputSignature = '';
    
    this.localPlayerId = this.networkManager.localId;
    this.lastFrameTime = performance.now();
    this.matchStartTime = Date.now(); // wall-clock match start (for telemetry duration)

    // Prepare Controls
    this.input.setupListeners(this.canvas);

    // Initial spawner coordinates
    const localNick = document.getElementById('nicknameInput').value.trim() || 'GLADIATOR';
    const localWeapon = document.querySelector('.weapon-card.selected')?.dataset.weapon || 'sword';

    if (this.networkManager.isHost) {
      // Host picks one per-match seed; the layout is derived deterministically
      // from it (grass-style). Only the seed ships to clients via ROOM_JOINED.
      this.coverSeed = (Math.random() * 0xffffffff) >>> 0;
      this._buildTerrain();   // builds water + cover (avoiding water) from the seed

      // Host adds themselves directly
      const spawnP = this._getRandomSpawnPoint();
      const hostPlayer = new Player(this.localPlayerId, localNick, localWeapon, spawnP.x, spawnP.y, this.localCostume);
      hostPlayer.isMobile = isMobileDevice(); // touch players fire instantly
      hostPlayer.mobileAimAssist = !!this.controlSettings.mobileAimAssist;
      hostPlayer.automaticAttack = !!this.controlSettings.automaticAttack;
      this._enforceWorkshopPolicy(hostPlayer);
      this.players[this.localPlayerId] = hostPlayer;

      // Dummy room: drop a few stationary practice targets into the arena.
      if (this.dummyRoom) {
        this._spawnDummies(this.dummyCount);
      }

      // Bot match: fill the arena with AI bots so a solo player has a real fight.
      if (this.botMatch) {
        const n = this.botFill > 0 ? Math.max(0, this.botFill - 1) : this.botCount;
        this._spawnBots(n, this.botDifficulty);
      }

      this._announce(this.dummyRoom ? '더미 연습장 입장' : (this.botMatch ? '봇 매치 시작!' : 'MATCH STARTED'));

      // Preserve active ticking when Host's tab is backgrounded.
      // Browsers throttle background intervals to ≥1s, so a fixed dt here made
      // physics run in ~1/28 slow motion while every wall-clock system (zone
      // rise, respawns, cooldowns, match timer) kept real time — bots couldn't
      // possibly outrun the lava. Substep the REAL elapsed time instead so
      // simulated time matches the clock no matter how hard we're throttled.
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
      // The tab can ALREADY be hidden when the match starts (e.g. launched from
      // a backgrounded panel) — visibilitychange never fires then, leaving the
      // sim frozen. Sync with the current state once.
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

  // Bind resize context
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

    const now = Date.now();

    if (this.networkManager.isHost) {
      // --- HOST (AUTHORITATIVE) ROUTE ---
      // Update camera over host coordinates
      const hp = this.players[this.localPlayerId];
      if (hp) {
        this.input.setLocalWeapon(hp.weapon);
        this.camera.updateAction(this._cameraFocusPoints(), this.canvas.width, this.canvas.height, this.level);
        if (!hp.isDead) {
          this.input.updateAimAngle(hp, this.camera, this.canvas.width, this.canvas.height, this.mapWidth, this.mapHeight);
          hp.angle = this.input.aimAngle;
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
      if (!this.matchOver && !holding) this._updateHostPhysics(deltaTime, now);

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
   * Host specific update routine
   */
  _updateHostPhysics(deltaTime, now) {
    // 0. Synthesize bot input first so their freshly-set keys/aim are consumed
    //    by the same physics + auto-attack pass as every other player.
    this._updateBots(deltaTime, now);

    // 1. Process all active players inputs (including guests)
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.isDead) return;

      // Snapshot this tick's start position BEFORE movement so melee hit tests
      // can sweep the target's path (prev → current) this frame.
      p.prevX = p.x;
      p.prevY = p.y;
      const wasGrounded = p.grounded;
      const fallVy = p.vy;

      if (id === this.localPlayerId) {
        // Local host: set aim first so facing follows the cursor this frame.
        p.angle = this.input.aimAngle;
        p.updatePosition(deltaTime, this.input.keys, this.level);
      } else {
        // Remote guest input updates (platformer physics vs the level).
        p.updatePosition(deltaTime, p.keys || {}, this.level);
      }
      if (!wasGrounded && p.grounded && fallVy > 520) {
        this._spawnLandingDust(p, now, fallVy);
      }
    });

    // 2. Resolve Player overlaps horizontally (platformer: keep bodies apart
    //    without disturbing the vertical landing solved by the level collision).
    Collision.resolvePlayerCollisions(this.players);

    // Storm zone tick + healing spawns/pickups (host authoritative).
    this._updateZone(now, deltaTime);
    this._updateHealingItems(now);
    this._guardianAutoSeek(now);
    this._updateChakramOrbit(now);
    this._updateHeatShield(now);
    this._updateMines(now);
    this._updateFlamethrower(now, deltaTime);
    this._updateFirePatches(now);

    // 2.5 Advance skill buffs & cooldowns authoritatively.
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.isDead) return;
      if (p.buffTimeLeft > 0) {
        p.buffTimeLeft -= deltaTime;
        if (p.buffTimeLeft <= 0) {
          // Buff expired → the post-buff cooldown begins now.
          p.buffTimeLeft = 0;
          p.buffType = null;
          const sk = SkillConfig[p.weapon];
          p.skillCdLeft = sk ? sk.cooldownMs / 1000 : 0;
        }
      } else if (p.skillCdLeft > 0) {
        p.skillCdLeft = Math.max(0, p.skillCdLeft - deltaTime);
      }
      if (p.altSkillCdLeft > 0) p.altSkillCdLeft = Math.max(0, p.altSkillCdLeft - deltaTime);
      if (p.targetSkillCdLeft > 0) p.targetSkillCdLeft = Math.max(0, p.targetSkillCdLeft - deltaTime);
      if (p.wsSkillCd) {
        for (const key in p.wsSkillCd) if (p.wsSkillCd[key] > 0) p.wsSkillCd[key] = Math.max(0, p.wsSkillCd[key] - deltaTime);
      }
      if (p.sniperTeleportTargetUntil > 0 && now > p.sniperTeleportTargetUntil) {
        p.sniperTeleportTargetUntil = 0;
      }
      this._tickMagicCooldowns(p, deltaTime);
    });

    this._releaseDueSwordWaves(now);
    this._releaseDueBowRailguns(now);
    this._releaseDueMagicShards(now);
    this._releaseDueKatanaSlashes(now);
    this._releaseDueSniperShots(now);
    this._releaseDueMatchlockShots(now);
    this._releaseDuePendingChakrams(now);
    this._processSpearThrowQueue(now);
    this._processPendingMeleeHits(now);
    this._processGreatswordCharges(now);
    this._processKatanaCharges(now);
    this._processDaggerQtes(now);
    this._processHammerSlams(now);
    this._processPistolBursts(now);
    this._processAimedShots(now);

    // 3. Process Automatic attack queues
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.isDead) return;
      if (p.isDummy) return; // training dummies just stand there

      const weaponConfig = getEffectiveWeapon(p.weapon, p.buffType);

      // Automatic Attack on cooldown trigger. If the equipped weapon has an
      // ADMIN-CANONICAL hitbox motion, the hit is judged by that motion's
      // hitboxes/active window (T1-D) instead of the code-fixed geometry; the
      // swing animation + cooldown still go through lastAttackTime.
      // Per-tick block gimmick (bounded by the VM's tick step budget).
      if (p.blockVM && p.blockVM.hasHandler('onTick')) this._runBlockEvent(p, 'onTick', now);

      if (p.canAttack(now)) {
        if (p.isBot || p.automaticAttack) this._performBasicAttack(p, weaponConfig, now);
      }
    });

    // 3a2. Resolve active hitbox swings against targets during their active window.
    this._updateHitboxSwings(now);

    // 3b. Tick fire DoT (magic staff fireball burns).
    this._tickStatuses(deltaTime, now);

    // 4. Update and check projectile hits
    this.projectiles.forEach(proj => {
      if (proj.isDead) return;

      // Boomerang javelin has its own out/return flight handling.
      if (proj.kind === 'thrownspear') {
        this._updateThrownSpear(proj, deltaTime, now);
        return;
      }
      // Boomerang projectiles: chakram + guardian R launch swords.
      if (proj.kind === 'chakram' || proj.kind === 'guardianlaunch') {
        this._updateChakram(proj, deltaTime, now);
        return;
      }
      // Guardian LMB dart: homing sword that tracks then vanishes.
      if (proj.kind === 'guardiandart') {
        this._updateHomingBlade(proj, deltaTime, now);
        return;
      }
      // Guardian auto-seek: orbit blade flies to enemy and returns to orbit.
      if (proj.kind === 'guardianseek') {
        this._updateGuardianSeek(proj, deltaTime, now);
        return;
      }

      // Block-gimmick entity (BlockVM 2.0 ①): let its script steer itself
      // (onEntityTick — homing/gravity) before it moves this frame.
      if (proj.kind === 'block' && proj._entScript) this._blockEntityStep(proj, deltaTime, now);
      if (proj.isDead) return;

      proj.update(deltaTime);

      // Block entity reached its range → onExpire (cluster-split etc.).
      if (proj.isDead && proj.kind === 'block' && proj._entScript) {
        this._runEntityEvent(this.players[proj.ownerId], proj, 'onExpire', now, 0);
        return;
      }

      // Solid level geometry (walls / ground / ledges) blocks projectiles;
      // one-way platforms let them pass (shoot up through a platform).
      if (this._levelSolidBlocks(proj.x, proj.y, proj.radius || 4)) {
        // A block entity with an onWallHit handler may bounce/redirect instead.
        if (proj.kind === 'block' && proj._entScript && this._blockEntityWall(proj, now)) return;
        proj.isDead = true;
        if (proj.kind === 'swordwave') this._explodeSwordWave(proj, now);
        else if (proj.kind === 'block' && proj._entScript) this._runEntityEvent(this.players[proj.ownerId], proj, 'onExpire', now, 0);
        else this.effects.push({
          attackerId: proj.ownerId, x: proj.x, y: proj.y,
          angle: Math.atan2(proj.vy, proj.vx),
          weapon: proj.weapon || 'bow', type: 'projectile_burst',
          progress: 0, timestamp: now, lifetime: 320
        });
        return;
      }
      // Cover blocks projectiles just like the arena wall.
      if (this.cover.length && coverBlocksCircle(this.cover, proj.x, proj.y, proj.radius || 4)) {
        if (proj.kind === 'block' && proj._entScript && this._blockEntityWall(proj, now)) return;
        proj.isDead = true;
        if (proj.kind === 'swordwave') {
          this._explodeSwordWave(proj, now);
        } else {
          this.effects.push({
            attackerId: proj.ownerId, x: proj.x, y: proj.y,
            angle: Math.atan2(proj.vy, proj.vx),
            weapon: proj.weapon || 'bow', type: 'projectile_burst',
            progress: 0, timestamp: now, lifetime: 320
          });
        }
        return;
      }

      if (proj.checkWallCollision(this.mapWidth, this.mapHeight)) {
        if (proj.kind === 'block' && proj._entScript && this._blockEntityWall(proj, now)) return;
        if (proj.kind === 'swordwave') {
          this._explodeSwordWave(proj, now);
        } else {
          this.effects.push({
            attackerId: proj.ownerId,
            x: proj.x,
            y: proj.y,
            angle: Math.atan2(proj.vy, proj.vx),
            weapon: proj.weapon || (proj.kind === 'greatswordwave' ? 'greatsword' : 'bow'),
            type: 'projectile_burst',
            progress: 0,
            timestamp: now,
            lifetime: 320
          });
        }
        return;
      }

      // Check hit detections (i-frames let a dashing player phase through).
      Object.keys(this.players).forEach(tid => {
        const target = this.players[tid];
        if (proj.isDead || target.isInvincible()) return;

        if (Collision.checkProjectileHit(proj, target)) {
          // Juice: a landed projectile from its owner gives a small hitstop,
          // matching the melee feel (the kill blow adds a bigger one). The sink
          // decides whether the owner is the local player.
          if (!target.isInvincible?.()) this.fx.hitstop(34, proj.ownerId);
          if (proj.kind === 'wsranged') {
            // A workshop ranged basic attack: weapon-damage direct hit + status.
            const owner = this.players[proj.ownerId];
            const died = target.takeDamage(proj.damage || 0, owner ? owner.nickname : '');
            if (owner) this._awardUltimateGauge(owner, proj.wsUltimateGain ?? 10);
            if (proj.wsStatus && proj.wsStatus !== 'none') this._applyStatusEffect(target, proj.ownerId, proj.wsStatus, proj.wsStatusMs || 0, now, proj.wsAirborneHeight);
            else if (owner) this._applyWorkshopStatus(owner, target, now);
            if (died) this._creditKill(proj.ownerId, target);
            if (!proj.piercing) proj.isDead = true;
            return;
          }
          if (proj.kind === 'wsskill') {
            // A workshop skill1/2/3's OWN ranged ability: its own damage + status
            // (not the basic swing's) — see _fireWorkshopPresetProjectile.
            const owner = this.players[proj.ownerId];
            const died = target.takeDamage(proj.damage || 0, owner ? owner.nickname : '');
            if (owner) this._awardUltimateGauge(owner, proj.wsUltimateGain ?? 10);
            if (proj.wsStatus) this._applyStatusEffect(target, proj.ownerId, proj.wsStatus, proj.wsStatusMs || 0, now, proj.wsAirborneHeight);
            if (died) this._creditKill(proj.ownerId, target);
            if (!proj.piercing) proj.isDead = true;
            return;
          }
          if (proj.kind === 'block') {
            // Block-gimmick projectile: deal its (clamped) damage via the block
            // damage path (fires the owner's onHit/onKill), then run the owner's
            // projectileHit[tag] handler. Non-piercing shots die on contact.
            const owner = this.players[proj.ownerId];
            if (owner) {
              this._blockDealDamage(owner, target, proj.damage || 0, now);
              this._runBlockEvent(owner, 'projectileHit', now, { tag: proj.blockTag || '' });
              // Entity's own onEntityHit (split-on-contact, redirect, etc.).
              if (proj._entScript) this._runEntityEvent(owner, proj, 'onEntityHit', now, 0);
            }
            if (!proj.piercing && !proj._keepAlive) proj.isDead = true;
            return;
          }

          if (proj.kind === 'swordwave') {
            // Direct contact damage, then the explosion AoE.
            const died = target.takeDamage(proj.damage, 'swordwave');
            if (died) this._creditKill(proj.ownerId, target, '검기로');
            this._explodeSwordWave(proj, now);
            return;
          }

          if (proj.kind === 'fireball') {
            proj.isDead = true;
            const died = target.takeDamage(proj.damage, '파이어볼');
            this._applyBurn(target, proj.ownerId, proj.burnDps || 2, proj.burnDurationMs || 4000);
            if (died) this._creditKill(proj.ownerId, target, '파이어볼로');
            return;
          }

          if (proj.kind === 'iceshard') {
            proj.isDead = true;
            const died = target.takeDamage(proj.damage, '아이스 샤드');
            if (!died) this._applySlow(target, MagicConfig.iceShard.slowMs || 1500); // 둔화
            if (died) this._creditKill(proj.ownerId, target, '아이스 샤드로');
            return;
          }

          if (proj.kind === 'pistol') {
            proj.isDead = true;
            const died = target.takeDamage(proj.damage, '쇠뇌');
            if (died) this._creditKill(proj.ownerId, target, '쇠뇌로');
            return;
          }

          if (proj.kind === 'harpoon') {
            proj.isDead = true;
            const hk = SkillConfig.harpoon;
            const died = target.takeDamage(proj.damage, '작살');
            const attacker = this.players[proj.ownerId];
            if (!died && attacker) {
              // Yank the target to just in front of the attacker along the line.
              const a = proj.angle;
              target.x = attacker.x + Math.cos(a) * (hk.pullToFront || 50);
              target.y = attacker.y + Math.sin(a) * (hk.pullToFront || 50);
              Collision.clampToMap(target, this.mapWidth, this.mapHeight);
              this._resolveOutOfTerrain(target);   // harpoon yank: don't land in a wall
              this._applySlow(target, hk.slowMs || 300);
              if (hk.pullStunMs) this._applyStun(target, hk.pullStunMs, Date.now());
              target.prevX = target.x; // discontinuous move — don't let melee sweep it
              target.prevY = target.y;
            }
            if (died) this._creditKill(proj.ownerId, target, '작살로');
            return;
          }

          proj.isDead = true;
          let arrowDmg = proj.damage;
          if (proj.kind === 'arrow') {
            this._awardBowArrowStack(this.players[proj.ownerId]);
            // Close-range falloff: a bow that lets you fight at melee is too safe.
            const bow = Weapons.bow;
            if (bow.closeRange) {
              const flew = Math.hypot(proj.x - proj.startX, proj.y - proj.startY);
              if (flew < bow.closeRange) arrowDmg = bow.closeDamage ?? arrowDmg;
            }
          }
          const died = target.takeDamage(arrowDmg, proj.kind === 'greatswordwave' ? 'greatswordwave' : 'arrow');
          if (died) this._creditKill(proj.ownerId, target, '활로');
        }
      });
    });

    // Clean up dead projectiles
    this.projectiles = this.projectiles.filter(p => !p.isDead);

    // Update effect decay cycles
    this.effects.forEach(e => {
      const elapsed = now - e.timestamp;
      e.progress = Math.min(elapsed / e.lifetime, 1);
    });
    this.effects = this.effects.filter(e => e.progress < 1);

    // 5. Update game standing counts & Host P2P Respawn Loop
    const alivePlayers = Object.values(this.players).filter(p => !p.isDead);
    this.remainingPlayersCount = alivePlayers.length;

    // Process resurrection/respawn times for dead competitors
    Object.keys(this.players).forEach(id => {
      const p = this.players[id];
      if (p.isDead) {
        if (!p.respawnTime) {
          p.respawnTime = now + RESPAWN_MS;
          if (!p.isDummy) p.deaths = (p.deaths || 0) + 1; // count once per death (telemetry / K-D)
          p.clearCombatTimers(); // drop buffs/dash/skill state on death
          this._clearPendingSwordWavesFor(p.id);
          this._clearPendingRailgunsFor(p.id);
          this._clearPendingMagicShardsFor(p.id);
          this._clearPendingMeleeHitsFor(p.id);
          this._clearPendingHammerSlamsFor(p.id);
          this._clearPendingSniperShotsFor(p.id);
          this._clearPendingMatchlockShotsFor(p.id);
        }
        p.respawnRemainingMs = Math.max(0, p.respawnTime - now);
        if (now >= p.respawnTime) {
          // Apply a queued weapon swap on respawn (resets max HP to the new weapon).
          if (p.pendingWorkshopWeapon) {
            p._applyWorkshopWeapon(p.pendingWorkshopWeapon);
            p.pendingWorkshopWeapon = null;
            p.pendingWeapon = null;
            if (p.id === this.localPlayerId) { this.pendingWeaponChoice = null; this.pendingWeaponChoiceLabel = ''; }
          } else if (p.pendingWeapon && Weapons[p.pendingWeapon] && p.pendingWeapon !== p.weapon) {
            p.weapon = p.pendingWeapon;
            p.maxHp = Weapons[p.weapon].maxHp || 100;
            p.workshopWeapon = null;
            if (p.id === this.localPlayerId) { this.pendingWeaponChoice = null; this.pendingWeaponChoiceLabel = ''; }
          }
          p.pendingWeapon = null;
          // An equipped workshop weapon's (clamped) maxHp wins on respawn.
          if (p.workshopWeapon?.stats?.maxHp) p.maxHp = p.workshopWeapon.stats.maxHp;

          const spawnP = p.isDummy
            ? { x: p.homeX, y: p.homeY }
            : this._getRandomSpawnPoint();
          p.isDead = false;
          p.hp = p.maxHp;
          p.x = spawnP.x;
          p.y = spawnP.y;
          p.respawnTime = 0;
          p.respawnRemainingMs = 0;
          p.clearCombatTimers(); // also clears bleed/burn DoTs
          // Respawn protection: i-frames + status/zone grace are intentionally
          // longer than the death delay so lava/landing chaos cannot spawn-kill.
          p.iframeTimeLeft = Math.max(p.iframeTimeLeft || 0, RESPAWN_PROTECTION_MS / 1000);
          p.statusImmuneUntil = now + RESPAWN_PROTECTION_MS;
          p.zoneGraceUntil = now + RESPAWN_PROTECTION_MS;
          p.stunImmuneUntil = 0;
          // Cosmetic respawn effect (equipped), synced to all.
          if (p.respawnFxColor) {
            this.effects.push({
              attackerId: p.id, x: p.x, y: p.y, weapon: '', type: 'respawn_fx',
              color: p.respawnFxColor, progress: 0, timestamp: now, lifetime: 560
            });
          }
          if (!p.isDummy) this._announce(`${p.nickname}님이 다시 부활했습니다!`);
        }
      } else {
        p.respawnTime = 0;
        p.respawnRemainingMs = 0;
      }
    });

    // 6. Broadcast state ticks to guests
    this.serverTickTimer += deltaTime * 1000;
    if (this.serverTickTimer >= this.serverTickInterval) {
      this.serverTickTimer = 0;
      this._broadcastState();
    }

    // Round end (demo bot match): time limit or kill target reached.
    this._checkMatchEnd(now);

    // Update stats UI counters
    this._updateHUD();
  }

  /** Milliseconds left in the round (Infinity when there is no time limit). */
  matchTimeLeftMs(now = Date.now()) {
    if (!this.matchDurationMs) return Infinity;
    // Held / counting down → the clock hasn't started; show the full duration.
    if (this.matchHold || now < this.countdownUntil) return this.matchDurationMs;
    return Math.max(0, this.matchDurationMs - (now - (this.matchStartTime || now)));
  }

  /**
   * Release the onboarding hold (quick-play): run a 3·2·1 countdown, then let
   * the sim (and the match clock) start. Safe to call repeatedly — only the
   * first call does anything, so re-opening the controls card changes nothing.
   */
  releaseMatchHold() {
    if (!this.matchHold) return;
    this.matchHold = false;
    const now = Date.now();
    this.countdownUntil = now + 3000;
    this.matchStartTime = this.countdownUntil; // 2:00 starts when the fight does
    this._announce('3');
    setTimeout(() => { if (!this.matchOver) this._announce('2'); }, 1000);
    setTimeout(() => { if (!this.matchOver) this._announce('1'); }, 2000);
    setTimeout(() => { if (!this.matchOver) this._announce('⚔ 전투 시작!'); }, 3000);
  }

  /**
   * End the round when the timer runs out or someone hits the kill target, then
   * hand a ranked result table to the host UI. No-op for endless matches.
   */
  _checkMatchEnd(now) {
    if (this.matchOver || (!this.matchDurationMs && !this.killTarget)) return;
    const timeUp = this.matchDurationMs && this.matchTimeLeftMs(now) <= 0;
    // Kill-target instant win is HUMAN-only (P3): bots racking up kills no
    // longer ends the round early — they only place on the timer scoreboard.
    const reached = this.killTarget && Object.values(this.players).some(p => !p.isDummy && !p.isBot && p.kills >= this.killTarget);
    if (!timeUp && !reached) return;

    this.matchOver = true;
    const results = Object.values(this.players)
      .filter(p => !p.isDummy)
      .map(p => ({
        id: p.id, name: p.nickname, weapon: p.weapon,
        kills: p.kills || 0, deaths: p.deaths || 0,
        isLocal: p.id === this.localPlayerId, isBot: !!p.isBot,
        color: p.color
      }))
      .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.isBot - b.isBot));
    results.forEach((r, i) => { r.rank = i + 1; });
    if (this.onMatchOver) { try { this.onMatchOver(results); } catch {} }
  }

  /**
   * Resolve a player's ADMIN-CANONICAL attack motion IFF it carries hitboxes
   * (authored in the editor on the canonical registry). Returns the motion or
   * null. Cosmetic/peer motions never have hitboxes (dual-trust sanitize), so a
   * guest can't fabricate one — the host only ever reads its own registry here.
   */
  /** Workshop weapons are always allowed in the creator-first ruleset. */
  _enforceWorkshopPolicy(player) {
    return player;
  }

  _canonicalHitboxMotion(player) {
    if (!player) return null;
    // 0) An equipped workshop weapon (per-player) defines its own attack hitboxes.
    const ws = player.workshopWeapon?.motionSet?.attack;
    if (ws && ((Array.isArray(ws.hitboxes) && ws.hitboxes.length) || (ws.projectileEvents && ws.projectileEvents.length) || (ws.teleportEvents && ws.teleportEvents.length))) return ws;
    if (player.weapon === 'magicstaff' || player.weapon === 'chakram') return null;
    // 1) The weapon's admin-canonical motion (shared by all players of that weapon).
    const wc = canonicalWeaponMotion(player.weapon, 'attack');
    if (wc && Array.isArray(wc.hitboxes) && wc.hitboxes.length) return wc;
    // 2) Fall back to this device's per-player authored set (offline/cosmetic path).
    const setId = sanitizeMotionSetId(player.motionSetId) || weaponSetId(player.weapon);
    const m = resolveMotion(setId, 'attack');
    return (m && Array.isArray(m.hitboxes) && m.hitboxes.length) ? m : null;
  }

  /** Fire a workshop ranged preset's projectile (direction from its config). */
  _fireWorkshopProjectile(player, now) {
    const pj = player.workshopWeapon.projectile; if (!pj) return;
    const motion = player.workshopWeapon?.motionSet?.attack;
    const combat = sampleCombatKeys(motion?.combatKeys, player.workshopWeapon?.stats || {}, 0);
    player.lastAttackTime = now; player.swingDirection *= -1;
    player.attackMotionTag = 'attack';
    player.lastAttackMotionTag = 'attack';
    this._lockPlayerMotion(player, now, motion);
    this._spawnWorkshopProjectile(player, pj, combat, now, 'basic');
  }

  _projectileAngle(player, pj = {}) {
    const D2R = Math.PI / 180;
    if (pj.directionSource === 'facing') return (player.facingRight === false || player.facing < 0) ? Math.PI : 0;
    if (pj.directionSource === 'angle') return (pj.angle || 0) * D2R;
    return player.angle || 0;   // cursor/default = aim angle
  }

  _spawnWorkshopProjectile(player, pj, combat = {}, now = Date.now(), tagSuffix = 'evt') {
    if (!player || !pj) return;
    const ang = this._projectileAngle(player, pj);
    const speed = pj.speed || 600;
    const lifeSec = Math.max(0.1, (pj.lifetimeMs || 1200) / 1000);
    const range = speed * lifeSec;
    const dmg = Number.isFinite(combat.damage) ? combat.damage : (player.workshopWeapon?.stats?.damage || 12);
    const sx = player.x + Math.cos(ang) * (player.radius + 3), sy = player.y + Math.sin(ang) * (player.radius + 3);
    const proj = new Projectile(`ws_${tagSuffix}_${player.id}_${this._wsrSeq = (this._wsrSeq || 0) + 1}`, player.id, sx, sy, ang, speed, range, dmg, tagSuffix === 'basic' ? 'wsranged' : 'wsskill');
    proj.weapon = player.weapon; proj.piercing = !!pj.pierce;
    // Collision radius from the authored hitbox (circle radius, or rect ½-extent).
    const hb = pj.hitbox || {};
    proj.radius = (hb.shape === 'circle') ? Math.max(3, hb.radius || 8) : Math.max(4, Math.max(hb.width || 24, hb.height || 12) / 2);
    proj.wsImageId = pj.imageId || 'arrow';
    proj.wsScale = Math.max(0.3, Math.min(3, Number(pj.scale) || 1));
    proj.wsRotation = Number.isFinite(Number(pj.rotation)) ? Number(pj.rotation) : 0;
    proj.wsStatus = combat.status || 'none';
    proj.wsStatusMs = combat.statusDurationMs || 0;
    proj.wsAirborneHeight = combat.airborneHeight || 120;
    proj.wsSlot = tagSuffix;
    proj.wsUltimateGain = tagSuffix === 'basic'
      ? 10
      : Math.max(10, Math.min(35, Math.round((Number(combat.ultimateGain) || 10) / 5) * 5));
    this.projectiles.push(proj);
    this.fx.sfx('shoot', player.id);
  }
  /** Apply the workshop weapon's status effect to a target (shared by melee/ranged). */
  _applyWorkshopStatus(owner, target, now) {
    const s = owner.workshopWeapon?.stats;
    if (!s || !s.status || s.status === 'none') return;
    this._applyStatusEffect(target, owner.id, s.status, s.statusDurationMs || 0, now, s.airborneHeight);
  }

  /** Apply an arbitrary status effect (shared by basic/heavy/skill hits — each
   *  preset carries its own status/duration rather than always the basic one). */
  _applyStatusEffect(target, ownerId, status, ms, now, airborneHeight = 120) {
    if (!status || status === 'none') return;
    if (status === 'slow') this._applySlow(target, ms);
    else if (status === 'bleed') this._applyBleed(target, ownerId);
    else if (status === 'burn') this._applyBurn(target, ownerId, 2, ms);
    else if (status === 'stun') this._applyStun(target, ms, now);
    else if (status === 'airborne') this._applyAirborne(target, ms, airborneHeight, now);
  }

  _applyAirborne(target, durationMs = 400, height = 120, now = Date.now()) {
    if (!this._canApplyStatus(target)) return;
    const ms = Math.max(100, Number(durationMs) || 400);
    const h = Math.max(20, Math.min(260, Number(height) || 120));
    const liftSeconds = Math.max(0.12, ms / 1000);
    target.vy = Math.min(target.vy || 0, -h / liftSeconds);
    target.grounded = false;
    target.jumping = false;
    this._applyStun(target, ms, now);
  }

  _awardUltimateGauge(player, amount = 10) {
    if (!player || player.isDead) return;
    const gain = Math.max(0, Math.min(35, Math.round((Number(amount) || 0) / 5) * 5));
    if (gain <= 0) return;
    const before = Math.max(0, Math.min(100, Number(player.ultimateGauge) || 0));
    player.ultimateGauge = Math.max(0, Math.min(100, before + gain));
    if (before < 100 && player.ultimateGauge >= 100 && player.id === this.localPlayerId) {
      this._announce('궁극기 준비!');
    }
  }

  /** Fire a ranged skill preset's projectile (skill1/2/3) — same shape as the
   *  basic workshop projectile but carries ITS OWN damage/status so hits apply
   *  the authored skill's combat, not the basic swing's. */
  _fireWorkshopPresetProjectile(player, pj, combat, now, tagSuffix) {
    if (this._isMotionLocked(player, now)) return;
    player.lastAttackTime = now; player.swingDirection *= -1;
    player.attackMotionTag = tagSuffix || 'skill';
    player.lastAttackMotionTag = player.attackMotionTag;
    this._lockPlayerMotion(player, now, player.workshopWeapon?.motionSet?.[tagSuffix || 'skill']);
    this._spawnWorkshopProjectile(player, pj, combat, now, tagSuffix || 'skill');
  }

  /** Fire a workshop weapon's skill1/skill2/skill3 (F/E/R) authored ability —
   *  melee hitbox swing or ranged projectile, gated by its OWN cooldown. Returns
   *  true when the equipped weapon owns this slot (caller skips base-weapon
   *  fallback logic), false when nothing is authored there (or no workshop
   *  weapon is equipped) so legacy per-weapon skills keep working unequipped. */
  _activateWorkshopSkill(player, slot, now) {
    const ws = player && player.workshopWeapon;
    const baseCombat = ws && ws.presetCombat && ws.presetCombat[slot];
    if (!baseCombat) return false;
    const combatKeys = ws && ws.presetCombatKeys && ws.presetCombatKeys[slot];
    const combat = sampleCombatKeys(combatKeys, baseCombat, 0);
    if (this._isMotionLocked(player, now)) return true;
    if (!player.wsSkillCd) player.wsSkillCd = {};
    if ((player.wsSkillCd[slot] || 0) > 0) return true;   // on cooldown — button consumed, nothing fires
    player.wsSkillCd[slot] = (Number.isFinite(combat.cooldownMs) ? combat.cooldownMs : 1000) / 1000;
    this._showSkillCallout(player, slot, slot === 'ultimate' ? '궁극기' : '스킬', now);
    const motion = ws.motionSet && ws.motionSet[slot];
    const hasTimelineEvents = !!(motion && ((motion.projectileEvents && motion.projectileEvents.length) || (motion.teleportEvents && motion.teleportEvents.length)));
    const ranged = ws.presetRanged && ws.presetRanged[slot];
    if (ranged && !hasTimelineEvents) { this._fireWorkshopPresetProjectile(player, ranged, combat, now, slot); return true; }
    const hb = ws.presetHitboxes && ws.presetHitboxes[slot];
    if ((Array.isArray(hb) && hb.length) || hasTimelineEvents) {
      const swingMotion = motion ? { ...motion, hitboxes: (Array.isArray(motion.hitboxes) ? motion.hitboxes : hb) || [] } : { duration: 0.4, hitboxes: hb || [] };
      this._startHitboxSwing(player, swingMotion, now, {
        damage: combat.damage, knockback: combat.knockback,
        status: combat.status, statusMs: combat.statusDurationMs, airborneHeight: combat.airborneHeight,
        projectile: ranged || null,
        motionTag: slot,
        ultimateGain: combat.ultimateGain,
        combat,
        combatKeys,
      });
    }
    return true;   // slot is authored (motion + cooldown apply) even with no hitbox/projectile yet
  }

  /** Begin a hitbox-driven swing: manage the cooldown + render animation via
   *  lastAttackTime, and record the active swing for _updateHitboxSwings. */
  _startHitboxSwing(player, motion, now, opts = {}) {
    player.lastAttackTime = now;
    player.attackMotionTag = opts.motionTag || 'attack';
    player.lastAttackMotionTag = player.attackMotionTag;
    this._lockPlayerMotion(player, now, motion);
    player.swingDirection *= -1;
    player._hbSwing = {
      start: now,
      durMs: Math.max(80, (motion.duration || 0.4) * 1000),
      hitboxes: motion.hitboxes,
      projectileEvents: Array.isArray(motion.projectileEvents) ? motion.projectileEvents : [],
      teleportEvents: Array.isArray(motion.teleportEvents) ? motion.teleportEvents : [],
      frameEffects: Array.isArray(motion.effects) ? motion.effects : [],
      eventProjectile: opts.projectile || null,
      firedProjectileEvents: new Set(),
      firedTeleportEvents: new Set(),
      firedFrameEffects: new Set(),
      knockback: Number.isFinite(opts.knockback) ? opts.knockback : (motion.knockback || 0),
      damage: Number.isFinite(opts.damage) ? opts.damage : null,   // override (e.g. heavy/skill preset)
      damageDivisor: Math.max(1, Array.isArray(motion.hitboxes) ? motion.hitboxes.length : 0),
      combat: opts.combat || null,
      combatKeys: Array.isArray(opts.combatKeys) ? opts.combatKeys : (Array.isArray(motion.combatKeys) ? motion.combatKeys : []),
      status: opts.status && opts.status !== 'none' ? opts.status : null,
      statusMs: opts.statusMs || 0,
      airborneHeight: opts.airborneHeight || 120,
      ultimateGain: Number.isFinite(Number(opts.ultimateGain)) ? Number(opts.ultimateGain) : null,
      hit: new Set(),
    };
    this.fx.attackSfx(getEffectiveWeapon(player.weapon, player.buffType), player.id);
  }

  _lockPlayerMotion(player, now, motion = null) {
    if (!player) return;
    const durMs = Math.max(80, Math.round(((motion && motion.duration) || 0.42) * 1000));
    player.motionLockUntil = Math.max(player.motionLockUntil || 0, now + durMs);
    if (motion && typeof player.beginMotionRoot === 'function') {
      player.beginMotionRoot(motion, now, durMs);
    }
  }

  _isMotionLocked(player, now = Date.now()) {
    return !!(player && player.motionLockUntil && now < player.motionLockUntil);
  }

  /**
   * Advance every active hitbox swing: during each hitbox's active window, test
   * its AABB (world px relative to the attacker, forward = facing) against all
   * live targets and apply the weapon's damage once per target per authored
   * hitbox. This lets frame-by-frame hitboxes land independently while each
   * individual active frame still hits a target only once.
   */
  _updateHitboxSwings(now) {
    for (const id in this.players) {
      const p = this.players[id];
      const sw = p._hbSwing;
      if (!sw) continue;
      if (p.isDead) { p._hbSwing = null; continue; }
      const phase = (now - sw.start) / sw.durMs;
      if (phase >= 1) { p._hbSwing = null; continue; }

      const facing = Math.cos(p.angle || 0) >= 0 ? 1 : -1;
      const wcfg = getEffectiveWeapon(p.weapon, p.buffType);
      const phaseCombat = sampleCombatKeys(sw.combatKeys, sw.combat || {
        damage: Number.isFinite(sw.damage) ? sw.damage : (p.workshopWeapon?.stats?.damage || wcfg.damage || 10),
        knockback: sw.knockback || 0,
        status: sw.status || 'none',
        statusDurationMs: sw.statusMs || 0,
        airborneHeight: sw.airborneHeight || 120,
        ultimateGain: Number.isFinite(Number(sw.ultimateGain)) ? sw.ultimateGain : 10,
      }, phase);
      // Swing-specific override (heavy finisher) → workshop damage → base weapon.
      const dmg = (Number.isFinite(phaseCombat.damage) ? phaseCombat.damage : (Number.isFinite(sw.damage) ? sw.damage : (p.workshopWeapon?.stats?.damage))) || wcfg.damage || 10;
      const perHitDamage = dmg / Math.max(1, Number(sw.damageDivisor) || hitboxDamageDivisor(sw.hitboxes));

      this._runWorkshopSwingEvents(p, sw, phase, now);

      const hitboxes = sw.hitboxes || [];
      for (let hbIndex = 0; hbIndex < hitboxes.length; hbIndex++) {
        const hb = hitboxes[hbIndex];
        const frameTime = Number(hb.frameTime);
        const activeStart = Number.isFinite(frameTime) ? Math.max(0, frameTime - 0.025) : hb.activeStart;
        const activeEnd = Number.isFinite(frameTime) ? Math.min(1, frameTime + 0.025) : hb.activeEnd;
        if (phase < activeStart || phase > activeEnd) continue;
        const bx = p.x + hb.ox * facing, by = p.y + hb.oy;
        const bl = bx - hb.w / 2, br = bx + hb.w / 2, bt = by - hb.h / 2, bb = by + hb.h / 2;
        for (const tid in this.players) {
          const t = this.players[tid];
          const hitKey = `${hbIndex}:${t.id}`;
          if (t.id === p.id || t.isDead || sw.hit.has(hitKey)) continue;
          if (t.isInvincible && t.isInvincible()) continue;
          const tr = t.radius || 14;
          if (br <= t.x - tr || bl >= t.x + tr || bb <= t.y - tr || bt >= t.y + tr) continue;
          if (this._terrainBlocksSegment(p.x, p.y, t.x, t.y)) continue;  // walls block
          sw.hit.add(hitKey);
          const kb = Number.isFinite(phaseCombat.knockback) ? phaseCombat.knockback : sw.knockback;
          if (kb) this._displace(t, facing * kb, 0);
          const hbDamage = Number.isFinite(Number(hb.damage)) ? Math.max(0, Number(hb.damage)) : perHitDamage;
          const died = t.takeDamage(hbDamage, p.nickname);
          this._awardUltimateGauge(p, Number.isFinite(Number(phaseCombat.ultimateGain)) ? phaseCombat.ultimateGain : 10);
          const status = phaseCombat.status && phaseCombat.status !== 'none' ? phaseCombat.status : sw.status;
          const statusMs = Number.isFinite(phaseCombat.statusDurationMs) ? phaseCombat.statusDurationMs : sw.statusMs;
          if (status) this._applyStatusEffect(t, p.id, status, statusMs, now, phaseCombat.airborneHeight || sw.airborneHeight);
          if (died) this._creditKill(p.id, t);
          this.fx.hitstop(42, p.id);
        }
      }
    }
  }

  _teleportEventAngle(player, ev = {}) {
    const D2R = Math.PI / 180;
    if (ev.directionSource === 'facing') return (player.facingRight === false || player.facing < 0) ? Math.PI : 0;
    if (ev.directionSource === 'back') return (player.facingRight === false || player.facing < 0) ? 0 : Math.PI;
    if (ev.directionSource === 'up') return -Math.PI / 2;
    if (ev.directionSource === 'down') return Math.PI / 2;
    if (ev.directionSource === 'angle') return (ev.angle || 0) * D2R;
    return player.angle || 0;
  }

  _runWorkshopSwingEvents(player, sw, phase, now) {
    const combat = sampleCombatKeys(sw.combatKeys, {
      damage: Number.isFinite(sw.damage) ? sw.damage : (player.workshopWeapon?.stats?.damage || 12),
      status: sw.status || 'none',
      statusDurationMs: sw.statusMs || 0,
      airborneHeight: sw.airborneHeight || 120,
      ultimateGain: Number.isFinite(Number(sw.ultimateGain)) ? sw.ultimateGain : 10,
    }, phase);
    for (let i = 0; i < (sw.projectileEvents || []).length; i++) {
      if (sw.firedProjectileEvents.has(i)) continue;
      const ev = sw.projectileEvents[i];
      if (phase < ev.time) continue;
      sw.firedProjectileEvents.add(i);
      this._spawnWorkshopProjectile(player, ev.projectile || sw.eventProjectile || player.workshopWeapon?.projectile, combat, now, `evt${i}`);
    }
    for (let i = 0; i < (sw.teleportEvents || []).length; i++) {
      if (sw.firedTeleportEvents.has(i)) continue;
      const ev = sw.teleportEvents[i];
      if (phase < ev.time) continue;
      sw.firedTeleportEvents.add(i);
      const ang = this._teleportEventAngle(player, ev);
      const dist = Math.max(0, Math.min(260, Number(ev.distance) || 0));
      this._displace(player, Math.cos(ang) * dist, Math.sin(ang) * dist);
      this._resolveOutOfTerrain(player);
    }
    for (let i = 0; i < (sw.frameEffects || []).length; i++) {
      if (sw.firedFrameEffects.has(i)) continue;
      const ev = sw.frameEffects[i];
      if (phase < ev.time) continue;
      sw.firedFrameEffects.add(i);
      this._spawnWorkshopFrameEffect(player, ev, now, sw.durMs);
    }
  }

  _spawnWorkshopFrameEffect(player, ev = {}, now = Date.now(), motionDurMs = 420) {
    if (!player) return;
    const angle = (player.angle || 0) + ((Number(ev.rotation) || 0) * Math.PI / 180);
    const forward = Math.cos(player.angle || 0) >= 0 ? 1 : -1;
    const xOff = Number(ev.x) || 0;
    const yOff = Number(ev.y) || 0;
    let bx = player.x;
    let by = player.y - (player.halfH || 20) * 0.35;
    if (ev.followBone === 'weaponTip') {
      bx += Math.cos(player.angle || 0) * ((player.radius || 14) + 28);
      by += Math.sin(player.angle || 0) * ((player.radius || 14) + 28);
    } else if (ev.followBone === 'handN' || ev.followBone === 'handR') {
      bx += Math.cos(player.angle || 0) * ((player.radius || 14) + 10);
      by += Math.sin(player.angle || 0) * ((player.radius || 14) + 10);
    } else if (ev.followBone === 'head') {
      by -= (player.halfH || 20) * 0.85;
    } else if (ev.followBone === 'root') {
      by = player.y;
    }
    const startTime = Number(ev.time) || 0;
    const lifeMs = Number.isFinite(Number(ev.endTime))
      ? Math.round(Math.max(0.04, Number(ev.endTime) - startTime) * (Number(motionDurMs) || 420))
      : 420;
    this.effects.push({
      attackerId: player.id,
      x: bx + xOff * forward,
      y: by + yOff,
      angle,
      weapon: player.weapon,
      type: 'workshop_frame_fx',
      worldAnchored: true,
      assetId: ev.assetId || 'spark',
      scale: Number(ev.scale) || 1,
      alpha: Number.isFinite(ev.alpha) ? ev.alpha : 1,
      flipX: !!ev.flipX,
      flipY: !!ev.flipY,
      progress: 0,
      timestamp: now,
      lifetime: Math.max(80, Math.min(30000, lifeMs))
    });
  }

  // ── Block-gimmick VM host integration (weapon blockcoding) ─────────────────
  /** Nearest LIVE enemy to a player → { target, dist, dir } or null. */
  _nearestEnemy(player) {
    let best = null, bestD = Infinity;
    for (const id in this.players) {
      const t = this.players[id];
      if (t.id === player.id || t.isDead) continue;
      const d = Math.hypot(t.x - player.x, t.y - player.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? { target: best, dist: bestD, dir: Math.atan2(best.y - player.y, best.x - player.x) } : null;
  }

  /** Read-only sense snapshot handed to a block program. Angles are in DEGREES
   *  (the block language convention — matches the spec's "조준각 + i×12°"). */
  _blockSense(player, now) {
    const near = this._nearestEnemy(player);
    const R2D = 180 / Math.PI;
    return {
      aimAngle: (player.angle || 0) * R2D, hp: player.hp, maxHp: player.maxHp,
      x: player.x, y: player.y, speed: Math.hypot(player.vx || 0, player.vy || 0),
      grounded: !!player.grounded, combo: player.comboStep || 0,
      lastDamage: player._lastDealt || 0, time: now / 1000,
      nearestDist: near ? near.dist : 99999, nearestDir: near ? near.dir * R2D : 0,
    };
  }

  /**
   * Run a weapon's block handler for `eventName` on the host (only). Bounded to a
   * nesting depth of 2 so onHit→spawn→onHit can't recurse forever. Returns true
   * if a handler existed + ran.
   */
  _runBlockEvent(player, eventName, now, extra = {}) {
    const vm = player.blockVM;
    if (!vm || !vm.hasHandler(eventName)) return false;
    if ((player._blockDepth || 0) >= 2) return false;
    player._blockDepth = (player._blockDepth || 0) + 1;
    try {
      vm.run(eventName, {
        api: this._blockApi(player, now),
        vars: player.blockVars || (player.blockVars = {}),
        lists: player.blockLists || (player.blockLists = {}),
        rng: Math.random,                        // host-side; clients only render results
        now,
        damageBase: player.workshopWeapon?.stats?.damage || 20,
        sense: this._blockSense(player, now),
        tag: extra.tag,
      });
    } catch { /* never let a gimmick crash the sim */ }
    finally { player._blockDepth--; }
    return true;
  }

  /** Apply block-dealt damage to a target + fire the attacker's onHit / onKill. */
  _blockDealDamage(attacker, target, dmg, now) {
    if (!target || target.isDead || (target.isInvincible && target.isInvincible())) return false;
    if (this._terrainBlocksSegment(attacker.x, attacker.y, target.x, target.y)) return false;
    // Damage budget (BlockVM 2.0): soft-cap per player per second so no combo
    // can exceed ~baseDPS×1.2 in total, however the hits are stacked.
    if (attacker.blockBudget) dmg = attacker.blockBudget.grantDamage(now, dmg);
    if (!(dmg > 0)) return false;
    attacker._lastDealt = dmg;
    const died = target.takeDamage(dmg, attacker.nickname);
    this.fx.hitstop(40, attacker.id);
    this._runBlockEvent(attacker, 'onHit', now, { damage: dmg });
    if (died) { this._creditKill(attacker.id, target); this._runBlockEvent(attacker, 'onKill', now); }
    return true;
  }

  /** The whitelisted host API a block program calls. All numbers arrive already
   *  envelope-clamped by the VM; here we turn them into real game effects. */
  _blockApi(player, now) {
    const near = () => this._nearestEnemy(player);
    const D2R = Math.PI / 180;   // block angles are DEGREES → radians for the sim
    return {
      spawnMelee: ({ frontOffset, width, height, damage }) => {
        const cx = player.x + Math.cos(player.angle) * frontOffset;
        const cy = player.y + Math.sin(player.angle) * frontOffset;
        for (const id in this.players) {
          const t = this.players[id];
          if (t.id === player.id || t.isDead) continue;
          if (Math.abs(t.x - cx) > width / 2 + (t.radius || 14) || Math.abs(t.y - cy) > height / 2 + (t.radius || 14)) continue;
          this._blockDealDamage(player, t, damage, now);
        }
      },
      spawnProjectile: ({ angle, speed, range, pierce, gravity, tag, damage, dir }) => {
        // Entity budget: cap spawns/sec + concurrent block entities per owner.
        if (player.blockBudget) {
          const live = this.projectiles.reduce((n, p) => n + (p.ownerId === player.id && p.kind === 'block' ? 1 : 0), 0);
          if (!player.blockBudget.allowSpawn(now, live)) return;
        }
        // Direction source (priority: block dir → block angle). cursor = aim angle,
        // facing = look direction, angle/none = the block's angle value.
        let rad;
        if (dir === 'cursor') rad = player.angle || 0;
        else if (dir === 'facing') rad = (player.facingRight === false || player.facing < 0) ? Math.PI : 0;
        else rad = angle * D2R;
        const sx = player.x + Math.cos(rad) * 20, sy = player.y + Math.sin(rad) * 20;
        const proj = new Projectile(`blk_${player.id}_${this._blockProjSeq = (this._blockProjSeq || 0) + 1}`, player.id, sx, sy, rad, speed, range, damage, 'block');
        proj.weapon = player.weapon; proj.blockTag = tag || ''; proj.piercing = !!pierce; proj.blockGravity = !!gravity;
        this._initBlockEntity(proj, player, now);
        this.projectiles.push(proj);
        if (proj._entScript) this._runEntityEvent(player, proj, 'onSpawn', now, 0);
      },
      spawnArea: ({ cx, cy, radius, damage }) => {
        const ax = Number.isFinite(cx) ? cx : player.x, ay = Number.isFinite(cy) ? cy : player.y;
        for (const id in this.players) {
          const t = this.players[id];
          if (t.id === player.id || t.isDead) continue;
          if (Math.hypot(t.x - ax, t.y - ay) > radius + (t.radius || 14)) continue;
          this._blockDealDamage(player, t, damage, now);
        }
        this.effects.push({ attackerId: player.id, x: ax, y: ay, weapon: '', type: 'mine_blast', progress: 0, timestamp: now, lifetime: 360 });
      },
      applyStatus: ({ status, durationMs }) => {
        const n = near(); if (!n) return;
        // CC budget: cap status-effect seconds granted per second.
        if (player.blockBudget) { durationMs = player.blockBudget.grantCC(now, durationMs); if (!(durationMs > 0)) return; }
        if (status === 'slow') this._applySlow(n.target, durationMs);
        else if (status === 'bleed') this._applyBleed(n.target, player.id);
        else if (status === 'burn') this._applyBurn(n.target, player.id, 2, durationMs);
        else if (status === 'stun') this._applyStun(n.target, durationMs, now);
      },
      knockback: ({ force, angle }) => { const n = near(); if (!n) return; const a = Number.isFinite(angle) ? angle * D2R : n.dir; this._displace(n.target, Math.cos(a) * force, Math.sin(a) * force); },
      heal: ({ amountPct, ofLastDamagePct }) => {
        const amt = (player.maxHp * (amountPct || 0) / 100) + ((player._lastDealt || 0) * (ofLastDamagePct || 0) / 100);
        if (amt > 0) player.hp = Math.min(player.maxHp, player.hp + amt);
      },
      dash: ({ angle, distance }) => { const a = angle * D2R; this._displace(player, Math.cos(a) * distance, Math.sin(a) * distance); },
      teleport: ({ distance }) => { this._displace(player, Math.cos(player.angle) * distance, Math.sin(player.angle) * distance); this._resolveOutOfTerrain(player); },
      jump: ({ power }) => { player.vy = -PHYS.jumpSpeed * power; player.grounded = false; },
      // Self-movement (BlockVM 2.0 ④): set/boost own velocity → jetpacks, recoil,
      // air-dashes. Speed is move-budget clamped (VM caps + a hard total cap here).
      moveSelf: ({ angle, speed }) => { const a = angle * D2R; player.vx = Math.cos(a) * speed; player.vy = Math.sin(a) * speed; if (player.vy < 0) player.grounded = false; },
      impulse: ({ angle, force }) => {
        const a = angle * D2R; player.vx += Math.cos(a) * force; player.vy += Math.sin(a) * force;
        const sp = Math.hypot(player.vx, player.vy), cap = 950;
        if (sp > cap) { player.vx *= cap / sp; player.vy *= cap / sp; }
        if (player.vy < 0) player.grounded = false;
      },
      pull: ({ distance }) => { const n = near(); if (!n) return; const a = n.dir + Math.PI; this._displace(n.target, Math.cos(a) * distance, Math.sin(a) * distance); },
      spawnPlacement: () => { /* placements land in a later pass; no-op keeps it safe for now */ },
      particle: (id) => this.effects.push({ attackerId: player.id, x: player.x, y: player.y, weapon: '', type: id === 'explosion' ? 'mine_blast' : 'danger_pop', progress: 0, timestamp: now, lifetime: 360 }),
      // 모션 재생 [태그] — cosmetic: broadcast a trigger; every client resolves the
      // tag from the player's synced weapon def and plays the pose overlay.
      playMotion: ({ tag }) => this.effects.push({ attackerId: player.id, x: player.x, y: player.y, weapon: '', type: 'stick_motion', tag, progress: 0, timestamp: now, lifetime: 700 }),
      sfx: (id) => this.fx.sfx(String(id), player.id),
      shake: (level) => this.fx.shake(level === 'strong' ? 14 : 7, 220),
      cooldownGate: () => { /* the weapon's clamped cooldownMs already floors fire rate */ },
    };
  }

  // ── Entity scripting (BlockVM 2.0 ①): a spawned projectile runs its own
  //    lifecycle handlers (onSpawn/onEntityTick/onEntityHit/onWallHit/onExpire).
  //    All output (damage, spawns, CC) still flows through the owner's budget. ──

  /** Tag a fresh block projectile with its per-entity runtime state. */
  _initBlockEntity(proj, owner, now) {
    proj.bornAt = now; proj._bounces = 0; proj._entVars = {};
    proj._entGravity = proj.blockGravity ? 900 : 0; proj._lifeMs = 0;
    proj._keepAlive = false;
    const tag = proj.blockTag || '';
    const vm = owner && owner.blockVM;
    proj._entScript = !!(vm && vm.program.entities && vm.program.entities[tag]);
  }

  _nearestEnemyFrom(x, y, excludeId) {
    let best = null, bestD = Infinity;
    for (const id in this.players) {
      const t = this.players[id];
      if (t.id === excludeId || t.isDead) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? { target: best, dist: bestD, dir: Math.atan2(best.y - y, best.x - x) } : null;
  }

  /** Read-only sense for an entity script — the entity's OWN motion state. */
  _blockEntitySense(proj, now) {
    const R2D = 180 / Math.PI;
    const near = this._nearestEnemyFrom(proj.x, proj.y, proj.ownerId);
    return {
      x: proj.x, y: proj.y, vx: proj.vx, vy: proj.vy,
      speed: Math.hypot(proj.vx, proj.vy), aimAngle: Math.atan2(proj.vy, proj.vx) * R2D,
      life: (now - (proj.bornAt || now)) / 1000, bounces: proj._bounces || 0,
      nearestDist: near ? near.dist : 99999, nearestDir: near ? near.dir * R2D : 0,
      time: now / 1000,
    };
  }

  /** The entity-acting api: steer/redirect/split THIS projectile. */
  _blockEntityApi(owner, proj, now, dt) {
    const D2R = Math.PI / 180;
    const setVel = (angleDeg, speed) => {
      const a = angleDeg * D2R;
      proj.vx = Math.cos(a) * speed; proj.vy = Math.sin(a) * speed;
      proj.angle = a; proj.speed = speed; proj._keepAlive = true;
    };
    // Owner-budgeted effects (applyStatus/spawnArea/particle…) fired from the
    // entity's position reuse the player api but centred on the projectile.
    const ownerApi = this._blockApi(owner, now);
    return {
      ...ownerApi,
      setVelocity: ({ angle, speed }) => setVel(angle, speed),
      homing: ({ turnDeg }) => {
        const near = this._nearestEnemyFrom(proj.x, proj.y, proj.ownerId);
        if (!near) return;
        const cur = Math.atan2(proj.vy, proj.vx);
        let diff = near.dir - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = turnDeg * D2R * (dt || 0.016);
        const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
        const spd = Math.hypot(proj.vx, proj.vy) || proj.speed || 300;
        setVel((cur + step) / D2R, spd);
      },
      setGravity: ({ value }) => { proj._entGravity = value; },
      setLifetime: ({ ms }) => { proj._lifeMs = ms; },
      removeSelf: () => { proj.isDead = true; },
      // spawnArea centred on the projectile (override owner-centred default).
      spawnArea: ({ radius, damage }) => ownerApi.spawnArea({ cx: proj.x, cy: proj.y, radius, damage }),
      split: ({ count, spreadDeg, speed, damage, tag }) => {
        const baseA = Math.atan2(proj.vy, proj.vx) * (180 / Math.PI);
        const childTag = tag || proj.blockTag || '';
        for (let i = 0; i < count; i++) {
          if (owner.blockBudget) {
            const live = this.projectiles.reduce((n, p) => n + (p.ownerId === owner.id && p.kind === 'block' ? 1 : 0), 0);
            if (!owner.blockBudget.allowSpawn(now, live)) break;
          }
          const frac = count > 1 ? (i / (count - 1) - 0.5) : 0;
          const a = (baseA + frac * spreadDeg) * D2R;
          const child = new Projectile(`blk_${owner.id}_${this._blockProjSeq = (this._blockProjSeq || 0) + 1}`, owner.id, proj.x, proj.y, a, speed, 260, damage, 'block');
          child.weapon = owner.weapon; child.blockTag = childTag; child.piercing = false;
          this._initBlockEntity(child, owner, now);
          child._childDepth = (proj._childDepth || 0) + 1;
          if (child._childDepth > 2) child._entScript = false;   // no infinite split chains
          this.projectiles.push(child);
        }
      },
    };
  }

  /** Run one entity lifecycle handler; depth-bounded like _runBlockEvent. */
  _runEntityEvent(owner, proj, eventName, now, dt) {
    if (!owner || !proj || !proj._entScript) return;
    const vm = owner.blockVM;
    if (!vm || !vm.hasEntityHandler(proj.blockTag || '', eventName)) return;
    if ((owner._blockDepth || 0) >= 2) return;
    owner._blockDepth = (owner._blockDepth || 0) + 1;
    try {
      vm.runEntity(proj.blockTag || '', eventName, {
        api: this._blockEntityApi(owner, proj, now, dt),
        vars: proj._entVars || (proj._entVars = {}),
        lists: owner.blockLists || (owner.blockLists = {}),
        rng: Math.random, now,
        damageBase: owner.workshopWeapon?.stats?.damage || 20,
        sense: this._blockEntitySense(proj, now),
      });
    } catch { /* never let a gimmick crash the sim */ }
    finally { owner._blockDepth--; }
  }

  /** Per-frame entity step: run onEntityTick, then apply gravity + lifetime. */
  _blockEntityStep(proj, dt, now) {
    const owner = this.players[proj.ownerId];
    if (!owner) return;
    this._runEntityEvent(owner, proj, 'onEntityTick', now, dt);
    if (proj.isDead) return;
    if (proj._entGravity) proj.vy += proj._entGravity * dt;
    if (proj._lifeMs && now - proj.bornAt >= proj._lifeMs) {
      this._runEntityEvent(owner, proj, 'onExpire', now, 0);
      proj.isDead = true;
    }
  }

  /** onWallHit: give the script a chance to bounce/redirect. Returns true if the
   *  entity survived (was redirected) — the caller then skips the death path. */
  _blockEntityWall(proj, now) {
    const owner = this.players[proj.ownerId];
    if (!owner || !owner.blockVM?.hasEntityHandler(proj.blockTag || '', 'onWallHit')) return false;
    if ((proj._bounces || 0) >= 30) return false;   // safety: no eternal bouncers
    proj._keepAlive = false;
    proj._bounces = (proj._bounces || 0) + 1;
    this._runEntityEvent(owner, proj, 'onWallHit', now, 0);
    if (proj.isDead || !proj._keepAlive) return false;
    // Redirected: nudge out of the wall along the new heading so it doesn't
    // re-collide on the same frame; if still buried, give up and die.
    const spd = Math.hypot(proj.vx, proj.vy) || 1;
    proj.x += (proj.vx / spd) * ((proj.radius || 5) + 8);
    proj.y += (proj.vy / spd) * ((proj.radius || 5) + 8);
    proj.startX = proj.x; proj.startY = proj.y;   // reset range origin so it isn't cut short
    if (this._levelSolidBlocks(proj.x, proj.y, proj.radius || 4)) { proj.isDead = true; return false; }
    return true;
  }

  _applyMobileAimAssistForAttack(player, presetKey = 'basic') {
    if (!player || !player.isMobile || !player.mobileAimAssist) return false;
    const assist = this._resolveAimAssistTarget(player, presetKey);
    if (!assist) return false;
    player.angle = assist.angle;
    const fc = Math.cos(player.angle);
    if (fc > 0.01) player.facing = 1;
    else if (fc < -0.01) player.facing = -1;
    return true;
  }

  _resolveAimAssistTarget(player, presetKey = 'basic') {
    const ww = player.workshopWeapon || null;
    const preset = ww?.presets?.[presetKey] || ww?.presets?.basic || null;
    const category = ww?.category || (ww?.ranged || preset?.ranged ? 'ranged' : 'melee');
    const ranged = !!(preset?.ranged || ww?.ranged || ww?.projectile || category === 'ranged');
    const baseRange = Number(preset?.combat?.range ?? ww?.stats?.range);
    const radius = Number.isFinite(baseRange) && baseRange > 0
      ? Math.max(ranged ? 520 : 240, Math.min(ranged ? 950 : 520, baseRange * (ranged ? 2.2 : 2.8)))
      : (ranged ? 820 : 420);
    const current = Number.isFinite(player.angle) ? player.angle : 0;
    const currentUx = Math.cos(current);
    const currentUy = Math.sin(current);
    const maxAngle = ranged ? Math.PI * 0.55 : Math.PI * 0.82;
    let best = null;

    for (const other of Object.values(this.players || {})) {
      if (!other || other.id === player.id || other.isDead) continue;
      const dx = other.x - player.x;
      const dy = other.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (!Number.isFinite(dist) || dist < 1 || dist > radius) continue;
      const angle = Math.atan2(dy, dx);
      const dot = (dx / dist) * currentUx + (dy / dist) * currentUy;
      const diff = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (diff > maxAngle && category !== 'special') continue;
      // Score balances distance with how close the target is to the current aim.
      const score = dist + diff * (ranged ? 180 : 95) + (other.isDummy ? 20 : 0);
      if (!best || score < best.score) best = { angle, targetId: other.id, score };
    }

    if (best) return best;
    return null;
  }

  _performBasicAttack(player, weaponConfig = getEffectiveWeapon(player?.weapon, player?.buffType), now = Date.now()) {
    if (!player || !weaponConfig || !player.canAttack(now)) return false;
    // A block program's basicAttack IS the attack (spawns its own hits); else
    // fall back to a workshop projectile, canonical hitbox swing, or coded kit.
    if (this._isMotionLocked(player, now)) return false;
    if (player.blockVM && player.blockVM.hasHandler('basicAttack')) {
      player.lastAttackTime = now;
      player.attackMotionTag = 'attack';
      player.lastAttackMotionTag = 'attack';
      this._lockPlayerMotion(player, now, player.workshopWeapon?.motionSet?.attack);
      player.swingDirection *= -1;
      this._runBlockEvent(player, 'basicAttack', now);
      this.fx.attackSfx(weaponConfig, player.id);
      return true;
    }
    const basicMotion = player.workshopWeapon?.motionSet?.attack;
    const basicHasEvents = !!(basicMotion && ((basicMotion.projectileEvents && basicMotion.projectileEvents.length) || (basicMotion.teleportEvents && basicMotion.teleportEvents.length)));
    if (player.workshopWeapon && player.workshopWeapon.ranged && player.workshopWeapon.projectile && !basicHasEvents) {
      this._fireWorkshopProjectile(player, now);
      return true;
    }
    const hbMotion = this._canonicalHitboxMotion(player);
    if (hbMotion) {
      // 강공격 = authored basic combo finisher. Default remains the old 3-hit
      // behavior, but workshop weapons can set 1..5 hits on the heavy preset.
      const ws = player.workshopWeapon;
      const heavyCombat = ws && ws.presetCombat && ws.presetCombat.heavy;
      const heavyHb = ws && ws.presetHitboxes && ws.presetHitboxes.heavy;
      const heavyMotion = ws && ws.motionSet && ws.motionSet.heavy;
      const heavyHasEvents = !!(heavyMotion && ((heavyMotion.projectileEvents && heavyMotion.projectileEvents.length) || (heavyMotion.teleportEvents && heavyMotion.teleportEvents.length)));
      const heavyReady = heavyCombat && ((Array.isArray(heavyHb) && heavyHb.length) || heavyHasEvents);
      if (heavyReady) {
        const heavyAfter = Math.max(1, Math.min(5, Math.round(Number(ws.heavyAfter) || 3)));
        if (!player._basicComboAt || (now - player._basicComboAt) > 1400) player._basicCombo = 0;
        player._basicComboAt = now;
        player._basicCombo = (player._basicCombo || 0) + 1;
        if (player._basicCombo >= heavyAfter) {
          player._basicCombo = 0;
          const motion = heavyMotion;
          const swingMotion = motion ? { ...motion, hitboxes: (Array.isArray(motion.hitboxes) ? motion.hitboxes : heavyHb) || [] } : { duration: 0.5, hitboxes: heavyHb || [] };
          this._startHitboxSwing(player, swingMotion, now, {
            damage: Number.isFinite(heavyCombat.damage) ? heavyCombat.damage : Math.round((ws.stats?.damage || 12) * 1.6),
            knockback: heavyCombat.knockback,
            status: heavyCombat.status, statusMs: heavyCombat.statusDurationMs, airborneHeight: heavyCombat.airborneHeight,
            projectile: ws.presetRanged?.heavy || null,
            motionTag: 'heavy',
            ultimateGain: 10,
            combat: heavyCombat,
            combatKeys: ws.presetCombatKeys?.heavy || [],
          });
          return true;
        }
      }
      this._startHitboxSwing(player, hbMotion, now, { projectile: player.workshopWeapon?.projectile || null });
      return true;
    }
    this._performAutomaticAttack(player, weaponConfig, now);
    return true;
  }

  _performAutomaticAttack(player, weaponConfig, now) {
    if (player.weapon === 'magicstaff') {
      this._castMagicStaff(player, now);
      return;
    }
    if (player.weapon === 'chakram') {
      this._throwChakram(player, weaponConfig, now);
      return;
    }
    const combo = this._resolveComboAttack(player, weaponConfig, now);
    let attackConfig = combo.weaponConfig;
    attackConfig = this._resolveDirectionalAttack(player, attackConfig);
    combo.weaponConfig = attackConfig;
    const swingDirection = Number.isFinite(attackConfig.fixedSwingDirection)
      ? attackConfig.fixedSwingDirection
      : player.triggerAttack(now);
    if (Number.isFinite(attackConfig.fixedSwingDirection)) {
      player.lastAttackTime = now;
      player.lastAttackMotionTag = 'attack';
    }
    this._applyComboRecovery(player, combo, now);

    if (attackConfig.type !== 'projectile') {
      if (attackConfig.lungeDistance) {
        this._lungePlayer(player, attackConfig.lungeDistance);
      }

      const baseLifetime = Math.min(
        Math.max((attackConfig.cooldown || weaponConfig.cooldown) * 0.78 + (attackConfig.delayDamageMs || 0) * 0.5, 150),
        combo.isFinisher ? 900 : 620
      );
      const localFx = {
        attackerId: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle,
        weapon: player.weapon,
        buffType: player.buffType,
        type: attackConfig.type,
        range: attackConfig.range,
        width: attackConfig.width,
        innerRange: attackConfig.innerRange,
        angleDeg: attackConfig.angle,
        angleOffset: attackConfig.angleOffset,
        punchSide: attackConfig.punchSide,
        comboStep: combo.step,
        comboCycle: combo.cycle,
        comboFinisher: combo.isFinisher,
        swingDirection,
        progress: 0,
        timestamp: now,
        lifetime: player.weapon === 'sword' && combo.isFinisher ? Math.max(920, baseLifetime) : baseLifetime
      };
      this.effects.push(localFx);

      const hitCount = this._queueOrApplyMeleeHit(player, attackConfig, now);
      if (hitCount !== null) {
        this._applyAttackTempoResult(player, attackConfig, hitCount, now);
      }
      this._tryPogo(player, hitCount || 0);   // platformer: downward air-attack bounce
      return;
    }

    const spawnDist = player.radius + 3;
    const projectileKind = attackConfig.projectileKind || 'arrow';
    const projectileWeapon = attackConfig.projectileWeapon || player.weapon;
    const arrowId = `${player.id}-${projectileKind}-${now}`;
    const shotEffect = projectileKind === 'greatswordwave'
      ? {
          attackerId: player.id,
          x: player.x,
          y: player.y,
          angle: player.angle,
          weapon: player.weapon,
          type: 'melee_arc',
          range: weaponConfig.range,
          width: weaponConfig.width,
          innerRange: weaponConfig.innerRange,
          angleDeg: weaponConfig.angle,
          comboStep: combo.step,
          comboCycle: combo.cycle,
          comboFinisher: false,
          swingDirection,
          progress: 0,
          timestamp: now,
          lifetime: Math.min(Math.max(weaponConfig.cooldown * 0.78, 240), 620)
        }
      : {
          attackerId: player.id,
          x: player.x,
          y: player.y,
          angle: player.angle,
          weapon: player.weapon,
          type: 'projectile_shot',
          projectileKind,
          progress: 0,
          timestamp: now,
          lifetime: Math.min(attackConfig.cooldown * 0.45, 260)
        };
    this.effects.push(shotEffect);

    // Optional per-shot spread (pistols) so accuracy drops at max range.
    const spread = attackConfig.spreadDeg
      ? ((Math.random() - 0.5) * 2 * attackConfig.spreadDeg * Math.PI) / 180
      : 0;
    const fireAngle = player.angle + spread;
    const proj = new Projectile(
      arrowId,
      player.id,
      player.x + Math.cos(fireAngle) * spawnDist,
      player.y + Math.sin(fireAngle) * spawnDist,
      fireAngle,
      attackConfig.speed,
      attackConfig.range,
      attackConfig.damage,
      projectileKind
    );
    proj.weapon = projectileWeapon;
    if (attackConfig.radius) proj.radius = attackConfig.radius;
    this.projectiles.push(proj);
  }

  _queueOrApplyMeleeHit(player, attackConfig, now) {
    const delayMs = Math.max(0, Math.round(attackConfig.delayDamageMs || 0));
    const snapshot = this._snapshotMeleeAttacker(player);
    if (Number.isFinite(attackConfig.angleOffset)) {
      snapshot.angle += attackConfig.angleOffset;
    }

    if (delayMs > 0) {
      if (!this.pendingMeleeHits) this.pendingMeleeHits = [];
      this.pendingMeleeHits.push({
        playerId: player.id,
        attacker: snapshot,
        attackConfig: { ...attackConfig },
        releaseAt: now + delayMs
      });
      return null;
    }

    return this._applyMeleeHits(snapshot, attackConfig, now);
  }

  _resolveDirectionalAttack(player, attackConfig) {
    if (player.weapon !== 'gauntlet') {
      return attackConfig;
    }

    const side = player.gauntletPunchSide === 1 ? -1 : 1;
    player.gauntletPunchSide = side;
    const convergeOffset = Number.isFinite(attackConfig.punchConvergeOffset)
      ? attackConfig.punchConvergeOffset
      : Math.max(4, Math.min(12, (attackConfig.width || 24) * 0.35));
    const amount = Math.atan2(convergeOffset, Math.max(1, attackConfig.range || 1));
    return {
      ...attackConfig,
      angleOffset: -side * amount,
      punchSide: side
    };
  }

  _snapshotMeleeAttacker(player) {
    return {
      id: player.id,
      nickname: player.nickname,
      x: player.x,
      y: player.y,
      angle: player.angle,
      radius: player.radius || 14
    };
  }

  _processPendingMeleeHits(now) {
    if (!this.pendingMeleeHits?.length) return;

    const waiting = [];
    for (const pending of this.pendingMeleeHits) {
      if (now < pending.releaseAt) {
        waiting.push(pending);
        continue;
      }

      const liveAttacker = this.players[pending.playerId];
      if (!liveAttacker || liveAttacker.isDead) continue;

      this._applyMeleeHits({
        ...pending.attacker,
        nickname: liveAttacker.nickname
      }, pending.attackConfig, now);
    }

    this.pendingMeleeHits = waiting;
  }

  _clearPendingMeleeHitsFor(playerId) {
    if (!this.pendingMeleeHits?.length) return;
    this.pendingMeleeHits = this.pendingMeleeHits.filter(hit => hit.playerId !== playerId);
  }

  _applyMeleeHits(attacker, attackConfig, now) {
    let hitCount = 0;

    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      const hit = this._resolveMeleeHitResult(attacker, target, attackConfig, now);
      if (!hit) return;

      hitCount++;
      this._applyMeleeHitMovement(attacker, target, hit);
      const died = target.takeDamage(hit.damage, attacker.nickname);
      if (!died) {
        // Conditional status effects carried on the hit result (Task 10).
        if (hit.stunMs) this._applyStun(target, hit.stunMs, now);
        if (hit.slowMs) this._applySlow(target, hit.slowMs);
        if (hit.bleed) this._applyBleed(target, attacker.id);
        if (hit.burn) this._applyBurn(target, attacker.id);
      }
      if (died) this._creditKill(attacker.id, target);
    });

    // Landing a hit on someone gives the local attacker a tiny hitstop (juice).
    // Tagged with the attacker; guests still get the synced damage numbers /
    // kill feed. The sink no-ops for anyone who isn't the local player.
    if (hitCount > 0) this.fx.hitstop(42, attacker.id);

    return hitCount;
  }

  _resolveMeleeHitResult(attacker, target, weapon, now = Date.now()) {
    if (!target || target.isInvincible?.()) return null;
    if (!Collision.checkMeleeHit(attacker, target, weapon)) return null;
    // A cover tile between attacker and target blocks the strike.
    if (this._terrainBlocksSegment(attacker.x, attacker.y, target.x, target.y)) {
      return null;
    }

    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    let damage = weapon.damage || 0;
    let pull = 0;
    let knockback = weapon.knockback || 0;
    let slowMs = 0, bleed = false, burn = false;

    if (weapon.type === 'melee_sweet_arc') {
      const sweetDistance = weapon.innerRange || weapon.range * 0.58;
      if (dist >= sweetDistance) {
        damage = weapon.sweetDamage || damage;
        pull = weapon.pull || 0;
        if (weapon.sweetBleed) bleed = true;        // scythe outer blade → bleed
      }
    } else if (weapon.type === 'melee_backstab') {
      const fromTargetToAttacker = Math.atan2(attacker.y - target.y, attacker.x - target.x);
      const behindAngle = (target.angle || 0) + Math.PI;
      const backstabWindow = ((weapon.backstabAngle || 95) * Math.PI) / 360;
      if (angleDistance(fromTargetToAttacker, behindAngle) <= backstabWindow) {
        damage = weapon.backstabDamage || damage;
      }
    } else if (weapon.type === 'melee_precise_line') {
      const uX = Math.cos(attacker.angle);
      const uY = Math.sin(attacker.angle);
      const perpDiff = Math.abs(dx * uY - dy * uX);
      // Centerline crit (only weapons that declare critDamage, e.g. combo finishers).
      if (weapon.critDamage) {
        const critWidth = Math.max(5, (weapon.width || 0) * 0.55) + (target.radius || 14) * 0.25;
        if (perpDiff <= critWidth) damage = weapon.critDamage;
      }
      // Dagger backstab: hit from the target's rear 90° → bonus + bleed.
      if (weapon.backstabDamage) {
        const fromTargetToAttacker = Math.atan2(attacker.y - target.y, attacker.x - target.x);
        const behindAngle = (target.angle || 0) + Math.PI;
        const win = ((weapon.backstabAngle || 90) * Math.PI) / 360;
        if (angleDistance(fromTargetToAttacker, behindAngle) <= win) {
          damage = weapon.backstabDamage;
          if (weapon.backstabBleed) bleed = true;
        }
      }
    } else if (weapon.type === 'melee_slam') {
      const inner = weapon.innerRange || weapon.range * 0.45;
      if (dist > inner + (target.radius || 14)) {
        damage = weapon.shockwaveDamage || Math.round(damage * 0.72);
      }
    }

    // Spear tip hit: the far 30px of the thrust → bonus + slow.
    if (weapon.tipDamage && weapon.type === 'melee_line') {
      const proj = dx * Math.cos(attacker.angle) + dy * Math.sin(attacker.angle);
      if (proj >= (weapon.range - (weapon.tipRange || 30))) {
        damage = weapon.tipDamage;
        if (weapon.tipSlowMs) slowMs = Math.max(slowMs, weapon.tipSlowMs);
      }
    }

    // Consecutive same-target chain (katana ramp / gauntlet uppercut). Tracked on
    // the LIVE attacker; bonuses only raise damage (never lower a finisher).
    const live = this.players[attacker.id];
    if (live && (weapon.chainHits || weapon.uppercutEvery)) {
      if (live._chainTargetId === target.id && now - (live._chainAt || 0) <= 2000) {
        live._chainCount = (live._chainCount || 1) + 1;
      } else {
        live._chainCount = 1;
        live._chainTargetId = target.id;
      }
      live._chainAt = now;
      if (weapon.chainHits && live._chainCount >= weapon.chainHits) {
        damage = Math.max(damage, weapon.chainDamage || damage);
      }
      if (weapon.uppercutEvery && live._chainCount % weapon.uppercutEvery === 0) {
        damage = Math.max(damage, weapon.uppercutDamage || damage);
        knockback = Math.max(knockback, weapon.uppercutKnockback || 0);
      }
    }

    // Unconditional on-hit status (axe bleed, hammer slow, finisher slow…).
    if (weapon.onHitBleed) bleed = true;
    if (weapon.onHitBurn) burn = true;
    if (weapon.onHitSlowMs) slowMs = Math.max(slowMs, weapon.onHitSlowMs);

    return { damage, pull, knockback, stunMs: weapon.stunMs || 0, slowMs, bleed, burn };
  }

  _applyMeleeHitMovement(attacker, target, hit) {
    if (!target || target.isDead) return;

    let dx = target.x - attacker.x;
    let dy = target.y - attacker.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-4) {
      dx = Math.cos(attacker.angle || 0);
      dy = Math.sin(attacker.angle || 0);
      len = 1;
    }
    const ux = dx / len;
    const uy = dy / len;

    if (hit.pull) {
      target.x -= ux * hit.pull;
      target.y -= uy * hit.pull;
    }
    if (hit.knockback) {
      target.x += ux * hit.knockback;
      target.y += uy * hit.knockback;
    }

    Collision.clampToMap(target, this.mapWidth, this.mapHeight);
    this._resolveOutOfTerrain(target);
  }

  _applyAttackTempoResult(player, attackConfig, hitCount, now) {
    if (hitCount > 0 && attackConfig.hitCooldownRefundMs) {
      const refund = Math.max(0, attackConfig.hitCooldownRefundMs);
      player.lastAttackTime -= refund;
      player.comboDelayUntil = Math.max(now, (player.comboDelayUntil || now) - refund);
    } else if (hitCount === 0 && attackConfig.missPenaltyMs) {
      player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + (attackConfig.cooldown || 0) + attackConfig.missPenaltyMs);
    }
  }

  _canUseAuxSkill(player, slot) {
    if (!player || player.isDead || player.stunTimeLeft > 0 || player.spearThrown) return false;
    if (player.greatswordChargeStart > 0 || player.katanaChargeStart > 0 || player.daggerQte) return false;
    const cfg = AuxSkillConfig[player.weapon]?.[slot];
    if (!cfg) return false;
    if (slot === 'alt') return !(player.altSkillCdLeft > 0);
    return !(player.targetSkillCdLeft > 0);
  }

  _castAuxAltSkill(player, now) {
    if (!this._canUseAuxSkill(player, 'alt')) return;
    this._executeAuxSkill(player, AuxSkillConfig[player.weapon].alt, now, 'alt');
  }

  _castAuxTargetSkill(player, now, targetX, targetY) {
    if (!this._canUseAuxSkill(player, 'target')) return;
    this._aimPlayerAt(player, targetX, targetY);
    this._executeAuxSkill(player, AuxSkillConfig[player.weapon].target, now, 'target');
  }

  _executeAuxSkill(player, cfg, now, slot) {
    if (!cfg) return;
    const cooldown = Math.max(0, cfg.cooldownMs || 0) / 1000;
    if (slot === 'alt') player.altSkillCdLeft = cooldown;
    else player.targetSkillCdLeft = cooldown;

    if (cfg.type === 'projectile') {
      this._spawnAuxProjectiles(player, cfg, now);
      return;
    }

    if (cfg.type === 'hitscan') {
      this._fireAuxHitscan(player, cfg, now);
      return;
    }

    if (cfg.type === 'aimed_shot') {
      if (!this.pendingAimedShots) this.pendingAimedShots = [];
      const fireAt = now + (cfg.windupMs || 400);
      this.pendingAimedShots.push({ playerId: player.id, fireAt, damage: cfg.damage || 26, range: cfg.range || 520, speed: cfg.speed || 1100 });
      // windup telegraph beam in the aim direction
      const dist = cfg.range || 520;
      this.effects.push({
        id: `${player.id}-aimwind-${now}`, attackerId: player.id,
        x: player.x, y: player.y,
        x2: player.x + Math.cos(player.angle) * dist, y2: player.y + Math.sin(player.angle) * dist,
        angle: player.angle, weapon: 'pistols', type: 'matchlock_telegraph',
        beamDist: dist, progress: 0, timestamp: now, lifetime: cfg.windupMs || 400
      });
      return;
    }

    if (cfg.type === 'dodge_reload') {
      // An iframe roll independent of the spacebar dash cooldown, then a buff.
      const dirX = Math.cos(player.angle), dirY = Math.sin(player.angle);
      player.dashDirX = dirX; player.dashDirY = dirY;
      player.dashTimeLeft = DashConfig.durationMs / 1000;
      player.iframeTimeLeft = Math.max(player.iframeTimeLeft || 0, DashConfig.iframeMs / 1000);
      player.pistolReloadUntil = now + (cfg.reloadMs || 2000);
      return;
    }

    if (cfg.type === 'place_mine') {
      this._placeMine(player, now);
      return;
    }

    if (cfg.type === 'tracer_mine') {
      this._placeTracerMine(player, now);
      return;
    }

    if (cfg.type === 'guardian_launch') {
      this._launchGuardianBlades(player, now);
      return;
    }

    if (cfg.type === 'guardian_homing') {
      this._spawnHomingBlade(player, now);
      return;
    }

    if (cfg.type === 'fire_bomb') {
      const bx = Math.max(8, Math.min(this.mapWidth - 8, player.x + Math.cos(player.angle) * (cfg.range || 88)));
      const by = Math.max(8, Math.min(this.mapHeight - 8, player.y + Math.sin(player.angle) * (cfg.range || 88)));
      const r = cfg.radius || 50;
      Object.values(this.players).forEach(t => {
        if (t.id === player.id || t.isDead || t.isInvincible()) return;
        if ((t.x - bx) ** 2 + (t.y - by) ** 2 > (r + (t.radius || 14)) ** 2) return;
        const died = t.takeDamage(cfg.damage || 28, player.nickname);
        if (!died && cfg.burn) this._applyBurn(t, player.id);
        if (died) this._creditKill(player.id, t, '점화로');
      });
      this.effects.push({
        attackerId: player.id, x: bx, y: by, weapon: 'flamethrower',
        type: 'explosion', radius: r, progress: 0, timestamp: now, lifetime: 360
      });
      return;
    }

    if (cfg.type === 'heat_shield') {
      player.heatShieldUntil = now + (cfg.durationMs || 1500);
      player.heatShieldRadius = cfg.contactRadius || 34;
      return;
    }

    if (cfg.type === 'chakram_throw') {
      const n = Math.max(1, cfg.count || 3);
      const intervalMs = 230;
      for (let i = 0; i < n; i++) {
        this.pendingChakrams.push({
          playerId: player.id,
          angle: player.angle,
          damage: cfg.damage || 18,
          range: cfg.range || 240,
          speed: cfg.speed || 680,
          fireAt: now + i * intervalMs,
          tag: `alt-${now}-${i}`
        });
      }
      this.effects.push({
        attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
        weapon: 'chakram', type: 'projectile_shot', projectileKind: 'chakram',
        progress: 0, timestamp: now, lifetime: 220
      });
      if (cfg.deflectProjectile) this._deflectProjectile(player, 70);
      return;
    }

    if (cfg.type === 'chakram_orbit') {
      player.chakramOrbitUntil = now + (cfg.durationMs || 1500);
      player.chakramOrbitDamage = cfg.orbitDamage || 14;
      player.chakramOrbitRadius = cfg.orbitRadius || 46;
      player.chakramOrbitHitCd = cfg.hitCooldownMs || 400;
      player.chakramOrbitHits = {};
      return;
    }

    const base = getEffectiveWeapon(player.weapon, player.buffType);
    const attackConfig = {
      ...base,
      ...cfg,
      cooldown: base.cooldown
    };

    if (attackConfig.lungeDistance) {
      this._lungePlayer(player, attackConfig.lungeDistance);
    }

    player.swingDirection *= -1;
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: player.weapon,
      buffType: player.buffType,
      type: attackConfig.type,
      range: attackConfig.range,
      width: attackConfig.width,
      innerRange: attackConfig.innerRange,
      angleDeg: attackConfig.angle,
      comboStep: 0,
      comboCycle: 0,
      comboFinisher: true,
      isSkill: true,
      swingDirection: player.swingDirection,
      progress: 0,
      timestamp: now,
      lifetime: Math.min(Math.max(480 + (attackConfig.delayDamageMs || 0), 300), 880)
    });

    const hitCount = this._queueOrApplyMeleeHit(player, attackConfig, now);
    if (hitCount !== null) this._applyAttackTempoResult(player, attackConfig, hitCount, now);

    // 쳐내기: knock out the nearest incoming enemy projectile in front of the player.
    if (cfg.deflectProjectile) this._deflectProjectile(player, attackConfig.range || 60);
  }

  // Destroy one enemy projectile within reach in front of the player (chakram 쳐내기).
  _deflectProjectile(player, reach) {
    let best = null, bestD = Infinity;
    for (const proj of this.projectiles) {
      if (!proj || proj.isDead || proj.ownerId === player.id) continue;
      const dx = proj.x - player.x, dy = proj.y - player.y;
      const d = Math.hypot(dx, dy);
      if (d > reach + (proj.radius || 6)) continue;
      if (Math.cos(player.angle) * dx + Math.sin(player.angle) * dy < 0) continue; // must be in front
      if (d < bestD) { bestD = d; best = proj; }
    }
    if (best) {
      best.isDead = true;
      if (best.locksOwner) { const o = this.players[best.ownerId]; if (o) o.chakramOut = false; }
    }
  }

  _spawnAuxProjectiles(player, cfg, now) {
    const count = Math.max(1, Math.floor(cfg.count || 1));
    const spread = ((cfg.spreadDeg || 0) * Math.PI) / 180;
    const spawnDist = player.radius + 4;
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * spread;
      const angle = player.angle + offset;
      const kind = cfg.projectileKind || 'arrow';
      const proj = new Projectile(
        `${player.id}-aux-${kind}-${now}-${i}`,
        player.id,
        player.x + Math.cos(angle) * spawnDist,
        player.y + Math.sin(angle) * spawnDist,
        angle,
        cfg.speed || 720,
        cfg.range,
        cfg.damage || 1,
        kind
      );
      proj.weapon = cfg.projectileWeapon || player.weapon;
      if (cfg.radius) proj.radius = cfg.radius;
      this.projectiles.push(proj);
    }
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: player.weapon,
      type: 'projectile_shot',
      projectileKind: cfg.projectileKind || 'arrow',
      progress: 0,
      timestamp: now,
      lifetime: 220
    });
  }

  _fireAuxHitscan(player, cfg, now) {
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    const maxDist = Number.isFinite(cfg.range) ? Math.min(cfg.range, wallDist) : wallDist;
    const coverDist = this._terrainRayDist(player.x, player.y, dirX, dirY);
    let hitDist = Math.min(Number.isFinite(maxDist) ? maxDist : Math.max(this.mapWidth, this.mapHeight), coverDist);
    let hitTarget = null;

    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === player.id || target.isDead || target.isInvincible()) return;
      const d = Collision.rayCircleHitDistance(player.x, player.y, dirX, dirY, target.x, target.y, target.radius);
      if (d !== null && d <= hitDist) {
        hitDist = d;
        hitTarget = target;
      }
    });

    if (hitTarget) {
      const died = hitTarget.takeDamage(cfg.damage || 1, player.nickname);
      if (died) this._creditKill(player.id, hitTarget);
    }

    this.effects.push({
      id: `${player.id}-auxbeam-${now}`,
      attackerId: player.id,
      x: player.x,
      y: player.y,
      x2: player.x + dirX * hitDist,
      y2: player.y + dirY * hitDist,
      angle: player.angle,
      weapon: player.weapon,
      type: 'railbeam',
      progress: 0,
      timestamp: now,
      lifetime: 300
    });
  }

  _aimPlayerAt(player, targetX, targetY) {
    const dx = targetX - player.x;
    const dy = targetY - player.y;
    if (Math.hypot(dx, dy) > 0.001) {
      player.angle = Math.atan2(dy, dx);
    }
  }

  _lungePlayer(player, distance) {
    const amount = Number.isFinite(distance) ? distance : 0;
    if (!amount) return;
    // Platformer: lunge along the HORIZONTAL aim component only, so auto-attacks
    // nudge you toward the cursor side instead of launching up/down. Swept
    // through the level so the lunge can't clip walls/platforms.
    const dir = Math.cos(player.angle) >= 0 ? 1 : -1;
    this._displace(player, dir * Math.abs(amount), 0);
  }

  /** Nearest forward distance to terrain (cover + solid level geometry) along a
   *  unit ray — used so hitscan shots stop at walls/ground/ledges. One-way
   *  platforms are intentionally NOT included (shots pass through them). */
  _terrainRayDist(ox, oy, dx, dy) {
    let d = Infinity;
    if (this.cover?.length) d = Math.min(d, coverRayDistance(this.cover, ox, oy, dx, dy));
    if (this.level?.solids?.length) d = Math.min(d, coverRayDistance(this.level.solids, ox, oy, dx, dy));
    return d;
  }

  /** True when a segment is blocked by terrain (cover or solid level geometry).
   *  Used for melee line-of-sight so you can't hit through a wall. */
  _terrainBlocksSegment(x0, y0, x1, y1) {
    if (this.cover?.length && coverBlocksSegment(this.cover, x0, y0, x1, y1)) return true;
    if (this.level?.solids?.length && coverBlocksSegment(this.level.solids, x0, y0, x1, y1)) return true;
    return false;
  }

  /** True when a circle (x,y,r) overlaps any SOLID level rect (not one-ways).
   *  Used to block projectiles / hitscan on walls, ground and ledges. */
  _levelSolidBlocks(x, y, r = 4) {
    const solids = this.level?.solids;
    if (!solids) return false;
    for (const s of solids) {
      if (x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h) return true;
    }
    return false;
  }

  /** True when a circle (x,y,r) overlaps any level rect (solids OR one-ways).
   *  Used by pogo to detect a surface to bounce off below the attacker. */
  _levelAnyOverlap(x, y, r = 6) {
    const all = this.level ? [...(this.level.solids || []), ...(this.level.oneWays || [])] : [];
    for (const s of all) {
      if (x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h) return true;
    }
    return false;
  }

  /**
   * Pogo (platformer): a downward air-attack that connects with an enemy or a
   * surface bounces the attacker straight back up. Called once per swing from
   * the attack paths with the swing's hit count.
   */
  _tryPogo(player, hitCount) {
    if (!player || player.grounded) return;
    if (Math.sin(player.angle) < 0.5) return;              // not aiming downward
    const reach = (player.halfH || 20) + 30;
    const surfaceBelow = (hitCount > 0) || this._levelAnyOverlap(player.x, player.y + reach, 7);
    if (!surfaceBelow) return;
    player.vy = -PHYS.pogoSpeed;
    player.jumping = false;
    player.coyoteLeft = 0;
  }

  /** Y of the nearest surface (solid OR one-way top) at or below `fromY` at
   *  column x — used to drop placed entities (mines / fire patches) onto the
   *  ground or platform instead of floating in mid-air. */
  _surfaceBelow(x, fromY) {
    if (!this.level) return fromY;   // no level (tests/mocks) → leave the point as-is
    let best = Infinity;
    const rects = [...(this.level.solids || []), ...(this.level.oneWays || [])];
    for (const s of rects) {
      if (x < s.x || x > s.x + s.w) continue;
      if (s.y >= fromY - 2 && s.y < best) best = s.y;
    }
    return Number.isFinite(best) ? best : (this.mapHeight || fromY);
  }

  /** Eject a body out of any solid level rect it overlaps (least-penetration
   *  axis, ties resolve upward). Used after absolute teleports / pulls so a
   *  player can't end up stuck inside a wall or platform. */
  _resolveOutOfTerrain(body) {
    const solids = this.level?.solids;
    if (!solids || !body) return;
    const hw = body.halfW || 13, hh = body.halfH || 20;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const s of solids) {
        const l = body.x - hw, r = body.x + hw, t = body.y - hh, b = body.y + hh;
        if (l < s.x + s.w && r > s.x && t < s.y + s.h && b > s.y) {
          const penL = r - s.x, penR = s.x + s.w - l, penT = b - s.y, penB = s.y + s.h - t;
          const m = Math.min(penL, penR, penT, penB);
          if (m === penT) body.y -= penT;
          else if (m === penB) body.y += penB;
          else if (m === penL) body.x -= penL;
          else body.x += penR;
          if (body.vy && ((m === penT && body.vy > 0) || (m === penB && body.vy < 0))) body.vy = 0;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** Sweep a player by (dx,dy) through the level so combat displacements
   *  (lunge/knockback/yanks) stop at terrain instead of clipping through it. */
  _displace(player, dx, dy) {
    if (!this.level) { player.x += dx; player.y += dy; return; }
    const svx = player.vx, svy = player.vy;
    player.vx = dx; player.vy = dy;
    Collision.moveAndCollide(player, this.level, 1, { dropThrough: false });
    player.vx = svx; player.vy = svy;
  }

  _resolveComboAttack(player, weaponConfig, now) {
    const comboConfig = ComboConfig[player.weapon];
    const comboLockedBySkill = player.weapon === 'axe' && player.buffType === 'axe_rage';
    if (!comboConfig || weaponConfig.type === 'projectile' || comboLockedBySkill) {
      player.comboStep = 0;
      return {
        weaponConfig,
        step: 0,
        cycle: 0,
        isFinisher: false,
        delayAfterMs: 0,
        recoveryMs: weaponConfig.cooldown || 0
      };
    }

    if (comboConfig.comboResetMs && now - (player.lastAttackTime || 0) > comboConfig.comboResetMs) {
      player.comboStep = 0;
    }

    const cycle = Math.max(1, comboConfig.cycle || 1);
    const step = ((player.comboStep || 0) % cycle) + 1;
    const isFinisher = step === cycle;
    const attackConfig = isFinisher
      ? { ...weaponConfig, ...(comboConfig.finisher || {}) }
      : { ...weaponConfig };

    return {
      weaponConfig: attackConfig,
      step,
      cycle,
      isFinisher,
      delayAfterMs: step === comboConfig.delayAfterStep ? comboConfig.delayBeforeFinisherMs || 0 : 0,
      recoveryMs: attackConfig.cooldown || weaponConfig.cooldown || 0
    };
  }

  _applyComboRecovery(player, combo, now) {
    if (!combo || !combo.cycle) {
      player.comboStep = 0;
      player.comboDelayUntil = now + (combo?.recoveryMs || 0);
      return;
    }

    player.comboStep = combo.isFinisher ? 0 : combo.step;
    const recoveryUntil = now + Math.max(combo.recoveryMs || 0, combo.delayAfterMs || 0);
    player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, recoveryUntil);

    // Push a visual "charging" effect during the pause before the finisher.
    // Renderer uses this to hold the weapon in pull-back position AND to preview
    // the upcoming finisher's hit range.
    if (combo.delayAfterMs > 0 && !combo.isFinisher && this.effects) {
      const comboConfig = ComboConfig[player.weapon];
      const baseWeapon = getEffectiveWeapon(player.weapon, player.buffType);
      const finisherShape = { ...baseWeapon, ...((comboConfig && comboConfig.finisher) || {}) };
      const readyEffect = {
        attackerId: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle,
        weapon: player.weapon,
        type: 'finisher_ready',
        comboFinisher: player.weapon === 'sword',
        progress: 0,
        timestamp: now,
        lifetime: combo.delayAfterMs
      };
      if (player.weapon !== 'greatsword') {
        // Shape of the upcoming finisher, used by the renderer to draw a range preview.
        readyEffect.previewType = finisherShape.type;
        readyEffect.previewRange = finisherShape.range;
        readyEffect.previewWidth = finisherShape.width;
        readyEffect.previewAngleDeg = finisherShape.angle;
      }
      this.effects.push(readyEffect);
    }
  }

  /**
   * Spawn stationary training dummies spread in a ring around the arena center.
   * They are normal Players flagged isDummy: they never move or attack (guarded
   * in the host loop) and respawn at their home spot when killed.
   */
  _spawnDummies(count) {
    const n = Math.max(1, Math.min(8, Math.floor(count) || 3));
    const cx = this.mapWidth / 2;
    const cy = this.mapHeight / 2;
    const ring = Math.min(this.mapWidth, this.mapHeight) * 0.3;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      const x = cx + Math.cos(a) * ring;
      const y = cy + Math.sin(a) * ring;
      const id = `dummy_${i}`;
      const d = new Player(id, `더미 ${i + 1}`, 'sword', x, y, { color: '#9aa0a6', accentColor: '#e5e7eb' });
      d.isDummy = true;
      d.homeX = x;
      d.homeY = y;
      this.players[id] = d;
    }
  }

  /**
   * Spawn `count` AI bots (host only). Each is a normal Player flagged `isBot`
   * with a curated weapon and an attached BotBrain (see Bot.js). Their input is
   * synthesized every host tick by _updateBots; the rest of the sim is shared.
   */
  _spawnBots(count, difficulty = 'normal') {
    const n = Math.max(0, Math.min(12, Math.floor(count) || 0));
    if (!this.botWorkshopWeapons.length) {
      console.warn('[bots] no workshop weapons available; bots were not spawned');
      return;
    }
    const loadout = Array.from({ length: n }, () => this._pickBotWorkshopWeapon()).filter(Boolean);
    if (loadout.length < n) {
      console.warn('[bots] failed to assign workshop weapons to every bot; bots were not spawned');
      return;
    }
    const NAMES = ['글라디우스', '레기온', '발로르', '모르가나', '카이저', '도르', '벨라', '녹스', '아레스', '루멘', '가레스', '세라핌'];
    for (let i = 0; i < n; i++) {
      const workshopWeapon = loadout[i];
      const spawnP = this._getRandomSpawnPoint();
      const id = `bot_${this._botSeq++}`;
      const name = NAMES[i % NAMES.length];
      const bot = new Player(id, `🤖${name}`, 'sword', spawnP.x, spawnP.y, { workshopWeapon });
      if (!bot.workshopWeapon) {
        bot._applyWorkshopWeapon(workshopWeapon);
        bot.hp = bot.maxHp;
      }
      if (!bot.workshopWeapon) continue;
      bot.isBot = true;
      bot.keys = {};
      bot.brain = new BotBrain(bot, difficulty);
      this._bots.push(bot.brain);
      this.players[id] = bot;
    }
  }

  _pickBotWorkshopWeapon() {
    const list = this.botWorkshopWeapons;
    if (!list.length) return null;
    const raw = list[Math.floor(Math.random() * list.length)];
    try {
      if (typeof structuredClone === 'function') return structuredClone(raw);
    } catch {}
    try { return JSON.parse(JSON.stringify(raw)); } catch { return raw; }
  }

  /**
   * Drive every alive bot one host tick: build a shared context, let each brain
   * synthesize its keys/aim, then route its one-shot intents (dash/skill)
   * through the same action helpers a human's input uses. Runs BEFORE the player
   * physics loop so the freshly-set keys are consumed this same frame.
   */
  _updateBots(dt, now) {
    if (!this._bots.length) return;
    const ctx = this._botContext();
    for (const brain of this._bots) {
      const bot = brain.player;
      if (!bot || bot.isDead) { if (bot) bot.keys = {}; continue; }
      const intents = brain.think(dt, now, ctx);
      if (intents.dash) this._tryDash(bot, intents.dash.dx, intents.dash.dy);
      if (intents.skill) this._handleSkillPressed(bot, now);
      if (intents.altSkill) {
        this._handleAltSkillPressed(bot, now);
        // Katana R is a hold-then-release charge; auto-release so the bot never
        // gets stuck mid-charge (charging blocks its basic attacks).
        if (bot.weapon === 'katana') bot._botAltReleaseAt = now + 420;
      }
      if (bot._botAltReleaseAt && now >= bot._botAltReleaseAt) {
        this._handleAltSkillReleased(bot, now);
        bot._botAltReleaseAt = 0;
      }
    }
  }

  /** Read-only world view + nav helpers handed to each bot brain each tick. */
  _botContext() {
    const z = this.zone;
    const damaging = !!(z && typeof z.isDamaging === 'function' && z.isDamaging());
    const floorY = damaging ? (z.floorY ?? Infinity) : Infinity;
    return {
      players: this.players,
      healingItems: this.healingItems,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      zoneDamaging: damaging,
      zoneFloorY: floorY,
      zoneSafeX: (x) => ({
        min: damaging ? (z.leftX ?? 0) + 24 : 0,
        max: damaging ? (z.rightX ?? this.mapWidth) - 24 : this.mapWidth,
      }),
      weaponOf: (p) => p?.workshopWeapon?.stats
        ? { ...getEffectiveWeapon(p.weapon, p.buffType), ...p.workshopWeapon.stats }
        : getEffectiveWeapon(p.weapon, p.buffType),
      solidBlocks: (x, y, r) => this._levelSolidBlocks(x, y, r),
      surfaceBelow: (x, fromY) => this._surfaceBelow(x, fromY),
      // Nearest platform/solid TOP still above the flood — where a bot should
      // climb when the lava nears its footing. Null when nothing is safe.
      // Skips wall-like solids (much taller than wide — their tops aren't real
      // footing) and anything the flood is about to swallow.
      nearestSafePerch: (x, footY) => {
        if (!damaging || !this.level) return null;
        let best = null, bestScore = Infinity;
        const consider = (s) => {
          if (s.h > s.w * 3) return;                  // wall, not footing
          const top = s.y;
          if (top > floorY - 60) return;              // flooded / about to be
          const cx = Math.max(s.x + 16, Math.min(x, s.x + s.w - 16));
          const score = Math.abs(cx - x) + Math.max(0, footY - top) * 0.35;
          if (score < bestScore) { bestScore = score; best = { x: cx, y: top }; }
        };
        for (const s of (this.level.oneWays || [])) consider(s);
        for (const s of (this.level.solids || [])) consider(s);
        return best;
      },
      // True when the only thing under the feet here is a one-way platform (so a
      // drop-through actually moves the bot down toward a lower target).
      onOneWayOnly: (x, footY) => {
        const ow = (this.level?.oneWays || []).some(s => x >= s.x && x <= s.x + s.w && Math.abs(s.y - footY) <= 6);
        const solid = (this.level?.solids || []).some(s => x >= s.x && x <= s.x + s.w && Math.abs(s.y - footY) <= 6);
        return ow && !solid;
      },
    };
  }

  /**
   * Credit a kill + broadcast a feed line.
   */
  _creditKill(killerId, target, viaLabel = '') {
    const killer = this.players[killerId];
    if (killer) {
      // Practice dummies are tallied separately so they never earn coins/rank
      // (see Game.quit → handleMatchEnd). They still show on the HUD for feel,
      // and never spam the kill feed.
      if (target.isDummy) {
        killer.dummyKills = (killer.dummyKills || 0) + 1;
        return;
      }
      killer.kills++;
      const via = viaLabel ? `${viaLabel} ` : '';
      this._announce(`${killer.nickname}님이 ${via}${target.nickname}님을 처치했습니다!`);

      // Kill juice for the slayer: a heavier hitstop + a strong shake make the
      // finishing blow land. Tagged with the killer — the sink decides whether
      // that is the local player (headless server: no-op).
      this.fx.hitstop(65, killer.id);
      this.fx.shake(14, 340, killer.id);
      this.fx.vibrate([40, 25, 55], killer.id);
      this.fx.sfx('kill', killer.id);

      // Kill feed: broadcast so every peer shows it, and add locally (host).
      const evt = Protocol.killEvent(
        killer.id, killer.nickname, target.id, target.nickname,
        killer.weapon, viaLabel,
        killer.title || null, target.title || null
      );
      if (this.networkManager?.isHost) this.networkManager.broadcast(evt);
      this.fx.killFeed(evt);

      // Cosmetic kill effect at the victim (equipped kill-fx), synced to all.
      const kfx = killer.killFx;
      if (kfx && kfx.style && target) {
        this.effects.push({
          attackerId: killer.id, x: target.x, y: target.y,
          weapon: '', type: 'kill_fx', style: kfx.style, color: kfx.color || '#ffd24a',
          progress: 0, timestamp: Date.now(), lifetime: 520
        });
      }
    } else {
      this._announce(`${target.nickname}님이 전사했습니다.`);
    }
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

  // --- Storm zone (Task 5) --------------------------------------------------
  _updateZone(now, deltaTime) {
    this._updateRingOutDeaths(now);
    if (!this.zone || typeof this.zone.update !== 'function') return; // host only
    this.zone.update(now);
    if (!zoneIsDamaging(this.zone)) return;
    Object.values(this.players).forEach(p => {
      if (p.isDead || p.isDummy) return;
      if (p.isInvincible && p.isInvincible()) return; // respawn i-frames are safe
      if (now < (p.zoneGraceUntil || 0)) return;      // explicit respawn lava grace
      if (!zoneIsOutside(this.zone, p.x, p.y)) { p._zoneDmgAcc = 0; return; }
      this._killByEnvironment(p, '위험지대에', now);
    });
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

  _updateRingOutDeaths(now) {
    const bottomLimit = (this.mapHeight || 0) + 220;
    Object.values(this.players).forEach(p => {
      if (p.isDead || p.isDummy) return;
      if (p.y > bottomLimit || p.x < -160 || p.x > (this.mapWidth || 0) + 160) {
        this._killByEnvironment(p, '낙사로', now);
      }
    });
  }

  _killByEnvironment(player, viaLabel, now) {
    if (!player || player.isDead) return;
    player.hp = 0;
    player.isDead = true;
    player._zoneDmgAcc = 0;
    this._creditKill(null, player, viaLabel);
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      weapon: '',
      type: 'danger_pop',
      progress: 0,
      timestamp: now,
      lifetime: 420
    });
  }

  _spawnLandingDust(player, now, fallVy = 0) {
    if (!player || player.isDead) return;
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y + (player.halfH || 20),
      weapon: '',
      type: 'landing_dust',
      strength: Math.max(0.6, Math.min(1.5, fallVy / 900)),
      progress: 0,
      timestamp: now,
      lifetime: 360
    });
  }

  // --- Healing items (Task 9) -----------------------------------------------
  _healInterval() {
    return HEAL_RATES[this.roomConfig.healingRate] || HEAL_RATES.normal;
  }
  _maxHealingItems() {
    return Math.max(2, Math.round((this.mapWidth * this.mapHeight) / (700 * 700) * 3));
  }
  /**
   * Resolve the biome + water layout from roomConfig and compute the combined
   * movement-blocker list. Deterministic (water comes from map size, like the
   * grass), so host and clients build the identical terrain with no extra sync.
   * Call after `this.cover`, `this.roomConfig` and the map dims are set.
   */
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

  /** Build the side-scroller level from the room's arena-size preset and adopt
   *  its pixel size as the map bounds. Deterministic → host + clients match. */
  _buildLevel() {
    const side = arenaDimensions(this.roomConfig).mapWidth;
    this.level = buildLevel(side, this.roomConfig);
    this.mapWidth = this.level.width;
    this.mapHeight = this.level.height;
  }

  _buildTerrain() {
    this.biome = this.roomConfig?.biome || 'day';
    this.frozen = this.biome === 'snow';      // frozen water = walkable
    // Reuse the synced per-match cover seed (a derived value so water and cover
    // don't correlate) — deterministic across clients, no extra sync.
    const waterSeed = ((this.coverSeed ^ 0x9e3779b9) >>> 0);
    this.water = this.roomConfig?.water
      ? generateWater(this.mapWidth, this.mapHeight, waterSeed)
      : emptyWater();
    // Platformer cover is baked into Level.solids so it is visible and collides
    // through the same AABB path. Keep the old top-down random cover disabled
    // here; otherwise invisible rectangles would still block projectiles/LOS.
    this.cover = [];
    // Water blocks movement only when not frozen. Platformer movement currently
    // uses level geometry, so this list is retained only for legacy callers.
    this.moveTiles = this.frozen
      ? this.cover
      : this.cover.concat(this.water.tiles);
  }
  _findEmptyPosition() {
    const anchors = this.level?.itemSpawns;
    if (Array.isArray(anchors) && anchors.length) {
      const shuffled = anchors
        .map(a => ({ a, sort: Math.random() }))
        .sort((l, r) => l.sort - r.sort)
        .map(v => v.a);
      for (const a of shuffled) {
        const x = a.x, y = a.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        let tooClose = false;
        for (const p of Object.values(this.players)) {
          if (p.isDead) continue;
          if ((p.x - x) ** 2 + (p.y - y) ** 2 < 110 * 110) { tooClose = true; break; }
        }
        if (tooClose) continue;
        if (this.healingItems.some(it => (it.x - x) ** 2 + (it.y - y) ** 2 < 90 * 90)) continue;
        return { x, y };
      }
    }
    const margin = 90;
    for (let i = 0; i < 24; i++) {
      const x = margin + Math.random() * (this.mapWidth - margin * 2);
      const y = margin + Math.random() * (this.mapHeight - margin * 2);
      if (this.moveTiles.length && !coverClearOfPoint(this.moveTiles, x, y, 28)) continue;
      let tooClose = false;
      for (const p of Object.values(this.players)) {
        if (p.isDead) continue;
        if ((p.x - x) ** 2 + (p.y - y) ** 2 < 120 * 120) { tooClose = true; break; }
      }
      if (tooClose) continue;
      if (this.healingItems.some(it => (it.x - x) ** 2 + (it.y - y) ** 2 < 100 * 100)) continue;
      return { x, y };
    }
    return null;
  }
  _updateHealingItems(now) {
    if (typeof this.zone === 'undefined') return; // guard for partial mocks
    if (!this.roomConfig.healing || !this.networkManager?.isHost) return;

    // Pickups: any live player overlapping an item heals 25% and consumes it.
    if (this.healingItems.length) {
      for (const item of this.healingItems) {
        if (item.taken) continue;
        for (const p of Object.values(this.players)) {
          if (p.isDead || p.isDummy) continue;
          const rr = (p.radius || 14) + 12;
          if ((p.x - item.x) ** 2 + (p.y - item.y) ** 2 <= rr * rr) {
            item.taken = true;
            p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));
            break;
          }
        }
      }
      this.healingItems = this.healingItems.filter(i => !i.taken);
    }

    // Spawn on the configured cadence, up to a small cap.
    if (!this._nextHealAt) this._nextHealAt = now + this._healInterval();
    if (now >= this._nextHealAt) {
      if (this.healingItems.length < this._maxHealingItems()) {
        const pos = this._findEmptyPosition();
        if (pos) this.healingItems.push({ id: ++this._healingSeq, x: pos.x, y: pos.y });
      }
      this._nextHealAt = now + this._healInterval();
    }
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

  _applyWorkshopWeaponNow(player, workshopWeapon) {
    if (!player || !workshopWeapon) return;
    player._applyWorkshopWeapon(workshopWeapon);
    player.pendingWeapon = null;
    player.pendingWorkshopWeapon = null;
    player.hp = Math.min(player.hp, player.maxHp);
    player.lastAttackTime = 0;
    player.clearCombatTimers();
    this._clearPendingSwordWavesFor(player.id);
    this._clearPendingRailgunsFor(player.id);
    this._clearPendingMagicShardsFor(player.id);
    this._clearPendingMeleeHitsFor(player.id);
    this._clearPendingHammerSlamsFor(player.id);
    this._clearPendingSniperShotsFor(player.id);
    this._clearPendingMatchlockShotsFor(player.id);
  }

  /**
   * Apply a weapon swap immediately (dummy room). Clears any weapon-specific
   * charge/buff/projectile state so the new weapon starts clean, and clamps HP
   * to the new max without auto-healing.
   */
  _applyWeaponNow(player, weapon) {
    if (!Weapons[weapon] || player.weapon === weapon) return;
    player.weapon = weapon;
    player.maxHp = Weapons[weapon].maxHp || 100;
    player.hp = Math.min(player.hp, player.maxHp);
    player.pendingWeapon = null;
    player.pendingWorkshopWeapon = null;
    player.workshopWeapon = null;
    player.lastAttackTime = 0;
    player.clearCombatTimers();
    this._clearPendingSwordWavesFor(player.id);
    this._clearPendingRailgunsFor(player.id);
    this._clearPendingMagicShardsFor(player.id);
    this._clearPendingMeleeHitsFor(player.id);
    this._clearPendingHammerSlamsFor(player.id);
    this._clearPendingSniperShotsFor(player.id);
    this._clearPendingMatchlockShotsFor(player.id);
  }

  /**
   * Route a one-shot action (dash/skill) from any player (host-local or guest).
   */
  _handlePlayerAction(player, data, now) {
    if (!player || player.isDead) return;
    if (data.action === 'dash') {
      const hasDir = Number.isFinite(data.dx) || Number.isFinite(data.dy);
      const v = hasDir ? { dx: data.dx || 0, dy: data.dy || 0 } : dirFromKeys(player.keys || {});
      this._tryDash(player, v.dx, v.dy);
    } else if (data.action === 'skill' || data.action === 'skillDown') {
      this._handleSkillPressed(player, now);
    } else if (data.action === 'skillUp') {
      this._handleSkillReleased(player, now);
    } else if (data.action === 'teleport') {
      this._handleAltSkillPressed(player, now);
    } else if (data.action === 'teleportUp') {
      this._handleAltSkillReleased(player, now);
    } else if (data.action === 'basicAttack') {
      if (this._isMotionLocked(player, now)) return;
      this._applyMobileAimAssistForAttack(player, 'basic');
      this._performBasicAttack(player, getEffectiveWeapon(player.weapon, player.buffType), now);
    } else if (data.action === 'ultimate') {
      this._handleUltimatePressed(player, now);
    } else if (data.action === 'targetCast') {
      this._handleTargetCast(player, data.x, data.y, now);
    }
  }

  _tryDash(player, dirX, dirY) {
    if (!player || player.isDead) return;
    if (player.daggerQte) return;
    if (player.startDash(dirX, dirY)) {
      this._triggerStickMotion(player, 'dash', Date.now());
      this.fx.sfx('dash', player.id);
    }
  }

  /** Emit a synced stick_motion overlay so an equipped workshop weapon's authored
   *  skill/dash motion plays for every viewer (no-op for base weapons or when the
   *  weapon didn't author that motion tag). */
  _triggerStickMotion(player, tag, now) {
    const m = player && player.workshopWeapon && player.workshopWeapon.motionSet && player.workshopWeapon.motionSet[tag];
    if (!m || !Array.isArray(m.keyframes) || !m.keyframes.length) return;
    const life = Math.max(200, Math.min(1500, Math.round((m.duration || 0.6) * 1000)));
    this.effects.push({ attackerId: player.id, x: player.x, y: player.y, weapon: '', type: 'stick_motion', tag, progress: 0, timestamp: now, lifetime: life });
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

  _handleSkillPressed(player, now) {
    if (!player || player.isDead || player.stunTimeLeft > 0) return;
    // An equipped workshop weapon's OWN skill1 ability (if authored) replaces the
    // base weapon's hardcoded F-skill entirely — its stats assume no workshop kit.
    if (this._activateWorkshopSkill(player, 'skill', now)) return;
    if (this._isMotionLocked(player, now)) return;
    this._triggerStickMotion(player, 'skill', now);   // workshop weapon's F-skill motion (cosmetic)
    if (player.weapon === 'dagger' && player.daggerQte) {
      this._tryDaggerQteInput(player, now);
      return;
    }
    if (player.weapon === 'magicstaff') {
      this._castMagicFireballSkill(player, now);
      return;
    }
    if (player.weapon === 'greatsword') {
      this._startGreatswordCharge(player, now);
      return;
    }
    this._activateSkill(player, now);
  }

  _handleSkillReleased(player, now) {
    if (!player || player.isDead) return;
    if (player.weapon === 'greatsword') {
      this._releaseGreatswordCharge(player, now);
    }
  }

  _handleUltimatePressed(player, now) {
    if (!player || player.isDead || player.stunTimeLeft > 0) return;
    if ((Number(player.ultimateGauge) || 0) < 100) return;
    const hasUltimate = Boolean(player.workshopWeapon?.presetCombat?.ultimate);
    if (!hasUltimate) {
      if (player.id === this.localPlayerId) this._announce('궁극기 스킬이 없습니다');
      return;
    }
    if (this._isMotionLocked(player, now)) return;
    player.ultimateGauge = 0;
    if (!player.wsSkillCd) player.wsSkillCd = {};
    player.wsSkillCd.ultimate = 0;
    this._activateWorkshopSkill(player, 'ultimate', now);
  }

  _handleAltSkillPressed(player, now) {
    if (!player || player.isDead || player.stunTimeLeft > 0) return;
    if (this._activateWorkshopSkill(player, 'skill2', now)) return;
    if (this._isMotionLocked(player, now)) return;
    this._triggerStickMotion(player, 'skill2', now);   // workshop weapon's E-skill motion (cosmetic)
    if (player.weapon === 'sniper') {
      this._handleTeleport(player, now);
    } else if (player.weapon === 'magicstaff') {
      this._castMagicLifeboundSkill(player, now);
    } else if (player.weapon === 'katana') {
      this._startKatanaIaijutsuCharge(player, now);
    } else {
      this._castAuxAltSkill(player, now);
    }
  }

  _handleAltSkillReleased(player, now) {
    if (!player || player.isDead) return;
    if (player.weapon === 'katana') {
      this._releaseKatanaIaijutsu(player, now, false);
    }
  }

  _handleTargetCast(player, x, y, now) {
    if (!player || player.isDead || player.stunTimeLeft > 0) return;
    // The R-skill fires toward the aim direction — workshop skill3 uses the same
    // facing/aim angle a ranged ability would (already resolved into player.angle
    // by the caller); melee skill3 swings its hitboxes from the player's position.
    if (this._activateWorkshopSkill(player, 'skill3', now)) return;
    if (this._isMotionLocked(player, now)) return;
    this._triggerStickMotion(player, 'skill3', now);   // 스킬3 (R) motion
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const targetX = Math.max(0, Math.min(this.mapWidth, x));
    const targetY = Math.max(0, Math.min(this.mapHeight, y));
    if (player.weapon === 'sniper' && player.sniperTeleportTargetUntil > now) {
      this._sniperTeleportTo(player, now, targetX, targetY);
    } else if (player.weapon === 'magicstaff') {
      this._castMagicIceSkill(player, now, targetX, targetY);
    } else {
      this._castAuxTargetSkill(player, now, targetX, targetY);
    }
  }

  _canUseSkill(player) {
    if (!player || player.isDead || player.stunTimeLeft > 0 ||
        player.buffTimeLeft > 0 || player.skillCdLeft > 0 || player.spearThrown) {
      return false;
    }
    if (player.greatswordChargeStart > 0 || player.katanaChargeStart > 0 || player.daggerQte) return false;
    if (!SkillConfig[player.weapon]) return false;
    if (player.weapon === 'bow') {
      return (player.arrowStacks || 0) > 0;
    }
    return true;
  }

  _tickMagicCooldowns(player, deltaTime) {
    if (!player?.magicCooldowns) return;
    ['fireball', 'iceShard', 'lifebound'].forEach(key => {
      if (player.magicCooldowns[key] > 0) {
        player.magicCooldowns[key] = Math.max(0, player.magicCooldowns[key] - deltaTime);
      }
    });
  }

  _canUseMagic(player, spell) {
    if (!player || player.isDead || player.stunTimeLeft > 0 || player.weapon !== 'magicstaff') return false;
    if (!MagicConfig[spell]) return false;
    const cooldowns = player.magicCooldowns || (player.magicCooldowns = { fireball: 0, iceShard: 0, lifebound: 0 });
    return !(cooldowns[spell] > 0);
  }

  _startMagicCooldown(player, spell) {
    const cfg = MagicConfig[spell];
    if (!player || !cfg) return;
    if (!player.magicCooldowns) player.magicCooldowns = { fireball: 0, iceShard: 0, lifebound: 0 };
    player.magicCooldowns[spell] = (cfg.cooldownMs || MagicConfig.cooldownMs || 2000) / 1000;
  }

  /**
   * Activate the weapon's F skill (host-authoritative).
   */
  _activateSkill(player, now) {
    if (!this._canUseSkill(player)) return;

    // Only the two built-in weapons remain (workshop weapons drive their F via
    // block gimmicks, not this switch).
    switch (player.weapon) {
      case 'sword': this._castSwordSkill(player, now); break;
      case 'greatsword': this._startGreatswordCharge(player, now); break;
      default: break;
    }
  }

  _startBuff(player, buffType, buffMs, now) {
    player.buffType = buffType;
    player.buffTimeLeft = buffMs / 1000;
    if (buffType === 'axe_rage') {
      player.comboStep = 0;
      player.comboDelayUntil = 0;
    }
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: player.weapon,
      buffType,
      type: 'buff_activate',
      progress: 0,
      timestamp: now,
      lifetime: 520
    });
  }

  _castMeleeSkill(player, now) {
    const sk = SkillConfig[player.weapon];
    if (!sk) return;

    const base = getEffectiveWeapon(player.weapon, player.buffType);
    const attackConfig = {
      ...base,
      ...sk,
      cooldown: base.cooldown
    };

    if (attackConfig.lungeDistance) {
      this._lungePlayer(player, attackConfig.lungeDistance);
    }

    player.swingDirection *= -1;
    const effect = {
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: player.weapon,
      buffType: player.buffType,
      type: attackConfig.type,
      range: attackConfig.range,
      width: attackConfig.width,
      innerRange: attackConfig.innerRange,
      angleDeg: attackConfig.angle,
      comboStep: 0,
      comboCycle: 0,
      comboFinisher: true,
      isSkill: true,
      swingDirection: player.swingDirection,
      progress: 0,
      timestamp: now,
      lifetime: Math.min(Math.max(520 + (attackConfig.delayDamageMs || 0), 360), 980)
    };
    this.effects.push(effect);

    const hitCount = this._queueOrApplyMeleeHit(player, attackConfig, now);
    if (hitCount !== null) {
      this._applyAttackTempoResult(player, attackConfig, hitCount, now);
    }

    player.skillCdLeft = sk.cooldownMs / 1000;
  }

  _startGreatswordCharge(player, now) {
    if (!this._canUseSkill(player)) return;
    const sk = SkillConfig.greatsword;
    player.greatswordChargeStart = now;
    player.greatswordChargeAngle = player.angle;
    player.comboStep = 0;
    player.comboDelayUntil = 0;
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'greatsword',
      type: 'greatsword_charge',
      range: sk.range,
      width: sk.width,
      angleDeg: sk.angle,
      progress: 0,
      timestamp: now,
      lifetime: sk.chargeMaxMs
    });
  }

  _releaseGreatswordCharge(player, now) {
    if (!player || player.greatswordChargeStart <= 0) return;
    const sk = SkillConfig.greatsword;
    const heldMs = Math.max(0, now - player.greatswordChargeStart);
    const chargeRatio = clamp01(heldMs / (sk.chargeMaxMs || 3000));
    const threshold = clamp01(sk.chargeThreshold ?? 0.5);
    const minDamage = sk.minDamage ?? sk.damage ?? 85;
    const thresholdDamage = sk.thresholdDamage ?? minDamage;
    const maxDamage = sk.damage ?? minDamage;
    const damage = chargeRatio < threshold
      ? minDamage
      : Math.round(thresholdDamage + (maxDamage - thresholdDamage) * ((chargeRatio - threshold) / Math.max(0.001, 1 - threshold)));
    player.greatswordChargeStart = 0;
    player.greatswordChargeAngle = 0;
    player.skillCdLeft = sk.cooldownMs / 1000;
    player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + (sk.attackLockMs || 0));

    // Reach scales with charge so a partial charge only cuts as far as its
    // preview shows (matches _drawGreatswordCharge's 0.38 + 0.62*progress).
    const effectiveRange = (sk.range || 128) * (0.38 + 0.62 * chargeRatio);

    const attackConfig = {
      ...Weapons.greatsword,
      ...sk,
      range: effectiveRange,
      damage,
      cooldown: Weapons.greatsword.cooldown,
      chargeRatio,
      // Full charge also slows (Task 10).
      onHitSlowMs: chargeRatio >= 0.99 ? (sk.fullChargeSlowMs || 0) : 0
    };

    const effect = {
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'greatsword',
      // Visual stays the heavy cleave arc; the hit test uses the blade-sweep
      // type on attackConfig. Both share the same (narrowed) angle.
      type: 'melee_heavy_arc',
      range: attackConfig.range,
      width: attackConfig.width,
      angleDeg: attackConfig.angle,
      comboFinisher: true,
      isSkill: true,
      chargeRatio,
      swingDirection: 1,
      progress: 0,
      timestamp: now,
      lifetime: 720
    };
    this.effects.push(effect);
    const hitCount = this._queueOrApplyMeleeHit(player, attackConfig, now);
    if (hitCount !== null) this._applyAttackTempoResult(player, attackConfig, hitCount, now);
  }

  _processGreatswordCharges(now) {
    const maxMs = SkillConfig.greatsword?.chargeMaxMs || 3000;
    Object.values(this.players).forEach(player => {
      if (!player || player.isDead || player.weapon !== 'greatsword') return;
      if (player.greatswordChargeStart > 0 && now - player.greatswordChargeStart >= maxMs) {
        this._releaseGreatswordCharge(player, now);
      }
    });
  }

  _startDaggerQte(player, now) {
    if (!this._canUseSkill(player)) return;
    const target = this._findNearestEnemy(player);
    const sk = SkillConfig.dagger;
    if (!target) {
      player.skillCdLeft = Math.min(1.5, sk.cooldownMs / 1000);
      return;
    }

    player.daggerQte = {
      targetId: target.id,
      phase: 'lock',
      actionAt: now + sk.lockMs,
      perfectAt: 0,
      expiresAt: now + sk.lockMs + sk.windowMs,
      iframeUntil: now + sk.lockMs + sk.windowMs
    };
    player.iframeTimeLeft = Math.max(player.iframeTimeLeft || 0, (sk.lockMs + sk.windowMs) / 1000);
    player.skillCdLeft = sk.cooldownMs / 1000;
    this.effects.push({
      attackerId: player.id,
      targetId: target.id,
      x: player.x,
      y: player.y,
      weapon: 'dagger',
      type: 'dagger_qte_lock',
      progress: 0,
      timestamp: now,
      lifetime: sk.lockMs
    });
  }

  _processDaggerQtes(now) {
    Object.values(this.players).forEach(player => {
      const qte = player?.daggerQte;
      if (!qte) return;

      const target = this.players[qte.targetId];
      if (!target || target.isDead || player.isDead) {
        this._clearDaggerQte(player, qte, now);
        return;
      }

      if (qte.phase === 'lock' && now >= qte.actionAt) {
        const sk = SkillConfig.dagger;
        this._placeBehindTarget(player, target, 34);
        player.angle = Math.atan2(target.y - player.y, target.x - player.x);
        qte.phase = 'window';
        qte.perfectAt = now + sk.perfectMs;
        qte.expiresAt = now + sk.windowMs;
        qte.iframeUntil = now + sk.windowMs;
        this.effects.push({
          attackerId: player.id,
          targetId: target.id,
          x: player.x,
          y: player.y,
          weapon: 'dagger',
          type: 'dagger_qte_window',
          progress: 0,
          timestamp: now,
          lifetime: sk.windowMs,
          perfectMs: sk.perfectMs
        });
      }

      if (qte.phase === 'window') {
        player.angle = Math.atan2(target.y - player.y, target.x - player.x);
      }

      if (qte.phase === 'window' && now > qte.expiresAt) {
        this._failDaggerQte(player, qte, now);
      }
    });
  }

  _tryDaggerQteInput(player, now) {
    const qte = player?.daggerQte;
    if (!qte || qte.phase !== 'window') return false;

    const target = this.players[qte.targetId];
    if (!target || target.isDead || target.isInvincible()) {
      this._clearDaggerQte(player, qte, now);
      return true;
    }

    const sk = SkillConfig.dagger;
    const diff = Math.abs(now - qte.perfectAt);
    const success = diff <= (sk.toleranceMs || 150);
    if (!success) {
      this._failDaggerQte(player, qte, now);
      return true;
    }

    this._clearDaggerQte(player, qte, now);
    player.angle = Math.atan2(target.y - player.y, target.x - player.x);
    this._lungePlayer(player, sk.dashDistance || 64);
    const died = target.takeDamage(sk.damage || 70, player.nickname);
    if (died) this._creditKill(player.id, target, '암습으로');
    this.effects.push({
      attackerId: player.id,
      targetId: target.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'dagger',
      type: 'dagger_qte_hit',
      progress: 0,
      timestamp: now,
      lifetime: 420
    });
    return true;
  }

  _clearDaggerQte(player, qte, now) {
    if (!player) return;
    player.daggerQte = null;
    if (qte?.iframeUntil) {
      player.iframeTimeLeft = 0;
    }
  }

  _failDaggerQte(player, qte, now) {
    const sk = SkillConfig.dagger;
    this._clearDaggerQte(player, qte, now);
    const failDamage = sk.failDamage || 10;
    player.hp = Math.max(0, player.hp - failDamage);
    if (player.hp <= 0) {
      player.isDead = true;
    } else {
      player.stunTimeLeft = Math.max(player.stunTimeLeft || 0, (sk.failStunMs || 300) / 1000);
    }
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      weapon: 'dagger',
      type: 'dagger_qte_fail',
      progress: 0,
      timestamp: now,
      lifetime: 320
    });
  }

  _findNearestEnemy(player) {
    let best = null;
    let bestDist = Infinity;
    Object.values(this.players).forEach(target => {
      if (!target || target.id === player.id || target.isDead) return;
      const dist = Math.hypot(target.x - player.x, target.y - player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = target;
      }
    });
    return best;
  }

  _placeBehindTarget(player, target, distance = 34) {
    const angle = (target.angle || 0) + Math.PI;
    player.x = target.x + Math.cos(angle) * distance;
    player.y = target.y + Math.sin(angle) * distance;
    Collision.clampToMap(player, this.mapWidth, this.mapHeight);
    this._resolveOutOfTerrain(player);
  }

  _castHammerSkill(player, now) {
    if (!this._canUseSkill(player)) return;
    const sk = SkillConfig.hammer;
    const waves = sk.waves || [];
    const previewMs = sk.previewMs ?? 1000;
    const delays = sk.waveDelaysMs || [];
    if (!this.pendingHammerSlams) this.pendingHammerSlams = [];

    // Lock the three shockwaves to the cast spot. After a 1s windup/preview each
    // wave fires waveDelaysMs[i] after the previous event → cast+1.8/2.6/3.8s.
    const originX = player.x;
    const originY = player.y;
    // Fire offsets from cast: windup, then each wave waveDelaysMs[i] later.
    let t = previewMs;
    const offsets = waves.map((wave, i) => {
      t += (delays[i] ?? delays[delays.length - 1] ?? 0);
      return t;
    });
    waves.forEach((wave, i) => {
      this.pendingHammerSlams.push({
        playerId: player.id,
        originX,
        originY,
        wave,
        waveIndex: i,
        releaseAt: now + offsets[i]
      });
    });

    player.skillCdLeft = sk.cooldownMs / 1000;
    // Block ALL basic attacks from cast until the final shockwave fires.
    player.hammerSkillUntil = now + (offsets[offsets.length - 1] || previewMs);

    const maxRange = waves.length ? waves[waves.length - 1].range : (sk.range || 150);
    // The preview's filling disc reaches each ring exactly when that wave fires
    // (hitOffsets), starting to grow after the windup (fillStartMs).
    this.effects.push({
      attackerId: player.id,
      x: originX,
      y: originY,
      weapon: 'hammer',
      type: 'hammer_windup',
      range: maxRange,
      ranges: waves.map(w => w.range),
      hitOffsets: offsets,
      fillStartMs: previewMs,
      worldAnchored: true,
      progress: 0,
      timestamp: now,
      lifetime: offsets[offsets.length - 1] || previewMs
    });
  }

  _processHammerSlams(now) {
    if (!this.pendingHammerSlams?.length) return;
    const waiting = [];
    for (const slam of this.pendingHammerSlams) {
      if (now < slam.releaseAt) {
        waiting.push(slam);
        continue;
      }
      const player = this.players[slam.playerId];
      if (!player || player.isDead || player.weapon !== 'hammer') continue;
      this._executeHammerWave(player, slam, now);
    }
    this.pendingHammerSlams = waiting;
  }

  _executeHammerWave(player, slam, now) {
    const sk = SkillConfig.hammer;
    const wave = slam.wave || {};
    const originX = Number.isFinite(slam.originX) ? slam.originX : player.x;
    const originY = Number.isFinite(slam.originY) ? slam.originY : player.y;

    const attackConfig = {
      type: 'melee_slam',
      range: wave.range,
      innerRange: wave.range,          // uniform damage across the whole radius
      damage: wave.damage,
      shockwaveDamage: wave.damage,
      stunMs: wave.stunMs || 0,
      knockback: wave.knockback ?? sk.knockback ?? 0
    };

    // Strike from the fixed cast spot (not the player's live position).
    const attacker = {
      id: player.id,
      nickname: player.nickname,
      x: originX,
      y: originY,
      angle: player.angle,
      radius: player.radius || 14
    };

    this.effects.push({
      attackerId: player.id,
      x: originX,
      y: originY,
      angle: player.angle,
      weapon: 'hammer',
      type: 'melee_slam',
      range: wave.range,
      innerRange: Math.round((wave.range || 0) * 0.5),
      waveIndex: slam.waveIndex,
      comboFinisher: slam.waveIndex === 2,
      isSkill: true,
      worldAnchored: true,
      progress: 0,
      timestamp: now,
      lifetime: 520
    });

    this._applyMeleeHits(attacker, attackConfig, now);
  }

  _clearPendingHammerSlamsFor(playerId) {
    if (!this.pendingHammerSlams?.length) return;
    this.pendingHammerSlams = this.pendingHammerSlams.filter(slam => slam.playerId !== playerId);
  }

  /**
   * Sword skill: release three sword-energy projectiles on a short cadence.
   */
  _castSwordSkill(player, now) {
    const sk = SkillConfig.sword;
    const waveCount = Math.max(1, Math.floor(sk.waveCount || 1));
    const waveIntervalMs = Math.max(0, sk.waveIntervalMs || 0);

    for (let i = 0; i < waveCount; i++) {
      this.pendingSwordWaves.push({
        playerId: player.id,
        castAt: now,
        releaseAt: now + waveIntervalMs * i,
        sequence: i
      });
    }

    player.skillCdLeft = sk.cooldownMs / 1000;
  }

  _releaseDueSwordWaves(now) {
    if (!this.pendingSwordWaves?.length) return;

    const waiting = [];
    for (const wave of this.pendingSwordWaves) {
      if (wave.releaseAt > now) {
        waiting.push(wave);
        continue;
      }

      const player = this.players[wave.playerId];
      if (!player || player.isDead || player.weapon !== 'sword') continue;
      this._spawnSwordWave(player, wave.castAt, wave.sequence);
    }
    this.pendingSwordWaves = waiting;
  }

  _spawnSwordWave(player, castAt, sequence) {
    const sk = SkillConfig.sword;
    const spawnDist = player.radius + 4;
    const angle = player.angle;
    const proj = new Projectile(
      `${player.id}-wave-${castAt}-${sequence}`,
      player.id,
      player.x + Math.cos(angle) * spawnDist,
      player.y + Math.sin(angle) * spawnDist,
      angle,
      sk.waveSpeed,
      Infinity,
      sk.directDamage,
      'swordwave'
    );
    proj.explosionRadius = sk.explosionRadius;
    proj.explosionDamage = sk.explosionDamage;
    proj.weapon = 'sword';
    this.projectiles.push(proj);
  }

  _clearPendingSwordWavesFor(playerId) {
    if (!this.pendingSwordWaves?.length) return;
    this.pendingSwordWaves = this.pendingSwordWaves.filter(wave => wave.playerId !== playerId);
  }

  _clearPendingRailgunsFor(playerId) {
    if (!this.pendingRailguns?.length) return;
    this.pendingRailguns = this.pendingRailguns.filter(shot => shot.playerId !== playerId);
  }

  _awardBowArrowStack(player) {
    if (!player || player.isDead || player.weapon !== 'bow') return;
    const maxStacks = SkillConfig.bow?.maxStacks || 5;
    player.arrowStacks = Math.min(maxStacks, (player.arrowStacks || 0) + 1);
  }

  _explodeSwordWave(proj, now) {
    proj.isDead = true;
    this.effects.push({
      attackerId: proj.ownerId,
      x: proj.x,
      y: proj.y,
      angle: proj.angle,
      weapon: 'sword',
      type: 'explosion',
      radius: proj.explosionRadius,
      progress: 0,
      timestamp: now,
      lifetime: 380
    });

    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === proj.ownerId || target.isDead || target.isInvincible()) return;
      const dist = Math.hypot(target.x - proj.x, target.y - proj.y);
      if (dist <= proj.explosionRadius + target.radius) {
        const died = target.takeDamage(proj.explosionDamage, 'swordwave');
        if (died) this._creditKill(proj.ownerId, target, '검기 폭발로');
      }
    });
  }

  // --- 화승총 (matchlock): 0.5s telegraph then hitscan instakill.
  // Same mechanic as sniper — aim line tracks mouse during the window.
  _fireMatchlock(player, now) {
    const sk = SkillConfig.matchlock;
    player.skillCdLeft = sk.cooldownMs / 1000;
    // Touch players fire instantly (no telegraph window) for usability on mobile.
    const telegraphMs = player.isMobile ? 0 : Math.max(0, sk.telegraphMs ?? 500);
    const beamDist = Math.max(this.mapWidth, this.mapHeight);

    if (!this.pendingMatchlockShots) this.pendingMatchlockShots = [];
    this.pendingMatchlockShots.push({ playerId: player.id, releaseAt: now + telegraphMs });

    this.effects.push({
      id: `${player.id}-matchlocktelegraph-${now}`,
      attackerId: player.id,
      x: player.x, y: player.y,
      angle: player.angle,
      beamDist,
      weapon: 'matchlock',
      type: 'matchlock_telegraph',
      progress: 0, timestamp: now, lifetime: telegraphMs
    });
  }

  _releaseDueMatchlockShots(now) {
    if (!this.pendingMatchlockShots?.length) return;
    const waiting = [];
    for (const shot of this.pendingMatchlockShots) {
      if (shot.releaseAt > now) { waiting.push(shot); continue; }
      const player = this.players[shot.playerId];
      if (!player || player.isDead || player.weapon !== 'matchlock') continue;
      this._resolveMatchlockShot(player, now);
    }
    this.pendingMatchlockShots = waiting;
  }

  _resolveMatchlockShot(player, now) {
    const sk = SkillConfig.matchlock;
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    const coverDist = this._terrainRayDist(player.x, player.y, dirX, dirY);
    let hitDist = Math.min(Number.isFinite(wallDist) ? wallDist : Math.max(this.mapWidth, this.mapHeight), coverDist);
    let hitTarget = null;
    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === player.id || target.isDead || target.isInvincible()) return;
      const d = Collision.rayCircleHitDistance(player.x, player.y, dirX, dirY, target.x, target.y, target.radius);
      if (d !== null && d <= hitDist) { hitDist = d; hitTarget = target; }
    });
    if (hitTarget) {
      const died = hitTarget.takeDamage(sk.damage, player.nickname);
      if (died) this._creditKill(player.id, hitTarget, '화승총으로');
    }
    this.effects.push({
      id: `${player.id}-matchbeam-${now}`,
      attackerId: player.id,
      x: player.x, y: player.y,
      x2: player.x + dirX * hitDist, y2: player.y + dirY * hitDist,
      angle: player.angle,
      weapon: 'matchlock',
      type: 'railbeam',
      progress: 0, timestamp: now, lifetime: 360
    });
  }

  _clearPendingMatchlockShotsFor(playerId) {
    if (!this.pendingMatchlockShots?.length) return;
    this.pendingMatchlockShots = this.pendingMatchlockShots.filter(s => s.playerId !== playerId);
  }

  // --- 카타나 (katana): dash forward and cut twice; each cut deals a direct arc
  // hit AND launches a wall-reaching blade wave.
  _castKatanaSkill(player, now) {
    const sk = SkillConfig.katana;
    if (!this.pendingKatanaSlashes) this.pendingKatanaSlashes = [];
    const count = Math.max(1, Math.floor(sk.slashCount || 2));
    const interval = Math.max(0, sk.slashIntervalMs || 150);
    for (let i = 0; i < count; i++) {
      this.pendingKatanaSlashes.push({ playerId: player.id, releaseAt: now + interval * i, sequence: i });
    }
    player.skillCdLeft = sk.cooldownMs / 1000;
    player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + (sk.attackLockMs || 0));
  }

  _releaseDueKatanaSlashes(now) {
    if (!this.pendingKatanaSlashes?.length) return;
    const sk = SkillConfig.katana;
    const waiting = [];
    for (const slash of this.pendingKatanaSlashes) {
      if (slash.releaseAt > now) { waiting.push(slash); continue; }
      const player = this.players[slash.playerId];
      if (!player || player.isDead || player.weapon !== 'katana') continue;
      this._performKatanaSlash(player, sk, now, slash.sequence);
    }
    this.pendingKatanaSlashes = waiting;
  }

  _performKatanaSlash(player, sk, now, sequence) {
    // Lunge a step forward with each cut.
    this._lungePlayer(player, (sk.dashDistance || 150) / Math.max(1, sk.slashCount || 2));

    // Direct arc cut.
    const attackConfig = {
      ...Weapons.katana,
      type: 'melee_arc',
      hitMode: 'melee_blade_sweep',
      damage: sk.directDamage,
      range: sk.directRange,
      angle: sk.directAngle
    };
    this._applyMeleeHits(this._snapshotMeleeAttacker(player), attackConfig, now);

    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'katana',
      type: 'melee_heavy_arc',
      range: sk.directRange,
      angleDeg: sk.directAngle,
      swingDirection: sequence % 2 === 0 ? 1 : -1,
      isSkill: true,
      progress: 0,
      timestamp: now,
      lifetime: 340
    });

    // Wall-reaching blade wave (direct contact only — no AoE).
    const angle = player.angle;
    const spawnDist = player.radius + 4;
    const proj = new Projectile(
      `${player.id}-katanawave-${now}-${sequence}`,
      player.id,
      player.x + Math.cos(angle) * spawnDist,
      player.y + Math.sin(angle) * spawnDist,
      angle,
      sk.waveSpeed,
      Infinity,
      sk.waveDamage,
      'swordwave'
    );
    proj.explosionRadius = 0;
    proj.explosionDamage = 0;
    proj.weapon = 'katana';
    this.projectiles.push(proj);
  }

  // --- 마법 지팡이 (magic staff): every auto-cast rolls one of three spells.
  _startKatanaIaijutsuCharge(player, now) {
    if (!player || player.isDead || player.weapon !== 'katana' || player.stunTimeLeft > 0) return;
    if (player.katanaChargeStart > 0 || now < (player.teleportReadyAt || 0)) return;
    const sk = SkillConfig.katana;
    player.katanaChargeStart = now;
    player.katanaChargeAngle = player.angle;
    player.comboStep = 0;
    player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + (sk.iaijutsuChargeMs || 1000));
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'katana',
      type: 'katana_charge',
      range: sk.iaijutsuRange,
      width: sk.iaijutsuWidth,
      progress: 0,
      timestamp: now,
      lifetime: sk.iaijutsuChargeMs || 1000
    });
  }

  _processKatanaCharges(now) {
    const chargeMs = SkillConfig.katana?.iaijutsuChargeMs || 1000;
    Object.values(this.players).forEach(player => {
      if (!player || player.isDead || player.weapon !== 'katana') return;
      if (player.katanaChargeStart > 0 && now - player.katanaChargeStart >= chargeMs) {
        this._releaseKatanaIaijutsu(player, now, true);
      }
    });
  }

  _releaseKatanaIaijutsu(player, now, forceFull = false) {
    if (!player || player.katanaChargeStart <= 0) return;
    const sk = SkillConfig.katana;
    const heldMs = Math.max(0, now - player.katanaChargeStart);
    const full = heldMs >= (sk.iaijutsuChargeMs || 1000);
    const angle = Number.isFinite(player.katanaChargeAngle) ? player.katanaChargeAngle : player.angle;
    player.katanaChargeStart = 0;
    player.katanaChargeAngle = 0;

    if (!full && !forceFull) {
      player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + 180);
      return;
    }

    const attackConfig = {
      ...Weapons.katana,
      type: 'melee_heavy_line',
      hitMode: null,
      damage: sk.iaijutsuDamage || 70,
      range: sk.iaijutsuRange || 150,
      width: sk.iaijutsuWidth || 40,
      cooldown: 0,
      knockback: 58,
      onHitBleed: true,        // R 발도술 → 출혈
      chainHits: 0             // don't let the basic-attack chain bonus apply here
    };
    const attacker = {
      ...this._snapshotMeleeAttacker(player),
      angle
    };
    this._applyMeleeHits(attacker, attackConfig, now);
    player.teleportReadyAt = now + (sk.iaijutsuCooldownMs || 3000);
    player.comboDelayUntil = Math.max(player.comboDelayUntil || 0, now + 520);
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle,
      weapon: 'katana',
      type: 'melee_heavy_line',
      range: attackConfig.range,
      width: attackConfig.width,
      isSkill: true,
      progress: 0,
      timestamp: now,
      lifetime: 420
    });
  }

  _castMagicStaff(player, now) {
    player.lastAttackTime = now;
    player.lastAttackMotionTag = 'attack';
    const roll = Math.floor(Math.random() * 3);
    if (roll === 0) this._castFireball(player, now);
    else if (roll === 1) this._castIceShards(player, now);
    else this._castLifebound(player, now);
  }

  _castMagicFireballSkill(player, now) {
    if (!this._canUseMagic(player, 'fireball')) return;
    this._castFireball(player, now);
    this._startMagicCooldown(player, 'fireball');
  }

  _castMagicLifeboundSkill(player, now) {
    if (!this._canUseMagic(player, 'lifebound')) return;
    this._castLifebound(player, now);
    this._startMagicCooldown(player, 'lifebound');
  }

  _castMagicIceSkill(player, now, targetX, targetY) {
    if (!this._canUseMagic(player, 'iceShard')) return;
    const cfg = MagicConfig.iceShard;
    const count = Math.max(1, Math.floor(cfg.count || 4));
    const interval = Math.max(0, cfg.intervalMs || 0);
    if (!this.pendingMagicShards) this.pendingMagicShards = [];
    for (let i = 0; i < count; i++) {
      this.pendingMagicShards.push({
        playerId: player.id,
        targetX,
        targetY,
        releaseAt: now + interval * i,
        sequence: i
      });
    }
    this._startMagicCooldown(player, 'iceShard');
    this.effects.push({
      attackerId: player.id,
      x: targetX,
      y: targetY,
      weapon: 'magicstaff',
      type: 'icicle_load',
      worldAnchored: true,
      progress: 0,
      timestamp: now,
      lifetime: Math.max(260, interval * count)
    });
  }

  _castFireball(player, now) {
    const cfg = MagicConfig.fireball;
    const angle = player.angle;
    const spawnDist = player.radius + 4;
    const proj = new Projectile(
      `${player.id}-fireball-${now}`,
      player.id,
      player.x + Math.cos(angle) * spawnDist,
      player.y + Math.sin(angle) * spawnDist,
      angle,
      cfg.speed,
      Infinity,
      cfg.damage,
      'fireball'
    );
    proj.weapon = 'magicstaff';
    proj.radius = cfg.radius;
    proj.burnDps = cfg.burnDps;
    proj.burnDurationMs = cfg.burnDurationMs;
    this.projectiles.push(proj);
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle,
      weapon: 'magicstaff', type: 'projectile_shot', projectileKind: 'fireball',
      progress: 0, timestamp: now, lifetime: 200
    });
  }

  _castIceShards(player, now) {
    const cfg = MagicConfig.iceShard;
    player.pendingIcicles = cfg.count; // loaded; canAttack pauses auto-cast until F fires them
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y,
      weapon: 'magicstaff', type: 'icicle_load',
      progress: 0, timestamp: now, lifetime: 320
    });
  }

  _castLifebound(player, now) {
    const cfg = MagicConfig.lifebound;
    player.hp = Math.min(player.maxHp, player.hp + (cfg.heal || 30));
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y,
      weapon: 'magicstaff', type: 'lifebound_heal',
      progress: 0, timestamp: now, lifetime: 620
    });
  }

  // Fire the loaded ice shards in a fan, then restart the cast cooldown.
  _fireIcicles(player, now) {
    const cfg = MagicConfig.iceShard;
    const count = Math.max(0, Math.floor(player.pendingIcicles || 0));
    if (count <= 0) return;
    player.pendingIcicles = 0;
    player.lastAttackTime = now; // 3s cast cooldown restarts from firing
    player.lastAttackMotionTag = 'attack';
    const spawnDist = player.radius + 4;
    // All four shards travel toward the cursor (player.angle); only the spawn
    // points are spread abreast so they read as four distinct icicles.
    const a = player.angle;
    const ux = Math.cos(a), uy = Math.sin(a);
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * 11; // perpendicular px offset
      const proj = new Projectile(
        `${player.id}-iceshard-${now}-${i}`,
        player.id,
        player.x + ux * spawnDist - uy * off,
        player.y + uy * spawnDist + ux * off,
        a,
        cfg.speed,
        Infinity,
        cfg.damage,
        'iceshard'
      );
      proj.weapon = 'magicstaff';
      proj.radius = cfg.radius;
      this.projectiles.push(proj);
    }
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
      weapon: 'magicstaff', type: 'projectile_shot', projectileKind: 'iceshard',
      progress: 0, timestamp: now, lifetime: 200
    });
  }

  _releaseDueMagicShards(now) {
    if (!this.pendingMagicShards?.length) return;
    const waiting = [];
    for (const shard of this.pendingMagicShards) {
      if (shard.releaseAt > now) {
        waiting.push(shard);
        continue;
      }

      const player = this.players[shard.playerId];
      if (!player || player.isDead || player.weapon !== 'magicstaff') continue;
      this._spawnMagicShard(player, shard, now);
    }
    this.pendingMagicShards = waiting;
  }

  _spawnMagicShard(player, shard, now) {
    const cfg = MagicConfig.iceShard;
    const dx = shard.targetX - player.x;
    const dy = shard.targetY - player.y;
    const angle = Math.atan2(dy, dx);
    const spawnDist = player.radius + 4;
    const side = (shard.sequence - ((cfg.count || 4) - 1) / 2) * 5;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const proj = new Projectile(
      `${player.id}-iceshard-${now}-${shard.sequence}`,
      player.id,
      player.x + ux * spawnDist - uy * side,
      player.y + uy * spawnDist + ux * side,
      angle,
      cfg.speed,
      Infinity,
      cfg.damage,
      'iceshard'
    );
    proj.weapon = 'magicstaff';
    proj.radius = cfg.radius;
    this.projectiles.push(proj);
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle,
      weapon: 'magicstaff',
      type: 'projectile_shot',
      projectileKind: 'iceshard',
      progress: 0,
      timestamp: now,
      lifetime: 170
    });
  }

  _clearPendingMagicShardsFor(playerId) {
    if (!this.pendingMagicShards?.length) return;
    this.pendingMagicShards = this.pendingMagicShards.filter(shard => shard.playerId !== playerId);
  }

  // --- Status effects (Task 10-1): bleed/burn DoTs, slow, stun -----------------

  // New status can't be applied during respawn protection or dash i-frames;
  // existing DoTs keep ticking regardless.
  _canApplyStatus(target) {
    if (!target || target.isDead) return false;
    if (Date.now() < (target.statusImmuneUntil || 0)) return false;
    if (target.isInvincible && target.isInvincible()) return false;
    return true;
  }

  _applyBurn(target, sourceId, dps, durationMs) {
    if (!this._canApplyStatus(target)) return;
    const c = STATUS.burn;
    target.burnTimeLeft = Math.max(target.burnTimeLeft || 0, (durationMs || c.durationMs) / 1000);
    target.burnDps = dps || c.dps;
    target.burnSourceId = sourceId;
    if (!(target.burnTickLeft > 0)) target.burnTickLeft = 1; // first tick 1s after ignition
  }

  _applyBleed(target, sourceId, dps, durationMs) {
    if (!this._canApplyStatus(target)) return;
    const c = STATUS.bleed;
    target.bleedTimeLeft = Math.max(target.bleedTimeLeft || 0, (durationMs || c.durationMs) / 1000);
    target.bleedDps = dps || c.dps;
    target.bleedSourceId = sourceId;
    if (!(target.bleedTickLeft > 0)) target.bleedTickLeft = 1;
  }

  // Slow magnitude is fixed (−30%); a longer remaining duration wins.
  _applySlow(target, durationMs) {
    if (!this._canApplyStatus(target)) return;
    target.slowTimeLeft = Math.max(target.slowTimeLeft || 0, (durationMs || 1500) / 1000);
  }

  // Stun, with a post-stun immunity window so a target can't be chain-stunned.
  _applyStun(target, durationMs, now = Date.now()) {
    if (!this._canApplyStatus(target)) return;
    if (now < (target.stunImmuneUntil || 0)) return;
    const ms = durationMs || 400;
    target.stunTimeLeft = Math.max(target.stunTimeLeft || 0, ms / 1000);
    target.stunImmuneUntil = now + ms + STATUS.stun.immuneMs;
  }

  // Tick both DoTs (host). Slow/stun timers decay in Player._tickTimers.
  _tickStatuses(deltaTime, now) {
    const tickDot = (p, key) => {
      const tl = key + 'TimeLeft', tk = key + 'TickLeft', dp = key + 'Dps', src = key + 'SourceId';
      if (!(p[tl] > 0)) return;
      p[tl] = Math.max(0, p[tl] - deltaTime);
      p[tk] -= deltaTime;
      if (p[tk] <= 0 && !p.isDead) {
        p[tk] += 1;
        const died = p.takeDamage(p[dp] || STATUS[key].dps, STATUS[key].deathName, true);
        if (died) this._creditKill(p[src], p, STATUS[key].viaLabel);
      }
      if (p[tl] <= 0) { p[tl] = 0; p[tk] = 0; p[dp] = 0; p[src] = null; }
    };
    Object.values(this.players).forEach(p => {
      if (!p || p.isDead) return;
      tickDot(p, 'burn');
      tickDot(p, 'bleed');
    });
  }

  // --- 스나이퍼 (sniper): immobile. Pressing F locks the aim line and exposes a
  // telegraph laser for telegraphMs before the killing hitscan resolves, giving
  // targets a window to dash/step out of the line (counterplay). The origin and
  // direction are frozen at fire time so re-aiming mid-telegraph can't track.
  _fireSniperShot(player, now) {
    const sk = SkillConfig.sniper || {};
    player.skillCdLeft = (sk.cooldownMs || 4000) / 1000;
    // Touch players fire instantly (no telegraph window) for usability on mobile.
    const telegraphMs = player.isMobile ? 0 : Math.max(0, sk.telegraphMs ?? 500);
    const beamDist = Math.max(this.mapWidth, this.mapHeight);

    if (!this.pendingSniperShots) this.pendingSniperShots = [];
    // Direction NOT frozen — shot fires along wherever the player is aiming
    // when the telegraph window expires (mouse-tracking preview).
    this.pendingSniperShots.push({ playerId: player.id, releaseAt: now + telegraphMs });

    this.effects.push({
      id: `${player.id}-snipertelegraph-${now}`,
      attackerId: player.id,
      x: player.x, y: player.y,
      angle: player.angle,
      beamDist,             // max draw distance; renderer uses live player angle
      weapon: 'sniper',
      type: 'sniper_telegraph',
      progress: 0, timestamp: now, lifetime: telegraphMs
    });
  }

  // Resolve any telegraphed sniper shots whose exposure window has elapsed.
  _releaseDueSniperShots(now) {
    if (!this.pendingSniperShots?.length) return;
    const waiting = [];
    for (const shot of this.pendingSniperShots) {
      if (shot.releaseAt > now) { waiting.push(shot); continue; }
      const player = this.players[shot.playerId];
      if (!player || player.isDead || player.weapon !== 'sniper') continue;
      this._resolveSniperShot(player, shot, now);
    }
    this.pendingSniperShots = waiting;
  }

  _resolveSniperShot(player, shot, now) {
    // Use current player position/angle — direction tracked live during telegraph.
    const originX = player.x;
    const originY = player.y;
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    const wallDist = Collision.rayToBoundsDistance(originX, originY, dirX, dirY, this.mapWidth, this.mapHeight);
    // Cover stops the beam (and shields anyone behind it).
    const coverDist = this._terrainRayDist(originX, originY, dirX, dirY);
    let hitDist = Math.min(Number.isFinite(wallDist) ? wallDist : Math.max(this.mapWidth, this.mapHeight), coverDist);
    let hitTarget = null;
    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === player.id || target.isDead || target.isInvincible()) return;
      const d = Collision.rayCircleHitDistance(originX, originY, dirX, dirY, target.x, target.y, target.radius);
      if (d !== null && d <= hitDist) { hitDist = d; hitTarget = target; }
    });

    if (hitTarget) {
      const died = hitTarget.takeDamage(9999, player.nickname); // instakill
      if (died) this._creditKill(player.id, hitTarget, '강궁으로');
    }

    this.effects.push({
      id: `${player.id}-sniperbeam-${now}`,
      attackerId: player.id,
      x: originX, y: originY,
      x2: originX + dirX * hitDist, y2: originY + dirY * hitDist,
      angle: shot.angle,
      weapon: 'sniper',
      type: 'railbeam',
      progress: 0, timestamp: now, lifetime: 320
    });
  }

  _clearPendingSniperShotsFor(playerId) {
    if (!this.pendingSniperShots?.length) return;
    this.pendingSniperShots = this.pendingSniperShots.filter(s => s.playerId !== playerId);
  }

  // R key: arm a targeted blink. The next target-cast click/tap chooses a point
  // inside a 400px-diameter circle around the sniper, then clamps it in-bounds.
  _handleTeleport(player, now) {
    if (!player || player.isDead || player.weapon !== 'sniper') return;
    if (now < (player.teleportReadyAt || 0)) return;
    const windowMs = SkillConfig.sniper?.teleportTargetWindowMs || 3500;
    player.sniperTeleportTargetUntil = now + windowMs;
  }

  _sniperTeleportTo(player, now, targetX, targetY) {
    const sk = SkillConfig.sniper;
    const margin = (player.radius || 14) + 12;
    const fromX = player.x, fromY = player.y;
    const maxRadius = sk?.teleportRadius || 200;
    let dx = targetX - fromX;
    let dy = targetY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    player.x = Math.max(margin, Math.min(this.mapWidth - margin, fromX + dx));
    player.y = Math.max(margin, Math.min(this.mapHeight - margin, fromY + dy));
    this._resolveOutOfTerrain(player);   // teleport: don't land inside terrain
    player.vy = 0;                        // cancel fall momentum on blink
    // Teleport is discontinuous — don't let the next melee test sweep the jump.
    player.prevX = player.x;
    player.prevY = player.y;
    player.sniperTeleportTargetUntil = 0;
    player.teleportReadyAt = now + (sk?.teleportCooldownMs || 4000);
    // Poof at the vacated spot and the arrival spot (world-anchored so they stay put).
    this.effects.push({ attackerId: player.id, x: fromX, y: fromY, weapon: 'sniper', type: 'sniper_teleport', worldAnchored: true, progress: 0, timestamp: now, lifetime: 420 });
    this.effects.push({ attackerId: player.id, x: player.x, y: player.y, weapon: 'sniper', type: 'sniper_teleport', worldAnchored: true, progress: 0, timestamp: now, lifetime: 420 });
  }

  /**
   * Bow skill: spend arrow stacks, then fire one railgun per stack.
   */
  _castRailgun(player, now) {
    const sk = SkillConfig.bow;
    const stackCount = Math.min(sk.maxStacks || 5, Math.max(0, Math.floor(player.arrowStacks || 0)));
    if (stackCount <= 0) return;

    player.arrowStacks = 0;
    const interval = Math.max(0, sk.burstIntervalMs || 0);
    for (let i = 0; i < stackCount; i++) {
      this.pendingRailguns.push({
        playerId: player.id,
        castAt: now,
        releaseAt: now + interval * i,
        sequence: i
      });
    }

    player.skillCdLeft = sk.cooldownMs / 1000;
  }

  _releaseDueBowRailguns(now) {
    if (!this.pendingRailguns?.length) return;

    const waiting = [];
    for (const shot of this.pendingRailguns) {
      if (shot.releaseAt > now) {
        waiting.push(shot);
        continue;
      }

      const player = this.players[shot.playerId];
      if (!player || player.isDead || player.weapon !== 'bow') continue;
      this._fireRailgun(player, now, shot.castAt, shot.sequence);
    }
    this.pendingRailguns = waiting;
  }

  _fireRailgun(player, now, castAt = now, sequence = 0) {
    const sk = SkillConfig.bow;
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    const coverDist = this._terrainRayDist(player.x, player.y, dirX, dirY);

    let hitDist = Math.min(Number.isFinite(wallDist) ? wallDist : Math.max(this.mapWidth, this.mapHeight), coverDist);
    let hitTarget = null;
    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === player.id || target.isDead || target.isInvincible()) return;
      const d = Collision.rayCircleHitDistance(player.x, player.y, dirX, dirY, target.x, target.y, target.radius);
      if (d !== null && d <= hitDist) {
        hitDist = d;
        hitTarget = target;
      }
    });

    if (hitTarget) {
      const died = hitTarget.takeDamage(sk.damage, 'railgun');
      if (died) this._creditKill(player.id, hitTarget, '레일건으로');
    }

    const effect = {
      id: `${player.id}-railbeam-${castAt}-${sequence}`,
      attackerId: player.id,
      x: player.x,
      y: player.y,
      x2: player.x + dirX * hitDist,
      y2: player.y + dirY * hitDist,
      angle: player.angle,
      weapon: 'bow',
      type: 'railbeam',
      progress: 0,
      timestamp: now,
      lifetime: 420
    };
    this.effects.push(effect);
    this._triggerLocalBowSkillVibration(effect);
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

  /**
   * Spear skill: instantly throw to the wall, then return to the owner.
   * Cooldown only starts once it is retrieved.
   */
  _throwSpear(player, now) {
    // Mark the skill as in-use immediately to prevent re-activation.
    player.spearThrown = true;

    // Play the windup (pull-back) animation. Actual throw executes after it completes.
    const WINDUP_MS = 240;
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      weapon: 'spear',
      type: 'spear_windup',
      progress: 0,
      timestamp: now,
      lifetime: WINDUP_MS
    });

    // Lock the throw direction at the moment F is pressed; player may move freely
    // during the windup but the spear flies in the aimed direction.
    if (!this.pendingSpearThrows) this.pendingSpearThrows = [];
    this.pendingSpearThrows.push({
      playerId: player.id,
      angle: player.angle,
      releaseAt: now + WINDUP_MS
    });
  }

  _processSpearThrowQueue(now) {
    if (!this.pendingSpearThrows?.length) return;

    this.pendingSpearThrows = this.pendingSpearThrows.filter(pending => {
      if (now < pending.releaseAt) return true; // still winding up

      const player = this.players[pending.playerId];
      if (!player || player.isDead) {
        // Player left or died during windup — free the skill state.
        if (player) {
          player.spearThrown = false;
          player.skillCdLeft = 0;
        }
        return false;
      }

      this._executeSpearThrow(player, pending, now);
      return false;
    });
  }

  _executeSpearThrow(player, pending, now) {
    const sk = SkillConfig.spear;
    const angle = pending.angle;  // locked aim direction from when F was pressed
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    // Hitscan from player's CURRENT position in the locked direction.
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    const coverDist = this._terrainRayDist(player.x, player.y, dirX, dirY);
    const travelDist = Math.min(Number.isFinite(wallDist) ? wallDist : Math.max(this.mapWidth, this.mapHeight), coverDist);
    const endX = Math.max(5, Math.min(this.mapWidth - 5, player.x + dirX * travelDist));
    const endY = Math.max(5, Math.min(this.mapHeight - 5, player.y + dirY * travelDist));

    // Spawn the returning javelin at the wall endpoint.
    const returnSpeed = sk.returnSpeed || 760;
    const proj = new Projectile(
      `${player.id}-javelin-${now}`,
      player.id,
      endX, endY,
      angle + Math.PI,
      returnSpeed,
      Infinity,
      sk.returnDamage || sk.damage,
      'thrownspear'
    );
    proj.bornAt = now;
    proj.returnStartedAt = now;
    proj.phase = 'return';
    proj.stuck = false;
    proj.hitSet = new Set();
    proj.vx = -dirX * returnSpeed;
    proj.vy = -dirY * returnSpeed;
    proj.angle = angle + Math.PI;
    proj.weapon = 'spear';
    this.projectiles.push(proj);

    // Railbeam and vibration feedback.
    const throwEffect = {
      id: `${player.id}-spear-rail-${now}`,
      attackerId: player.id,
      x: player.x, y: player.y,
      x2: endX, y2: endY,
      angle,
      weapon: 'spear',
      type: 'railbeam',
      progress: 0,
      timestamp: now,
      lifetime: 260
    };
    this.effects.push(throwEffect);
    this._triggerLocalSpearThrowFeedback(throwEffect);

    this._damageSpearThrowPath(player, dirX, dirY, travelDist);
  }

  _damageSpearThrowPath(player, dirX, dirY, maxDist) {
    const sk = SkillConfig.spear;
    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === player.id || target.isDead || target.isInvincible()) return;
      const hitDist = Collision.rayCircleHitDistance(
        player.x,
        player.y,
        dirX,
        dirY,
        target.x,
        target.y,
        (target.radius || 14) + 5
      );
      if (hitDist === null || hitDist > maxDist) return;

      const died = target.takeDamage(sk.damage, 'javelin');
      if (died) this._creditKill(player.id, target, '투창으로');
    });
  }

  _updateThrownSpear(proj, deltaTime, now) {
    const owner = this.players[proj.ownerId];
    const sk = SkillConfig.spear;
    const elapsed = now - (proj.returnStartedAt || proj.bornAt || now);

    // Owner left or died → drop the spear and free the skill.
    if (!owner || owner.isDead) {
      proj.isDead = true;
      if (owner) {
        owner.spearThrown = false;
        owner.skillCdLeft = sk.cooldownMs / 1000;
      }
      return;
    }

    if (proj.phase !== 'return') proj.phase = 'return';
    if (!proj.hitSet) proj.hitSet = new Set();

    const dx = owner.x - proj.x;
    const dy = owner.y - proj.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 20 || elapsed >= (sk.returnMs || 1800)) {
      proj.isDead = true;
      owner.spearThrown = false;
      owner.skillCdLeft = sk.cooldownMs / 1000;
      return;
    }

    const timeLeft = Math.max(0.001, ((sk.returnMs || 1800) - elapsed) / 1000);
    const speed = Math.max(sk.returnSpeed || 760, dist / timeLeft);
    const ux = dx / dist;
    const uy = dy / dist;
    proj.vx = ux * speed;
    proj.vy = uy * speed;
    proj.angle = Math.atan2(uy, ux);
    proj.x += proj.vx * deltaTime;
    proj.y += proj.vy * deltaTime;

    // Damage each enemy at most once while the javelin returns.
    Object.keys(this.players).forEach(tid => {
      const target = this.players[tid];
      if (target.id === proj.ownerId || target.isDead || target.isInvincible() || proj.hitSet.has(target.id)) return;
      if (Collision.checkProjectileHit(proj, target)) {
        proj.hitSet.add(target.id);
        const died = target.takeDamage(sk.returnDamage || sk.damage, 'javelin');
        if (died) this._creditKill(proj.ownerId, target, '투창으로');
      }
    });
  }

  // --- 차크람 (chakram): boomerang disc, basic attack + 3-way fan skill -------

  // Spawn one chakram disc travelling at `angle`. `isSkill` discs don't lock the
  // owner's primary throw (the F fan fires multiple at once).
  _spawnChakram(player, angle, damage, outRange, speed, now, tag, isSkill) {
    const spawnDist = (player.radius || 14) + 3;
    const proj = new Projectile(
      `${player.id}-chakram-${tag}`,
      player.id,
      player.x + Math.cos(angle) * spawnDist,
      player.y + Math.sin(angle) * spawnDist,
      angle, speed, Infinity, damage, 'chakram'
    );
    proj.weapon = 'chakram';
    proj.radius = 13;
    proj.phase = 'out';
    proj.bornAt = now;
    proj.outRange = outRange;
    proj.locksOwner = !isSkill;     // only the basic throw disarms until return
    proj.deathName = '부메랑';
    proj.hitLabel = '부메랑으로';
    proj.hitOut = new Set();
    proj.hitBack = new Set();
    this.projectiles.push(proj);
    return proj;
  }

  _throwChakram(player, cfg, now) {
    player.lastAttackTime = now;    // re-stamped on return so the cooldown starts then
    player.chakramOut = true;
    const p = this._spawnChakram(player, player.angle, cfg.damage, cfg.range, cfg.speed, now, `${now}`, false);
    p.wallBouncesLeft = cfg.wallReflect || 0;
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
      weapon: 'chakram', type: 'projectile_shot', projectileKind: 'chakram',
      progress: 0, timestamp: now, lifetime: 200
    });
  }

  // F skill: three discs in a fan. These don't disarm the player (the basic disc
  // may still be out); they simply expire on return without re-stamping cooldown.
  _throwChakramFan(player, now) {
    const sk = SkillConfig.chakram;
    player.skillCdLeft = (sk.cooldownMs || 6000) / 1000;
    const n = sk.fanCount || 3;
    const spread = ((sk.fanSpreadDeg || 34) * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : (i - (n - 1) / 2) * (spread / (n - 1));
      const p = this._spawnChakram(player, player.angle + off, sk.damage, sk.range, sk.speed, now, `fan-${now}-${i}`, true);
      p.bleed = Boolean(sk.bleed);
    }
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
      weapon: 'chakram', type: 'projectile_shot', projectileKind: 'chakram',
      progress: 0, timestamp: now, lifetime: 240
    });
  }

  _releaseDuePendingChakrams(now) {
    if (!this.pendingChakrams?.length) return;
    const waiting = [];
    for (const shot of this.pendingChakrams) {
      if (shot.fireAt > now) { waiting.push(shot); continue; }
      const player = this.players[shot.playerId];
      if (!player || player.isDead || player.weapon !== 'chakram') continue;
      this._spawnChakram(player, shot.angle, shot.damage, shot.range, shot.speed, now, shot.tag, true);
    }
    this.pendingChakrams = waiting;
  }

  _updateChakram(proj, deltaTime, now) {
    const owner = this.players[proj.ownerId];
    if (!owner || owner.isDead) {
      proj.isDead = true;
      if (owner && proj.locksOwner) owner.chakramOut = false;
      return;
    }

    const damageLeg = (hitSet, label) => {
      Object.keys(this.players).forEach(tid => {
        const target = this.players[tid];
        if (target.id === proj.ownerId || target.isDead || target.isInvincible() || hitSet.has(target.id)) return;
        if (Collision.checkProjectileHit(proj, target)) {
          hitSet.add(target.id);
          const died = target.takeDamage(proj.damage, proj.deathName || '부메랑');
          if (!died && proj.bleed) this._applyBleed(target, proj.ownerId);
          if (died) this._creditKill(proj.ownerId, target, proj.hitLabel || '부메랑으로');
        }
      });
    };

    if (proj.phase === 'out') {
      proj.x += proj.vx * deltaTime;
      proj.y += proj.vy * deltaTime;
      damageLeg(proj.hitOut, 'out');
      const flew = Math.hypot(proj.x - proj.startX, proj.y - proj.startY);
      const hitWall = proj.x <= proj.radius || proj.x >= this.mapWidth - proj.radius ||
                      proj.y <= proj.radius || proj.y >= this.mapHeight - proj.radius;
      const hitCover = this.cover.length && coverBlocksCircle(this.cover, proj.x, proj.y, proj.radius);
      // Wall reflect: bounce off the arena edge once (extra hit chance) before returning.
      if (hitWall && !hitCover && flew < proj.outRange && (proj.wallBouncesLeft || 0) > 0) {
        proj.wallBouncesLeft -= 1;
        if (proj.x <= proj.radius || proj.x >= this.mapWidth - proj.radius) proj.vx = -proj.vx;
        if (proj.y <= proj.radius || proj.y >= this.mapHeight - proj.radius) proj.vy = -proj.vy;
        proj.x = Math.max(proj.radius, Math.min(this.mapWidth - proj.radius, proj.x));
        proj.y = Math.max(proj.radius, Math.min(this.mapHeight - proj.radius, proj.y));
        proj.angle = Math.atan2(proj.vy, proj.vx);
        proj.hitOut.clear();        // allow re-hitting after the bounce
        return;
      }
      if (flew >= proj.outRange || hitWall || hitCover) {
        proj.x = Math.max(proj.radius, Math.min(this.mapWidth - proj.radius, proj.x));
        proj.y = Math.max(proj.radius, Math.min(this.mapHeight - proj.radius, proj.y));
        proj.phase = 'return';
      }
      return;
    }

    // Return leg: home toward the owner; re-hit anyone not struck on the way back.
    const dx = owner.x - proj.x;
    const dy = owner.y - proj.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 22) {
      proj.isDead = true;
      if (proj.locksOwner) {
        owner.chakramOut = false;
        owner.lastAttackTime = now; // cooldown starts once the disc is back in hand
      }
      return;
    }
    const sp = Math.max(SkillConfig.chakram?.returnSpeed || 720, proj.speed * 0.95);
    const ux = dx / dist, uy = dy / dist;
    proj.vx = ux * sp; proj.vy = uy * sp;
    proj.angle = Math.atan2(uy, ux);
    proj.x += proj.vx * deltaTime;
    proj.y += proj.vy * deltaTime;
    damageLeg(proj.hitBack, 'back');
  }

  // --- 지뢰 가방 (mine bag): R plants a proximity mine -----------------------
  _placeMine(player, now) {
    const sk = SkillConfig.minebag;
    // Cooldown governed by the R aux executor (altSkillCdLeft).
    const mine = {
      id: ++this._mineSeq,
      ownerId: player.id,
      // Drop onto the surface below the placer (platformer: ground-placed).
      x: player.x, y: this._surfaceBelow(player.x, player.y) - 5,
      armAt: now + (sk.armMs || 1000)
    };
    this.mines.push(mine);
    const own = this.mines.filter(m => m.ownerId === player.id && !m.tracer);
    const max = sk.maxMines || 3;
    if (own.length > max) {
      const oldest = own[0];
      this.mines = this.mines.filter(m => m !== oldest);
    }
  }

  // F 원격 기폭: detonate all of the player's armed proximity mines at once.
  _detonateAllMines(player, now) {
    const sk = SkillConfig.minebag;
    player.skillCdLeft = (sk.detonateCooldownMs || 4000) / 1000;
    const mine = this.mines.filter(m => m.ownerId === player.id && !m.tracer);
    for (const m of mine) { this._explodeMine(m, now); m._spent = true; }
    this.mines = this.mines.filter(m => !m._spent);
  }

  // LMB 예광 지뢰: stick a timed mine onto the nearest enemy (else drop in front),
  // bursts after a fuse for high damage + stun.
  _placeTracerMine(player, now) {
    const sk = SkillConfig.minebag;
    let stick = null, bestD = sk.tracerStickRange || 220;
    for (const t of Object.values(this.players)) {
      if (t.id === player.id || t.isDead) continue;
      const d = Math.hypot(t.x - player.x, t.y - player.y);
      if (d < bestD) { bestD = d; stick = t; }
    }
    const fx = stick ? stick.x : player.x + Math.cos(player.angle) * 60;
    const fy = stick ? stick.y : this._surfaceBelow(fx, player.y) - 5;
    this.mines.push({
      id: ++this._mineSeq, ownerId: player.id, tracer: true,
      stickTo: stick ? stick.id : null,
      x: fx, y: fy,
      armAt: now, fuseAt: now + (sk.tracerFuseMs || 2000)
    });
  }

  // Shared blast: damage + 둔화 every non-owner in range; tracer mines also stun.
  _explodeMine(mine, now) {
    const sk = SkillConfig.minebag;
    const blast = sk.blastRadius || 60;
    const dmg = mine.tracer ? (sk.tracerDamage || 30) : sk.damage;
    for (const t of Object.values(this.players)) {
      if (t.id === mine.ownerId || t.isDead || t.isInvincible?.()) continue;
      if ((t.x - mine.x) ** 2 + (t.y - mine.y) ** 2 > (blast + (t.radius || 14)) ** 2) continue;
      const died = t.takeDamage(dmg, '지뢰');
      if (!died) {
        if (mine.tracer && sk.tracerStunMs) this._applyStun(t, sk.tracerStunMs, now);
        else if (sk.blastSlowMs) this._applySlow(t, sk.blastSlowMs);
      }
      if (died) this._creditKill(mine.ownerId, t, '지뢰로');
    }
    this.effects.push({
      attackerId: mine.ownerId, x: mine.x, y: mine.y,
      weapon: 'minebag', type: 'mine_blast', range: blast,
      progress: 0, timestamp: now, lifetime: 360
    });
  }

  _updateMines(now) {
    if (!this.mines.length) return;
    const sk = SkillConfig.minebag;
    const survivors = [];
    for (const mine of this.mines) {
      const owner = this.players[mine.ownerId];
      if (!owner || owner.isDead) continue; // placer gone → mine removed

      // Tracer mine: follow its stuck target, then burst on the fuse timer.
      if (mine.tracer) {
        if (mine.stickTo) {
          const tgt = this.players[mine.stickTo];
          if (tgt && !tgt.isDead) { mine.x = tgt.x; mine.y = tgt.y; }
        }
        if (now >= mine.fuseAt) { this._explodeMine(mine, now); continue; }
        survivors.push(mine);
        continue;
      }

      if (now < mine.armAt) { survivors.push(mine); continue; }
      // Armed: detonate if a non-owner steps within the trigger radius.
      const trig = sk.triggerRadius || 46;
      let triggered = false;
      for (const t of Object.values(this.players)) {
        if (t.id === mine.ownerId || t.isDead || t.isInvincible?.()) continue;
        if ((t.x - mine.x) ** 2 + (t.y - mine.y) ** 2 <= (trig + (t.radius || 14)) ** 2) { triggered = true; break; }
      }
      if (!triggered) { survivors.push(mine); continue; }
      this._explodeMine(mine, now);
    }
    this.mines = survivors;
  }

  // --- 화염방사기 (flamethrower): continuous cone spray + fuel ---------------
  _updateFlamethrower(now, deltaTime) {
    const cfg = Weapons.flamethrower;
    Object.values(this.players).forEach(player => {
      if (player.weapon !== 'flamethrower' || player.isDead || player.isDummy) return;
      if (player.flameFuel === undefined) player.flameFuel = cfg.fuelMs;

      const canSpray = !player.flameEmpty && player.flameFuel > 0 && player.stunTimeLeft <= 0;
      if (canSpray) {
        player.flameSpraying = true;
        player.flameFuel = Math.max(0, player.flameFuel - deltaTime * 1000);
        if (player.flameFuel <= 0) player.flameEmpty = true; // forced recharge

        const halfAng = (cfg.angle * Math.PI) / 360;
        if (!player._flameHits) player._flameHits = {};
        Object.values(this.players).forEach(t => {
          if (t.id === player.id || t.isDead || t.isInvincible?.()) return;
          const dx = t.x - player.x, dy = t.y - player.y;
          const dist = Math.hypot(dx, dy);
          if (dist > cfg.range + (t.radius || 14)) return;
          let ad = Math.atan2(dy, dx) - player.angle;
          while (ad > Math.PI) ad -= Math.PI * 2;
          while (ad < -Math.PI) ad += Math.PI * 2;
          if (Math.abs(ad) > halfAng) return;
          if (this._terrainBlocksSegment(player.x, player.y, t.x, t.y)) return;
          const last = player._flameHits[t.id] || 0;
          if (now - last < (cfg.tickMs || 200)) return;
          player._flameHits[t.id] = now;
          const died = t.takeDamage(cfg.damage, '화염방사기');
          if (!died && cfg.burn) this._applyBurn(t, player.id);
          if (died) this._creditKill(player.id, t, '화염방사기로');
        });
      } else {
        player.flameSpraying = false;
        // Refill while not spraying; clear the empty lock once full.
        const rate = cfg.fuelMs / (cfg.rechargeMs || 2000);
        player.flameFuel = Math.min(cfg.fuelMs, player.flameFuel + deltaTime * 1000 * rate);
        if (player.flameFuel >= cfg.fuelMs) player.flameEmpty = false;
      }
    });
  }

  _throwFirePatch(player, now) {
    const sk = SkillConfig.flamethrower;
    player.skillCdLeft = (sk.cooldownMs || 7000) / 1000;
    let x = player.x + Math.cos(player.angle) * (sk.patchRange || 76);
    let y = player.y + Math.sin(player.angle) * (sk.patchRange || 76);
    x = Math.max(10, Math.min(this.mapWidth - 10, x));
    y = Math.max(10, Math.min(this.mapHeight - 10, y));
    y = this._surfaceBelow(x, y) - 4;   // burn pools on the ground/platform below
    this.firePatches.push({
      id: ++this._patchSeq, ownerId: player.id, x, y,
      expireAt: now + (sk.patchMs || 2000), nextTickAt: now
    });
  }

  _updateFirePatches(now) {
    if (!this.firePatches.length) return;
    const sk = SkillConfig.flamethrower;
    const survivors = [];
    for (const patch of this.firePatches) {
      if (now >= patch.expireAt) continue;
      if (now >= patch.nextTickAt) {
        patch.nextTickAt = now + (sk.patchTickMs || 250);
        const r = sk.patchRadius || 55;
        for (const t of Object.values(this.players)) {
          if (t.id === patch.ownerId || t.isDead || t.isInvincible?.()) continue;
          if ((t.x - patch.x) ** 2 + (t.y - patch.y) ** 2 <= (r + (t.radius || 14)) ** 2) {
            const died = t.takeDamage(sk.patchDamage || 2.5, '화염 장판');
            if (!died && sk.burn) this._applyBurn(t, patch.ownerId);
            if (died) this._creditKill(patch.ownerId, t, '화염 장판으로');
          }
        }
      }
      survivors.push(patch);
    }
    this.firePatches = survivors;
  }

  // --- 작살 (harpoon): F GRAPPLE — fire a hook along the aim, then zip the
  //     player toward the anchored point (wall/platform/enemy). Works mid-air
  //     and carries momentum out, so it doubles as platformer traversal. -------
  _harpoonPull(player, now) {
    const sk = SkillConfig.harpoon;
    player.skillCdLeft = (sk.cooldownMs || 5000) / 1000;
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    // Nearest anchor along the aim: terrain (solids) or an enemy, capped by the
    // hook range and the arena bound.
    const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
    let dist = Math.min(sk.pullRange || 360, Number.isFinite(wallDist) ? wallDist : (sk.pullRange || 360));
    dist = Math.min(dist, this._terrainRayDist(player.x, player.y, dirX, dirY));
    let hookedEnemy = false;
    Object.keys(this.players).forEach(tid => {
      const t = this.players[tid];
      if (t.id === player.id || t.isDead) return;
      const d = Collision.rayCircleHitDistance(player.x, player.y, dirX, dirY, t.x, t.y, (t.radius || 14) + 5);
      if (d !== null && d < dist) { dist = d; hookedEnemy = true; }
    });

    const anchorX = player.x + dirX * dist;
    const anchorY = player.y + dirY * dist;
    // Stop a little short of the anchor so we don't clip into the wall/enemy.
    const stop = Math.max(0, dist - (sk.stopGap || 32));
    player.grappleX = player.x + dirX * stop;
    player.grappleY = player.y + dirY * stop;
    player.grappling = true;
    player.grappleTimeLeft = PHYS.grappleMaxMs / 1000;
    player.jumping = false;

    // Hooking an enemy still slows them where they stand.
    if (hookedEnemy && sk.arrivalSlowMs) {
      Object.values(this.players).forEach(t => {
        if (t.id === player.id || t.isDead || t.isInvincible()) return;
        if (Math.hypot(t.x - anchorX, t.y - anchorY) <= (t.radius || 14) + 8) this._applySlow(t, sk.arrivalSlowMs);
      });
    }
    // Chain beam from the player to the anchor for the zip's duration.
    this.effects.push({
      id: `${player.id}-harpoonpull-${now}`,
      attackerId: player.id,
      x: player.x, y: player.y,
      x2: anchorX, y2: anchorY,
      angle: player.angle, weapon: 'harpoon', type: 'railbeam',
      progress: 0, timestamp: now, lifetime: PHYS.grappleMaxMs
    });
  }

  // --- 쇠뇌 (pistols key): F barrage of 8 fanned shots, then a back-hop -----
  _spawnPistolBullet(player, angle, damage, speed, range, now, tag) {
    const spawnDist = (player.radius || 14) + 3;
    const proj = new Projectile(
      `${player.id}-pistol-${tag}`,
      player.id,
      player.x + Math.cos(angle) * spawnDist,
      player.y + Math.sin(angle) * spawnDist,
      angle, speed, range, damage, 'pistol'
    );
    proj.weapon = 'pistols';
    proj.radius = 5;
    this.projectiles.push(proj);
  }

  _firePistolBarrage(player, now) {
    const sk = SkillConfig.pistols;
    player.skillCdLeft = (sk.cooldownMs || 6000) / 1000;
    const count = sk.burstCount || 8;
    if (!this.pendingPistolBursts) this.pendingPistolBursts = [];
    this.pendingPistolBursts.push({
      playerId: player.id,
      shotsLeft: count,
      total: count,
      interval: (sk.burstMs || 600) / count,
      nextAt: now,
      hopped: false
    });
  }

  // --- 디펜더 (guardian): orbiting blades + F launch/recall ----------

  // Deterministic blade positions for a guardian player at host time `now`.
  _guardianBladePositions(player, now) {
    const cfg = Weapons.guardian;
    const base = (now / (cfg.orbitPeriodMs || 1100)) * Math.PI * 2;
    const n = cfg.orbitCount || 2;
    // 수호 태세: widen the orbit while active (radius only — re-hit cap makes
    // a speed change DPS-neutral, so geometry stays consistent with the client).
    const stance = player.guardianStanceUntil && now < player.guardianStanceUntil;
    const radius = cfg.orbitRadius + (stance ? (cfg.stanceRadiusBonus || 0) : 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * Math.PI * 2;
      out.push({ x: player.x + Math.cos(a) * radius, y: player.y + Math.sin(a) * radius, angle: a });
    }
    return out;
  }

  // F 집중 사출: immediately dispatch all available orbit blades at enemies in expanded range.
  _guardianSurge(player, now) {
    const sk = SkillConfig.guardian;
    player.skillCdLeft = (sk.cooldownMs || 5000) / 1000;
    const surgeRange = sk.surgeRange || 200;
    const cfg = Weapons.guardian;
    const deployed = this.projectiles.filter(p => p.kind === 'guardianseek' && p.ownerId === player.id);
    const deployedSlots = new Set(deployed.map(p => p.bladeSlot));
    const enemies = Object.values(this.players).filter(t =>
      t.id !== player.id && !t.isDead && typeof t.isInvincible === 'function' && !t.isInvincible() &&
      Math.hypot(t.x - player.x, t.y - player.y) <= surgeRange
    );
    if (!enemies.length) return;
    const blades = this._guardianBladePositions(player, now);
    for (let i = 0; i < (cfg.orbitCount || 3); i++) {
      if (deployedSlots.has(i)) continue;
      const target = enemies[Math.floor(Math.random() * enemies.length)];
      const b = blades[i];
      const angle = Math.atan2(target.y - b.y, target.x - b.x);
      const proj = new Projectile(
        `${player.id}-gsurge-${now}-${i}`, player.id,
        b.x, b.y, angle,
        (cfg.seekSpeed || 420) * 1.3, Infinity, sk.surgeDamage || 24, 'guardianseek'
      );
      proj.weapon = 'guardian';
      proj.radius = cfg.bladeRadius || 9;
      proj.phase = 'out';
      proj.bladeSlot = i;
      proj.targetId = target.id;
      proj.hitOnce = false;
      proj.deathName = '디펜더';
      proj.hitLabel = '디펜더로';
      this.projectiles.push(proj);
    }
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
      weapon: 'guardian', type: 'projectile_shot', projectileKind: 'guardianseek',
      progress: 0, timestamp: now, lifetime: 180
    });
  }

  // LMB 추적 칼날: detach one blade that homes the nearest enemy for a short time.
  _spawnHomingBlade(player, now) {
    const sk = SkillConfig.guardian;
    const spawnDist = (player.radius || 14) + 6;
    const proj = new Projectile(
      `${player.id}-ghoming-${now}`, player.id,
      player.x + Math.cos(player.angle) * spawnDist,
      player.y + Math.sin(player.angle) * spawnDist,
      player.angle, sk.homingSpeed || 360, Infinity, sk.homingDamage || 14, 'guardiandart'
    );
    proj.weapon = 'guardian';
    proj.radius = 11;
    proj.expireAt = now + (sk.homingDurationMs || 1500);
    proj.hitCooldownMs = sk.homingHitCooldownMs || 400;
    proj.homingHits = {};
    this.projectiles.push(proj);
  }

  _updateHomingBlade(proj, deltaTime, now) {
    if (now >= proj.expireAt) { proj.isDead = true; return; }
    // steer toward the nearest living enemy
    let best = null, bestD = Infinity;
    for (const t of Object.values(this.players)) {
      if (t.id === proj.ownerId || t.isDead) continue;
      const d = Math.hypot(t.x - proj.x, t.y - proj.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) proj.angle = Math.atan2(best.y - proj.y, best.x - proj.x);
    proj.vx = Math.cos(proj.angle) * proj.speed;
    proj.vy = Math.sin(proj.angle) * proj.speed;
    proj.x += proj.vx * deltaTime;
    proj.y += proj.vy * deltaTime;
    if (proj.x < 0 || proj.x > this.mapWidth || proj.y < 0 || proj.y > this.mapHeight) { proj.isDead = true; return; }
    for (const t of Object.values(this.players)) {
      if (t.id === proj.ownerId || t.isDead || t.isInvincible()) continue;
      if (Math.hypot(t.x - proj.x, t.y - proj.y) > (t.radius || 14) + proj.radius) continue;
      if ((proj.homingHits[t.id] || 0) > now) continue;
      proj.homingHits[t.id] = now + proj.hitCooldownMs;
      const died = t.takeDamage(proj.damage, '디펜더');
      if (died) this._creditKill(proj.ownerId, t, '디펜더로');
    }
  }

  // 차크람 LMB 맴돌이: a defensive disc orbits the caster, dealing contact damage
  // with a per-target hit cooldown while active.
  _updateChakramOrbit(now) {
    Object.values(this.players).forEach(player => {
      if (player.isDead || !player.chakramOrbitUntil || now >= player.chakramOrbitUntil) return;
      const orbitR = player.chakramOrbitRadius || 46;
      const baseAng = (now / 93) % (Math.PI * 2);
      const hits = player.chakramOrbitHits || (player.chakramOrbitHits = {});
      for (let i = 0; i < 3; i++) {
        const ang = baseAng + (i / 3) * Math.PI * 2;
        const ox = player.x + Math.cos(ang) * orbitR;
        const oy = player.y + Math.sin(ang) * orbitR;
        Object.values(this.players).forEach(target => {
          if (target.id === player.id || target.isDead || target.isInvincible()) return;
          if (Math.hypot(target.x - ox, target.y - oy) > target.radius + 12) return;
          if ((hits[target.id] || 0) > now) return;
          hits[target.id] = now + (player.chakramOrbitHitCd || 400);
          const died = target.takeDamage(player.chakramOrbitDamage || 14, player.nickname);
          if (died) this._creditKill(player.id, target, '부메랑으로');
        });
      }
    });
  }

  // 열기 방패 (flamethrower LMB): burns enemies that stay in contact while active.
  _updateHeatShield(now) {
    Object.values(this.players).forEach(player => {
      if (player.isDead || !player.heatShieldUntil || now >= player.heatShieldUntil) return;
      const cr = player.heatShieldRadius || 34;
      if (!player._heatHits) player._heatHits = {};
      Object.values(this.players).forEach(t => {
        if (t.id === player.id || t.isDead || t.isInvincible()) return;
        if (Math.hypot(t.x - player.x, t.y - player.y) > cr + (t.radius || 14)) return;
        if ((player._heatHits[t.id] || 0) > now) return;
        player._heatHits[t.id] = now + 300;
        this._applyBurn(t, player.id);
      });
    });
  }

  // Auto-dispatch one orbit blade per 0.5 s toward an enemy within seekRange.
  _guardianAutoSeek(now) {
    const cfg = Weapons.guardian;
    Object.values(this.players).forEach(player => {
      if (player.weapon !== 'guardian' || player.isDead) return;
      if (now < (player.guardianNextSeekAt || 0)) return;
      const deployed = this.projectiles.filter(p => p.kind === 'guardianseek' && p.ownerId === player.id);
      if (deployed.length >= (cfg.orbitCount || 3)) return;
      const seekRange = cfg.seekRange || 130;
      const enemies = Object.values(this.players).filter(t =>
        t.id !== player.id && !t.isDead && typeof t.isInvincible === 'function' && !t.isInvincible() &&
        Math.hypot(t.x - player.x, t.y - player.y) <= seekRange
      );
      if (!enemies.length) return;
      const deployedSlots = new Set(deployed.map(p => p.bladeSlot));
      let slot = 0;
      for (let i = 0; i < (cfg.orbitCount || 3); i++) {
        if (!deployedSlots.has(i)) { slot = i; break; }
      }
      const target = enemies[Math.floor(Math.random() * enemies.length)];
      const b = this._guardianBladePositions(player, now)[slot];
      const angle = Math.atan2(target.y - b.y, target.x - b.x);
      const proj = new Projectile(
        `${player.id}-gseek-${now}-${slot}`, player.id,
        b.x, b.y, angle,
        cfg.seekSpeed || 420, Infinity, cfg.damage || 18, 'guardianseek'
      );
      proj.weapon = 'guardian';
      proj.radius = cfg.bladeRadius || 9;
      proj.phase = 'out';
      proj.bladeSlot = slot;
      proj.targetId = target.id;
      proj.hitOnce = false;
      proj.deathName = '디펜더';
      proj.hitLabel = '디펜더로';
      this.projectiles.push(proj);
      player.guardianNextSeekAt = now + (cfg.seekIntervalMs || 500);
    });
  }

  // Update a guardianseek blade: track target on 'out', home to owner on 'return'.
  _updateGuardianSeek(proj, dt, now) {
    const owner = this.players[proj.ownerId];
    if (!owner || owner.isDead) { proj.isDead = true; return; }
    if (proj.phase === 'out') {
      const target = this.players[proj.targetId];
      if (target && !target.isDead) {
        const angle = Math.atan2(target.y - proj.y, target.x - proj.x);
        proj.vx = Math.cos(angle) * proj.speed;
        proj.vy = Math.sin(angle) * proj.speed;
        proj.angle = angle;
      }
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      if (target && !target.isDead && !proj.hitOnce && typeof target.isInvincible === 'function' && !target.isInvincible()) {
        if (Math.hypot(target.x - proj.x, target.y - proj.y) <= (target.radius || 14) + proj.radius) {
          proj.hitOnce = true;
          const died = target.takeDamage(proj.damage, proj.deathName || '디펜더');
          if (died) this._creditKill(proj.ownerId, target, proj.hitLabel || '디펜더로');
          proj.phase = 'return';
          return;
        }
      }
      const dist = Math.hypot(proj.x - proj.startX, proj.y - proj.startY);
      if (dist > (Weapons.guardian?.seekRange || 130) * 1.5 || !target || target.isDead) {
        proj.phase = 'return';
      }
      return;
    }
    const dx = owner.x - proj.x, dy = owner.y - proj.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 22) { proj.isDead = true; return; }
    const sp = (proj.speed || 420) * 1.2;
    proj.vx = (dx / dist) * sp; proj.vy = (dy / dist) * sp;
    proj.angle = Math.atan2(dy, dx);
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
  }

  _launchGuardianBlades(player, now) {
    const sk = SkillConfig.guardian;
    // Cooldown is governed by the R aux executor (altSkillCdLeft), not skillCdLeft.
    const blades = this._guardianBladePositions(player, now);
    blades.forEach((b, i) => {
      const proj = new Projectile(
        `${player.id}-gblade-${now}-${i}`,
        player.id, b.x, b.y, b.angle,
        sk.launchSpeed, Infinity, sk.launchDamage, 'guardianlaunch'
      );
      proj.weapon = 'guardian';
      proj.radius = 11;
      proj.phase = 'out';
      proj.bornAt = now;
      proj.outRange = sk.launchRange;
      proj.locksOwner = false;
      proj.deathName = '디펜더';
      proj.hitLabel = '디펜더로';
      proj.hitOut = new Set();
      proj.hitBack = new Set();
      this.projectiles.push(proj);
    });
    this.effects.push({
      attackerId: player.id, x: player.x, y: player.y, angle: player.angle,
      weapon: 'guardian', type: 'projectile_shot', projectileKind: 'guardianlaunch',
      progress: 0, timestamp: now, lifetime: 220
    });
  }

  _processPistolBursts(now) {
    if (!this.pendingPistolBursts?.length) return;
    const sk = SkillConfig.pistols;
    const fan = ((sk.fanSpreadDeg || 70) * Math.PI) / 180;
    const waiting = [];
    for (const b of this.pendingPistolBursts) {
      const player = this.players[b.playerId];
      if (!player || player.isDead || player.weapon !== 'pistols') continue; // drop
      while (b.shotsLeft > 0 && now >= b.nextAt) {
        const idx = b.total - b.shotsLeft;
        const t = b.total <= 1 ? 0.5 : idx / (b.total - 1);
        const off = (t - 0.5) * fan;
        this._spawnPistolBullet(player, player.angle + off, sk.damage, sk.speed, sk.range, now, `barrage-${b.nextAt}-${idx}`);
        b.shotsLeft--;
        b.nextAt += b.interval;
      }
      if (b.shotsLeft > 0) {
        waiting.push(b);
      } else if (!b.hopped) {
        this._lungePlayer(player, -(sk.hopDistance || 90)); // backward escape hop
        b.hopped = true;
      }
    }
    this.pendingPistolBursts = waiting;
  }

  // 조준 사격 (pistols R): after the 0.4s windup, fire a piercing hitscan that
  // damages every enemy along the aim line (stopped only by walls/cover).
  _processAimedShots(now) {
    if (!this.pendingAimedShots?.length) return;
    const waiting = [];
    for (const s of this.pendingAimedShots) {
      if (now < s.fireAt) { waiting.push(s); continue; }
      const player = this.players[s.playerId];
      if (!player || player.isDead || player.weapon !== 'pistols') continue;
      const dirX = Math.cos(player.angle), dirY = Math.sin(player.angle);
      const wallDist = Collision.rayToBoundsDistance(player.x, player.y, dirX, dirY, this.mapWidth, this.mapHeight);
      const coverDist = this._terrainRayDist(player.x, player.y, dirX, dirY);
      const maxDist = Math.min(s.range, Number.isFinite(wallDist) ? wallDist : s.range, coverDist);
      for (const t of Object.values(this.players)) {
        if (t.id === player.id || t.isDead || t.isInvincible()) continue;
        const d = Collision.rayCircleHitDistance(player.x, player.y, dirX, dirY, t.x, t.y, t.radius);
        if (d === null || d > maxDist) continue;
        const died = t.takeDamage(s.damage, player.nickname);
        if (died) this._creditKill(player.id, t, '쇠뇌로');
      }
      this.effects.push({
        id: `${player.id}-aimshot-${now}`, attackerId: player.id,
        x: player.x, y: player.y,
        x2: player.x + dirX * maxDist, y2: player.y + dirY * maxDist,
        angle: player.angle, weapon: 'pistols', type: 'railbeam',
        progress: 0, timestamp: now, lifetime: 280
      });
    }
    this.pendingAimedShots = waiting;
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

    if (signature === this.lastInputSignature && now - this.lastInputSentAt < 100) {
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
    const now = Date.now();

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
    const now = Date.now();
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
      biome: this.biome,
      water: this.water,
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
   * Host: Serialize entire scene state to send out
   */
  _broadcastState() {
    const playerSnapshots = {};
    Object.keys(this.players).forEach(id => {
      playerSnapshots[id] = this.players[id].serialize();
    });

    const projectileSnapshots = this.projectiles.map(p => p.serialize());

    // Host effects are compiled dynamically as well
    const payload = Protocol.gameState(
      playerSnapshots,
      projectileSnapshots,
      this.effects,
      this.remainingPlayersCount,
      zoneRenderPayload(this.zone),
      this.roomConfig.healing ? this.healingItems : null,
      this.mines.length ? this.mines : null,
      this.firePatches.length ? this.firePatches : null
    );

    this.networkManager.broadcast(payload);
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

  _weaponHasAltSkill(weapon) {
    return weapon === 'sniper' || weapon === 'magicstaff' || weapon === 'katana' || Boolean(AuxSkillConfig[weapon]?.alt);
  }

  _weaponHasTargetSkill(weapon) {
    return weapon === 'magicstaff' || Boolean(AuxSkillConfig[weapon]?.target);
  }

  _playerHasWorkshopSkill(player, slot) {
    return Boolean(player?.workshopWeapon?.presetCombat?.[slot]);
  }

  _playerUsesWorkshopWeapon(player) {
    return Boolean(player?.workshopWeapon);
  }

  _playerHasVisibleFSkill(player) {
    if (!player) return false;
    if (this._playerUsesWorkshopWeapon(player)) return this._playerHasWorkshopSkill(player, 'skill');
    return Boolean(SkillConfig[player.weapon] || player.weapon === 'magicstaff');
  }

  _playerHasVisibleESkill(player) {
    if (!player) return false;
    if (this._playerUsesWorkshopWeapon(player)) return this._playerHasWorkshopSkill(player, 'skill2');
    return this._weaponHasAltSkill(player.weapon);
  }

  _playerHasVisibleRSkill(player) {
    if (!player) return false;
    if (this._playerUsesWorkshopWeapon(player)) return this._playerHasWorkshopSkill(player, 'skill3');
    return this._weaponHasTargetSkill(player.weapon);
  }

  _workshopSkillCooldownInfo(player, slot) {
    const combat = player?.workshopWeapon?.presetCombat?.[slot];
    if (!combat) return null;
    return {
      left: Math.max(0, Number(player?.wsSkillCd?.[slot]) || 0),
      total: Math.max(0.1, (Number(combat.cooldownMs) || 1000) / 1000),
      color: player.workshopWeapon?.color || Weapons[player.weapon]?.color || '#c9a227'
    };
  }

  _workshopSkillName(player, slot, fallback = '스킬') {
    return clampSkillLabel(player?.workshopWeapon?.presetNames?.[slot], fallback);
  }

  _showSkillCallout(player, slot, fallback = '스킬', now = Date.now()) {
    if (!player) return;
    const text = this._workshopSkillName(player, slot, fallback);
    this.effects.push({
      attackerId: player.id,
      x: player.x,
      y: player.y,
      weapon: player.weapon || '',
      type: 'skill_callout',
      text,
      progress: 0,
      timestamp: now,
      lifetime: 760
    });
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
  /** Banner text. Routed through the presentation sink so simulation code that
   *  announces (respawns, countdown, kills) stays free of the DOM. */
  _announce(text) {
    this.fx.announce(text);
  }

  /**
   * Spawner positions math
   */
  _getRandomSpawnPoint() {
    // Platformer: stand the body on a ground spawn OR a one-way platform top.
    // When the 2D hazard is intruding, only stand points clear of the rising
    // flood and the closing side walls are eligible — otherwise the player
    // would respawn straight into the lava and die in a loop.
    const halfH = 20;
    const cands = [];
    for (const s of (this.level?.spawns || [])) cands.push({ x: s.x, y: s.y });
    for (const ow of (this.level?.oneWays || [])) cands.push({ x: ow.x + ow.w / 2, y: ow.y });
    if (!cands.length) cands.push({ x: this.mapWidth / 2, y: this.mapHeight / 2 });

    const z = this.zone;
    const hazard = !!(z && typeof z.isDamaging === 'function' && z.isDamaging());
    const margin = 30;
    const isSafe = (p) => {
      if (!hazard) return true;
      if (p.y >= (z.floorY ?? Infinity) - margin) return false;               // in/under the flood
      if (p.x <= (z.leftX ?? 0) + margin || p.x >= (z.rightX ?? this.mapWidth) - margin) return false; // beyond a wall
      return true;
    };
    let pool = cands.filter(isSafe);
    if (!pool.length) pool = [cands.reduce((a, b) => (b.y < a.y ? b : a))]; // none safe → highest

    let best = pool[0], bestDist = -1;
    for (const s of pool) {
      let nearest = Infinity;
      for (const id in this.players) {
        const o = this.players[id];
        if (o.isDead) continue;
        const dx = o.x - s.x, dy = o.y - (s.y - halfH);
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      if (nearest > bestDist) { bestDist = nearest; best = s; }
    }
    let x = best.x;
    let y = best.y - halfH - 1;
    if (hazard && z) {
      const marginX = 42;
      const left = Number.isFinite(z.leftX) ? z.leftX + marginX : marginX;
      const right = Number.isFinite(z.rightX) ? z.rightX - marginX : (this.mapWidth || 0) - marginX;
      if (right > left) x = Math.max(left, Math.min(right, x));
      if (Number.isFinite(z.floorY)) {
        y = Math.min(y, z.floorY - halfH - 36);
      }
    }
    return { x, y };
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
      dummy: !!this.dummyRoom || !!this.botMatch
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

      // 1. Double check capacity or duplicate IDs
      if (this.players[remoteId]) return;

      // 2. Select elegant far coordinate to spawn newcomer
      const spawnP = this._getRandomSpawnPoint();
      const nickname = sanitizeNickname(joinPayload.nickname);
      const weapon = Weapons[joinPayload.weapon] ? joinPayload.weapon : 'sword';
      const costume = sanitizeCostume(joinPayload.costume);
      const guestPlayer = new Player(remoteId, nickname, weapon, spawnP.x, spawnP.y, costume);
      guestPlayer.applyCosmetics(sanitizeCosmetics(joinPayload.costume?.cosmetics));
      guestPlayer.isMobile = !!joinPayload.isMobile; // touch players fire instantly
      guestPlayer.mobileAimAssist = joinPayload.controls?.mobileAimAssist === undefined ? true : !!joinPayload.controls.mobileAimAssist;
      guestPlayer.automaticAttack = !!joinPayload.controls?.automaticAttack;
      this._enforceWorkshopPolicy(guestPlayer);
      this.players[remoteId] = guestPlayer;

      this._announce(`${guestPlayer.nickname}님이 전장에 입장했습니다!`);

      // 3. Serialise existing player lists to supply to joining guest as initial context
      const existingPlayers = {};
      Object.keys(this.players).forEach(id => {
        existingPlayers[id] = this.players[id].serialize();
      });

      // 4. Send hand-shake ROOM_JOINED acceptance packed specifically to the guest.
      //    roomConfig rides along so late-joiners get the exact same arena/rules.
      this.networkManager.sendTo(remoteId, Protocol.roomJoined(
        remoteId,
        existingPlayers,
        this.mapWidth,
        this.mapHeight,
        this.roomConfig,
        this.coverSeed,
        canonicalWeaponsSnapshot()   // host-authoritative canonical weapon defs (T1-F)
      ));

      // 5. Broadcast to everyone else that a new player entered
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
      const now = Date.now();

      if (this.networkManager.isHost) {
        // --- HOST HANDLERS ---
        const player = this.players[fromId];
        if (!player) return;

        // Weapon swaps are accepted even while dead (applied on next respawn).
        if (data.type === MsgType.WEAPON_SELECT) {
          if (typeof data.weapon === 'string' && data.weapon.startsWith('ws:') && data.workshopWeapon) {
            player.pendingWorkshopWeapon = data.workshopWeapon;
            player.pendingWeapon = null;
          } else if (Weapons[data.weapon]) {
            player.pendingWeapon = data.weapon;
            player.pendingWorkshopWeapon = null;
          }
          return;
        }

        if (player.isDead) return;

        if (data.type === MsgType.PLAYER_INPUT) {
          player.keys = sanitizeInputKeys(data.keys);
        } else if (data.type === MsgType.PLAYER_AIM) {
          if (Number.isFinite(data.angle)) {
            player.angle = data.angle;
          }
        } else if (data.type === MsgType.PLAYER_ACTION) {
          this._handlePlayerAction(player, data, now);
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
          this._buildTerrain();   // biome + water + cover (deterministic from config + seed)

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

            p.kills = snap.kills;
            p.isDead = snap.isDead;
            p.nickname = snap.nickname || p.nickname;
            p.weapon = Weapons[snap.weapon] ? snap.weapon : p.weapon;
            p.maxHp = positiveFinite(snap.maxHp) ? snap.maxHp : (Weapons[p.weapon]?.maxHp || p.maxHp || 100);
            p.hp = Number.isFinite(snap.hp) ? Math.min(snap.hp, p.maxHp) : p.maxHp;
            if (Number.isFinite(snap.vx)) p.vx = snap.vx;
            if (Number.isFinite(snap.vy)) p.vy = snap.vy;
            p.grounded = Boolean(snap.grounded);
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
            p.activeHitboxes = Array.isArray(snap.activeHitboxes) ? snap.activeHitboxes.slice(0, 8) : [];
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

            if (id !== this.localPlayerId) {
              // Soft buffer coordinates for smooth client interpolation
              p.targetX = snap.x;
              p.targetY = snap.y;
              p.targetAngle = snap.angle;
            } else {
              // Reconcile local prediction toward the host WITHOUT teleporting:
              // moderate drift is corrected a fraction at a time (spread across
              // ticks, invisible), and only a big desync — knockback, respawn or
              // a lag spike — hard-snaps.
              const correctionDistance = localCorrectDist(p.x, p.y, snap.x, snap.y);
              if (p.isDead || correctionDistance > 120) {
                p.x = snap.x;
                p.y = snap.y;
              } else if (correctionDistance > 6) {
                p.x += (snap.x - p.x) * 0.25;
                p.y += (snap.y - p.y) * 0.25;
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

function dirFromKeys(keys = {}) {
  let dx = 0;
  let dy = 0;
  if (keys.w || keys.ArrowUp) dy -= 1;
  if (keys.s || keys.ArrowDown) dy += 1;
  if (keys.a || keys.ArrowLeft) dx -= 1;
  if (keys.d || keys.ArrowRight) dx += 1;
  return { dx, dy };
}

function sanitizeNickname(value) {
  const nickname = String(value || '').trim().replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 12);
  return nickname || 'Gladiator';
}

// Validate a costume frame received from a peer — only allow safe CSS color
// strings (hsl/rgb/#hex/names). Returns null to fall back to the hash colors.
function sanitizeCostume(costume) {
  if (!costume || typeof costume !== 'object') return null;
  const safe = (c) => {
    if (typeof c !== 'string') return null;
    const s = c.trim().slice(0, 40);
    return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:hsla?|rgba?)\([0-9.,%\s]+\))$/.test(s) ? s : null;
  };
  const color = safe(costume.color);
  if (!color) return null;
  const safeToken = (value, allowed) => {
    if (typeof value !== 'string') return null;
    const token = value.trim().slice(0, 24);
    return allowed.has(token) ? token : null;
  };
  const decorations = new Set(['crest', 'wings', 'crown', 'halo', 'cape']);
  const effects = new Set(['embers', 'leaves', 'sparkles', 'runes', 'shade']);
  return {
    color,
    accentColor: safe(costume.accentColor) || color,
    decoration: safeToken(costume.decoration, decorations),
    effect: safeToken(costume.effect, effects)
  };
}

// Validate a guest's cosmetic loadout (P2P → never trust the wire). Drops
// anything malformed/unknown so it falls back to the default look. Cosmetic
// only — nothing here can affect combat.
function sanitizeCosmetics(cos) {
  if (!cos || typeof cos !== 'object') return null;
  const color = (c) => (typeof c === 'string' &&
    /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:hsla?|rgba?)\([0-9.,%\s]+\))$/.test(c.trim().slice(0, 40)))
    ? c.trim().slice(0, 40) : null;
  const out = {};
  // weapon skins: per-weapon map { sword: 'ember', ... }
  const VALID_WEAPONS = new Set(['axe','bow','chakram','crossbow','dagger','flamethrower','greatsword','guardian','hammer','harpoon','katana','magicstaff','rapier','scythe','sniper','spear','sword']);
  const VALID_SKINS = new Set(['ember','frost','void']);
  if (cos.weaponskins && typeof cos.weaponskins === 'object' && !Array.isArray(cos.weaponskins)) {
    const ws = {};
    for (const [wpn, sk] of Object.entries(cos.weaponskins)) {
      if (VALID_WEAPONS.has(wpn) && VALID_SKINS.has(sk)) ws[wpn] = sk;
    }
    if (Object.keys(ws).length) out.weaponskins = ws;
  }
  if (color(cos.dashtrail?.data?.color)) out.dashtrail = { data: { color: color(cos.dashtrail.data.color) } };
  if (color(cos.respawnfx?.data?.color)) out.respawnfx = { data: { color: color(cos.respawnfx.data.color) } };
  const styles = new Set(['firework', 'skull', 'coins']);
  if (styles.has(cos.killfx?.data?.style)) {
    out.killfx = { data: { style: cos.killfx.data.style, color: color(cos.killfx.data.color) } };
  }
  if (typeof cos.title?.data?.text === 'string' && cos.title.data.text.trim()) {
    out.title = { data: { text: cos.title.data.text.trim().slice(0, 12), color: color(cos.title.data.color) } };
  }
  return out;
}

function sanitizeInputKeys(keys = {}) {
  return {
    w: Boolean(keys.w),
    a: Boolean(keys.a),
    s: Boolean(keys.s),
    d: Boolean(keys.d),
    ArrowUp: Boolean(keys.ArrowUp),
    ArrowDown: Boolean(keys.ArrowDown),
    ArrowLeft: Boolean(keys.ArrowLeft),
    ArrowRight: Boolean(keys.ArrowRight)
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

function angleDistance(a, b) {
  let delta = a - b;
  while (delta < -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return Math.abs(delta);
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
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

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function zoneSnapshot(zone) {
  if (!zone) return null;
  return (typeof zone.serialize === 'function') ? zone.serialize() : zone;
}

function zoneRenderPayload(zone) {
  const z = zoneSnapshot(zone);
  if (!z) return null;
  if (z.kind === 'platformer_rise') return z;
  const x = Number.isFinite(z.x) ? z.x : z.cx;
  const y = Number.isFinite(z.y) ? z.y : z.cy;
  const nextX = Number.isFinite(z.nextX) ? z.nextX : z.nextCx;
  const nextY = Number.isFinite(z.nextY) ? z.nextY : z.nextCy;
  return {
    x,
    y,
    radius: z.radius,
    nextX,
    nextY,
    nextRadius: z.nextRadius,
    phase: z.phase
  };
}

function zoneIsDamaging(zone) {
  if (!zone) return false;
  if (typeof zone.isDamaging === 'function') return zone.isDamaging();
  const z = zoneSnapshot(zone);
  return z?.phase === 'shrinking' || z?.phase === 'hold';
}

function zoneIsOutside(zone, x, y) {
  if (!zone || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (typeof zone.isOutside === 'function') return zone.isOutside(x, y);
  const z = zoneSnapshot(zone);
  if (!z) return false;
  if (z.kind === 'platformer_rise') {
    return y >= z.floorY || x <= z.leftX || x >= z.rightX;
  }
  const cx = Number.isFinite(z.x) ? z.x : z.cx;
  const cy = Number.isFinite(z.y) ? z.y : z.cy;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(z.radius)) return false;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy > z.radius * z.radius;
}

function hitboxDamageDivisor(hitboxes) {
  return Math.max(1, Array.isArray(hitboxes) ? hitboxes.length : 0);
}

// Damage number styling tier (drives color + size in the renderer). Derived
// from the amount alone so it needs no extra netcode.
function damageTier(amount) {
  if (amount >= 80) return 'lethal'; // instakills / charged finishers
  if (amount >= 38) return 'big';    // skills, heavy hits
  return 'normal';
}

// Default presentation sink: headless. The browser shell replaces it with a
// BrowserFx in the constructor; a server (or a test that builds an instance
// straight off the prototype) inherits this no-op and stays DOM-free.
Game.prototype.fx = NULL_FX;
