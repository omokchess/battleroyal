import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sanitizeMotion, sanitizeMotionSetId, registerMotionSet, hasMotionSet,
  weaponSetId, resolveMotion, MOTION_LIMITS, DEFAULT_MOTION, sampleRootOffset,
  StickAnimator,
} from '../game/Motion.js';

test('sanitizeMotion clamps angles and caps keyframes', () => {
  const huge = { duration: 999, loop: true,
    keyframes: Array.from({ length: 80 }, (_, i) => ({ t: i / 79, pose: { spine: 99999 } })),
    events: [{ t: 0.5, type: 'impact' }] };
  const m = sanitizeMotion(huge);
  assert.ok(m.duration <= MOTION_LIMITS.maxDuration);
  assert.ok(m.keyframes.length <= MOTION_LIMITS.maxKeyframes);
  assert.equal(m.keyframes[0].pose.spine, MOTION_LIMITS.angleMax); // clamped, not 99999
  assert.equal(m.events[0].type, 'impact');
});

test('sanitizeMotion preserves keyframe root offsets and samples them', () => {
  const m = sanitizeMotion({
    duration: 1,
    keyframes: [
      { t: 0, pose: { spine: -90 }, root: { x: -999, y: 10 } },
      { t: 1, pose: { spine: -90 }, root: { x: 100, y: 50 } },
    ],
  });
  assert.equal(m.keyframes[0].root.x, -MOTION_LIMITS.rootOffsetMax);
  assert.equal(m.keyframes[0].root.y, 10);
  const mid = sampleRootOffset(m, 0.5);
  assert.ok(mid.x > -MOTION_LIMITS.rootOffsetMax && mid.x < 100);
  assert.equal(mid.y, 30);
});

test('sanitizeMotion drops unknown joints and invalid events', () => {
  const m = sanitizeMotion({
    duration: 0.4, keyframes: [{ t: 0, pose: { spine: -90, notAJoint: 12 } }],
    events: [{ t: 0.5, type: 'hack' }, { t: 0.2, type: 'sfx' }],
  });
  assert.ok('spine' in m.keyframes[0].pose);
  assert.ok(!('notAJoint' in m.keyframes[0].pose));
  assert.deepEqual(m.events.map(e => e.type), ['sfx']); // 'hack' rejected
});

test('sanitizeMotion falls back to default on garbage', () => {
  for (const bad of [null, undefined, {}, { keyframes: [] }, { keyframes: 'x' }, 42]) {
    const m = sanitizeMotion(bad);
    assert.ok(Array.isArray(m.keyframes) && m.keyframes.length > 0);
    assert.equal(m.duration, DEFAULT_MOTION.duration);
  }
});

test('unknown motion-set id is rejected; weapon fallback resolves', () => {
  assert.equal(sanitizeMotionSetId('does-not-exist'), null);
  assert.equal(sanitizeMotionSetId(123), null);
  assert.equal(sanitizeMotionSetId('default'), 'default');
  // Weapon mapping + resolution always yields a playable motion.
  assert.equal(weaponSetId('greatsword'), 'greatsword');
  assert.equal(weaponSetId('unknownWeapon'), 'default');
  const atk = resolveMotion(weaponSetId('sword'), 'attack');
  assert.ok(atk.keyframes.length > 0);
});

test('registerMotionSet sanitizes incoming data before storing', () => {
  registerMotionSet('user_test', { attack: { duration: 50, keyframes: [{ t: 0, pose: { spine: 99999, bogus: 1 } }] } });
  assert.ok(hasMotionSet('user_test'));
  assert.equal(sanitizeMotionSetId('user_test'), 'user_test');
  const m = resolveMotion('user_test', 'attack');
  assert.ok(m.duration <= MOTION_LIMITS.maxDuration);
  assert.equal(m.keyframes[0].pose.spine, MOTION_LIMITS.angleMax);
  assert.ok(!('bogus' in m.keyframes[0].pose));
  // A state the set doesn't define falls back to the base locomotion.
  assert.ok(resolveMotion('user_test', 'run').keyframes.length > 0);
});

