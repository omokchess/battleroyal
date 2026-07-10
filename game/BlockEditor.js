/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Weapon-gimmick block editor — Entry/Scratch-style drag-snap, modeled on
 * 13_block_editor_demo.html: a flow-layout stack of DOM blocks with an insertion
 * indicator, C-block inner dropzones, palette drag-to-insert / click-to-append,
 * reporter (pill) + boolean (hex) blocks that nest into value slots, and
 * live AST serialization.
 *
 * SCHEMA NOTE: BlockVM.js is frozen (sandbox interpreter, resource limits,
 * envelope). We keep ITS AST — statement = { op, ...flatArgs, then/else/body },
 * value/boolean expr = { op, a, b, ... } — so existing saved weapons round-trip
 * and the host VM is unchanged. (The demo groups args under `args:{}`; here they
 * sit flat on the stmt, which is what BlockVM reads.) A dropped reporter/boolean
 * becomes the slot's value-expr; a plain slot is a number/string literal.
 *
 * Drag uses HTML5 DnD (like the demo) for desktop; touch keeps the demo's
 * click-to-append + a tap ✕ delete as the accessible fallback (spec §6).
 */

import { BlockVM, VM_LIMITS, countBlocks, EVENTS } from './BlockVM.js';
import { estimateBudget } from './BlockBudget.js';
import { Sound } from './Sound.js';

const C = { ev: '#c9a227', act: '#3a6ea5', ctl: '#c96f27', val: '#3a8f7a', op: '#5a8f3c', vr: '#b32d2d' };
const CATN = { ev: '이벤트', act: '동작', ctl: '제어', val: '값', op: '연산', vr: '변수' };

