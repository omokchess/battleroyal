import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeRoomConfig,
  arenaDimensions,
  roomConfigBadges,
  DEFAULT_ROOM_CONFIG,
  ARENA_SIZES
} from '../game/RoomConfig.js';

test('normalizeRoomConfig fills defaults for empty / missing input', () => {
  assert.deepEqual(normalizeRoomConfig(undefined), { ...DEFAULT_ROOM_CONFIG });
  assert.deepEqual(normalizeRoomConfig(null), { ...DEFAULT_ROOM_CONFIG });
  assert.deepEqual(normalizeRoomConfig({}), { ...DEFAULT_ROOM_CONFIG });
});

test('normalizeRoomConfig rejects unknown enum values (anti-cheat on network input)', () => {
  const c = normalizeRoomConfig({ arenaSize: 'gigantic', cover: 'hax', platforms: 'hax', platformShape: 'maze', healingRate: 'instant', storm: 'yes' });
  assert.equal(c.arenaSize, 'medium');     // unknown → default
  assert.equal(c.cover, 'none');
  assert.equal(c.platforms, 'some');
  assert.equal(c.platformShape, 'balanced');
  assert.equal(c.healingRate, 'normal');
  assert.equal(c.storm, false);          // lava/storm is removed from live rules
  assert.equal(normalizeRoomConfig({ allowWorkshop: false }).allowWorkshop, true);
});

test('normalizeRoomConfig keeps valid values', () => {
  const c = normalizeRoomConfig({ arenaSize: 'medium', storm: true, cover: 'many', platforms: 'few', platformShape: 'stairs', healing: true, healingRate: 'fast' });
  assert.deepEqual(c, { ...DEFAULT_ROOM_CONFIG, storm: false, cover: 'many', platforms: 'few', platformShape: 'stairs', healing: true, healingRate: 'fast' });
});

test('arenaDimensions uses the single medium square map', () => {
  assert.deepEqual(arenaDimensions(undefined), { mapWidth: ARENA_SIZES.medium, mapHeight: ARENA_SIZES.medium });
  assert.deepEqual(arenaDimensions({ arenaSize: 'huge' }), { mapWidth: ARENA_SIZES.medium, mapHeight: ARENA_SIZES.medium });
});

test('roomConfigBadges shows visible gameplay toggles only', () => {
  assert.deepEqual(roomConfigBadges({}), ['플랫폼 보통']);
  assert.deepEqual(
    roomConfigBadges({ arenaSize: 'medium', storm: true, cover: 'many', platforms: 'many', healing: true }),
    ['엄폐물 많음', '플랫폼 많음', '회복']
  );
  // cover 'none' must not produce a badge
  assert.deepEqual(roomConfigBadges({ arenaSize: 'small', cover: 'none', platforms: 'none' }), []);
});
