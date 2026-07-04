/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Weapon-gimmick block VM (Entry/Scratch-style visual scripting). A weapon can
 * carry a JSON AST of event handlers ("when basic-attack → spawn 3 projectiles…").
 * This module is the SANDBOXED interpreter + validator for that AST.
 *
 * SAFETY (section 0 of the spec — the whole point):
 *  - Pure-data AST run by THIS interpreter only. Never eval()/Function() — a
 *    malicious workshop blob can't execute arbitrary code.
 *  - Whitelisted ops only; unknown ops are dropped on sanitize. Every numeric
 *    OUTPUT (damage/radius/speed/count/status duration…) is envelope-clamped.
 *    Damage is never an absolute number — only "N% of the weapon's base damage",
 *    clamped to the balance envelope.
 *  - Resource limits (blocks / handlers / VM steps / spawns / loop / wait) halt
 *    runaway scripts (infinite loops, spawn bombs) instantly.
 *  - Deterministic: the host runs the logic and provides a seeded RNG + the API
 *    that spawns real entities; clients only receive/render the results.
 *
 * The API surface (ctx.api.*) is supplied by the host (Game.js) or a mock in
 * tests, so this file has ZERO game/DOM dependencies and is unit-testable.
 */

import { ENVELOPE } from './Workshop.js';

// Resource limits per trust tier. Workshop (user) is tighter than admin.
export const VM_LIMITS = {
  workshop: { maxBlocks: 80,  maxHandlers: 10, maxSteps: 2000, tickSteps: 300, maxSpawns: 16, maxLoop: 50,  maxWaitMs: 5000, maxVars: 8 },
  admin:    { maxBlocks: 160, maxHandlers: 16, maxSteps: 4000, tickSteps: 600, maxSpawns: 24, maxLoop: 100, maxWaitMs: 8000, maxVars: 16 },
};

// Whitelists — anything not here is dropped by sanitize / rejected at run.
export const EVENTS = new Set([
  'basicAttack', 'skillF', 'skillR', 'lmb', 'charging', 'chargeRelease',
  'onHit', 'onHurt', 'onKill', 'onJump', 'onLand', 'onRespawn', 'onTick',
  'projectileHit', 'placementTrigger',
  'onSignal',   // BlockVM 2.0 ③: custom broadcast channel
]);
const CONTROL_OPS = new Set(['if', 'repeat', 'repeatVar', 'while', 'wait', 'stop']);
const ACTION_OPS = new Set([
  'spawnMelee', 'spawnProjectile', 'spawnArea', 'applyStatus', 'knockback',
  'heal', 'dash', 'teleport', 'jump', 'pull', 'spawnPlacement',
  'particle', 'sfx', 'shake', 'cooldownGate', 'setVar', 'playMotion',
  // Entity-scoped actions (valid inside an `entities` script; the host supplies
  // the entity-acting api, so they are no-ops in the owner-script context).
  'setVelocity', 'homing', 'setGravity', 'setLifetime', 'removeSelf', 'split',
  // Custom-block call (BlockVM 2.0 ②): invoke a user-defined function.
  'callFunc',
  // Signals + lists (BlockVM 2.0 ③).
  'broadcast', 'listPush', 'listClear',
  // Self-movement / physics (BlockVM 2.0 ④) — velocity is move-budget clamped.
  'moveSelf', 'impulse',
]);
const VALUE_OPS = new Set([
  'add', 'sub', 'mul', 'div', 'mod', 'lt', 'le', 'eq', 'ge', 'gt', 'and', 'or', 'not',
  'min', 'max', 'clamp', 'abs', 'round', 'sin', 'cos', 'rand',
  'aimAngle', 'myHp', 'myMaxHp', 'myX', 'myY', 'mySpeed', 'grounded',
  'nearestDist', 'nearestDir', 'charge', 'combo', 'lastDamage', 'time', 'var',
  // Entity-scoped senses (the entity's own motion state).
  'myVx', 'myVy', 'myLife', 'bounces',
  // List reads (BlockVM 2.0 ③).
  'listGet', 'listLen',
]);
// Per-entity lifecycle events for the `entities` section (BlockVM 2.0 axis ①).
export const ENTITY_EVENTS = new Set(['onSpawn', 'onEntityTick', 'onEntityHit', 'onWallHit', 'onExpire']);
const STATUS_TYPES = new Set(['bleed', 'burn', 'slow', 'stun']);
// The fixed motion-tag vocabulary (모션 재생 block) — must match Workshop's motionSet slots.
const MOTION_TAG_KEYS = new Set(['attack', 'run', 'idle', 'jump', 'dash', 'skill', 'hurt', 'kill']);

