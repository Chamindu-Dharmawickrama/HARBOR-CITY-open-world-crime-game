import { describe, expect, it } from 'vitest';
import { Animator, REQUIRED_CLIPS } from '../characters/anim/animator';
import { buildClipLibrary } from '../characters/anim/clip';
import { Pose } from '../characters/anim/pose';
import { BONE_INDEX, type BoneName } from '../characters/rig/skeleton-def';
import { ANIMATION_CLIPS } from './animations';

function angleX(pose: Pose, bone: BoneName): number {
  const [x, , , w] = pose.quat(bone);
  return (2 * Math.atan2(x, w) * 180) / Math.PI;
}

describe('animation content', () => {
  const library = buildClipLibrary(ANIMATION_CLIPS);

  it('provides every clip the animator needs, with sane durations', () => {
    for (const name of REQUIRED_CLIPS) expect(library[name], name).toBeDefined();
    for (const clip of ANIMATION_CLIPS) {
      expect(clip.duration, clip.name).toBeGreaterThan(0.1);
      expect(clip.duration, clip.name).toBeLessThan(5);
    }
    expect(() => new Animator(library)).not.toThrow();
  });

  it('cyclic gaits share the phase convention: left leg forward at t = 0, right leg at t = 0.5', () => {
    const pose = new Pose();
    for (const name of ['walk', 'run', 'sprint', 'crouchWalk']) {
      const clip = library[name];
      if (!clip) throw new Error(name);
      clip.sample(0, pose);
      // Forward swing is negative X on legs; the left thigh leads the right one at t = 0.
      expect(angleX(pose, 'upperLegL'), name).toBeLessThan(angleX(pose, 'upperLegR'));
      clip.sample(clip.duration / 2, pose);
      expect(angleX(pose, 'upperLegR'), name).toBeLessThan(angleX(pose, 'upperLegL'));
    }
  });

  it('arms swing opposite to the legs', () => {
    const pose = new Pose();
    const walk = library['walk'];
    if (!walk) throw new Error('walk');
    walk.sample(0, pose);
    // Left leg forward ⇒ left arm back (positive X) and right arm forward.
    expect(angleX(pose, 'upperArmL')).toBeGreaterThan(0);
    expect(angleX(pose, 'upperArmR')).toBeLessThan(0);
  });

  it('keeps joints within human ranges (knees and elbows bend one way)', () => {
    const pose = new Pose();
    for (const clip of Object.values(library)) {
      for (let i = 0; i <= 20; i++) {
        clip.sample((i / 20) * clip.duration, pose);
        for (const knee of ['lowerLegL', 'lowerLegR'] as const) {
          expect(angleX(pose, knee), `${clip.name} ${knee}`).toBeGreaterThan(-2);
          expect(angleX(pose, knee), `${clip.name} ${knee}`).toBeLessThan(140);
        }
        for (const elbow of ['lowerArmL', 'lowerArmR'] as const) {
          expect(angleX(pose, elbow), `${clip.name} ${elbow}`).toBeLessThan(2);
          expect(angleX(pose, elbow), `${clip.name} ${elbow}`).toBeGreaterThan(-150);
        }
        expect(Math.abs(pose.hips[1]), `${clip.name} hips`).toBeLessThan(1);
      }
    }
    expect(BONE_INDEX.lowerLegL).toBeGreaterThan(0);
  });
});
