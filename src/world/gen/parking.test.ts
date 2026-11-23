import { describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { generateCity } from './city-layout';
import { generateParkingSpots } from './parking';

const model = generateCity(CITY, 74613);
const spots = generateParkingSpots(model.layout, model.terrain);

describe('parking spots', () => {
  it('finds lot stalls, curb spots and boat moorings', () => {
    const count = (kind: string): number => spots.filter((s) => s.kind === kind).length;
    expect(count('lot')).toBeGreaterThan(100);
    expect(count('curb')).toBeGreaterThan(100);
    expect(count('boat')).toBeGreaterThan(0);
    spots.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('is deterministic', () => {
    const again = generateParkingSpots(model.layout, model.terrain);
    expect(again).toEqual(spots);
  });

  it('puts cars on land and boats on water, with finite poses', () => {
    for (const s of spots) {
      expect(Number.isFinite(s.x + s.y + s.z + s.yaw)).toBe(true);
      if (s.kind === 'boat') expect(model.terrain.isLand(s.x, s.z)).toBe(false);
      else expect(model.terrain.isLand(s.x, s.z)).toBe(true);
    }
  });

  it('keeps cars apart (no two spots closer than a car width)', () => {
    const cars = spots.filter((s) => s.kind !== 'boat');
    const cell = new Map<string, typeof cars>();
    for (const s of cars) {
      const key = `${Math.floor(s.x / 4)},${Math.floor(s.z / 4)}`;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const o of cell.get(`${Math.floor(s.x / 4) + dx},${Math.floor(s.z / 4) + dz}`) ?? []) {
            expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(2.2);
          }
        }
      }
      const list = cell.get(key) ?? [];
      list.push(s);
      cell.set(key, list);
    }
  });
});
