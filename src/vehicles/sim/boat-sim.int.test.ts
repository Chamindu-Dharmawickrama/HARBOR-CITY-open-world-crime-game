import { beforeAll, describe, expect, it } from 'vitest';
import { BOATS } from '../../content/vehicles';
import { PhysicsWorld } from '../../physics/physics-world';
import { loadRapier, type Rapier } from '../../physics/rapier';
import { BoatSim } from './boat-sim';

const DT = 1 / 60;
let rapier: Rapier;
beforeAll(async () => {
  rapier = await loadRapier();
});

/** Open water everywhere x < 200; a sloping concrete ramp (beach) beyond. */
function harbour(def = BOATS[0]): { physics: PhysicsWorld; boat: BoatSim; step: (s: number) => void } {
  if (!def) throw new Error('no boats');
  const physics = new PhysicsWorld(rapier);
  physics.createFixedBox({ halfExtents: [400, 1, 400], position: [0, -12, 0] }); // sea floor
  physics.createFixedBox({ halfExtents: [100, 1, 400], position: [320, 0, 0] }); // quay at x ≥ 220
  physics.world.step();
  const boat = new BoatSim(physics, def, { waterLevel: 0, isWater: (x) => x < 220 }, 0, 0.5, 0, 0);
  boat.engineOn = true;
  const step = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      boat.step(DT);
      physics.step();
    }
  };
  return { physics, boat, step };
}

describe('BoatSim (Rapier)', () => {
  it('floats level at its design draft', () => {
    const { boat, step } = harbour();
    step(10);
    const def = boat.def;
    // Hull samples sit 0.05 m above the body origin and float `draft` below the surface.
    expect(boat.body.translation().y).toBeCloseTo(-(def.boat?.draft ?? 0) - 0.05, 1);
    expect(boat.submerged).toBe(1);
    const y0 = boat.body.translation().y;
    step(1);
    expect(Math.abs(boat.body.translation().y - y0)).toBeLessThan(0.01); // settled, not bobbing
  });

  for (const def of BOATS) {
    it(`${def.id}: reaches its top speed and turns with the rudder`, () => {
      const { boat, step } = harbour(def);
      step(2);
      boat.controls.throttle = 1;
      boat.teleport(-300, -0.3, -300, 0);
      step(25);
      const kmh = boat.telemetry.forwardSpeed * 3.6;
      expect(kmh).toBeGreaterThanOrEqual(def.targets.topSpeedKmh[0]);
      expect(kmh).toBeLessThanOrEqual(def.targets.topSpeedKmh[1]);
      boat.controls.steer = 1; // right
      let turned = 0;
      for (let i = 0; i < 120; i++) {
        step(DT);
        turned += boat.body.angvel().y * DT;
      }
      // Turned right (yaw decreases) at a believable rate: 0.3–1.2 rad/s.
      expect(turned).toBeLessThan(-0.6);
      expect(turned).toBeGreaterThan(-2.4);
      const q1 = boat.body.rotation();
      const up = 1 - 2 * (q1.x * q1.x + q1.z * q1.z);
      expect(up).toBeGreaterThan(0.8);
    });
  }

  it('does not float on land', () => {
    const { boat, step } = harbour();
    boat.teleport(300, 2, 0, 0);
    step(3);
    expect(boat.submerged).toBe(0);
    expect(boat.body.translation().y).toBeCloseTo(1, 0);
  });

  it('reverses with the brake', () => {
    const { boat, step } = harbour();
    step(2);
    boat.controls.brake = 1;
    step(4);
    expect(boat.telemetry.forwardSpeed).toBeLessThan(-1);
  });
});
