import type { ClipDef, Key } from '../characters/anim/clip';

/**
 * Hand-authored animation clips (degrees; see characters/rig/skeleton-def.ts for axis
 * conventions). Cyclic locomotion clips share one phase convention: the LEFT foot contacts the
 * ground at t = 0 and the right foot at t = 0.5, so they can be blended in step.
 */

/** Same keys shifted by `offset` in normalised time (wrapped and re-sorted) — the other leg/arm. */
function shift(keys: readonly Key[], offset: number): Key[] {
  return keys
    .map(([t, x, y, z]) => [(((t + offset) % 1) + 1) % 1, x, y, z] as const)
    .sort((a, b) => a[0] - b[0])
    .filter((k, i, all) => i === 0 || k[0] !== all[i - 1][0]);
}

/** Mirrors Y/Z (twist and side swing) for the right side of the body. */
function mirror(keys: readonly Key[]): Key[] {
  return keys.map(([t, x, y, z]) => [t, x, -y, -z] as const);
}

function cycle(
  name: string,
  duration: number,
  leg: { upper: Key[]; lower: Key[]; foot: Key[] },
  arm: { upper: Key[]; lower: Key[] },
  extra: ClipDef['tracks'],
  hips: Key[],
): ClipDef {
  return {
    name,
    duration,
    loop: true,
    tracks: {
      upperLegL: leg.upper,
      lowerLegL: leg.lower,
      footL: leg.foot,
      upperLegR: shift(leg.upper, 0.5),
      lowerLegR: shift(leg.lower, 0.5),
      footR: shift(leg.foot, 0.5),
      upperArmL: arm.upper,
      lowerArmL: arm.lower,
      upperArmR: mirror(shift(arm.upper, 0.5)),
      lowerArmR: mirror(shift(arm.lower, 0.5)),
      ...extra,
    },
    hips,
  };
}

const idle: ClipDef = {
  name: 'idle',
  duration: 3.2,
  loop: true,
  tracks: {
    spine: [
      [0, 1, 0, 0],
      [0.5, 2, 0, 0],
    ],
    chest: [
      [0, 1.5, 0, 0],
      [0.5, 3.5, 0, 0],
    ],
    neck: [
      [0, -2, 0, 0],
      [0.5, -3, 0, 0],
    ],
    head: [
      [0, 0, -3, 0],
      [0.5, 1, 4, 0],
    ],
    upperArmL: [
      [0, 2, 0, 6],
      [0.5, 3, 0, 7],
    ],
    lowerArmL: [
      [0, -8, 0, 0],
      [0.5, -10, 0, 0],
    ],
    upperArmR: [
      [0, 2, 0, -6],
      [0.5, 3, 0, -7],
    ],
    lowerArmR: [
      [0, -8, 0, 0],
      [0.5, -10, 0, 0],
    ],
    upperLegL: [[0, -2, 0, 2]],
    upperLegR: [[0, 2, 0, -2]],
    lowerLegL: [[0, 3, 0, 0]],
    lowerLegR: [[0, 3, 0, 0]],
  },
  hips: [
    [0, 0, 0, 0],
    [0.5, 0, -0.008, 0],
  ],
};

const walk = cycle(
  'walk',
  1.05,
  {
    upper: [
      [0, -24, 0, 0],
      [0.25, -2, 0, 0],
      [0.5, 21, 0, 0],
      [0.75, -9, 0, 0],
    ],
    lower: [
      [0, 4, 0, 0],
      [0.12, 14, 0, 0],
      [0.3, 5, 0, 0],
      [0.5, 18, 0, 0],
      [0.66, 58, 0, 0],
      [0.85, 22, 0, 0],
    ],
    foot: [
      [0, -14, 0, 0],
      [0.12, 0, 0, 0],
      [0.42, 6, 0, 0],
      [0.55, 22, 0, 0],
      [0.72, -4, 0, 0],
    ],
  },
  {
    upper: [
      [0, 16, 0, 5],
      [0.5, -16, 0, 5],
    ],
    lower: [
      [0, -10, 0, 0],
      [0.5, -24, 0, 0],
    ],
  },
  {
    spine: [
      [0, 3, 3, 0],
      [0.5, 3, -3, 0],
    ],
    chest: [
      [0, 1, -5, 0],
      [0.5, 1, 5, 0],
    ],
    head: [
      [0, -2, 2, 0],
      [0.5, -2, -2, 0],
    ],
  },
  [
    [0, 0, -0.03, 0],
    [0.25, 0, 0.012, 0],
    [0.5, 0, -0.03, 0],
    [0.75, 0, 0.012, 0],
  ],
);

