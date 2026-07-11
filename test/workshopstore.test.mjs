import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// Minimal localStorage shim for the store module (browser-only otherwise).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const S = await import('../game/WorkshopStore.js');
const Images = await import('../game/WeaponImages.js');
const { makeEmptyWeaponV2 } = await import('../game/Workshop.js');

beforeEach(() => mem.clear());

test('saveWorkshopWeaponLocal upserts locally and does NOT publish', () => {
  const w = makeEmptyWeaponV2({ name: '검' });
  const saved = S.saveWorkshopWeaponLocal(w);
  const all = S.loadWorkshopWeaponsV2();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, saved.id);
  // Re-saving the same id upserts (no duplicate).
  S.saveWorkshopWeaponLocal({ ...saved, name: '검2' });
  const all2 = S.loadWorkshopWeaponsV2();
  assert.equal(all2.length, 1);
  assert.equal(all2[0].name, '검2');
});

test('equip round-trips + game runtime shape derives from basic preset', () => {
  const w = makeEmptyWeaponV2({ name: '창' });
  S.saveWorkshopWeaponLocal(w);
  S.equipWorkshopWeaponLocal(w.id);
  assert.equal(S.equippedWorkshopWeaponId(), w.id);
  const v2 = S.equippedWorkshopWeaponV2();
  assert.equal(v2.id, w.id);
  // Legacy runtime shape for Game/Player/Motion.
  const rt = S.equippedWorkshopWeapon();
  assert.ok(rt.stats && typeof rt.stats.maxHp === 'number', 'has V1 stats');
  assert.ok(rt.motionSet, 'has motionSet');
  S.unequipWorkshopWeapon();
  assert.equal(S.equippedWorkshopWeapon(), null);
});

test('offline save works; an id-map keeps multiple weapons', () => {
  const a = S.saveWorkshopWeaponLocal(makeEmptyWeaponV2({ name: 'A' }));
  const b = S.saveWorkshopWeaponLocal(makeEmptyWeaponV2({ name: 'B' }));
  assert.equal(S.loadWorkshopWeaponsV2().length, 2);
  S.deleteWorkshopWeaponLocal(a.id);
  const rest = S.loadWorkshopWeaponsV2();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].id, b.id);
});

test('legacy V1 equipped weapon is absorbed into the V2 store on first load', () => {
  mem.set('pixelroyale_workshop_equipped_v1', JSON.stringify({
    name: '옛검', stats: { damage: 30, maxHp: 120, moveSpeed: 1.1 },
    motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } },
  }));
  const all = S.loadWorkshopWeaponsV2();
  assert.equal(all.length, 1, 'legacy folded in');
  assert.equal(all[0].schemaVersion, 2);
  assert.equal(all[0].name, '옛검');
  // it becomes the equipped weapon
  const rt = S.equippedWorkshopWeapon();
  assert.ok(rt && rt.stats, 'legacy is equipped after absorb');
  assert.equal(mem.get('pixelroyale_workshop_equipped_v1'), undefined, 'legacy key cleared');
});

test('importWorkshopWeapon migrates a browsed (V1) weapon into the local armory', async () => {
  const before = S.loadWorkshopWeaponsV2().length;
  await S.importWorkshopWeapon({ name: '남의검', stats: { damage: 25 }, motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } } });
  const all = S.loadWorkshopWeaponsV2();
  assert.equal(all.length, before + 1);
  assert.equal(all[all.length - 1].schemaVersion, 2);
});

test('importWorkshopWeapon preserves long published ids so similar weapons do not overwrite', async () => {
  const prefix = 'firebase_user_uid_with_long_prefix_1234567890_';
  await S.importWorkshopWeapon({ id: prefix + 'alpha-blade', schemaVersion: 2, name: 'A', presets: { basic: { kind: 'basic', motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 12 } } } });
  await S.importWorkshopWeapon({ id: prefix + 'alpha-burst', schemaVersion: 2, name: 'B', presets: { basic: { kind: 'basic', motion: { keyframes: [{ t: 0, pose: {} }] }, combat: { damage: 14 } } } });
  const ids = S.loadWorkshopWeaponsV2().map(w => w.id);
  assert.ok(ids.includes(prefix + 'alpha-blade'));
  assert.ok(ids.includes(prefix + 'alpha-burst'));
  assert.equal(new Set(ids).size, 2);
});

test('saveWorkshopWeaponLocal throws when local storage write fails', () => {
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  try {
    assert.throws(() => S.saveWorkshopWeaponLocal(makeEmptyWeaponV2({ name: '저장실패' })), /저장/);
  } finally {
    globalThis.localStorage.setItem = original;
  }
});

