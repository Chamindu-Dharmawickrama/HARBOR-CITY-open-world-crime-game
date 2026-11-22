import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BONE_INDEX } from '../rig/skeleton-def';
import { Blend1D } from './blend-1d';
import { buildClipLibrary, Clip } from './clip';
import { solveTwoBoneIK } from './ik';
import { blendPoses, boneMask, Pose } from './pose';

const swing = new Clip({
  name: 'swing',
  duration: 1,
  loop: true,
  tracks: {
    upperLegL: [
      [0, -30, 0, 0],
      [0.5, 30, 0, 0],
    ],
  },
  hips: [
    [0, 0, -0.03, 0],
    [0.5, 0, 0.01, 0],
  ],
});

function angleX(pose: Pose, bone: keyof typeof BONE_INDEX): number {
  const [x, , , w] = pose.quat(bone);
  return (2 * Math.atan2(x, w) * 180) / Math.PI;
}

describe('Pose', () => {
  it('Euler conversion matches Three.js XYZ order', () => {
    const pose = new Pose();
    pose.setEuler(BONE_INDEX.chest, 20, -35, 50);
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((20 * Math.PI) / 180, (-35 * Math.PI) / 180, (50 * Math.PI) / 180, 'XYZ'),
    );
    const [x, y, z, w] = pose.quat('chest');
    expect(x).toBeCloseTo(q.x, 5);
    expect(y).toBeCloseTo(q.y, 5);
    expect(z).toBeCloseTo(q.z, 5);
    expect(w).toBeCloseTo(q.w, 5);
  });

  it('blends halfway and respects masks', () => {
    const a = new Pose();
    const b = new Pose();
    b.setEuler(BONE_INDEX.chest, 60, 0, 0);
    b.setEuler(BONE_INDEX.upperLegL, 60, 0, 0);
    b.hips[1] = 0.2;
    const out = new Pose();
    blendPoses(a, b, 0.5, out);
    expect(angleX(out, 'chest')).toBeCloseTo(30, 3);
    expect(out.hips[1]).toBeCloseTo(0.1);
    blendPoses(a, b, 1, out, boneMask(['chest']));
    expect(angleX(out, 'chest')).toBeCloseTo(60, 3);
    expect(angleX(out, 'upperLegL')).toBeCloseTo(0, 5);
  });

  it('addEuler stacks rotations', () => {
    const p = new Pose();
    p.setEuler(BONE_INDEX.spine, 10, 0, 0);
    p.addEuler(BONE_INDEX.spine, 15, 0, 0);
    expect(angleX(p, 'spine')).toBeCloseTo(25, 4);
  });
});

describe('Clip', () => {
  it('hits keys exactly and interpolates smoothly between them', () => {
    const out = new Pose();
    swing.sample(0, out);
    expect(angleX(out, 'upperLegL')).toBeCloseTo(-30, 3);
    expect(out.hips[1]).toBeCloseTo(-0.03);
    swing.sample(0.5, out);
    expect(angleX(out, 'upperLegL')).toBeCloseTo(30, 3);
    swing.sample(0.25, out);
    expect(Math.abs(angleX(out, 'upperLegL'))).toBeLessThan(5);
  });

  it('loops wrap and one-shots clamp', () => {
    const out = new Pose();
    swing.sample(1.5, out);
    expect(angleX(out, 'upperLegL')).toBeCloseTo(30, 3);
    const once = new Clip({
      name: 'once',
      duration: 2,
      loop: false,
      tracks: {
        head: [
          [0, 0, 0, 0],
          [1, 40, 0, 0],
        ],
      },
    });
    once.sample(10, out);
    expect(angleX(out, 'head')).toBeCloseTo(40, 3);
  });

  it('rejects malformed keys and duplicate clip names', () => {
    expect(
      () =>
        new Clip({
          name: 'bad',
          duration: 1,
          loop: true,
          tracks: {
            head: [
              [0.5, 0, 0, 0],
              [0.2, 0, 0, 0],
            ],
          },
        }),
    ).toThrow();
    expect(() =>
      buildClipLibrary([
        { name: 'x', duration: 1, loop: true, tracks: {} },
        { name: 'x', duration: 1, loop: true, tracks: {} },
      ]),
    ).toThrow();
  });
});

