/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where the dedicated game server lives. Overridable at build time with
 * VITE_GAME_SERVER (e.g. wss://pixelroyale-server.fly.dev), and — for the
 * competition-day local demo — with a ws://localhost address so the whole match
 * runs on the presentation machine with no venue Wi-Fi in the loop.
 *
 * Default: same host as the page, port 8787 (matches server/index.mjs).
 */

const DEFAULT_PORT = 8787;
const PRODUCTION_SERVER = 'wss://craftroyale-game-server.fly.dev';

export function serverUrlFor(locationLike = null, configuredUrl = null) {
  if (configuredUrl) return String(configuredUrl).replace(/\/+$/, '');
  const hostname = String(locationLike?.hostname || '');
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return `ws://localhost:${DEFAULT_PORT}`;
  }
  return PRODUCTION_SERVER;
}

/** Base ws(s):// URL of the game server. */
export function gameServerUrl() {
  // Vite statically replaces import.meta.env.* at build time.
  let fromEnv = null;
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      fromEnv = import.meta.env.VITE_GAME_SERVER || null;
    }
  } catch { /* import.meta unavailable (plain Node) */ }
  return serverUrlFor(typeof location !== 'undefined' ? location : null, fromEnv);
}

/** Base http(s):// URL for the lobby list / health, derived from the ws URL. */
export function gameServerHttpUrl() {
  return gameServerUrl().replace(/^ws/, 'http');
}
