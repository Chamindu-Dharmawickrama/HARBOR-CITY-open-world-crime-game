export interface Vec2Out {
  x: number;
  y: number;
}

/**
 * Radial deadzone with rescaling: input inside `inner` reads as zero, input beyond `outer`
 * reads as full magnitude, and the range between is remapped linearly so there is no jump at
 * the deadzone edge. Direction is preserved.
 */
export function applyRadialDeadzone(
  x: number,
  y: number,
  inner: number,
  outer: number,
  out: Vec2Out,
): Vec2Out {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= inner || magnitude === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = Math.min(1, (magnitude - inner) / Math.max(1e-6, outer - inner));
  const factor = scaled / magnitude;
  out.x = x * factor;
  out.y = y * factor;
  return out;
}

/** Response curve for look sticks: keeps fine aiming near centre, full speed at the edge. */
export function lookCurve(value: number, exponent = 1.8): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}
