import { PhysicsWorld } from '../physics/physics-world';
import type { Rapier } from '../physics/rapier';
import { RaycastVehicle } from './sim/raycast-vehicle';
import type { VehicleDef } from './vehicle-def';

/**
 * Objective handling measurements on a flat test pad (used by the handling integration tests
 * and for tuning). Every measurement builds its own physics world.
 */
const DT = 1 / 60;
const KMH = 3.6;

export interface Pad {
  physics: PhysicsWorld;
  vehicle: RaycastVehicle;
  step(seconds?: number): void;
  /** Heading of the vehicle (rad, 0 = +Z, + = turned left). */
  heading(): number;
  upY(): number;
}

export function createPad(rapier: Rapier, def: VehicleDef, extra?: (physics: PhysicsWorld) => void): Pad {
  const physics = new PhysicsWorld(rapier);
  physics.createFixedBox({ halfExtents: [3000, 1, 3000], position: [0, -1, 0], friction: 1 });
  extra?.(physics);
  physics.world.step();
  const vehicle = new RaycastVehicle(physics, def, 0, 0.05, -2500, 0);
  vehicle.engineOn = true;
  const step = (seconds = DT): void => {
    const n = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < n; i++) {
      vehicle.step(DT);
      physics.step();
    }
  };
  const heading = (): number => {
    const q = vehicle.body.rotation();
    // Forward (+Z) rotated: x = 2(xz + wy), z = 1 − 2(x² + y²)
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return Math.atan2(fx, fz);
  };
  const upY = (): number => {
    const q = vehicle.body.rotation();
    return 1 - 2 * (q.x * q.x + q.z * q.z);
  };
  step(1); // settle on the suspension
  return { physics, vehicle, step, heading, upY };
}

function forward(p: Pad): number {
  return p.vehicle.telemetry.forwardSpeed;
}

/** Seconds from standstill to 100 km/h at full throttle (Infinity if never reached in 40 s). */
export function zeroTo100(rapier: Rapier, def: VehicleDef): number {
  const p = createPad(rapier, def);
  const c = p.vehicle.controls;
  c.throttle = 1;
  for (let t = 0; t < 40; t += DT) {
    p.step();
    if (forward(p) >= 100 / KMH) return t + DT;
  }
  return Infinity;
}

/** Maximum speed (km/h) reached with full throttle on a long straight. */
export function topSpeed(rapier: Rapier, def: VehicleDef, seconds = 90): number {
  const p = createPad(rapier, def);
  p.vehicle.controls.throttle = 1;
  let best = 0;
  let lastGain = 0;
  for (let t = 0; t < seconds; t += DT) {
    p.step();
    const v = forward(p);
    if (v > best + 0.01) {
      best = v;
      lastGain = t;
    }
    if (t - lastGain > 6) break; // plateau
  }
  return best * KMH;
}

/** Stopping distance (m) from 100 km/h with full brakes. */
export function brake100To0(rapier: Rapier, def: VehicleDef): number {
  const p = createPad(rapier, def);
  const c = p.vehicle.controls;
  c.throttle = 1;
  for (let t = 0; t < 40 && forward(p) < 100 / KMH; t += DT) p.step();
  c.throttle = 0;
  c.brake = 1;
  const start = p.vehicle.body.translation();
  const sx = start.x;
  const sz = start.z;
  for (let t = 0; t < 20; t += DT) {
    p.step();
    if (forward(p) < 0.3) break;
  }
  const end = p.vehicle.body.translation();
  return Math.hypot(end.x - sx, end.z - sz);
}

/**
 * Skidpad: follows a 40 m circle while slowly raising the target speed; returns the highest
 * lateral acceleration (g) held for at least a second within 2 m of the line.
 */
export function skidpad(rapier: Rapier, def: VehicleDef, radius = 40): number {
  const p = createPad(rapier, def);
  const v = p.vehicle;
  const c = v.controls;
  // Centre of the circle to the vehicle's left.
  const start = v.body.translation();
  const cx = start.x + radius;
  const cz = start.z;
  let target = 6;
  let held = 0;
  let best = 0;
  let window = 0;
  let windowMin = Infinity;
  for (let t = 0; t < 150; t += DT) {
    const pos = v.body.translation();
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const dist = Math.hypot(dx, dz);
    const err = dist - radius; // + = outside the circle
    // Tangent direction for counter-clockwise travel (turning left).
    const tx = dz / dist;
    const tz = -dx / dist;
    const heading = p.heading();
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const headingErr = Math.atan2(fz * tx - fx * tz, fx * tx + fz * tz); // + = pointing right of the tangent
    const feedForward = Math.atan(def.wheelbase / radius) / Math.max(0.05, def.steering.maxAngle);
    c.steer = Math.max(-1, Math.min(1, -(feedForward + err * 0.25 + headingErr * 1.2)));
    const speed = forward(p);
    c.throttle = Math.max(0, Math.min(1, (target - speed) * 0.6 + 0.15));
    c.brake = speed > target + 2 ? 0.3 : 0;
    p.step();
    if (Math.abs(err) < 2 && speed > 3) {
      const g = (speed * speed) / radius / 9.81;
      window += DT;
      windowMin = Math.min(windowMin, g);
      if (window >= 1) {
        best = Math.max(best, windowMin);
        window = 0;
        windowMin = Infinity;
      }
      held += DT;
      if (held > 1.2) target += 0.004;
    } else {
      held = 0;
      window = 0;
      windowMin = Infinity;
      target = Math.max(4, target - 0.03);
    }
    if (p.upY() < 0.3) break;
  }
  return best;
}

