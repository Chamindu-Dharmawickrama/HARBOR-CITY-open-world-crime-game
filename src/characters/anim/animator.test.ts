import { describe, expect, it } from 'vitest';
import { ANIMATION_CLIPS } from '../../content/animations';
import { Animator, emptyAnimatorInput, type AnimatorInput } from './animator';
import { buildClipLibrary } from './clip';
import { Pose } from './pose';

const library = buildClipLibrary(ANIMATION_CLIPS);
const DT = 1 / 60;

function run(animator: Animator, input: AnimatorInput, seconds: number, out: Pose): void {
  for (let t = 0; t < seconds; t += DT) animator.update(input, DT, out);
}

function angleX(pose: Pose, bone: 'upperLegL' | 'lowerLegL' | 'spine' | 'lowerArmR' | 'chest'): number {
  const [x, , , w] = pose.quat(bone);
  return (2 * Math.atan2(x, w) * 180) / Math.PI;
}

describe('Animator', () => {
  it('picks the base state from the motor mode', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    const cases: [AnimatorInput['mode'], boolean, string][] = [
      ['ground', false, 'locomotion'],
      ['ground', true, 'crouch'],
      ['air', false, 'air'],
      ['swim', false, 'swim'],
      ['climb', false, 'climb'],
      ['dead', false, 'dead'],
    ];
    for (const [mode, crouched, state] of cases) {
      input.mode = mode;
      input.crouched = crouched;
      a.update(input, DT, out);
      expect(a.state).toBe(state);
    }
  });

  it('crossfades instead of popping between states', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    run(a, input, 1, out);
    const standing = angleX(out, 'upperLegL');
    input.crouched = true;
    a.update(input, DT, out);
    const firstFrame = angleX(out, 'upperLegL');
    // One frame into the 0.25 s fade the thigh has barely moved toward the crouch (≈ −74°).
    expect(Math.abs(firstFrame - standing)).toBeLessThan(5);
    run(a, input, 0.5, out);
    expect(angleX(out, 'upperLegL')).toBeLessThan(-60);
  });

  it('blends locomotion by speed (sprint leans further forward than walk)', () => {
    const walk = new Animator(library);
    const sprint = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    input.speed = 1.6;
    let walkLean = 0;
    for (let i = 0; i < 120; i++) {
      walk.update(input, DT, out);
      walkLean += angleX(out, 'spine');
    }
    input.speed = 7.2;
    let sprintLean = 0;
    for (let i = 0; i < 120; i++) {
      sprint.update(input, DT, out);
      sprintLean += angleX(out, 'spine');
    }
    expect(sprintLean / 120).toBeGreaterThan(walkLean / 120 + 5);
  });

  it('a hard landing crouches briefly, then recovers', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    run(a, input, 1, out);
    const before = angleX(out, 'lowerLegL');
    a.land(14);
    run(a, input, 0.13, out);
    expect(angleX(out, 'lowerLegL')).toBeGreaterThan(before + 40);
    run(a, input, 0.6, out);
    expect(Math.abs(angleX(out, 'lowerLegL') - before)).toBeLessThan(10);
  });

  it('the aim layer raises the fists without touching the legs and fades out again', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    run(a, input, 1, out);
    const legBefore = angleX(out, 'upperLegL');
    input.aiming = true;
    run(a, input, 0.5, out);
    expect(a.aimBlend).toBe(1);
    expect(angleX(out, 'lowerArmR')).toBeLessThan(-100);
    expect(Math.abs(angleX(out, 'upperLegL') - legBefore)).toBeLessThan(3);
    input.aiming = false;
    run(a, input, 0.5, out);
    expect(a.aimBlend).toBe(0);
  });

  it('aim pitch bends the spine (looking up leans back)', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    input.aiming = true;
    run(a, input, 0.5, out);
    const level = angleX(out, 'chest');
    input.aimPitch = 0.6;
    a.update(input, DT, out);
    expect(angleX(out, 'chest')).toBeLessThan(level - 8);
  });

  it('flinch is additive and short-lived', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    run(a, input, 1, out);
    const before = angleX(out, 'spine');
    a.flinch(1);
    run(a, input, 0.1, out);
    expect(angleX(out, 'spine')).toBeLessThan(before - 4);
    run(a, input, 0.5, out);
    expect(Math.abs(angleX(out, 'spine') - before)).toBeLessThan(2.5);
  });

  it('foot planting only applies on the ground once a fade completes', () => {
    const a = new Animator(library);
    const out = new Pose();
    const input = emptyAnimatorInput();
    run(a, input, 0.5, out);
    expect(a.footPlanting).toBe(1);
    input.mode = 'air';
    a.update(input, DT, out);
    expect(a.footPlanting).toBe(0);
  });
});
