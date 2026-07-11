/** Server-side wire validation and per-socket token buckets. */

import { MsgType } from '../multiplayer/Protocol.js';

const RULES = Object.freeze({
  [MsgType.JOIN_ROOM]:     { rate: 2, burst: 2 },
  [MsgType.PLAYER_INPUT]:  { rate: 45, burst: 90 },
  [MsgType.PLAYER_AIM]:    { rate: 45, burst: 90 },
  [MsgType.PLAYER_ACTION]: { rate: 15, burst: 30 },
  [MsgType.WEAPON_SELECT]: { rate: 2, burst: 4 },
  [MsgType.PING]:          { rate: 2, burst: 5 },
  [MsgType.LEAVE_ROOM]:    { rate: 1, burst: 2 },
});

const ACTIONS = new Set([
  'dash', 'skill', 'skillDown', 'skillUp', 'teleport', 'teleportUp',
  'basicAttack', 'ultimate', 'targetCast',
]);

export class MessageGate {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.buckets = new Map();
  }

  accept(data) {
    if (!validMessage(data)) return false;
    const rule = RULES[data.type];
    if (!rule) return false;
    const now = this.now();
    const b = this.buckets.get(data.type) || { tokens: rule.burst, at: now };
    b.tokens = Math.min(rule.burst, b.tokens + Math.max(0, now - b.at) * rule.rate / 1000);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(data.type, b); return false; }
    b.tokens -= 1;
    this.buckets.set(data.type, b);
    return true;
  }
}

export function validMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return false;
  switch (data.type) {
    case MsgType.JOIN_ROOM:
      return typeof data.nickname === 'string'
        && data.nickname.length <= 64
        && (data.idToken == null || (typeof data.idToken === 'string' && data.idToken.length <= 8192))
        && (data.sessionToken == null || (typeof data.sessionToken === 'string' && data.sessionToken.length <= 128));
    case MsgType.PLAYER_INPUT:
      return data.keys && typeof data.keys === 'object' && Object.keys(data.keys).length <= 12;
    case MsgType.PLAYER_AIM:
      return Number.isFinite(data.angle) && Math.abs(data.angle) <= Math.PI * 4;
    case MsgType.PLAYER_ACTION:
      return ACTIONS.has(data.action)
        && (data.x == null || Number.isFinite(data.x))
        && (data.y == null || Number.isFinite(data.y))
        && (data.dx == null || Number.isFinite(data.dx))
        && (data.dy == null || Number.isFinite(data.dy));
    case MsgType.WEAPON_SELECT:
      return typeof data.weapon === 'string' && data.weapon.length <= 80;
    case MsgType.PING:
      return Number.isSafeInteger(data.seq) && data.seq >= 0;
    case MsgType.LEAVE_ROOM:
      return true;
    default:
      return false;
  }
}
