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

test('importWorkshopWeapon migrates a browsed (V1) weapon into the local armory', () => {
  const before = S.loadWorkshopWeaponsV2().length;
  S.importWorkshopWeapon({ name: '남의검', stats: { damage: 25 }, motionSet: { attack: { keyframes: [{ t: 0, pose: {} }] } } });
  const all = S.loadWorkshopWeaponsV2();
  assert.equal(all.length, before + 1);
  assert.equal(all[all.length - 1].schemaVersion, 2);
});
