import * as THREE from 'three';
import type { Entity } from '../../ecs/entity';
import type { FixedSystem, RenderContext, RenderSystem } from '../../ecs/scheduler';
import {
  interpolatePose,
  setPose,
  teleport,
  Transform,
  type PoseOut,
  type TransformStore,
} from '../../ecs/transform';
import type { World } from '../../ecs/world';
import type { PhysicsWorld } from '../../physics/physics-world';
import { Animator, emptyAnimatorInput } from '../anim/animator';
import type { ClipLibrary } from '../anim/clip';
import { Pose } from '../anim/pose';
import {
  CharacterMotor,
  emptyCommand,
  type MotorCommand,
  type MotorEnvironment,
} from '../controller/character-motor';
import type { SeatOverride } from '../player/player-systems';
import { Ragdoll } from '../ragdoll/ragdoll';
import type { CharacterAppearance } from '../rig/appearance';
import { buildCharacter } from '../rig/character-mesh';
import { CharacterView } from '../rig/character-view';

/**
 * idle / walk (moved by the crowd AI) / seated (in a vehicle) / stumble → flee (own motor, after
 * being pulled out of a car) / ragdoll (physics) → down (lying, alive) → getUp, or dead.
 */
export type NpcState =
  'idle' | 'walk' | 'seated' | 'stumble' | 'flee' | 'ragdoll' | 'down' | 'dead' | 'getUp';

const GET_UP_TIME = 1.1;

/**
 * A non-player character: motor + skinned view + animator. Drivers sit in vehicles, get pulled
 * out and run (their own motor); pedestrians are moved along sidewalk paths by the crowd AI
 * (`moveTo`, no character-controller sweep). Hit hard, an NPC becomes a ragdoll, then lies
 * still (frozen pose) and gets up again — or stays down when it has no health left.
 */
export class NpcCharacter {
  readonly motor: CharacterMotor;
  readonly view: CharacterView;
  readonly animator: Animator;
  readonly entity: Entity;
  state: NpcState = 'idle';
  /** Seated in / being pulled out of a vehicle. */
  seat: SeatOverride | null = null;
  /** Seconds left in the current behaviour (stumble / flee / get up). */
  timer = 0;
  /** Point to run away from while fleeing. */
  readonly threat = { x: 0, z: 0 };
  readonly pose = new Pose();
  readonly interpolated: PoseOut = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  health = 100;
  /** Owned by the crowd AI (moved with `moveTo`). */
  driven = false;
  ragdoll: Ragdoll | null = null;
  /** Animate every Nth rendered frame (distance LOD set by the owner); 0 = not at all. */
  animStride = 1;
  /** Where the lying pose is anchored (also where the NPC stands up). */
  readonly downRoot = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Times this NPC was knocked down (tests / stats). */
  knockdowns = 0;
  private readonly downPose = new Pose();
  private readonly cmd: MotorCommand = emptyCommand();
  private readonly input = emptyAnimatorInput();
  private animCounter = 0;
  private animDt = 0;
  private groundY = 0;
  private readonly pelvis = { x: 0, y: 0, z: 0 };

  constructor(
    physics: PhysicsWorld,
    env: MotorEnvironment,
    world: World,
    clips: ClipLibrary,
    readonly appearance: CharacterAppearance,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) {
    this.motor = new CharacterMotor(physics, env, x, y, z);
    this.view = new CharacterView(buildCharacter(appearance, material), appearance.body);
    this.animator = new Animator(clips);
    this.entity = world.create();
    world.add(this.entity, Transform);
    teleport(world.soa(Transform), this.entity, x, y, z);
  }

  get alive(): boolean {
    return this.health > 0;
  }

  /** Lying on the ground or flying through the air. */
  get knockedDown(): boolean {
    return (
      this.state === 'ragdoll' || this.state === 'down' || this.state === 'dead' || this.state === 'getUp'
    );
  }

  /** Sits in a vehicle seat (collider off). */
  sit(seat: SeatOverride): void {
    this.seat = seat;
    this.state = 'seated';
    this.driven = false;
    this.motor.collider.setEnabled(false);
  }

  /** Leaves the seat at (x, y, z) facing `yaw`, staggering for a moment, then flees from the threat. */
  ejectAndFlee(x: number, y: number, z: number, yaw: number, threatX: number, threatZ: number): void {
    this.seat = null;
    this.driven = false;
    this.motor.collider.setEnabled(true);
    this.motor.teleport(x, y, z);
    this.motor.yaw = yaw;
    this.threat.x = threatX;
    this.threat.z = threatZ;
    this.state = 'stumble';
    this.timer = 0.9;
    this.animator.flinch(1);
  }

