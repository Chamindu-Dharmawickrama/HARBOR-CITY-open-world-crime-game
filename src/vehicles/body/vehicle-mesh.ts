import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cabinCentreFor, cabinLengthFor } from '../sim/raycast-vehicle';
import type { VehicleDef } from '../vehicle-def';
import { LightCode } from './vehicle-materials';

/** Material groups of a vehicle mesh (index into the material array). */
export const VehicleGroup = { paint: 0, glass: 1, lights: 2 } as const;

/** Bone layout: 0 = body, then doors, then wheels, then (bikes) the fork. */
export interface VehicleModel {
  readonly geometry: THREE.BufferGeometry;
  /** Local positions of every bone (rest pose) and its parent (−1 for the body). */
  readonly bones: readonly { name: string; x: number; y: number; z: number; parent: number }[];
  readonly doors: readonly DoorInfo[];
  /** Bone index per sim wheel (same order as RaycastVehicle.wheels). */
  readonly wheelBones: readonly number[];
  readonly forkBone: number;
  /** Where the driver sits (local), and where they stand to get in, per door. */
  readonly seat: THREE.Vector3;
  readonly bounds: THREE.Sphere;
}

export interface DoorInfo {
  bone: number;
  /** +1 = left side (+X), −1 = right side. */
  side: 1 | -1;
  front: boolean;
  /** Where a character stands to open this door (local, on the ground). */
  stand: THREE.Vector3;
}

type Part = { geometry: THREE.BufferGeometry; group: number; bone: number; colour: number; light?: number };

const TRIM = 0x1d1f22;
const TIRE = 0x161616;
const RIM = 0xb9bec4;
const CHROME = 0xd5d8dc;
const PLATE = 0xe8e4d6;
const WHITE = 0xf2f2f2;
const LIGHT_COLOURS: Record<number, number> = {
  [LightCode.head]: 0xfff4d6,
  [LightCode.tail]: 0xd0150f,
  [LightCode.reverse]: 0xf8f8f8,
  [LightCode.indicatorLeft]: 0xff9a1a,
  [LightCode.indicatorRight]: 0xff9a1a,
  [LightCode.barRed]: 0xff2020,
  [LightCode.barBlue]: 0x2050ff,
  [LightCode.marker]: 0xfff2a0,
};

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Cylinder with its axis along X. */
function cylinderX(
  r: number,
  width: number,
  x: number,
  y: number,
  z: number,
  segments = 16,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, width, segments).rotateZ(Math.PI / 2).translate(x, y, z);
}

/**
 * Extrudes a side profile (points in (z, y), any winding) across the vehicle's width, with
 * rounded edges, centred on x = 0.
 */
function extrudeSide(
  points: readonly (readonly [number, number])[],
  width: number,
  bevel: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(0.01, width - 2 * bevel);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // Shape x → vehicle z; extrusion (shape z) → vehicle x, centred.
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(depth / 2, 0, 0);
  return geometry;
}

/** Bottom edge with semicircular wheel arches, from the rear bumper to the front bumper. */
function archedBottom(def: VehicleDef, zRear: number, zFront: number, sill: number): [number, number][] {
  const r = def.wheelRadius + 0.05;
  const points: [number, number][] = [[zRear, sill]];
  for (const axleZ of [-def.wheelbase / 2, def.wheelbase / 2]) {
    const dy = def.wheelRadius - sill;
    const half = Math.sqrt(Math.max(0.01, r * r - dy * dy));
    points.push([axleZ - half, sill]);
    for (let i = 1; i < 9; i++) {
      const a = Math.PI - (i / 9) * Math.PI;
      // Arch angle measured from the wheel centre; clamp to the sill line at the ends.
      const z = axleZ + r * Math.cos(a);
      const y = Math.max(sill, def.wheelRadius + r * Math.sin(a));
      points.push([z, y]);
    }
    points.push([axleZ + half, sill]);
  }
  points.push([zFront, sill]);
  return points;
}

