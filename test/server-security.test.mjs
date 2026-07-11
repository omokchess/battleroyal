import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageGate, validMessage } from '../server/Security.mjs';
import { MsgType, Protocol } from '../multiplayer/Protocol.js';

test('server message schema rejects malformed actions and oversized identity fields', () => {
  assert.equal(validMessage(Protocol.clientAction('basicAttack')), true);
  assert.equal(validMessage({ type: MsgType.PLAYER_ACTION, action: 'adminKill' }), false);
  assert.equal(validMessage({ type: MsgType.PLAYER_AIM, angle: Infinity }), false);
  assert.equal(validMessage({ type: MsgType.JOIN_ROOM, nickname: 'x', idToken: 'x'.repeat(9000) }), false);
});

test('per-type token bucket throttles a burst and refills over time', () => {
  let now = 1000;
  const gate = new MessageGate(() => now);
  const action = Protocol.clientAction('basicAttack');
  let accepted = 0;
  for (let i = 0; i < 50; i++) if (gate.accept(action)) accepted++;
  assert.equal(accepted, 30);
  now += 1000;
  let refilled = 0;
  for (let i = 0; i < 20; i++) if (gate.accept(action)) refilled++;
  assert.equal(refilled, 15);
});
