/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Weapons, getEffectiveWeapon, DashConfig } from './Weapons.js';
import { STATUS } from './Status.js';
import { PHYS } from './Level.js';
import { Collision } from './Collision.js';
import { clampWorkshopWeapon } from './Workshop.js';
import { BlockVM } from './BlockVM.js';
import { BlockBudget, weaponBaseDps } from './BlockBudget.js';

export class Player {
  constructor(id, nickname, weaponType, x = 0, y = 0, costume = null) {
    this.id = id;
    this.nickname = nickname || 'Gladiator';
    this.isMobile = false;   // touch player → instant sniper/matchlock + visible aim tell
    this.mobileAimAssist = true;
    this.automaticAttack = false;
    this.weapon = weaponType in Weapons ? weaponType : 'sword';
    const weaponConfig = Weapons[this.weapon] || Weapons.sword;
    this.x = x;
    this.y = y;
    // Position at the start of the current host tick, used for swept melee hit
    // tests so a fast-moving target can't tunnel through a thin/quick blade.
    this.prevX = x;
    this.prevY = y;

    // Core parameters
    this.maxHp = weaponConfig.maxHp || 100;
    this.hp = this.maxHp;
    this.speed = 180; // px/s
    this.radius = 14;
    this.angle = 0; // aim angle in radians
    this.kills = 0;       // real-opponent kills (reported to the server for coins/rank)
    this.dummyKills = 0;  // practice-dummy kills (HUD only — never reported/credited)
    this.deaths = 0;      // times this player has been killed (telemetry / K-D)
    this.isDead = false;
    this.respawnRemainingMs = 0;
    // Training dummy: spawned by the host in a dummy room. Doesn't move or
    // attack, respawns at its home spot, and is rendered with a clear label.
    this.isDummy = false;

    // Cool down tracker
    this.lastAttackTime = 0;
    this.swingDirection = -1;   // first triggerAttack flips this to +1 (downward first swing)
    this.gauntletPunchSide = -1;
    this.comboStep = 0;
    this.comboDelayUntil = 0;

    // --- Dash / i-frame state (seconds remaining) ---
    this.dashTimeLeft = 0;
    this.iframeTimeLeft = 0;
    this.dashCdLeft = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
    this.stunTimeLeft = 0;

    // --- Platformer physics state (side-scroller pivot) ---
    this.vx = 0;                 // horizontal velocity (px/s)
    this.vy = 0;                 // vertical velocity (px/s, + = down)
    this.grounded = false;       // standing on solid/one-way this frame
    this.facing = 1;             // +1 right, -1 left (follows the aim/cursor)
    this.coyoteLeft = 0;         // grace window to still jump after leaving ground
    this.jumpBufferLeft = 0;     // buffered jump press (fires on landing)
    this.jumpHeldPrev = false;   // previous frame's jump-held (edge detection)
    this.jumping = false;        // in a rising jump (variable-height cut applies)
    this.dropThroughLeft = 0;    // brief window where one-way platforms are ignored
    this.halfW = 13;             // AABB half-width
    this.halfH = 20;             // AABB half-height
    // Grapple (harpoon F): zip toward a hooked world point.
    this.grappling = false;
    this.grappleX = 0;
    this.grappleY = 0;
    this.grappleTimeLeft = 0;

    // --- F skill state ---
    this.skillCdLeft = 0;     // seconds remaining on the skill cooldown
    this.buffType = null;     // 'axe_rage' | 'gauntlet_lance' | null
    this.buffTimeLeft = 0;    // seconds remaining on the active buff
    this.spearThrown = false; // true while the javelin skill is airborne
    this.chakramOut = false;  // true while a thrown chakram hasn't returned (disarmed)
    this.chakramOrbitUntil = 0; // ms timestamp until which the LMB 맴돌이 defensive disc orbits
    this.heatShieldUntil = 0; // ms timestamp until which 열기 방패 (flamethrower LMB) is active
    this.guardianStanceUntil = 0; // ms timestamp until which 수호 태세 (guardian F) widens the orbit
    this.pistolReloadUntil = 0; // ms timestamp until which 구르기 장전 (pistols LMB) speeds up fire
    this.slowTimeLeft = 0;    // seconds of a movement slow (harpoon pull) — can still attack
    // Flamethrower fuel state (host-driven; flameSpraying is synced for visuals).
    this.flameFuel = (Weapons.flamethrower?.fuelMs) || 3000;
    this.flameEmpty = false;
    this.flameSpraying = false;
    this.hammerSkillUntil = 0; // host-ms timestamp: no basic attacks until the hammer skill fully ends
    this.pendingIcicles = 0;   // magic staff: ice shards loaded, waiting for F to fire
    this.magicCooldowns = { fireball: 0, iceShard: 0, lifebound: 0 };
    this.burnTimeLeft = 0;     // fire DoT: seconds remaining
    this.burnTickLeft = 0;     // fire DoT: seconds until the next tick
    this.burnDps = 0;          // fire DoT: damage per tick
    this.burnSourceId = null;  // fire DoT: who applied it (kill credit)
    this.bleedTimeLeft = 0;    // bleed DoT: seconds remaining
    this.bleedTickLeft = 0;    // bleed DoT: seconds until the next tick
    this.bleedDps = 0;         // bleed DoT: damage per tick
    this.bleedSourceId = null; // bleed DoT: who applied it (kill credit)
    this.stunImmuneUntil = 0;  // host-ms: no new stun until this time (anti stun-lock)
    this.statusImmuneUntil = 0;// host-ms: respawn protection — no new status until this time
    this.teleportReadyAt = 0;  // sniper R teleport: host-ms timestamp when ready again
    this.sniperTeleportTargetUntil = 0;
    this.altSkillCdLeft = 0;    // generic R skill cooldown (seconds)
    this.targetSkillCdLeft = 0; // generic LMB skill cooldown (seconds)
    this.pendingWeapon = null; // queued weapon swap, applied on next respawn
    this.arrowStacks = 0;     // bow skill charges earned by landing arrows
    this.greatswordChargeStart = 0;
    this.greatswordChargeAngle = 0;
    this.katanaChargeStart = 0;
    this.katanaChargeAngle = 0;
    this.daggerQte = null;

    // Equipped costume overrides the auto-generated colors; otherwise derive
    // a unique color scheme from the peer ID hash.
    if (costume && costume.color) {
      this.color = costume.color;
      this.accentColor = costume.accentColor || costume.color;
      this.costumeDecoration = costume.decoration || null;
      this.costumeEffect = costume.effect || null;
    } else {
      const colors = this._generateColorsFromId(id);
      this.color = colors.primary;
      this.accentColor = colors.accent;
      this.costumeDecoration = null;
      this.costumeEffect = null;
    }

    // Cosmetic-only loadout (shop). None of these touch combat.
    this.applyCosmetics(costume?.cosmetics);

    // Stickman motion-set loadout id (cosmetic). Synced as a bare id only; the
    // renderer validates it against its local registry and falls back to the
    // weapon's default set if unknown (Phase B stickman pivot). null = default.
    this.motionSetId = (costume && typeof costume.motionSetId === 'string') ? costume.motionSetId : null;
    // Stick appearance blob (color/lineW/head/accessory). Held raw + synced;
    // the renderer sanitizes it. Cosmetic only — never affects collision.
    this.stickLook = (costume && costume.stick && typeof costume.stick === 'object') ? costume.stick : null;

    // Tier-2 workshop weapon (user-authored). When equipped, its ENVELOPE-clamped
    // stats override the base weapon's damage/cooldown/hp/move and its motion's
    // hitboxes drive the hit (combat path is Tier-1's hitbox swing). Always stored
    // pre-clamped; never trust a raw def.
    this.workshopWeapon = null;
    this.blockVM = null;       // sandboxed block-gimmick VM (host-only)
    this.blockVars = {};       // weapon-instance locals (reset on respawn)
    this._blockDepth = 0;      // event-nesting guard (host)
    if (costume && costume.workshopWeapon) {
      this._applyWorkshopWeapon(costume.workshopWeapon);
      this.hp = this.maxHp;
    }
  }