  /** Crowd locomotion: place at (x, y, z) facing `yaw`, moving at `speed` (for the animation). */
  moveTo(
    x: number,
    y: number,
    z: number,
    yaw: number,
    speed: number,
    dt: number,
    transforms: TransformStore,
  ): void {
    this.motor.placeKinematic(x, y, z, yaw, speed, dt);
    const half = yaw / 2;
    setPose(transforms, this.entity, x, y, z, 0, Math.sin(half), 0, Math.cos(half));
  }

  /** Thrown as a ragdoll with the given velocity (the motor's capsule is switched off). */
  startRagdoll(physics: PhysicsWorld, vx: number, vy: number, vz: number): void {
    if (this.ragdoll) {
      this.ragdoll.push(vx, vy, vz);
      return;
    }
    this.groundY = this.motor.position.y;
    this.seat = null;
    this.motor.collider.setEnabled(false);
    this.ragdoll = new Ragdoll(physics, this.view, this.appearance.body.height, vx, vy, vz);
    this.state = 'ragdoll';
    this.knockdowns++;
  }

  /** Ends the ragdoll: keeps its last pose and lies there (or is dead). */
  freeze(): void {
    const r = this.ragdoll;
    if (!r) return;
    r.pelvis(this.pelvis);
    const yaw = r.heading();
    const root = this.downRoot;
    root.x = this.pelvis.x;
    root.z = this.pelvis.z;
    root.y = Math.min(this.groundY, this.pelvis.y - 0.1);
    root.yaw = yaw;
    r.writePose(this.downPose, root.x, root.y, root.z, root.yaw);
    r.dispose();
    this.ragdoll = null;
    this.state = this.alive ? 'down' : 'dead';
    this.timer = this.alive ? 1.2 : 0;
    this.motor.teleport(root.x, root.y, root.z);
    this.motor.yaw = yaw;
  }

  /** Stands up from the lying pose (blends into the idle stance). */
  getUp(): void {
    if (this.state !== 'down') return;
    this.state = 'getUp';
    this.timer = GET_UP_TIME;
    this.animator.snapFrom(this.downPose, GET_UP_TIME);
    this.motor.collider.setEnabled(true);
  }

  step(dt: number, transforms: TransformStore): void {
    const cmd = this.cmd;
    cmd.moveX = 0;
    cmd.moveZ = 0;
    cmd.jump = false;
    cmd.crouchToggle = false;
    cmd.faceYaw = null;
    cmd.speed = 'run';
    if (this.state === 'seated') return;
    if (this.ragdoll) {
      this.ragdoll.step(dt);
      return;
    }
    this.timer -= dt;
    if (this.state === 'down' || this.state === 'dead') return;
    if (this.state === 'getUp') {
      if (this.timer <= 0) this.state = 'idle';
      return;
    }
    if (this.driven) return;
    const p = this.motor.position;
    if (this.state === 'stumble') {
      if (this.timer <= 0) {
        this.state = 'flee';
        this.timer = 12;
      }
    } else if (this.state === 'flee') {
      const dx = p.x - this.threat.x;
      const dz = p.z - this.threat.z;
      const len = Math.hypot(dx, dz) || 1;
      cmd.moveX = dx / len;
      cmd.moveZ = dz / len;
      cmd.speed = 'sprint';
      if (this.timer <= 0) this.state = 'idle';
    }
    this.motor.step(cmd, dt);
    const half = this.motor.yaw / 2;
    setPose(transforms, this.entity, p.x, p.y, p.z, 0, Math.sin(half), 0, Math.cos(half));
  }

