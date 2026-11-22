import { describe, expect, it } from 'vitest';
import { Hasher, fnv1a32, hashCombine, mix32 } from './hash';
import { Rng, RngStreams, seedFrom } from './rng';

describe('hash', () => {
  it('fnv1a32 matches known vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('mix32 and hashCombine are deterministic and order dependent', () => {
    expect(mix32(1)).toBe(mix32(1));
    expect(mix32(1)).not.toBe(mix32(2));
    expect(hashCombine(1, 2)).not.toBe(hashCombine(2, 1));
  });

  it('Hasher quantises floats', () => {
    const a = new Hasher().addFloat(1.00001).addString('x').hex();
    const b = new Hasher().addFloat(1.00002).addString('x').hex();
    const c = new Hasher().addFloat(1.01).addString('x').hex();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Rng', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('different seeds diverge', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(3);
  });

  it('string seeds hash consistently', () => {
    expect(seedFrom('harbor')).toBe(seedFrom('harbor'));
    expect(new Rng('harbor').next()).toBe(new Rng('harbor').next());
  });

  it('next() is uniform in [0, 1)', () => {
    const rng = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)] += 1;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n / 100);
  });

  it('int() stays in range and covers it', () => {
    const rng = new Rng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(8);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it('gaussian has roughly the requested mean and deviation', () => {
    const rng = new Rng(11);
    const n = 50_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.gaussian(5, 2);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(mean).toBeCloseTo(5, 1);
    expect(sd).toBeCloseTo(2, 1);
  });

  it('pickWeighted respects weights', () => {
    const rng = new Rng(3);
    let a = 0;
    for (let i = 0; i < 10_000; i++) if (rng.pickWeighted(['a', 'b'], [3, 1]) === 'a') a++;
    expect(a / 10_000).toBeGreaterThan(0.72);
    expect(a / 10_000).toBeLessThan(0.78);
  });

  it('pick throws on empty input', () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });

  it('shuffle is a permutation', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = new Rng(5).shuffle([...items]);
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
  });

  it('state can be saved and restored', () => {
    const rng = new Rng(77);
    rng.next();
    const state = rng.getState();
    const expected = [rng.next(), rng.next()];
    rng.setState(state);
    expect([rng.next(), rng.next()]).toEqual(expected);
  });
});

describe('RngStreams', () => {
  it('streams are independent of creation order', () => {
    const s1 = new RngStreams(100);
    const traffic1 = s1.get('traffic').next();
    const s2 = new RngStreams(100);
    s2.get('peds').next();
    s2.get('weather').next();
    expect(s2.get('traffic').next()).toBe(traffic1);
  });

  it('returns the same stream instance per name', () => {
    const s = new RngStreams(1);
    expect(s.get('x')).toBe(s.get('x'));
    expect(s.get('x')).not.toBe(s.get('y'));
  });
});
