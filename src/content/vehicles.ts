import type { TireParams } from '../vehicles/physics/tire';
import type { BoatSpec, HandlingTargets, VehicleDef } from '../vehicles/vehicle-def';

/**
 * Vehicle catalogue (original makes and models). Each road vehicle is generated from a few
 * headline numbers — power, top speed, mass, size — so gearing and drag are consistent with the
 * handling targets that the handling harness (vehicles/handling.int.test.ts) checks.
 */

const G = 9.81;
const RHO = 1.225;

const STREET_TIRE: TireParams = {
  mu: 1.04,
  loadSensitivity: 0.08,
  nominalLoad: 4000,
  peakSlipRatio: 0.1,
  peakSlipAngle: 0.14,
  shape: 1.5,
  lateralFactor: 0.95,
};

interface Headline {
  id: string;
  name: string;
  class: VehicleDef['class'];
  style: VehicleDef['style'];
  livery?: VehicleDef['livery'];
  colours: readonly number[];
  mass: number;
  size: readonly [length: number, width: number, height: number];
  clearance: number;
  comHeight: number;
  /** CoM ahead of the wheelbase middle (m). */
  comForward: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  wheelWidth: number;
  rearOverhang: number;
  /** Peak engine power (kW) and the rpm band. */
  powerKw: number;
  idleRpm: number;
  redlineRpm: number;
  gears: number;
  layout: VehicleDef['drive']['layout'];
  frontSplit?: number;
  limitedSlip?: number;
  topSpeedKmh: number;
  /**
   * Speed governor: top gear reaches the limiter at this speed (buses, trucks). Drag is then sized
   * for `topSpeedKmh`, which should be higher, so the vehicle pulls strongly up to the governor.
   */
  governorKmh?: number;
  /** Shift time (s). */
  shiftTime?: number;
  tire?: Partial<TireParams>;
  frontGrip?: number;
  rearGrip?: number;
  /** Deceleration the brakes can demand (g) and front bias. */
  brakeG: number;
  frontBias?: number;
  /** Static suspension sag (m) and damping ratio. */
  sag: number;
  damping?: number;
  antiRoll?: number;
  liftArea?: number;
  steerDeg?: number;
  halfLockSpeed?: number;
  abs?: boolean;
  tcs?: boolean;
  yawAssist?: number;
  doors: 0 | 2 | 4;
  seats: number;
  durability: number;
  lightBar?: boolean;
  targets: HandlingTargets;
}

/** Torque curve with peak power at 85 % of the redline. */
function torqueCurve(powerKw: number, idle: number, redline: number): [number, number][] {
  const peakRpm = 0.85 * redline;
  const peakTorque = (powerKw * 1000) / ((peakRpm * Math.PI) / 30) / 0.97;
  return [
    [idle, peakTorque * 0.72],
    [redline * 0.35, peakTorque * 0.9],
    [redline * 0.6, peakTorque],
    [peakRpm, peakTorque * 0.97],
    [redline, peakTorque * 0.84],
  ];
}

