import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input } from '../game/Input.js';
import { Game } from '../game/Game.js';
import { Player } from '../game/Player.js';
import { Protocol } from '../multiplayer/Protocol.js';
import { Weapons } from '../game/Weapons.js';

function installDom(elements = {}) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  globalThis.window = { innerWidth: 800, innerHeight: 600, PointerEvent: function PointerEvent() {} };
  globalThis.document = {
    addEventListener: () => {},
    getElementById: id => elements[id] || null
  };
  globalThis.localStorage = { getItem: () => 'false', setItem: () => {} };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0 }
  });

  return () => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;

    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;

    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;

    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  };
}

function inputWithCanvas(elements = {}) {
  const restore = installDom(elements);
  const listeners = {};
  const canvas = {
    width: 800,
    height: 600,
    style: {},
    addEventListener: (type, handler) => { listeners[type] = handler; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 })
  };
  const input = new Input();
  input.setupListeners(canvas);
  return { input, listeners, restore };
}

test('desktop pointer interaction matrix: basic attack vs target cast vs ignored clicks', () => {
  const cases = [
    {
      name: 'left click without target mode queues basic attack',
      prepare: input => input,
      event: { button: 0, clientX: 120, clientY: 80 },
      expectBasic: true,
      expectTarget: false
    },
    {
      name: 'left click in target mode queues scaled target cast only',
      prepare: input => { input._beginPointerTarget('targetCast'); return input; },
      event: { button: 0, clientX: 120, clientY: 80 },
      expectBasic: false,
      expectTarget: { x: 240, y: 160 }
    },
    {
      name: 'right click is ignored',
      prepare: input => input,
      event: { button: 2, clientX: 120, clientY: 80 },
      expectBasic: false,
      expectTarget: false
    },
    {
      name: 'synthetic touch mouse event is ignored in joystick mode',
      prepare: input => { input.joystickEnabled = true; return input; },
      event: { button: 0, clientX: 120, clientY: 80, sourceCapabilities: { firesTouchEvents: true } },
      expectBasic: false,
      expectTarget: false
    }
  ];

  for (const c of cases) {
    const { input, listeners, restore } = inputWithCanvas();
    try {
      c.prepare(input);
      listeners.mousedown(c.event);

      assert.equal(input.consumeBasicAttack(), c.expectBasic, c.name);
      if (c.expectTarget) {
        assert.deepEqual(input.consumeTargetCast(), c.expectTarget, c.name);
      } else {
        assert.equal(input.consumeTargetCast(), null, c.name);
      }
    } finally {
      restore();
    }
  }
});

test('mobile target mode ignores touches on virtual controls', () => {
  const attackBtn = {
    offsetParent: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 180, bottom: 180 })
  };
  const { input, listeners, restore } = inputWithCanvas({ attackBtn });
  try {
    input.joystickEnabled = true;
    input._beginPointerTarget('targetCast');

    listeners.pointerdown({
      pointerType: 'touch',
      clientX: 120,
      clientY: 120,
      target: { closest: () => null },
      cancelable: true,
      preventDefault: () => {}
    });

    assert.equal(input.consumeTargetCast(), null);
    assert.equal(input.consumeBasicAttack(), false);
  } finally {
    restore();
  }
});

test('protocol join carries mobile control settings for every boolean combination', () => {
  for (const automaticAttack of [false, true]) {
    for (const mobileAimAssist of [false, true]) {
      const controls = { automaticAttack, mobileAimAssist };
      const msg = Protocol.joinRoom('tester', 'sword', { color: '#fff' }, true, controls);

      assert.equal(msg.isMobile, true);
      assert.deepEqual(msg.controls, controls);
      assert.equal(msg.weapon, 'sword');
    }
  }
});

function aimAssistGame(players) {
  const game = Object.create(Game.prototype);
  game.players = players;
  return game;
}

