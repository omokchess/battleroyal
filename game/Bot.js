/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * AI bot brain (host-only). A bot is NOT a new entity type — it is a normal
 * Player flagged `isBot` whose movement keys + aim angle + one-shot actions are
 * synthesized here every host tick, exactly the way a human's input would be.
 * The existing player simulation (physics, weapons, status, sync) then runs
 * unchanged, so bots get platforming (jump/dash/pogo/grapple), weapon hit
 * resolution and netcode for free. Clients receive bots as ordinary players.
 *
 * The brain is a small finite-state machine with heuristic navigation — the
 * levels are a handful of platforms, so a full path-finder is overkill. It only
 * needs: chase the target, jump over walls / up to higher ground, drop through
 * one-ways to reach lower ground, and refuse to walk off the map or into the
 * rising hazard.
 */

// Per-difficulty knobs. Only reaction speed, aim accuracy, aggression, skill
// frequency and dodge tendency change — the underlying behaviour is shared.
export const BOT_DIFFICULTY = {
  easy: {
    decisionMs: [240, 380], // think interval (ms) — slower = more sluggish
    aimError: 0.40,         // max aim jitter (radians) added per decision
    aimEase: 0.10,          // how fast the aim slews toward the target
    aggro: 0.55,            // 0..1 chance to commit to chasing vs. drift
    skillChance: 0.22,      // chance to fire F/R when off cooldown & in range
    dashChance: 0.25,       // chance to dash to close/dodge on a dash window
    dodgeChance: 0.20,      // chance to dodge a nearby threat
    lead: 0.35,             // projectile lead factor (0=no lead, 1=full)
    retreatHp: 0.22,        // retreat when hp fraction drops below this
    reach: 0.92,            // melee engage distance multiplier
  },
  normal: {
    decisionMs: [150, 240],
    aimError: 0.17,
    aimEase: 0.20,
    aggro: 0.82,
    skillChance: 0.5,
    dashChance: 0.5,
    dodgeChance: 0.45,
    lead: 0.7,
    retreatHp: 0.28,
    reach: 1.0,
  },
  hard: {
    decisionMs: [90, 150],
    aimError: 0.055,
    aimEase: 0.34,
    aggro: 0.97,
    skillChance: 0.78,
    dashChance: 0.72,
    dodgeChance: 0.72,
    lead: 0.95,
    retreatHp: 0.32,
    reach: 1.08,
  },
};

// Rough projectile speeds (px/s) for aim lead. Melee weapons fall back to a
// large value (≈ instant) so lead collapses to ~0 for them.
const PROJ_SPEED = {};

const TAU = Math.PI * 2;
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}
function angLerp(from, to, t) {
  return from + angDiff(to, from) * Math.max(0, Math.min(1, t));
}

export class BotBrain {
  constructor(player, difficulty = 'normal', rng = Math.random) {
    this.player = player;
    // The simulation injects its seeded rng so a match replays identically on a
    // server (and in tests). Defaults to Math.random for standalone use.
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.difficulty = BOT_DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.cfg = BOT_DIFFICULTY[this.difficulty];

    this.targetId = null;
    this.state = 'wander';
    this.nextDecisionAt = 0;
    this.aimAngle = player.angle || 0;
    this.aimErr = 0;
    this.wanderDir = this.rng() < 0.5 ? -1 : 1;
    this.wanderUntil = 0;

    this.jumpHoldUntil = 0;   // keep the jump key held until this host-ms (variable height)
    this.jumpReadyAt = 0;     // don't re-press jump before this (avoid machine-gun hops)
    this.dropUntil = 0;       // hold "down" to fall through one-ways until this ms
    this.nextDashAt = 0;
    this.nextSkillAt = 0;
  }

  _rollDecision(now) {
    const [lo, hi] = this.cfg.decisionMs;
    this.nextDecisionAt = now + lo + this.rng() * (hi - lo);
    this.aimErr = (this.rng() * 2 - 1) * this.cfg.aimError;
  }

