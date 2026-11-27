/** Intelligent Driver Model parameters (SI units). */
export interface IdmParams {
  /** Maximum acceleration (m/s²). */
  a: number;
  /** Comfortable deceleration (m/s², positive). */
  b: number;
  /** Desired time headway (s). */
  T: number;
  /** Minimum standstill gap (m). */
  s0: number;
  /** Acceleration exponent. */
  delta: number;
}

/** Hardest braking the model may ask for (m/s², positive). */
export const IDM_MAX_DECEL = 9;

/** Free-road term: acceleration toward the desired speed `v0` with no leader. */
export function idmFree(p: IdmParams, v: number, v0: number): number {
  if (v0 <= 0.01) return -p.b * Math.min(1, v / 2);
  const ratio = v / v0;
  if (ratio <= 1) return p.a * (1 - ratio ** p.delta);
  // Above the desired speed: brake back toward it, no harder than comfortable.
  return -Math.min(p.b, p.a * (ratio ** p.delta - 1));
}

/**
 * IDM acceleration behind a leader: `gap` = bumper-to-bumper distance (m), `dv` = own speed minus
 * leader speed (m/s, positive when closing in). Clamped to [−IDM_MAX_DECEL, a].
 */
export function idmAccel(p: IdmParams, v: number, v0: number, gap: number, dv: number): number {
  const free = idmFree(p, v, v0);
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(0.05, gap);
  const interaction = p.a * (sStar / g) ** 2;
  return Math.max(-IDM_MAX_DECEL, Math.min(p.a, free - interaction));
}

/** Deceleration needed to stop within `distance` from speed v (m/s², positive). */
export function stoppingDecel(v: number, distance: number): number {
  if (v <= 0) return 0;
  if (distance <= 0.01) return Infinity;
  return (v * v) / (2 * distance);
}

/** Highest speed at distance `d` before a point that must be passed at `vTarget`, braking at `b`. */
export function approachSpeed(vTarget: number, d: number, b: number): number {
  return Math.sqrt(vTarget * vTarget + 2 * b * Math.max(0, d));
}
