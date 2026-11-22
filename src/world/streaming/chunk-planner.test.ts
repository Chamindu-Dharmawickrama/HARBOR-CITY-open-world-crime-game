import { describe, expect, it } from 'vitest';
import { buildingFallbacks, chunkDistance, releaseDistance, ringsFor, wantsAt } from './chunk-planner';

describe('chunk planner', () => {
  it('measures distance to the chunk square (zero inside)', () => {
    expect(chunkDistance(0, 0, 128, 64, 64)).toBe(0);
    expect(chunkDistance(1, 0, 128, 0, 64)).toBe(128);
    expect(chunkDistance(1, 1, 128, 0, 0)).toBeCloseTo(Math.SQRT2 * 128);
  });

  it('derives nested rings from the draw distance', () => {
    const rings = ringsFor(800, 220);
    expect(rings.near).toBeLessThan(rings.mid);
    expect(rings.mid).toBeLessThan(rings.far);
    expect(rings.far).toBe(800);
  });

  it('wants detail near, simplified mid, coarse far, nothing beyond', () => {
    const rings = ringsFor(800, 220);
    expect(wantsAt(0, rings)).toEqual({ ground: 'groundDetail', buildings: 'buildings0', colliders: true });
    expect(wantsAt(rings.near + 1, rings)).toEqual({
      ground: 'groundDetail',
      buildings: 'buildings1',
      colliders: false,
    });
    expect(wantsAt(rings.mid + 1, rings)).toEqual({
      ground: 'groundCoarse',
      buildings: 'buildings2',
      colliders: false,
    });
    expect(wantsAt(rings.far + 1, rings).ground).toBeNull();
  });

  it('releases pieces only past their ring plus hysteresis', () => {
    const rings = ringsFor(800, 220);
    expect(releaseDistance('buildings0', rings)).toBe(rings.near + rings.hysteresis);
    expect(releaseDistance('groundCoarse', rings)).toBe(rings.far + rings.hysteresis);
  });

  it('falls back to the nearest available level of detail', () => {
    expect(buildingFallbacks('buildings0')[1]).toBe('buildings1');
    expect(buildingFallbacks('buildings2')[1]).toBe('buildings1');
  });
});