const clampNum = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);

// ── AST validation / sanitize ──────────────────────────────────────────────
/**
 * Return a safe AST: unknown ops dropped, counts capped, structure normalized.
 * Never throws — garbage in → { events: [] } (a no-op program).
 */
export function sanitizeProgram(raw, tier = 'workshop') {
  const L = VM_LIMITS[tier] || VM_LIMITS.workshop;
  const out = { events: [] };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) return out;
  let blocks = 0;
  const budget = () => blocks < L.maxBlocks;

  const sanExpr = (e, depth) => {
    if (depth > 24) return 0;
    if (typeof e === 'number') return Number.isFinite(e) ? e : 0;
    if (typeof e === 'boolean') return e;
    if (typeof e === 'string') return String(e).slice(0, 32);
    if (!e || typeof e !== 'object' || !VALUE_OPS.has(e.op || (e.var !== undefined ? 'var' : ''))) return 0;
    if (e.var !== undefined) return { op: 'var', name: String(e.var || e.name || '').slice(0, 24) };
    if (e.op === 'listGet' || e.op === 'listLen') {
      const o = { op: e.op, list: String(e.list || '').slice(0, 24) };
      if (e.i !== undefined) o.i = sanExpr(e.i, depth + 1);
      return o;
    }
    const o = { op: e.op };
    for (const k of ['a', 'b', 'c', 'lo', 'hi', 'x']) if (e[k] !== undefined) o[k] = sanExpr(e[k], depth + 1);
    return o;
  };

  const sanStmts = (arr, depth) => {
    if (!Array.isArray(arr) || depth > 16) return [];
    const res = [];
    for (const s of arr) {
      if (!budget() || !s || typeof s !== 'object') break;
      const op = s.op;
      if (CONTROL_OPS.has(op)) {
        blocks++;
        if (op === 'stop') { res.push({ op: 'stop' }); }
        else if (op === 'wait') { res.push({ op: 'wait', ms: sanExpr(s.ms ?? s.seconds, 0) }); }
        else if (op === 'if') { res.push({ op: 'if', cond: sanExpr(s.cond, 0), then: sanStmts(s.then, depth + 1), else: sanStmts(s.else, depth + 1) }); }
        else if (op === 'repeat') { res.push({ op: 'repeat', count: sanExpr(s.count, 0), body: sanStmts(s.body, depth + 1) }); }
        else if (op === 'repeatVar') { res.push({ op: 'repeatVar', var: String(s.var || 'i').slice(0, 24), from: sanExpr(s.from, 0), to: sanExpr(s.to, 0), body: sanStmts(s.body, depth + 1) }); }
        else if (op === 'while') { res.push({ op: 'while', cond: sanExpr(s.cond, 0), body: sanStmts(s.body, depth + 1) }); }
      } else if (op === 'callFunc') {
        blocks++;
        res.push({ op: 'callFunc', name: String(s.name || '').slice(0, 24), args: Array.isArray(s.args) ? s.args.slice(0, 4).map(a => sanExpr(a, 0)) : [] });
      } else if (ACTION_OPS.has(op)) {
        blocks++;
        const a = { op };
        // Copy known params as sanitized exprs; the runtime clamps final numbers.
        for (const k of ['frontOffset', 'width', 'height', 'durFrames', 'damagePct', 'angle', 'speed', 'range', 'radius', 'cx', 'cy', 'force', 'distance', 'power', 'amountPct', 'ofLastDamagePct', 'durationMs', 'activateDelayMs', 'triggerRadius', 'max', 'seconds', 'value', 'level', 'turnDeg', 'count', 'spreadDeg', 'ms']) {
          if (s[k] !== undefined) a[k] = sanExpr(s[k], 0);
        }
        for (const k of ['status', 'tag', 'id', 'key', 'var', 'trigger', 'sig', 'list']) if (s[k] !== undefined) a[k] = String(s[k]).slice(0, 24);
        a.pierce = !!s.pierce; a.gravity = !!s.gravity;
        res.push(a);
      }
      // unknown op → dropped
    }
    return res;
  };

  for (const ev of raw.events.slice(0, L.maxHandlers)) {
    if (!budget()) break;
    if (!ev || !EVENTS.has(ev.on)) continue;
    out.events.push({ on: ev.on, tag: ev.tag ? String(ev.tag).slice(0, 24) : undefined, sig: ev.sig ? String(ev.sig).slice(0, 24) : undefined, do: sanStmts(ev.do, 0) });
  }

  // Entity scripts (BlockVM 2.0 axis ①): `entities: { <tag>: { events:[{on,do}] } }`.
  // A spawned projectile/placement tagged <tag> runs these lifecycle handlers on
  // the host, letting it steer/home/split itself — all output still budgeted.
  if (raw.entities && typeof raw.entities === 'object') {
    out.entities = {};
    let etags = 0;
    for (const tag of Object.keys(raw.entities)) {
      if (etags >= L.maxHandlers || !budget()) break;
      const spec = raw.entities[tag];
      if (!spec || !Array.isArray(spec.events)) continue;
      const evs = [];
      for (const ev of spec.events.slice(0, L.maxHandlers)) {
        if (!budget()) break;
        if (!ev || !ENTITY_EVENTS.has(ev.on)) continue;
        evs.push({ on: ev.on, do: sanStmts(ev.do, 0) });
      }
      if (evs.length) { out.entities[String(tag).slice(0, 24)] = { events: evs }; etags++; }
    }
  }

  // Custom blocks (BlockVM 2.0 ②): `funcs: { <name>: { params:[…], do:[…] } }`.
  // Reusable, parameterised routines. No true recursion — the VM's call-depth
  // cap halts self/mutual calls, so a runaway can't hang the sim.
  if (raw.funcs && typeof raw.funcs === 'object') {
    out.funcs = {};
    let fc = 0;
    for (const name of Object.keys(raw.funcs)) {
      if (fc >= L.maxHandlers || !budget()) break;
      const f = raw.funcs[name];
      if (!f || !Array.isArray(f.do)) continue;
      const params = Array.isArray(f.params) ? f.params.slice(0, 4).map(p => String(p).slice(0, 24)) : [];
      out.funcs[String(name).slice(0, 24)] = { params, do: sanStmts(f.do, 0) };
      fc++;
    }
  }
  return out;
}