const run = cycle(
  'run',
  0.68,
  {
    upper: [
      [0, -30, 0, 0],
      [0.15, -8, 0, 0],
      [0.35, 26, 0, 0],
      [0.6, 2, 0, 0],
      [0.8, -46, 0, 0],
    ],
    lower: [
      [0, 16, 0, 0],
      [0.15, 32, 0, 0],
      [0.35, 22, 0, 0],
      [0.55, 105, 0, 0],
      [0.8, 62, 0, 0],
    ],
    foot: [
      [0, -10, 0, 0],
      [0.18, 4, 0, 0],
      [0.36, 30, 0, 0],
      [0.6, 12, 0, 0],
      [0.85, -16, 0, 0],
    ],
  },
  {
    upper: [
      [0, 36, 0, 6],
      [0.5, -46, 0, 8],
    ],
    lower: [
      [0, -78, 0, 0],
      [0.5, -102, 0, 0],
    ],
  },
  {
    spine: [
      [0, 9, 5, 0],
      [0.5, 9, -5, 0],
    ],
    chest: [
      [0, 4, -9, 0],
      [0.5, 4, 9, 0],
    ],
    neck: [[0, -8, 0, 0]],
    head: [
      [0, -4, 3, 0],
      [0.5, -4, -3, 0],
    ],
  },
  [
    [0, 0, -0.035, 0],
    [0.15, 0, -0.065, 0],
    [0.38, 0, 0.025, 0],
    [0.5, 0, -0.035, 0],
    [0.65, 0, -0.065, 0],
    [0.88, 0, 0.025, 0],
  ],
);

const sprint = cycle(
  'sprint',
  0.56,
  {
    upper: [
      [0, -38, 0, 0],
      [0.15, -10, 0, 0],
      [0.35, 34, 0, 0],
      [0.6, 0, 0, 0],
      [0.8, -62, 0, 0],
    ],
    lower: [
      [0, 20, 0, 0],
      [0.15, 38, 0, 0],
      [0.35, 28, 0, 0],
      [0.55, 118, 0, 0],
      [0.8, 80, 0, 0],
    ],
    foot: [
      [0, -8, 0, 0],
      [0.18, 6, 0, 0],
      [0.36, 38, 0, 0],
      [0.6, 14, 0, 0],
      [0.85, -18, 0, 0],
    ],
  },
  {
    upper: [
      [0, 48, 0, 6],
      [0.5, -64, 0, 8],
    ],
    lower: [
      [0, -82, 0, 0],
      [0.5, -108, 0, 0],
    ],
  },
  {
    spine: [
      [0, 15, 6, 0],
      [0.5, 15, -6, 0],
    ],
    chest: [
      [0, 6, -11, 0],
      [0.5, 6, 11, 0],
    ],
    neck: [[0, -14, 0, 0]],
    head: [[0, -6, 0, 0]],
  },
  [
    [0, 0, -0.045, 0],
    [0.15, 0, -0.08, 0],
    [0.38, 0, 0.035, 0],
    [0.5, 0, -0.045, 0],
    [0.65, 0, -0.08, 0],
    [0.88, 0, 0.035, 0],
  ],
);

const CROUCH_HIPS = -0.36;

const crouchIdle: ClipDef = {
  name: 'crouchIdle',
  duration: 2.4,
  loop: true,
  tracks: {
    spine: [
      [0, 24, 0, 0],
      [0.5, 26, 0, 0],
    ],
    chest: [[0, 10, 0, 0]],
    neck: [[0, -18, 0, 0]],
    head: [
      [0, -12, 0, 0],
      [0.5, -12, 6, 0],
    ],
    upperArmL: [[0, -20, 0, 10]],
    lowerArmL: [[0, -50, 0, 0]],
    upperArmR: [[0, -20, 0, -10]],
    lowerArmR: [[0, -50, 0, 0]],
    upperLegL: [[0, -74, 0, 6]],
    lowerLegL: [[0, 100, 0, 0]],
    footL: [[0, -26, 0, 0]],
    upperLegR: [[0, -70, 0, -6]],
    lowerLegR: [[0, 98, 0, 0]],
    footR: [[0, -28, 0, 0]],
  },
  hips: [
    [0, 0, CROUCH_HIPS, 0],
    [0.5, 0, CROUCH_HIPS - 0.01, 0],
  ],
};

