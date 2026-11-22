import { describe, expect, it } from 'vitest';
import { percentileSorted, RingBuffer, summarize } from './stats';

describe('stats', () => {
  it('percentileSorted interpolates', () => {
    const data = [10, 20, 30, 40, 50];
    expect(percentileSorted(data, 0)).toBe(10);
    expect(percentileSorted(data, 50)).toBe(30);
    expect(percentileSorted(data, 100)).toBe(50);
    expect(percentileSorted(data, 25)).toBe(20);
    expect(percentileSorted([], 50)).toBe(0);
    expect(percentileSorted([7], 99)).toBe(7);
  });

  it('summarize covers the first count samples', () => {
    const samples = new Float32Array([5, 1, 3, 100, 100]);
    const s = summarize(samples, 3);
    expect(s.count).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.p50).toBe(3);
  });

  it('summarize handles empty input', () => {
    expect(summarize([])).toMatchObject({ count: 0, mean: 0, p99: 0 });
  });

  it('RingBuffer keeps a running mean of the last N values', () => {
    const ring = new RingBuffer(3);
    ring.push(1);
    ring.push(2);
    expect(ring.mean).toBe(1.5);
    ring.push(3);
    ring.push(10);
    expect(ring.size).toBe(3);
    expect(ring.mean).toBe(5);
    expect(ring.max()).toBe(10);
    expect([ring.at(0), ring.at(1), ring.at(2)]).toEqual([2, 3, 10]);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.mean).toBe(0);
  });
});
