import { sampleHourly } from '../core/time-of-day';
import type { DistrictId } from '../world/gen/types';

/** Hourly population curves (0..1 of the preset cap), per district (content data). */
export interface DensityCurves {
  peds: Readonly<Record<DistrictId, readonly number[]>>;
  cars: Readonly<Record<DistrictId, readonly number[]>>;
}

export type PopulationKind = 'peds' | 'cars';

/** Density 0..1 for a district (bridges / water fall back to downtown) at a time of day. */
export function densityAt(
  curves: DensityCurves,
  kind: PopulationKind,
  district: DistrictId | null,
  hours: number,
): number {
  const curve = curves[kind][district ?? 'meridian'];
  return Math.max(0, Math.min(1, sampleHourly(curve, hours)));
}

/** How many to keep around the camera: the cap scaled by the density, never above the cap. */
export function targetCount(cap: number, density: number): number {
  return Math.max(0, Math.min(cap, Math.round(cap * density)));
}
