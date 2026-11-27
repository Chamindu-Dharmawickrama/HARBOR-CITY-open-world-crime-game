import { describe, expect, it } from 'vitest';
import { cycleLength, DEFAULT_TIMING, Light, lightAt, timeToChange, Walk, walkAt } from './signals';

const T = { ...DEFAULT_TIMING, green: [20, 12] as const, amber: 3, allRed: 2, offset: 0 };

describe('signal controller', () => {
  it('cycles green → amber → red for each phase, never green for both', () => {
    expect(cycleLength(T)).toBe(42);
    expect(lightAt(T, 0, 0)).toBe(Light.green);
    expect(lightAt(T, 0, 19.9)).toBe(Light.green);
    expect(lightAt(T, 0, 21)).toBe(Light.amber);
    expect(lightAt(T, 0, 23.5)).toBe(Light.red);
    expect(lightAt(T, 1, 24.9)).toBe(Light.red); // all-red clearance
    expect(lightAt(T, 1, 25.1)).toBe(Light.green);
    expect(lightAt(T, 1, 38)).toBe(Light.amber);
    expect(lightAt(T, 0, 41)).toBe(Light.red);
    expect(lightAt(T, 0, 42.1)).toBe(Light.green);
    for (let t = 0; t < 200; t += 0.05) {
      const a = lightAt(T, 0, t);
      const b = lightAt(T, 1, t);
      expect(a === Light.red || b === Light.red).toBe(true);
    }
  });

  it('reports the time until the next change', () => {
    expect(timeToChange(T, 0, 5)).toBeCloseTo(15);
    expect(timeToChange(T, 0, 21)).toBeCloseTo(2);
    expect(timeToChange(T, 1, 0)).toBeCloseTo(25);
  });

  it('lets pedestrians walk only while their crossing traffic is held at red', () => {
    for (let t = 0; t < 200; t += 0.05) {
      for (const arm of [0, 1]) {
        if (walkAt(T, arm, t) === Walk.walk) {
          // The traffic that drives across this crosswalk is stopped, and stays stopped for the
          // clearance time.
          expect(lightAt(T, arm, t)).toBe(Light.red);
          expect(lightAt(T, arm, t + T.pedClearance - 0.1)).toBe(Light.red);
        }
      }
    }
    expect(walkAt(T, 1, 1)).toBe(Walk.walk);
    expect(walkAt(T, 1, 20)).toBe(Walk.flash);
    expect(walkAt(T, 0, 1)).toBe(Walk.dont);
  });

  it('runs three phases in turn for awkward junctions', () => {
    const three = { ...T, green: [10, 10, 10] };
    expect(cycleLength(three)).toBe(45);
    expect(lightAt(three, 0, 5)).toBe(Light.green);
    expect(lightAt(three, 1, 20)).toBe(Light.green);
    expect(lightAt(three, 2, 35)).toBe(Light.green);
    for (let t = 0; t < 100; t += 0.1) {
      const greens = [0, 1, 2].filter((p) => lightAt(three, p, t) !== Light.red).length;
      expect(greens).toBeLessThanOrEqual(1);
    }
  });

  it('applies the per-junction offset', () => {
    const shifted = { ...T, offset: 25.5 };
    expect(lightAt(shifted, 1, 0)).toBe(Light.green);
    expect(lightAt(shifted, 0, 0)).toBe(Light.red);
  });
});