// s = string token; or { a:key, t:type, d:default, o:[opts] }
const s = (a, t, d, o) => ({ a, t, d, o });
const DEFS = {
  // ── events (hat) — op maps to BlockVM EVENTS. scope 'main' = weapon context. ──
  basicAttack: { cat: 'ev', hat: 1, scope: 'main', op: 'basicAttack', parts: ['평타 시'] },
  skillF: { cat: 'ev', hat: 1, scope: 'main', op: 'skillF', parts: ['F스킬 시'] },
  onHit: { cat: 'ev', hat: 1, scope: 'main', op: 'onHit', parts: ['명중 시'] },
  onKill: { cat: 'ev', hat: 1, scope: 'main', op: 'onKill', parts: ['처치 시'] },
  onTick: { cat: 'ev', hat: 1, scope: 'main', op: 'onTick', parts: ['매 틱'] },
  projectileHit: { cat: 'ev', hat: 1, scope: 'main', op: 'projectileHit', parts: ['투사체', s('tag', 'text', ''), '명중 시'] },
  onSignal: { cat: 'ev', hat: 1, scope: 'main', op: 'onSignal', parts: ['신호', s('sig', 'text', 'boom'), '받을 때'] },
  // ── entity lifecycle events (hat, scope 'entity') ──
  onSpawn: { cat: 'ev', hat: 1, scope: 'entity', op: 'onSpawn', parts: ['생성 시'] },
  onEntityTick: { cat: 'ev', hat: 1, scope: 'entity', op: 'onEntityTick', parts: ['엔티티 매 틱'] },
  onEntityHit: { cat: 'ev', hat: 1, scope: 'entity', op: 'onEntityHit', parts: ['엔티티 적중 시'] },
  onWallHit: { cat: 'ev', hat: 1, scope: 'entity', op: 'onWallHit', parts: ['벽 충돌 시'] },
  onExpire: { cat: 'ev', hat: 1, scope: 'entity', op: 'onExpire', parts: ['소멸 시'] },
  // ── actions ──
  spawnProjectile: { cat: 'act', op: 'spawnProjectile', parts: ['투사체 발사 방향', s('dir', 'sel', 'angle', ['angle|고정각도', 'cursor|커서', 'facing|바라보는쪽']), '각도', s('angle', 'num', 0), '속도', s('speed', 'num', 520), '사거리', s('range', 'num', 280), '대미지', s('damagePct', 'num', 90), '% 태그', s('tag', 'text', ''), '관통', s('pierce', 'check', false)] },
  spawnMelee: { cat: 'act', op: 'spawnMelee', parts: ['근접 판정 앞', s('frontOffset', 'num', 60), '폭', s('width', 'num', 50), '높이', s('height', 'num', 44), '대미지', s('damagePct', 'num', 100), '%'] },
  spawnArea: { cat: 'act', op: 'spawnArea', parts: ['범위 판정 반경', s('radius', 'num', 60), '대미지', s('damagePct', 'num', 70), '%'] },
  applyStatus: { cat: 'act', op: 'applyStatus', parts: ['상태이상', s('status', 'sel', 'burn', ['bleed', 'burn', 'slow', 'stun']), '지속', s('durationMs', 'num', 1000), 'ms'] },
  heal: { cat: 'act', op: 'heal', parts: ['회복 마지막 피해의', s('ofLastDamagePct', 'num', 20), '%'] },
  knockback: { cat: 'act', op: 'knockback', parts: ['넉백 힘', s('force', 'num', 80)] },
  dash: { cat: 'act', op: 'dash', parts: ['대시 각도', s('angle', 'num', 0), '거리', s('distance', 'num', 120)] },
  teleport: { cat: 'act', op: 'teleport', parts: ['텔레포트 거리', s('distance', 'num', 120)] },
  jump: { cat: 'act', op: 'jump', parts: ['점프 세기', s('power', 'num', 1)] },
  pull: { cat: 'act', op: 'pull', parts: ['끌어오기 거리', s('distance', 'num', 120)] },
  moveSelf: { cat: 'act', op: 'moveSelf', parts: ['내 속도 각도', s('angle', 'num', -90), '속도', s('speed', 'num', 400)] },
  impulse: { cat: 'act', op: 'impulse', parts: ['추진 각도', s('angle', 'num', -90), '힘', s('force', 'num', 300)] },
  broadcast: { cat: 'act', op: 'broadcast', parts: ['신호 보내기', s('sig', 'text', 'boom')] },
  listPush: { cat: 'act', op: 'listPush', parts: ['리스트', s('list', 'text', 'marks'), '에', s('value', 'num', 0), '추가'] },
  listClear: { cat: 'act', op: 'listClear', parts: ['리스트', s('list', 'text', 'marks'), '비우기'] },
  particle: { cat: 'act', op: 'particle', parts: ['파티클', s('id', 'sel', 'explosion', ['explosion', 'danger_pop'])] },
  sfx: { cat: 'act', op: 'sfx', parts: ['사운드', s('id', 'sel', 'shoot', ['shoot', 'hit', 'slash', 'slam', 'explosion'])] },
  shake: { cat: 'act', op: 'shake', parts: ['화면 흔들림', s('level', 'sel', 'weak', ['weak', 'strong'])] },
  playMotion: { cat: 'act', op: 'playMotion', parts: ['모션 재생', s('tag', 'sel', 'skill', ['attack|공격', 'run|걷기', 'idle|대기', 'jump|점프', 'dash|대시', 'skill|스킬', 'hurt|피격', 'kill|처치'])] },
  // ── entity-scoped actions (scope 'entity') ──
  setVelocity: { cat: 'act', scope: 'entity', op: 'setVelocity', parts: ['속도 설정 각도', s('angle', 'num', 0), '속도', s('speed', 'num', 400)] },
  homing: { cat: 'act', scope: 'entity', op: 'homing', parts: ['유도 회전', s('turnDeg', 'num', 200), '°/s'] },
  setGravity: { cat: 'act', scope: 'entity', op: 'setGravity', parts: ['중력', s('value', 'num', 900)] },
  setLifetime: { cat: 'act', scope: 'entity', op: 'setLifetime', parts: ['수명', s('ms', 'num', 1200), 'ms'] },
  removeSelf: { cat: 'act', scope: 'entity', op: 'removeSelf', parts: ['자신 제거'] },
  split: { cat: 'act', scope: 'entity', op: 'split', parts: ['분열', s('count', 'num', 4), '개 퍼짐', s('spreadDeg', 'num', 60), '° 속도', s('speed', 'num', 300), '대미지', s('damagePct', 'num', 40), '% 태그', s('tag', 'text', '')] },
  // ── control (C-blocks) ──
  if: { cat: 'ctl', c: 1, op: 'if', parts: ['만약', s('cond', 'bool')], containers: ['then', 'else'] },
  repeat: { cat: 'ctl', c: 1, op: 'repeat', parts: [s('count', 'num', 3), '번 반복'], containers: ['body'] },
  repeatVar: { cat: 'ctl', c: 1, op: 'repeatVar', parts: [s('var', 'text', 'i'), '를', s('from', 'num', -1), '부터', s('to', 'num', 1), '까지'], containers: ['body'] },
  wait: { cat: 'ctl', op: 'wait', parts: ['대기', s('ms', 'num', 200), 'ms'] },
  stop: { cat: 'ctl', op: 'stop', parts: ['정지'] },
  // ── values (reporters, pill) ──
  aimAngle: { cat: 'val', rep: 1, op: 'aimAngle', parts: ['조준각'] },
  nearestDist: { cat: 'val', rep: 1, op: 'nearestDist', parts: ['가까운 적 거리'] },
  myHp: { cat: 'val', rep: 1, op: 'myHp', parts: ['내 HP'] },
  charge: { cat: 'val', rep: 1, op: 'charge', parts: ['충전량'] },
  combo: { cat: 'val', rep: 1, op: 'combo', parts: ['콤보'] },
  lastDamage: { cat: 'val', rep: 1, op: 'lastDamage', parts: ['마지막 피해'] },
  rand: { cat: 'val', rep: 1, op: 'rand', parts: ['난수', s('a', 'num', 1), '~', s('b', 'num', 10)] },
  listGet: { cat: 'val', rep: 1, op: 'listGet', parts: ['리스트', s('list', 'text', 'marks'), s('i', 'num', 0), '번째'] },
  listLen: { cat: 'val', rep: 1, op: 'listLen', parts: ['리스트', s('list', 'text', 'marks'), '길이'] },
  // ── entity-scoped senses (scope 'entity') ──
  myVx: { cat: 'val', rep: 1, scope: 'entity', op: 'myVx', parts: ['내 X속도'] },
  myVy: { cat: 'val', rep: 1, scope: 'entity', op: 'myVy', parts: ['내 Y속도'] },
  myLife: { cat: 'val', rep: 1, scope: 'entity', op: 'myLife', parts: ['생존 시간'] },
  bounces: { cat: 'val', rep: 1, scope: 'entity', op: 'bounces', parts: ['튕긴 횟수'] },
  // ── operators (reporters + booleans) ──
  add: { cat: 'op', rep: 1, op: 'add', parts: [s('a', 'num', 0), '+', s('b', 'num', 12)] },
  sub: { cat: 'op', rep: 1, op: 'sub', parts: [s('a', 'num', 0), '−', s('b', 'num', 0)] },
  mul: { cat: 'op', rep: 1, op: 'mul', parts: [s('a', 'num', 1), '×', s('b', 'num', 2)] },
  div: { cat: 'op', rep: 1, op: 'div', parts: [s('a', 'num', 1), '÷', s('b', 'num', 2)] },
  lt: { cat: 'op', bool: 1, op: 'lt', parts: [s('a', 'num', 0), '<', s('b', 'num', 90)] },
  gt: { cat: 'op', bool: 1, op: 'gt', parts: [s('a', 'num', 0), '>', s('b', 'num', 0)] },
  ge: { cat: 'op', bool: 1, op: 'ge', parts: [s('a', 'num', 0), '≥', s('b', 'num', 0)] },
  le: { cat: 'op', bool: 1, op: 'le', parts: [s('a', 'num', 0), '≤', s('b', 'num', 0)] },
  eq: { cat: 'op', bool: 1, op: 'eq', parts: [s('a', 'num', 0), '=', s('b', 'num', 0)] },
  and: { cat: 'op', bool: 1, op: 'and', parts: [s('a', 'bool'), '그리고', s('b', 'bool')] },
  or: { cat: 'op', bool: 1, op: 'or', parts: [s('a', 'bool'), '또는', s('b', 'bool')] },
  // ── variables ──
  setVar: { cat: 'vr', op: 'setVar', parts: ['변수', s('var', 'text', 'charge'), '=', s('value', 'num', 0)] },
};
// op → def id (for import).
const OP2ID = {}; for (const id in DEFS) OP2ID[DEFS[id].op] = id;