/** Count total blocks in a (sanitized) program — for the editor's usage gauge. */
export function countBlocks(program) {
  let n = 0;
  const walk = (arr) => { for (const s of arr || []) { n++; if (s.then) walk(s.then); if (s.else) walk(s.else); if (s.body) walk(s.body); } };
  for (const ev of program?.events || []) walk(ev.do);
  for (const tag of Object.keys(program?.entities || {})) for (const ev of program.entities[tag].events || []) walk(ev.do);
  for (const nm of Object.keys(program?.funcs || {})) walk(program.funcs[nm].do);
  return n;
}

class Halt { constructor(reason) { this.reason = reason; } }

// ── The interpreter ────────────────────────────────────────────────────────
export class BlockVM {
  constructor(program, tier = 'workshop') {
    this.tier = VM_LIMITS[tier] ? tier : 'workshop';
    this.program = sanitizeProgram(program, this.tier);
    this.limits = VM_LIMITS[this.tier];
  }

  hasHandler(eventName) { return this.program.events.some(e => e.on === eventName); }

  /** Does entity `tag` define a handler for `eventName`? (host tick gate). */
  hasEntityHandler(tag, eventName) {
    const ent = this.program.entities && this.program.entities[tag];
    return !!(ent && ent.events.some(e => e.on === eventName));
  }