  /** Install (and ENVELOPE re-clamp) a workshop weapon def, applying its maxHp
   *  and building the sandboxed block VM (which sanitizes the AST). */
  _applyWorkshopWeapon(def) {
    const safe = clampWorkshopWeapon(def);
    // The V1 clamp drops weaponVisual; keep the small id-only visual for rendering.
    if (def && def.weaponVisual && (def.weaponVisual.imageId || def.weaponVisual.dual)) {
      safe.weaponVisual = { imageId: def.weaponVisual.imageId ? String(def.weaponVisual.imageId).slice(0, 48) : null, scale: Number(def.weaponVisual.scale) || 1, dual: !!def.weaponVisual.dual };
    }
    // Ranged basic attack (projectile config) — kept for the fire path + renderer.
    if (def && def.ranged && def.projectile) { safe.ranged = true; safe.projectile = def.projectile; }
    this.workshopWeapon = safe;
    // Block-gimmick VM (host runs it; the constructor sanitizes + caps the AST).
    this.blockVM = safe.blocks ? new BlockVM(safe.blocks, 'workshop') : null;
    this.blockVars = {};       // weapon-instance locals (reset on respawn)
    this.blockLists = {};      // weapon-instance lists (reset on respawn)
    // Runtime OUTPUT budget (BlockVM 2.0): meters damage/CC/spawn per second so
    // any combo stays fair. Cap derives from the weapon's intended DPS.
    this.blockBudget = new BlockBudget(weaponBaseDps(safe.stats));
    if (safe.stats && Number.isFinite(safe.stats.maxHp)) {
      this.maxHp = safe.stats.maxHp;
      this.hp = Math.min(this.hp, this.maxHp);
    }
  }

