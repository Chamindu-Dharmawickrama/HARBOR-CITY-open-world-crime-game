import type { RoadClass } from './types';

/**
 * Cross-section rules shared by lane generation and curb parking: streets wide enough for curb
 * parking keep a strip along each kerb clear of traffic lanes.
 */
export const CURB_PARKING_MIN_WIDTH = 9;
/** Width of the parking strip along each kerb of a curb-parking street (metres). */
export const CURB_PARKING_STRIP = 2.1;
/** Parked cars stand this far in from the kerb line (car centre to kerb minus half a car). */
export const CURB_PARKING_INSET = 1.05;

export function hasCurbParking(cls: RoadClass, width: number): boolean {
  return cls === 'street' && width >= CURB_PARKING_MIN_WIDTH;
}

/** Width of one traffic lane: the carriageway minus any parking strips, split between the lanes. */
export function laneWidthFor(cls: RoadClass, width: number, lanesPerDirection: number): number {
  const driving = hasCurbParking(cls, width) ? width - 2 * CURB_PARKING_STRIP : width;
  return driving / (2 * Math.max(1, lanesPerDirection));
}
