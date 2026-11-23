import * as THREE from 'three';
import type { Vec2Out } from '../../core/input/deadzone';
import type { InputSystem } from '../../core/input/input-system';
import { clamp, dampAngle, wrapAngle } from '../../core/math';
import type { Entity } from '../../ecs/entity';
import type { FixedSystem, RenderContext, RenderSystem } from '../../ecs/scheduler';
import { interpolatePose, setPose, Transform, type PoseOut, type TransformStore } from '../../ecs/transform';
import type { World } from '../../ecs/world';
import type { PhysicsWorld } from '../../physics/physics-world';
import { ORBIT, OrbitCamera, type OrbitTarget } from '../../rendering/camera/orbit-camera';
import { Animator, emptyAnimatorInput } from '../anim/animator';
import type { ClipLibrary } from '../anim/clip';
import { Pose } from '../anim/pose';
import type { CharacterView, GroundQuery } from '../rig/character-view';
import {
  CameraClip,
  createCameraClipCheck,
  createCameraCollision,
  createGroundQuery,
} from './physics-queries';
import { yawFacingCamera, type PlayerCharacter } from './player-character';

/** Fixed step: player logic + motor, then publishes the pose to the entity's Transform. */
export function createPlayerFixedSystem(player: PlayerCharacter, world: World, entity: Entity): FixedSystem {
  const transforms = world.soa(Transform);
  return {
    name: 'player',
    phase: 'prePhysics',
    fixedUpdate(ctx): void {
      player.step(ctx.dt);
      const p = player.motor.position;
      const half = player.motor.yaw / 2;
      setPose(transforms, entity, p.x, p.y, p.z, 0, Math.sin(half), 0, Math.cos(half));
    },
  };
}

/**
 * Seat placement while getting in, sitting in and getting out of a vehicle (filled in by the
 * vehicle layer). The character is placed in `anchor`'s frame, blending from the door stand
 * point (blend 0) to the seat (blend 1).
 */
export interface SeatOverride {
  anchor: THREE.Object3D;
  seat: THREE.Vector3;
  door: THREE.Vector3;
  blend: number;
  clip: 'sitDrive' | 'sitRide';
  steer: number;
  /** Interior camera: hide the body. */
  hidden: boolean;
}

const seatLocal = new THREE.Vector3();
const seatWorld = new THREE.Vector3();
const seatQuat = new THREE.Quaternion();

/** Yaw (0 = +Z) from an interpolated rotation about Y. */
function yawOf(pose: PoseOut): number {
  return 2 * Math.atan2(pose.qy, pose.qw);
}

/**
 * Render rate: interpolated placement, animation state machine, pose → bones, foot IK.
 * Hidden when the camera is inside the character (tight spaces).
 */
export class PlayerPresentation implements RenderSystem {
  readonly name = 'playerAnimation';
  readonly phase = 'animation' as const;
  readonly animator: Animator;
  readonly pose = new Pose();
  /** Interpolated feet position and yaw this frame (read by the camera). */
  readonly interpolated: PoseOut = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  yaw = 0;
  private readonly input = emptyAnimatorInput();
  private readonly ground: GroundQuery;
  private readonly transforms: TransformStore;
  private lastLandings = 0;
  private lastDamaged = 0;
  private headYaw = 0;
  /** Set by the camera system: hide the body when the camera is pressed into it. */
  cameraTooClose = false;
  /** Set by the vehicle layer while getting in / riding / getting out. */
  seat: SeatOverride | null = null;

  constructor(
    private readonly player: PlayerCharacter,
    readonly view: CharacterView,
    world: World,
    private readonly entity: Entity,
    physics: PhysicsWorld,
    clips: ClipLibrary,
    private readonly camera: { yaw: number; pitch: number },
  ) {
    this.animator = new Animator(clips);
    this.ground = createGroundQuery(physics);
    this.transforms = world.soa(Transform);
  }

  /** Called when the player takes damage (additive flinch). */
  flinch(amount: number): void {
    this.lastDamaged = amount;
    this.animator.flinch(clamp(amount / 30, 0.35, 1));
  }

