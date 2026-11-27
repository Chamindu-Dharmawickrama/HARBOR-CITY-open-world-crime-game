import { describe, expect, it } from 'vitest';
import { densityAt, targetCount, type DensityCurves } from './density';

const flat = (v: number): number[] => Array.from({ length: 24 }, () => v);
const CURVES: DensityCurves = {
  peds: {
    meridian: flat(0.5).map((_, h) => (h >= 8 && h < 20 ? 1 : 0.1)),
    gantry: flat(0.2),
    linden: flat(0),
  },
  cars: { meridian: flat(1), gantry: flat(0.5), linden: flat(0.25) },
};

describe('population density', () => {
  it('follows the hour per district (bridges and water count as downtown)', () => {
    expect(densityAt(CURVES, 'peds', 'meridian', 12)).toBe(1);
    expect(densityAt(CURVES, 'peds', 'meridian', 3)).toBeCloseTo(0.1);
    expect(densityAt(CURVES, 'peds', 'meridian', 7.5)).toBeCloseTo(0.55);
    expect(densityAt(CURVES, 'peds', null, 12)).toBe(1);
    expect(densityAt(CURVES, 'cars', 'linden', 12)).toBe(0.25);
  });

  it('never exceeds the cap', () => {
    for (const cap of [16, 24, 30, 45, 48, 80]) {
      for (let d = -0.5; d <= 1.5; d += 0.05) {
        const n = targetCount(cap, d);
        expect(n).toBeLessThanOrEqual(cap);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
    expect(targetCount(48, 0.5)).toBe(24);
  });
});
