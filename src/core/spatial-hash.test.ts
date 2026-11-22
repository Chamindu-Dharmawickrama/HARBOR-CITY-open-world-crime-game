import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { SpatialHash2D } from './spatial-hash';

describe('SpatialHash2D', () => {
  it('finds points by rectangle and radius', () => {
    const hash = new SpatialHash2D(10, 100);
    hash.insertPoint(1, 0, 0);
    hash.insertPoint(2, 15, 0);
    hash.insertPoint(3, -50, -50);
    const out: number[] = [];
    hash.queryRect(-1, -1, 16, 1, out);
    expect(out.sort()).toEqual([1, 2]);
    hash.queryRadius(0, 0, 5, out);
    expect(out).toEqual([1]);
    expect(hash.size).toBe(3);
  });

  it('handles AABBs spanning many cells without duplicates', () => {
    const hash = new SpatialHash2D(4, 10);
    hash.insert(7, -20, -20, 20, 20);
    const out: number[] = [];
    expect(hash.queryRect(-30, -30, 30, 30, out)).toBe(1);
    expect(out).toEqual([7]);
  });

  it('updates and removes', () => {
    const hash = new SpatialHash2D(10, 10);
    hash.insertPoint(0, 0, 0);
    const out: number[] = [];
    hash.updatePoint(0, 100, 100);
    expect(hash.queryRadius(0, 0, 5, out)).toBe(0);
    expect(hash.queryRadius(100, 100, 1, out)).toBe(1);
    hash.remove(0);
    expect(hash.queryRadius(100, 100, 1, out)).toBe(0);
    expect(hash.has(0)).toBe(false);
    expect(hash.size).toBe(0);
  });

  it('matches brute force on random data (negative coordinates included)', () => {
    const rng = new Rng(123);
    const n = 500;
    const hash = new SpatialHash2D(16, n);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push(rng.range(-500, 500));
      zs.push(rng.range(-500, 500));
      hash.insertPoint(i, xs[i], zs[i]);
    }
    for (let i = 0; i < n; i += 3)
      hash.updatePoint(i, (xs[i] = rng.range(-500, 500)), (zs[i] = rng.range(-500, 500)));
    const out: number[] = [];
    for (let q = 0; q < 50; q++) {
      const cx = rng.range(-500, 500);
      const cz = rng.range(-500, 500);
      const r = rng.range(5, 80);
      hash.queryRadius(cx, cz, r, out);
      const expected: number[] = [];
      for (let i = 0; i < n; i++) {
        if (Math.hypot(xs[i] - cx, zs[i] - cz) <= r) expected.push(i);
      }
      expect([...out].sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('rejects out-of-range slots and invalid cell size', () => {
    expect(() => new SpatialHash2D(0, 1)).toThrow();
    expect(() => new SpatialHash2D(1, 1).insertPoint(5, 0, 0)).toThrow();
  });
});