  /** Adopt an equipped-cosmetics set ({weaponskins, killfx, dashtrail, respawnfx, title}). */
  applyCosmetics(cos) {
    this.weaponSkins = cos?.weaponskins || {};  // { weapon: skinId }
    this.weaponSkin = cos?.weaponskin?.data?.skin || null;
    this.weaponTint = cos?.weaponskin?.data?.tint || null;
    this.dashTrailColor = cos?.dashtrail?.data?.color || null;
    this.killFx = cos?.killfx?.data || null;          // { style, color }
    this.respawnFxColor = cos?.respawnfx?.data?.color || null;
    this.title = cos?.title?.data || null;            // { text, color }
  }

  /** Restore the compact serialized cosmetics blob (see serialize). */
  applyCosmeticsSnapshot(c) {
    this.weaponSkins = (c?.ws && typeof c.ws === 'object') ? c.ws : {};
    this.weaponSkin = c?.wskin || null;
    this.weaponTint = c?.wt || null;
    this.dashTrailColor = c?.dt || null;
    this.killFx = c?.kf || null;
    this.respawnFxColor = c?.rf || null;
    this.title = c?.ti || null;
  }

  /** Compact cosmetics blob for the wire. */
  cosmeticsSnapshot() {
    return {
      ws: this.weaponSkins || {},
      wskin: this.weaponSkin || null,
      wt: this.weaponTint || null,
      dt: this.dashTrailColor,
      kf: this.killFx,
      rf: this.respawnFxColor,
      ti: this.title
    };
  }

  /**
   * Generates a balanced, nice looking color scheme using HSL
   */
  _generateColorsFromId(id) {
    let hash = 0;
    const str = String(id);
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Hue from 0 to 360
    const hue = Math.abs(hash) % 360;
    // Saturation 80-95% for bright vivid hues
    const saturation = 85 + (Math.abs(hash >> 8) % 15);
    // Lightness 45-55% for legibility against dark canvas background
    const lightness = 50 + (Math.abs(hash >> 16) % 10);

    return {
      primary: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
      accent: `hsl(${(hue + 180) % 360}, ${saturation}%, 65%)` // Complementary color
    };
  }

  /**
   * Decrement the per-frame movement/i-frame timers. Buff & skill cooldown
   * timers are advanced authoritatively by the host (see Game).
   */
  _tickTimers(deltaTime) {
    if (this.dashTimeLeft > 0) this.dashTimeLeft = Math.max(0, this.dashTimeLeft - deltaTime);
    if (this.iframeTimeLeft > 0) this.iframeTimeLeft = Math.max(0, this.iframeTimeLeft - deltaTime);
    if (this.dashCdLeft > 0) this.dashCdLeft = Math.max(0, this.dashCdLeft - deltaTime);
    if (this.stunTimeLeft > 0) this.stunTimeLeft = Math.max(0, this.stunTimeLeft - deltaTime);
    if (this.slowTimeLeft > 0) this.slowTimeLeft = Math.max(0, this.slowTimeLeft - deltaTime);
  }