interface Profile {
  body: [number, number][];
  cabin: [number, number][];
  belt: number;
  zRear: number;
  zFront: number;
  cabinRear: number;
  cabinFront: number;
}

/** Side silhouette of the body shell and the glasshouse for each body style. */
function profileFor(def: VehicleDef): Profile {
  const zRear = -(def.wheelbase / 2 + def.rearOverhang);
  const zFront = zRear + def.length;
  const sill = def.clearance;
  const h = def.height;
  const boxy = def.style === 'van' || def.style === 'bus' || def.style === 'truck';
  const belt = boxy ? sill + (h - sill) * 0.48 : sill + (h - sill) * 0.55;
  const cabinLength = cabinLengthFor(def);
  const cabinCentre = cabinCentreFor(def);
  const cabinRear = cabinCentre - cabinLength / 2;
  const cabinFront = cabinCentre + cabinLength / 2;
  const roof = h;
  let top: [number, number][];
  let cabin: [number, number][];
  switch (def.style) {
    case 'van':
    case 'bus':
    case 'truck': {
      const nose = def.style === 'van' ? 0.55 : def.style === 'truck' ? 0.3 : 0.08;
      top = [
        [zRear, belt],
        [zFront - nose, belt],
        [zFront, belt - (def.style === 'van' ? 0.25 : 0.05)],
      ];
      cabin = [
        [zRear + 0.05, belt],
        [zRear + 0.08, roof],
        [zFront - nose - 0.25, roof],
        [zFront - nose + 0.02, belt],
      ];
      break;
    }
    case 'pickup': {
      top = [
        [zRear, belt - 0.05],
        [cabinRear, belt - 0.05],
        [cabinFront + 0.15, belt],
        [zFront - 0.15, belt - 0.05],
        [zFront, belt - 0.22],
      ];
      cabin = [
        [cabinRear, belt],
        [cabinRear + 0.08, roof],
        [cabinFront - 0.4, roof],
        [cabinFront, belt],
      ];
      break;
    }
    case 'hatch': {
      top = [
        [zRear, belt - 0.05],
        [zRear + 0.12, belt],
        [cabinFront, belt],
        [zFront - 0.1, belt - 0.07],
        [zFront, belt - 0.22],
      ];
      cabin = [
        [zRear + 0.12, belt],
        [zRear + 0.32, roof],
        [cabinFront - 0.62, roof],
        [cabinFront, belt],
      ];
      break;
    }
    case 'coupe':
    case 'muscle': {
      const fast = def.style === 'coupe' ? 0.9 : 0.55;
      top = [
        [zRear, belt - 0.08],
        [zRear + 0.2, belt],
        [cabinFront, belt],
        [zFront - 0.15, belt - 0.1],
        [zFront, belt - 0.25],
      ];
      cabin = [
        [cabinRear - fast * 0.4, belt],
        [cabinRear + fast * 0.35, roof],
        [cabinFront - 0.75, roof],
        [cabinFront, belt],
      ];
      break;
    }
    case 'sedan':
    case 'bike':
    case 'boat': {
      top = [
        [zRear, belt - 0.1],
        [zRear + 0.15, belt],
        [cabinRear, belt],
        [cabinFront, belt],
        [zFront - 0.12, belt - 0.06],
        [zFront, belt - 0.24],
      ];
      cabin = [
        [cabinRear, belt],
        [cabinRear + 0.45, roof],
        [cabinFront - 0.6, roof],
        [cabinFront, belt],
      ];
    }
  }
  const bottom = archedBottom(def, zRear, zFront, sill);
  // Polygon: bottom (rear → front) then top (front → rear).
  const body = [...bottom, ...[...top].reverse().filter((p) => p[0] < zFront || p[1] > sill)];
  return { body, cabin, belt, zRear, zFront, cabinRear, cabinFront };
}