// Which weapon EVENT hats each preset may use (평타 프리셋엔 F스킬 이벤트 숨김 등).
// Reaction events (onHit/onKill/onTick/projectileHit/onSignal) are shared.
const SHARED_EVENTS = ['onHit', 'onKill', 'onTick', 'projectileHit', 'onSignal'];
const PRESET_EVENTS = {
  basic: ['basicAttack', ...SHARED_EVENTS], heavy: ['basicAttack', ...SHARED_EVENTS],
  skill1: ['skillF', ...SHARED_EVENTS], skill2: ['skillR', ...SHARED_EVENTS], skill3: ['skillF', 'skillR', ...SHARED_EVENTS],
  dash: ['onTick', 'onSignal'],
};

function ensureStyles() {
  if (document.getElementById('beStyles')) return;
  const st = document.createElement('style'); st.id = 'beStyles';
  st.textContent = `
  #beWorkspace .stack{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
  .be-blk{position:relative;border-radius:5px;padding:5px 10px 6px;color:#fff;font-size:11px;width:fit-content;max-width:100%;box-shadow:0 1px 0 rgba(0,0,0,.3);cursor:grab;line-height:1.9;font-family:system-ui,sans-serif}
  .be-blk::after{content:'';position:absolute;left:12px;bottom:-4px;width:16px;height:5px;background:inherit;border-radius:0 0 4px 4px}
  .be-hat{border-radius:16px 16px 5px 5px;font-weight:500}
  .be-rep{border-radius:999px;padding:2px 9px;display:inline-flex;vertical-align:middle}
  .be-rep::after{display:none}
  .be-bool{clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 50%,calc(100% - 8px) 100%,8px 100%,0 50%);padding:2px 13px;display:inline-flex;vertical-align:middle}
  .be-bool::after{display:none}
  .be-sl{width:42px;background:#fff;border:none;border-radius:999px;padding:2px 6px;font-size:11px;color:#1a1a1a;text-align:center;margin:0 2px}
  select.be-sl{width:auto}
  .be-slot{display:inline-flex;align-items:center;min-height:18px;margin:0 2px}
  .be-bslot{display:inline-flex;align-items:center;min-width:34px;min-height:16px;margin:0 3px;background:rgba(0,0,0,.28);border-radius:0;clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 50%,calc(100% - 8px) 100%,8px 100%,0 50%);padding:0 8px}
  .be-cwrap{width:fit-content}
  .be-cinner{margin-left:14px;border-left:14px solid;padding:3px 0 3px 5px;display:flex;flex-direction:column;gap:2px;min-height:16px;min-width:130px;border-radius:0 0 0 4px}
  .be-cfoot{height:11px;width:90px;border-radius:0 0 5px 5px;position:relative}
  .be-cfoot::after{content:'';position:absolute;left:12px;bottom:-4px;width:16px;height:5px;background:inherit;border-radius:0 0 4px 4px}
  .be-del{position:absolute;top:-6px;right:-6px;width:15px;height:15px;line-height:13px;text-align:center;background:#241710;color:#e8d5a3;border:1px solid #6b4a2b;border-radius:50%;font-size:10px;cursor:pointer;display:none;z-index:3}
  .be-blk:hover>.be-del{display:block}
  .be-ind{height:3px;background:#ffd75e;border-radius:2px;width:150px;margin:1px 0;flex:none}
  .be-orphan{opacity:.5}
  .be-orphan-badge{font-size:8px;color:#ff9e9e;margin-left:4px}
  .be-shake{animation:beShake .28s}
  @keyframes beShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
  #bePalette .be-blk{cursor:pointer;margin-bottom:6px}
  .be-blk{touch-action:pan-y;user-select:none;-webkit-user-select:none}
  /* snap ghost — a translucent silhouette of what will be inserted */
  .be-ghost{opacity:.4;pointer-events:none;filter:saturate(.8)}
  .be-ghost>*{pointer-events:none!important}
  /* the block(s) picked up and following the cursor */
  .be-floating{position:fixed;left:0;top:0;z-index:200;pointer-events:none;opacity:.9;transform:rotate(2.5deg);filter:drop-shadow(0 7px 10px rgba(0,0,0,.55))}
  .be-floating .stack,.be-floating>*{align-items:flex-start}
  .be-drag-src{opacity:.45}
  /* value-slot drop feedback */
  .be-slot-hot{outline:2px solid #ffe08a;outline-offset:1px;background:rgba(255,224,138,.28)!important;transform:scale(1.15);transition:transform .1s}
  .be-slot-bad{animation:beShake .2s}
  /* trash affordance (over palette) */
  #bePalette.be-trash-hot{outline:2px dashed #ff7a7a;outline-offset:-3px;background:rgba(255,90,90,.08)}
  .be-flip{transition:transform .16s ease}
  @keyframes bePop{0%{transform:scale(1.05)}100%{transform:scale(1)}}
  .be-pop{animation:bePop .16s ease-out}
  @media (prefers-reduced-motion: reduce){ .be-flip{transition:none!important} .be-pop{animation:none!important} }`;
  document.head.appendChild(st);
}

const numOr = (v) => { const n = Number(v); return isNaN(n) ? v : n; };

