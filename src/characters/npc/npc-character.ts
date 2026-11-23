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
import type { CharacterAppearance } from '../rig/appearance';
import { buildCharacter } from '../rig/character-mesh';
import { CharacterView } from '../rig/character-view';

export type NpcState = 'idle' | 'seated' | 'stumble' | 'flee';

/**
 * A non-player character: motor + skinned view + animator, with a few simple behaviours used by
 * vehicles in M3 (sitting at the wheel, being pulled out, staggering, fleeing). The crowd AI of
 * M4 builds on this.
 */
export class NpcCharacter {
  readonly motor: CharacterMotor;
  readonly view: CharacterView;
  readonly animator: Animator;
  readonly entity: Entity;
  state: NpcState = 'idle';
  /** Seated in / being pulled out of a vehicle. */
  seat: SeatOverride | null = null;
  /** Seconds left in the current behaviour (stumble / flee). */
  timer = 0;
  /** Point to run away from while fleeing. */
  readonly threat = { x: 0, z: 0 };
  readonly pose = new Pose();
  readonly interpolated: PoseOut = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private readonly cmd: MotorCommand = emptyCommand();
  private readonly input = emptyAnimatorInput();

  constructor(
    physics: PhysicsWorld,
    env: MotorEnvironment,
    world: World,
    clips: ClipLibrary,
    appearance: CharacterAppearance,
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

  /** Sits in a vehicle seat (collider off). */
  sit(seat: SeatOverride): void {
    this.seat = seat;
    this.state = 'seated';
    this.motor.collider.setEnabled(false);
  }

  /** Leaves the seat at (x, y, z) facing `yaw`, staggering for a moment, then flees from the threat. */
  ejectAndFlee(x: number, y: number, z: number, yaw: number, threatX: number, threatZ: number): void {
    this.seat = null;
    this.motor.collider.setEnabled(true);
    this.motor.teleport(x, y, z);
    this.motor.yaw = yaw;
    this.threat.x = threatX;
    this.threat.z = threatZ;
    this.state = 'stumble';
    this.timer = 0.9;
    this.animator.flinch(1);
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
    this.timer -= dt;
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
    if (seat) {
      seat.anchor.updateWorldMatrix(true, false);
      local.lerpVectors(seat.door, seat.seat, seat.blend).applyMatrix4(seat.anchor.matrixWorld);
      seat.anchor.getWorldQuaternion(quat);
      this.view.setTransformQuat(local.x, local.y, local.z, quat);
      input.seatedClip = seat.blend > 0.2 ? seat.clip : null;
      input.steer = seat.steer;
    } else {
      interpolatePose(transforms, this.entity, ctx.alpha, this.interpolated);
      const pose = this.interpolated;
      this.view.setTransform(pose.x, pose.y, pose.z, 2 * Math.atan2(pose.qy, pose.qw));
      input.seatedClip = null;
    }
    const motor = this.motor;
    input.mode = seat ? 'ground' : motor.mode;
    input.speed = seat ? 0 : motor.speed;
    input.crouched = false;
    input.verticalSpeed = motor.velocity.y;
    this.animator.update(input, ctx.frameSeconds, this.pose);
    this.view.applyPose(this.pose);
  }
}

const local = new THREE.Vector3();
const quat = new THREE.Quaternion();

/** Owns NPCs: steps and renders them, removes the ones that wandered off. */
export class NpcManager {
  readonly npcs: NpcCharacter[] = [];
  private readonly transforms: TransformStore;

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
    npc.view.root.removeFromParent();
    npc.motor.dispose();
    this.world.destroyDeferred(npc.entity);
  }

  /** Removes idle NPCs farther than `radius` from (x, z). */
  cull(x: number, z: number, radius: number): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      if (npc.state === 'seated') continue;
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