function paintColour(def: VehicleDef, colour: number): { body: number; doors: number; roof: number } {
  switch (def.livery) {
    case 'police':
      return { body: 0x111418, doors: WHITE, roof: WHITE };
    case 'ambulance':
      return { body: WHITE, doors: WHITE, roof: WHITE };
    case 'taxi':
    case 'swat':
    case 'armored':
    case 'none':
      return { body: colour, doors: colour, roof: colour };
  }
}

/** Car / van / truck / bus. */
function carParts(
  def: VehicleDef,
  colour: number,
  parts: Part[],
  bones: VehicleModel['bones'][number][],
  doors: DoorInfo[],
): number[] {
  const p = profileFor(def);
  const paint = paintColour(def, colour);
  const w = def.width;
  parts.push({
    geometry: extrudeSide(p.body, w, 0.06),
    group: VehicleGroup.paint,
    bone: 0,
    colour: paint.body,
  });
  parts.push({
    geometry: extrudeSide(p.cabin, w * 0.86, 0.05),
    group: VehicleGroup.glass,
    bone: 0,
    colour: 0xffffff,
  });
  // Roof panel and pillars give the glasshouse a solid top.
  const roofFront = p.cabin[2];
  const roofRear = p.cabin[1];
  parts.push({
    geometry: box(
      w * 0.86,
      0.05,
      roofFront[0] - roofRear[0] + 0.05,
      0,
      def.height - 0.02,
      (roofFront[0] + roofRear[0]) / 2,
    ),
    group: VehicleGroup.paint,
    bone: 0,
    colour: paint.roof,
  });
  // Bumpers, grille, plates, sills, mirrors.
  const bumperY = def.clearance + 0.12;
  parts.push({
    geometry: box(w * 0.98, 0.18, 0.12, 0, bumperY, p.zFront - 0.02),
    group: VehicleGroup.paint,
    bone: 0,
    colour: TRIM,
  });
  parts.push({
    geometry: box(w * 0.98, 0.18, 0.12, 0, bumperY, p.zRear + 0.02),
    group: VehicleGroup.paint,
    bone: 0,
    colour: TRIM,
  });
  parts.push({
    geometry: box(w * 0.45, 0.14, 0.04, 0, p.belt - 0.2, p.zFront + 0.02),
    group: VehicleGroup.paint,
    bone: 0,
    colour: TRIM,
  });
  parts.push({
    geometry: box(0.36, 0.11, 0.02, 0, bumperY, p.zFront + 0.05),
    group: VehicleGroup.paint,
    bone: 0,
    colour: PLATE,
  });
  parts.push({
    geometry: box(0.36, 0.11, 0.02, 0, bumperY + 0.12, p.zRear - 0.04),
    group: VehicleGroup.paint,
    bone: 0,
    colour: PLATE,
  });
  for (const side of [1, -1]) {
    parts.push({
      geometry: box(0.12, 0.08, 0.16, side * (w / 2 + 0.05), p.belt + 0.08, p.cabinFront - 0.15),
      group: VehicleGroup.paint,
      bone: 0,
      colour: paint.body,
    });
  }
  // Lights.
  const lightY = p.belt - 0.12;
  for (const side of [1, -1]) {
    const x = side * (w / 2 - 0.22);
    light(parts, LightCode.head, box(0.32, 0.12, 0.06, x, lightY, p.zFront + 0.005));
    light(
      parts,
      side > 0 ? LightCode.indicatorLeft : LightCode.indicatorRight,
      box(0.1, 0.07, 0.06, side * (w / 2 - 0.04), lightY - 0.02, p.zFront - 0.01),
    );
    light(parts, LightCode.tail, box(0.3, 0.14, 0.06, x, lightY + 0.04, p.zRear - 0.005));
    light(parts, LightCode.reverse, box(0.1, 0.07, 0.06, side * 0.25, lightY - 0.08, p.zRear - 0.01));
    light(
      parts,
      side > 0 ? LightCode.indicatorLeft : LightCode.indicatorRight,
      box(0.08, 0.14, 0.06, side * (w / 2 - 0.03), lightY + 0.04, p.zRear - 0.01),
    );
  }
  // Liveries.
  if (def.livery === 'taxi') {
    light(parts, LightCode.marker, box(0.6, 0.18, 0.28, 0, def.height + 0.11, p.cabinRear + 0.6));
    for (let i = 0; i < 14; i++) {
      const z = p.cabinRear - 0.1 + i * ((p.cabinFront - p.cabinRear + 0.2) / 14);
      for (const side of [1, -1]) {
        parts.push({
          geometry: box(0.01, 0.07, 0.08, side * (w / 2 + 0.005), p.belt - 0.05 - (i % 2) * 0.07, z),
          group: VehicleGroup.paint,
          bone: 0,
          colour: 0x111111,
        });
      }
    }
  }
  if (def.livery === 'ambulance' || def.livery === 'swat' || def.livery === 'armored') {
    const stripe = def.livery === 'ambulance' ? 0xc8102e : def.livery === 'swat' ? 0x2d3a4a : 0x3a4530;
    for (const side of [1, -1]) {
      parts.push({
        geometry: box(
          0.01,
          0.16,
          def.length * 0.8,
          side * (w / 2 + 0.01),
          p.belt - 0.1,
          (p.zFront + p.zRear) / 2,
        ),
        group: VehicleGroup.paint,
        bone: 0,
        colour: stripe,
      });
    }
  }
  if (def.lightBar) {
    const barZ = p.cabin[1][0] + 0.35;
    parts.push({
      geometry: box(w * 0.7, 0.08, 0.26, 0, def.height + 0.04, barZ),
      group: VehicleGroup.paint,
      bone: 0,
      colour: TRIM,
    });
    light(parts, LightCode.barRed, box(w * 0.32, 0.1, 0.22, w * 0.18, def.height + 0.12, barZ));
    light(parts, LightCode.barBlue, box(w * 0.32, 0.1, 0.22, -w * 0.18, def.height + 0.12, barZ));
  }

  // Doors (hinged at their front edge) — separate bones so they can swing open.
  const doorHeight = p.belt - def.clearance - 0.08;
  const frontDoorLength = Math.min(1.15, (p.cabinFront - p.cabinRear) * 0.55);
  const spans: { front: boolean; z0: number; z1: number }[] = [];
  if (def.doors >= 2)
    spans.push({ front: true, z0: p.cabinFront - frontDoorLength, z1: p.cabinFront - 0.05 });
  if (def.doors >= 4 && def.style !== 'bus') {
    const rearLength = Math.min(0.95, Math.max(0.6, p.cabinFront - frontDoorLength - p.cabinRear - 0.05));
    spans.push({
      front: false,
      z0: p.cabinFront - frontDoorLength - rearLength - 0.02,
      z1: p.cabinFront - frontDoorLength - 0.02,
    });
  }
  for (const span of spans) {
    for (const side of [1, -1] as const) {
      const bone = bones.length;
      const hingeX = side * (w / 2 + 0.005);
      bones.push({
        name: `door${side > 0 ? 'L' : 'R'}${span.front ? 'F' : 'R'}`,
        x: hingeX,
        y: def.clearance + 0.06,
        z: span.z1,
        parent: 0,
      });
      const len = span.z1 - span.z0;
      parts.push({
        geometry: box(
          0.04,
          doorHeight,
          len,
          hingeX - side * 0.0,
          def.clearance + 0.06 + doorHeight / 2,
          span.z1 - len / 2,
        ),
        group: VehicleGroup.paint,
        bone,
        colour: paint.doors,
      });
      parts.push({
        geometry: box(0.05, 0.03, 0.12, hingeX + side * 0.02, p.belt - 0.18, span.z0 + 0.15),
        group: VehicleGroup.paint,
        bone,
        colour: CHROME,
      });
      doors.push({
        bone,
        side,
        front: span.front,
        stand: new THREE.Vector3(side * (w / 2 + 0.75), 0, span.z0 + len * 0.45),
      });
    }
  }
  return wheelParts(def, parts, bones, false);
}