  /**
   * Produce this tick's input. Writes `player.keys` + `player.angle` and returns
   * one-shot intents the host executes via its normal action helpers:
   *   { dash: {dx,dy}|null, skill: bool, altSkill: bool }
   * `ctx` is supplied by Game._updateBots (see that method).
   */
  think(dt, now, ctx) {
    const p = this.player;
    const keys = {};
    const intents = { dash: null, skill: false, altSkill: false };
    if (p.isDead) { p.keys = keys; return intents; }

    if (now >= this.nextDecisionAt) this._rollDecision(now);

    const target = this._pickTarget(now, ctx);
    const footY = p.y + (p.halfH || 20);
    const hpFrac = p.hp / (p.maxHp || 100);
    const lowHp = hpFrac <= this.cfg.retreatHp;

    // ---- Desired horizontal heading -------------------------------------
    let dir = 0;               // -1 left, +1 right, 0 hold
    let wantClose = false;     // chasing a target (vs. wandering / fleeing)
    let dist = Infinity, dyToTarget = 0;

    if (target) {
      const dx = target.x - p.x;
      dyToTarget = target.y - p.y;
      dist = Math.hypot(dx, dyToTarget);
      const weapon = ctx.weaponOf(p);
      const reach = (Number.isFinite(weapon?.range) ? weapon.range : 240) * this.cfg.reach;
      const engage = Math.max(46, reach * 0.8);

      if (lowHp && this.cfg.aggro < 0.99) {
        // Flee: move away from the threat, look for a heal on the way.
        dir = dx >= 0 ? -1 : 1;
        const heal = this._nearestHeal(ctx);
        if (heal) dir = heal.x >= p.x ? 1 : -1;
        this.state = 'retreat';
      } else if (dist > engage) {
        dir = dx >= 0 ? 1 : -1;          // close in
        wantClose = true;
        this.state = 'chase';
      } else {
        // In range: hold ground (a little spacing jitter for ranged weapons).
        this.state = 'attack';
        if (Number.isFinite(weapon?.range) && weapon.range > 200) {
          if (dist < engage * 0.6) dir = dx >= 0 ? -1 : 1; // kite back
        } else if (dist > engage * 0.55) {
          dir = dx >= 0 ? 1 : -1;        // creep into melee
        }
      }
    } else {
      // No target: lazy patrol so idle bots still look alive.
      if (now >= this.wanderUntil) {
        this.wanderUntil = now + 600 + this.rng() * 900;
        this.wanderDir = this.rng() < 0.5 ? -1 : (this.rng() < 0.7 ? 1 : 0);
      }
      dir = this.wanderDir;
      this.state = 'wander';
    }

    // ---- Aim (360°, lead the target, with per-difficulty error) ---------
    if (target) {
      const aim = this._aimAt(target, ctx);
      this.aimAngle = angLerp(this.aimAngle, aim + this.aimErr, this.cfg.aimEase);
    } else {
      // face the way we walk so wandering bots don't stare at one wall
      const want = dir < 0 ? Math.PI : 0;
      this.aimAngle = angLerp(this.aimAngle, want, 0.08);
    }
    p.angle = this.aimAngle;

    // Pogo setup: airborne, target below & close → aim down so the auto-swing's
    // downward hit bounces us (handled in Game._tryPogo).
    if (target && !p.grounded && dyToTarget > 30 && dist < 120) {
      this.aimAngle = angLerp(this.aimAngle, Math.PI / 2, 0.5);
      p.angle = this.aimAngle;
    }

    // ---- Navigation: jumps, drops, edge & hazard avoidance --------------
    const nav = this._navigate(now, dir, footY, target, dyToTarget, ctx);
    dir = nav.dir;
    if (nav.jump) this._beginJump(now, nav.jumpStrength);
    if (nav.drop) this.dropUntil = now + 140;

    // Apply held jump (variable height) + drop windows.
    if (now < this.jumpHoldUntil) keys.w = true;
    if (now < this.dropUntil) keys.s = true;

    // ---- Movement keys ---------------------------------------------------
    if (dir < 0) keys.a = true;
    else if (dir > 0) keys.d = true;
    p.keys = keys;

    // ---- One-shot actions: dash + skills --------------------------------
    if (target && now >= this.nextDashAt) {
      this.nextDashAt = now + 520 + this.rng() * 700;
      const r = this.rng();
      if (lowHp && r < this.cfg.dodgeChance) {
        intents.dash = { dx: target.x >= p.x ? -1 : 1, dy: 0 }; // dash away
      } else if (dist > 240 && r < this.cfg.dashChance) {
        intents.dash = { dx: target.x >= p.x ? 1 : -1, dy: 0 }; // dash in
      } else if (r < this.cfg.dodgeChance * 0.5) {
        intents.dash = { dx: this.rng() < 0.5 ? -1 : 1, dy: 0 }; // juke
      }
    }

    if (target && now >= this.nextSkillAt && dist < 360 && !lowHp) {
      this.nextSkillAt = now + 700 + this.rng() * 1100;
      const r = this.rng();
      if (p.skillCdLeft <= 0 && r < this.cfg.skillChance) intents.skill = true;
      else if (p.altSkillCdLeft <= 0 && r < this.cfg.skillChance * 0.7) intents.altSkill = true;
    }

    return intents;
  }

  // --- Target selection ------------------------------------------------------
  _pickTarget(now, ctx) {
    const p = this.player;
    let cur = ctx.players[this.targetId];
    const valid = (o) => o && !o.isDead && o.id !== p.id && !o.isDummy;
    // Re-pick on a decision boundary or when the current target is gone.
    if (!valid(cur) || now >= this.nextDecisionAt - 1) {
      let best = null, bestScore = Infinity;
      const wantLowest = this.rng() < 0.3; // sometimes focus the weakest
      for (const id in ctx.players) {
        const o = ctx.players[id];
        if (!valid(o)) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        const score = wantLowest ? (o.hp * 4 + d) : d;
        if (score < bestScore) { bestScore = score; best = o; }
      }
      cur = best;
      this.targetId = best ? best.id : null;
    }
    return valid(cur) ? cur : null;
  }

