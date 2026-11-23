import { beforeAll, describe, expect, it } from 'vitest';
import { BOATS, VEHICLES } from '../content/vehicles';
import { loadRapier, type Rapier } from '../physics/rapier';
import {
  brake100To0,
  driftRecovery,
  highSpeedStability,
  jTurn,
  skidpad,
  topSpeed,
  tunnelling,
  zeroTo100,
} from './handling-harness';
import { peakPower } from './physics/drivetrain';

let rapier: Rapier;

beforeAll(async () => {
  rapier = await loadRapier();
});

function within(value: number, range: readonly [number, number]): void {
  expect(value).toBeGreaterThanOrEqual(range[0]);
  expect(value).toBeLessThanOrEqual(range[1]);
}

describe('vehicle catalogue', () => {
  it('has unique ids, sane numbers and every planned class', () => {
    const all = [...VEHICLES, ...BOATS];
    expect(new Set(all.map((v) => v.id)).size).toBe(all.length);
    const classes = new Set(all.map((v) => v.class));
    for (const c of [
      'compact',
      'sedan',
      'taxi',
      'sports',
      'muscle',
      'pickup',
      'van',
      'bus',
      'motorbike',
      'police',
      'ambulance',
      'swat',
      'armored',
      'speedboat',
      'policeBoat',
    ] as const) {
      expect(classes.has(c), c).toBe(true);
    }
    for (const v of VEHICLES) {
      expect(v.mass).toBeGreaterThan(150);
      expect(v.comHeight).toBeLessThan(v.height);
      expect(v.wheelbase).toBeLessThan(v.length);
      expect(v.gearbox.ratios.length).toBeGreaterThanOrEqual(5);
      for (let i = 1; i < v.gearbox.ratios.length; i++) {
        expect(v.gearbox.ratios[i], `${v.id} gear ${i + 1}`).toBeLessThan(v.gearbox.ratios[i - 1]);
      }
      expect(peakPower(v.engine) / 1000).toBeGreaterThan(40);
    }
  });
});

/**
 * The handling harness: every road vehicle is measured on a flat test pad and must land inside
 * its class targets (PLAN.md §7, M3).
 */
describe.each(VEHICLES.map((v) => [v.id, v] as const))('handling: %s', (_id, def) => {
  it('0–100 km/h, top speed, 100–0 braking and skidpad are on target', () => {
    within(zeroTo100(rapier, def), def.targets.zeroTo100);
    within(topSpeed(rapier, def), def.targets.topSpeedKmh);
    within(brake100To0(rapier, def), def.targets.brake100To0);
    within(skidpad(rapier, def), def.targets.skidpadG);
  });

  it('survives a J-turn, recovers from a handbrake slide, and is stable flat out', () => {
    const j = jTurn(rapier, def);
    expect(j.minUp).toBeGreaterThan(0.5);
    expect(j.recovered).toBe(true);
    const drift = driftRecovery(rapier, def);
    expect(drift.upright).toBe(true);
    expect(drift.settle).toBeLessThan(4);
    const top = def.targets.topSpeedKmh[0];
    const stability = highSpeedStability(rapier, def, top);
    expect(stability.upright).toBe(true);
    expect(stability.maxYawRate).toBeLessThan(0.5);
  });

  it('does not tunnel through a thin wall at top speed', () => {
    expect(tunnelling(rapier, def, def.targets.topSpeedKmh[1])).toBeLessThan(0.3);
  });
});