function light(parts: Part[], code: number, geometry: THREE.BufferGeometry): void {
  parts.push({
    geometry,
    group: VehicleGroup.lights,
    bone: 0,
    colour: LIGHT_COLOURS[code] ?? WHITE,
    light: code,
  });
}

/** Wheels (tire + rim + hub), one bone each, in sim order (FL, FR, RL, RR / F, R). */
function wheelParts(
  def: VehicleDef,
  parts: Part[],
  bones: VehicleModel['bones'][number][],
  bike: boolean,
): number[] {
  const out: number[] = [];
  const positions: [number, number][] = bike
    ? [
        [0, def.wheelbase / 2],
        [0, -def.wheelbase / 2],
      ]
    : [
        [def.track / 2, def.wheelbase / 2],
        [-def.track / 2, def.wheelbase / 2],
        [def.track / 2, -def.wheelbase / 2],
        [-def.track / 2, -def.wheelbase / 2],
      ];
  const r = def.wheelRadius;
  const wd = def.wheelWidth;
  for (const [x, z] of positions) {
    const bone = bones.length;
    bones.push({ name: 'wheel', x, y: r, z, parent: 0 });
    const outward = x === 0 ? 1 : Math.sign(x);
    parts.push({ geometry: cylinderX(r, wd, x, r, z, 18), group: VehicleGroup.paint, bone, colour: TIRE });
    parts.push({
      geometry: cylinderX(r * 0.62, wd + 0.012, x, r, z, 12),
      group: VehicleGroup.paint,
      bone,
      colour: RIM,
    });
    // Spokes make the rotation visible.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      parts.push({
        geometry: new THREE.BoxGeometry(0.02, r * 1.1, 0.05)
          .rotateX(a)
          .translate(x + outward * (wd / 2 + 0.008), r, z),
        group: VehicleGroup.paint,
        bone,
        colour: 0x8a9097,
      });
    }
    out.push(bone);
  }
  return out;
}