/** J-turn at 70 km/h: full lock + handbrake. Returns the lowest body up.y (rollover if < 0.3). */
export function jTurn(rapier: Rapier, def: VehicleDef): { minUp: number; recovered: boolean } {
  const p = createPad(rapier, def);
  const c = p.vehicle.controls;
  c.throttle = 1;
  for (let t = 0; t < 30 && forward(p) < 70 / KMH; t += DT) p.step();
  c.throttle = 0;
  c.steer = -1;
  c.handbrake = true;
  let minUp = 1;
  for (let t = 0; t < 0.7; t += DT) {
    p.step();
    minUp = Math.min(minUp, p.upY());
  }
  c.handbrake = false;
  c.steer = 0;
  c.brake = 1;
  let stopped = false;
  for (let t = 0; t < 5 && !stopped; t += DT) {
    p.step();
    minUp = Math.min(minUp, p.upY());
    if (p.vehicle.speed < 1) stopped = true;
  }
  const recovered = stopped && p.upY() > 0.9;
  return { minUp, recovered };
}

/**
 * Drift recovery: handbrake turn at 60 km/h to start a slide, then throttle off and straight
 * steering. Returns seconds until the yaw rate settles (< 0.15 rad/s) and whether it stayed upright.
 */
export function driftRecovery(rapier: Rapier, def: VehicleDef): { settle: number; upright: boolean } {
  const p = createPad(rapier, def);
  const c = p.vehicle.controls;
  c.throttle = 1;
  for (let t = 0; t < 30 && forward(p) < 60 / KMH; t += DT) p.step();
  c.steer = -0.8;
  c.handbrake = true;
  p.step(0.5);
  c.handbrake = false;
  c.steer = 0;
  c.throttle = 0;
  let upright = true;
  for (let t = 0; t < 6; t += DT) {
    p.step();
    if (p.upY() < 0.5) upright = false;
    const yawRate = Math.abs(p.vehicle.body.angvel().y);
    if (yawRate < 0.15 && t > 0.3) return { settle: t, upright };
  }
  return { settle: Infinity, upright };
}

/** At 90 % of top speed, a gentle steering sine: the heading must follow without spinning. */
export function highSpeedStability(
  rapier: Rapier,
  def: VehicleDef,
  topKmh: number,
): { maxYawRate: number; upright: boolean } {
  const p = createPad(rapier, def);
  const c = p.vehicle.controls;
  c.throttle = 1;
  const target = (topKmh * 0.9) / KMH;
  for (let t = 0; t < 90 && forward(p) < target; t += DT) p.step();
  let maxYaw = 0;
  let upright = true;
  for (let t = 0; t < 6; t += DT) {
    c.steer = Math.sin(t * 2) * 0.15;
    p.step();
    maxYaw = Math.max(maxYaw, Math.abs(p.vehicle.body.angvel().y));
    if (p.upY() < 0.8) upright = false;
  }
  return { maxYawRate: maxYaw, upright };
}

/** Drives at top speed into a 0.3 m wall: returns how far past the wall face the car got (≤ ~0 = no tunnelling). */
export function tunnelling(rapier: Rapier, def: VehicleDef, kmh: number): number {
  const wallZ = 200;
  const p = createPad(rapier, def, (physics) => {
    physics.createFixedBox({ halfExtents: [20, 3, 0.15], position: [0, 3, wallZ] });
  });
  const v = p.vehicle;
  v.teleport(0, 0.05, wallZ - 60, 0);
  p.step(0.5);
  v.body.setLinvel({ x: 0, y: 0, z: kmh / KMH }, true);
  for (const w of v.wheels) w.omega = kmh / KMH / def.wheelRadius;
  v.controls.throttle = 1;
  let maxZ = -Infinity;
  for (let t = 0; t < 3; t += DT) {
    p.step();
    maxZ = Math.max(maxZ, v.body.translation().z + def.length / 2 - def.rearOverhang - def.wheelbase / 2);
  }
  return maxZ - (wallZ - 0.15);
}
