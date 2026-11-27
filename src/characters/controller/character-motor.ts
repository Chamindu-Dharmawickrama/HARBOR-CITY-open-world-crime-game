import type {
  CharacterCollision,
  Collider,
  KinematicCharacterController,
  RigidBody,
  Vector,
} from '@dimforge/rapier3d-compat';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld, type RayHit } from '../../physics/physics-world';

/** Tuning for on-foot movement (metres, seconds). */
export const MOTOR = {
  walkSpeed: 1.6,
  runSpeed: 4.6,
  sprintSpeed: 7.2,
  crouchSpeed: 1.8,
  swimSpeed: 1.7,
  swimFastSpeed: 2.9,
  groundAccel: 26,
  airAccel: 5,
  waterAccel: 6,
  gravity: 20,
  terminalSpeed: 55,
  jumpSpeed: 6.4,
  turnRate: 11,
  radius: 0.3,
  /** Capsule half-heights of the cylindrical part (standing / crouched). */
  standHalf: 0.6,
  crouchHalf: 0.26,
  stepHeight: 0.42,
  maxSlopeDeg: 46,
  climbMin: 0.45,
  climbMax: 1.85,
  /** Swimmers can pull themselves up quays and piers this far above their feet. */
  swimClimbMax: 4.6,
  /** Feet depth below the water surface while swimming (head stays above water). */
  floatDepth: 1.25,
  /** Skin gap kept between the capsule and the world by the character controller. */
  skin: 0.05,
} as const;

export type MotorMode = 'ground' | 'air' | 'swim' | 'climb' | 'dead';
export type MoveSpeed = 'walk' | 'run' | 'sprint';

export interface MotorCommand {
  /** Desired world-space movement direction × magnitude (0..1) on X and Z. */
  moveX: number;
  moveZ: number;
  speed: MoveSpeed;
  /** Jump/climb pressed this step. */
  jump: boolean;
  /** Crouch toggle pressed this step. */
  crouchToggle: boolean;
  /** When set, the body faces this yaw (strafing while aiming) instead of the move direction. */
  faceYaw: number | null;
}

export interface MotorEnvironment {
  waterLevel: number;
  /** True where the surface at (x, z) is open water (not land, piers or tunnel trenches). */
  isWater(x: number, z: number): boolean;
}

interface ClimbState {
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  t: number;
  duration: number;
}

const CHARACTER_GROUPS = interactionGroups(
  Group.CHARACTER,
  Group.WORLD | Group.PROP | Group.VEHICLE | Group.DEBRIS | Group.CHARACTER,
);
/** What ledge/headroom probes can stand on or bump into. */
const PROBE_GROUPS = interactionGroups(0xffff, Group.WORLD | Group.PROP | Group.VEHICLE);

export function emptyCommand(): MotorCommand {
  return { moveX: 0, moveZ: 0, speed: 'run', jump: false, crouchToggle: false, faceYaw: null };
}

/**
 * Kinematic character physics on top of Rapier's character controller: walking/running with
 * acceleration, autostep, slope limits, ground snapping, jumping, crouching (with headroom check),
 * ledge climbing, surface swimming and falling. Reports landing impacts for fall damage.
 */