  /**
   * Run entity-script handlers for `eventName` on the spawned entity tagged
   * `tag`. Same ctx shape as run(); ctx.sense/api/vars are ENTITY-scoped (the
   * host binds them to the projectile/placement). Output stays host-budgeted.
   */
  runEntity(tag, eventName, ctx) {
    const ent = this.program.entities && this.program.entities[tag];
    if (!ent) return { steps: 0, halted: false };
    const isTick = eventName === 'onEntityTick';
    const stepMax = isTick ? this.limits.tickSteps : this.limits.maxSteps;
    const S = { steps: 0, stepMax, spawns: 0, spawnMax: this.limits.maxSpawns, halted: false };
    for (const ev of ent.events) {
      if (ev.on !== eventName) continue;
      try { this._execBlock(ev.do, ctx, S); }
      catch (e) { if (e instanceof Halt) S.halted = true; else S.halted = true; }
    }
    return { steps: S.steps, halted: S.halted };
  }

  /**
   * Run every handler for `eventName`. `ctx` (host-provided):
   *   { api, vars, rng()->[0,1), now, damageBase, sense:{...}, tagMatch }
   * Returns { steps, halted } (halted = hit a resource limit / stop).
   */
  run(eventName, ctx) {
    const isTick = eventName === 'onTick';
    const stepMax = isTick ? this.limits.tickSteps : this.limits.maxSteps;
    const S = { steps: 0, stepMax, spawns: 0, spawnMax: this.limits.maxSpawns, halted: false };
    for (const ev of this.program.events) {
      if (ev.on !== eventName) continue;
      if (eventName === 'projectileHit' || eventName === 'placementTrigger') {
        if (ev.tag && ctx.tag && ev.tag !== ctx.tag) continue;   // tag-filtered callbacks
      }
      try { this._execBlock(ev.do, ctx, S); }
      catch (e) { if (e instanceof Halt) { S.halted = true; } else { /* never let a bug crash the sim */ S.halted = true; } }
    }
    return { steps: S.steps, halted: S.halted };
  }

  _tick(S) { if (++S.steps > S.stepMax) throw new Halt('steps'); }

  _execBlock(stmts, ctx, S) {
    for (const s of stmts || []) this._execStmt(s, ctx, S);
  }

  _execStmt(s, ctx, S) {
    this._tick(S);
    switch (s.op) {
      case 'stop': throw new Halt('stop');
      case 'wait': /* cooperative wait is host-scheduled; here it is a no-op guard */ return;
      case 'if': {
        if (this._truthy(this._eval(s.cond, ctx, S))) this._execBlock(s.then, ctx, S);
        else this._execBlock(s.else, ctx, S);
        return;
      }
      case 'repeat': {
        const n = clampNum(Math.floor(this._num(s.count, ctx, S)), 0, this.limits.maxLoop);
        for (let i = 0; i < n; i++) { this._tick(S); this._execBlock(s.body, ctx, S); }
        return;
      }
      case 'repeatVar': {
        const from = Math.floor(this._num(s.from, ctx, S));
        const to = Math.floor(this._num(s.to, ctx, S));
        const span = clampNum(Math.abs(to - from) + 1, 0, this.limits.maxLoop);
        const dir = to >= from ? 1 : -1;
        for (let k = 0; k < span; k++) { this._tick(S); ctx.vars[s.var] = from + dir * k; this._execBlock(s.body, ctx, S); }
        return;
      }
      case 'while': {
        let guard = 0;
        while (this._truthy(this._eval(s.cond, ctx, S))) { this._tick(S); if (++guard > this.limits.maxLoop) throw new Halt('loop'); this._execBlock(s.body, ctx, S); }
        return;
      }
      default: this._execAction(s, ctx, S);
    }
  }