const crouchWalk = cycle(
  'crouchWalk',
  1.15,
  {
    upper: [
      [0, -88, 0, 4],
      [0.25, -70, 0, 4],
      [0.5, -52, 0, 4],
      [0.75, -80, 0, 4],
    ],
    lower: [
      [0, 100, 0, 0],
      [0.25, 96, 0, 0],
      [0.5, 92, 0, 0],
      [0.7, 118, 0, 0],
    ],
    foot: [
      [0, -18, 0, 0],
      [0.5, -34, 0, 0],
    ],
  },
  {
    upper: [
      [0, -6, 0, 10],
      [0.5, -32, 0, 10],
    ],
    lower: [
      [0, -48, 0, 0],
      [0.5, -60, 0, 0],
    ],
  },
  {
    spine: [
      [0, 26, 3, 0],
      [0.5, 26, -3, 0],
    ],
    chest: [[0, 10, 0, 0]],
    neck: [[0, -20, 0, 0]],
    head: [[0, -12, 0, 0]],
  },
  [
    [0, 0, CROUCH_HIPS - 0.02, 0],
    [0.25, 0, CROUCH_HIPS + 0.01, 0],
    [0.5, 0, CROUCH_HIPS - 0.02, 0],
    [0.75, 0, CROUCH_HIPS + 0.01, 0],
  ],
);

const jump: ClipDef = {
  name: 'jump',
  duration: 1,
  loop: true,
  tracks: {
    spine: [[0, -4, 0, 0]],
    upperArmL: [[0, -40, 0, 38]],
    lowerArmL: [[0, -40, 0, 0]],
    upperArmR: [[0, -30, 0, -38]],
    lowerArmR: [[0, -40, 0, 0]],
    upperLegL: [[0, -48, 0, 4]],
    lowerLegL: [[0, 72, 0, 0]],
    footL: [[0, 12, 0, 0]],
    upperLegR: [[0, -12, 0, -4]],
    lowerLegR: [[0, 30, 0, 0]],
    footR: [[0, 18, 0, 0]],
  },
};

const fall: ClipDef = {
  name: 'fall',
  duration: 0.9,
  loop: true,
  tracks: {
    spine: [
      [0, -6, 0, 0],
      [0.5, -2, 0, 0],
    ],
    neck: [[0, 10, 0, 0]],
    upperArmL: [
      [0, -50, 0, 70],
      [0.5, -10, 0, 50],
    ],
    lowerArmL: [
      [0, -30, 0, 0],
      [0.5, -55, 0, 0],
    ],
    upperArmR: [
      [0, -10, 0, -50],
      [0.5, -50, 0, -70],
    ],
    lowerArmR: [
      [0, -55, 0, 0],
      [0.5, -30, 0, 0],
    ],
    upperLegL: [
      [0, -30, 0, 6],
      [0.5, -8, 0, 6],
    ],
    lowerLegL: [
      [0, 40, 0, 0],
      [0.5, 22, 0, 0],
    ],
    upperLegR: [
      [0, -8, 0, -6],
      [0.5, -30, 0, -6],
    ],
    lowerLegR: [
      [0, 22, 0, 0],
      [0.5, 40, 0, 0],
    ],
  },
};

