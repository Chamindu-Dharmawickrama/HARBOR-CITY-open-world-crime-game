/**
 * Humanoid skeleton shared by every character. Rest pose is an "I-pose": spine up, arms and legs
 * straight down, facing +Z (the character's left is +X). Rotation conventions used by clips:
 * - X on limbs pointing down: positive swings the limb BACK, negative swings it FORWARD.
 * - X on the spine/neck/head (pointing up): positive leans FORWARD.
 * - Z on the left arm: positive raises it out to the side; on the right arm, negative does.
 * - Y: twist (positive turns the character's front toward its left, i.e. counter-clockwise).
 */
export const BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'upperArmL',
  'lowerArmL',
  'handL',
  'upperArmR',
  'lowerArmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'upperLegR',
  'lowerLegR',
  'footR',
] as const;

export type BoneName = (typeof BONES)[number];
export const BONE_COUNT = BONES.length;

export const BONE_INDEX: Readonly<Record<BoneName, number>> = Object.fromEntries(
  BONES.map((b, i) => [b, i]),
) as Record<BoneName, number>;

export const BONE_PARENT: Readonly<Record<BoneName, BoneName | null>> = {
  root: null,
  hips: 'root',
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  upperArmL: 'chest',
  lowerArmL: 'upperArmL',
  handL: 'lowerArmL',
  upperArmR: 'chest',
  lowerArmR: 'upperArmR',
  handR: 'lowerArmR',
  upperLegL: 'hips',
  lowerLegL: 'upperLegL',
  footL: 'lowerLegL',
  upperLegR: 'hips',
  lowerLegR: 'upperLegR',
  footR: 'lowerLegR',
};

/** Bones driven by the upper-body (aim/punch) layer. */
export const UPPER_BODY_BONES: readonly BoneName[] = [
  'spine',
  'chest',
  'neck',
  'head',
  'upperArmL',
  'lowerArmL',
  'handL',
  'upperArmR',
  'lowerArmR',
  'handR',
];

export interface BodyParams {
  /** Standing height in metres (≈1.6–1.95). */
  height: number;
  /** Girth multiplier (≈0.85–1.25). */
  build: number;
}

export const DEFAULT_BODY: BodyParams = { height: 1.8, build: 1 };

/** Reference proportions for a 1.8 m figure (local offsets from each bone's parent). */
const REFERENCE: Readonly<Record<BoneName, readonly [number, number, number]>> = {
  root: [0, 0, 0],
  hips: [0, 0.97, 0],
  spine: [0, 0.1, 0],
  chest: [0, 0.2, 0],
  neck: [0, 0.24, 0],
  head: [0, 0.08, 0],
  upperArmL: [0.19, 0.2, 0],
  lowerArmL: [0, -0.28, 0],
  handL: [0, -0.25, 0],
  upperArmR: [-0.19, 0.2, 0],
  lowerArmR: [0, -0.28, 0],
  handR: [0, -0.25, 0],
  upperLegL: [0.095, -0.05, 0],
  lowerLegL: [0, -0.43, 0],
  footL: [0, -0.41, 0],
  upperLegR: [-0.095, -0.05, 0],
  lowerLegR: [0, -0.43, 0],
  footR: [0, -0.41, 0],
};

export const REFERENCE_HEIGHT = 1.8;

/** Rest offsets scaled to the body: heights scale with `height`, shoulder/hip width with `build` too. */
export function restOffsets(body: BodyParams): Record<BoneName, [number, number, number]> {
  const s = body.height / REFERENCE_HEIGHT;
  const w = s * (0.85 + 0.15 * body.build);
  const out = {} as Record<BoneName, [number, number, number]>;
  for (const bone of BONES) {
    const [x, y, z] = REFERENCE[bone];
    out[bone] = [x * w, y * s, z * s];
  }
  return out;
}

/** Height of the ankle joint above the sole (for foot placement). */
export function ankleHeight(body: BodyParams): number {
  return 0.08 * (body.height / REFERENCE_HEIGHT);
}
