/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// game packet type labels
export const MsgType = {
  HOST_CREATE_ROOM: 'HOST_CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  ROOM_JOINED: 'ROOM_JOINED',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  HOST_CHANGED: 'HOST_CHANGED',
  PLAYER_INPUT: 'PLAYER_INPUT',
  PLAYER_AIM: 'PLAYER_AIM',
  PLAYER_ACTION: 'PLAYER_ACTION',
  WEAPON_SELECT: 'WEAPON_SELECT',
  GAME_STATE: 'GAME_STATE',
  KILL_EVENT: 'KILL_EVENT',
  LEAVE_ROOM: 'LEAVE_ROOM',
  SERVER_SHUTDOWN: 'SERVER_SHUTDOWN',
  MATCH_RECORDED: 'MATCH_RECORDED',
  PING: 'PING',
  PONG: 'PONG',
  ERROR: 'ERROR'
};

/**
 * Clean serialization wrappers
 */
export const Protocol = {
  // Client registration frame. `costume` (optional) carries the purchased
  // skin colors { color, accentColor } so the host paints this player for everyone.
  // `isMobile` lets the host give touch players the instant-fire sniper/matchlock.
  joinRoom(nickname, weapon, costume = null, isMobile = false, controls = null, identity = null) {
    const msg = { type: MsgType.JOIN_ROOM, nickname, weapon, costume, isMobile: !!isMobile, controls };
    if (identity?.idToken) msg.idToken = String(identity.idToken);
    if (identity?.sessionToken) msg.sessionToken = String(identity.sessionToken);
    return msg;
  },

  // Handshake registration acceptance frame. roomConfig carries the arena-size /
  // storm / cover / healing settings, and coverSeed the per-match seed clients
  // use to regenerate the identical obstacle layout locally, so late-joiners get
  // the exact same arena/rules. weaponMotions carries the host's CANONICAL weapon
  // definitions (incl. hitboxes) so every peer simulates/renders with the same
  // host-authoritative set (T1-F); clients re-sanitize before use.
  roomJoined(id, initialPlayers, mapWidth, mapHeight, roomConfig = null, coverSeed = 0, weaponMotions = null, sessionToken = '', hostId = '') {
    return { type: MsgType.ROOM_JOINED, id, initialPlayers, mapWidth, mapHeight, roomConfig, coverSeed, weaponMotions, sessionToken, hostId };
  },

  // Notify clients of a newcomer
  playerJoined(player) {
    return { type: MsgType.PLAYER_JOINED, player };
  },

  // Broadcast coordinate input maps from client to host
  clientInput(keys) {
    return { type: MsgType.PLAYER_INPUT, keys };
  },

  // Broadcast pointer aim angle
  clientAim(angle) {
    return { type: MsgType.PLAYER_AIM, angle };
  },

  // Discrete one-shot commands (dash / skill). Dash carries the intended
  // movement direction so the host reproduces the client's burst direction.
  clientAction(action, dx = 0, dy = 0, extra = null) {
    const msg = { type: MsgType.PLAYER_ACTION, action };
    if (action === 'dash') {
      msg.dx = dx;
      msg.dy = dy;
    }
    if (extra && typeof extra === 'object') {
      Object.assign(msg, extra);
    }
    return msg;
  },

  // Request a weapon swap (applied on the next respawn).
  selectWeapon(weapon, workshopWeapon = null, label = '') {
    const msg = { type: MsgType.WEAPON_SELECT, weapon };
    if (workshopWeapon && typeof workshopWeapon === 'object') msg.workshopWeapon = workshopWeapon;
    if (label) msg.label = String(label).slice(0, 32);
    return msg;
  },

  leaveRoom() {
    return { type: MsgType.LEAVE_ROOM };
  },

  // System snapshot state. zone (storm) + healingItems are dynamic and ride
  // along here; cover is static and goes in ROOM_JOINED instead.
  gameState(players, projectiles, effects, remainingPlayersCount, zone = null, healingItems = null, mines = null, firePatches = null) {
    return {
      type: MsgType.GAME_STATE,
      players,
      projectiles,
      effects,
      remainingPlayersCount,
      zone,
      healingItems,
      mines,
      firePatches,
      timestamp: Date.now()
    };
  },

  // Kill feed line, broadcast by the host so every peer shows the same notice.
  // `weapon` is the killer's weapon key (for the icon/label); `via` is an
  // optional method label (e.g. '활로'). killerId/victimId let clients highlight
  // their own kills/deaths.
  killEvent(killerId, killerName, victimId, victimName, weapon, via = '', killerTitle = null, victimTitle = null) {
    return {
      type: MsgType.KILL_EVENT,
      killerId, killerName, victimId, victimName, weapon, via,
      killerTitle, victimTitle,
      timestamp: Date.now()
    };
  },

  // Ping frames
  ping(seq) {
    return { type: MsgType.PING, seq };
  },

  pong(seq) {
    return { type: MsgType.PONG, seq };
  }
};