const land: ClipDef = {
  name: 'land',
  duration: 0.42,
  loop: false,
  tracks: {
    spine: [
      [0, 6, 0, 0],
      [0.3, 22, 0, 0],
      [1, 2, 0, 0],
    ],
    upperArmL: [
      [0, -20, 0, 20],
      [0.3, -30, 0, 25],
      [1, 2, 0, 6],
    ],
    upperArmR: [
      [0, -20, 0, -20],
      [0.3, -30, 0, -25],
      [1, 2, 0, -6],
    ],
    lowerArmL: [
      [0, -30, 0, 0],
      [1, -8, 0, 0],
    ],
    lowerArmR: [
      [0, -30, 0, 0],
      [1, -8, 0, 0],
    ],
    upperLegL: [
      [0, -30, 0, 0],
      [0.3, -62, 0, 4],
      [1, -2, 0, 2],
    ],
    lowerLegL: [
      [0, 50, 0, 0],
      [0.3, 92, 0, 0],
      [1, 3, 0, 0],
    ],
    footL: [
      [0, -18, 0, 0],
      [0.3, -30, 0, 0],
      [1, 0, 0, 0],
    ],
    upperLegR: [
      [0, -26, 0, 0],
      [0.3, -58, 0, -4],
      [1, 2, 0, -2],
    ],
    lowerLegR: [
      [0, 46, 0, 0],
      [0.3, 88, 0, 0],
      [1, 3, 0, 0],
    ],
    footR: [
      [0, -18, 0, 0],
      [0.3, -30, 0, 0],
      [1, 0, 0, 0],
    ],
  },
  hips: [
    [0, 0, -0.1, 0],
    [0.3, 0, -0.3, 0],
    [1, 0, 0, 0],
  ],
};

const climb: ClipDef = {
  name: 'climb',
  duration: 1,
  loop: false,
  tracks: {
    spine: [
      [0, 10, 0, 0],
      [0.4, 18, 0, 0],
      [0.7, 42, 0, 0],
      [1, 3, 0, 0],
    ],
    neck: [
      [0, -20, 0, 0],
      [0.7, -24, 0, 0],
      [1, -2, 0, 0],
    ],
    upperArmL: [
      [0, -165, 0, 12],
      [0.35, -150, 0, 12],
      [0.65, -40, 0, 22],
      [1, 2, 0, 6],
    ],
    lowerArmL: [
      [0, -10, 0, 0],
      [0.35, -40, 0, 0],
      [0.65, -20, 0, 0],
      [1, -8, 0, 0],
    ],
    upperArmR: [
      [0, -165, 0, -12],
      [0.35, -150, 0, -12],
      [0.65, -40, 0, -22],
      [1, 2, 0, -6],
    ],
    lowerArmR: [
      [0, -10, 0, 0],
      [0.35, -40, 0, 0],
      [0.65, -20, 0, 0],
      [1, -8, 0, 0],
    ],
    upperLegL: [
      [0, -20, 0, 0],
      [0.4, -50, 0, 0],
      [0.7, -95, 0, 6],
      [1, -2, 0, 2],
    ],
    lowerLegL: [
      [0, 30, 0, 0],
      [0.4, 70, 0, 0],
      [0.7, 110, 0, 0],
      [1, 3, 0, 0],
    ],
    upperLegR: [
      [0, 0, 0, 0],
      [0.4, -20, 0, 0],
      [0.7, -40, 0, -4],
      [1, 2, 0, -2],
    ],
    lowerLegR: [
      [0, 10, 0, 0],
      [0.4, 45, 0, 0],
      [0.7, 60, 0, 0],
      [1, 3, 0, 0],
    ],
  },
};

const swimIdle: ClipDef = {
  name: 'swimIdle',
  duration: 1.8,
  loop: true,
  tracks: {
    spine: [[0, 12, 0, 0]],
    neck: [[0, -10, 0, 0]],
    upperArmL: [
      [0, -40, -20, 50],
      [0.5, -40, 25, 40],
    ],
    lowerArmL: [
      [0, -30, 0, 0],
      [0.5, -50, 0, 0],
    ],
    upperArmR: [
      [0, -40, 25, -40],
      [0.5, -40, -20, -50],
    ],
    lowerArmR: [
      [0, -50, 0, 0],
      [0.5, -30, 0, 0],
    ],
    upperLegL: [
      [0, -30, 0, 6],
      [0.5, 10, 0, 6],
    ],
    lowerLegL: [
      [0, 30, 0, 0],
      [0.5, 60, 0, 0],
    ],
    upperLegR: [
      [0, 10, 0, -6],
      [0.5, -30, 0, -6],
    ],
    lowerLegR: [
      [0, 60, 0, 0],
      [0.5, 30, 0, 0],
    ],
  },
  hips: [
    [0, 0, 0, 0],
    [0.5, 0, 0.03, 0],
  ],
};

