/**
 * Deterministic pseudo-random numbers.
 *
 * Every stochastic demonstration (radioactive decay, gas packing, Monte-Carlo
 * titration noise) draws from a seeded generator so an experiment can be
 * replayed exactly and a failing test can be reproduced.
 */

export type Rng = () => number;

/** mulberry32 — 32-bit state, period 2³², fine for educational sampling. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function randomNormal(rng: Rng, mean = 0, sd = 1): number {
  // Box–Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Maxwell–Boltzmann speed sampler for one Cartesian component (Gaussian). */
export function maxwellComponent(rng: Rng, thermalSpeed: number): number {
  return randomNormal(rng, 0, thermalSpeed);
}

export function pickFrom<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** Hash a string into a 32-bit seed so named experiments are reproducible. */
export function seedFromString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
