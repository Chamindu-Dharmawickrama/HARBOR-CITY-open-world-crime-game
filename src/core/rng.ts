import { fnv1a32, hashCombine } from './hash';

const U32 = 4294967296;

/** Converts a numeric or string seed into a 32-bit seed. */
export function seedFrom(value: number | string): number {
  return typeof value === 'number' ? value >>> 0 : fnv1a32(value);
}

export type RngState = readonly [number, number, number, number];

/**
 * Small, fast, seedable PRNG (sfc32, seeded through splitmix32).
 * Every source of gameplay or generation randomness goes through this class so that
 * runs are reproducible from a seed.
 */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number | string) {
    let s = seedFrom(seed);
    const splitmix = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = splitmix();
    this.b = splitmix();
    this.c = splitmix();
    this.d = splitmix();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** Uniform unsigned 32-bit integer. */
  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / U32;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length)];
  }

  /** Weighted pick; weights need not be normalised. */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) {
      throw new Error('Rng.pickWeighted: items and weights must be non-empty and equal length');
    }
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i]);
      if (roll < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Normally distributed value (Box–Muller). */
  gaussian(mean = 0, stdDev = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  getState(): RngState {
    return [this.a, this.b, this.c, this.d];
  }

  setState(state: RngState): void {
    [this.a, this.b, this.c, this.d] = state;
  }
}

/**
 * Named, independent RNG streams derived from one root seed. Adding a new stream never
 * changes the sequence of an existing one, so systems stay reproducible in isolation.
 */
export class RngStreams {
  private readonly streams = new Map<string, Rng>();

  constructor(readonly rootSeed: number) {}

  get(name: string): Rng {
    let rng = this.streams.get(name);
    if (!rng) {
      rng = new Rng(RngStreams.deriveSeed(this.rootSeed, name));
      this.streams.set(name, rng);
    }
    return rng;
  }

  static deriveSeed(rootSeed: number, name: string): number {
    return hashCombine(rootSeed >>> 0, fnv1a32(name));
  }
}
