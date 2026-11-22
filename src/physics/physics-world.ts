import type { Collider, RigidBody, World as RapierWorld, Ray } from '@dimforge/rapier3d-compat';
import { FIXED_STEP_SECONDS } from '../core/loop';
import { GROUPS_DYNAMIC_PROP, GROUPS_STATIC_WORLD } from './collision-groups';
import type { Rapier } from './rapier';

export interface RayHit {
  hit: boolean;
  distance: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  collider: Collider | null;
}

export function createRayHit(): RayHit {
  return { hit: false, distance: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, collider: null };
}

export interface BoxBodyOptions {
  halfExtents: readonly [number, number, number];
  position: readonly [number, number, number];
  rotation?: readonly [number, number, number, number];
  density?: number;
  friction?: number;
  restitution?: number;
  groups?: number;
  linearVelocity?: readonly [number, number, number];
  ccd?: boolean;
}

/** Thin wrapper around a Rapier world: fixed timestep, body helpers, allocation-free ray casts. */
export class PhysicsWorld {
  readonly world: RapierWorld;
  private readonly ray: Ray;

  constructor(
    readonly rapier: Rapier,
    gravityY = -9.81,
    readonly stepSeconds = FIXED_STEP_SECONDS,
  ) {
    this.world = new rapier.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = stepSeconds;
    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  step(): void {
    this.world.step();
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }

  get colliderCount(): number {
    return this.world.colliders.len();
  }

  /** Dynamic bodies that are currently simulated (not asleep). O(n): call at UI rate, not per tick. */
  countAwakeDynamic(): number {
    let n = 0;
    this.world.bodies.forEach((body) => {
      if (body.isDynamic() && !body.isSleeping()) n++;
    });
    return n;
  }

  createFixedBox(options: BoxBodyOptions): Collider {
    const { rapier } = this;
    const [hx, hy, hz] = options.halfExtents;
    const [x, y, z] = options.position;
    const desc = rapier.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(options.friction ?? 0.8)
      .setRestitution(options.restitution ?? 0)
      .setCollisionGroups(options.groups ?? GROUPS_STATIC_WORLD);
    if (options.rotation) {
      const [qx, qy, qz, qw] = options.rotation;
      desc.setRotation({ x: qx, y: qy, z: qz, w: qw });
    }
    return this.world.createCollider(desc);
  }

  createDynamicBox(options: BoxBodyOptions): RigidBody {
    const { rapier } = this;
    const [x, y, z] = options.position;
    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setCcdEnabled(options.ccd ?? false);
    if (options.rotation) {
      const [qx, qy, qz, qw] = options.rotation;
      bodyDesc.setRotation({ x: qx, y: qy, z: qz, w: qw });
    }
    if (options.linearVelocity) {
      const [vx, vy, vz] = options.linearVelocity;
      bodyDesc.setLinvel(vx, vy, vz);
    }
    const body = this.world.createRigidBody(bodyDesc);
    const [hx, hy, hz] = options.halfExtents;
    const colliderDesc = rapier.ColliderDesc.cuboid(hx, hy, hz)
      .setDensity(options.density ?? 400)
      .setFriction(options.friction ?? 0.7)
      .setRestitution(options.restitution ?? 0.05)
      .setCollisionGroups(options.groups ?? GROUPS_DYNAMIC_PROP);
    this.world.createCollider(colliderDesc, body);
    return body;
  }

  removeBody(body: RigidBody): void {
    this.world.removeRigidBody(body);
  }

  removeCollider(collider: Collider): void {
    this.world.removeCollider(collider, false);
  }

  /**
   * Casts a ray (direction need not be normalised; distance is along the normalised direction).
   * Writes into `out` and returns `out.hit`.
   */
  castRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: RayHit,
    groups?: number,
    excludeBody?: RigidBody,
  ): boolean {
    const len = Math.hypot(dx, dy, dz);
    out.hit = false;
    out.collider = null;
    if (len === 0) return false;
    const ray = this.ray;
    ray.origin.x = ox;
    ray.origin.y = oy;
    ray.origin.z = oz;
    ray.dir.x = dx / len;
    ray.dir.y = dy / len;
    ray.dir.z = dz / len;
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      groups,
      undefined,
      excludeBody,
    );
    if (!hit) return false;
    out.hit = true;
    out.distance = hit.timeOfImpact;
    out.x = ox + ray.dir.x * hit.timeOfImpact;
    out.y = oy + ray.dir.y * hit.timeOfImpact;
    out.z = oz + ray.dir.z * hit.timeOfImpact;
    out.nx = hit.normal.x;
    out.ny = hit.normal.y;
    out.nz = hit.normal.z;
    out.collider = hit.collider;
    return true;
  }

  /** Line-segment buffers of every collider (for the physics debug view). */
  debugBuffers(): { vertices: Float32Array; colors: Float32Array } {
    return this.world.debugRender();
  }

  dispose(): void {
    this.world.free();
  }
}