test('importWorkshopWeapon stores received pixels outside the localStorage quota', async () => {
  const w = makeEmptyWeaponV2({ name: '장식검' });
  w.weaponVisual = {
    imageId: 'custom:main',
    dual: true,
    offhand: { imageId: 'custom:off', scale: 1.2 },
    hats: [
      { imageId: 'custom:hat-a', name: '장식A', scale: 1, offsetX: 0, offsetY: 0 },
      { imageId: 'custom:hat-b', name: '장식B', scale: 1, offsetX: 4, offsetY: -8 },
    ],
  };
  w.presets.basic.effects = [{ time: 0.1, assetId: 'custom:fx-a', x: 0, y: 0, scale: 1, alpha: 1 }];
  await S.importWorkshopWeapon({
    ...w,
    weaponImage: { id: 'custom:main', name: 'main', src: 'data:image/png;base64,main', size: 2 },
    offhandImage: { id: 'custom:off', name: 'off', src: 'data:image/png;base64,off', size: 1 },
    hatImages: [
      { id: 'custom:hat-a', name: 'hatA', src: 'data:image/png;base64,hata', size: 1 },
      { id: 'custom:hat-b', name: 'hatB', src: 'data:image/png;base64,hatb', size: 1 },
    ],
    effectImages: [{ id: 'custom:fx-a', name: 'fxA', src: 'data:image/png;base64,fxa', size: 1 }],
  });
  for (const id of ['custom:main', 'custom:off', 'custom:hat-a', 'custom:hat-b', 'custom:fx-a']) {
    assert.equal(Images.getCustomWeaponRecord(id)?.id, id, `${id} image record imported`);
  }
  assert.equal(mem.get('psd_custom_weapons'), '[]', 'received image blobs do not consume localStorage');
  const saved = S.loadWorkshopWeaponsV2()[0];
  assert.equal(saved.weaponVisual.hats.length, 2);
  assert.equal(saved.presets.basic.effects[0].assetId, 'custom:fx-a');
});

test('v2ToV1Runtime preserves frame projectile/teleport events and visual id', () => {
  const id = 'custom:' + 'x'.repeat(70);
  const offhandId = 'custom:' + 'y'.repeat(70);
  const offhandAnchors = { gx: 0.18, gy: 0.58, tx: 0.82, ty: 0.42 };
  const hats = [
    { imageId: 'custom:hat-a', name: '왕관', scale: 1.2, offsetX: 8, offsetY: -24, alpha: 0.9, rotation: 15, anchorX: 0.4, anchorY: 0.6, anchors: { gx: 0.4, gy: 0.6, tx: 0.9, ty: 0.4 }, layer: 'overWeapon', keys: [{ t: 0.4, offsetX: 12, offsetY: -28, rotation: 45, scale: 1.4, alpha: 0.7 }] },
    { imageId: 'custom:hat-b', name: '깃털', scale: 0.7, offsetX: -10, offsetY: -12, alpha: 0.5, rotation: -20, anchorX: 0.2, anchorY: 0.8, layer: 'behindPlayer', showHandles: false },
  ];
  const w = makeEmptyWeaponV2({ name: '이벤트검' });
  w.weaponVisual = {
    imageId: id,
    scale: 2,
    dual: true,
    offhand: { imageId: offhandId, scale: 1.8, anchors: offhandAnchors },
    hats,
    selectedHat: 1,
    layerOrder: ['player', 'hat:0', 'weapon:left', 'hat:1', 'weapon:right'],
  };
  w.presets.basic.ranged = true;
  w.presets.basic.previewOffset = { x: 24, y: -12 };
  w.presets.basic.motion.keyframes[0].root = { x: 12, y: 8 };
  w.presets.basic.projectile = { imageId: 'bolt', directionSource: 'cursor', speed: 500, lifetimeMs: 500, hitbox: { shape: 'rect', width: 20, height: 10 } };
  w.presets.basic.projectileEvents = [{ time: 0.25, projectile: { imageId: 'bolt', speed: 500 } }];
  w.presets.basic.teleportEvents = [{ time: 0.5, directionSource: 'facing', distance: 120 }];
  const rt = S.v2ToV1Runtime(w);
  assert.equal(rt.weaponVisual.imageId, id);
  assert.equal(rt.weaponVisual.dual, true);
  assert.equal(rt.weaponVisual.offhand.imageId, offhandId);
  assert.equal(rt.weaponVisual.offhand.scale, 1.8);
  assert.deepEqual(rt.weaponVisual.offhand.anchors, offhandAnchors);
  assert.deepEqual(rt.weaponVisual.hats, hats);
  assert.equal(rt.weaponVisual.hat.imageId, 'custom:hat-a');
  assert.equal(rt.weaponVisual.hats[0].keys[0].rotation, 45);
  assert.deepEqual(rt.weaponVisual.hats[0].anchors, { gx: 0.4, gy: 0.6, tx: 0.9, ty: 0.4 });
  assert.equal(rt.weaponVisual.hats[1].showHandles, false);
  assert.equal(rt.weaponVisual.selectedHat, 1);
  assert.deepEqual(rt.weaponVisual.layerOrder, ['player', 'hat:0', 'weapon:left', 'hat:1', 'weapon:right']);
  assert.equal(rt.motionSet.attack.projectileEvents.length, 1);
  assert.equal(rt.motionSet.attack.teleportEvents.length, 1);
  assert.deepEqual(rt.motionSet.attack.previewOffset, { x: 24, y: -12 });
  assert.deepEqual(rt.motionSet.attack.keyframes[0].root, { x: 12, y: 8 });
  assert.equal(rt.ranged, true);
});