  /**
   * Handles local or server physics tick
   */
  /**
   * Platformer physics step (side-scroller pivot). Reads horizontal input +
   * jump (held) + drop-through, applies run accel/air control + gravity +
   * variable-height jump (coyote time, jump buffer), then sweeps the AABB
   * through the level. Dash is a fixed-direction burst (aim/move direction).
   *
   * Input mapping (re-uses the synced movement keys so no protocol change):
   *   a / ArrowLeft = left, d / ArrowRight = right,
   *   w / ArrowUp / Space = jump (held for variable height),
   *   s / ArrowDown + jump = drop through one-way platforms.
   */
  updatePosition(deltaTime, keys, level) {
    if (this.isDead) { this._tickTimers(deltaTime); return; }

    const dt = deltaTime;
    const grav = PHYS.gravity;
    const stunned = this.stunTimeLeft > 0 || !!this.daggerQte;

    // --- Dash burst: constant-velocity, gravity-free, fixed direction ---
    if (this.dashTimeLeft > 0) {
      this.vx = this.dashDirX * PHYS.dashSpeed;
      this.vy = this.dashDirY * PHYS.dashSpeed;
      const hit = Collision.moveAndCollide(this, level, dt);
      this.grounded = hit.grounded;
      if (hit.grounded && this.vy > 0) this.vy = 0;
      this._tickTimers(dt);
      if (this.dropThroughLeft > 0) this.dropThroughLeft -= dt;
      return;
    }

    // --- Grapple: zip toward the hooked point, gravity-free, until reached,
    //     blocked, or timed out — then exit with a little momentum. ---
    if (this.grappling) {
      const gdx = this.grappleX - this.x, gdy = this.grappleY - this.y;
      const gd = Math.hypot(gdx, gdy);
      this.grappleTimeLeft -= dt;
      if (gd < 20 || this.grappleTimeLeft <= 0) {
        this.grappling = false;
        this.vx = (gd > 0.001 ? gdx / gd : 0) * PHYS.runSpeed;   // keep some glide
        this.vy = PHYS.grappleExitVy;
        this._tickTimers(dt);
        return;
      }
      this.vx = (gdx / gd) * PHYS.grappleSpeed;
      this.vy = (gdy / gd) * PHYS.grappleSpeed;
      const hit = Collision.moveAndCollide(this, level, dt);
      if (hit.grounded || hit.ceiling || hit.wallLeft || hit.wallRight) {
        this.grappling = false;
        if (hit.grounded) this.vy = 0; else this.vy = PHYS.grappleExitVy;
      }
      this.grounded = hit.grounded;
      this._tickTimers(dt);
      if (this.dropThroughLeft > 0) this.dropThroughLeft -= dt;
      return;
    }

    this._tickTimers(dt);
    if (this.dropThroughLeft > 0) this.dropThroughLeft -= dt;

    const left = !stunned && (keys.a || keys.ArrowLeft);
    const right = !stunned && (keys.d || keys.ArrowRight);
    const jumpHeld = !stunned && (keys.w || keys.ArrowUp);
    const downHeld = keys.s || keys.ArrowDown;

    // Horizontal target speed (status slow + axe-rage slow still apply).
    const slowMul = this.slowTimeLeft > 0 ? STATUS.slow.moveFactor : 1;
    const rageSlowMul = (this.buffType === 'axe_rage' && this.buffTimeLeft > 0) ? 0.3 : 1; // 70% slow while spinning
    const weaponConfig = Weapons[this.weapon] || Weapons.sword;
    let baseMul = this.workshopWeapon?.stats?.moveSpeed ?? weaponConfig.moveSpeed ?? 1;
    if (this.weapon === 'flamethrower' && this.flameSpraying) baseMul = weaponConfig.sprayMoveSpeed ?? baseMul;
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const targetVx = target * PHYS.runSpeed * baseMul * slowMul * rageSlowMul;

    const accel = this.grounded ? PHYS.groundAccel : PHYS.airAccel;
    const decel = this.grounded ? PHYS.groundDecel : PHYS.airDecel;
    if (target !== 0) {
      this.vx += Math.sign(targetVx - this.vx) * accel * dt;
      // don't overshoot the target speed
      if ((targetVx - this.vx) * target < 0) this.vx = targetVx;
    } else {
      const d = decel * dt;
      this.vx = Math.abs(this.vx) <= d ? 0 : this.vx - Math.sign(this.vx) * d;
    }

    // --- Jump: coyote time + jump buffer + variable height ---
    const jumpPressed = jumpHeld && !this.jumpHeldPrev;
    if (jumpPressed) this.jumpBufferLeft = PHYS.jumpBufferMs / 1000;
    if (this.coyoteLeft > 0) this.coyoteLeft -= dt;
    if (this.jumpBufferLeft > 0) this.jumpBufferLeft -= dt;

    const canJump = (this.grounded || this.coyoteLeft > 0) && !stunned;
    if (this.jumpBufferLeft > 0 && canJump) {
      if (downHeld) {
        // drop through the one-way platform we're standing on instead of jumping
        this.dropThroughLeft = 0.12;
        this.grounded = false;
      } else {
        this.vy = -PHYS.jumpSpeed;
        this.jumping = true;
        this.grounded = false;
        this.coyoteLeft = 0;
        this.jumpBufferLeft = 0;
      }
    }
    // Variable height: releasing jump while rising cuts the upward velocity.
    if (this.jumping && !jumpHeld && this.vy < 0) {
      this.vy *= PHYS.jumpCutMul;
      this.jumping = false;
    }
    if (this.vy >= 0) this.jumping = false;
    this.jumpHeldPrev = jumpHeld;

    // --- Gravity + terminal velocity ---
    this.vy = Math.min(this.vy + grav * dt, PHYS.maxFall);

    // --- Integrate + collide ---
    const dropThrough = this.dropThroughLeft > 0;
    const hit = Collision.moveAndCollide(this, level, dt, { dropThrough });

    const wasGrounded = this.grounded;
    this.grounded = hit.grounded;
    if (this.grounded) {
      this.coyoteLeft = PHYS.coyoteMs / 1000;
      this.jumping = false;
    } else if (wasGrounded && this.vy >= 0) {
      // just walked off a ledge → start the coyote window
      this.coyoteLeft = PHYS.coyoteMs / 1000;
    }

    // Facing follows the aim (cursor) direction for combat readability.
    const fc = Math.cos(this.angle);
    if (fc > 0.01) this.facing = 1; else if (fc < -0.01) this.facing = -1;
  }