export class CharacterMotor {
  readonly body: RigidBody;
  readonly collider: Collider;
  private readonly kcc: KinematicCharacterController;
  mode: MotorMode = 'ground';
  crouched = false;
  grounded = false;
  yaw = 0;
  readonly velocity = { x: 0, y: 0, z: 0 };
  /** Measured horizontal ground speed (m/s) — what the animation should show. */
  speed = 0;
  /** Downward speed at the last landing (m/s) and a counter that increments on each landing. */
  lastImpactSpeed = 0;
  landings = 0;
  /** Increments each time the character enters water. */
  waterEntries = 0;
  /** Climb progress 0..1 while climbing. */
  climbProgress = 0;
  private climb: ClimbState | null = null;
  /** Capsule bottom (body origin); sits `MOTOR.skin` above the ground. */
  private readonly pos = { x: 0, y: 0, z: 0 };
  private readonly feet = { x: 0, y: 0, z: 0 };
  /** Seconds since the controller last reported ground contact. */
  private airTime = 0;
  private readonly desired: Vector = { x: 0, y: 0, z: 0 };
  private readonly moved: Vector = { x: 0, y: 0, z: 0 };
  private readonly hit: RayHit = createRayHit();
  private contact: CharacterCollision | null = null;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly env: MotorEnvironment,
    x: number,
    y: number,
    z: number,
  ) {
    const { rapier, world } = physics;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + MOTOR.skin, z),
    );
    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(MOTOR.standHalf, MOTOR.radius)
        .setTranslation(0, MOTOR.standHalf + MOTOR.radius, 0)
        .setCollisionGroups(CHARACTER_GROUPS),
      this.body,
    );
    this.kcc = world.createCharacterController(MOTOR.skin);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    // Larger normal nudge: avoids single-frame stalls the controller otherwise produces when
    // sliding along flat colliders (measured: 11 → 0 stalled frames per 300 on a box floor).
    this.kcc.setNormalNudgeFactor(0.05);
    this.kcc.setMaxSlopeClimbAngle((MOTOR.maxSlopeDeg * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle(((MOTOR.maxSlopeDeg + 4) * Math.PI) / 180);
    this.kcc.enableAutostep(MOTOR.stepHeight, 0.2, false);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
    this.pos.x = x;
    this.pos.y = y + MOTOR.skin;
    this.pos.z = z;
  }

  /** Feet position on the ground (the capsule floats `MOTOR.skin` above it). */
  get position(): Readonly<{ x: number; y: number; z: number }> {
    this.feet.x = this.pos.x;
    this.feet.y = this.pos.y - MOTOR.skin;
    this.feet.z = this.pos.z;
    return this.feet;
  }

  get height(): number {
    return 2 * ((this.crouched ? MOTOR.crouchHalf : MOTOR.standHalf) + MOTOR.radius);
  }

  teleport(x: number, y: number, z: number): void {
    y += MOTOR.skin;
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.airTime = 0;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.climb = null;
    if (this.mode === 'climb') this.mode = 'air';
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
  }

  /**
   * Scripted locomotion (crowd pedestrians on their sidewalk paths): moves the capsule straight to
   * (x, y, z) facing `yaw` without a character-controller sweep, reporting `speed` for animation.
   */
  placeKinematic(x: number, y: number, z: number, yaw: number, speed: number, dt: number): void {
    const vx = dt > 0 ? (x - this.pos.x) / dt : 0;
    const vz = dt > 0 ? (z - this.pos.z) / dt : 0;
    this.velocity.x = vx;
    this.velocity.y = 0;
    this.velocity.z = vz;
    this.pos.x = x;
    this.pos.y = y + MOTOR.skin;
    this.pos.z = z;
    this.yaw = yaw;
    this.speed += (speed - this.speed) * Math.min(1, dt * 12);
    this.mode = 'ground';
    this.grounded = true;
    this.airTime = 0;
    this.commit();
  }

  kill(): void {
    this.mode = 'dead';
    this.climb = null;
    this.setCrouched(false);
  }

  revive(): void {
    this.mode = 'air';
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.kcc);
    this.physics.removeBody(this.body);
  }

  step(cmd: MotorCommand, dt: number): void {
    if (this.mode === 'climb') {
      this.stepClimb(dt);
      return;
    }
    const dead = this.mode === 'dead';
    const swimming = this.mode === 'swim';

    if (!dead && cmd.crouchToggle && this.grounded) this.setCrouched(!this.crouched);
    if (!dead && cmd.jump) {
      if (this.tryStartClimb(swimming ? MOTOR.swimClimbMax : MOTOR.climbMax, swimming ? 0 : MOTOR.climbMin))
        return;
      if (this.grounded && !this.crouched && !swimming) {
        this.velocity.y = MOTOR.jumpSpeed;
        this.mode = 'air';
        this.grounded = false;
        this.airTime = 0.2;
      }
    }

    // Horizontal intent.
    const mag = dead ? 0 : Math.min(1, Math.hypot(cmd.moveX, cmd.moveZ));
    const target = mag * this.speedFor(cmd.speed, swimming);
    const dirX = mag > 1e-4 ? cmd.moveX / Math.hypot(cmd.moveX, cmd.moveZ) : 0;
    const dirZ = mag > 1e-4 ? cmd.moveZ / Math.hypot(cmd.moveX, cmd.moveZ) : 0;
    if (!dead) {
      const faceTarget = cmd.faceYaw ?? (mag > 0.1 ? Math.atan2(dirX, dirZ) : this.yaw);
      this.yaw = turnToward(this.yaw, faceTarget, MOTOR.turnRate * dt * (cmd.faceYaw !== null ? 2 : 1));
    }
    const accel = swimming ? MOTOR.waterAccel : this.grounded ? MOTOR.groundAccel : MOTOR.airAccel;
    const deadDrag = dead && this.grounded ? 8 : 0;
    this.velocity.x = approachVelocity(this.velocity.x, dirX * target, (accel + deadDrag) * dt);
    this.velocity.z = approachVelocity(this.velocity.z, dirZ * target, (accel + deadDrag) * dt);

    // Vertical.
    if (swimming) {
      const floatY = this.env.waterLevel - MOTOR.floatDepth;
      this.velocity.y = Math.max(-3, Math.min(3, (floatY - this.pos.y) * 4));
    } else {
      this.velocity.y = Math.max(-MOTOR.terminalSpeed, this.velocity.y - MOTOR.gravity * dt);
    }

    // Collide-and-slide through the character controller.
    this.desired.x = this.velocity.x * dt;
    this.desired.y = this.velocity.y * dt;
    this.desired.z = this.velocity.z * dt;
    if (this.mode === 'ground' && this.velocity.y <= 0) this.kcc.enableSnapToGround(0.35);
    else this.kcc.disableSnapToGround();
    this.kcc.computeColliderMovement(
      this.collider,
      this.desired,
      this.physics.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      CHARACTER_GROUPS,
    );
    this.kcc.computedMovement(this.moved);
    const wasGrounded = this.grounded;
    this.grounded = !swimming && this.kcc.computedGrounded();

    if (this.velocity.y > 0 && this.moved.y < this.desired.y - 1e-4) this.velocity.y = 0; // ceiling
    this.pos.x += this.moved.x;
    this.pos.y += this.moved.y;
    this.pos.z += this.moved.z;
    const measured = dt > 0 ? Math.hypot(this.moved.x, this.moved.z) / dt : 0;
    this.speed += (measured - this.speed) * (1 - Math.exp(-20 * dt));
    this.slideAlongWalls();

    if (this.grounded) {
      // A landing needs real airtime; one-frame contact flicker (steps, slopes) is not a landing.
      if (!wasGrounded && this.airTime > 0.15 && (this.mode === 'air' || dead)) {
        this.lastImpactSpeed = Math.max(0, -this.velocity.y);
        this.landings++;
      }
      this.airTime = 0;
      // Zero (not slightly negative) vertical speed on the ground: snap-to-ground follows slopes down,
      // and a constant downward push prevents the controller's autostep from climbing kerbs.
      this.velocity.y = Math.max(this.velocity.y, 0);
      if (this.mode === 'air') this.mode = 'ground';
    } else {
      this.airTime += dt;
      // Brief grace before counting as airborne (walking off kerbs and down steps).
      if (this.mode === 'ground' && (this.airTime > 0.1 || this.velocity.y > 0.5)) this.mode = 'air';
    }

    // Water.
    const inWater = this.env.isWater(this.pos.x, this.pos.z);
    if (!dead && !swimming && inWater && this.pos.y < this.env.waterLevel - MOTOR.floatDepth + 0.15) {
      this.mode = 'swim';
      this.waterEntries++;
      this.velocity.y *= 0.2;
      this.setCrouched(false);
    } else if (swimming && !inWater) {
      this.mode = 'air';
    }

    this.commit();
  }

  /** Removes the velocity component pushing into walls the controller collided with this step. */
  private slideAlongWalls(): void {
    const count = this.kcc.numComputedCollisions();
    for (let i = 0; i < count; i++) {
      const c = this.kcc.computedCollision(i, this.contact ?? undefined);
      if (!c) continue;
      this.contact = c;
      const n = c.normal2;
      if (Math.abs(n.y) > 0.7) continue; // floor or ceiling, handled by grounding
      const len = Math.hypot(n.x, n.z) || 1;
      const nx = n.x / len;
      const nz = n.z / len;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= into * nx;
        this.velocity.z -= into * nz;
      }
    }
  }

  private speedFor(speed: MoveSpeed, swimming: boolean): number {
    if (swimming) return speed === 'sprint' ? MOTOR.swimFastSpeed : MOTOR.swimSpeed;
    if (this.crouched) return MOTOR.crouchSpeed;
    if (speed === 'walk') return MOTOR.walkSpeed;
    return speed === 'sprint' ? MOTOR.sprintSpeed : MOTOR.runSpeed;
  }

  private commit(): void {
    this.body.setNextKinematicTranslation(this.pos);
    const half = this.yaw / 2;
    this.body.setNextKinematicRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
  }

  private setCrouched(crouched: boolean): void {
    if (crouched === this.crouched) return;
    if (!crouched) {
      // Stand up only if there is headroom.
      const top = this.pos.y + 2 * (MOTOR.crouchHalf + MOTOR.radius) - 0.05;
      const needed = 2 * (MOTOR.standHalf - MOTOR.crouchHalf) + 0.1;
      if (this.physics.castRay(this.pos.x, top, this.pos.z, 0, 1, 0, needed, this.hit, PROBE_GROUPS)) return;
    }
    this.crouched = crouched;
    const half = crouched ? MOTOR.crouchHalf : MOTOR.standHalf;
    this.collider.setHalfHeight(half);
    this.collider.setTranslationWrtParent({ x: 0, y: half + MOTOR.radius, z: 0 });
  }

  /** Probes for a climbable ledge in front; starts the climb if one is found. */
  private tryStartClimb(maxHeight: number, minHeight: number): boolean {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const { x, y, z } = this.pos;
    const hit = this.hit;
    const probeY = this.mode === 'swim' ? this.env.waterLevel + 0.2 : y + 0.35;
    // 1) Something in front of us.
    if (!this.physics.castRay(x, probeY, z, fx, 0, fz, MOTOR.radius + 0.9, hit, PROBE_GROUPS)) return false;
    const wallDist = hit.distance;
    // 2) A walkable top within reach, just past the wall face.
    const reach = MOTOR.radius + wallDist + 0.35;
    const sx = x + fx * reach;
    const sz = z + fz * reach;
    const startY = y + maxHeight + 0.4;
    if (!this.physics.castRay(sx, startY, sz, 0, -1, 0, maxHeight + 0.4 - 0.1, hit, PROBE_GROUPS))
      return false;
    if (hit.ny < 0.7) return false;
    const topY = hit.y;
    const h = topY - y;
    if (h < minHeight || h > maxHeight) return false;
    // 3) Room to stand on top, and nothing blocking the way over the edge.
    if (this.physics.castRay(sx, topY + 0.05, sz, 0, 1, 0, 1.75, hit, PROBE_GROUPS)) return false;
    if (this.physics.castRay(x, topY + 1.0, z, fx, 0, fz, reach + 0.2, hit, PROBE_GROUPS)) return false;
    this.climb = {
      fromX: x,
      fromY: y,
      fromZ: z,
      toX: sx,
      toY: topY + 0.02,
      toZ: sz,
      t: 0,
      duration: 0.45 + 0.3 * h + (this.mode === 'swim' ? 0.3 : 0),
    };
    this.mode = 'climb';
    this.climbProgress = 0;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.setCrouched(false);
    return true;
  }

  private stepClimb(dt: number): void {
    const c = this.climb;
    if (!c) {
      this.mode = 'air';
      return;
    }
    c.t = Math.min(1, c.t + dt / c.duration);
    this.climbProgress = c.t;
    // Rise in place (close to the wall) for the first 65%, then step forward onto the ledge.
    const rise = Math.min(1, c.t / 0.65);
    const over = Math.max(0, (c.t - 0.65) / 0.35);
    const easeRise = 1 - (1 - rise) * (1 - rise);
    const easeOver = over * over * (3 - 2 * over);
    this.pos.y = c.fromY + (c.toY - c.fromY) * easeRise;
    this.pos.x = c.fromX + (c.toX - c.fromX) * easeOver;
    this.pos.z = c.fromZ + (c.toZ - c.fromZ) * easeOver;
    this.speed = 0;
    this.commit();
    if (c.t >= 1) {
      this.climb = null;
      this.mode = 'ground';
      this.grounded = true;
      this.velocity.y = 0;
    }
  }
}

function approachVelocity(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

function turnToward(current: number, target: number, maxStep: number): number {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const step = Math.max(-maxStep, Math.min(maxStep, d));
  let next = current + step;
  if (next > Math.PI) next -= Math.PI * 2;
  if (next < -Math.PI) next += Math.PI * 2;
  return next;
}
