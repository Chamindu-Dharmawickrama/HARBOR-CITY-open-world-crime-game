/** Suspension, anti-roll, brakes/assists, steering and aerodynamics — small pure functions. */

export interface SuspensionSpec {
  /** Spring travel above the rest position plus droop below, metres. */
  restLength: number;
  travel: number;
  /** Spring rate front/rear, N/m. */
  stiffnessFront: number;
  stiffnessRear: number;
  /** Damping N·s/m for compression (bump) and extension (rebound). */
  bump: number;
  rebound: number;
  /** Anti-roll bar rate per axle, N per metre of left/right compression difference. */
  antiRollFront: number;
  antiRollRear: number;
}

/**
 * Suspension normal force for a wheel: spring on compression plus direction-dependent damping,
 * with a stiff bump stop in the last 10 % of travel. Never pulls the wheel down (≥ 0).
 */
export function suspensionForce(
  compression: number,
  compressionSpeed: number,
  stiffness: number,
  bump: number,
  rebound: number,
  travel: number,
): number {
  const damping = compressionSpeed > 0 ? bump : rebound;
  let force = stiffness * compression + damping * compressionSpeed;
  const stop = travel * 0.9;
  if (compression > stop) force += stiffness * 12 * (compression - stop);
  return Math.max(0, force);
}

/** Anti-roll bar: extra force on the more compressed side (+) and relief on the other (−). */
export function antiRollForce(compressionLeft: number, compressionRight: number, rate: number): number {
  return (compressionLeft - compressionRight) * rate;
}

export interface BrakeSpec {
  /** Total brake torque at full pedal, N·m (all wheels). */
  maxTorque: number;
  /** Fraction to the front axle. */
  frontBias: number;
  /** Rear handbrake torque per wheel, N·m. */
  handbrakeTorque: number;
}

export interface AssistSpec {
  abs: boolean;
  tcs: boolean;
  /** 0..1 automatic counter-steer strength (helps catch slides). */
  yawAssist: number;
}

/** ABS: eases the brake off a wheel whose slip ratio is beyond the locking threshold. */
export function absModulate(brakeTorque: number, slipRatio: number, speed: number): number {
  if (speed < 2.5 || brakeTorque <= 0) return brakeTorque;
  const lock = -slipRatio;
  if (lock <= 0.12) return brakeTorque;
  return brakeTorque * Math.max(0.15, 1 - (lock - 0.12) * 6);
}

/** Traction control: throttle multiplier from the worst driven-wheel slip ratio. */
export function tcsThrottle(throttle: number, maxDrivenSlip: number, speed: number): number {
  // Hold driven slip near the tire's peak (≈ 0.1) so some side grip is always left over.
  const limit = speed < 4 ? 0.22 : 0.12;
  if (maxDrivenSlip <= limit) return throttle;
  return throttle * Math.max(0.12, 1 - (maxDrivenSlip - limit) * 9);
}

export interface SteeringSpec {
  /** Maximum road-wheel angle at standstill, radians. */
  maxAngle: number;
  /** Speed (m/s) at which the available lock has halved. */
  halfLockSpeed: number;
  /** How fast the wheels turn, rad/s. */
  rate: number;
}

/** Available steering lock at `speed` (speed-sensitive steering). */
export function steeringLimit(spec: SteeringSpec, speed: number): number {
  const r = Math.abs(speed) / spec.halfLockSpeed;
  return spec.maxAngle / (1 + r * r);
}

/** Moves the current wheel angle toward the requested one at the steering rate. */
export function steerToward(current: number, target: number, spec: SteeringSpec, dt: number): number {
  const max = spec.rate * dt;
  return current + Math.max(-max, Math.min(max, target - current));
}

export interface AeroSpec {
  /** Drag coefficient × frontal area, m². */
  dragArea: number;
  /** Downforce coefficient × area, m² (0 for most road cars). */
  liftArea: number;
  /** Rolling resistance coefficient. */
  rollingResistance: number;
}

export const AIR_DENSITY = 1.225;

export function dragForce(spec: AeroSpec, speed: number): number {
  return 0.5 * AIR_DENSITY * spec.dragArea * speed * speed;
}

export function downForce(spec: AeroSpec, speed: number): number {
  return 0.5 * AIR_DENSITY * spec.liftArea * speed * speed;
}