  /**
   * Begin a dash in the given direction. Falls back to the aim direction when
   * no movement is held. Returns true when the dash actually started.
   */
  startDash(dirX = 0, dirY = 0) {
    if (this.isDead || this.stunTimeLeft > 0 || this.dashCdLeft > 0 || this.dashTimeLeft > 0) return false;
    if (this.buffType === 'axe_rage' && this.buffTimeLeft > 0) return false; // rooted during axe rage

    let len = Math.hypot(dirX, dirY);
    if (len < 1e-4) {
      dirX = Math.cos(this.angle);
      dirY = Math.sin(this.angle);
      len = 1;
    }

    this.dashDirX = dirX / len;
    this.dashDirY = dirY / len;
    this.dashTimeLeft = PHYS.dashMs / 1000;
    this.iframeTimeLeft = PHYS.dashIframeMs / 1000;
    this.dashCdLeft = PHYS.dashCdMs / 1000;
    this.jumping = false;
    return true;
  }

  isInvincible() {
    return this.iframeTimeLeft > 0;
  }

  /**
   * Reset all combat timers — used on respawn and on death so buffs/cooldowns
   * never linger across lives.
   */
  clearCombatTimers() {
    this.dashTimeLeft = 0;
    this.iframeTimeLeft = 0;
    this.dashCdLeft = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
    this.stunTimeLeft = 0;
    this.grappling = false;
    this.grappleTimeLeft = 0;
    this.skillCdLeft = 0;
    this.buffType = null;
    this.buffTimeLeft = 0;
    this.spearThrown = false;
    this.chakramOut = false;
    this.slowTimeLeft = 0;
    this.flameFuel = (Weapons.flamethrower?.fuelMs) || 3000;
    this.flameEmpty = false;
    this.flameSpraying = false;
    this.hammerSkillUntil = 0;
    this.pendingIcicles = 0;
    this.magicCooldowns = { fireball: 0, iceShard: 0, lifebound: 0 };
    this.burnTimeLeft = 0;
    this.burnTickLeft = 0;
    this.burnDps = 0;
    this.burnSourceId = null;
    this.bleedTimeLeft = 0;
    this.bleedTickLeft = 0;
    this.bleedDps = 0;
    this.bleedSourceId = null;
    // Note: stunImmuneUntil / statusImmuneUntil are timestamps set on respawn,
    // not cleared here (clearCombatTimers also runs on death).
    this.teleportReadyAt = 0;
    this.sniperTeleportTargetUntil = 0;
    this.altSkillCdLeft = 0;
    this.targetSkillCdLeft = 0;
    this.arrowStacks = 0;
    this.greatswordChargeStart = 0;
    this.greatswordChargeAngle = 0;
    this.katanaChargeStart = 0;
    this.katanaChargeAngle = 0;
    this.daggerQte = null;
    this.gauntletPunchSide = -1;
    this.comboStep = 0;
    this.comboDelayUntil = 0;
    this.blockVars = {};       // weapon-instance locals reset on death/respawn
    this.blockLists = {};      // weapon-instance lists reset on death/respawn
    if (this.blockBudget) this.blockBudget.reset();
  }

