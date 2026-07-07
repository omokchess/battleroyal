/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 방 커스텀 설정(roomConfig)의 단일 소스.
 *
 * 모든 기본값은 "현행과 동일"하게 맞춰져 있어, 설정을 건드리지 않으면 게임은
 * 지금과 똑같이 동작한다(중형 맵 1000, 용암/엄폐물/회복 전부 OFF).
 *
 * 설계 원칙:
 *  - 호스트가 roomConfig 를 들고, ROOM_JOINED 으로 참가자에게 전달한다.
 *  - 네트워크로 들어온 값은 신뢰하지 않으므로 normalizeRoomConfig() 로 항상 정규화.
 *  - 이후 설정 항목 추가는 이 파일의 표 + DEFAULT_ROOM_CONFIG 한 곳만 늘리면 된다.
 */

// 경기장 크기 프리셋 → 한 변 픽셀. Platformer pivot now standardizes on
// one balanced medium arena; old presets remain only in git history.
export const ARENA_SIZES = {
  medium: 1000
};

export const ARENA_LABELS = {
  medium: '중형'
};

// 엄폐물 밀도 프리셋. 실제 타일 개수는 작업 9에서 경기장 크기와 함께 계산.
// 여기 값은 "기준 면적(700²)당 타일 수" 가중치로만 사용한다.
export const COVER_DENSITY = {
  none: 0,
  few:  6,
  some: 12,
  many: 20
};

export const COVER_LABELS = {
  none: '없음', few: '적음', some: '보통', many: '많음'
};

export const PLATFORM_DENSITY = {
  none: 0,
  few:  2,
  some: 4,
  many: 6
};

export const PLATFORM_LABELS = {
  none: '없음', few: '적음', some: '보통', many: '많음'
};

export const PLATFORM_SHAPES = {
  balanced: '균형형',
  stairs: '계단형',
  towers: '타워형'
};

// 회복 아이템 스폰 주기(ms). 작업 9에서 사용.
export const HEAL_RATES = {
  fast:   8000,
  normal: 15000,
  slow:   26000
};

export const HEAL_RATE_LABELS = {
  fast: '빠름', normal: '보통', slow: '느림'
};

// 지형(바이옴) 프리셋. 시각 테마(바닥 색/분위기)를 바꾸며, 'snow' 에서는 물이
// 얼어 이동 차단이 사라진다(위로 걸어다닐 수 있음). 'day' = 현행 초록 들판.
export const BIOME_LABELS = {
  day: '낮', night: '밤', dawn: '새벽', desert: '사막', snow: '눈'
};

// 기본값 = 현행 동작.
export const DEFAULT_ROOM_CONFIG = Object.freeze({
  arenaSize: 'medium',
  storm: false,
  cover: 'none',
  platforms: 'some',
  platformShape: 'balanced',
  healing: false,
  healingRate: 'normal',
  biome: 'day',
  water: false,
  // Tier-2 공방 무기는 사용자 창작 무기 중심 구조라 항상 허용한다.
  allowWorkshop: true
});

const oneOf = (value, table, fallback) =>
  (Object.prototype.hasOwnProperty.call(table, value) ? value : fallback);

/**
 * 임의 입력(로컬 UI 또는 네트워크 수신)을 안전한 roomConfig 로 정규화.
 * 알 수 없는 값은 기본값으로 대체한다.
 */
export function normalizeRoomConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    arenaSize:   oneOf(c.arenaSize, ARENA_SIZES, DEFAULT_ROOM_CONFIG.arenaSize),
    // Lava/storm pressure was removed from live rules. Keep the field in the
    // wire shape for backward compatibility, but never allow it to turn on.
    storm:       false,
    cover:       oneOf(c.cover, COVER_DENSITY, DEFAULT_ROOM_CONFIG.cover),
    platforms:   oneOf(c.platforms, PLATFORM_DENSITY, DEFAULT_ROOM_CONFIG.platforms),
    platformShape: oneOf(c.platformShape, PLATFORM_SHAPES, DEFAULT_ROOM_CONFIG.platformShape),
    healing:     Boolean(c.healing),
    healingRate: oneOf(c.healingRate, HEAL_RATES, DEFAULT_ROOM_CONFIG.healingRate),
    biome:       oneOf(c.biome, BIOME_LABELS, DEFAULT_ROOM_CONFIG.biome),
    water:       Boolean(c.water),
    allowWorkshop: true
  };
}

/** roomConfig → 맵 크기. 정사각형이라 width === height. */
export function arenaDimensions(config) {
  const cfg = normalizeRoomConfig(config);
  const side = ARENA_SIZES[cfg.arenaSize];
  return { mapWidth: side, mapHeight: side };
}

/**
 * 로비 방 목록에 띄울 짧은 배지 라벨 배열.
 * 예: ['자기장', '엄폐물 많음', '플랫폼 많음', '회복']
 */
export function roomConfigBadges(config) {
  const cfg = normalizeRoomConfig(config);
  const badges = [];
  if (cfg.biome !== 'day') badges.push(BIOME_LABELS[cfg.biome]);
  if (cfg.cover !== 'none') badges.push(`엄폐물 ${COVER_LABELS[cfg.cover]}`);
  if (cfg.platforms !== 'none') badges.push(`플랫폼 ${PLATFORM_LABELS[cfg.platforms]}`);
  if (cfg.water) badges.push('물');
  if (cfg.healing) badges.push('회복');
  return badges;
}