/** Motorbike: frame, tank, seat, fairing, fork (steering bone), lights. */
function bikeParts(
  def: VehicleDef,
  colour: number,
  parts: Part[],
  bones: VehicleModel['bones'][number][],
): { wheels: number[]; fork: number } {
  const r = def.wheelRadius;
  const half = def.wheelbase / 2;
  parts.push({
    geometry: box(0.16, 0.12, def.wheelbase * 0.9, 0, r + 0.2, -0.05),
    group: VehicleGroup.paint,
    bone: 0,
    colour: TRIM,
  });
  parts.push({
    geometry: box(0.3, 0.28, 0.55, 0, r + 0.45, 0.15),
    group: VehicleGroup.paint,
    bone: 0,
    colour,
  });
  parts.push({
    geometry: box(0.26, 0.1, 0.55, 0, r + 0.42, -0.35),
    group: VehicleGroup.paint,
    bone: 0,
    colour: 0x111111,
  });
  parts.push({
    geometry: box(0.2, 0.18, 0.42, 0, r + 0.32, -0.75),
    group: VehicleGroup.paint,
    bone: 0,
    colour,
  });
  parts.push({
    geometry: box(0.24, 0.3, 0.45, 0, r + 0.22, -0.1),
    group: VehicleGroup.paint,
    bone: 0,
    colour: 0x2a2c30,
  });
  parts.push({
    geometry: cylinderX(0.045, 0.12, 0.12, r + 0.05, -0.55, 8),
    group: VehicleGroup.paint,
    bone: 0,
    colour: CHROME,
  });
  light(parts, LightCode.tail, box(0.14, 0.06, 0.04, 0, r + 0.42, -0.97));
  // Fork bone at the steering head; front wheel hangs from it.
  const fork = bones.length;
  bones.push({ name: 'fork', x: 0, y: r + 0.62, z: half - 0.25, parent: 0 });
  parts.push({
    geometry: box(0.36, 0.36, 0.34, 0, r + 0.58, half - 0.12),
    group: VehicleGroup.paint,
    bone: fork,
    colour,
  });
  parts.push({
    geometry: box(0.64, 0.04, 0.04, 0, r + 0.82, half - 0.32),
    group: VehicleGroup.paint,
    bone: fork,
    colour: TRIM,
  });
  parts.push({
    geometry: box(0.05, 0.62, 0.05, 0.08, r + 0.3, half - 0.05),
    group: VehicleGroup.paint,
    bone: fork,
    colour: CHROME,
  });
  parts.push({
    geometry: box(0.05, 0.62, 0.05, -0.08, r + 0.3, half - 0.05),
    group: VehicleGroup.paint,
    bone: fork,
    colour: CHROME,
  });
  light(parts, LightCode.head, box(0.18, 0.12, 0.06, 0, r + 0.6, half + 0.06));
  light(parts, LightCode.indicatorLeft, box(0.05, 0.04, 0.04, 0.16, r + 0.55, half + 0.02));
  light(parts, LightCode.indicatorRight, box(0.05, 0.04, 0.04, -0.16, r + 0.55, half + 0.02));
  const wheels = wheelParts(def, parts, bones, true);
  // The front wheel turns with the fork.
  const front = bones[wheels[0]];
  if (front) front.parent = fork;
  return { wheels, fork };
}