  /**
   * Try to initiate an attack based on weapon cooldown
   */
  canAttack(now) {
    if (this.isDead || this.stunTimeLeft > 0 || this.spearThrown || this.chakramOut || this.greatswordChargeStart > 0 || this.katanaChargeStart > 0 || this.daggerQte) return false;
    // Hammer skill: absolutely no basic attacks from cast until the last shockwave fires.
    if (now < (this.hammerSkillUntil || 0)) return false;
    // Magic staff: don't auto-cast again while ice shards are loaded (waiting for F).
    if (this.weapon === 'magicstaff' && this.pendingIcicles > 0) return false;
    const ignoresComboDelay = this.weapon === 'axe' && this.buffType === 'axe_rage';
    if (!ignoresComboDelay && now < (this.comboDelayUntil || 0)) return false;
    const weaponConfig = getEffectiveWeapon(this.weapon, this.buffType);
    if (weaponConfig.automaticAttack === false && !this.workshopWeapon) return false;
    // Workshop weapons fire on their own (clamped) cooldown floor.
    let cd = (this.workshopWeapon?.stats?.cooldownMs) || weaponConfig.cooldown;
    // 구르기 장전 (pistols LMB): +30% fire rate for a short window.
    if (this.weapon === 'pistols' && this.pistolReloadUntil && now < this.pistolReloadUntil) cd *= 0.7;
    return (now - this.lastAttackTime) >= cd;
  }

  triggerAttack(now) {
    this.lastAttackTime = now;
    this.swingDirection *= -1;
    return this.swingDirection;
  }