describe('Blend1D', () => {
  const fast = new Clip({
    name: 'fast',
    duration: 0.5,
    loop: true,
    tracks: {
      upperLegL: [
        [0, -60, 0, 0],
        [0.5, 60, 0, 0],
      ],
    },
  });
  const idle = new Clip({ name: 'idle', duration: 2, loop: true, tracks: {} });

  it('brackets values and keeps a shared phase', () => {
    const blend = new Blend1D([
      { clip: idle, at: 0 },
      { clip: swing, at: 1.5 },
      { clip: fast, at: 4.5 },
    ]);
    expect(blend.bracket(-1)).toEqual({ index: 0, weight: 0 });
    expect(blend.bracket(3)).toEqual({ index: 1, weight: 0.5 });
    expect(blend.bracket(99)).toEqual({ index: 2, weight: 0 });
    const out = new Pose();
    blend.update(3, 0.375, out); // blended cycle 0.75 s → phase advances 0.5
    expect(blend.phase).toBeCloseTo(0.5);
    // Both clips are at their t=0.5 key (+30° and +60°) → blend ≈ 45°.
    expect(angleX(out, 'upperLegL')).toBeCloseTo(45, 0);
  });

  it('rejects unsorted points', () => {
    expect(
      () =>
        new Blend1D([
          { clip: swing, at: 2 },
          { clip: fast, at: 1 },
        ]),
    ).toThrow();
  });
});

describe('two-bone IK', () => {
  function chain(): { root: THREE.Object3D; upper: THREE.Bone; lower: THREE.Bone; end: THREE.Bone } {
    const root = new THREE.Object3D();
    const upper = new THREE.Bone();
    const lower = new THREE.Bone();
    const end = new THREE.Bone();
    upper.position.set(0, 1, 0);
    lower.position.set(0, -0.45, 0);
    end.position.set(0, -0.45, 0);
    lower.rotation.x = 0.2;
    root.add(upper);
    upper.add(lower);
    lower.add(end);
    root.updateMatrixWorld(true);
    return { root, upper, lower, end };
  }

  it('places the end effector on a reachable target', () => {
    const { upper, lower, end } = chain();
    const target = new THREE.Vector3(0.1, 0.35, 0.25);
    solveTwoBoneIK(upper, lower, end, target, new THREE.Vector3(0, 0, 1));
    const p = end.getWorldPosition(new THREE.Vector3());
    expect(p.distanceTo(target)).toBeLessThan(1e-3);
    // Segment lengths are preserved (rotations only).
    const pu = upper.getWorldPosition(new THREE.Vector3());
    const pl = lower.getWorldPosition(new THREE.Vector3());
    expect(pu.distanceTo(pl)).toBeCloseTo(0.45, 5);
  });

  it('extends toward an unreachable target', () => {
    const { upper, lower, end } = chain();
    const target = new THREE.Vector3(0, -5, 0.5);
    solveTwoBoneIK(upper, lower, end, target, new THREE.Vector3(0, 0, 1));
    const pu = upper.getWorldPosition(new THREE.Vector3());
    const pe = end.getWorldPosition(new THREE.Vector3());
    expect(pu.distanceTo(pe)).toBeGreaterThan(0.89);
    const dirToTarget = target.clone().sub(pu).normalize();
    const dirChain = pe.clone().sub(pu).normalize();
    expect(dirToTarget.dot(dirChain)).toBeGreaterThan(0.999);
  });

  it('weight 0 leaves the pose untouched', () => {
    const { upper, lower, end } = chain();
    const before = end.getWorldPosition(new THREE.Vector3());
    solveTwoBoneIK(upper, lower, end, new THREE.Vector3(0.3, 0.3, 0.3), new THREE.Vector3(0, 0, 1), 0);
    expect(end.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-9);
  });
});