export class BlockEditor {
  constructor() {
    this.root = document.getElementById('blockEditor');
    if (!this.root) return;
    ensureStyles();
    this.ws = document.getElementById('beWorkspace');
    this.cat = 'ev'; this.tier = 'workshop'; this.onSave = null;
    this.ind = document.createElement('div'); this.ind.className = 'be-ind';
    document.getElementById('beClose')?.addEventListener('click', () => this.close());
    document.getElementById('beSave')?.addEventListener('click', () => { this.onSave?.(this.buildAST()); this._status('저장됨. 무기 저장 시 함께 적용됩니다.'); });
    document.getElementById('beTest')?.addEventListener('click', () => this._test());
    // Category tabs live in the top tab row.
    const tabs = document.getElementById('beEventTabs');
    if (tabs) { tabs.innerHTML = ''; for (const k in CATN) { const t = document.createElement('button'); t.className = 'med-btn text-[10px] px-2 py-1'; t.dataset.cat = k; t.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${C[k]};margin-right:3px"></span>${CATN[k]}`; t.addEventListener('click', () => { this.cat = k; this._renderPalette(); this._syncTabs(); }); tabs.appendChild(t); } }
  }

  open(ast, tier = 'workshop', onSave = null, stats = null, presetKey = null) {
    if (!this.root) return;
    this.tier = VM_LIMITS[tier] ? tier : 'workshop';
    this.onSave = onSave;
    this.stats = stats || { damage: 18, cooldownMs: 600 };
    this.presetKey = presetKey;   // scope the event palette to this preset (or null = all)
    document.getElementById('beBlockMax').textContent = VM_LIMITS[this.tier].maxBlocks;
    this.stack = this.ws.querySelector('.stack');
    if (!this.stack) { this.stack = document.createElement('div'); this.stack.className = 'stack'; this.ws.innerHTML = ''; this.ws.appendChild(this.stack); this._dz(this.stack); }
    // Multi-context model: the weapon's main events + per-entity scripts + funcs.
    this.model = this._parseModel(ast);
    this.ctxKind = 'main'; this.ctxName = '';
    this._renderCtxBar();
    this._loadCtx();
    this._renderPalette(); this._syncTabs();
    this.root.classList.remove('hidden');
  }
  close() { this.root?.classList.add('hidden'); }

  _parseModel(ast) {
    const m = { events: [], entities: {}, funcs: {} };
    if (ast && Array.isArray(ast.events)) m.events = ast.events;
    if (ast && ast.entities) for (const k in ast.entities) m.entities[k] = { events: Array.isArray(ast.entities[k].events) ? ast.entities[k].events : [] };
    if (ast && ast.funcs && typeof ast.funcs === 'object') m.funcs = ast.funcs;   // AST-only for now, preserved verbatim
    return m;
  }

  // ── context (weapon / entity script) switching ──
  _renderCtxBar() {
    let bar = document.getElementById('beCtxBar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'beCtxBar';
      bar.style.cssText = 'display:flex;gap:4px;align-items:center;padding:4px 8px;border-bottom:1px solid #333;overflow-x:auto;flex:none;background:#0f0b07';
      // Insert the context bar just above the palette/workspace row (a direct
      // child of the editor root, so insertBefore is valid).
      const row = this.ws.parentElement;
      this.root.insertBefore(bar, row);
    }
    bar.innerHTML = '';
    const mkTab = (label, kind, name, active) => { const b = document.createElement('button'); b.textContent = label; b.className = 'med-btn text-[10px] px-2 py-0.5' + (active ? ' on' : ''); b.onclick = () => this._switchCtx(kind, name); return b; };
    bar.appendChild(mkTab('⚔ 무기', 'main', '', this.ctxKind === 'main'));
    for (const k of Object.keys(this.model.entities)) {
      const wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-flex;align-items:center;flex:none';
      wrap.appendChild(mkTab('🎯 ' + k, 'entity', k, this.ctxKind === 'entity' && this.ctxName === k));
      const del = document.createElement('button'); del.textContent = '×'; del.className = 'text-[10px] px-1 text-gray-500 hover:text-red-400 cursor-pointer'; del.title = '엔티티 삭제';
      del.onclick = (e) => { e.stopPropagation(); this._deleteEntity(k); }; wrap.appendChild(del);
      bar.appendChild(wrap);
    }
    const add = document.createElement('button'); add.textContent = '＋ 엔티티'; add.className = 'med-btn text-[10px] px-2 py-0.5'; add.title = '투사체/설치물의 자기 스크립트 추가';
    add.onclick = () => this._addEntity(); bar.appendChild(add);
  }
  _addEntity() {
    const name = String(window.prompt('엔티티(투사체) 태그 — 발사 블록의 태그와 일치시키세요:', 'missile') || '').trim().slice(0, 24);
    if (!name) return;
    if (!this.model.entities[name]) this.model.entities[name] = { events: [] };
    this._switchCtx('entity', name);
  }
  _deleteEntity(k) {
    this._saveCtx(); delete this.model.entities[k];
    if (this.ctxKind === 'entity' && this.ctxName === k) { this.ctxKind = 'main'; this.ctxName = ''; }
    this._renderCtxBar(); this._loadCtx(); this._renderPalette();
  }
  _switchCtx(kind, name) {
    this._saveCtx();
    this.ctxKind = kind; this.ctxName = name || '';
    this._renderCtxBar(); this._loadCtx(); this._renderPalette();
  }
  /** Serialize the visible stack back into the model at the current context. */
  _saveCtx() {
    const evs = this._stackEvents();
    if (this.ctxKind === 'entity') { (this.model.entities[this.ctxName] || (this.model.entities[this.ctxName] = { events: [] })).events = evs; }
    else this.model.events = evs;
  }
  /** Load the current context's events into the stack. */
  _loadCtx() {
    this.stack.innerHTML = '';
    const evs = this.ctxKind === 'entity' ? (this.model.entities[this.ctxName]?.events || []) : this.model.events;
    this._importEvents(evs);
    if (!this.stack.children.length && this.ctxKind === 'main') this.stack.appendChild(this._mk('basicAttack'));
    this._refresh();
  }
  _syncTabs() { document.querySelectorAll('#beEventTabs [data-cat]').forEach(t => t.classList.toggle('on', t.dataset.cat === this.cat)); }

  // ── build a block DOM node ──
  _mk(id) {
    const d = DEFS[id]; if (!d) return document.createElement('div');
    const b = document.createElement('div');
    b.className = 'be-blk' + (d.hat ? ' be-hat' : '') + (d.rep ? ' be-rep' : '') + (d.bool ? ' be-bool' : '');
    b.style.background = C[d.cat]; b.dataset.id = id; b.dataset.op = d.op;
    for (const part of d.parts) {
      if (typeof part === 'string') { b.appendChild(document.createTextNode(' ' + part + ' ')); continue; }
      b.appendChild(this._slot(part));
    }
    const del = document.createElement('span'); del.className = 'be-del'; del.textContent = '×'; del.title = '삭제';
    del.addEventListener('click', (e) => { e.stopPropagation(); (b.dataset.cwrap ? b : (b.closest('.be-cwrap') && b.closest('.be-cwrap').querySelector(':scope>.be-blk') === b ? b.closest('.be-cwrap') : b)).remove(); this._refresh(); });
    b.appendChild(del);
    if (d.c) {
      const wrap = document.createElement('div'); wrap.className = 'be-cwrap'; wrap.dataset.cwrap = id; wrap.dataset.op = d.op; wrap.dataset.id = id;
      wrap.appendChild(b);
      for (const cont of d.containers) {
        const inner = document.createElement('div'); inner.className = 'be-cinner'; inner.style.borderColor = C[d.cat]; inner.dataset.container = cont;
        if (cont === 'else') { const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:10px;color:#fff;opacity:.8'; lbl.textContent = '아니면'; wrap.appendChild(lbl); }
        this._dz(inner); wrap.appendChild(inner);
      }
      const foot = document.createElement('div'); foot.className = 'be-cfoot'; foot.style.background = C[d.cat]; wrap.appendChild(foot);
      this._hookDrag(b, wrap);
      // del on the head removes the whole wrap
      del.onclick = (e) => { e.stopPropagation(); wrap.remove(); this._refresh(); };
      return wrap;
    }
    this._hookDrag(b, b);
    return b;
  }

  // ── a value/boolean slot (holds an input/select, or a nested block) ──
  _slot(part) {
    if (part.t === 'bool') {
      const slot = document.createElement('span'); slot.className = 'be-bslot'; slot.dataset.a = part.a; slot.dataset.slotType = 'bool';
      this._slotDrop(slot); return slot;
    }
    const slot = document.createElement('span'); slot.className = 'be-slot'; slot.dataset.a = part.a; slot.dataset.slotType = part.t;
    let inp;
    if (part.t === 'sel') {
      inp = document.createElement('select'); inp.className = 'be-sl';
      // options are 'value' or 'value|라벨' (AST stores the value key).
      inp.innerHTML = part.o.map(o => { const [v, l] = String(o).split('|'); return `<option value="${v}">${l || v}</option>`; }).join('');
      inp.value = part.d;
    }
    else if (part.t === 'check') { inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!part.d; }
    else if (part.t === 'text') { inp = document.createElement('input'); inp.className = 'be-sl'; inp.value = part.d ?? ''; }
    else { inp = document.createElement('input'); inp.className = 'be-sl'; inp.value = part.d ?? 0; }
    inp.dataset.a = part.a;
    inp.addEventListener('input', () => this._refresh());
    inp.addEventListener('change', () => this._refresh());
    inp.addEventListener('mousedown', (e) => e.stopPropagation());
    inp.draggable = false;
    slot.appendChild(inp);
    if (part.t === 'num') this._slotDrop(slot);   // only number slots accept reporters
    return slot;
  }

  // ── drag hooks (pointer-based: ghost preview, reflow, touch, ESC) ──
  _hookDrag(headEl, rootEl) {
    rootEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('input,select,.be-del')) return;   // let controls work
      if (this.drag) return;
      e.stopPropagation();
      this._armPointer(e, (ev) => {
        const isRep = rootEl.classList.contains('be-rep') || rootEl.classList.contains('be-bool');
        const dup = ev.ctrlKey || ev.metaKey;
        let nodes = isRep ? [rootEl] : this._collectRun(rootEl);
        const origin = dup ? null : { parent: nodes[0].parentElement, next: nodes[nodes.length - 1].nextElementSibling };
        if (dup) nodes = nodes.map((n) => n.cloneNode(true));   // clone; re-hooked after drop
        this._startDrag(ev, { nodes, isReporter: isRep, fromStack: true, rehook: dup, origin });
      });
    });
    headEl.querySelectorAll('.be-sl').forEach((sl) => sl.addEventListener('pointerdown', (e) => e.stopPropagation()));
  }