  // `ignoreIframe` lets damage-over-time (bleed/burn) keep ticking through dash
  // i-frames — i-frames only block NEW direct hits/status, not existing DoTs.
  takeDamage(amount, attackerName, ignoreIframe = false) {
    if (this.isDead || (!ignoreIframe && this.isInvincible())) return false;

    let dmg = amount;
    // 열기 방패 (flamethrower LMB): flat 30% damage reduction while active.
    if (this.heatShieldUntil && Date.now() < this.heatShieldUntil) dmg *= 0.7;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.isDead = true;
      return true; // Indicates player died in this damage hit
    }
    return false;
  }

  /**
   * Full serialization for sync transmission
   */
  serialize() {
    return {
      id: this.id,
      nickname: this.nickname,
      weapon: this.weapon,
      maxHp: this.maxHp,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      grounded: this.grounded,
      hp: this.hp,
      angle: this.angle,
      kills: this.kills,
      dummyKills: this.dummyKills || 0,
      deaths: this.deaths || 0,
      isDead: this.isDead,
      isDummy: this.isDummy,
      respawnRemainingMs: this.respawnRemainingMs || 0,
      iframeMs: Math.round(this.iframeTimeLeft * 1000),
      buffType: this.buffType,
      buffMs: Math.round(this.buffTimeLeft * 1000),
      skillCdMs: Math.round(this.skillCdLeft * 1000),
      dashCdMs: Math.round(this.dashCdLeft * 1000),
      stunMs: Math.round(this.stunTimeLeft * 1000),
      slowMs: Math.round((this.slowTimeLeft || 0) * 1000),
      bleedMs: Math.round((this.bleedTimeLeft || 0) * 1000),
      spearThrown: this.spearThrown,
      flameSpraying: this.flameSpraying,
      isMobile: this.isMobile,
      mobileAimAssist: this.mobileAimAssist,
      automaticAttack: this.automaticAttack,
      arrowStacks: this.arrowStacks || 0,
      greatswordChargeMs: this.greatswordChargeStart > 0 ? Math.max(0, Date.now() - this.greatswordChargeStart) : 0,
      katanaChargeMs: this.katanaChargeStart > 0 ? Math.max(0, Date.now() - this.katanaChargeStart) : 0,
      daggerQte: serializeDaggerQte(this.daggerQte),
      comboStep: this.comboStep || 0,
      comboDelayMs: Math.max(0, Math.round((this.comboDelayUntil || 0) - Date.now())),
      pendingIcicles: this.pendingIcicles || 0,
      magicCdMs: serializeMagicCooldowns(this.magicCooldowns),
      burnMs: Math.round((this.burnTimeLeft || 0) * 1000),
      teleportCdMs: Math.max(0, Math.round((this.teleportReadyAt || 0) - Date.now())),
      sniperTeleportTargetMs: Math.max(0, Math.round((this.sniperTeleportTargetUntil || 0) - Date.now())),
      altSkillCdMs: Math.round((this.altSkillCdLeft || 0) * 1000),
      targetSkillCdMs: Math.round((this.targetSkillCdLeft || 0) * 1000),
      orbitMs: Math.max(0, Math.round((this.chakramOrbitUntil || 0) - Date.now())),
      shieldMs: Math.max(0, Math.round((this.heatShieldUntil || 0) - Date.now())),
      stanceMs: Math.max(0, Math.round((this.guardianStanceUntil || 0) - Date.now())),
      color: this.color,
      accentColor: this.accentColor,
      costumeDecoration: this.costumeDecoration || null,
      costumeEffect: this.costumeEffect || null,
      msid: this.motionSetId || null,   // stickman motion-set loadout id (cosmetic; id only)
      look: this.stickLook || null,     // stick appearance blob (cosmetic; sanitized at render)
      wsw: this.workshopWeapon || null, // workshop weapon def (re-clamped on receive)
      cos: this.cosmeticsSnapshot()
    };
  }

  /**
   * Reconstitute client values from server package
   */
  deserialize(data) {
    this.nickname = data.nickname;
    this.weapon = data.weapon;
    this.maxHp = Number.isFinite(data.maxHp) ? data.maxHp : (Weapons[this.weapon]?.maxHp || this.maxHp || 100);
    this.hp = Number.isFinite(data.hp) ? Math.min(data.hp, this.maxHp) : this.maxHp;
    if (Number.isFinite(data.vx)) this.vx = data.vx;
    if (Number.isFinite(data.vy)) this.vy = data.vy;
    this.grounded = Boolean(data.grounded);
    this.kills = data.kills;
    this.dummyKills = data.dummyKills || 0;
    this.deaths = data.deaths || 0;
    this.isDead = data.isDead;
    this.isDummy = Boolean(data.isDummy);
    this.respawnRemainingMs = data.respawnRemainingMs || 0;
    this.iframeTimeLeft = (data.iframeMs || 0) / 1000;
    this.buffType = data.buffType || null;
    this.buffTimeLeft = (data.buffMs || 0) / 1000;
    this.skillCdLeft = (data.skillCdMs || 0) / 1000;
    this.dashCdLeft = (data.dashCdMs || 0) / 1000;
    this.stunTimeLeft = (data.stunMs || 0) / 1000;
    this.slowTimeLeft = (data.slowMs || 0) / 1000;
    this.bleedTimeLeft = (data.bleedMs || 0) / 1000;
    this.spearThrown = Boolean(data.spearThrown);
    this.isMobile = Boolean(data.isMobile);
    this.mobileAimAssist = data.mobileAimAssist === undefined ? true : Boolean(data.mobileAimAssist);
    this.automaticAttack = Boolean(data.automaticAttack);
    this.arrowStacks = Math.max(0, Math.floor(data.arrowStacks || 0));
    this.greatswordChargeStart = data.greatswordChargeMs > 0 ? Date.now() - data.greatswordChargeMs : 0;
    this.katanaChargeStart = data.katanaChargeMs > 0 ? Date.now() - data.katanaChargeMs : 0;
    this.magicCooldowns = deserializeMagicCooldowns(data.magicCdMs);
    this.teleportReadyAt = data.teleportCdMs > 0 ? Date.now() + data.teleportCdMs : 0;
    this.sniperTeleportTargetUntil = data.sniperTeleportTargetMs > 0 ? Date.now() + data.sniperTeleportTargetMs : 0;
    this.altSkillCdLeft = Math.max(0, (data.altSkillCdMs || 0) / 1000);
    this.targetSkillCdLeft = Math.max(0, (data.targetSkillCdMs || 0) / 1000);
    this.chakramOrbitUntil = data.orbitMs > 0 ? Date.now() + data.orbitMs : 0;
    this.heatShieldUntil = data.shieldMs > 0 ? Date.now() + data.shieldMs : 0;
    this.guardianStanceUntil = data.stanceMs > 0 ? Date.now() + data.stanceMs : 0;
    this.daggerQte = deserializeDaggerQte(data.daggerQte);
    this.comboStep = Math.max(0, Math.floor(data.comboStep || 0));
    this.comboDelayUntil = Date.now() + Math.max(0, Math.round(data.comboDelayMs || 0));
    this.color = data.color;
    this.accentColor = data.accentColor;
    this.costumeDecoration = data.costumeDecoration || null;
    this.costumeEffect = data.costumeEffect || null;
    this.motionSetId = (typeof data.msid === 'string') ? data.msid : null; // validated at render
    this.stickLook = (data.look && typeof data.look === 'object') ? data.look : null; // sanitized at render
    // Workshop weapon: re-clamp the received def through the envelope (never trust
    // a peer's raw blob — host authority + double clamp).
    if (data.wsw) this._applyWorkshopWeapon(data.wsw); else this.workshopWeapon = null;
    this.applyCosmeticsSnapshot(data.cos);

    // Coordinate smoothing can be applied in game loop,
    // but assign directly first
    this.x = data.x;
    this.y = data.y;
    this.angle = data.angle;
  }
}