function build(h: Headline): VehicleDef {
  const [length, width, height] = h.size;
  const vTop = h.topSpeedKmh / 3.6;
  const crr = h.class === 'bus' || h.class === 'armored' || h.class === 'swat' ? 0.009 : 0.012;
  const efficiency = 0.9;
  // Top gear puts peak power at the target top speed; drag absorbs exactly that power there.
  const topOverall = h.governorKmh
    ? (h.redlineRpm * Math.PI) / 30 / (h.governorKmh / 3.6 / h.wheelRadius)
    : (0.85 * h.redlineRpm * Math.PI) / 30 / (vTop / h.wheelRadius);
  const wheelPower = h.powerKw * 1000 * efficiency;
  const dragArea = Math.max(0.25, (wheelPower - crr * h.mass * G * vTop) / (0.5 * RHO * vTop ** 3));
  // First gear spans a fixed ratio over top gear (traction control handles wheelspin).
  const peakTorque = torqueCurve(h.powerKw, h.idleRpm, h.redlineRpm)[2][1];
  const firstOverall = topOverall * (h.gears >= 6 ? 3.4 : h.gears === 5 ? 3.1 : 2.7);
  const finalDrive = 3.5;
  const ratios: number[] = [];
  for (let i = 0; i < h.gears; i++) {
    const t = h.gears === 1 ? 1 : i / (h.gears - 1);
    // Geometric spacing, slightly closer at the top.
    const overall = firstOverall * Math.pow(topOverall / firstOverall, Math.pow(t, 0.9));
    ratios.push(overall / finalDrive);
  }
  const frontShare = (h.wheelbase / 2 + h.comForward) / h.wheelbase;
  const perAxle = h.style === 'bike' ? 1 : 2;
  const kFront = (h.mass * G * frontShare) / perAxle / h.sag;
  const kRear = (h.mass * G * (1 - frontShare)) / perAxle / h.sag;
  const quarter = h.mass / (perAxle * 2);
  const critical = 2 * Math.sqrt(((kFront + kRear) / 2) * quarter);
  const zeta = h.damping ?? 0.38;
  const restLength = Math.max(0.16, h.sag * 2.6);
  const tire: TireParams = { ...STREET_TIRE, ...h.tire, nominalLoad: (h.mass * G) / (perAxle * 2) };
  return {
    id: h.id,
    name: h.name,
    class: h.class,
    kind: h.style === 'bike' ? 'bike' : 'car',
    style: h.style,
    livery: h.livery ?? 'none',
    colours: h.colours,
    mass: h.mass,
    length,
    width,
    height,
    clearance: h.clearance,
    comHeight: h.comHeight,
    comForward: h.comForward,
    wheelbase: h.wheelbase,
    track: h.track,
    wheelRadius: h.wheelRadius,
    wheelWidth: h.wheelWidth,
    rearOverhang: h.rearOverhang,
    suspension: {
      restLength,
      travel: restLength,
      stiffnessFront: kFront,
      stiffnessRear: kRear,
      bump: critical * zeta,
      rebound: critical * zeta * 1.35,
      antiRollFront: (kFront + kRear) * 0.5 * (h.antiRoll ?? 0.6),
      antiRollRear: (kFront + kRear) * 0.5 * (h.antiRoll ?? 0.6) * 0.75,
    },
    tire,
    frontGrip: h.frontGrip ?? 1,
    rearGrip: h.rearGrip ?? 1.04,
    engine: {
      idleRpm: h.idleRpm,
      redlineRpm: h.redlineRpm,
      torqueCurve: torqueCurve(h.powerKw, h.idleRpm, h.redlineRpm),
      engineBraking: peakTorque * 0.22,
    },
    gearbox: {
      ratios,
      reverse: ratios[0] * 1.05,
      finalDrive,
      shiftTime: h.shiftTime ?? 0.22,
      upshift: 0.97,
      downshift: 0.5,
      efficiency,
    },
    drive: { layout: h.layout, frontSplit: h.frontSplit ?? 0.4, limitedSlip: h.limitedSlip ?? 0.35 },
    brakes: {
      maxTorque: h.brakeG * 1.3 * h.mass * G * h.wheelRadius,
      frontBias: h.frontBias ?? 0.66,
      handbrakeTorque: h.mass * G * 0.35 * h.wheelRadius,
    },
    steering: {
      maxAngle: ((h.steerDeg ?? 36) * Math.PI) / 180,
      halfLockSpeed: h.halfLockSpeed ?? 26,
      rate: 2.6,
    },
    aero: { dragArea, liftArea: h.liftArea ?? 0, rollingResistance: crr },
    assists: { abs: h.abs ?? true, tcs: h.tcs ?? true, yawAssist: h.yawAssist ?? 0.4 },
    doors: h.doors,
    seats: h.seats,
    durability: h.durability,
    lightBar: h.lightBar ?? false,
    targets: h.targets,
  };
}

const CIVIL_COLOURS = [
  0xb8bcc2, 0x2b2f36, 0x8e1c1c, 0x1f3f6e, 0xe6e3dc, 0x3c5a3a, 0x6b6f75, 0xa06a2c, 0x4a2a5e, 0x101418,
];

