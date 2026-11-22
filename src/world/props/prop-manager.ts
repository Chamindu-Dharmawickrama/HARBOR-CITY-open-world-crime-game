import type { Collider } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Entity } from '../../ecs/entity';
import type { FixedSystem } from '../../ecs/scheduler';
import { teleport, Transform } from '../../ecs/transform';
import type { World } from '../../ecs/world';
import { GROUPS_DYNAMIC_PROP, GROUPS_STATIC_PROP } from '../../physics/collision-groups';
import type { PhysicsWorld } from '../../physics/physics-world';
import { RigidBodyRef } from '../../physics/rigid-body-sync';
import { RenderObject } from '../../rendering/render-sync';
import type { PropSpec } from '../gen/types';
import { CONTAINER_COLORS, PROP_PHYSICS, propGeometryKey } from './prop-library';

const MAX_DEBRIS = 40;
const DEBRIS_LIFETIME = 45;

interface Debris {
  entity: Entity;
  mesh: THREE.Mesh;
  bornAt: number;
}

/**
 * All street furniture in one BatchedMesh (a single draw call). Instances are culled by
 * distance; static colliders are created per streamed chunk; props hit hard enough are knocked
 * loose and become pooled dynamic debris bodies.
 */
export class PropManager {
  readonly mesh: THREE.BatchedMesh;
  private readonly instanceOf: Int32Array;
  private readonly knocked: Uint8Array;
  private readonly colliders = new Map<number, Collider>();
  private readonly propByHandle = new Map<number, number>();
  private readonly debris: Debris[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private visibleCount = 0;
  private simTime = 0;
  private readonly pendingKnocks: number[] = [];

  constructor(
    private readonly props: readonly PropSpec[],
    private readonly library: Map<string, THREE.BufferGeometry>,
    private readonly material: THREE.Material,
    private readonly physics: PhysicsWorld,
    private readonly world: World,
    private readonly scene: THREE.Scene,
  ) {
    let vertices = 0;
    let indices = 0;
    for (const g of library.values()) {
      vertices += g.getAttribute('position').count;
      indices += g.index?.count ?? 0;
    }
    this.mesh = new THREE.BatchedMesh(Math.max(1, props.length), vertices, indices, material);
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.sortObjects = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'props';
    const geometryIds = new Map<string, number>();
    for (const [key, g] of library) geometryIds.set(key, this.mesh.addGeometry(g));
    this.instanceOf = new Int32Array(props.length).fill(-1);
    this.knocked = new Uint8Array(props.length);
    props.forEach((p, i) => {
      const geometryId = geometryIds.get(propGeometryKey(p.type, p.variant));
      if (geometryId === undefined) return;
      const instance = this.mesh.addInstance(geometryId);
      this.instanceOf[i] = instance;
      this.mesh.setMatrixAt(instance, this.propMatrix(p));
      this.color.setHex(
        p.type === 'container' ? CONTAINER_COLORS[p.variant % CONTAINER_COLORS.length] : 0xffffff,
      );
      this.mesh.setColorAt(instance, this.color);
      this.mesh.setVisibleAt(instance, false);
    });
    scene.add(this.mesh);
  }

  get stats(): { visible: number; knocked: number; debris: number; colliders: number } {
    let knocked = 0;
    for (let i = 0; i < this.knocked.length; i++) knocked += this.knocked[i];
    return {
      visible: this.visibleCount,
      knocked,
      debris: this.debris.length,
      colliders: this.colliders.size,
    };
  }

  /** Shows props within `radius` of (x, z); hides the rest. */
  updateVisibility(x: number, z: number, radius: number): void {
    const r2 = radius * radius;
    let visible = 0;
    for (let i = 0; i < this.props.length; i++) {
      const instance = this.instanceOf[i];
      if (instance < 0) continue;
      const p = this.props[i];
      const dx = p.x - x;
      const dz = p.z - z;
      const show = this.knocked[i] === 0 && dx * dx + dz * dz < r2 * (p.type === 'crane' ? 6 : 1);
      this.mesh.setVisibleAt(instance, show);
      if (show) visible++;
    }
    this.visibleCount = visible;
  }

  addColliders(propIds: readonly number[]): void {
    const rapier = this.physics.rapier;
    for (const id of propIds) {
      if (this.colliders.has(id) || this.knocked[id] === 1) continue;
      const p = this.props[id];
      const spec = PROP_PHYSICS[p.type];
      if (!spec) continue;
      this.quat.setFromAxisAngle(this.up, p.rotY);
      const desc = rapier.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2])
        .setTranslation(p.x, p.y + spec.centerY, p.z)
        .setRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w })
        .setCollisionGroups(GROUPS_STATIC_PROP);
      if (Number.isFinite(spec.knockForce)) {
        desc
          .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(spec.knockForce);
      }
      const collider = this.physics.world.createCollider(desc);
      this.colliders.set(id, collider);
      this.propByHandle.set(collider.handle, id);
    }
  }

  removeColliders(propIds: readonly number[]): void {
    for (const id of propIds) {
      const collider = this.colliders.get(id);
      if (!collider) continue;
      this.propByHandle.delete(collider.handle);
      this.physics.removeCollider(collider);
      this.colliders.delete(id);
    }
  }

  /** Converts a prop into a loose dynamic body. Returns false if it cannot be knocked. */
  knock(id: number): boolean {
    const p = this.props[id];
    if (!p || this.knocked[id] === 1) return false;
    const spec = PROP_PHYSICS[p.type];
    const geometry = this.library.get(propGeometryKey(p.type, p.variant));
    if (!spec || !Number.isFinite(spec.knockForce) || !geometry) return false;
    this.knocked[id] = 1;
    this.removeColliders([id]);
    const instance = this.instanceOf[id];
    if (instance >= 0) this.mesh.setVisibleAt(instance, false);
    if (this.debris.length >= MAX_DEBRIS) this.despawn(this.debris.shift() as Debris);

    this.quat.setFromAxisAngle(this.up, p.rotY);
    const body = this.physics.world.createRigidBody(
      this.physics.rapier.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + 0.02, p.z)
        .setRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w })
        .setCcdEnabled(true),
    );
    const volume = 8 * spec.half[0] * spec.half[1] * spec.half[2];
    this.physics.world.createCollider(
      this.physics.rapier.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2])
        .setTranslation(0, spec.centerY, 0)
        .setDensity(spec.mass / Math.max(1e-3, volume))
        .setFriction(0.8)
        .setCollisionGroups(GROUPS_DYNAMIC_PROP),
      body,
    );
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    const entity = this.world.create();
    this.world.add(entity, Transform);
    teleport(
      this.world.soa(Transform),
      entity,
      p.x,
      p.y + 0.02,
      p.z,
      this.quat.x,
      this.quat.y,
      this.quat.z,
      this.quat.w,
    );
    this.world.set(entity, RigidBodyRef, body);
    this.world.set(entity, RenderObject, mesh);
    this.debris.push({ entity, mesh, bornAt: this.simTime });
    return true;
  }

  /** Drains contact forces after the physics step and knocks props that were hit hard enough. */
  createSystem(): FixedSystem {
    return {
      name: 'propKnock',
      phase: 'postPhysics',
      fixedUpdate: (ctx): void => {
        this.simTime = ctx.time;
        this.physics.drainContactForces((h1, h2, magnitude) => {
          const id = this.propByHandle.get(h1) ?? this.propByHandle.get(h2);
          if (id === undefined) return;
          const spec = PROP_PHYSICS[this.props[id].type];
          if (spec && magnitude >= spec.knockForce) this.pendingKnocks.push(id);
        });
        while (this.pendingKnocks.length > 0) this.knock(this.pendingKnocks.pop() as number);
        while (this.debris.length > 0 && ctx.time - this.debris[0].bornAt > DEBRIS_LIFETIME) {
          this.despawn(this.debris.shift() as Debris);
        }
      },
    };
  }

  /** Nearest knockable prop within `radius` of (x, z) (used by tests and the dev console). */
  nearestKnockable(x: number, z: number, radius: number): number {
    let best = -1;
    let bestD = radius * radius;
    this.props.forEach((p, i) => {
      if (this.knocked[i] === 1 || !Number.isFinite(PROP_PHYSICS[p.type]?.knockForce ?? Infinity)) return;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  isKnocked(id: number): boolean {
    return this.knocked[id] === 1;
  }

  hasCollider(id: number): boolean {
    return this.colliders.has(id);
  }

  private despawn(d: Debris): void {
    const body = this.world.get(d.entity, RigidBodyRef);
    if (body) this.physics.removeBody(body);
    this.world.destroy(d.entity);
    this.scene.remove(d.mesh);
  }

  private propMatrix(p: PropSpec): THREE.Matrix4 {
    this.quat.setFromAxisAngle(this.up, p.rotY);
    this.pos.set(p.x, p.y, p.z);
    return this.matrix.compose(this.pos, this.quat, this.one);
  }
}
