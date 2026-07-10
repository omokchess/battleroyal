import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input, resolvePointerAimAngle } from '../game/Input.js';

const camera = {
  x: 350,
  y: 350,
  zoom: 1,
  toScreen(worldX, worldY, viewportWidth, viewportHeight) {
    return {
      x: (worldX - this.x) * this.zoom + viewportWidth / 2,
      y: (worldY - this.y) * this.zoom + viewportHeight / 2
    };
  },
  toWorld(screenX, screenY, viewportWidth, viewportHeight) {
    return {
      x: (screenX - viewportWidth / 2) / this.zoom + this.x,
      y: (screenY - viewportHeight / 2) / this.zoom + this.y
    };
  }
};

test('mouse aim projects arena-center pointer direction onto the wall', () => {
  const player = { x: 100, y: 100 };
  const pointerNearCenterRight = { x: 360, y: 350 };

  const angle = resolvePointerAimAngle(
    player,
    camera,
    pointerNearCenterRight,
    700,
    700,
    700,
    700,
    0
  );

  assert.ok(Math.abs(angle - Math.atan2(250, 600)) < 0.0001);
});

test('mouse aim keeps the previous angle at exact arena center', () => {
  const player = { x: 100, y: 100 };
  const fallbackAngle = 1.234;

  const angle = resolvePointerAimAngle(
    player,
    camera,
    { x: 350, y: 350 },
    700,
    700,
    700,
    700,
    fallbackAngle
  );

  assert.equal(angle, fallbackAngle);
});