/** Boat: hull (raked bow), deck, windscreen, console, outboard. */
function boatParts(def: VehicleDef, colour: number, parts: Part[]): void {
  const L = def.length;
  const h = def.height * 0.55;
  const zRear = -L / 2;
  const zFront = L / 2;
  const hull: [number, number][] = [
    [zRear, 0.1],
    [zFront - L * 0.3, 0],
    [zFront - L * 0.08, h * 0.45],
    [zFront, h],
    [zRear, h],
  ];
  parts.push({ geometry: extrudeSide(hull, def.width, 0.12), group: VehicleGroup.paint, bone: 0, colour });
  parts.push({
    geometry: box(def.width * 0.9, 0.06, L * 0.85, 0, h + 0.02, -L * 0.05),
    group: VehicleGroup.paint,
    bone: 0,
    colour: 0xe8e2d2,
  });
  parts.push({
    geometry: box(def.width * 0.5, 0.6, 0.7, 0, h + 0.3, 0.1),
    group: VehicleGroup.paint,
    bone: 0,
    colour: WHITE,
  });
  parts.push({
    geometry: box(def.width * 0.7, 0.42, 0.05, 0, h + 0.55, 0.5)
      .rotateX(-0.5)
      .translate(0, 0.05, 0.1),
    group: VehicleGroup.glass,
    bone: 0,
    colour: 0xffffff,
  });
  parts.push({
    geometry: box(0.45, 0.8, 0.5, 0, h + 0.1, zRear - 0.1),
    group: VehicleGroup.paint,
    bone: 0,
    colour: TRIM,
  });
  light(parts, LightCode.head, box(0.16, 0.1, 0.06, 0, h + 0.12, zFront - 0.15));
  light(parts, LightCode.tail, box(0.12, 0.1, 0.06, 0, h + 0.62, zRear + 0.3));
  if (def.lightBar) {
    parts.push({
      geometry: box(0.08, 0.6, 0.08, 0, h + 0.9, -0.3),
      group: VehicleGroup.paint,
      bone: 0,
      colour: TRIM,
    });
    light(parts, LightCode.barRed, box(0.3, 0.12, 0.14, 0.17, h + 1.25, -0.3));
    light(parts, LightCode.barBlue, box(0.3, 0.12, 0.14, -0.17, h + 1.25, -0.3));
  }
}