  // Actions → clamped params → host API. Damage is ALWAYS a % of the base.
  _execAction(s, ctx, S) {
    const api = ctx.api || {};
    const dmg = (pct) => clampNum((ctx.damageBase || 0) * clampNum(this._num(pct, ctx, S), 0, 300) / 100, 0, ENVELOPE.damage[1]);
    const spawnGuard = () => { if (S.spawns >= S.spawnMax) throw new Halt('spawns'); S.spawns++; };
    switch (s.op) {
      case 'spawnMelee': spawnGuard(); api.spawnMelee?.({
        frontOffset: clampNum(this._num(s.frontOffset, ctx, S), -ENVELOPE.hitboxOffsetMax ?? -220, 220),
        width: clampNum(this._num(s.width, ctx, S) || 50, 4, ENVELOPE.hitboxDimMax),
        height: clampNum(this._num(s.height, ctx, S) || 44, 4, ENVELOPE.hitboxDimMax),
        durFrames: clampNum(Math.floor(this._num(s.durFrames, ctx, S)) || 6, 1, 30),
        damage: dmg(s.damagePct ?? 100),
      }); return;
      case 'spawnProjectile': spawnGuard(); api.spawnProjectile?.({
        angle: this._num(s.angle, ctx, S),
        speed: clampNum(this._num(s.speed, ctx, S) || 500, 80, ENVELOPE.projectileSpeed[1]),
        range: clampNum(this._num(s.range, ctx, S) || 280, 20, ENVELOPE.range[1] * 1.2),
        pierce: !!s.pierce, gravity: !!s.gravity, tag: s.tag || '',
        damage: dmg(s.damagePct ?? 100),
      }); return;
      case 'spawnArea': spawnGuard(); api.spawnArea?.({
        cx: s.cx !== undefined ? this._num(s.cx, ctx, S) : undefined,
        cy: s.cy !== undefined ? this._num(s.cy, ctx, S) : undefined,
        radius: clampNum(this._num(s.radius, ctx, S) || 60, 8, 160),
        damage: dmg(s.damagePct ?? 100),
      }); return;
      case 'applyStatus': api.applyStatus?.({
        status: STATUS_TYPES.has(s.status) ? s.status : 'slow',
        durationMs: clampNum(this._num(s.durationMs, ctx, S) || 1000, 0, ENVELOPE.statusDurationMs[1]),
      }); return;
      case 'knockback': api.knockback?.({ force: clampNum(this._num(s.force, ctx, S), 0, ENVELOPE.knockback[1]), angle: s.angle !== undefined ? this._num(s.angle, ctx, S) : undefined }); return;
      case 'heal': api.heal?.({
        amountPct: s.amountPct !== undefined ? clampNum(this._num(s.amountPct, ctx, S), 0, 40) : 0,
        ofLastDamagePct: s.ofLastDamagePct !== undefined ? clampNum(this._num(s.ofLastDamagePct, ctx, S), 0, 60) : 0,
      }); return;
      case 'dash': api.dash?.({ angle: this._num(s.angle, ctx, S), distance: clampNum(this._num(s.distance, ctx, S) || 120, 0, 260) }); return;
      case 'teleport': api.teleport?.({ distance: clampNum(this._num(s.distance, ctx, S) || 120, 0, 220) }); return;
      case 'jump': api.jump?.({ power: clampNum(this._num(s.power, ctx, S) || 1, 0, 1.5) }); return;
      case 'pull': api.pull?.({ distance: clampNum(this._num(s.distance, ctx, S) || 120, 0, 300) }); return;
      case 'spawnPlacement': spawnGuard(); api.spawnPlacement?.({
        activateDelayMs: clampNum(this._num(s.activateDelayMs, ctx, S) || 500, 0, 4000),
        triggerRadius: clampNum(this._num(s.triggerRadius, ctx, S) || 60, 10, 160),
        tag: s.tag || '', max: clampNum(Math.floor(this._num(s.max, ctx, S)) || 3, 1, 6),
      }); return;
      case 'particle': api.particle?.(s.id || 'explosion'); return;
      case 'playMotion': api.playMotion?.({ tag: MOTION_TAG_KEYS.has(s.tag) ? s.tag : 'skill' }); return;
      case 'sfx': api.sfx?.(s.id || 'hit'); return;
      case 'shake': api.shake?.(String(s.level || 'weak')); return;
      case 'cooldownGate': api.cooldownGate?.({ key: s.key || 'g', seconds: clampNum(this._num(s.seconds, ctx, S), 0, 10) }); return;
      case 'setVar': {
        const name = String(s.var || '').slice(0, 24);
        if (name && Object.keys(ctx.vars).length < this.limits.maxVars) ctx.vars[name] = clampNum(this._num(s.value, ctx, S), -100000, 100000);
        return;
      }
      // ── entity-scoped actions (api present only in an entity script) ──
      case 'setVelocity': api.setVelocity?.({ angle: this._num(s.angle, ctx, S), speed: clampNum(this._num(s.speed, ctx, S) || 400, 0, ENVELOPE.projectileSpeed[1]) }); return;
      case 'homing': api.homing?.({ turnDeg: clampNum(this._num(s.turnDeg, ctx, S) || 160, 0, 720) }); return;
      case 'setGravity': api.setGravity?.({ value: clampNum(this._num(s.value, ctx, S), -1200, 2400) }); return;
      case 'setLifetime': api.setLifetime?.({ ms: clampNum(this._num(s.ms, ctx, S) || 1200, 50, 8000) }); return;
      case 'removeSelf': api.removeSelf?.(); return;
      case 'callFunc': this._callFunc(s, ctx, S); return;
      // ── signals + lists (BlockVM 2.0 ③) ──
      case 'moveSelf': api.moveSelf?.({ angle: this._num(s.angle, ctx, S), speed: clampNum(this._num(s.speed, ctx, S) || 300, 0, 900) }); return;
      case 'impulse': api.impulse?.({ angle: this._num(s.angle, ctx, S), force: clampNum(this._num(s.force, ctx, S) || 300, 0, 700) }); return;
      case 'broadcast': this._broadcast(s, ctx, S); return;
      case 'listPush': {
        const nm = String(s.list || '').slice(0, 24); if (!nm) return;
        const lists = ctx.lists || (ctx.lists = {});
        if (!lists[nm] && Object.keys(lists).length >= 6) return;   // cap distinct lists
        const L = lists[nm] || (lists[nm] = []);
        if (L.length < 32) L.push(clampNum(this._num(s.value, ctx, S), -1e6, 1e6));
        return;
      }
      case 'listClear': { const nm = String(s.list || '').slice(0, 24); if (ctx.lists && ctx.lists[nm]) ctx.lists[nm].length = 0; return; }
      case 'split': spawnGuard(); api.split?.({
        count: clampNum(Math.floor(this._num(s.count, ctx, S)) || 2, 1, 8),
        spreadDeg: clampNum(this._num(s.spreadDeg, ctx, S) || 30, 0, 180),
        speed: clampNum(this._num(s.speed, ctx, S) || 380, 80, ENVELOPE.projectileSpeed[1]),
        damage: dmg(s.damagePct ?? 60), tag: s.tag || '',
      }); return;
    }
  }