  renderUpdate(ctx: RenderContext): void {
    const player = this.player;
    const motor = player.motor;
    const dt = ctx.frameSeconds;
    interpolatePose(this.transforms, this.entity, ctx.alpha, this.interpolated);
    const pose = this.interpolated;
    const seat = this.seat;
    if (seat) {
      // In the vehicle's frame (includes a bike's lean).
      seat.anchor.updateWorldMatrix(true, false);
      seatLocal.lerpVectors(seat.door, seat.seat, seat.blend);
      seatWorld.copy(seatLocal).applyMatrix4(seat.anchor.matrixWorld);
      seat.anchor.getWorldQuaternion(seatQuat);
      this.view.setTransformQuat(seatWorld.x, seatWorld.y, seatWorld.z, seatQuat);
      this.yaw = 2 * Math.atan2(seatQuat.y, seatQuat.w);
      pose.x = seatWorld.x;
      pose.y = seatWorld.y;
      pose.z = seatWorld.z;
      this.view.setVisible(!seat.hidden);
      const input = this.input;
      input.seatedClip = seat.blend > 0.2 ? seat.clip : null;
      input.steer = seat.steer;
      input.mode = 'ground';
      input.speed = 0;
      input.aiming = false;
      input.lookYaw = 0;
      this.animator.update(input, dt, this.pose);
      this.view.applyPose(this.pose);
      return;
    }
    this.input.seatedClip = null;
    this.yaw = yawOf(pose);
    this.view.setTransform(pose.x, pose.y, pose.z, this.yaw);
    this.view.setVisible(!player.placing && !this.cameraTooClose);

    if (motor.landings !== this.lastLandings) {
      this.lastLandings = motor.landings;
      this.animator.land(motor.lastImpactSpeed);
    }
    const input = this.input;
    input.mode = motor.mode;
    input.speed = motor.speed;
    input.crouched = motor.crouched;
    input.verticalSpeed = motor.velocity.y;
    input.climbProgress = motor.climbProgress;
    input.aiming = player.aiming;
    input.aimPitch = this.camera.pitch;
    // Idle head look toward where the camera points (never over the shoulder).
    const rel = wrapAngle(yawFacingCamera(this.camera.yaw) - this.yaw);
    const lookTarget = !player.aiming && Math.abs(rel) < 1.9 && motor.speed < 3 ? clamp(rel, -1.1, 1.1) : 0;
    this.headYaw = dampAngle(this.headYaw, lookTarget, 5, dt);
    input.lookYaw = this.headYaw;
    this.animator.update(input, dt, this.pose);
    this.view.applyPose(this.pose);
    this.view.plantFeet(this.ground, motor.grounded ? this.animator.footPlanting : 0, dt);
  }

  get damagedAmount(): number {
    return this.lastDamaged;
  }
}

/**
 * Render rate: third-person camera around the player (follow / aim, shoulder swap, distance
 * modes, collision) and a per-frame clipping audit used by tests.
 */
export class PlayerCameraSystem implements RenderSystem {
  readonly name = 'playerCamera';
  readonly phase = 'camera' as const;
  enabled = true;
  readonly orbit: OrbitCamera;
  /** Frames audited and frames in which the camera clipped into geometry. */
  auditedFrames = 0;
  clippedFrames = 0;
  lastClipped = false;
  /** Details of the first clipped frame since the last reset (for diagnosis). */
  firstClip: {
    reason: number;
    cam: number[];
    pivot: number[];
    head: number[];
    distance: number;
    yaw: number;
    pitch: number;
  } | null = null;
  private readonly look: Vec2Out = { x: 0, y: 0 };
  private readonly target: OrbitTarget = { x: 0, y: 0, z: 0, height: 1.8, heading: 0, speed: 0 };
  private readonly clipCheck: ReturnType<typeof createCameraClipCheck>;
  private snapNext = true;

  constructor(
    camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
    private readonly input: InputSystem,
    private readonly player: PlayerCharacter,
    private readonly presentation: PlayerPresentation,
  ) {
    this.orbit = new OrbitCamera(camera, createCameraCollision(physics));
    this.clipCheck = createCameraClipCheck(physics);
  }

  get yaw(): number {
    return this.orbit.yaw;
  }

  get pitch(): number {
    return this.orbit.pitch;
  }

  /** Snap behind the player on the next frame (spawn, respawn, teleport). */
  snapBehind(): void {
    this.snapNext = true;
  }

  resetAudit(): void {
    this.auditedFrames = 0;
    this.clippedFrames = 0;
    this.firstClip = null;
  }

  renderUpdate(ctx: RenderContext): void {
    if (!this.enabled) return;
    const input = this.input;
    input.readLook(ctx.frameSeconds, this.look);
    const player = this.player;
    const motor = player.motor;
    const p = this.presentation.interpolated;
    const t = this.target;
    t.x = p.x;
    t.y = p.y;
    t.z = p.z;
    t.height = motor.height;
    t.heading = this.presentation.yaw;
    t.speed = motor.speed;
    if (this.snapNext && !player.placing) {
      this.orbit.snap(t);
      this.snapNext = false;
    }
    if (player.controlsEnabled && player.alive) {
      if (input.pressedThisFrame('swapShoulder')) this.orbit.swapShoulder();
      if (input.pressedThisFrame('cameraMode')) this.orbit.cycleDistance();
    }
    this.orbit.aiming = player.aiming;
    const lookEnabled = player.controlsEnabled;
    this.orbit.update(t, lookEnabled ? this.look.x : 0, lookEnabled ? this.look.y : 0, ctx.frameSeconds);
    this.presentation.cameraTooClose = this.orbit.distance < 0.7;

    // Audit: camera sphere clear of geometry and clear sight lines to the player.
    if (!player.placing) {
      const cam = this.orbit.position;
      const pv = this.orbit.pivot;
      const headY = p.y + t.height * 0.85;
      const reason = this.clipCheck(
        cam.x,
        cam.y,
        cam.z,
        pv.x,
        pv.y,
        pv.z,
        p.x,
        headY,
        p.z,
        ORBIT.radius * 0.85,
      );
      this.lastClipped = reason !== CameraClip.none;
      this.auditedFrames++;
      if (this.lastClipped) {
        this.clippedFrames++;
        this.firstClip ??= {
          reason,
          cam: [cam.x, cam.y, cam.z],
          pivot: [pv.x, pv.y, pv.z],
          head: [p.x, headY, p.z],
          distance: this.orbit.distance,
          yaw: this.orbit.yaw,
          pitch: this.orbit.pitch,
        };
      }
    }
  }
}
