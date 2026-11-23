import { clamp, clamp01, smoothstep } from '../../core/math';
import { BONE_INDEX, UPPER_BODY_BONES } from '../rig/skeleton-def';
import { Blend1D } from './blend-1d';
import type { Clip, ClipLibrary } from './clip';
import { addPose, blendPoses, boneMask, Pose } from './pose';

export type AnimState = 'locomotion' | 'crouch' | 'air' | 'climb' | 'swim' | 'dead' | 'seated';

/** What the animation needs to know about the character each frame. */
export interface AnimatorInput {
  mode: 'ground' | 'air' | 'swim' | 'climb' | 'dead';
  /** Horizontal speed, m/s. */
  speed: number;
  crouched: boolean;
  verticalSpeed: number;
  /** 0..1 while climbing. */
  climbProgress: number;
  aiming: boolean;
  /** Aim pitch in radians (+ = up). */
  aimPitch: number;
  /** Head look yaw relative to the body, radians (+ = left). */
  lookYaw: number;
  /** Seated in a vehicle: the clip to hold (overrides the motor mode), and steering −1..1. */
  seatedClip: 'sitDrive' | 'sitRide' | null;
  steer: number;
}

export const REQUIRED_CLIPS = [
  'idle',
  'walk',
  'run',
  'sprint',
  'crouchIdle',
  'crouchWalk',
  'jump',
  'fall',
  'land',
  'climb',
  'swimIdle',
  'swim',
  'aim',
  'punch',
  'hit',
  'die',
  'sitDrive',
  'sitRide',
] as const;

/** Crossfade time into each state (seconds). */
const FADE_IN: Record<AnimState, number> = {
  locomotion: 0.2,
  crouch: 0.25,
  air: 0.15,
  climb: 0.1,
  swim: 0.35,
  dead: 0.12,
  seated: 0.25,
};

const UPPER_MASK = boneMask(UPPER_BODY_BONES);
const RAD2DEG = 180 / Math.PI;

export function emptyAnimatorInput(): AnimatorInput {
  return {
    mode: 'ground',
    speed: 0,
    crouched: false,
    verticalSpeed: 0,
    climbProgress: 0,
    aiming: false,
    aimPitch: 0,
    lookYaw: 0,
    seatedClip: null,
    steer: 0,
  };
}

/**
 * Character animation state machine:
 * base state (speed-blended locomotion / crouch / air / climb / swim / death) with crossfades →
 * landing overlay → upper-body aim and punch layer (masked) → additive hit flinch → procedural
 * aim pitch and head look. Allocation-free per update.
 */
export class Animator {
  state: AnimState = 'locomotion';
  /** Seconds in the current state. */
  stateTime = 0;
  private readonly clips: Record<(typeof REQUIRED_CLIPS)[number], Clip>;
  private readonly loco: Blend1D;
  private readonly crouch: Blend1D;
  private readonly swim: Blend1D;
  private readonly statePose = new Pose();
  private readonly from = new Pose();
  private readonly tmp = new Pose();
  private readonly tmp2 = new Pose();
  private readonly last = new Pose();
  private fade = 1;
  private fadeDuration = 0.2;
  private landTime = Infinity;
  private landStrength = 0;
  private punchTime = Infinity;
  private hitTime = Infinity;
  private hitStrength = 0;
  private aimWeight = 0;

  constructor(library: ClipLibrary) {
    const clips = {} as Record<(typeof REQUIRED_CLIPS)[number], Clip>;
    for (const name of REQUIRED_CLIPS) {
      const clip = library[name];
      if (!clip) throw new Error(`Animator: missing clip "${name}"`);
      clips[name] = clip;
    }
    this.clips = clips;
    this.loco = new Blend1D([
      { clip: clips.idle, at: 0 },
      { clip: clips.walk, at: 1.6 },
      { clip: clips.run, at: 4.6 },
      { clip: clips.sprint, at: 7.2 },
    ]);
    this.crouch = new Blend1D([
      { clip: clips.crouchIdle, at: 0 },
      { clip: clips.crouchWalk, at: 1.8 },
    ]);
    this.swim = new Blend1D([
      { clip: clips.swimIdle, at: 0 },
      { clip: clips.swim, at: 1.7 },
    ]);
  }

  /** Current weight of the upper-body aim layer (0..1). */
  get aimBlend(): number {
    return this.aimWeight;
  }

  /** Locomotion phase (0..1, left foot down at 0) — for footstep sounds later. */
  get phase(): number {
    return this.loco.phase;
  }

  /** How much foot IK should apply in the current state (0..1). */
  get footPlanting(): number {
    if (this.state !== 'locomotion' && this.state !== 'crouch') return 0;
    return this.fade < 1 ? smoothstep(0, 1, this.fade) : 1;
  }

  /** A landing with the given downward impact speed (m/s). */
  land(impactSpeed: number): void {
    if (impactSpeed < 3) return;
    this.landTime = 0;
    this.landStrength = clamp(impactSpeed / 9, 0.35, 1);
  }

  punch(): void {
    this.punchTime = 0;
  }

  flinch(strength = 1): void {
    this.hitTime = 0;
    this.hitStrength = clamp01(strength);
  }

