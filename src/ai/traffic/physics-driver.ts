import type { RaycastVehicle } from '../../vehicles/sim/raycast-vehicle';
import { steeringLimit } from '../../vehicles/physics/chassis';
import { createLanePoint } from './lane-network';
import type { TrafficCar, TrafficSim } from './traffic-sim';

const target = createLanePoint();

/** Look-ahead distance for pure pursuit at speed v (m). */
export function lookaheadDistance(v: number): number {
  return Math.max(4.5, Math.min(16, 3.5 + 0.55 * v));
}

/** Heading of a vehicle body from its rotation (unit forward vector in XZ). */
export function bodyForward(
  q: { x: number; y: number; z: number; w: number },
  out: { x: number; z: number },
): void {
  out.x = 2 * (q.x * q.z + q.w * q.y);
  out.z = 1 - 2 * (q.x * q.x + q.y * q.y);
  const len = Math.hypot(out.x, out.z) || 1;
  out.x /= len;
  out.z /= len;
}

const forward = { x: 0, z: 1 };

/**
 * Turns the traffic model's plan into pedals and steering for a physics vehicle: pure-pursuit
 * steering toward a point ahead on the planned path (with the car's lateral offset) and an
 * open-loop mapping from the commanded acceleration to throttle / brake, holding the brake at a
 * standstill (reverse disabled).
 */
export function drivePhysicsCar(sim: TrafficSim, car: TrafficCar, vehicle: RaycastVehicle): void {
  const body = vehicle.body;
  const p = body.translation();
  bodyForward(body.rotation(), forward);
  const v = vehicle.telemetry.forwardSpeed;
  const ld = lookaheadDistance(Math.max(0, v));
  // The body origin is mid-wheelbase: aim from the rear axle for stable tracking.
  sim.lookahead(car, ld - vehicle.def.wheelbase / 2, target);
  const rx = p.x - forward.x * (vehicle.def.wheelbase / 2);
  const rz = p.z - forward.z * (vehicle.def.wheelbase / 2);
  const dx = target.x - rx;
  const dz = target.z - rz;
  const ahead = dx * forward.x + dz * forward.z;
  const left = dx * forward.z - dz * forward.x;
  const d2 = Math.max(1, ahead * ahead + left * left);
  const delta = Math.atan((vehicle.def.wheelbase * 2 * left) / d2); // + = steer left
  const limit = steeringLimit(vehicle.def.steering, Math.abs(v));
  const c = vehicle.controls;
  c.allowReverse = false;
  c.handbrake = false;
  c.steer = Math.max(-1, Math.min(1, -delta / Math.max(1e-3, limit)));

  const a = car.accel;
  const heavy = vehicle.def.mass > 3000;
  const reference = heavy ? 1.4 : 2.8;
  if (Math.abs(v) < 0.4 && a < 0.25) {
    // Standing: hold it there.
    c.throttle = 0;
    c.brake = 1;
  } else if (a > 0.05) {
    // Feed-forward for rolling resistance and drag, which grow with speed.
    const hold = 0.04 + 0.00055 * v * v;
    c.throttle = Math.max(0, Math.min(1, a / reference + hold));
    c.brake = 0;
  } else if (a < -0.35) {
    c.throttle = 0;
    c.brake = Math.max(0.05, Math.min(1, -a / 8.5));
  } else {
    // Cruising: keep the speed against drag.
    c.throttle = v > 1 ? 0.03 + 0.0005 * v * v : 0;
    c.brake = 0;
  }
}
