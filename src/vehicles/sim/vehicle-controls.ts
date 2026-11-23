/** Driver inputs for one vehicle (player, AI or tests). */
export interface VehicleControls {
  /** 0..1 accelerator. */
  throttle: number;
  /** 0..1 brake pedal (also reverse throttle when stopped/reversing). */
  brake: number;
  /** −1..1, + = steer right. */
  steer: number;
  handbrake: boolean;
}

export function emptyControls(): VehicleControls {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false };
}

/** Parked: no driver — brakes and handbrake hold the car. */
export function parkedControls(out: VehicleControls): VehicleControls {
  out.throttle = 0;
  out.brake = 1;
  out.steer = 0;
  out.handbrake = true;
  return out;
}
