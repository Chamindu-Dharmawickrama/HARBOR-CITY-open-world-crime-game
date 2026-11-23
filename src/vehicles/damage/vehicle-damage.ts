import type { RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../../core/events';
import type { Rng } from '../../core/rng';
import type { FixedSystem, RenderContext, RenderSystem } from '../../ecs/scheduler';
import { Group, interactionGroups } from '../../physics/collision-groups';
import type { PhysicsWorld } from '../../physics/physics-world';
import { PARTICLES, type ParticleSystem } from '../../rendering/particles/particle-system';
import { RaycastVehicle } from '../sim/raycast-vehicle';
import type { VehicleInstance, VehicleManager } from '../vehicle-manager';

export const DAMAGE = {
  /** Impacts below this deceleration (m/s², force / mass) do no damage. */
  minAccel: 22,
  /** Engine damage per m/s² above the threshold, as a fraction of durability (per crash). */
  engineRate: 0.0006,
  /** A single crash never takes more than this fraction of durability. */
  maxCrash: 0.4,
  /** Contacts within this window belong to the same crash (only a harder hit adds damage). */
  crashWindow: 0.3,
  /** A dead engine still burns this long before it blows (time to bail out). */
  minFuse: 2.2,
  crackAccel: 70,
  shatterAccel: 170,
  wheelAccel: 260,
  /** Dent radius (m), depth per m/s² over the threshold (m), max total depth (m). */
  dentRadius: 0.75,
  dentRate: 0.0011,
  dentMax: 0.28,
  /** Engine health fractions where smoke and fire start; seconds of fire before it blows. */
  smokeAt: 0.4,
  fireAt: 0.15,
  fuse: 5,
  explosionRadius: 11,
  explosionImpulse: 9,
  /** Chain reaction: engine damage (× durability) to vehicles at the centre of a blast. */
  chainDamage: 1.15,
  looseWheelLifetime: 30,
} as const;

const DEBRIS_GROUPS = interactionGroups(
  Group.DEBRIS,
  Group.WORLD | Group.VEHICLE | Group.DEBRIS | Group.PROP,
);

interface LooseWheel {
  body: RigidBody;
  mesh: THREE.Mesh;
  age: number;
}

interface Dents {
  original: Float32Array;
}

const point = new THREE.Vector3();
const inward = new THREE.Vector3();
const quat = new THREE.Quaternion();
const vec = new THREE.Vector3();

/**
 * Turns contact impulses into vehicle damage: dents (vertices pushed in around the contact,
 * copy-on-write), cracked then shattered glass, wheels torn off, engine damage → smoke → fire →
 * explosion with a radial impulse, chain reactions and a burnt-out wreck.
 */
export class VehicleDamage {
  private readonly pending: { vehicle: VehicleInstance; other: number; collider: number; accel: number }[] =
    [];
  private readonly dents = new Map<VehicleInstance, Dents>();
  /** Per vehicle: strongest hit (m/s²) of the current crash, and seconds left in its window. */
  private readonly crashes = new Map<VehicleInstance, { peak: number; left: number }>();
  private readonly looseWheels: LooseWheel[] = [];
  private readonly flash = new THREE.PointLight(0xffb060, 0, 40, 1.6);
  private flashTime = 0;
  private emitTimer = 0;
  private readonly wheelGeometry: THREE.BufferGeometry;
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  /** Explosions so far (tests / stats). */
  explosions = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly vehicles: VehicleManager,
    private readonly scene: THREE.Scene,
    private readonly smoke: ParticleSystem,
    private readonly glow: ParticleSystem,
    private readonly bus: EventBus<GameEvents>,
    private readonly rng: Rng,
  ) {
    this.wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2);
    scene.add(this.flash);
    physics.onContactForce((h1, h2, magnitude) => {
      const a = vehicles.byCollider(h1);
      const b = vehicles.byCollider(h2);
      if (a) this.pending.push({ vehicle: a, other: h2, collider: h1, accel: magnitude / a.def.mass });
      if (b) this.pending.push({ vehicle: b, other: h1, collider: h2, accel: magnitude / b.def.mass });
    });
    vehicles.listeners.removed.push((v) => {
      this.dents.delete(v);
      this.crashes.delete(v);
    });
  }

  createFixedSystem(): FixedSystem {
    return {
      name: 'vehicleDamage',
      phase: 'postPhysics',
      fixedUpdate: (ctx): void => {
        for (const [v, crash] of this.crashes) {
          crash.left -= ctx.dt;
          if (crash.left <= 0) this.crashes.delete(v);
        }
        for (const hit of this.pending) this.applyImpact(hit.vehicle, hit.collider, hit.other, hit.accel);
        this.pending.length = 0;
        const list = this.vehicles.vehicles;
        for (let i = 0; i < list.length; i++) this.stepEngine(list[i], ctx.dt);
        for (let i = this.looseWheels.length - 1; i >= 0; i--) {
          const w = this.looseWheels[i];
          w.age += ctx.dt;
          if (w.age > DAMAGE.looseWheelLifetime) {
            this.physics.removeBody(w.body);
            w.mesh.removeFromParent();
            this.looseWheels.splice(i, 1);
          }
        }
      },
    };
  }

  /** Render: smoke/fire emitters, loose wheels, explosion light. */
  createRenderSystem(camera: THREE.PerspectiveCamera, viewportHeight: () => number): RenderSystem {
    return {
      name: 'vehicleEffects',
      phase: 'ui',
      renderUpdate: (ctx: RenderContext): void => {
        const dt = ctx.frameSeconds;
        this.emitTimer += dt;
        const emitNow = this.emitTimer > 0.05;
        if (emitNow) this.emitTimer = 0;
        for (const v of this.vehicles.vehicles) {
          const health = v.engineHealth / v.def.durability;
          if (!emitNow || (health > DAMAGE.smokeAt && !v.onFire && !v.wrecked)) continue;
          const root = v.view.root;
          point.set(
            0,
            v.def.height * 0.75,
            v.def.kind === 'boat' ? -v.def.length * 0.4 : v.def.length * 0.32,
          );
          point.applyQuaternion(root.quaternion).add(root.position);
          const j = (): number => this.rng.range(-0.25, 0.25);
          if (v.onFire) {
            this.glow.emit(point.x + j(), point.y, point.z + j(), j(), 0.8, j(), PARTICLES.fire);
            this.glow.emit(point.x + j(), point.y + 0.1, point.z + j(), j(), 1.1, j(), PARTICLES.fire);
            this.smoke.emit(point.x, point.y + 0.6, point.z, j(), 1.5, j(), PARTICLES.blackSmoke);
          } else if (v.wrecked) {
            this.smoke.emit(point.x, point.y, point.z, j(), 0.8, j(), PARTICLES.blackSmoke);
          } else {
            this.smoke.emit(
              point.x + j(),
              point.y,
              point.z + j(),
              j(),
              0.6,
              j(),
              health < DAMAGE.fireAt * 1.8 ? PARTICLES.blackSmoke : PARTICLES.smoke,
            );
          }
        }
        for (const w of this.looseWheels) {
          w.body.translation(vec);
          w.mesh.position.set(vec.x, vec.y, vec.z);
          const r = w.body.rotation();
          w.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        }
        if (this.flashTime > 0) {
          this.flashTime = Math.max(0, this.flashTime - dt);
          this.flash.intensity = 250 * (this.flashTime / 0.5) ** 2;
        }
        this.smoke.update(dt, camera, viewportHeight());
        this.glow.update(dt, camera, viewportHeight());
      },
    };
  }

  /** Damages a vehicle directly (debug command, weapons later). */
  damage(v: VehicleInstance, amount: number): void {
    if (v.wrecked) return;
    v.engineHealth = Math.max(0, v.engineHealth - amount);
    this.bus.emit('vehicle:damaged', { vehicle: v.id, engineHealth: v.engineHealth, amount });
    if (v.engineHealth <= v.def.durability * DAMAGE.fireAt && !v.onFire) this.ignite(v);
  }

  repair(v: VehicleInstance): void {
    v.engineHealth = v.def.durability;
    v.onFire = false;
    v.fireTime = 0;
    v.view.setGlass('intact');
    const dents = this.dents.get(v);
    if (dents) {
      const position = v.view.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      (position.array as Float32Array).set(dents.original);
      position.needsUpdate = true;
    }
    if (v.sim instanceof RaycastVehicle) {
      for (const w of v.sim.wheels) w.detached = false;
      v.sim.balanced = true;
    }
    v.sim.enginePower = 1;
  }

  /** Blows a vehicle up now (debug, chain reactions, weapons). */
  explode(v: VehicleInstance): void {
    if (v.wrecked) return;
    v.wrecked = true;
    v.onFire = true;
    v.fireTime = 0;
    v.engineHealth = 0;
    v.sim.engineOn = false;
    v.sim.enginePower = 0;
    v.siren = false;
    v.view.setBurnt();
    if (v.occupant) {
      v.occupant.seat = null;
      v.occupant = null;
    }
    const t = v.sim.body.translation();
    const cx = t.x;
    const cy = t.y + v.def.height * 0.5;
    const cz = t.z;
    this.explosions++;
    // Fireball, flash, smoke, sparks.
    for (let i = 0; i < 6; i++)
      this.glow.emit(
        cx,
        cy,
        cz,
        this.rng.range(-2, 2),
        this.rng.range(1, 4),
        this.rng.range(-2, 2),
        PARTICLES.fireball,
      );
    this.glow.emit(cx, cy + 0.5, cz, 0, 0, 0, PARTICLES.flash);
    for (let i = 0; i < 40; i++) {
      this.glow.emit(
        cx,
        cy,
        cz,
        this.rng.range(-12, 12),
        this.rng.range(4, 16),
        this.rng.range(-12, 12),
        PARTICLES.spark,
      );
    }
    for (let i = 0; i < 10; i++) {
      this.smoke.emit(
        cx + this.rng.range(-1, 1),
        cy + 1,
        cz + this.rng.range(-1, 1),
        this.rng.range(-1, 1),
        this.rng.range(2, 5),
        this.rng.range(-1, 1),
        PARTICLES.blackSmoke,
      );
    }
    this.flash.position.set(cx, cy + 1.5, cz);
    this.flashTime = 0.5;
    // The wreck jumps and spins.
    const body = v.sim.body;
    body.applyImpulse({ x: 0, y: v.def.mass * 5.5, z: 0 }, true);
    body.applyTorqueImpulse(
      {
        x: v.def.mass * this.rng.range(-1.2, 1.2),
        y: v.def.mass * this.rng.range(-0.6, 0.6),
        z: v.def.mass * this.rng.range(-1.2, 1.2),
      },
      true,
    );
    // Push and damage everything around (chain reactions).
    for (const other of this.vehicles.vehicles) {
      if (other === v) continue;
      const o = other.sim.body.translation();
      const dx = o.x - cx;
      const dy = o.y - cy;
      const dz = o.z - cz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > DAMAGE.explosionRadius) continue;
      const falloff = 1 - dist / DAMAGE.explosionRadius;
      const k = (DAMAGE.explosionImpulse * other.def.mass * falloff) / Math.max(1, dist);
      other.sim.body.applyImpulse(
        { x: dx * k, y: Math.abs(dy) * k + other.def.mass * 3 * falloff, z: dz * k },
        true,
      );
      this.damage(other, other.def.durability * DAMAGE.chainDamage * falloff * falloff);
      if (other.view.glass !== 'shattered' && falloff > 0.3) this.shatter(other);
    }
    this.bus.emit('vehicle:exploded', { vehicle: v.id, x: cx, y: cy, z: cz });
  }

  private ignite(v: VehicleInstance): void {
    v.onFire = true;
    v.fireTime = 0;
    v.sim.enginePower = 0.4;
    this.bus.emit('vehicle:onFire', { vehicle: v.id });
  }

  private stepEngine(v: VehicleInstance, dt: number): void {
    if (!v.onFire) return;
    v.fireTime += dt;
    if (!v.wrecked) {
      v.engineHealth = Math.max(0, v.engineHealth - v.def.durability * 0.02 * dt);
      const fuse = v.engineHealth <= 0 ? DAMAGE.minFuse : DAMAGE.fuse;
      if (v.fireTime >= fuse) this.explode(v);
    } else if (v.fireTime > 9) v.onFire = false;
  }

  private applyImpact(v: VehicleInstance, colliderHandle: number, otherHandle: number, accel: number): void {
    if (accel < DAMAGE.minAccel || v.spawnGrace > 0) return;
    const excess = accel - DAMAGE.minAccel;
    const t = v.sim.body.translation();
    // Contact point from the contact manifold (falls back to the vehicle's front).
    const world = this.physics.world;
    const self = world.getCollider(colliderHandle);
    const other = world.getCollider(otherHandle);
    point.set(t.x, t.y + v.def.height * 0.4, t.z);
    if (self && other) {
      world.contactPair(self, other, (manifold) => {
        if (manifold.numSolverContacts() > 0) {
          const p = manifold.solverContactPoint(0);
          if (p) point.set(p.x, p.y, p.z);
        }
      });
    }
    this.bus.emit('vehicle:impact', {
      vehicle: v.id,
      force: accel * v.def.mass,
      x: point.x,
      y: point.y,
      z: point.z,
    });
    // One crash spans several contact steps: only a harder hit than its peak adds damage.
    const crash = this.crashes.get(v);
    const previous = crash ? crash.peak - DAMAGE.minAccel : 0;
    if (crash) {
      crash.left = DAMAGE.crashWindow;
      if (accel <= crash.peak) return;
      crash.peak = accel;
    } else this.crashes.set(v, { peak: accel, left: DAMAGE.crashWindow });
    const amount =
      Math.min(DAMAGE.maxCrash, DAMAGE.engineRate * excess) -
      Math.min(DAMAGE.maxCrash, DAMAGE.engineRate * previous);
    this.damage(v, v.def.durability * amount);
    if (v.wrecked) return;
    if (accel > DAMAGE.shatterAccel && v.view.glass !== 'shattered') this.shatter(v);
    else if (accel > DAMAGE.crackAccel && v.view.glass === 'intact') v.view.setGlass('cracked');
    this.dent(v, point, excess);
    if (accel > DAMAGE.wheelAccel) this.tearWheel(v, point);
  }

  private shatter(v: VehicleInstance): void {
    v.view.setGlass('shattered');
    const t = v.sim.body.translation();
    for (let i = 0; i < 24; i++) {
      this.smoke.emit(
        t.x + this.rng.range(-0.8, 0.8),
        t.y + v.def.height * 0.75,
        t.z + this.rng.range(-1, 1),
        this.rng.range(-2, 2),
        this.rng.range(0.5, 2.5),
        this.rng.range(-2, 2),
        PARTICLES.glass,
      );
    }
  }

  /** Pushes body vertices near the contact inwards (copy-on-write geometry, depth-capped). */
  private dent(v: VehicleInstance, worldPoint: THREE.Vector3, excess: number): void {
    const depth = Math.min(DAMAGE.dentMax, excess * DAMAGE.dentRate);
    if (depth < 0.004) return;
    const geometry = v.view.ownGeometry();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    let dents = this.dents.get(v);
    if (!dents) {
      dents = { original: array.slice() };
      this.dents.set(v, dents);
    }
    const root = v.view.root;
    quat.copy(root.quaternion).invert();
    point.copy(worldPoint).sub(root.position).applyQuaternion(quat);
    // Push toward the vehicle's centre line at mid height.
    inward.set(-point.x, v.def.height * 0.45 - point.y, -point.z * 0.6).normalize();
    const skin = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    const wheelBones = v.view.model.wheelBones;
    const r = DAMAGE.dentRadius;
    const original = dents.original;
    for (let i = 0; i < position.count; i++) {
      if (wheelBones.includes(skin.getX(i))) continue;
      const o = i * 3;
      const dx = array[o] - point.x;
      const dy = array[o + 1] - point.y;
      const dz = array[o + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r * r) continue;
      const f = 1 - Math.sqrt(d2) / r;
      const push = depth * f * f;
      for (let k = 0; k < 3; k++) {
        const moved = array[o + k] + (k === 0 ? inward.x : k === 1 ? inward.y : inward.z) * push;
        const base = original[o + k];
        array[o + k] = Math.max(base - DAMAGE.dentMax, Math.min(base + DAMAGE.dentMax, moved));
      }
    }
    position.needsUpdate = true;
  }

  /** A huge hit near a wheel tears it off: it becomes a loose physics wheel. */
  private tearWheel(v: VehicleInstance, worldPoint: THREE.Vector3): void {
    if (!(v.sim instanceof RaycastVehicle) || v.def.kind === 'bike') return;
    const sim = v.sim;
    const root = v.view.root;
    quat.copy(root.quaternion).invert();
    point.copy(worldPoint).sub(root.position).applyQuaternion(quat);
    let best = -1;
    let bestD = 0.9;
    sim.wheels.forEach((w, i) => {
      if (w.detached) return;
      const d = Math.hypot(point.x - w.hx, point.z - w.hz);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const wheel = best >= 0 ? sim.wheels[best] : undefined;
    if (!wheel) return;
    wheel.detached = true;
    vec
      .set(wheel.hx, wheel.hy - wheel.suspensionLength, wheel.hz)
      .applyQuaternion(root.quaternion)
      .add(root.position);
    const { rapier, world } = this.physics;
    const lv = sim.body.linvel();
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(vec.x, vec.y, vec.z)
        .setRotation({
          x: root.quaternion.x,
          y: root.quaternion.y,
          z: root.quaternion.z,
          w: root.quaternion.w,
        })
        .setLinvel(lv.x + this.rng.range(-2, 2), lv.y + 3, lv.z + this.rng.range(-2, 2))
        .setAngvel({ x: this.rng.range(-8, 8), y: 0, z: 0 }),
    );
    // Cylinder axis along local X like the wheel.
    world.createCollider(
      rapier.ColliderDesc.cylinder(v.def.wheelWidth / 2, v.def.wheelRadius)
        .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
        .setDensity(120)
        .setCollisionGroups(DEBRIS_GROUPS),
      body,
    );
    const mesh = new THREE.Mesh(this.wheelGeometry, this.wheelMaterial);
    mesh.scale.set(v.def.wheelWidth, v.def.wheelRadius, v.def.wheelRadius);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.looseWheels.push({ body, mesh, age: 0 });
    for (let i = 0; i < 12; i++)
      this.glow.emit(
        vec.x,
        vec.y,
        vec.z,
        this.rng.range(-4, 4),
        this.rng.range(1, 5),
        this.rng.range(-4, 4),
        PARTICLES.spark,
      );
  }

  get looseWheelCount(): number {
    return this.looseWheels.length;
  }
}
