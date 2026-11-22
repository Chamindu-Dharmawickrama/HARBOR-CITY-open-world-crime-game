import { describe, expect, it } from 'vitest';
import { BenchRecorder } from './bench';
import { DEFAULT_WORLD_SEED, parseUrlParams } from './url-params';

describe('parseUrlParams', () => {
  it('uses defaults for an empty query', () => {
    expect(parseUrlParams('')).toEqual({
      debug: false,
      test: false,
      seed: DEFAULT_WORLD_SEED,
      preset: 'medium',
      bench: null,
      gpu: 'default',
    });
  });

  it('parses flags, numeric and string seeds, presets and gpu', () => {
    const p = parseUrlParams('?debug&test=1&seed=42&preset=HIGH&bench=playground&gpu=low-power');
    expect(p).toMatchObject({
      debug: true,
      test: true,
      seed: 42,
      preset: 'high',
      bench: 'playground',
      gpu: 'low-power',
    });
    const s = parseUrlParams('?seed=harbor&debug=0');
    expect(s.debug).toBe(false);
    expect(s.seed).toBe(parseUrlParams('?seed=harbor').seed);
    expect(s.seed).not.toBe(DEFAULT_WORLD_SEED);
  });

  it('falls back on invalid values', () => {
    const p = parseUrlParams('?preset=ultra&gpu=fast&bench=');
    expect(p.preset).toBe('medium');
    expect(p.gpu).toBe('default');
    expect(p.bench).toBeNull();
  });
});

const META = {
  scenario: 's',
  preset: 'medium',
  gpu: 'g',
  width: 1,
  height: 1,
  pixelRatio: 1,
  userAgent: 'ua',
  droppedSimSeconds: 0,
};

describe('BenchRecorder', () => {
  it('skips warm-up, records for the duration, then stops', () => {
    const bench = new BenchRecorder(1, 2);
    for (let i = 0; i < 30; i++) bench.frame(1 / 30, 1, 100, 1000, 50);
    expect(bench.recording).toBe(true);
    for (let i = 0; i < 59; i++) bench.frame(1 / 30, 2, 200, 2000, 50 + i * 0.01);
    expect(bench.done).toBe(false);
    bench.frame(1 / 30, 2, 300, 3000, 51);
    expect(bench.done).toBe(true);
    const result = bench.result(META);
    expect(result.frames).toBe(60);
    expect(result.fps).toBeCloseTo(30, 0);
    expect(result.cpuMs.mean).toBe(2);
    expect(result.drawCalls.max).toBe(300);
    expect(result.heapGrowthMBps).toBeCloseTo(0.5, 1);
    bench.frame(1, 1, 1, 1, 1);
    expect(bench.result(META).frames).toBe(60);
  });

  it('reports null heap growth without heap data', () => {
    const bench = new BenchRecorder(0, 0.1);
    for (let i = 0; i < 10; i++) bench.frame(0.05, 1, 1, 1, null);
    expect(bench.result(META).heapGrowthMBps).toBeNull();
  });
});