  _nearestHeal(ctx) {
    const items = ctx.healingItems;
    if (!items || !items.length) return null;
    const p = this.player;
    let best = null, bestD = Infinity;
    for (const it of items) {
      const d = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  // --- Aim with projectile lead ---------------------------------------------
  _aimAt(target, ctx) {
    const p = this.player;
    const speed = PROJ_SPEED[p.weapon];
    let tx = target.x, ty = target.y;
    if (speed && this.cfg.lead > 0) {
      const d = Math.hypot(target.x - p.x, target.y - p.y);
      const tLead = (d / speed) * this.cfg.lead;
      tx += (target.vx || 0) * tLead;
      ty += (target.vy || 0) * tLead;
    }
    return Math.atan2(ty - p.y, tx - p.x);
  }

  // --- Navigation heuristics -------------------------------------------------
  _navigate(now, dir, footY, target, dyToTarget, ctx) {
    const p = this.player;
    const out = { dir, jump: false, drop: false, jumpStrength: 1 };
    const hw = p.halfW || 13;
    const probe = hw + 18;

    // 1) Hazard (rising lava + closing walls): never advance into it — and when
    //    the flood nears our footing, ABANDON the chase and climb: route to the
    //    nearest platform still above the lava, then jump for it. The old
    //    behaviour (hop in place once wading) drowned bots en masse whenever the
    //    ground level flooded with no platform directly overhead.
    if (ctx.zoneDamaging) {
      const floorY = ctx.zoneFloorY;
      if (footY >= floorY - 120) {                   // flood at/near our level → survival first
        const perch = ctx.nearestSafePerch ? ctx.nearestSafePerch(p.x, footY) : null;
        if (perch) {
          const dxPerch = perch.x - p.x;
          out.dir = Math.abs(dxPerch) > 24 ? (dxPerch > 0 ? 1 : -1) : 0;
          // Under (or close enough to) the perch → jump for it, scaled to height.
          if (Math.abs(dxPerch) < 90 && p.grounded && now >= this.jumpReadyAt) {
            out.jump = true;
            out.jumpStrength = Math.min(1, (footY - perch.y) / 220 + 0.45);
          }
        }
        if (footY >= floorY - 40 && now >= this.jumpReadyAt) out.jump = true; // already wading — hop NOW
      }
      const safe = ctx.zoneSafeX(p.x);               // {min,max} safe x band
      if (out.dir < 0 && p.x - probe <= safe.min) out.dir = 1;
      else if (out.dir > 0 && p.x + probe >= safe.max) out.dir = -1;
      dir = out.dir;                                 // later rules follow the survival heading
    }

    // 2) Map edge: don't walk off the left/right ends.
    if (dir < 0 && p.x - probe < 12) out.dir = 0;
    else if (dir > 0 && p.x + probe > ctx.mapWidth - 12) out.dir = 0;
    dir = out.dir;

    // 3) Wall ahead at body height → jump it.
    if (dir !== 0 && ctx.solidBlocks(p.x + dir * probe, p.y, 8)) {
      if (now >= this.jumpReadyAt) out.jump = true;
    }

    // 4) Ledge ahead: ground drops away. If chasing a target that is NOT far
    //    below, jump the gap; otherwise stop so we don't fall to our death.
    if (dir !== 0 && p.grounded) {
      const aheadX = p.x + dir * (probe + 10);
      const groundAheadY = ctx.surfaceBelow(aheadX, footY + 4);
      const dropDepth = groundAheadY - footY;
      const offMap = aheadX < 12 || aheadX > ctx.mapWidth - 12;
      if (offMap || dropDepth > 240) {
        if (target && dyToTarget < 120 && !offMap && now >= this.jumpReadyAt) {
          out.jump = true;                 // hop across toward an enemy on our level
        } else {
          out.dir = 0;                     // back off the cliff
        }
      }
    }

    // 5) Target above us → jump up toward it (variable height by gap).
    if (target && dyToTarget < -50 && now >= this.jumpReadyAt && p.grounded) {
      const horiz = Math.abs(target.x - p.x);
      if (horiz < 260) {
        out.jump = true;
        out.jumpStrength = Math.min(1, (-dyToTarget) / 220 + 0.3);
      }
    }

    // 6) Target well below & we stand on a one-way → drop through to chase.
    if (target && dyToTarget > 110 && p.grounded && ctx.onOneWayOnly(p.x, footY)) {
      out.drop = true;
    }

    return out;
  }

  _beginJump(now, strength = 1) {
    if (now < this.jumpReadyAt) return;
    const s = Math.max(0.35, Math.min(1, strength));
    // Hold the jump key proportional to desired height; ground-press edge in
    // Player.updatePosition fires the jump, the hold sustains it.
    this.jumpHoldUntil = now + 60 + s * 230;
    this.jumpReadyAt = now + 360;     // min gap between jumps
  }
}