function serializeDaggerQte(qte) {
  if (!qte) return null;
  const now = Date.now();
  return {
    targetId: qte.targetId,
    phase: qte.phase || 'lock',
    actionMs: Math.max(0, Math.round((qte.actionAt || now) - now)),
    perfectMs: Math.max(0, Math.round((qte.perfectAt || now) - now)),
    expiresMs: Math.max(0, Math.round((qte.expiresAt || now) - now))
  };
}

function deserializeDaggerQte(qte) {
  if (!qte) return null;
  const now = Date.now();
  return {
    targetId: qte.targetId,
    phase: qte.phase || 'lock',
    actionAt: now + Math.max(0, Math.round(qte.actionMs || 0)),
    perfectAt: now + Math.max(0, Math.round(qte.perfectMs || 0)),
    expiresAt: now + Math.max(0, Math.round(qte.expiresMs || 0))
  };
}

function serializeMagicCooldowns(cooldowns = {}) {
  return {
    fireball: Math.max(0, Math.round((cooldowns.fireball || 0) * 1000)),
    iceShard: Math.max(0, Math.round((cooldowns.iceShard || 0) * 1000)),
    lifebound: Math.max(0, Math.round((cooldowns.lifebound || 0) * 1000))
  };
}

function deserializeMagicCooldowns(cooldowns = {}) {
  return {
    fireball: Math.max(0, (cooldowns.fireball || 0) / 1000),
    iceShard: Math.max(0, (cooldowns.iceShard || 0) / 1000),
    lifebound: Math.max(0, (cooldowns.lifebound || 0) / 1000)
  };
}
