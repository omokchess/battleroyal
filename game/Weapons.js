/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Base weapon roster. Only two built-ins remain — 검(sword) and 대검(greatsword).
 * Every other weapon was removed on purpose: user-made workshop weapons
 * (Tier 2, envelope-clamped) are the live catalogue now. Weapon-specific code
 * paths for the removed weapons may still exist in Game.js/Renderer.js but are
 * unreachable (no config → never selectable).
 */

// Global Weapon Configurations
export const Weapons = {
  sword: {
    name: '검',
    damage: 25,    // 밸런스의 영점 (DPS 48) — 모든 무기는 이 무기 대비 장단점이 명확
    maxHp: 120,
    cooldown: 520, // milliseconds
    moveSpeed: 1.1,
    range: 70,     // pixels
    angle: 110,    // degrees
    type: 'melee_arc',
    hitMode: 'melee_blade_sweep',  // hit along the swept blade, like the greatsword
    bladeHalfWidth: 12,
    description: '공수 밸런스가 뛰어난 기준점 무기입니다. 상태이상이나 조건부 보상은 없지만 모든 면이 안정적입니다.',
    skill: 'F: 0.25초 간격으로 검기 3회 발사(직격 24, 폭발 20/반경 70) · 쿨타임 4초\nR: 회전 베기(22 피해, 360도, 넉백) · 쿨타임 4.5초\nLMB: 전방 돌진 찌르기(30 피해, 사거리 115px, 넉백) · 쿨타임 4초',
    color: '#45f3ff'
  },
  greatsword: {
    name: '대검',
    damage: 38,
    maxHp: 140,
    cooldown: 900,
    automaticAttack: false,
    moveSpeed: 0.82,
    range: 88,
    angle: 210,
    fixedSwingDirection: 1,
    type: 'melee_arc',
    description: '평타 없이 F 차징으로만 공격하는 중량 무기입니다. 차징 시간에 따라 15~75 피해를 주고, 풀차징(1초) 명중 시 둔화까지 겁니다.',
    skill: 'F: 홀드 최대 1초 차징 후 강베기(15~75 피해, 풀차징 시 0.8초 둔화) · 쿨타임 0.8초\nR: 내려찍기(42 피해 + 충격파 34, 0.45초 기절, 넉백) · 쿨타임 5초\nLMB: 묵직한 직선 베기(58 피해, 사거리 165px, 지연 타격+넉백) · 쿨타임 6초',
    color: '#8bd3ff'
  }
};

// --- Dash (Shift) tuning ------------------------------------------------------
// All values are easy to retune here without touching game logic.
export const DashConfig = {
  distance: 130,                  // px travelled during a dash
  durationMs: 160,                // dash movement window
  iframeFrames: 13,               // invincibility expressed in 60fps frames
  iframeMs: (13 / 60) * 1000,     // ≈ 216.7 ms of invulnerability
  cooldownMs: 900
};

// Derived once so both host and client share the exact same burst speed.
DashConfig.speed = DashConfig.distance / (DashConfig.durationMs / 1000); // px/s

// --- Per-weapon F skill tuning ----------------------------------------------
export const SkillConfig = {
  sword: {
    cooldownMs: 4000,
    waveSpeed: 800,        // sword-energy projectile speed (px/s)
    waveCount: 3,
    waveIntervalMs: 250,
    directDamage: 24,      // damage on direct contact
    explosionRadius: 70,   // explosion AoE radius (px)
    explosionDamage: 20    // explosion AoE damage
  },
  greatsword: {
    cooldownMs: 800,
    chargeMaxMs: 1000,
    chargeThreshold: 0.5,
    minDamage: 15,         // bumped from 1 so a short charge is still a real option
    thresholdDamage: 38,
    damage: 75,
    fullChargeSlowMs: 800, // full-charge hit also slows
    // Hit only along the swept blade (its arc band + blade thickness), not the
    // whole fan — the visual cleave arc and the hit test now match. The reach is
    // scaled by charge (see _releaseGreatswordCharge) so a half charge cuts only
    // as far as its preview shows.
    type: 'melee_blade_sweep',
    range: 128,
    angle: 210,
    bladeHalfWidth: 18,
    delayDamageMs: 70,
    attackLockMs: 800,
    knockback: 82
  }
};

// --- Automatic attack combo tuning -----------------------------------------
export const ComboConfig = {
  sword: {
    cycle: 4,
    delayAfterStep: 3,
    delayBeforeFinisherMs: 880,
    comboResetMs: 2600,
    finisher: {
      type: 'melee_arc',
      damage: 28,
      range: 78,
      angle: 360,
      cooldown: 760
    }
  },
  greatsword: {
    cycle: 3,
    delayAfterStep: 2,
    delayBeforeFinisherMs: 620,
    comboResetMs: 2400,
    finisher: {
      type: 'projectile',
      damage: 25,
      range: 185,
      speed: 760,
      radius: 28,
      projectileKind: 'greatswordwave',
      projectileWeapon: 'greatsword',
      cooldown: 760
    }
  }
};

// --- Magic staff spell tuning (unused — magicstaff removed; kept so imports
// and optional-chained HUD reads stay valid) ---------------------------------
export const MagicConfig = {
  cooldownMs: 2000,
  fireball:  {},
  iceShard:  {},
  lifebound: {}
};

// --- R / LMB auxiliary skill tuning ----------------------------------------
// `alt` is bound to R. `target` is bound to LMB / target-cast.
export const AuxSkillConfig = {
  sword: {
    alt: { label: '회전 베기', cooldownMs: 4500, type: 'melee_circle', damage: 22, range: 74, angle: 360, knockback: 22 },
    target: { label: '돌진 찌르기', cooldownMs: 4000, type: 'melee_line', damage: 30, range: 115, width: 28, lungeDistance: 28, knockback: 28 }
  },
  greatsword: {
    alt: { label: '내려찍기', cooldownMs: 5000, type: 'melee_slam', damage: 42, shockwaveDamage: 34, range: 96, innerRange: 50, knockback: 92, stunMs: 450 },
    target: { label: '직선 베기', cooldownMs: 6000, type: 'melee_heavy_line', damage: 58, range: 165, width: 34, delayDamageMs: 120, knockback: 70 }
  }
};

/**
 * Resolve a weapon's *effective* combat stats given an active skill buff.
 * Always returns a fresh object so callers never mutate the base config.
 *
 * @param {string} weaponKey
 * @param {string|null} buffType  (no built-in buff weapons remain — workshop
 *                                gimmicks drive their own effective stats)
 */
export function getEffectiveWeapon(weaponKey, buffType = null) {
  const base = Weapons[weaponKey] || Weapons.sword;
  return base;
}