test('Y key queues one ultimate activation', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; }
  };
  globalThis.localStorage = { getItem: () => null };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0 }
  });
  try {
    const input = new Input();
    let prevented = false;
    input.setupListeners({
      width: 800,
      height: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {},
      removeEventListener() {}
    });
    input._keyDownHandler({ key: 'y', code: 'KeyY', repeat: false, preventDefault: () => { prevented = true; } });
    assert.equal(input.consumeUltimate(), true);
    assert.equal(input.consumeUltimate(), false);
    assert.equal(prevented, true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('custom keybinds drive movement and combat actions', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; }
  };
  globalThis.localStorage = {
    getItem(key) {
      if (key === 'battle_control_settings_v1') {
        return JSON.stringify({ keybinds: { jump: 'KeyI', dash: 'KeyQ', skill1: 'KeyU', skill2: 'KeyO', skill3: 'KeyP', ultimate: 'KeyL' } });
      }
      return null;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0 }
  });
  try {
    const input = new Input();
    input.setupListeners({
      width: 800,
      height: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {},
      removeEventListener() {}
    });
    let prevented = false;
    const ev = (key, code, repeat = false) => ({ key, code, repeat, preventDefault: () => { prevented = true; } });
    input._keyDownHandler(ev('i', 'KeyI'));
    assert.equal(input.keys.w, true);
    assert.equal(prevented, true);
    input._keyUpHandler(ev('i', 'KeyI'));
    assert.equal(input.keys.w, false);

    input._keyDownHandler(ev('q', 'KeyQ'));
    assert.ok(input.consumeDash());
    input._keyDownHandler(ev('u', 'KeyU'));
    assert.equal(input.consumeSkillDown(), true);
    input._keyUpHandler(ev('u', 'KeyU'));
    assert.equal(input.consumeSkillUp(), true);
    input._keyDownHandler(ev('o', 'KeyO'));
    assert.equal(input.consumeTeleport(), true);
    input._keyUpHandler(ev('o', 'KeyO'));
    assert.equal(input.consumeTeleportUp(), true);
    input._keyDownHandler(ev('p', 'KeyP'));
    assert.equal(input.consumeTargetCastDirection(), 0);
    input._keyDownHandler(ev('l', 'KeyL'));
    assert.equal(input.consumeUltimate(), true);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('mobile joystick cursor only flashes after target casts', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDateNow = Date.now;

  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = {
    getElementById(id) {
      if (id !== 'leftJoystickContainer') return null;
      return {
        offsetParent: {},
        getBoundingClientRect: () => ({ left: 100, right: 200, top: 300, bottom: 400 })
      };
    }
  };
  globalThis.localStorage = { getItem: () => 'true' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 1 }
  });

  try {
    const input = new Input();
    input.joystickEnabled = true;
    input.hasMouseInput = false;
    input.mouse = { x: 120, y: 180 };

    assert.equal(input.getCursorPos(1000), null);

    input.targetCursorVisibleUntil = 1100;
    assert.deepEqual(input.getCursorPos(1050), { x: 120, y: 180 });
    assert.equal(input.getCursorPos(1101), null);

    input.hasMouseInput = true;
    assert.deepEqual(input.getCursorPos(1101), { x: 120, y: 180 });

    Date.now = () => 2000;
    input._markTouchInput();
    Date.now = () => 2200;
    assert.equal(input._isSyntheticTouchMouseEvent(), true);
    Date.now = () => 2701;
    assert.equal(input._isSyntheticTouchMouseEvent(), false);
    assert.equal(input._isSyntheticTouchMouseEvent({ sourceCapabilities: { firesTouchEvents: true } }), true);

    assert.equal(input._isMobileControlTarget({ closest: () => ({}) }), true);
    assert.equal(input._isMobileControlTarget({ closest: () => null }), false);
    assert.equal(input._isMobileControlPoint(150, 350), true);
    assert.equal(input._isMobileControlPoint(250, 350), false);
  } finally {
    Date.now = originalDateNow;

    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;

    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;

    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;

    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('mobile action buttons act as release-fire aim joysticks', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = { getElementById: () => null };
  globalThis.localStorage = { getItem: () => 'true' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 1 }
  });

  try {
    const input = new Input();
    const button = {
      style: {},
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 60, height: 60 })
    };
    const topButton = {
      style: {},
      classList: { contains: name => name === 'mobile-action-top' },
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 60, height: 60 })
    };

    input._beginSkillAimJoystick(button, { pointerId: 7, clientX: 130, clientY: 130 });
    assert.equal(input.isSkillAimActive, true);
    assert.equal(input.skillAimPointerId, 7);

    input._moveSkillAimJoystick(button, { clientX: 190, clientY: 130 });
    assert.equal(input.aimAngle, 0);
    assert.match(button.style.transform, /translate\(/);

    input._moveSkillAimJoystick(button, { clientX: 130, clientY: 190 });
    assert.ok(Math.abs(input.aimAngle - Math.PI / 2) < 1e-6);

    input._resetSkillAimJoystick(button);
    assert.equal(input.isSkillAimActive, false);
    assert.equal(input.skillAimPointerId, null);
    assert.equal(button.style.transform, '');

    input._beginSkillAimJoystick(topButton, { pointerId: 8, clientX: 130, clientY: 130 });
    input._moveSkillAimJoystick(topButton, { clientX: 130, clientY: 70 });
    assert.match(topButton.style.transform, /translate\(/);

    input._requestTargetCastDirection(Math.PI / 4);
    assert.equal(input.consumeTargetCastDirection(), Math.PI / 4);
    assert.equal(input.consumeTargetCastDirection(), null);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;

    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;

    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;

    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('mobile movement stick drives aim without cancelling jump, and attack button fires basic attack', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const elements = {};
  const windowListeners = {};

  const makeEl = (rect) => ({
    style: {},
    classList: { contains: () => false },
    addEventListener: (type, handler) => { elements[rect.id].listeners[type] = handler; },
    removeEventListener: () => {},
    setPointerCapture: () => {},
    getBoundingClientRect: () => rect
  });

  [
    { id: 'leftJoystickContainer', left: 20, top: 400, width: 100, height: 100 },
    { id: 'leftJoystickKnob', left: 50, top: 430, width: 40, height: 40 },
    { id: 'attackBtn', left: 700, top: 500, width: 58, height: 58 }
  ].forEach(rect => {
    elements[rect.id] = { listeners: {} };
    elements[rect.id].el = makeEl(rect);
  });

  globalThis.window = {
    innerWidth: 800,
    innerHeight: 600,
    PointerEvent: function PointerEvent() {},
    addEventListener: (type, handler) => { windowListeners[type] = handler; },
    removeEventListener: () => {}
  };
  globalThis.document = {
    addEventListener: () => {},
    getElementById: id => elements[id]?.el || null
  };
  globalThis.localStorage = { getItem: () => 'true' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 1 }
  });

  const canvas = {
    width: 800,
    height: 600,
    style: {},
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };
  const event = {
    pointerId: 5,
    pointerType: 'touch',
    clientX: 670,
    clientY: 450,
    cancelable: true,
    preventDefault: () => {},
    stopPropagation: () => {}
  };

  try {
    const input = new Input();
    input.setupListeners(canvas);
    input.keys.w = true;

    elements.leftJoystickContainer.listeners.pointerdown({ ...event, clientX: 70, clientY: 450 });
    windowListeners.pointermove({ ...event, clientX: 120, clientY: 450 });
    assert.equal(input.keys.d, true);
    assert.equal(input.keys.w, true);
    windowListeners.pointerup({ ...event, clientX: 120, clientY: 450 });
    assert.equal(input.consumeBasicAttack(), false);
    assert.equal(input.keys.d, false);
    assert.equal(input.keys.w, true);
    assert.equal(input.aimAngle, 0);

    elements.attackBtn.listeners.pointerdown({ ...event, pointerId: 6, clientX: 730, clientY: 530 });
    assert.equal(input.consumeBasicAttack(), true);
    assert.equal(input.consumeBasicAttack(), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;

    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;

    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;

    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('mobile sniper R arms target mode without acting as an aim joystick', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const listeners = {};
  const altSkillBtn = {
    style: {},
    addEventListener: (type, handler) => { listeners[type] = handler; },
    setPointerCapture: () => {}
  };
  const canvas = {
    width: 800,
    height: 600,
    style: {},
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };

  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = {
    addEventListener: () => {},
    getElementById: id => id === 'altSkillBtn' ? altSkillBtn : null
  };
  globalThis.localStorage = { getItem: () => 'true' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 1 }
  });

  try {
    const input = new Input();
    input.setLocalWeapon('sniper');
    input.aimAngle = 0.25;
    input.setupListeners(canvas);

    const event = {
      pointerId: 11,
      pointerType: 'touch',
      clientX: 130,
      clientY: 130,
      cancelable: true,
      preventDefault: () => {},
      stopPropagation: () => {}
    };

    listeners.pointerdown(event);
    assert.equal(input.isSkillAimActive, false);
    assert.equal(input.skillAimButton, null);

    listeners.pointermove({ ...event, clientX: 230, clientY: 130 });
    assert.equal(input.aimAngle, 0.25);

    listeners.pointerup({ ...event, clientX: 230, clientY: 130 });
    assert.equal(input.teleportRequested, true);
    assert.equal(input.pointerTargetMode, 'sniperTeleport');
    assert.equal(input.targetCastDirectionRequested, false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;

    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;

    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;

    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});