export const VEHICLES: readonly VehicleDef[] = [
  build({
    id: 'brisa',
    name: 'Vellum Brisa',
    class: 'compact',
    style: 'hatch',
    colours: [0xd9c84a, 0x3a7bb8, 0xc2402c, 0xe6e3dc, 0x5b8f4b, 0x2b2f36],
    mass: 1100,
    size: [3.95, 1.72, 1.48],
    clearance: 0.15,
    comHeight: 0.52,
    comForward: 0.2,
    wheelbase: 2.5,
    track: 1.46,
    wheelRadius: 0.3,
    wheelWidth: 0.19,
    rearOverhang: 0.62,
    powerKw: 84,
    idleRpm: 850,
    redlineRpm: 6600,
    gears: 5,
    layout: 'FWD',
    topSpeedKmh: 165,
    brakeG: 1.0,
    sag: 0.075,
    doors: 4,
    seats: 4,
    durability: 900,
    targets: { zeroTo100: [9, 11], topSpeedKmh: [155, 175], brake100To0: [35, 45], skidpadG: [0.8, 1.1] },
  }),
  build({
    id: 'meridian',
    name: 'Arbor Meridian',
    class: 'sedan',
    style: 'sedan',
    colours: CIVIL_COLOURS,
    mass: 1480,
    size: [4.75, 1.83, 1.45],
    clearance: 0.15,
    comHeight: 0.54,
    comForward: 0.12,
    wheelbase: 2.82,
    track: 1.57,
    wheelRadius: 0.32,
    wheelWidth: 0.22,
    rearOverhang: 1.0,
    powerKw: 118,
    idleRpm: 800,
    redlineRpm: 6400,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 185,
    brakeG: 1.0,
    sag: 0.08,
    doors: 4,
    seats: 4,
    durability: 1000,
    targets: { zeroTo100: [8, 9.5], topSpeedKmh: [175, 195], brake100To0: [35, 45], skidpadG: [0.8, 1.1] },
  }),
  build({
    id: 'cab',
    name: 'Arbor Meridian Cab',
    class: 'taxi',
    style: 'sedan',
    livery: 'taxi',
    colours: [0xf2b705],
    mass: 1530,
    size: [4.75, 1.83, 1.45],
    clearance: 0.15,
    comHeight: 0.55,
    comForward: 0.12,
    wheelbase: 2.82,
    track: 1.57,
    wheelRadius: 0.32,
    wheelWidth: 0.22,
    rearOverhang: 1.0,
    powerKw: 119,
    idleRpm: 800,
    redlineRpm: 6400,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 185,
    brakeG: 1.0,
    sag: 0.08,
    doors: 4,
    seats: 4,
    durability: 1050,
    targets: { zeroTo100: [8, 9.5], topSpeedKmh: [175, 195], brake100To0: [35, 45], skidpadG: [0.8, 1.1] },
  }),
  build({
    id: 'vireo',
    name: 'Corsa Vireo GT',
    class: 'sports',
    style: 'coupe',
    colours: [0xc4161c, 0xf0f0f0, 0x111111, 0xf28c00, 0x1b6fd1, 0x9dd13a],
    mass: 1380,
    size: [4.45, 1.95, 1.2],
    clearance: 0.11,
    comHeight: 0.42,
    comForward: -0.1,
    wheelbase: 2.62,
    track: 1.64,
    wheelRadius: 0.34,
    wheelWidth: 0.27,
    rearOverhang: 0.95,
    powerKw: 262,
    idleRpm: 950,
    redlineRpm: 7800,
    gears: 7,
    layout: 'AWD',
    frontSplit: 0.38,
    limitedSlip: 0.5,
    topSpeedKmh: 272,
    shiftTime: 0.1,
    tire: { mu: 1.12, peakSlipAngle: 0.12 },
    brakeG: 1.15,
    sag: 0.055,
    damping: 0.45,
    antiRoll: 0.8,
    liftArea: 0.4,
    steerDeg: 34,
    halfLockSpeed: 30,
    yawAssist: 0.3,
    doors: 2,
    seats: 2,
    durability: 850,
    targets: {
      zeroTo100: [3.8, 4.8],
      topSpeedKmh: [265, 295],
      brake100To0: [32, 42],
      skidpadG: [0.95, 1.25],
    },
  }),
  build({
    id: 'brakker',
    name: 'Hammond Brakker V8',
    class: 'muscle',
    style: 'muscle',
    colours: [0x1d1d1d, 0xa3121f, 0xe8b400, 0x0e5a3a, 0x24477d, 0xdedede],
    mass: 1650,
    size: [4.85, 1.92, 1.32],
    clearance: 0.13,
    comHeight: 0.5,
    comForward: 0.15,
    wheelbase: 2.85,
    track: 1.6,
    wheelRadius: 0.34,
    wheelWidth: 0.26,
    rearOverhang: 1.05,
    powerKw: 380,
    idleRpm: 750,
    redlineRpm: 6200,
    gears: 6,
    layout: 'RWD',
    limitedSlip: 0.6,
    rearGrip: 1.12,
    topSpeedKmh: 250,
    shiftTime: 0.18,
    tire: { mu: 1.08 },
    brakeG: 1.05,
    sag: 0.07,
    yawAssist: 0.35,
    doors: 2,
    seats: 4,
    durability: 1100,
    targets: {
      zeroTo100: [4.8, 5.8],
      topSpeedKmh: [235, 265],
      brake100To0: [35, 45],
      skidpadG: [0.85, 1.15],
    },
  }),
  build({
    id: 'haul',
    name: 'Kestrel Haul 1500',
    class: 'pickup',
    style: 'pickup',
    colours: [0x7a1f1f, 0x2c3e50, 0xd8d8d8, 0x4b5320, 0x111111, 0x8c6b3e],
    mass: 2150,
    size: [5.6, 2.0, 1.85],
    clearance: 0.24,
    comHeight: 0.78,
    comForward: 0.3,
    wheelbase: 3.4,
    track: 1.72,
    wheelRadius: 0.39,
    wheelWidth: 0.26,
    rearOverhang: 1.15,
    powerKw: 182,
    idleRpm: 700,
    redlineRpm: 5600,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 170,
    brakeG: 0.95,
    sag: 0.1,
    antiRoll: 0.75,
    doors: 4,
    seats: 4,
    durability: 1300,
    targets: { zeroTo100: [8, 10], topSpeedKmh: [160, 180], brake100To0: [36, 46], skidpadG: [0.75, 1.05] },
  }),
  build({
    id: 'courier',
    name: 'Atlas Courier',
    class: 'van',
    style: 'van',
    colours: [0xf2f2f2, 0x2b4f8c, 0x8f8f8f, 0xb5452f],
    mass: 2350,
    size: [5.2, 2.0, 2.3],
    clearance: 0.18,
    comHeight: 0.85,
    comForward: 0.35,
    wheelbase: 3.25,
    track: 1.72,
    wheelRadius: 0.35,
    wheelWidth: 0.22,
    rearOverhang: 1.05,
    powerKw: 134,
    idleRpm: 750,
    redlineRpm: 5200,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 150,
    brakeG: 0.95,
    sag: 0.1,
    antiRoll: 0.8,
    doors: 4,
    seats: 3,
    durability: 1300,
    targets: { zeroTo100: [11, 14], topSpeedKmh: [140, 160], brake100To0: [37, 47], skidpadG: [0.75, 1.05] },
  }),
  build({
    id: 'linewalker',
    name: 'Transit Linewalker',
    class: 'bus',
    style: 'bus',
    colours: [0x2f6f9f, 0xc23b22, 0x3d8b3d],
    mass: 11000,
    size: [11.8, 2.55, 3.1],
    clearance: 0.3,
    comHeight: 1.15,
    comForward: -0.4,
    wheelbase: 6.2,
    track: 2.1,
    wheelRadius: 0.5,
    wheelWidth: 0.3,
    rearOverhang: 3.0,
    powerKw: 360,
    idleRpm: 600,
    redlineRpm: 2600,
    gears: 5,
    layout: 'RWD',
    topSpeedKmh: 140,
    governorKmh: 112,
    shiftTime: 0.4,
    tire: { mu: 0.85 },
    brakeG: 0.5,
    sag: 0.12,
    antiRoll: 1.0,
    steerDeg: 40,
    halfLockSpeed: 18,
    doors: 4,
    seats: 2,
    durability: 2400,
    targets: { zeroTo100: [18, 25], topSpeedKmh: [100, 120], brake100To0: [52, 68], skidpadG: [0.6, 0.85] },
  }),
  build({
    id: 'sprint',
    name: 'Rivet Sprint 900',
    class: 'motorbike',
    style: 'bike',
    colours: [0xd11f1f, 0x111111, 0x1f5fd1, 0xf2c200, 0xe6e6e6],
    mass: 310,
    size: [2.1, 0.75, 1.15],
    clearance: 0.28,
    comHeight: 0.62,
    comForward: -0.12,
    wheelbase: 1.45,
    track: 0,
    wheelRadius: 0.31,
    wheelWidth: 0.17,
    rearOverhang: 0.3,
    powerKw: 100,
    idleRpm: 1200,
    redlineRpm: 10500,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 230,
    shiftTime: 0.08,
    tire: { mu: 1.15 },
    frontGrip: 1.0,
    rearGrip: 1.22,
    brakeG: 1.05,
    frontBias: 0.72,
    sag: 0.05,
    steerDeg: 32,
    halfLockSpeed: 9,
    yawAssist: 0,
    doors: 0,
    seats: 2,
    durability: 500,
    targets: {
      zeroTo100: [3.5, 4.5],
      topSpeedKmh: [215, 245],
      brake100To0: [34, 46],
      skidpadG: [0.75, 1.15],
    },
  }),
  build({
    id: 'interceptor',
    name: 'HCPD Interceptor',
    class: 'police',
    style: 'sedan',
    livery: 'police',
    colours: [0x111418],
    mass: 1720,
    size: [5.0, 1.9, 1.48],
    clearance: 0.15,
    comHeight: 0.53,
    comForward: 0.12,
    wheelbase: 2.95,
    track: 1.62,
    wheelRadius: 0.33,
    wheelWidth: 0.24,
    rearOverhang: 1.05,
    powerKw: 275,
    idleRpm: 750,
    redlineRpm: 6500,
    gears: 6,
    layout: 'RWD',
    limitedSlip: 0.5,
    topSpeedKmh: 230,
    tire: { mu: 1.06 },
    brakeG: 1.05,
    sag: 0.07,
    antiRoll: 0.75,
    doors: 4,
    seats: 4,
    durability: 1500,
    lightBar: true,
    targets: { zeroTo100: [5.5, 6.5], topSpeedKmh: [215, 245], brake100To0: [35, 45], skidpadG: [0.85, 1.1] },
  }),
  build({
    id: 'medic',
    name: 'Atlas Medic',
    class: 'ambulance',
    style: 'van',
    livery: 'ambulance',
    colours: [0xf4f4f4],
    mass: 3100,
    size: [5.9, 2.1, 2.6],
    clearance: 0.2,
    comHeight: 0.95,
    comForward: 0.2,
    wheelbase: 3.6,
    track: 1.78,
    wheelRadius: 0.37,
    wheelWidth: 0.24,
    rearOverhang: 1.3,
    powerKw: 175,
    idleRpm: 700,
    redlineRpm: 5000,
    gears: 6,
    layout: 'RWD',
    topSpeedKmh: 160,
    brakeG: 0.9,
    sag: 0.1,
    antiRoll: 0.9,
    doors: 4,
    seats: 4,
    durability: 1600,
    lightBar: true,
    targets: { zeroTo100: [11, 15], topSpeedKmh: [150, 170], brake100To0: [38, 50], skidpadG: [0.75, 1.05] },
  }),
  build({
    id: 'bulwark',
    name: 'HCPD Bulwark',
    class: 'swat',
    style: 'truck',
    livery: 'swat',
    colours: [0x1b2027],
    mass: 5600,
    size: [6.3, 2.4, 2.75],
    clearance: 0.32,
    comHeight: 1.05,
    comForward: 0.3,
    wheelbase: 3.8,
    track: 2.0,
    wheelRadius: 0.48,
    wheelWidth: 0.32,
    rearOverhang: 1.3,
    powerKw: 260,
    idleRpm: 650,
    redlineRpm: 3600,
    gears: 6,
    layout: 'AWD',
    frontSplit: 0.45,
    topSpeedKmh: 150,
    shiftTime: 0.3,
    tire: { mu: 0.95 },
    brakeG: 0.85,
    sag: 0.11,
    antiRoll: 1.0,
    doors: 4,
    seats: 4,
    durability: 3200,
    lightBar: true,
    targets: { zeroTo100: [12, 17], topSpeedKmh: [140, 160], brake100To0: [40, 54], skidpadG: [0.65, 0.95] },
  }),
  build({
    id: 'vaultline',
    name: 'Vaultline Armored',
    class: 'armored',
    style: 'truck',
    livery: 'armored',
    colours: [0x4d5a3a],
    mass: 8200,
    size: [6.8, 2.5, 2.9],
    clearance: 0.34,
    comHeight: 1.1,
    comForward: 0.2,
    wheelbase: 4.1,
    track: 2.08,
    wheelRadius: 0.52,
    wheelWidth: 0.36,
    rearOverhang: 1.4,
    powerKw: 345,
    idleRpm: 600,
    redlineRpm: 3000,
    gears: 6,
    layout: 'AWD',
    frontSplit: 0.45,
    topSpeedKmh: 130,
    shiftTime: 0.35,
    tire: { mu: 0.9 },
    brakeG: 0.72,
    sag: 0.12,
    antiRoll: 1.0,
    doors: 2,
    seats: 2,
    durability: 6000,
    targets: { zeroTo100: [15, 22], topSpeedKmh: [120, 140], brake100To0: [44, 60], skidpadG: [0.6, 0.9] },
  }),
];