const cache = new Map<string, VehicleModel>();

/**
 * Builds (and caches per model + colour) one merged, skinned vehicle geometry: groups for paint
 * (vertex colours), glass and lights (with an `aLight` code per lamp), rigid skin weights per bone.
 */
export function buildVehicleModel(def: VehicleDef, colour: number): VehicleModel {
  const key = `${def.id}:${colour}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const parts: Part[] = [];
  const bones: VehicleModel['bones'][number][] = [{ name: 'body', x: 0, y: 0, z: 0, parent: -1 }];
  const doors: DoorInfo[] = [];
  let wheelBones: number[] = [];
  let forkBone = -1;
  if (def.kind === 'boat') boatParts(def, colour, parts);
  else if (def.kind === 'bike') {
    const bike = bikeParts(def, colour, parts, bones);
    wheelBones = bike.wheels;
    forkBone = bike.fork;
  } else wheelBones = carParts(def, colour, parts, bones, doors);

  const tint = new THREE.Color();
  const byGroup: THREE.BufferGeometry[][] = [[], [], []];
  for (const part of parts) {
    // Everything non-indexed so parts of every kind merge (ExtrudeGeometry has no index).
    const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    for (const name of Object.keys(g.attributes))
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const count = g.getAttribute('position').count;
    const colours = new Uint8Array(count * 3);
    tint.setHex(part.colour, THREE.SRGBColorSpace);
    for (let i = 0; i < count; i++) {
      colours[i * 3] = Math.round(tint.r * 255);
      colours[i * 3 + 1] = Math.round(tint.g * 255);
      colours[i * 3 + 2] = Math.round(tint.b * 255);
    }
    g.setAttribute('color', new THREE.Uint8BufferAttribute(colours, 3, true));
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = part.bone;
      skinWeight[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    g.setAttribute(
      'aLight',
      new THREE.Float32BufferAttribute(new Float32Array(count).fill(part.light ?? -1), 1),
    );
    byGroup[part.group]?.push(g);
    if (g !== part.geometry) part.geometry.dispose();
  }
  // One sub-geometry per material group, in group order (an empty group keeps a degenerate
  // triangle so material indices stay aligned).
  const groupGeometries = byGroup.map(
    (list) => (list.length > 0 ? mergeGeometries(list, false) : null) ?? emptyLike(),
  );
  for (const list of byGroup) for (const g of list) g.dispose();
  const geometry = mergeGeometries(groupGeometries, true);
  for (const g of groupGeometries) g.dispose();
  if (!geometry) throw new Error(`buildVehicleModel: merge failed for ${def.id}`);
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere?.clone() ?? new THREE.Sphere(new THREE.Vector3(), def.length);
  sphere.radius *= 1.15;
  // The rider's root (feet) position: hips land on the seat through the seated clip's hip drop.
  const seat =
    def.kind === 'bike'
      ? new THREE.Vector3(0, def.wheelRadius + 0.47 - 0.55, -0.32)
      : def.kind === 'boat'
        ? new THREE.Vector3(0, def.height * 0.55 + 0.05, -0.55)
        : new THREE.Vector3(def.width * 0.22, def.clearance + 0.08, cabinCentreFor(def) + 0.05);
  const model: VehicleModel = { geometry, bones, doors, wheelBones, forkBone, seat, bounds: sphere };
  cache.set(key, model);
  return model;
}

function emptyLike(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('color', new THREE.Uint8BufferAttribute(new Uint8Array(9), 3, true));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  g.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4),
  );
  g.setAttribute('aLight', new THREE.Float32BufferAttribute([-1, -1, -1], 1));
  return g;
}

/** Number of cached vehicle geometries (debug overlay). */
export function vehicleModelCacheSize(): number {
  return cache.size;
}
