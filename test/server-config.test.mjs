import test from 'node:test';
import assert from 'node:assert/strict';

import { serverUrlFor } from '../multiplayer/serverConfig.js';

test('production hosting always targets the Fly game server', () => {
  assert.equal(serverUrlFor({ hostname: 'pixelroyale-2aa32.web.app' }), 'wss://craftroyale-game-server.fly.dev');
});

test('localhost keeps the local demonstration server and env overrides win', () => {
  assert.equal(serverUrlFor({ hostname: 'localhost' }), 'ws://localhost:8787');
  assert.equal(serverUrlFor({ hostname: 'example.com' }, 'wss://custom.example/ws/'), 'wss://custom.example/ws');
});
