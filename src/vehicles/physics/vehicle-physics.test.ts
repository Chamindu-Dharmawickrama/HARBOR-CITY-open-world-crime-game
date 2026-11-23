import { describe, expect, it } from 'vitest';
import {
  absModulate,
  antiRollForce,
  dragForce,
  steeringLimit,
  steerToward,
  suspensionForce,
  tcsThrottle,
} from './chassis';
import {
  Drivetrain,
  engineTorque,
  peakPower,
  splitAxleTorque,
  type EngineSpec,
  type GearboxSpec,
} from './drivetrain';
import { computeTireForces, createTireForces, effectiveMu, slipCurve, type TireParams } from './tire';

const TIRE: TireParams = {
  mu: 1,
  loadSensitivity: 0.1,
  nominalLoad: 4000,
  peakSlipRatio: 0.1,
  peakSlipAngle: 0.14,
  shape: 1.5,
  lateralFactor: 0.95,
};

describe('tire model', () => {
  it('the normalised curve peaks at 1 and falls to sin(C·π/2) when sliding', () => {
    expect(slipCurve(1, 1.5)).toBeCloseTo(1, 6);
    expect(slipCurve(0.5, 1.5)).toBeLessThan(1);
    expect(slipCurve(1000, 1.5)).toBeCloseTo(Math.sin((1.5 * Math.PI) / 2), 2);
  });

  it('peak force ≈ μ·Fz at the peak slip ratio; braking reverses the sign', () => {
    const out = createTireForces();
    computeTireForces(TIRE, 4000, 0.1, 0, 1, out);
    expect(out.fx).toBeCloseTo(4000, 0);
    expect(out.fy).toBeCloseTo(0, 6);
    computeTireForces(TIRE, 4000, -0.1, 0, 1, out);
    expect(out.fx).toBeCloseTo(-4000, 0);
  });

  it('side force opposes the slip angle', () => {
    const out = createTireForces();
    computeTireForces(TIRE, 4000, 0, 0.14, 1, out);
    expect(out.fy).toBeCloseTo(-4000 * 0.95, -1);
    computeTireForces(TIRE, 4000, 0, -0.05, 1, out);
    expect(out.fy).toBeGreaterThan(0);
  });

  it('combined slip: a locked wheel loses most of its side grip', () => {
    const out = createTireForces();
    computeTireForces(TIRE, 4000, 0, 0.1, 1, out);
    const free = Math.abs(out.fy);
    computeTireForces(TIRE, 4000, -1, 0.1, 1, out);
    expect(Math.abs(out.fy)).toBeLessThan(free * 0.2);
  });

  it('load sensitivity lowers μ under load; no load → no force', () => {
    expect(effectiveMu(TIRE, 8000)).toBeLessThan(effectiveMu(TIRE, 4000));
    const out = createTireForces();
    computeTireForces(TIRE, 0, 0.5, 0.2, 1, out);
    expect(out.fx).toBe(0);
    expect(out.fy).toBe(0);
  });
});

const ENGINE: EngineSpec = {
  idleRpm: 800,
  redlineRpm: 6000,
  torqueCurve: [
    [800, 150],
    [3000, 220],
    [5000, 210],
    [6000, 180],
  ],
  engineBraking: 50,
};
const BOX: GearboxSpec = {
  ratios: [3.5, 2.1, 1.4, 1.0, 0.8],
  reverse: 3.4,
  finalDrive: 3.7,
  shiftTime: 0.2,
  upshift: 0.97,
  downshift: 0.5,
  efficiency: 0.9,
};

describe('drivetrain', () => {
  it('interpolates the torque curve and cuts off past the limiter', () => {
    expect(engineTorque(ENGINE, 3000)).toBe(220);
    expect(engineTorque(ENGINE, 4000)).toBeCloseTo(215);
    expect(engineTorque(ENGINE, 6500)).toBe(0);
    expect(peakPower(ENGINE)).toBeGreaterThan(110_000);
  });

  it('launches with clutch slip, then shifts up through the gears without hunting', () => {
    const d = new Drivetrain(ENGINE, BOX);
    const torque = d.update(0, 1, 1 / 60);
    expect(torque).toBeGreaterThan(0);
    expect(d.clutch).toBeLessThan(1);
    // Ramp wheel speed: gears must only increase.
    let last = d.gear;
    for (let i = 0; i < 60 * 30; i++) {
      const wheelOmega = (i / (60 * 30)) * 200;
      d.update(wheelOmega, 1, 1 / 60);
      expect(d.gear).toBeGreaterThanOrEqual(last);
      last = d.gear;
    }
    expect(d.gear).toBe(5);
  });

  it('no drive torque while shifting or in neutral; reverse drives backwards', () => {
    const d = new Drivetrain(ENGINE, BOX);
    d.shiftTo(2);
    expect(d.update(30, 1, 1 / 60)).toBe(0);
    d.shiftTo(-1);
    for (let i = 0; i < 30; i++) d.update(0, 1, 1 / 60);
    expect(d.update(0, 1, 1 / 60)).toBeLessThan(0);
  });

  it('a limited-slip differential sends torque to the slower wheel', () => {
    const out = { left: 0, right: 0 };
    splitAxleTorque(1000, 50, 50, 0.5, out);
    expect(out.left).toBeCloseTo(500);
    splitAxleTorque(1000, 80, 20, 0.5, out);
    expect(out.right).toBeGreaterThan(out.left);
    expect(out.left + out.right).toBeCloseTo(1000);
  });
});

describe('chassis helpers', () => {
  it('suspension pushes on compression, damps by direction, never pulls', () => {
    expect(suspensionForce(0.05, 0, 30000, 2000, 3000, 0.2)).toBeCloseTo(1500);
    expect(suspensionForce(0.05, 1, 30000, 2000, 3000, 0.2)).toBeCloseTo(3500);
    expect(suspensionForce(0.05, -1, 30000, 2000, 3000, 0.2)).toBe(0);
    expect(suspensionForce(0.19, 0, 30000, 2000, 3000, 0.2)).toBeGreaterThan(30000 * 0.19);
    expect(antiRollForce(0.1, 0.05, 20000)).toBeCloseTo(1000);
  });

  it('ABS eases a locking wheel; TCS trims a spinning one', () => {
    expect(absModulate(1000, -0.05, 20)).toBe(1000);
    expect(absModulate(1000, -0.5, 20)).toBeLessThan(500);
    expect(absModulate(1000, -0.5, 1)).toBe(1000);
    expect(tcsThrottle(1, 0.05, 20)).toBe(1);
    expect(tcsThrottle(1, 0.4, 20)).toBeLessThan(0.5);
  });

  it('speed-sensitive steering and a steering rate limit', () => {
    const spec = { maxAngle: 0.6, halfLockSpeed: 25, rate: 2 };
    expect(steeringLimit(spec, 0)).toBeCloseTo(0.6);
    expect(steeringLimit(spec, 25)).toBeCloseTo(0.3);
    expect(steerToward(0, 1, spec, 0.1)).toBeCloseTo(0.2);
  });

  it('aero drag grows with the square of speed', () => {
    const aero = { dragArea: 0.7, liftArea: 0, rollingResistance: 0.012 };
    expect(dragForce(aero, 20) / dragForce(aero, 10)).toBeCloseTo(4);
  });
});