/** Boats: buoyancy sized for the draft, hull drag sized so thrust balances it at top speed. */
function boat(
  id: string,
  name: string,
  cls: 'speedboat' | 'policeBoat',
  livery: VehicleDef['livery'],
  colours: readonly number[],
  mass: number,
  size: readonly [number, number, number],
  power: { thrust: number; reverseThrust: number; rudder: number; draft: number; sideways: number },
  topKmh: number,
): VehicleDef {
  const base = VEHICLES[0];
  const v = topKmh / 3.6;
  const spec: BoatSpec = {
    thrust: power.thrust,
    reverseThrust: power.reverseThrust,
    rudder: power.rudder,
    dragForward: power.thrust / (v * v + 4 * v),
    dragSideways: power.sideways,
    buoyancy: (mass * G) / (6 * power.draft),
    buoyancyDamping: (mass * G) / 6 / 1.2,
    draft: power.draft,
  };
  return {
    ...base,
    id,
    name,
    class: cls,
    kind: 'boat',
    style: 'boat',
    livery,
    colours,
    mass,
    length: size[0],
    width: size[1],
    height: size[2],
    clearance: 0,
    comHeight: 0.3,
    comForward: -0.4,
    wheelbase: size[0] * 0.6,
    track: size[1] * 0.7,
    rearOverhang: size[0] * 0.2,
    doors: 0,
    seats: 4,
    durability: 1200,
    lightBar: cls === 'policeBoat',
    boat: spec,
    targets: {
      zeroTo100: [0, 0],
      topSpeedKmh: [topKmh * 0.85, topKmh * 1.1],
      brake100To0: [0, 0],
      skidpadG: [0, 0],
    },
  };
}

export const BOATS: readonly VehicleDef[] = [
  boat(
    'gullwing',
    'Gullwing 26',
    'speedboat',
    'none',
    [0xf2f2f2, 0xc8102e, 0x0f4c81, 0x111111],
    1800,
    [7.6, 2.5, 1.5],
    { thrust: 7800, reverseThrust: 2600, rudder: 5, draft: 0.35, sideways: 900 },
    95,
  ),
  boat(
    'patrol',
    'HCPD Patrol Boat',
    'policeBoat',
    'police',
    [0x1b2735],
    2600,
    [8.4, 2.8, 1.9],
    { thrust: 10500, reverseThrust: 3400, rudder: 6.5, draft: 0.4, sideways: 1200 },
    85,
  ),
];

export const ALL_VEHICLES: readonly VehicleDef[] = [...VEHICLES, ...BOATS];