  /** Invoke a user-defined function: bind params as locals, run its body, then
   *  restore. Call depth is capped (no real recursion) so it can never hang. */
  _callFunc(s, ctx, S) {
    const f = this.program.funcs && this.program.funcs[s.name];
    if (!f) return;
    if ((S.callDepth || 0) >= 8) throw new Halt('callDepth');
    const names = f.params || [], argv = s.args || [], saved = {};
    for (let i = 0; i < names.length; i++) { const nm = names[i]; saved[nm] = ctx.vars[nm]; ctx.vars[nm] = this._num(argv[i], ctx, S); }
    S.callDepth = (S.callDepth || 0) + 1;
    try { this._execBlock(f.do, ctx, S); }
    finally { S.callDepth--; for (const nm of names) { if (saved[nm] === undefined) delete ctx.vars[nm]; else ctx.vars[nm] = saved[nm]; } }
  }

  /** Broadcast a signal → run matching onSignal handlers now, depth-bounded so
   *  a signal storm (A→B→A…) can't recurse forever. */
  _broadcast(s, ctx, S) {
    if ((S.sigDepth || 0) >= 4) return;
    S.sigDepth = (S.sigDepth || 0) + 1;
    try {
      for (const ev of this.program.events) {
        if (ev.on === 'onSignal' && (!ev.sig || !s.sig || ev.sig === s.sig)) this._execBlock(ev.do, ctx, S);
      }
    } finally { S.sigDepth--; }
  }