  // Contiguous run: the block + siblings after it until the next hat (Scratch feel).
  _collectRun(node) {
    if (node.closest('.be-cinner') || DEFS[node.dataset.id]?.hat) {
      // inside a C mouth OR a hat: dragging a hat carries its trailing stack too
      if (DEFS[node.dataset.id]?.hat) return this._runFrom(node);
      return [node];
    }
    return this._runFrom(node);
  }
  _runFrom(node) {
    const run = [node]; let n = node.nextElementSibling;
    while (n && n !== this.ind) { if (this._isHat(n)) break; run.push(n); n = n.nextElementSibling; }
    return run;
  }
  _isHat(node) { const id = node.dataset && node.dataset.id; return id && DEFS[id] && DEFS[id].hat; }

  // Drop zones (main stack + each C-mouth) are tagged so the pointer drag can
  // find them by class; slots are already class-marked (.be-slot/.be-bslot).
  _dz(zone) { zone.classList.add('be-dz'); }
  _slotDrop(slot) { slot.classList.add('be-dz-slot'); }

  // ── pointer drag machinery ─────────────────────────────────────────────────
  /** Wait for an intentional drag: mouse = 5px move; touch = 200ms long-press
   *  (a quick touch-move before that is a scroll gesture, so we bail). */
  _armPointer(e, startFn) {
    const sx = e.clientX, sy = e.clientY, touch = e.pointerType !== 'mouse';
    let fired = false, timer = null;
    const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (timer) { clearTimeout(timer); timer = null; } };
    const go = (ev) => { if (fired) return; fired = true; finish(); startFn(ev); };
    const move = (ev) => {
      const far = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (touch) { if (far > 12) finish(); return; }   // moved before long-press = scroll → abort
      if (far > 5) go(ev);
    };
    const up = () => finish();
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    if (touch) timer = setTimeout(() => { timer = null; go(e); }, 200);
  }

  _startDrag(e, opt) {
    const first = opt.nodes[0];
    const r = first.getBoundingClientRect();
    const float = document.createElement('div'); float.className = 'be-floating';
    const holder = document.createElement('div'); holder.className = 'stack'; holder.style.gap = '2px';
    const srcZone = opt.fromStack && !opt.rehook ? first.parentElement : null;
    const lift = () => { for (const n of opt.nodes) holder.appendChild(n); };
    if (srcZone) this._flip(srcZone, lift); else lift();   // source closes smoothly
    float.appendChild(holder); document.body.appendChild(float);
    this.drag = {
      ...opt, float, holder,
      offX: e.clientX - r.left, offY: e.clientY - r.top,
      x: e.clientX, y: e.clientY, ghost: null, slot: null, drop: null, raf: 0, scroll: 0, over: null,
    };
    if (opt.rehook && opt.origin === null && opt.fromStack) {/* dup: originals stay in place */}
    this._moveFloat();
    this._pm = (ev) => this._dragMove(ev);
    this._pu = () => this._dragEnd();
    this._pk = (ev) => { if (ev.key === 'Escape') this._dragCancel(); };
    window.addEventListener('pointermove', this._pm, { passive: false });
    window.addEventListener('pointerup', this._pu); window.addEventListener('pointercancel', this._pu);
    window.addEventListener('keydown', this._pk);
    this._dragMove(e);
  }

  _moveFloat() { const d = this.drag; if (d) d.float.style.transform = `translate(${d.x - d.offX}px,${d.y - d.offY}px) rotate(2.5deg)`; }

  _dragMove(e) {
    const d = this.drag; if (!d) return;
    if (e.cancelable) e.preventDefault();   // suppress touch scroll while dragging
    d.x = e.clientX; d.y = e.clientY;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0; if (!this.drag) return;
      this._moveFloat();
      this._autoScroll(d.x, d.y);
      const pal = document.getElementById('bePalette');
      const overPal = pal && this._within(pal, d.x, d.y);
      if (overPal) { pal.classList.add('be-trash-hot'); this._clearGhost(); this._clearSlot(); return; }
      if (pal) pal.classList.remove('be-trash-hot');
      if (d.isReporter) this._hitSlot(d.x, d.y);
      else this._hitStack(d.x, d.y);
    });
  }

  _within(el, x, y) { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

  // Nearest valid stack insertion within the snap radius → show the ghost there.
  _hitStack(x, y) {
    const R = 42; let best = null, bestD = R;
    const zones = [this.stack, ...this.stack.querySelectorAll('.be-cinner')];
    for (const zone of zones) {
      const zr = zone.getBoundingClientRect();
      if (x < zr.left - 30 || x > zr.right + 60) continue;
      const kids = [...zone.children].filter((k) => k !== this.drag.ghost && k.nodeType === 1);
      // candidate gap Ys: before each child + after the last one
      const gaps = [];
      for (const k of kids) { const r = k.getBoundingClientRect(); gaps.push({ yy: r.top, ref: k }); }
      gaps.push({ yy: kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom : zr.top + 6, ref: null });
      for (const g of gaps) { const dd = Math.abs(y - g.yy); if (dd < bestD) { bestD = dd; best = { zone, ref: g.ref }; } }
    }
    if (best) this._showGhost(best.zone, best.ref); else this._clearGhost();
  }

  _hitSlot(x, y) {
    const el = document.elementFromPoint(x, y);
    const slot = el && el.closest('.be-slot,.be-bslot');
    if (!slot || !this.stack.contains(slot)) { this._clearSlot(); return; }
    if (slot === this.drag.slot) return;
    this._clearSlot();
    const wantBool = slot.dataset.slotType === 'bool';
    const isBool = this.drag.nodes[0].classList.contains('be-bool');
    if (slot.dataset.slotType !== 'num' && slot.dataset.slotType !== 'bool') return;   // only num/bool slots
    if (wantBool !== isBool) { slot.classList.add('be-slot-bad'); setTimeout(() => slot.classList.remove('be-slot-bad'), 220); return; }
    slot.classList.add('be-slot-hot'); this.drag.slot = slot;
  }
  _clearSlot() { if (this.drag && this.drag.slot) { this.drag.slot.classList.remove('be-slot-hot'); this.drag.slot = null; } }

  _buildGhost() { const g = document.createElement('div'); g.className = 'be-ghost stack'; g.style.gap = '2px'; for (const n of this.drag.nodes) g.appendChild(n.cloneNode(true)); return g; }
  _showGhost(zone, ref) {
    const d = this.drag; const g = d.ghost || (d.ghost = this._buildGhost());
    if (g.parentElement === zone && g.nextElementSibling === ref) return;
    const oldZone = g.parentElement;
    if (oldZone && oldZone !== zone) this._flip(oldZone, () => g.remove());
    this._flip(zone, () => zone.insertBefore(g, ref));
    d.drop = { zone, ref };
  }
  _clearGhost() { const d = this.drag; if (d && d.ghost && d.ghost.parentElement) { const z = d.ghost.parentElement; this._flip(z, () => d.ghost.remove()); } if (d) d.drop = null; }

  // FLIP: animate a zone's children into their new positions with transform only.
  _flip(zone, mutate) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const kids = [...zone.children].filter((k) => k.nodeType === 1 && k !== (this.drag && this.drag.ghost));
    const before = reduce ? null : new Map(kids.map((k) => [k, k.getBoundingClientRect().top]));
    mutate();
    if (reduce) return;
    for (const k of kids) {
      if (!k.isConnected) continue;
      const dy = before.get(k) - k.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) { k.classList.remove('be-flip'); k.style.transform = `translateY(${dy}px)`; void k.offsetHeight; k.classList.add('be-flip'); k.style.transform = ''; }
    }
  }

  // Edge auto-scroll: accelerate toward the edge the cursor hovers near.
  _autoScroll(x, y) {
    const d = this.drag; const r = this.ws.getBoundingClientRect(); const M = 42;
    let v = 0;
    if (y < r.top + M) v = -Math.ceil((r.top + M - y) / M * 14);
    else if (y > r.bottom - M) v = Math.ceil((y - (r.bottom - M)) / M * 14);
    if (!v) { if (d.scroll) { cancelAnimationFrame(d.scroll); d.scroll = 0; } return; }
    if (d.scroll) return;
    const step = () => { if (!this.drag) return; this.ws.scrollTop += v; this.drag.scroll = requestAnimationFrame(step); };
    d.scroll = requestAnimationFrame(step);
  }

  _endCleanup() {
    const d = this.drag; if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf); if (d.scroll) cancelAnimationFrame(d.scroll);
    window.removeEventListener('pointermove', this._pm); window.removeEventListener('pointerup', this._pu);
    window.removeEventListener('pointercancel', this._pu); window.removeEventListener('keydown', this._pk);
    d.float.remove();
    const pal = document.getElementById('bePalette'); if (pal) pal.classList.remove('be-trash-hot');
    this._clearSlot();
    this.drag = null;
  }

  _dragEnd() {
    const d = this.drag; if (!d) return;
    const pal = document.getElementById('bePalette');
    const overPal = pal && this._within(pal, d.x, d.y);
    const nodes = d.nodes;
    if (overPal) { this._clearGhost(); this._endCleanup(); this._refresh(); return; }   // dropped on palette = discard
    if (d.isReporter) {
      if (d.slot) { d.slot.innerHTML = ''; d.slot.appendChild(nodes[0]); nodes[0].classList.add('be-pop'); this._pop(nodes[0]); this._snap(); this._endCleanup(); if (d.rehook) this._reimport(); else this._refresh(); return; }
      // no valid slot: restore or discard
      if (d.origin) d.origin.parent.insertBefore(nodes[0], d.origin.next);
      this._endCleanup(); this._refresh(); return;
    }
    // stack drop
    let target = d.drop;
    if (!target) target = { zone: this.stack, ref: null };   // empty area → append as its own stack
    if (d.ghost && d.ghost.parentElement) { target = { zone: d.ghost.parentElement, ref: d.ghost.nextElementSibling }; }
    this._flip(target.zone, () => { for (const n of nodes) target.zone.insertBefore(n, target.ref); if (d.ghost && d.ghost.parentElement) d.ghost.remove(); });
    for (const n of nodes) this._pop(n);
    this._snap();
    this._endCleanup();
    if (d.rehook) this._reimport(); else this._refresh();
  }

  _dragCancel() {
    const d = this.drag; if (!d) return;
    this._clearGhost();
    if (d.origin && !d.rehook) { for (const n of d.nodes) d.origin.parent.insertBefore(n, d.origin.next); }
    this._endCleanup(); this._refresh();
  }

  _pop(node) { node.classList.remove('be-pop'); void node.offsetHeight; node.classList.add('be-pop'); setTimeout(() => node.classList.remove('be-pop'), 200); }
  _snap() { try { Sound.play('hit'); } catch {} }
  // Duplicate drops carry cloned DOM with no listeners → rebuild the context so
  // every node is fully hooked again (AST is unchanged).
  _reimport() { const evs = this._stackEvents(); this.stack.innerHTML = ''; this._importEvents(evs); this._refresh(); }

  // ── palette ──
  _renderPalette() {
    const pal = document.getElementById('bePalette'); if (!pal) return;
    pal.innerHTML = '';
    for (const id in DEFS) {
      const d = DEFS[id];
      if (d.cat !== this.cat) continue;
      // Context-scoped palette: entity blocks only in an entity script, and the
      // weapon's own event hats only in the weapon context.
      if (this.ctxKind === 'entity') { if (d.scope === 'main') continue; }
      else if (d.scope === 'entity') continue;
      // Preset-scoped events: hide event hats that don't belong to this preset.
      if (this.ctxKind === 'main' && d.hat && this.presetKey && PRESET_EVENTS[this.presetKey] && !PRESET_EVENTS[this.presetKey].includes(d.op)) continue;
      const p = document.createElement('div');
      p.className = 'be-blk' + (d.hat ? ' be-hat' : '') + (d.rep ? ' be-rep' : '') + (d.bool ? ' be-bool' : '');
      p.style.background = C[d.cat];
      for (const part of d.parts) p.appendChild(typeof part === 'string' ? document.createTextNode(' ' + part + ' ') : this._slot(part));
      p.querySelectorAll('.be-sl,input,select').forEach(x => { x.disabled = true; });
      p.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (this.drag) return;
        this._armPointer(e, (ev) => {
          const node = this._mk(id);
          this._startDrag(ev, { nodes: [node], isReporter: !!(d.rep || d.bool), fromStack: false, rehook: false, origin: null });
        });
      });
      p.addEventListener('click', () => { if (d.rep || d.bool) { this._status('값/조건 블록은 슬롯으로 드래그하세요.'); return; } this.stack.appendChild(this._mk(id)); this._refresh(); });
      pal.appendChild(p);
    }
  }

  // ── serialize the visible stack → events array ──
  _stackEvents() {
    const events = []; let cur = null;
    for (const node of this.stack.children) {
      if (node === this.ind) continue;
      if (this._isHat(node)) { cur = { on: node.dataset.op, do: [] }; const tag = this._headTag(node); if (tag) cur.tag = tag; const sig = this._headSlot(node, 'sig'); if (sig) cur.sig = sig; events.push(cur); continue; }
      const stmt = this._nodeStmt(node); if (!stmt) continue;
      if (!cur) { cur = { on: this.ctxKind === 'entity' ? 'onEntityTick' : 'basicAttack', do: [] }; events.push(cur); }
      cur.do.push(stmt);
    }
    return events;
  }
  // ── assemble the full multi-context AST ({events, entities?, funcs?}) ──
  buildAST() {
    this._saveCtx();
    const out = { events: this.model.events };
    const ents = {};
    for (const k of Object.keys(this.model.entities)) if ((this.model.entities[k].events || []).length) ents[k] = { events: this.model.entities[k].events };
    if (Object.keys(ents).length) out.entities = ents;
    if (this.model.funcs && Object.keys(this.model.funcs).length) out.funcs = this.model.funcs;
    return out;
  }
  _headTag(hatNode) { return this._headSlot(hatNode, 'tag'); }
  _headSlot(hatNode, key) { const t = hatNode.querySelector(`:scope .be-slot[data-a="${key}"] input`); return t ? t.value : ''; }

  _nodeStmt(node) {
    const isWrap = node.dataset && node.dataset.cwrap;
    const head = isWrap ? node.querySelector(':scope>.be-blk') : node;
    if (!head || !head.dataset.op) return null;
    const stmt = { op: head.dataset.op };
    this._readSlots(head, stmt);
    if (isWrap) {
      const inners = node.querySelectorAll(':scope>.be-cinner');
      const def = DEFS[node.dataset.id];
      def.containers.forEach((cont, i) => {
        const inner = inners[i]; const arr = [];
        if (inner) for (const k of inner.children) { if (k === this.ind) continue; const st = this._nodeStmt(k); if (st) arr.push(st); }
        stmt[cont] = arr;
      });
    }
    return stmt;
  }
  // Read the block head's direct slots into args (nested reporter → value-expr).
  _readSlots(head, target) {
    for (const slot of head.querySelectorAll(':scope > .be-slot, :scope > .be-bslot')) {
      const key = slot.dataset.a; if (!key) continue;
      const nested = slot.querySelector(':scope > .be-blk, :scope > .be-rep, :scope > .be-bool, :scope > .be-cwrap, :scope > [data-op]');
      if (nested) { target[key] = this._exprOf(nested); continue; }
      const inp = slot.querySelector('input,select');
      if (!inp) { if (slot.dataset.slotType === 'bool') target[key] = { op: 'lt', a: { op: 'nearestDist' }, b: 90 }; continue; }
      if (inp.type === 'checkbox') target[key] = inp.checked;
      else target[key] = numOr(inp.value);
    }
  }
  // A reporter/boolean block → value-expr AST.
  _exprOf(node) {
    const expr = { op: node.dataset.op };
    this._readSlots(node, expr);
    return expr;
  }

  // ── import an events array → DOM stack ──
  _importEvents(events) {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      const hatId = OP2ID[ev.on]; if (!hatId || !DEFS[hatId].hat) continue;
      const hat = this._mk(hatId);
      if (ev.tag) { const t = hat.querySelector('.be-slot[data-a="tag"] input'); if (t) t.value = ev.tag; }
      if (ev.sig) { const t = hat.querySelector('.be-slot[data-a="sig"] input'); if (t) t.value = ev.sig; }
      this.stack.appendChild(hat);
      for (const st of (ev.do || [])) { const node = this._buildFromStmt(st); if (node) this.stack.appendChild(node); }
    }
  }
  _buildFromStmt(st) {
    const id = OP2ID[st.op]; if (!id) return null;
    const node = this._mk(id); const def = DEFS[id];
    const head = node.dataset.cwrap ? node.querySelector(':scope>.be-blk') : node;
    this._fillSlots(head, st);
    if (def.containers) {
      const inners = node.querySelectorAll(':scope>.be-cinner');
      def.containers.forEach((cont, i) => { const arr = st[cont]; if (Array.isArray(arr) && inners[i]) for (const c of arr) { const cn = this._buildFromStmt(c); if (cn) inners[i].appendChild(cn); } });
    }
    return node;
  }
  _fillSlots(head, src) {
    for (const slot of head.querySelectorAll(':scope > .be-slot, :scope > .be-bslot')) {
      const key = slot.dataset.a; if (!key || !(key in src)) continue;
      const v = src[key];
      if (v && typeof v === 'object' && v.op) { slot.innerHTML = ''; const rn = this._buildExpr(v); if (rn) slot.appendChild(rn); continue; }
      const inp = slot.querySelector('input,select'); if (!inp) continue;
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
    }
  }
  _buildExpr(expr) {
    const id = OP2ID[expr.op]; if (!id) return null;
    const node = this._mk(id); this._fillSlots(node, expr); return node;
  }

  // ── orphan marking + gauge ──
  _refresh() {
    // Dim leading blocks before the first hat (won't run).
    let seenHat = false;
    for (const node of this.stack.children) {
      if (node === this.ind) continue;
      if (this._isHat(node)) { seenHat = true; node.classList.remove('be-orphan'); this._badge(node, false); continue; }
      node.classList.toggle('be-orphan', !seenHat);
      this._badge(node, !seenHat);
    }
    this._gauge();
  }
  _badge(node, on) {
    const head = node.dataset.cwrap ? node.querySelector(':scope>.be-blk') : node;
    let b = head.querySelector(':scope>.be-orphan-badge');
    if (on && !b) { b = document.createElement('span'); b.className = 'be-orphan-badge'; b.textContent = '실행 안 됨'; head.appendChild(b); }
    else if (!on && b) b.remove();
  }
  _gauge() {
    const ast = this.buildAST();
    const n = countBlocks(ast), max = VM_LIMITS[this.tier].maxBlocks;
    const g = document.getElementById('beBlockGauge'); if (g) g.textContent = n;
    const bar = document.getElementById('beBlockBar'); if (bar) { bar.style.width = Math.min(100, n / max * 100) + '%'; bar.style.background = n > max ? '#ff5a5a' : n > max * 0.85 ? '#ffd24a' : '#7df09a'; }
    const cnt = document.getElementById('meBlockCount'); if (cnt) cnt.textContent = n ? `(${n} 블록)` : '';
    this._budgetGauge(ast);
  }

  /** Live OUTPUT-budget gauge: shows how hard the combo pushes each per-second
   *  cap (damage / entities / CC). >100% = the host will soft-cap it in a match
   *  — the "형태는 자유, 출력은 예산" idea, made visible while authoring. */
  _budgetGauge(ast) {
    const host = document.getElementById('beBudget'); if (!host) return;
    const est = estimateBudget(ast, this.stats || {}, this.tier);
    const rows = [['피해', est.damage], ['엔티티', est.spawn], ['CC', est.cc]];
    const barColor = (f) => f > 1 ? '#ff5a5a' : f > 0.85 ? '#ffd24a' : '#7df09a';
    host.innerHTML = rows.map(([label, f]) => {
      const pct = Math.min(100, Math.max(0, f * 100));
      return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
        <span style="width:44px;font-size:10px;color:#cbd5e1">${label}</span>
        <span style="flex:1;height:6px;border-radius:3px;background:#1e293b;overflow:hidden;display:inline-block">
          <span style="display:block;height:100%;width:${pct}%;background:${barColor(f)}"></span></span>
        <span style="width:34px;text-align:right;font-size:10px;color:${barColor(f)}">${Math.round(f * 100)}%</span>
      </div>`;
    }).join('') + (est.throttled
      ? `<div style="font-size:10px;color:#ffb454;margin-top:3px">⚠ 예산 초과 — 실전에서 초과 출력은 자동 감쇠됩니다(형태는 자유, 출력은 예산).</div>`
      : `<div style="font-size:10px;color:#64748b;margin-top:3px">예산 이내 — 출력이 온전히 적용됩니다.</div>`);
  }

  _test() {
    const events = this.buildAST().events; const ev = events.find(e => e.do && e.do.length) || events[0];
    if (!ev) { this._status('실행할 이벤트 블록이 없습니다.'); return; }
    const vm = new BlockVM(this.buildAST(), this.tier);
    const calls = []; const api = {}; for (const nm of ['spawnMelee', 'spawnProjectile', 'spawnArea', 'applyStatus', 'knockback', 'heal', 'dash', 'teleport', 'jump', 'pull', 'spawnPlacement', 'particle', 'sfx', 'shake', 'cooldownGate']) api[nm] = (p) => calls.push(nm + (p && p.damage ? `(${Math.round(p.damage)})` : p && p.angle !== undefined ? `(${Math.round(p.angle)}°)` : ''));
    const r = vm.run(ev.on, { api, vars: {}, rng: () => 0.5, now: 0, damageBase: 20, sense: { aimAngle: 0, hp: 60, maxHp: 100, x: 0, y: 0, speed: 0, grounded: true, nearestDist: 70, nearestDir: 0, combo: 0, lastDamage: 18, time: 0 } });
    const out = document.getElementById('beTestOut');
    if (out) out.innerHTML = `<b class="text-[#7df09a]">${(ev.on)}</b> → ${calls.length}개 호출<br>${calls.slice(0, 14).join(' · ') || '(효과 없음)'}${r.halted ? '<br><span class="text-[#ff5a5a]">⚠ 자원 한계로 중단</span>' : ''}`;
  }
  _status(t) { const el = document.getElementById('beTestOut'); if (el) el.textContent = t; }
}
