import type { AeroSpec, AssistSpec, BrakeSpec, SteeringSpec, SuspensionSpec } from './physics/chassis';
import type { DriveSpec, EngineSpec, GearboxSpec } from './physics/drivetrain';
import type { TireParams } from './physics/tire';

export type VehicleClass =
  | 'compact'
  | 'sedan'
  | 'taxi'
  | 'sports'
  | 'muscle'
  | 'pickup'
  | 'van'
  | 'bus'
  | 'motorbike'
  | 'police'
  | 'ambulance'
  | 'swat'
  | 'armored'
  | 'speedboat'
  | 'policeBoat';

export type VehicleKind = 'car' | 'bike' | 'boat';

/** Shape family for the procedural body generator. */
export type BodyStyle =
  'hatch' | 'sedan' | 'coupe' | 'muscle' | 'pickup' | 'van' | 'bus' | 'truck' | 'bike' | 'boat';

/** Livery painted over the base colour. */
export type Livery = 'none' | 'taxi' | 'police' | 'ambulance' | 'swat' | 'armored';

/** Handling acceptance ranges checked by the handling harness. */
export interface HandlingTargets {
  zeroTo100: readonly [number, number];
  topSpeedKmh: readonly [number, number];
  brake100To0: readonly [number, number];
  skidpadG: readonly [number, number];
}

export interface BoatSpec {
  /** Thrust at full throttle, N. */
  thrust: number;
  reverseThrust: number;
  /** Rudder side force per (m/s)² of forward speed at full deflection (plus 20 % of thrust as prop wash). */
  rudder: number;
  /** Water drag coefficients (N per (m/s)²) along and across the hull. */
  dragForward: number;
  dragSideways: number;
  /** Buoyancy spring per metre of submersion per sample point, N/m, and its damping. */
  buoyancy: number;
  buoyancyDamping: number;
  /** Hull draft at rest, metres. */
  draft: number;
}

/**
 * Everything that defines one vehicle model. Local frame: +Z forward, +X left, +Y up; origin at
 * the middle of the wheelbase on the ground (road surface at rest).
 */
export interface VehicleDef {
  id: string;
  /** Display name (original, in-world brand + model). */
  name: string;
  class: VehicleClass;
  kind: VehicleKind;
  style: BodyStyle;
  livery: Livery;
  /** Base paint colours to pick from (hex sRGB). */
  colours: readonly number[];
  mass: number;
  /** Overall body size, metres. */
  length: number;
  width: number;
  height: number;
  /** Ground clearance of the body underside at rest. */
  clearance: number;
  /** Centre of mass: height above the ground and offset forward of the wheelbase middle. */
  comHeight: number;
  comForward: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Rear overhang (body behind the rear axle), metres. */
  rearOverhang: number;
  suspension: SuspensionSpec;
  tire: TireParams;
  /** Grip multipliers per axle (balance tuning). */
  frontGrip: number;
  rearGrip: number;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  drive: DriveSpec;
  brakes: BrakeSpec;
  steering: SteeringSpec;
  aero: AeroSpec;
  assists: AssistSpec;
  /** Number of side doors (0 for bikes/boats). Seats: driver + passengers. */
  doors: 0 | 2 | 4;
  seats: number;
  /** Engine health (hit points before it catches fire and then explodes). */
  durability: number;
  /** Police / emergency light bar on the roof. */
  lightBar: boolean;
  boat?: BoatSpec;
  targets: HandlingTargets;
}

export function isRoadVehicle(def: VehicleDef): boolean {
  return def.kind !== 'boat';
}