test('mobile aim assist target selection matrix filters self/dead/out-of-angle targets', () => {
  const cases = [
    {
      name: 'melee chooses nearby live target in front',
      owner: { category: 'melee', range: 120, angle: 0 },
      targets: [
        { id: 'dead-near', x: 40, y: 0, isDead: true },
        { id: 'front', x: 150, y: 0 },
        { id: 'behind', x: -40, y: 0 }
      ],
      expected: 'front'
    },
    {
      name: 'ranged prefers target close to current aim line over closer off-angle target',
      owner: { category: 'ranged', range: 300, angle: 0 },
      targets: [
        { id: 'off-angle', x: 120, y: 260 },
        { id: 'on-line', x: 360, y: 0 }
      ],
      expected: 'on-line'
    },
    {
      name: 'far melee target outside assist radius is ignored',
      owner: { category: 'melee', range: 60, angle: 0 },
      targets: [{ id: 'too-far', x: 900, y: 0 }],
      expected: null
    },
    {
      name: 'special can use wide angle fallback when target is valid',
      owner: { category: 'special', range: 180, angle: 0 },
      targets: [{ id: 'vertical', x: 0, y: 160 }],
      expected: 'vertical'
    }
  ];

  for (const c of cases) {
    const owner = new Player('owner', 'Owner', 'sword', 0, 0);
    owner.isMobile = true;
    owner.mobileAimAssist = true;
    owner.angle = c.owner.angle;
    owner.workshopWeapon = {
      category: c.owner.category,
      stats: { range: c.owner.range },
      presets: {
        basic: {
          ranged: c.owner.category === 'ranged',
          combat: { range: c.owner.range }
        }
      }
    };
    const players = { owner };
    for (const t of c.targets) {
      const p = new Player(t.id, t.id, 'sword', t.x, t.y);
      p.isDead = !!t.isDead;
      players[p.id] = p;
    }

    const assist = aimAssistGame(players)._resolveAimAssistTarget(owner, 'basic');
    assert.equal(assist?.targetId ?? null, c.expected, c.name);
  }
});

test('mobile aim assist application matrix respects mobile and setting gates', () => {
  const cases = [
    { isMobile: true, enabled: true, changed: true },
    { isMobile: true, enabled: false, changed: false },
    { isMobile: false, enabled: true, changed: false },
    { isMobile: false, enabled: false, changed: false }
  ];

  for (const c of cases) {
    const owner = new Player('owner', 'Owner', 'sword', 0, 0);
    owner.isMobile = c.isMobile;
    owner.mobileAimAssist = c.enabled;
    owner.angle = 0.5;
    owner.workshopWeapon = {
      category: 'melee',
      stats: { range: 120 },
      presets: { basic: { combat: { range: 120 } } }
    };
    const target = new Player('target', 'Target', 'sword', 120, 0);
    const game = aimAssistGame({ owner, target });

    assert.equal(game._applyMobileAimAssistForAttack(owner, 'basic'), c.changed);
    assert.equal(Math.abs(owner.angle) < 1e-9, c.changed);
  }
});

test('direct basic attack execution matrix covers blocked and workshop-ranged paths', () => {
  const blocked = new Player('blocked', 'Blocked', 'greatsword', 0, 0);
  const blockedGame = Object.assign(Object.create(Game.prototype), {
    players: { blocked },
    projectiles: [],
    effects: [],
    pendingMeleeHits: [],
    mapWidth: 700,
    mapHeight: 700,
    _creditKill: () => {}
  });
  assert.equal(blockedGame._performBasicAttack(blocked, Weapons.greatsword, 5000), false);

  const ranged = new Player('ranged', 'Ranged', 'sword', 0, 0);
  ranged.workshopWeapon = {
    ranged: true,
    stats: { damage: 17, cooldownMs: 100 },
    projectile: {
      directionSource: 'angle',
      angle: 90,
      rotation: -45,
      speed: 100,
      lifetimeMs: 1000,
      hitbox: { shape: 'circle', radius: 6 },
      imageId: 'arrow'
    }
  };
  const rangedGame = Object.assign(Object.create(Game.prototype), {
    players: { ranged },
    projectiles: [],
    effects: [],
    localPlayerId: 'not-ranged'
  });

  assert.equal(rangedGame._performBasicAttack(ranged, Weapons.sword, 5000), true);
  assert.equal(rangedGame.projectiles.length, 1);
  assert.equal(rangedGame.projectiles[0].damage, 17);
  assert.equal(rangedGame.projectiles[0].radius, 6);
  assert.equal(rangedGame.projectiles[0].wsRotation, -45);
  assert.equal(rangedGame.projectiles[0].serialize().wsRotation, -45);
  assert.ok(Math.abs(rangedGame.projectiles[0].angle - Math.PI / 2) < 1e-9);
});

test('workshop ultimate gauge gain clamps and caps at ready', () => {
  const game = Object.assign(Object.create(Game.prototype), {
    localPlayerId: 'none',
    _announce: () => {}
  });
  const player = new Player('p', 'Player', 'sword', 0, 0);
  player.ultimateGauge = 90;
  game._awardUltimateGauge(player, 35);
  assert.equal(player.ultimateGauge, 100);
  game._awardUltimateGauge(player, 35);
  assert.equal(player.ultimateGauge, 100);
});