  update(input: AnimatorInput, dt: number, out: Pose): void {
    const next = this.stateFor(input);
    if (next !== this.state) {
      this.from.copy(this.last);
      this.state = next;
      this.stateTime = 0;
      this.fade = 0;
      this.fadeDuration = FADE_IN[next];
    }
    this.stateTime += dt;
    this.evaluateState(input, dt, this.statePose);

    // Crossfade from the frozen previous output.
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeDuration);
      blendPoses(this.from, this.statePose, smoothstep(0, 1, this.fade), out);
    } else {
      out.copy(this.statePose);
    }

    // Landing overlay (crouches into the impact, recovers over the clip; weaker when moving).
    const land = this.clips.land;
    if (this.landTime < land.duration && (this.state === 'locomotion' || this.state === 'crouch')) {
      const u = this.landTime / land.duration;
      const moving = clamp01(input.speed / 4.6);
      const w = this.landStrength * (1 - 0.6 * moving) * (u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3);
      land.sample(this.landTime, this.tmp);
      blendPoses(out, this.tmp, w, out);
    }
    this.landTime += dt;

    // Upper body: guard/aim stance and punches.
    const upperAllowed = this.state === 'locomotion' || this.state === 'crouch';
    const aimTarget = input.aiming && upperAllowed ? 1 : 0;
    this.aimWeight += clamp(aimTarget - this.aimWeight, -dt * 6, dt * 8);
    if (this.aimWeight > 0.001) {
      this.clips.aim.sample(this.stateTime, this.tmp);
      blendPoses(out, this.tmp, smoothstep(0, 1, this.aimWeight), out, UPPER_MASK);
    }
    const punch = this.clips.punch;
    if (this.punchTime < punch.duration && upperAllowed) {
      punch.sample(this.punchTime, this.tmp);
      const u = this.punchTime / punch.duration;
      blendPoses(out, this.tmp, u < 0.1 ? u / 0.1 : u > 0.85 ? (1 - u) / 0.15 : 1, out, UPPER_MASK);
    }
    this.punchTime += dt;

    // Additive flinch.
    const hit = this.clips.hit;
    if (this.hitTime < hit.duration && this.state !== 'dead') {
      hit.sample(this.hitTime, this.tmp2);
      addPose(out, this.tmp2, this.hitStrength, out);
    }
    this.hitTime += dt;

    // Procedural aim pitch (spread over the spine) and head look.
    if (this.state !== 'dead' && this.state !== 'climb') {
      const pitchDeg = clamp(input.aimPitch, -1.1, 1.1) * RAD2DEG * this.aimWeight;
      if (pitchDeg !== 0) {
        out.addEuler(BONE_INDEX.spine, -pitchDeg * 0.3, 0, 0);
        out.addEuler(BONE_INDEX.chest, -pitchDeg * 0.35, 0, 0);
        out.addEuler(BONE_INDEX.neck, -pitchDeg * 0.2, 0, 0);
      }
      const lookDeg = clamp(input.lookYaw, -1.2, 1.2) * RAD2DEG;
      if (lookDeg !== 0) {
        out.addEuler(BONE_INDEX.neck, 0, lookDeg * 0.4, 0);
        out.addEuler(BONE_INDEX.head, 0, lookDeg * 0.6, 0);
      }
    }
    this.last.copy(out);
  }

  private stateFor(input: AnimatorInput): AnimState {
    if (input.seatedClip) return 'seated';
    switch (input.mode) {
      case 'dead':
        return 'dead';
      case 'climb':
        return 'climb';
      case 'swim':
        return 'swim';
      case 'air':
        return 'air';
      case 'ground':
        return input.crouched ? 'crouch' : 'locomotion';
    }
  }

  private evaluateState(input: AnimatorInput, dt: number, out: Pose): void {
    const c = this.clips;
    switch (this.state) {
      case 'locomotion':
        this.loco.update(input.speed, dt, out);
        return;
      case 'crouch':
        this.crouch.update(input.speed, dt, out);
        return;
      case 'swim':
        this.swim.update(input.speed, dt * Math.max(1, input.speed / 1.7), out);
        return;
      case 'air': {
        // Rising → tucked jump pose; falling → flailing fall pose.
        const w = clamp01((2 - input.verticalSpeed) / 5);
        c.jump.sample(this.stateTime, this.tmp);
        c.fall.sample(this.stateTime, this.tmp2);
        blendPoses(this.tmp, this.tmp2, w, out);
        return;
      }
      case 'climb':
        c.climb.sample(clamp01(input.climbProgress) * c.climb.duration, out);
        return;
      case 'dead':
        c.die.sample(this.stateTime, out);
        return;
      case 'seated': {
        (input.seatedClip === 'sitRide' ? c.sitRide : c.sitDrive).sample(this.stateTime, out);
        // Hands follow the steering: shoulders turn with the wheel, the head looks into the turn.
        const steer = Math.max(-1, Math.min(1, input.steer));
        out.addEuler(BONE_INDEX.chest, 0, -steer * 8, 0);
        out.addEuler(BONE_INDEX.upperArmL, steer * 12, 0, 0);
        out.addEuler(BONE_INDEX.upperArmR, -steer * 12, 0, 0);
        out.addEuler(BONE_INDEX.head, 0, -steer * 12, 0);
        return;
      }
    }
  }
}