  render(ctx: RenderContext, transforms: TransformStore): void {
    const seat = this.seat;
    const input = this.input;
    if (this.ragdoll) {
      // Physics drives the skeleton; the root sits under the pelvis.
      this.ragdoll.pelvis(this.pelvis);
      const yaw = this.ragdoll.heading();
      this.ragdoll.writePose(this.pose, this.pelvis.x, this.groundY, this.pelvis.z, yaw);
      this.view.setTransform(this.pelvis.x, this.groundY, this.pelvis.z, yaw);
      this.view.applyPose(this.pose);
      return;
    }
    if (this.state === 'down' || this.state === 'dead') {
      const r = this.downRoot;
      this.view.setTransform(r.x, r.y, r.z, r.yaw);
      this.view.applyPose(this.downPose);
      return;
    }
    if (seat) {
      seat.anchor.updateWorldMatrix(true, false);
      local.lerpVectors(seat.door, seat.seat, seat.blend).applyMatrix4(seat.anchor.matrixWorld);
      seat.anchor.getWorldQuaternion(quat);
      this.view.setTransformQuat(local.x, local.y, local.z, quat);
      input.seatedClip = seat.blend > 0.2 ? seat.clip : null;
      input.steer = seat.steer;
    } else if (this.state === 'getUp') {
      const r = this.downRoot;
      this.view.setTransform(r.x, r.y, r.z, r.yaw);
      input.seatedClip = null;
    } else {
      interpolatePose(transforms, this.entity, ctx.alpha, this.interpolated);
      const pose = this.interpolated;
      this.view.setTransform(pose.x, pose.y, pose.z, 2 * Math.atan2(pose.qy, pose.qw));
      input.seatedClip = null;
    }
    // Distance LOD: far characters animate every few frames (with the accumulated time).
    this.animDt += ctx.frameSeconds;
    if (this.animStride <= 0) return;
    if (++this.animCounter < this.animStride) return;
    this.animCounter = 0;
    const motor = this.motor;
    input.mode = seat || this.state === 'getUp' ? 'ground' : motor.mode;
    input.speed = seat || this.state === 'getUp' ? 0 : motor.speed;
    input.crouched = false;
    input.verticalSpeed = motor.velocity.y;
    this.animator.update(input, this.animDt, this.pose);
    this.animDt = 0;
    this.view.applyPose(this.pose);
  }
}

const local = new THREE.Vector3();
const quat = new THREE.Quaternion();

/** Owns NPCs: steps and renders them, removes the ones that wandered off, budgets ragdolls. */
export class NpcManager {
  readonly npcs: NpcCharacter[] = [];
  readonly listeners: { removed: ((npc: NpcCharacter) => void)[] } = { removed: [] };
  /** At most this many ragdolls simulate at once (the oldest is frozen when a new one starts). */
  maxRagdolls = 8;
  private readonly transforms: TransformStore;
  private readonly ragdolls: NpcCharacter[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly env: MotorEnvironment,
    private readonly world: World,
    private readonly scene: THREE.Scene,
    private readonly clips: ClipLibrary,
    private readonly material: THREE.Material,
  ) {
    this.transforms = world.soa(Transform);
  }

  get transformStore(): TransformStore {
    return this.transforms;
  }

  get activeRagdolls(): number {
    return this.ragdolls.length;
  }

  spawn(appearance: CharacterAppearance, x: number, y: number, z: number): NpcCharacter {
    const npc = new NpcCharacter(
      this.physics,
      this.env,
      this.world,
      this.clips,
      appearance,
      this.material,
      x,
      y,
      z,
    );
    this.scene.add(npc.view.root);
    this.npcs.push(npc);
    return npc;
  }

  remove(npc: NpcCharacter): void {
    const i = this.npcs.indexOf(npc);
    if (i < 0) return;
    this.npcs.splice(i, 1);
    const r = this.ragdolls.indexOf(npc);
    if (r >= 0) this.ragdolls.splice(r, 1);
    npc.ragdoll?.dispose();
    npc.ragdoll = null;
    for (const listener of this.listeners.removed) listener(npc);
    npc.view.root.removeFromParent();
    npc.motor.dispose();
    this.world.destroyDeferred(npc.entity);
  }

  /** Knocks an NPC over as a ragdoll with the given velocity (within the ragdoll budget). */
  knockDown(npc: NpcCharacter, vx: number, vy: number, vz: number): void {
    if (npc.ragdoll) {
      npc.ragdoll.push(vx, vy, vz);
      return;
    }
    while (this.ragdolls.length >= this.maxRagdolls) this.ragdolls.shift()?.freeze();
    npc.startRagdoll(this.physics, vx, vy, vz);
    this.ragdolls.push(npc);
  }

  /** Removes NPCs farther than `radius` from (x, z) that nobody else manages. */
  cull(x: number, z: number, radius: number): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      if (npc.state === 'seated' || npc.driven) continue;
      const p = npc.motor.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > radius * radius) this.remove(npc);
    }
  }

  createFixedSystem(): FixedSystem {
    return {
      name: 'npcs',
      phase: 'prePhysics',
      fixedUpdate: (ctx): void => {
        for (const npc of this.npcs) npc.step(ctx.dt, this.transforms);
        // Settled ragdolls freeze into a lying pose.
        for (let i = this.ragdolls.length - 1; i >= 0; i--) {
          const npc = this.ragdolls[i];
          if (npc.ragdoll?.settled ?? true) {
            npc.freeze();
            this.ragdolls.splice(i, 1);
          }
        }
      },
    };
  }

  createRenderSystem(): RenderSystem {
    return {
      name: 'npcViews',
      phase: 'animation',
      renderUpdate: (ctx): void => {
        for (const npc of this.npcs) npc.render(ctx, this.transforms);
      },
    };
  }
}
