/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The simulation's two ambient dependencies, made injectable.
 *
 * Phase 0 of the host-authoritative → server-authoritative move. The sim must
 * be reproducible and must not read global state, so it never calls
 * `Math.random()` or `Date.now()` directly:
 *
 *   - randomness → `this.rng()`   (seeded, so a match can be replayed)
 *   - wall clock → `this.now()`   (injectable, so tests can step time)
 *
 * Render-only juice (hit sparks, death bursts) deliberately keeps using
 * `Math.random()`: it never touches simulation state, so seeding it would only
 * make particles correlate across clients for no benefit.
 */

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG. Returns a function
 * yielding floats in [0, 1), like `Math.random`, but driven by `seed`.
 *
 * Chosen over an LCG because the low bits of a naive LCG are badly non-random,
 * and the sim uses `rng()` for things like `Math.floor(rng() * n)`.
 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;   // a zero seed would make mulberry32 degenerate
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random 32-bit seed, for when nobody supplied one (a fresh local match). */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Real wall clock. */
export const SystemClock = {
  now: () => Date.now(),
};

/**
 * Manually advanced clock for deterministic tests and for a server that wants
 * to drive the sim from its own fixed-tick accumulator.
 */
export class FixedClock {
  constructor(startMs = 0) { this.t = startMs; }
  now() { return this.t; }
  advance(ms) { this.t += ms; return this.t; }
}
