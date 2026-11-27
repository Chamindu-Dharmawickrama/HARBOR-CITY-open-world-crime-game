/** Engine, gearbox and driveline: pure functions plus a small state machine for shifting. */

export interface EngineSpec {
  idleRpm: number;
  /** Automatic upshift point and the rev limiter. */
  redlineRpm: number;
  /** Torque curve: [rpm, Nm] points, ascending rpm. */
  torqueCurve: readonly (readonly [number, number])[];
  /** Engine braking torque at the redline with the throttle closed (scales with rpm). */
  engineBraking: number;
}

export interface GearboxSpec {
  /** Forward ratios, first gear first. */
  ratios: readonly number[];
  reverse: number;
  finalDrive: number;
  /** Seconds without drive torque during a shift. */
  shiftTime: number;
  /** Automatic: upshift above this fraction of the redline, downshift below `downshift` × redline. */
  upshift: number;
  downshift: number;
  /** Driveline efficiency 0..1. */
  efficiency: number;
}

export type DriveLayout = 'FWD' | 'RWD' | 'AWD';

export interface DriveSpec {
  layout: DriveLayout;
  /** AWD only: fraction of torque to the front axle. */
  frontSplit: number;
  /** 0 = open differential, 1 = fully locked (share of torque moved toward the slower wheel). */
  limitedSlip: number;
}

