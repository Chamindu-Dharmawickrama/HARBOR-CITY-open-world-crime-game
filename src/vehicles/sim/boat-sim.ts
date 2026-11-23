import type { Collider, RigidBody, Rotation, Vector } from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../../physics/physics-world';
import type { BoatSpec, VehicleDef } from '../vehicle-def';
import { VEHICLE_GROUPS } from './raycast-vehicle';
import { emptyControls, type VehicleControls } from './vehicle-controls';
import { createTelemetry, type VehicleSim, type VehicleTelemetry, type WaterQuery } from './vehicle-sim';

const GRAVITY = 9.81;
/** Buoyancy samples across the hull bottom (fractions of half-length, half-width). */
const SAMPLES: readonly (readonly [number, number])[] = [
  [0.75, 0.7],
  [0.75, -0.7],
  [0, 0.85],
  [0, -0.85],
  [-0.75, 0.85],
  [-0.75, -0.85],
];
const MAX_DEPTH = 1.2;

function rotate(q: Rotation, x: number, y: number, z: number, out: Vector): Vector {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Boat on a Rapier body: per-sample buoyancy springs with damping against the water level,
 * stern thrust (only when the propeller is in the water), a rudder whose side force grows with
 * speed and prop wash, and quadratic hull drag that is much higher sideways than along the keel.
 */
export class BoatSim implements VehicleSim {
  readonly body: RigidBody;
  readonly colliders: Collider[] = [];
  readonly controls: VehicleControls = emptyControls();
  readonly telemetry: VehicleTelemetry = createTelemetry();
  engineOn = false;
  enginePower = 1;
  /** Fraction of buoyancy samples in the water (0 = beached / airborne). */
  submerged = 0;
  private readonly spec: BoatSpec;
  private readonly pos: Vector = { x: 0, y: 0, z: 0 };
  private readonly point: Vector = { x: 0, y: 0, z: 0 };
  private readonly fwd: Vector = { x: 0, y: 0, z: 0 };
  private readonly left: Vector = { x: 0, y: 0, z: 0 };
  private readonly impulse: Vector = { x: 0, y: 0, z: 0 };
  private rpm = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    readonly def: VehicleDef,
    private readonly water: WaterQuery,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    if (!def.boat) throw new Error(`BoatSim: ${def.id} has no boat spec`);
    this.spec = def.boat;
    const { rapier, world } = physics;
    const half = yaw / 2;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
        .setCcdEnabled(true)
        .setAngularDamping(1.6)
        .setLinearDamping(0.05),
    );
    const hullHeight = def.height * 0.55;
    const hull = rapier.ColliderDesc.cuboid(def.width / 2, hullHeight / 2, def.length / 2)
      .setTranslation(0, hullHeight / 2, 0)
      .setCollisionGroups(VEHICLE_GROUPS)
      .setFriction(0.3)
      .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(def.mass * 6);
    const m = def.mass;
    hull.setMassProperties(
      m,
      { x: 0, y: def.comHeight - hullHeight / 2, z: def.comForward },
      {
        x: (m / 12) * (hullHeight ** 2 + def.length ** 2),
        y: (m / 12) * (def.width ** 2 + def.length ** 2),
        z: (m / 12) * (def.width ** 2 + hullHeight ** 2),
      },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    this.colliders.push(world.createCollider(hull, this.body));
  }

  get speed(): number {
    return this.telemetry.speed;
  }

  step(dt: number): void {
    const body = this.body;
    const d = this.def;
    const spec = this.spec;
    if (body.isSleeping() && !this.engineOn) return;
    const rot = body.rotation();
    const t = body.translation();
    this.pos.x = t.x;
    this.pos.y = t.y;
    this.pos.z = t.z;
    const lv = body.linvel();
    const av = body.angvel();
    rotate(rot, 0, 0, 1, this.fwd);
    rotate(rot, 1, 0, 0, this.left);
    const waterLevel = this.water.waterLevel;
    const inWater = this.water.isWater(t.x, t.z);

    // Buoyancy: a damped spring per sample point.
    let wet = 0;
    for (const [fz, fx] of SAMPLES) {
      rotate(rot, (fx * d.width) / 2, 0.05, (fz * d.length) / 2, this.point);
      const px = this.point.x + t.x;
      const py = this.point.y + t.y;
      const pz = this.point.z + t.z;
      const depth = waterLevel - py;
      if (depth <= 0 || !inWater) continue;
      wet++;
      // Vertical velocity of the sample point: v + ω × r
      const vy = lv.y + (av.z * this.point.x - av.x * this.point.z);
      const force = spec.buoyancy * Math.min(depth, MAX_DEPTH) - spec.buoyancyDamping * vy;
      this.impulse.x = 0;
      this.impulse.y = Math.max(0, force) * dt;
      this.impulse.z = 0;
      this.point.x = px;
      this.point.y = py;
      this.point.z = pz;
      body.applyImpulseAtPoint(this.impulse, this.point, true);
    }
    this.submerged = wet / SAMPLES.length;

    // Horizontal heading and speeds.
    const hl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const hx = this.fwd.x / hl;
    const hz = this.fwd.z / hl;
    const lx = hz;
    const lz = -hx;
    const vLong = lv.x * hx + lv.z * hz;
    const vLat = lv.x * lx + lv.z * lz;
    const c = this.controls;
    const throttle = this.engineOn ? c.throttle * this.enginePower : 0;
    const reverse = this.engineOn ? c.brake * this.enginePower : 0;

    if (this.submerged > 0) {
      const wetness = this.submerged;
      // Stern: thrust and rudder act there (if the propeller is under water).
      rotate(rot, 0, 0.05, -d.length / 2 + 0.3, this.point);
      const sx = this.point.x + t.x;
      const sy = this.point.y + t.y;
      const sz = this.point.z + t.z;
      const propWet = sy < waterLevel + 0.15;
      const thrust = propWet ? throttle * spec.thrust - reverse * spec.reverseThrust : 0;
      // Rudder: steer right (+) pushes the stern left so the bow swings right.
      const rudder = c.steer * (spec.rudder * vLong * Math.abs(vLong) + Math.abs(thrust) * 0.2);
      this.impulse.x = (hx * thrust + lx * rudder) * dt;
      this.impulse.y = 0;
      this.impulse.z = (hz * thrust + lz * rudder) * dt;
      this.point.x = sx;
      this.point.y = Math.min(sy, waterLevel);
      this.point.z = sz;
      body.applyImpulseAtPoint(this.impulse, this.point, true);
      // Hull drag: quadratic along and (much higher) across the keel, plus a little linear term.
      const dragLong = -(spec.dragForward * vLong * Math.abs(vLong) + spec.dragForward * 4 * vLong) * wetness;
      const dragLat = -(spec.dragSideways * vLat * Math.abs(vLat) + spec.dragSideways * 2 * vLat) * wetness;
      this.impulse.x = (hx * dragLong + lx * dragLat) * dt;
      this.impulse.y = 0;
      this.impulse.z = (hz * dragLong + lz * dragLat) * dt;
      body.applyImpulse(this.impulse, true);
    }

    // Telemetry (engine note follows throttle and speed).
    const targetRpm = 900 + 4800 * Math.max(throttle, reverse, Math.min(1, Math.abs(vLong) / 25));
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 3);
    const tel = this.telemetry;
    tel.speed = Math.hypot(lv.x, lv.y, lv.z);
    tel.forwardSpeed = vLong;
    tel.rpm = this.engineOn ? this.rpm : 0;
    tel.gear = reverse > 0 && throttle === 0 ? -1 : 1;
    tel.throttle = throttle;
    tel.brake = reverse;
    tel.steer = c.steer;
    tel.lateralG = (av.y * vLong) / GRAVITY;
    tel.groundedWheels = 0;
  }

  teleport(x: number, y: number, z: number, yaw: number): void {
    const half = yaw / 2;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  dispose(): void {
    this.physics.removeBody(this.body);
  }
}
