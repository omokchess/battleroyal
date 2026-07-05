/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_COSTUMES = [
  { id: 'default', name: '기본', price: 0, color: 'hsl(190, 85%, 52%)', accent_color: 'hsl(10, 85%, 65%)', sort_order: 0 },
  { id: 'crimson', name: '크림슨', price: 100, color: 'hsl(350, 85%, 55%)', accent_color: 'hsl(170, 85%, 65%)', sort_order: 1 },
  { id: 'emerald', name: '에메랄드', price: 150, color: 'hsl(150, 80%, 45%)', accent_color: 'hsl(330, 85%, 65%)', sort_order: 2 },
  { id: 'gold', name: '골드', price: 300, color: 'hsl(45, 90%, 55%)', accent_color: 'hsl(225, 85%, 65%)', sort_order: 3 },
  { id: 'violet', name: '바이올렛', price: 300, color: 'hsl(270, 80%, 60%)', accent_color: 'hsl(90, 85%, 65%)', sort_order: 4 },
  { id: 'shadow', name: '섀도우', price: 500, color: 'hsl(220, 15%, 32%)', accent_color: 'hsl(40, 90%, 60%)', sort_order: 5 },
];

const costumeItems = DEFAULT_COSTUMES.map(c => ({
  id: `costume:${c.id}`,
  category: 'costume',
  name: c.name,
  price: c.price,
  data: { color: c.color, accentColor: c.accent_color },
  unlock_type: 'coin',
  unlock_threshold: 0,
  sort_order: c.sort_order,
}));

export const WEAPON_LIST = ['axe','bow','chakram','crossbow','dagger','flamethrower','greatsword','guardian','hammer','harpoon','katana','magicstaff','rapier','scythe','sniper','spear','sword'];

export const WEAPON_SKIN_DEFS = [
  { id: 'ember', name: '불꽃', price: 30, tint: '#ff3d3d' },
  { id: 'frost', name: '서리', price: 30, tint: '#5fd3ff' },
  { id: 'void', name: '보이드', price: 80, tint: '#b14bff' },
];

const weaponSkinItems = WEAPON_SKIN_DEFS.flatMap((sk, si) =>
  WEAPON_LIST.map((wpn, wi) => ({
    id: `weaponskin:${wpn}:${sk.id}`,
    category: 'weaponskin',
    name: `${wpn} - ${sk.name}`,
    price: sk.price,
    data: { weapon: wpn, skin: sk.id, tint: sk.tint },
    unlock_type: 'coin',
    unlock_threshold: 0,
    sort_order: si * 100 + wi,
  }))
);

export const DEFAULT_ITEMS = [
  ...costumeItems,
  // weaponSkinItems removed from the shop (weapons are now the workshop/무기 tab).
  // Kept exported for back-compat with any existing owned/equipped skin data.
  { id: 'killfx:none', category: 'killfx', name: '기본', price: 0, data: {}, unlock_type: 'coin', unlock_threshold: 0, sort_order: 0 },
  { id: 'killfx:firework', category: 'killfx', name: '폭죽', price: 300, data: { style: 'firework', color: '#ffd24a' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 1 },
  { id: 'killfx:skull', category: 'killfx', name: '픽셀 해골', price: 450, data: { style: 'skull', color: '#e5e7eb' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 2 },
  { id: 'killfx:coins', category: 'killfx', name: '코인 분수', price: 600, data: { style: 'coins', color: '#fbbf24' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 3 },
  { id: 'dashtrail:none', category: 'dashtrail', name: '기본', price: 0, data: {}, unlock_type: 'coin', unlock_threshold: 0, sort_order: 0 },
  { id: 'dashtrail:flame', category: 'dashtrail', name: '불꽃', price: 200, data: { color: '#ff7a3d' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 1 },
  { id: 'dashtrail:spark', category: 'dashtrail', name: '번개', price: 200, data: { color: '#7dd3fc' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 2 },
  { id: 'dashtrail:star', category: 'dashtrail', name: '픽셀 별', price: 400, data: { color: '#fde047' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 3 },
  { id: 'respawnfx:none', category: 'respawnfx', name: '기본', price: 0, data: {}, unlock_type: 'coin', unlock_threshold: 0, sort_order: 0 },
  { id: 'respawnfx:warp', category: 'respawnfx', name: '워프', price: 250, data: { color: '#67e8f9' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 1 },
  { id: 'respawnfx:phoenix', category: 'respawnfx', name: '불사조', price: 500, data: { color: '#ff8a3d' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 2 },
  { id: 'title:none', category: 'title', name: '없음', price: 0, data: { text: '' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 0 },
  { id: 'title:rookie', category: 'title', name: '루키', price: 100, data: { text: '루키', color: '#9ca3af' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 1 },
  { id: 'title:gladiator', category: 'title', name: '글래디에이터', price: 300, data: { text: '글래디에이터', color: '#facc15' }, unlock_type: 'coin', unlock_threshold: 0, sort_order: 2 },
  { id: 'title:slayer', category: 'title', name: '학살자', price: 0, data: { text: '학살자', color: '#f87171' }, unlock_type: 'achievement', unlock_threshold: 100, sort_order: 3 },
  { id: 'title:legend', category: 'title', name: '전설', price: 0, data: { text: '전설', color: '#a855f7' }, unlock_type: 'achievement', unlock_threshold: 500, sort_order: 4 },
];

export function defaultItemById(id) {
  return DEFAULT_ITEMS.find(i => i.id === id) || null;
}