/** Linear interpolation of the torque curve (clamped at the ends, zero past the limiter). */
export function engineTorque(spec: EngineSpec, rpm: number): number {
  const curve = spec.torqueCurve;
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 0;
  // Rev limiter: torque fades to zero over the last 3 % (smooth governor, no bouncing).
  if (rpm >= spec.redlineRpm * 1.03) return 0;
  if (rpm > spec.redlineRpm) return last[1] * (1 - (rpm - spec.redlineRpm) / (spec.redlineRpm * 0.03));
  if (rpm <= first[0]) return first[1];
  if (rpm >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i];
    if (rpm <= b[0]) {
      const a = curve[i - 1];
      const t = (rpm - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/** Peak engine power in watts (for sanity checks and the telemetry readout). */
export function peakPower(spec: EngineSpec): number {
  let best = 0;
  for (let rpm = spec.idleRpm; rpm <= spec.redlineRpm; rpm += 50) {
    best = Math.max(best, (engineTorque(spec, rpm) * rpm * Math.PI) / 30);
  }
  return best;
}

export const RAD_S_TO_RPM = 30 / Math.PI;

/** Drivetrain state for one vehicle. Gear 0 = neutral, −1 = reverse, 1.. = forward gears. */
export class Drivetrain {
  gear = 1;
  rpm: number;
  /** Seconds left in the current shift (no drive torque meanwhile). */
  shifting = 0;
  automatic = true;
  /** Clutch engagement 0..1 from the last update (launch slip at low speed). */
  clutch = 1;
  /** Seconds before the automatic box may shift again (prevents gear hunting). */
  private cooldown = 0;

  constructor(
    readonly engine: EngineSpec,
    readonly gearbox: GearboxSpec,
  ) {
    this.rpm = engine.idleRpm;
  }

  /** Overall ratio (gear × final drive) of the current gear; 0 in neutral. */
  get ratio(): number {
    const g = this.gearbox;
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -g.reverse * g.finalDrive;
    return (g.ratios[this.gear - 1] ?? 0) * g.finalDrive;
  }

  get topGear(): number {
    return this.gearbox.ratios.length;
  }

  /**
   * Jumps straight to the highest forward gear that keeps the engine comfortably above idle at
   * this wheel speed (no shift delay) — for a vehicle handed to the simulation already moving.
   */
  matchGear(wheelOmega: number): void {
    const e = this.engine;
    const g = this.gearbox;
    let pick = 1;
    for (let i = 1; i <= this.topGear; i++) {
      const rpm = Math.abs(wheelOmega * (g.ratios[i - 1] ?? 0) * g.finalDrive) * RAD_S_TO_RPM;
      if (rpm >= Math.max(e.idleRpm * 1.4, e.redlineRpm * 0.3)) pick = i;
    }
    this.gear = pick;
    this.shifting = 0;
    this.cooldown = 0.5;
    const rpm = Math.abs(wheelOmega * this.ratio) * RAD_S_TO_RPM;
    this.rpm = Math.max(e.idleRpm, Math.min(e.redlineRpm, rpm));
  }

  shiftTo(gear: number): void {
    const clamped = Math.max(-1, Math.min(this.topGear, gear));
    if (clamped === this.gear) return;
    this.gear = clamped;
    this.shifting = this.gearbox.shiftTime;
    this.cooldown = this.gearbox.shiftTime + 0.7;
  }

  /**
   * Advances the drivetrain and returns the total drive torque at the driven wheels (N·m).
   * @param wheelOmega Mean angular speed of the driven wheels (rad/s, + forward).
   * @param throttle 0..1 (already reduced by traction control).
   */
  update(wheelOmega: number, throttle: number, dt: number): number {
    const e = this.engine;
    if (this.shifting > 0) this.shifting = Math.max(0, this.shifting - dt);
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    const ratio = this.ratio;
    // Engine speed follows the wheels through the gearbox; below idle the clutch slips.
    const coupled = Math.abs(wheelOmega * ratio) * RAD_S_TO_RPM;
    const launchRpm = e.idleRpm + (e.redlineRpm - e.idleRpm) * 0.35 * throttle;
    if (ratio === 0 || this.shifting > 0) {
      this.clutch = 0;
      const target = ratio === 0 ? e.idleRpm + (e.redlineRpm - e.idleRpm) * throttle : coupled;
      this.rpm += (Math.max(e.idleRpm, target) - this.rpm) * Math.min(1, dt * 8);
    } else if (coupled < launchRpm) {
      this.clutch = Math.max(0.15, coupled / launchRpm);
      this.rpm += (launchRpm - this.rpm) * Math.min(1, dt * 10);
    } else {
      this.clutch = 1;
      this.rpm = coupled;
    }
    this.rpm = Math.max(e.idleRpm, Math.min(e.redlineRpm * 1.02, this.rpm));

    if (this.automatic) this.autoShift(wheelOmega, throttle);
    if (ratio === 0 || this.shifting > 0) return 0;

    const drive = engineTorque(e, this.rpm) * throttle;
    // Closed throttle: engine braking opposes wheel rotation (only when the clutch is engaged).
    const braking = throttle < 0.05 && this.clutch >= 1 ? (e.engineBraking * this.rpm) / e.redlineRpm : 0;
    const sign = Math.sign(ratio);
    const wheelDir = Math.sign(wheelOmega) || sign;
    return drive * ratio * this.gearbox.efficiency - braking * Math.abs(ratio) * wheelDir;
  }

  private autoShift(wheelOmega: number, throttle: number): void {
    if (this.gear <= 0 || this.shifting > 0) return;
    // Upshifts may follow each other quickly; downshifts wait for the cooldown.
    const e = this.engine;
    const g = this.gearbox;
    const coupled = Math.abs(wheelOmega * this.ratio) * RAD_S_TO_RPM;
    if (this.gear < this.topGear && coupled > e.redlineRpm * g.upshift && throttle > 0.1) {
      this.shiftTo(this.gear + 1);
      return;
    }
    if (this.gear > 1 && this.cooldown <= 0) {
      // Downshift (or kick down under full throttle) only if the lower gear lands well below the
      // upshift point — otherwise the box would hunt between two gears.
      const lowerRatio = (g.ratios[this.gear - 2] ?? 0) * g.finalDrive;
      const lowerRpm = Math.abs(wheelOmega * lowerRatio) * RAD_S_TO_RPM;
      const threshold = e.redlineRpm * (throttle > 0.8 ? g.downshift + 0.1 : g.downshift);
      if (coupled < threshold && lowerRpm < e.redlineRpm * 0.8) this.shiftTo(this.gear - 1);
    }
  }
}

/**
 * Splits axle torque between left and right wheels. A limited-slip differential moves up to
 * `limitedSlip` of the torque toward the slower wheel, so one spinning wheel cannot waste it all.
 */
export function splitAxleTorque(
  torque: number,
  omegaLeft: number,
  omegaRight: number,
  limitedSlip: number,
  out: { left: number; right: number },
): void {
  const diff = omegaLeft - omegaRight;
  const sum = Math.abs(omegaLeft) + Math.abs(omegaRight) + 1;
  const bias = Math.max(-1, Math.min(1, diff / sum)) * limitedSlip;
  out.left = torque * 0.5 * (1 - bias);
  out.right = torque * 0.5 * (1 + bias);
}
