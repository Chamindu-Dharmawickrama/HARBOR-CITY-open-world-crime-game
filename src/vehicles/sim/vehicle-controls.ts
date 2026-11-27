/** Driver inputs for one vehicle (player, AI or tests). */
export interface VehicleControls {
  /** 0..1 accelerator. */
  throttle: number;
  /** 0..1 brake pedal (also reverse throttle when stopped/reversing). */
  brake: number;
  /** −1..1, + = steer right. */
  steer: number;
  handbrake: boolean;
  /**
   * Holding the brake at a standstill engages reverse (arcade controls). AI drivers turn this off:
   * they brake to hold a stop and must never roll backwards.
   */
  allowReverse: boolean;
}

export function emptyControls(): VehicleControls {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, allowReverse: true };
}

/** Parked: no driver — brakes and handbrake hold the car. */
export function parkedControls(out: VehicleControls): VehicleControls {
  out.throttle = 0;
  out.brake = 1;
  out.steer = 0;
  out.handbrake = true;
  out.allowReverse = true;
  return out;
}
