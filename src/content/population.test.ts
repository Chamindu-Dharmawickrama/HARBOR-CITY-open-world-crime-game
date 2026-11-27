import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../rendering/quality';
import { ARCHETYPE_MIX, ARCHETYPES, DENSITY, TRAFFIC_RULES } from './population';
import { ALL_VEHICLES } from './vehicles';

describe('population content', () => {
  it('has a 24-hour curve in [0, 1] for every district, busier by day than at 3 am', () => {
    for (const kind of ['peds', 'cars'] as const) {
      for (const [district, curve] of Object.entries(DENSITY[kind])) {
        expect(curve, `${kind} ${district}`).toHaveLength(24);
        for (const v of curve) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(Math.max(...curve.slice(8, 19))).toBeGreaterThan(curve[3] * 2);
      }
    }
  });

  it('mixes only known archetypes with sensible speeds', () => {
    for (const mix of Object.values(ARCHETYPE_MIX)) {
      for (const table of [mix.day, mix.night]) {
        const ids = Object.keys(table);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(ARCHETYPES).toHaveProperty(id);
      }
    }
    for (const a of Object.values(ARCHETYPES)) {
      expect(a.speed[0]).toBeGreaterThan(0.8);
      expect(a.speed[1]).toBeLessThan(4);
      expect(a.dwell[0]).toBeLessThanOrEqual(a.dwell[1]);
    }
  });

  it('only sends existing road vehicles into traffic', () => {
    for (const table of Object.values(TRAFFIC_RULES.models)) {
      for (const id of Object.keys(table)) {
        const def = ALL_VEHICLES.find((d) => d.id === id);
        expect(def, id).toBeDefined();
        expect(def?.kind).toBe('car');
        expect(def?.lightBar ?? false).toBe(false);
      }
    }
  });

  it('caps match the plan (Low 24/16, Medium 48/30, High 80/45)', () => {
    expect([QUALITY_PRESETS.low.maxPedestrians, QUALITY_PRESETS.low.maxTraffic]).toEqual([24, 16]);
    expect([QUALITY_PRESETS.medium.maxPedestrians, QUALITY_PRESETS.medium.maxTraffic]).toEqual([48, 30]);
    expect([QUALITY_PRESETS.high.maxPedestrians, QUALITY_PRESETS.high.maxTraffic]).toEqual([80, 45]);
  });
});