  // ── value expressions (pure) ──
  _num(e, ctx, S) { const v = this._eval(e, ctx, S); return typeof v === 'number' ? v : (v ? 1 : 0); }
  _truthy(v) { return typeof v === 'number' ? v !== 0 : !!v; }

  _eval(e, ctx, S) {
    if (typeof e === 'number' || typeof e === 'boolean') return e;
    if (typeof e === 'string') return e;
    if (!e || typeof e !== 'object') return 0;
    this._tick(S);
    const A = () => this._eval(e.a, ctx, S), B = () => this._eval(e.b, ctx, S);
    const sn = ctx.sense || {};
    switch (e.op) {
      case 'var': return Number.isFinite(ctx.vars[e.name]) ? ctx.vars[e.name] : 0;
      case 'add': return this._n(A()) + this._n(B()); case 'sub': return this._n(A()) - this._n(B());
      case 'mul': return this._n(A()) * this._n(B()); case 'div': { const b = this._n(B()); return b === 0 ? 0 : this._n(A()) / b; }
      case 'mod': { const b = this._n(B()); return b === 0 ? 0 : this._n(A()) % b; }
      case 'lt': return this._n(A()) < this._n(B()); case 'le': return this._n(A()) <= this._n(B());
      case 'eq': return this._n(A()) === this._n(B()); case 'ge': return this._n(A()) >= this._n(B()); case 'gt': return this._n(A()) > this._n(B());
      case 'and': return this._truthy(A()) && this._truthy(B()); case 'or': return this._truthy(A()) || this._truthy(B()); case 'not': return !this._truthy(A());
      case 'min': return Math.min(this._n(A()), this._n(B())); case 'max': return Math.max(this._n(A()), this._n(B()));
      case 'clamp': return clampNum(this._n(A()), this._n(this._eval(e.lo, ctx, S)), this._n(this._eval(e.hi, ctx, S)));
      case 'abs': return Math.abs(this._n(A())); case 'round': return Math.round(this._n(A()));
      case 'sin': return Math.sin(this._n(A()) * Math.PI / 180); case 'cos': return Math.cos(this._n(A()) * Math.PI / 180);
      case 'rand': { const lo = this._n(A()), hi = this._n(B()); return lo + (ctx.rng ? ctx.rng() : Math.random()) * (hi - lo); }
      case 'aimAngle': return sn.aimAngle || 0;
      case 'myHp': return sn.hp || 0; case 'myMaxHp': return sn.maxHp || 0;
      case 'myX': return sn.x || 0; case 'myY': return sn.y || 0; case 'mySpeed': return sn.speed || 0;
      case 'grounded': return !!sn.grounded;
      case 'nearestDist': return Number.isFinite(sn.nearestDist) ? sn.nearestDist : 99999;
      case 'nearestDir': return sn.nearestDir || 0;
      case 'myVx': return sn.vx || 0; case 'myVy': return sn.vy || 0;
      case 'myLife': return sn.life || 0; case 'bounces': return sn.bounces || 0;
      case 'listGet': { const L = (ctx.lists || {})[e.list]; if (!Array.isArray(L)) return 0; const i = Math.floor(this._n(this._eval(e.i, ctx, S))); return Number.isFinite(L[i]) ? L[i] : 0; }
      case 'listLen': { const L = (ctx.lists || {})[e.list]; return Array.isArray(L) ? L.length : 0; }
      case 'charge': return Number.isFinite(ctx.vars.charge) ? ctx.vars.charge : 0;
      case 'combo': return sn.combo || 0; case 'lastDamage': return sn.lastDamage || 0; case 'time': return sn.time || 0;
      default: return 0;
    }
  }
  _n(v) { return typeof v === 'number' ? v : (v ? 1 : 0); }
}
