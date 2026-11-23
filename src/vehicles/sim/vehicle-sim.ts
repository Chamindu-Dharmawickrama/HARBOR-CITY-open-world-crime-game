import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { VehicleDef } from '../vehicle-def';
import type { VehicleControls } from './vehicle-controls';

/** Live readout for HUD/telemetry/audio. */
export interface VehicleTelemetry {
  speed: number;
  forwardSpeed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  lateralG: number;
  longitudinalG: number;
  groundedWheels: number;
}

export function createTelemetry(): VehicleTelemetry {
  return {
    speed: 0,
    forwardSpeed: 0,
    rpm: 0,
    gear: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    lateralG: 0,
    longitudinalG: 0,
    groundedWheels: 0,
  };
}

/** Open water lookup (the same shape the character motor uses). */
export interface WaterQuery {
  readonly waterLevel: number;
  isWater(x: number, z: number): boolean;
}

/** Common surface of every drivable simulation (cars, bikes, boats). */
export interface VehicleSim {
  readonly body: RigidBody;
  readonly def: VehicleDef;
  readonly controls: VehicleControls;
  readonly telemetry: VehicleTelemetry;
  /** The engine runs (hotwired / driven). */
  engineOn: boolean;
  /** Multiplies drive power (damage lowers it). */
  enginePower: number;
  readonly speed: number;
  step(dt: number): void;
  teleport(x: number, y: number, z: number, yaw: number): void;
  dispose(): void;
}