const swim: ClipDef = {
  name: 'swim',
  duration: 1.3,
  loop: true,
  tracks: {
    hips: [[0, 78, 0, 0]],
    spine: [
      [0, 0, 6, 0],
      [0.5, 0, -6, 0],
    ],
    neck: [[0, -45, 0, 0]],
    head: [[0, -25, 0, 0]],
    upperArmL: [
      [0, -170, 0, 10],
      [0.25, -100, 0, 10],
      [0.5, 10, 0, 15],
      [0.75, -60, 0, 50],
    ],
    lowerArmL: [
      [0, -10, 0, 0],
      [0.25, -30, 0, 0],
      [0.5, -10, 0, 0],
      [0.75, -80, 0, 0],
    ],
    upperArmR: [
      [0, 10, 0, -15],
      [0.25, -60, 0, -50],
      [0.5, -170, 0, -10],
      [0.75, -100, 0, -10],
    ],
    lowerArmR: [
      [0, -10, 0, 0],
      [0.25, -80, 0, 0],
      [0.5, -10, 0, 0],
      [0.75, -30, 0, 0],
    ],
    upperLegL: [
      [0, -12, 0, 4],
      [0.25, 12, 0, 4],
      [0.5, -12, 0, 4],
      [0.75, 12, 0, 4],
    ],
    lowerLegL: [
      [0, 20, 0, 0],
      [0.25, 8, 0, 0],
      [0.5, 20, 0, 0],
      [0.75, 8, 0, 0],
    ],
    upperLegR: [
      [0, 12, 0, -4],
      [0.25, -12, 0, -4],
      [0.5, 12, 0, -4],
      [0.75, -12, 0, -4],
    ],
    lowerLegR: [
      [0, 8, 0, 0],
      [0.25, 20, 0, 0],
      [0.5, 8, 0, 0],
      [0.75, 20, 0, 0],
    ],
    footL: [[0, 40, 0, 0]],
    footR: [[0, 40, 0, 0]],
  },
  hips: [[0, 0, 0.55, -0.4]],
};

/** Unarmed guard stance (upper body only; weapons add their own aims in M5). Fists at chin height. */
const aim: ClipDef = {
  name: 'aim',
  duration: 1,
  loop: true,
  tracks: {
    spine: [[0, 6, 0, 0]],
    chest: [[0, 3, 14, 0]],
    head: [[0, -6, -12, 0]],
    upperArmL: [[0, -28, -8, 12]],
    lowerArmL: [[0, -118, 0, 0]],
    upperArmR: [[0, -20, 8, -14]],
    lowerArmR: [[0, -124, 0, 0]],
  },
};

const punch: ClipDef = {
  name: 'punch',
  duration: 0.45,
  loop: false,
  tracks: {
    chest: [
      [0, 2, 12, 0],
      [0.35, 4, -22, 0],
      [1, 2, 12, 0],
    ],
    upperArmL: [
      [0, -55, 0, 16],
      [0.35, -40, 0, 20],
      [1, -55, 0, 16],
    ],
    lowerArmL: [
      [0, -110, 0, 0],
      [1, -110, 0, 0],
    ],
    upperArmR: [
      [0, -45, 0, -18],
      [0.35, -88, 0, -4],
      [1, -45, 0, -18],
    ],
    lowerArmR: [
      [0, -115, 0, 0],
      [0.35, -6, 0, 0],
      [1, -115, 0, 0],
    ],
  },
};

/** Additive flinch when hit (applied on top of whatever is playing). */
const hit: ClipDef = {
  name: 'hit',
  duration: 0.35,
  loop: false,
  tracks: {
    spine: [
      [0, 0, 0, 0],
      [0.3, -10, 4, 0],
      [1, 0, 0, 0],
    ],
    chest: [
      [0, 0, 0, 0],
      [0.3, -8, 0, 0],
      [1, 0, 0, 0],
    ],
    head: [
      [0, 0, 0, 0],
      [0.25, -16, 6, 0],
      [1, 0, 0, 0],
    ],
  },
};