test('registerMotionSet rejects a bad id', () => {
  assert.equal(registerMotionSet('', {}), null);
  assert.equal(registerMotionSet(null, {}), null);
});

// --- T1-C: admin-canonical gameplay fields (dual-trust) ---------------------
const motionWithHitbox = {
  duration: 0.4, keyframes: [{ t: 0, pose: { spine: -90 } }, { t: 1, pose: { spine: -90 } }],
  events: [{ t: 0.5, type: 'impact' }],
  hitboxes: [{ ox: 9999, oy: -9999, w: 0.1, h: 9999, activeStart: 0.8, activeEnd: 0.2 }],
  knockback: 99999,
};

test('gameplay fields are STRIPPED by default (peer/cosmetic path)', () => {
  const m = sanitizeMotion(motionWithHitbox);              // no allowGameplay
  assert.equal(m.hitboxes, undefined);
  assert.equal(m.knockback, undefined);
});

test('gameplay fields are KEPT + clamped on the admin path', () => {
  const m = sanitizeMotion(motionWithHitbox, DEFAULT_MOTION, { allowGameplay: true });
  assert.equal(m.hitboxes.length, 1);
  const hb = m.hitboxes[0];
  assert.ok(Math.abs(hb.ox) <= MOTION_LIMITS.hitboxOffsetMax, 'ox clamped');
  assert.ok(Math.abs(hb.oy) <= MOTION_LIMITS.hitboxOffsetMax, 'oy clamped');
  assert.ok(hb.w >= MOTION_LIMITS.hitboxSizeMin && hb.h <= MOTION_LIMITS.hitboxSizeMax, 'size clamped');
  assert.ok(hb.activeStart <= hb.activeEnd, 'active window ordered');  // swapped from 0.8>0.2
  assert.ok(Number.isFinite(hb.frameTime), 'hitbox keeps a frame marker for editor/runtime display');
  assert.ok(m.knockback <= MOTION_LIMITS.knockbackMax, 'knockback clamped');
});

test('hitbox count is capped and bad entries dropped', () => {
  const many = { duration: 0.4, keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }],
    hitboxes: [null, 'x', {}, { ox: 1 }, { ox: 2 }, { ox: 3 }, { ox: 4 }, { ox: 5 }] };
  const m = sanitizeMotion(many, DEFAULT_MOTION, { allowGameplay: true });
  assert.ok(m.hitboxes.length <= MOTION_LIMITS.maxHitboxes);
});

test('StickAnimator starts remote workshop attack from last motion tag', () => {
  const animator = new StickAnimator();
  const player = {
    id: 'remote',
    weapon: 'sword',
    vx: 0,
    vy: 0,
    grounded: true,
    lastAttackTime: 12345,
    attackMotionTag: null,
    lastAttackMotionTag: 'skill1',
    workshopWeapon: {
      motionSet: {
        skill1: {
          duration: 0.5,
          keyframes: [
            { t: 0, pose: { spine: -90 } },
            { t: 1, pose: { spine: -70 } },
          ],
        },
      },
    },
  };
  const sample = animator.sample(player, 1000);
  assert.equal(sample.motionName, 'skill1');
});

test('StickAnimator samples weapon hand-swap timeline', () => {
  const animator = new StickAnimator();
  const player = {
    id: 'hands',
    weapon: 'sword',
    vx: 0,
    vy: 0,
    grounded: true,
    lastAttackTime: 1000,
    lastAttackMotionTag: 'attack',
    workshopWeapon: {
      motionSet: {
        attack: {
          duration: 1,
          handSwapKeys: [{ time: 0, value: false }, { time: 0.2, value: true }],
          keyframes: [{ t: 0, pose: {} }, { t: 1, pose: {} }],
        },
      },
    },
  };
  animator.sample(player, 1000);
  const sample = animator.sample(player, 1300);
  assert.equal(sample.handSwapped, true);
});
