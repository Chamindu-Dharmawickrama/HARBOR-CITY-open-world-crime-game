import { BONE_COUNT, BONE_INDEX, type BoneName } from '../rig/skeleton-def';

const DEG = Math.PI / 180;

/**
 * A skeletal pose: one local rotation quaternion per bone (x, y, z, w) plus a translation
 * offset for the hips relative to their rest position.
 */
export class Pose {
  readonly rot = new Float32Array(BONE_COUNT * 4);
  readonly hips = new Float32Array(3);

  constructor() {
    this.identity();
  }

  identity(): this {
    this.rot.fill(0);
    for (let b = 0; b < BONE_COUNT; b++) this.rot[b * 4 + 3] = 1;
    this.hips.fill(0);
    return this;
  }

  copy(from: Pose): this {
    this.rot.set(from.rot);
    this.hips.set(from.hips);
    return this;
  }

  /** Sets a bone rotation from XYZ Euler angles in degrees (applied X, then Y, then Z — intrinsic XYZ). */
  setEuler(bone: number, xDeg: number, yDeg: number, zDeg: number): void {
    eulerToQuat(xDeg * DEG, yDeg * DEG, zDeg * DEG, this.rot, bone * 4);
  }

  /** Pre-multiplies an extra Euler rotation (degrees) onto a bone (adds on top of the current pose). */
  addEuler(bone: number, xDeg: number, yDeg: number, zDeg: number): void {
    eulerToQuat(xDeg * DEG, yDeg * DEG, zDeg * DEG, scratch, 0);
    multiplyInto(this.rot, bone * 4, scratch, 0, this.rot, bone * 4);
  }

  quat(bone: BoneName): [number, number, number, number] {
    const o = BONE_INDEX[bone] * 4;
    return [this.rot[o], this.rot[o + 1], this.rot[o + 2], this.rot[o + 3]];
  }
}

const scratch = new Float32Array(4);

/** Intrinsic XYZ Euler (Three.js 'XYZ' order) to quaternion, written into out[o..o+3]. */
export function eulerToQuat(x: number, y: number, z: number, out: Float32Array, o: number): void {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  out[o] = s1 * c2 * c3 + c1 * s2 * s3;
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** out = a * b (quaternions at offsets). Safe when out aliases a or b. */
export function multiplyInto(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  out: Float32Array,
  oo: number,
): void {
  const ax = a[ao];
  const ay = a[ao + 1];
  const az = a[ao + 2];
  const aw = a[ao + 3];
  const bx = b[bo];
  const by = b[bo + 1];
  const bz = b[bo + 2];
  const bw = b[bo + 3];
  out[oo] = ax * bw + aw * bx + ay * bz - az * by;
  out[oo + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[oo + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * out = blend(a, b, t) per bone (normalised lerp along the shortest arc). With a mask, only bones
 * whose mask entry is non-zero are blended; others copy `a`.
 */
export function blendPoses(a: Pose, b: Pose, t: number, out: Pose, mask?: Uint8Array): void {
  const s = 1 - t;
  for (let bone = 0; bone < BONE_COUNT; bone++) {
    const o = bone * 4;
    if (mask && mask[bone] === 0) {
      out.rot[o] = a.rot[o];
      out.rot[o + 1] = a.rot[o + 1];
      out.rot[o + 2] = a.rot[o + 2];
      out.rot[o + 3] = a.rot[o + 3];
      continue;
    }
    let bx = b.rot[o];
    let by = b.rot[o + 1];
    let bz = b.rot[o + 2];
    let bw = b.rot[o + 3];
    if (a.rot[o] * bx + a.rot[o + 1] * by + a.rot[o + 2] * bz + a.rot[o + 3] * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    const x = a.rot[o] * s + bx * t;
    const y = a.rot[o + 1] * s + by * t;
    const z = a.rot[o + 2] * s + bz * t;
    const w = a.rot[o + 3] * s + bw * t;
    const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    out.rot[o] = x / len;
    out.rot[o + 1] = y / len;
    out.rot[o + 2] = z / len;
    out.rot[o + 3] = w / len;
  }
  const hipsT = mask ? (mask[BONE_INDEX.hips] === 0 ? 0 : t) : t;
  for (let k = 0; k < 3; k++) out.hips[k] = a.hips[k] * (1 - hipsT) + b.hips[k] * hipsT;
}

/**
 * Additive layer: rotates each bone of `base` by `weight` × the additive pose's rotation (an
 * additive pose is a delta from the rest pose, i.e. identity = no change). Hips offsets add.
 * `out` may alias `base`.
 */
export function addPose(base: Pose, additive: Pose, weight: number, out: Pose): void {
  if (weight <= 0) {
    if (out !== base) out.copy(base);
    return;
  }
  const w = Math.min(1, weight);
  for (let bone = 0; bone < BONE_COUNT; bone++) {
    const o = bone * 4;
    // nlerp(identity, additive, w) — shortest arc from identity (w component positive).
    const sign = additive.rot[o + 3] < 0 ? -1 : 1;
    const x = additive.rot[o] * sign * w;
    const y = additive.rot[o + 1] * sign * w;
    const z = additive.rot[o + 2] * sign * w;
    const ww = 1 - w + additive.rot[o + 3] * sign * w;
    const len = Math.sqrt(x * x + y * y + z * z + ww * ww) || 1;
    scratch[0] = x / len;
    scratch[1] = y / len;
    scratch[2] = z / len;
    scratch[3] = ww / len;
    multiplyInto(base.rot, o, scratch, 0, out.rot, o);
  }
  for (let k = 0; k < 3; k++) out.hips[k] = base.hips[k] + additive.hips[k] * w;
}

/** Mask with 1 for the listed bones. */
export function boneMask(bones: readonly BoneName[]): Uint8Array {
  const mask = new Uint8Array(BONE_COUNT);
  for (const b of bones) mask[BONE_INDEX[b]] = 1;
  return mask;
}