const die: ClipDef = {
  name: 'die',
  duration: 1.2,
  loop: false,
  tracks: {
    hips: [
      [0, 0, 0, 0],
      [0.35, -30, 10, 0],
      [0.75, -86, 18, 0],
      [1, -90, 20, 0],
    ],
    spine: [
      [0, 0, 0, 0],
      [0.5, -10, 0, 0],
      [1, -4, 0, 0],
    ],
    neck: [
      [0, 0, 0, 0],
      [0.8, 10, 0, 0],
      [1, 6, 30, 0],
    ],
    upperArmL: [
      [0, -20, 0, 30],
      [0.5, -60, 0, 70],
      [1, -30, 0, 80],
    ],
    lowerArmL: [
      [0, -30, 0, 0],
      [1, -20, 0, 0],
    ],
    upperArmR: [
      [0, -20, 0, -30],
      [0.5, -40, 0, -60],
      [1, -10, 0, -70],
    ],
    lowerArmR: [
      [0, -30, 0, 0],
      [1, -40, 0, 0],
    ],
    upperLegL: [
      [0, -10, 0, 0],
      [0.5, -50, 0, 6],
      [1, -30, 0, 10],
    ],
    lowerLegL: [
      [0, 20, 0, 0],
      [0.5, 60, 0, 0],
      [1, 30, 0, 0],
    ],
    upperLegR: [
      [0, 0, 0, 0],
      [0.5, -30, 0, -6],
      [1, -6, 0, -12],
    ],
    lowerLegR: [
      [0, 10, 0, 0],
      [0.5, 40, 0, 0],
      [1, 6, 0, 0],
    ],
  },
  hips: [
    [0, 0, 0, 0],
    [0.35, 0, -0.25, -0.05],
    [0.75, 0, -0.72, -0.35],
    [1, 0, -0.8, -0.4],
  ],
};

/** Seated at a steering wheel (hips at seat height; root is the seat). */
const sitDrive: ClipDef = {
  name: 'sitDrive',
  duration: 3,
  loop: true,
  tracks: {
    spine: [[0, -8, 0, 0]],
    chest: [
      [0, 2, 0, 0],
      [0.5, 3, 0, 0],
    ],
    neck: [[0, 4, 0, 0]],
    head: [
      [0, 2, -3, 0],
      [0.5, 2, 3, 0],
    ],
    upperArmL: [[0, -52, 0, 14]],
    lowerArmL: [[0, -42, 0, 0]],
    upperArmR: [[0, -52, 0, -14]],
    lowerArmR: [[0, -42, 0, 0]],
    upperLegL: [[0, -82, 0, 6]],
    lowerLegL: [[0, 72, 0, 0]],
    footL: [[0, -8, 0, 0]],
    upperLegR: [[0, -82, 0, -6]],
    lowerLegR: [[0, 72, 0, 0]],
    footR: [[0, -8, 0, 0]],
  },
  // Root on the cabin floor; hips drop onto the seat cushion ≈ 0.3 m above it.
  hips: [[0, 0, -0.67, -0.12]],
};

/** Astride a motorbike, leaning onto the bars. */
const sitRide: ClipDef = {
  name: 'sitRide',
  duration: 3,
  loop: true,
  tracks: {
    spine: [[0, 26, 0, 0]],
    chest: [[0, 10, 0, 0]],
    neck: [[0, -22, 0, 0]],
    head: [[0, -10, 0, 0]],
    upperArmL: [[0, -58, 0, 16]],
    lowerArmL: [[0, -30, 0, 0]],
    upperArmR: [[0, -58, 0, -16]],
    lowerArmR: [[0, -30, 0, 0]],
    upperLegL: [[0, -58, 0, 18]],
    lowerLegL: [[0, 88, 0, 0]],
    footL: [[0, -10, 0, 0]],
    upperLegR: [[0, -58, 0, -18]],
    lowerLegR: [[0, 88, 0, 0]],
    footR: [[0, -10, 0, 0]],
  },
  hips: [[0, 0, -0.42, -0.08]],
};

export const ANIMATION_CLIPS: readonly ClipDef[] = [
  sitDrive,
  sitRide,
  idle,
  walk,
  run,
  sprint,
  crouchIdle,
  crouchWalk,
  jump,
  fall,
  land,
  climb,
  swimIdle,
  swim,
  aim,
  punch,
  hit,
  die,
];
