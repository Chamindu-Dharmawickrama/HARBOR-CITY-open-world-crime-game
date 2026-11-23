/**
 * Pacejka-lite tire model. Longitudinal slip ratio and lateral slip angle are normalised by
 * their peak values and combined into one slip magnitude (the "similarity" method), so a wheel
 * that is spinning or locked automatically loses side grip — which is what makes handbrake turns
 * and power slides work.
 */
export interface TireParams {
  /** Peak friction coefficient at the nominal load. */
  mu: number;
  /** Fractional loss of mu per 100 % of extra load over nominal (load sensitivity). */
  loadSensitivity: number;
  /** Load (N) at which `mu` applies. */
  nominalLoad: number;
  /** Slip ratio at peak longitudinal force (≈ 0.08–0.15). */
  peakSlipRatio: number;
  /** Slip angle at peak lateral force, radians (≈ 0.10–0.18). */
  peakSlipAngle: number;
  /**
   * Magic-formula shape factor C (1.2–1.8): higher = sharper peak and lower grip once sliding.
   * Grip at full slide is sin(C·π/2) of the peak.
   */
  shape: number;
  /** Lateral peak as a fraction of longitudinal peak. */
  lateralFactor: number;
}

export interface TireForces {
  /** Longitudinal force along the wheel heading, N (+ = forward). */
  fx: number;
  /** Lateral force along the wheel's left axis, N (+ = toward the wheel's left). */
  fy: number;
  /** Combined normalised slip (1 = at the peak; > 1 = sliding). */
  slip: number;
}

export function createTireForces(): TireForces {
  return { fx: 0, fy: 0, slip: 0 };
}

/** Normalised magic-formula curve with its peak (= 1) at s = 1. */
export function slipCurve(s: number, shape: number): number {
  const b = Math.tan(Math.PI / (2 * shape));
  return Math.sin(shape * Math.atan(b * s));
}

/** Effective peak friction at load `fz` (load sensitivity, clamped to stay positive). */
export function effectiveMu(p: TireParams, fz: number): number {
  const over = fz / p.nominalLoad - 1;
  return p.mu * Math.max(0.5, Math.min(1.15, 1 - p.loadSensitivity * over));
}

/**
 * Tire forces for normal load `fz` (N), slip ratio κ (+ = driving/spinning, − = braking/locked),
 * slip angle α (radians, + = contact patch sliding toward the wheel's left ⇒ force to the right),
 * and a grip multiplier (surface, handbrake). Writes into `out`.
 */
export function computeTireForces(
  p: TireParams,
  fz: number,
  slipRatio: number,
  slipAngle: number,
  grip: number,
  out: TireForces,
): TireForces {
  if (fz <= 0 || grip <= 0) {
    out.fx = 0;
    out.fy = 0;
    out.slip = 0;
    return out;
  }
  const sx = slipRatio / p.peakSlipRatio;
  const sy = Math.tan(Math.max(-1.45, Math.min(1.45, slipAngle))) / Math.tan(p.peakSlipAngle);
  const s = Math.sqrt(sx * sx + sy * sy);
  out.slip = s;
  if (s < 1e-9) {
    out.fx = 0;
    out.fy = 0;
    return out;
  }
  const peak = effectiveMu(p, fz) * fz * grip;
  const f = peak * slipCurve(s, p.shape);
  out.fx = (f * sx) / s;
  out.fy = (-f * sy * p.lateralFactor) / s;
  return out;
}
