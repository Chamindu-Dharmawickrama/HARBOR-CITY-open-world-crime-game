export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Maps value from [inMin, inMax] to [outMin, outMax], clamped to the output range. */
export function remapClamped(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing toward target.
 * `lambda` is the decay rate in 1/s (higher = snappier).
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Moves current toward target by at most maxDelta. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = (angle + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon;
}

export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * Exact critically damped spring step (no overshoot). `omega` is the natural frequency in rad/s;
 * the spring settles in roughly 4/omega seconds. Mutates `state`.
 */
export function stepCriticalSpring(state: SpringState, target: number, omega: number, dt: number): void {
  const offset = state.value - target;
  const j = state.velocity + offset * omega;
  const decay = Math.exp(-omega * dt);
  state.value = target + (offset + j * dt) * decay;
  state.velocity = (state.velocity - j * omega * dt) * decay;
}
