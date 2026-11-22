import { BONE_INDEX, BONES, type BoneName } from '../rig/skeleton-def';
import type { Pose } from './pose';

/** A key: [normalised time 0..1, x°, y°, z°] (Euler angles in degrees, or metres for hips). */
export type Key = readonly [number, number, number, number];

/** Authored animation data (lives in src/content/animations.ts). */
export interface ClipDef {
  name: string;
  /** Length of one cycle (looping) or of the whole move (one-shot), seconds. */
  duration: number;
  loop: boolean;
  tracks: Partial<Record<BoneName, readonly Key[]>>;
  /** Hips translation offset keys [t, x, y, z] in metres. */
  hips?: readonly Key[];
}

interface Track {
  bone: number;
  keys: readonly Key[];
}

/**
 * Samples keyframed Euler tracks with Catmull-Rom interpolation (wrapping for loops, clamped
 * for one-shots). Bones without a track keep their rest (identity) rotation.
 */
export class Clip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  private readonly tracks: Track[];
  private readonly hipsKeys: readonly Key[] | null;
  private readonly tmp = new Float64Array(3);

  constructor(def: ClipDef) {
    this.name = def.name;
    this.duration = def.duration;
    this.loop = def.loop;
    this.tracks = [];
    for (const bone of BONES) {
      const keys = def.tracks[bone];
      if (keys && keys.length > 0)
        this.tracks.push({ bone: BONE_INDEX[bone], keys: validateKeys(def.name, bone, keys) });
    }
    this.hipsKeys = def.hips && def.hips.length > 0 ? validateKeys(def.name, 'hips', def.hips) : null;
  }

  /** Writes the pose at `time` seconds (looping clips wrap; one-shots clamp to the last frame). */
  sample(time: number, out: Pose): void {
    out.identity();
    const t = this.normalized(time);
    for (const track of this.tracks) {
      evaluate(track.keys, t, this.loop, this.tmp);
      out.setEuler(track.bone, this.tmp[0], this.tmp[1], this.tmp[2]);
    }
    if (this.hipsKeys) {
      evaluate(this.hipsKeys, t, this.loop, this.tmp);
      out.hips[0] = this.tmp[0];
      out.hips[1] = this.tmp[1];
      out.hips[2] = this.tmp[2];
    }
  }

  normalized(time: number): number {
    if (this.duration <= 0) return 0;
    if (this.loop) {
      const t = (time / this.duration) % 1;
      return t < 0 ? t + 1 : t;
    }
    return Math.min(1, Math.max(0, time / this.duration));
  }
}

function validateKeys(clip: string, bone: string, keys: readonly Key[]): readonly Key[] {
  for (let i = 0; i < keys.length; i++) {
    const t = keys[i][0];
    if (t < 0 || t > 1 || (i > 0 && t <= keys[i - 1][0])) {
      throw new Error(`Clip ${clip}/${bone}: key times must increase within [0, 1]`);
    }
  }
  return keys;
}

/** Catmull-Rom interpolation of key values at normalised time t. */
function evaluate(keys: readonly Key[], t: number, loop: boolean, out: Float64Array): void {
  const n = keys.length;
  if (n === 1) {
    const k = keys[0];
    out[0] = k[1];
    out[1] = k[2];
    out[2] = k[3];
    return;
  }
  // Find segment i such that keys[i].t <= t < keys[i+1].t (wrapping for loops).
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (keys[k][0] > t) {
      i = k - 1;
      break;
    }
  }
  let t0: number;
  let t1: number;
  let i0: number;
  let i1: number;
  if (i < 0) {
    if (!loop) return copyKey(keys[0], out);
    i0 = n - 1;
    i1 = 0;
    t0 = keys[n - 1][0] - 1;
    t1 = keys[0][0];
  } else if (i === n - 1) {
    if (!loop) return copyKey(keys[n - 1], out);
    i0 = n - 1;
    i1 = 0;
    t0 = keys[n - 1][0];
    t1 = keys[0][0] + 1;
  } else {
    i0 = i;
    i1 = i + 1;
    t0 = keys[i0][0];
    t1 = keys[i1][0];
  }
  const u = t1 > t0 ? (t - t0 + (t < t0 ? 1 : 0)) / (t1 - t0) : 0;
  const prev = loop ? (i0 - 1 + n) % n : Math.max(0, i0 - 1);
  const next = loop ? (i1 + 1) % n : Math.min(n - 1, i1 + 1);
  const p0 = keys[prev];
  const p1 = keys[i0];
  const p2 = keys[i1];
  const p3 = keys[next];
  const u2 = u * u;
  const u3 = u2 * u;
  for (let c = 1; c <= 3; c++) {
    const a = p0[c];
    const b = p1[c];
    const d = p2[c];
    const e = p3[c];
    out[c - 1] =
      0.5 * (2 * b + (-a + d) * u + (2 * a - 5 * b + 4 * d - e) * u2 + (-a + 3 * b - 3 * d + e) * u3);
  }
}

function copyKey(key: Key, out: Float64Array): void {
  out[0] = key[1];
  out[1] = key[2];
  out[2] = key[3];
}

export type ClipLibrary = Readonly<Record<string, Clip>>;

export function buildClipLibrary(defs: readonly ClipDef[]): Record<string, Clip> {
  const lib: Record<string, Clip> = {};
  for (const def of defs) {
    if (lib[def.name]) throw new Error(`Duplicate clip ${def.name}`);
    lib[def.name] = new Clip(def);
  }
  return lib;
}
