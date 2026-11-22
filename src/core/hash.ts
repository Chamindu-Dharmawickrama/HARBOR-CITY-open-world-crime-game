/** FNV-1a 32-bit hash of a string. Deterministic on every platform. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 32-bit finaliser: strong avalanche for integer mixing. */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Order-dependent combination of two 32-bit hashes. */
export function hashCombine(a: number, b: number): number {
  return mix32((a >>> 0) ^ (mix32(b) + 0x9e3779b9 + ((a << 6) >>> 0) + (a >>> 2)));
}

/**
 * Incremental hasher for determinism snapshots. Floats are quantised first so that
 * values which are equal to within `quantum` hash identically.
 */
export class Hasher {
  private state = 0x811c9dc5;

  addInt(value: number): this {
    this.state = hashCombine(this.state, value | 0);
    return this;
  }

  addFloat(value: number, quantum = 1e-4): this {
    return this.addInt(Math.round(value / quantum));
  }

  addString(text: string): this {
    this.state = hashCombine(this.state, fnv1a32(text));
    return this;
  }

  digest(): number {
    return mix32(this.state);
  }

  hex(): string {
    return this.digest().toString(16).padStart(8, '0');
  }
}
