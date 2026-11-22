import { defineSoA, type SoAStore } from './component';
import { entityIndex, type Entity } from './entity';
import type { FixedSystem } from './scheduler';
import type { World } from './world';

/**
 * World transform with the previous tick's value kept for render interpolation.
 * p* = position, q* = rotation quaternion, pp* / pq* = previous tick.
 */
export const Transform = defineSoA('Transform', [
  'px',
  'py',
  'pz',
  'qx',
  'qy',
  'qz',
  'qw',
  'ppx',
  'ppy',
  'ppz',
  'pqx',
  'pqy',
  'pqz',
  'pqw',
] as const);

export type TransformStore = SoAStore<(typeof Transform.fields)[number]>;

export interface PoseOut {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Sets the current pose (the previous pose is left alone, so motion interpolates). */
export function setPose(
  t: TransformStore,
  entity: Entity,
  x: number,
  y: number,
  z: number,
  qx = 0,
  qy = 0,
  qz = 0,
  qw = 1,
): void {
  const i = entityIndex(entity);
  const f = t.f;
  f.px[i] = x;
  f.py[i] = y;
  f.pz[i] = z;
  f.qx[i] = qx;
  f.qy[i] = qy;
  f.qz[i] = qz;
  f.qw[i] = qw;
}

/** Sets current and previous pose (no interpolation smear — use for spawns and teleports). */
export function teleport(
  t: TransformStore,
  entity: Entity,
  x: number,
  y: number,
  z: number,
  qx = 0,
  qy = 0,
  qz = 0,
  qw = 1,
): void {
  setPose(t, entity, x, y, z, qx, qy, qz, qw);
  copyCurrentToPrevious(t, entityIndex(entity));
}

export function copyCurrentToPrevious(t: TransformStore, i: number): void {
  const f = t.f;
  f.ppx[i] = f.px[i];
  f.ppy[i] = f.py[i];
  f.ppz[i] = f.pz[i];
  f.pqx[i] = f.qx[i];
  f.pqy[i] = f.qy[i];
  f.pqz[i] = f.qz[i];
  f.pqw[i] = f.qw[i];
}

/**
 * Copies current → previous for every transform. Registered first in the 'input' phase so the
 * snapshot is taken at the very start of each tick, before anything moves.
 */
export function createTransformSnapshotSystem(world: World): FixedSystem {
  const t = world.soa(Transform);
  const entities = world.query([Transform]).entities;
  return {
    name: 'transformSnapshot',
    phase: 'input',
    fixedUpdate(): void {
      for (let n = 0; n < entities.length; n++) copyCurrentToPrevious(t, entityIndex(entities[n]));
    },
  };
}

/**
 * Interpolated pose between previous and current tick: position lerp, rotation normalised
 * lerp along the shortest arc (accurate for the small per-tick rotations involved).
 */
export function interpolatePose(t: TransformStore, entity: Entity, alpha: number, out: PoseOut): PoseOut {
  const i = entityIndex(entity);
  const f = t.f;
  const a = alpha;
  const b = 1 - alpha;
  out.x = f.ppx[i] * b + f.px[i] * a;
  out.y = f.ppy[i] * b + f.py[i] * a;
  out.z = f.ppz[i] * b + f.pz[i] * a;
  let qx = f.qx[i];
  let qy = f.qy[i];
  let qz = f.qz[i];
  let qw = f.qw[i];
  const px = f.pqx[i];
  const py = f.pqy[i];
  const pz = f.pqz[i];
  const pw = f.pqw[i];
  if (px * qx + py * qy + pz * qz + pw * qw < 0) {
    qx = -qx;
    qy = -qy;
    qz = -qz;
    qw = -qw;
  }
  let rx = px * b + qx * a;
  let ry = py * b + qy * a;
  let rz = pz * b + qz * a;
  let rw = pw * b + qw * a;
  const len = Math.hypot(rx, ry, rz, rw) || 1;
  rx /= len;
  ry /= len;
  rz /= len;
  rw /= len;
  out.qx = rx;
  out.qy = ry;
  out.qz = rz;
  out.qw = rw;
  return out;
}
