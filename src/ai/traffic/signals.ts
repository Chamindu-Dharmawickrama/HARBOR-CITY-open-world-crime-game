/** Traffic light aspects. */
export const Light = { green: 0, amber: 1, red: 2 } as const;
export type LightState = (typeof Light)[keyof typeof Light];

/** Pedestrian signal aspects: walk, flashing don't-walk (finish crossing), don't walk. */
export const Walk = { walk: 0, flash: 1, dont: 2 } as const;
export type WalkState = (typeof Walk)[keyof typeof Walk];

export interface SignalTiming {
  /** Green time of each phase in turn (s); usually two phases, three for awkward junctions. */
  green: readonly number[];
  amber: number;
  /** All-red clearance after each amber (s). */
  allRed: number;
  /** Seconds into the cycle at sim time 0. */
  offset: number;
  /** Pedestrians stop starting to cross this long before their crossing traffic gets green (s). */
  pedClearance: number;
}

export const DEFAULT_TIMING: SignalTiming = {
  green: [18, 14],
  amber: 3,
  allRed: 1.5,
  offset: 0,
  pedClearance: 7,
};

export function cycleLength(t: SignalTiming): number {
  let c = 0;
  for (const g of t.green) c += g + t.amber + t.allRed;
  return c;
}

/** Position in the cycle at sim time `time`. */
function cycleTime(t: SignalTiming, time: number): number {
  const c = cycleLength(t);
  const u = (time + t.offset) % c;
  return u < 0 ? u + c : u;
}

/** Start of `phase`'s green within the cycle. */
function greenStart(t: SignalTiming, phase: number): number {
  let s = 0;
  for (let i = 0; i < phase && i < t.green.length; i++) s += t.green[i] + t.amber + t.allRed;
  return s;
}

/** Seconds since `phase`'s green last started. */
function sinceGreen(t: SignalTiming, phase: number, time: number): number {
  const c = cycleLength(t);
  const v = cycleTime(t, time) - greenStart(t, phase);
  return v < 0 ? v + c : v;
}

/** Light shown to approaches of `phase` at sim time `time`. */
export function lightAt(t: SignalTiming, phase: number, time: number): LightState {
  const v = sinceGreen(t, phase, time);
  const g = t.green[phase] ?? 0;
  if (v < g) return Light.green;
  if (v < g + t.amber) return Light.amber;
  return Light.red;
}

/** Seconds until the light of `phase` next changes aspect. */
export function timeToChange(t: SignalTiming, phase: number, time: number): number {
  const v = sinceGreen(t, phase, time);
  const g = t.green[phase] ?? 0;
  if (v < g) return g - v;
  if (v < g + t.amber) return g + t.amber - v;
  return cycleLength(t) - v;
}

/**
 * Pedestrian signal for a crosswalk across an approach of `armPhase`: people may start to cross
 * while that approach's traffic is held at red and will stay red for longer than the clearance
 * time; then the aspect flashes until the approach gets green.
 */
export function walkAt(t: SignalTiming, armPhase: number, time: number): WalkState {
  if (lightAt(t, armPhase, time) !== Light.red) return Walk.dont;
  const untilGreen = timeToChange(t, armPhase, time);
  return untilGreen > t.pedClearance ? Walk.walk : Walk.flash;
}
