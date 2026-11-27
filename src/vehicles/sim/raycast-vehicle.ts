import type { Collider, RigidBody, Rotation, Vector } from '@dimforge/rapier3d-compat';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld, type RayHit } from '../../physics/physics-world';
import {
  absModulate,
  antiRollForce,
  downForce,
  dragForce,
  steeringLimit,
  steerToward,
  suspensionForce,
  tcsThrottle,
} from '../physics/chassis';
import { Drivetrain, RAD_S_TO_RPM, splitAxleTorque } from '../physics/drivetrain';
import { computeTireForces, createTireForces, effectiveMu } from '../physics/tire';
import type { VehicleDef } from '../vehicle-def';
import { emptyControls, type VehicleControls } from './vehicle-controls';
import { createTelemetry, type VehicleSim, type VehicleTelemetry } from './vehicle-sim';

export const GRAVITY = 9.81;
const SUBSTEPS = 4;
/** Below this forward speed the slip ratio uses a fixed denominator (keeps wheel spin stable). */
const SLIP_SPEED_FLOOR = 4;
/** Vehicle hull: collides with everything except hitboxes/triggers. */
export const VEHICLE_GROUPS = interactionGroups(
  Group.VEHICLE,
  Group.WORLD |
    Group.PROP |
    Group.VEHICLE |
    Group.CHARACTER |
    Group.DEBRIS |
    Group.RAGDOLL |
    Group.PROJECTILE,
);
/** Wheels ride on the world and on other vehicles (not on street furniture or people). */
const WHEEL_RAY_GROUPS = interactionGroups(0xffff, Group.WORLD | Group.VEHICLE);

/** Per-wheel state (read by rendering, audio and telemetry). */
export interface WheelState {
  /** Local hardpoint (top of suspension travel). */
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly front: boolean;
  readonly left: boolean;
  readonly driven: boolean;
  grounded: boolean;
  /** Suspension compression (m), its rate (m/s) and the distance from hardpoint to wheel centre. */
  compression: number;
  compressionSpeed: number;
  suspensionLength: number;
  /** Steering angle, radians (+ = left). */
  steer: number;
  /** Spin rate (rad/s) and accumulated rotation (rad) for rendering. */
  omega: number;
  rotation: number;
  /** Normal load (N), slip ratio, slip angle (rad), combined slip, tire forces (N). */
  load: number;
  slipRatio: number;
  slipAngle: number;
  slip: number;
  fx: number;
  fy: number;
  /** Ground normal at the contact (world). */
  nx: number;
  ny: number;
  nz: number;
  /** Detached wheels no longer touch the road. */
  detached: boolean;
  /** Flat tire (lower grip, lower radius) — from damage or spike strips. */
  flat: boolean;
}

const tmpTire = createTireForces();
const axle = { left: 0, right: 0 };

/** Rotates v by quaternion q, writing into out. */
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

function vec(): Vector {
  return { x: 0, y: 0, z: 0 };
}

/**
 * Raycast vehicle on a Rapier rigid body (cars and motorbikes): per-wheel suspension rays,
 * Pacejka-lite tires with combined slip, implicit wheel-spin integration (stable at 60 Hz),
 * engine/gearbox/differential, ABS/TCS, speed-sensitive steering with Ackermann geometry,
 * handbrake drifts, aero drag/downforce, and a lean controller for two-wheelers.
 */
export class RaycastVehicle implements VehicleSim {
  readonly body: RigidBody;
  readonly colliders: Collider[] = [];
  readonly wheels: WheelState[];
  readonly drivetrain: Drivetrain;
  readonly controls: VehicleControls = emptyControls();
  readonly telemetry: VehicleTelemetry = createTelemetry();
  /** The engine runs (hotwired / driven). A stopped engine gives no drive torque. */
  engineOn = false;
  /** Multiplies engine torque (damage reduces it). */
  enginePower = 1;
  /** Steering angle of the front axle (centre), radians. */
  steerAngle = 0;
  /** Two-wheeler visual lean angle (rad, + = left) for the renderer. */
  lean = 0;
  /** When false (rider thrown off, wreck) a two-wheeler is no longer held upright. */
  balanced = true;
  private readonly hit: RayHit = createRayHit();
  private readonly pos = vec();
  private readonly linvel = vec();
  private readonly angvel = vec();
  private readonly up = vec();
  private readonly fwd = vec();
  private readonly left = vec();
  private readonly com = vec();
  private readonly tmp = vec();
  private readonly impulse = vec();
  private readonly point = vec();
  private readonly wheelInertia: number;
  private readonly staticGain: number;
  /** Two-wheelers: smoothed wheelie / stoppie control factors (1 = no intervention). */
  private wheelieCut = 1;
  private tcsFactor = 1;
  private stoppieCut = 1;
  private prevForward = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    readonly def: VehicleDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    const { rapier, world } = physics;
    const half = yaw / 2;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
        .setCcdEnabled(true)
        // No linear damping: air drag and rolling resistance are modelled explicitly.
        .setAngularDamping(def.kind === 'bike' ? 1.2 : 0.4),
    );
    this.createColliders();
    this.drivetrain = new Drivetrain(def.engine, def.gearbox);
    this.wheelInertia = def.kind === 'bike' ? 0.7 : Math.max(1, def.wheelRadius * def.wheelRadius * 12);
    this.staticGain = def.mass / (def.kind === 'bike' ? 2 : 4);
    this.wheels = this.createWheels();
  }

  get speed(): number {
    return this.telemetry.speed;
  }

  /** Hardpoint height so that each axle sits at the road surface under static load. */
  private createWheels(): WheelState[] {
    const d = this.def;
    const s = d.suspension;
    const frontShare = (d.wheelbase / 2 + d.comForward) / d.wheelbase;
    const perFront = d.kind === 'bike' ? 1 : 2;
    const loadFront = (d.mass * GRAVITY * frontShare) / perFront;
    const loadRear = (d.mass * GRAVITY * (1 - frontShare)) / perFront;
    const sagFront = Math.min(s.restLength * 0.8, loadFront / s.stiffnessFront);
    const sagRear = Math.min(s.restLength * 0.8, loadRear / s.stiffnessRear);
    const make = (front: boolean, side: number): WheelState => {
      const sag = front ? sagFront : sagRear;
      const driven =
        d.drive.layout === 'AWD' ||
        (d.drive.layout === 'FWD' && front) ||
        (d.drive.layout === 'RWD' && !front);
      return {
        hx: (side * d.track) / 2,
        hy: d.wheelRadius + s.restLength - sag,
        hz: front ? d.wheelbase / 2 : -d.wheelbase / 2,
        front,
        left: side > 0,
        driven,
        grounded: false,
        compression: sag,
        compressionSpeed: 0,
        suspensionLength: s.restLength - sag,
        steer: 0,
        omega: 0,
        rotation: 0,
        load: 0,
        slipRatio: 0,
        slipAngle: 0,
        slip: 0,
        fx: 0,
        fy: 0,
        nx: 0,
        ny: 1,
        nz: 0,
        detached: false,
        flat: false,
      };
    };
    if (d.kind === 'bike') return [make(true, 0), make(false, 0)];
    return [make(true, 1), make(true, -1), make(false, 1), make(false, -1)];
  }

  /** Hull: a lower body box plus a cabin box; mass properties set explicitly (low CoM). */
  private createColliders(): void {
    const d = this.def;
    const { rapier, world } = this.physics;
    const bodyHeight = Math.max(0.2, (d.height - d.clearance) * (d.style === 'bike' ? 0.75 : 0.5));
    const centreZ = d.length / 2 - (d.rearOverhang + d.wheelbase / 2);
    // Bikes: a slim hull so it never scrapes the road when leaned over.
    const halfWidth = d.style === 'bike' ? Math.min(d.width / 2, 0.16) : d.width / 2;
    const main = rapier.ColliderDesc.cuboid(halfWidth, bodyHeight / 2, d.length / 2)
      .setTranslation(0, d.clearance + bodyHeight / 2, centreZ)
      .setCollisionGroups(VEHICLE_GROUPS)
      .setFriction(0.45)
      .setRestitution(0.05)
      .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(d.mass * 6);
    // Inertia of a solid box, slightly reduced (mass is concentrated low and central).
    const ix = (d.mass / 12) * (d.height * d.height + d.length * d.length) * 0.8;
    const iy = (d.mass / 12) * (d.width * d.width + d.length * d.length) * 0.9;
    const iz = (d.mass / 12) * (d.width * d.width + d.height * d.height) * 0.8;
    // Rapier takes the centre of mass in the COLLIDER's frame: subtract the collider offset.
    const colliderY = d.clearance + bodyHeight / 2;
    main.setMassProperties(
      d.mass,
      { x: 0, y: d.comHeight - colliderY, z: d.comForward - centreZ },
      { x: ix, y: iy, z: iz },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    this.colliders.push(world.createCollider(main, this.body));
    const cabinHeight = d.height - d.clearance - bodyHeight;
    if (cabinHeight > 0.15 && d.style !== 'bike') {
      const cabinLength = cabinLengthFor(d);
      const cabin = rapier.ColliderDesc.cuboid(d.width * 0.42, cabinHeight / 2, cabinLength / 2)
        .setTranslation(0, d.clearance + bodyHeight + cabinHeight / 2, cabinCentreFor(d))
        .setCollisionGroups(VEHICLE_GROUPS)
        .setFriction(0.45)
        .setDensity(0);
      this.colliders.push(world.createCollider(cabin, this.body));
    }
  }

  dispose(): void {
    this.physics.removeBody(this.body);
  }

  /** Advances one fixed step: reads the body state, applies suspension/tire/aero impulses. */
  step(dt: number): void {
    const body = this.body;
    if (body.isSleeping()) {
      if (
        this.controls.throttle === 0 &&
        this.controls.steer === 0 &&
        this.controls.brake >= 0 &&
        !this.engineOn
      )
        return;
      body.wakeUp();
    }
    const d = this.def;
    const rot = body.rotation();
    const t = body.translation();
    this.pos.x = t.x;
    this.pos.y = t.y;
    this.pos.z = t.z;
    const lv = body.linvel();
    const av = body.angvel();
    this.linvel.x = lv.x;
    this.linvel.y = lv.y;
    this.linvel.z = lv.z;
    this.angvel.x = av.x;
    this.angvel.y = av.y;
    this.angvel.z = av.z;
    rotate(rot, 0, 1, 0, this.up);
    rotate(rot, 0, 0, 1, this.fwd);
    rotate(rot, 1, 0, 0, this.left);
    rotate(rot, 0, d.comHeight, d.comForward, this.com);
    this.com.x += this.pos.x;
    this.com.y += this.pos.y;
    this.com.z += this.pos.z;

    const forwardSpeed = this.linvel.x * this.fwd.x + this.linvel.y * this.fwd.y + this.linvel.z * this.fwd.z;
    const speed = Math.hypot(this.linvel.x, this.linvel.y, this.linvel.z);

    // ---- driver intent: forward/reverse logic, steering -----------------------------------------
    const c = this.controls;
    const dt0 = this.drivetrain;
    let drive: number;
    let brake: number;
    if (!dt0.automatic) {
      // Manual box: throttle drives in whatever gear is selected (reverse included).
      drive = c.throttle;
      brake = c.brake;
    } else if (dt0.gear >= 0) {
      drive = c.throttle;
      brake = c.brake;
      // Arcade reverse: holding the brake at a standstill (engine running) engages reverse.
      if (c.allowReverse && this.engineOn && c.brake > 0.1 && c.throttle < 0.1 && speed < 0.8) {
        dt0.shiftTo(-1);
        brake = 0;
      }
      if (dt0.gear === 0) dt0.shiftTo(1);
    } else {
      drive = c.brake;
      brake = c.throttle;
      if (c.throttle > 0.1 && c.brake < 0.1 && speed < 0.8) {
        dt0.shiftTo(1);
        brake = 0;
      }
    }
    if (!this.engineOn) drive = 0;

    const limit = steeringLimit(d.steering, forwardSpeed);
    let target = -c.steer * limit;
    if (d.assists.yawAssist > 0 && speed > 5 && !c.handbrake) {
      // Counter-steer toward the direction of travel when the rear steps out.
      const lateral = this.linvel.x * this.left.x + this.linvel.y * this.left.y + this.linvel.z * this.left.z;
      const drift = Math.atan2(lateral, Math.abs(forwardSpeed));
      // Only the excess over a normal cornering slip angle counts as a slide to catch.
      const excess = Math.sign(drift) * Math.max(0, Math.abs(drift) - 0.12);
      if (excess !== 0) target += Math.max(-limit, Math.min(limit, excess * d.assists.yawAssist * 2));
    }
    this.steerAngle = steerToward(this.steerAngle, target, d.steering, dt);

    // ---- wheels ------------------------------------------------------------------------------------
    const s = d.suspension;
    const rayLength = s.restLength + d.wheelRadius;
    const physics = this.physics;
    let grounded = 0;
    let maxDrivenSlip = 0;
    for (const w of this.wheels) {
      if (w.detached) {
        w.grounded = false;
        continue;
      }
      rotate(rot, w.hx, w.hy, w.hz, this.point);
      const hx = this.point.x + this.pos.x;
      const hy = this.point.y + this.pos.y;
      const hz = this.point.z + this.pos.z;
      const radius = w.flat ? d.wheelRadius * 0.82 : d.wheelRadius;
      // Cars: along the suspension axis. Bikes: straight down (they lean far over), with the
      // distance converted back to the suspension axis.
      const worldDown = d.kind === 'bike';
      const axisScale = worldDown ? Math.max(0.5, this.up.y) : 1;
      const hitGround = worldDown
        ? physics.castRay(hx, hy, hz, 0, -1, 0, rayLength * axisScale, this.hit, WHEEL_RAY_GROUPS, this.body)
        : physics.castRay(
            hx,
            hy,
            hz,
            -this.up.x,
            -this.up.y,
            -this.up.z,
            rayLength,
            this.hit,
            WHEEL_RAY_GROUPS,
            this.body,
          );
      if (worldDown) this.hit.distance /= axisScale;
      const prev = w.compression;
      if (hitGround && this.hit.ny > 0.2) {
        w.grounded = true;
        grounded++;
        w.nx = this.hit.nx;
        w.ny = this.hit.ny;
        w.nz = this.hit.nz;
        w.compression = Math.max(
          0,
          Math.min(s.restLength, rayLength - this.hit.distance - (d.wheelRadius - radius)),
        );
      } else {
        w.grounded = false;
        w.compression = 0;
      }
      w.suspensionLength = s.restLength - w.compression;
      w.compressionSpeed = (w.compression - prev) / dt;
      if (w.driven) maxDrivenSlip = Math.max(maxDrivenSlip, w.slipRatio);
    }
    this.telemetry.groundedWheels = grounded;

    // Engine → wheels.
    // Traction control, smoothed (cuts fast, restores gradually) so it does not chatter.
    const tcsTarget = d.assists.tcs && drive > 0 ? tcsThrottle(1, maxDrivenSlip, speed) : 1;
    this.tcsFactor += (tcsTarget - this.tcsFactor) * Math.min(1, dt * (tcsTarget < this.tcsFactor ? 25 : 6));
    let throttle = drive * this.tcsFactor;
    if (d.kind === 'bike') {
      // Wheelie control: back off the throttle as the front wheel unloads; stoppie control eases
      // the front brake as the rear lifts.
      const front = this.wheels[0];
      const rear = this.wheels[1];
      const staticLoad = (d.mass * GRAVITY) / 2;
      const frontShare = front.grounded
        ? front.compression / Math.max(1e-3, front.compression + rear.compression)
        : 0;
      const rearShare = rear.grounded ? 1 - frontShare : 0;
      const wantWheelie = Math.max(0.1, Math.min(1, (frontShare - 0.03) / 0.1));
      const wantStoppie = Math.max(0.15, Math.min(1, (rearShare - 0.03) / 0.1));
      this.wheelieCut +=
        (wantWheelie - this.wheelieCut) * Math.min(1, dt * (wantWheelie < this.wheelieCut ? 30 : 4));
      this.stoppieCut +=
        (wantStoppie - this.stoppieCut) * Math.min(1, dt * (wantStoppie < this.stoppieCut ? 30 : 4));
      throttle *= this.wheelieCut;
      void staticLoad;
    }
    let drivenOmega = 0;
    let drivenCount = 0;
    for (const w of this.wheels) {
      if (w.driven && !w.detached) {
        drivenOmega += w.omega;
        drivenCount++;
      }
    }
    drivenOmega = drivenCount > 0 ? drivenOmega / drivenCount : 0;
    const totalTorque = dt0.update(drivenOmega, throttle, dt) * this.enginePower;

    // Ackermann: inner wheel turns more than the outer one.
    const ackL = this.ackermann(this.steerAngle, true);
    const ackR = this.ackermann(this.steerAngle, false);

    const bike = d.kind === 'bike';
    const frontAxleTorque =
      d.drive.layout === 'AWD'
        ? totalTorque * d.drive.frontSplit
        : d.drive.layout === 'FWD'
          ? totalTorque
          : 0;
    const rearAxleTorque = totalTorque - frontAxleTorque;
    const brakeFront =
      ((d.brakes.maxTorque * d.brakes.frontBias * brake) / (bike ? 1 : 2)) * (bike ? this.stoppieCut : 1);
    const brakeRear = (d.brakes.maxTorque * (1 - d.brakes.frontBias) * brake) / (bike ? 1 : 2);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.steer = w.front ? (bike ? this.steerAngle : w.left ? ackL : ackR) : 0;
      if (!w.grounded || w.detached) {
        w.load = 0;
        w.fx = 0;
        w.fy = 0;
        w.slip = 0;
        // Free wheel: brakes and drive still act on the spin.
        const freeTorque = this.wheelDriveTorque(w, frontAxleTorque, rearAxleTorque, i);
        w.omega += (freeTorque / this.wheelInertia) * dt;
        w.omega *= Math.exp(-dt * (brake > 0 || (c.handbrake && !w.front) ? 12 : 0.3));
        w.rotation += w.omega * dt;
        continue;
      }
      const front = w.front;
      // Suspension load (with anti-roll from the opposite wheel on the same axle).
      const k = front ? s.stiffnessFront : s.stiffnessRear;
      let load = suspensionForce(w.compression, w.compressionSpeed, k, s.bump, s.rebound, s.travel);
      if (!bike) {
        const other = this.wheels[i ^ 1];
        load += antiRollForce(
          w.compression,
          other.grounded ? other.compression : 0,
          front ? s.antiRollFront : s.antiRollRear,
        );
      }
      load = Math.max(0, load);
      w.load = load;

      // Contact frame on the ground plane.
      rotate(rot, w.hx, w.hy - w.suspensionLength - d.wheelRadius, w.hz, this.point);
      const px = this.point.x + this.pos.x;
      const py = this.point.y + this.pos.y;
      const pz = this.point.z + this.pos.z;
      const nx = w.nx;
      const ny = w.ny;
      const nz = w.nz;
      // Wheel heading: body forward rotated by steer about body up, projected on the ground.
      const cs = Math.cos(w.steer);
      const sn = Math.sin(w.steer);
      let fx = this.fwd.x * cs + this.left.x * sn;
      let fy = this.fwd.y * cs + this.left.y * sn;
      let fz = this.fwd.z * cs + this.left.z * sn;
      const dn = fx * nx + fy * ny + fz * nz;
      fx -= nx * dn;
      fy -= ny * dn;
      fz -= nz * dn;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      // left = n × forward
      const lx = ny * fz - nz * fy;
      const ly = nz * fx - nx * fz;
      const lz = nx * fy - ny * fx;
      // Contact point velocity.
      const rx = px - this.com.x;
      const ry = py - this.com.y;
      const rz = pz - this.com.z;
      const vx = this.linvel.x + (this.angvel.y * rz - this.angvel.z * ry);
      const vy = this.linvel.y + (this.angvel.z * rx - this.angvel.x * rz);
      const vz = this.linvel.z + (this.angvel.x * ry - this.angvel.y * rx);
      const vLong = vx * fx + vy * fy + vz * fz;
      const vLat = vx * lx + vy * ly + vz * lz;
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5));
      w.slipAngle = slipAngle;

      const radius = w.flat ? d.wheelRadius * 0.82 : d.wheelRadius;
      let grip = (front ? d.frontGrip : d.rearGrip) * (w.flat ? 0.45 : 1);
      if (c.handbrake && !front) grip *= 0.62;
      const driveTorque = this.wheelDriveTorque(w, frontAxleTorque, rearAxleTorque, i);
      let brakeTorque = front ? brakeFront : brakeRear;
      if (c.handbrake && !front) brakeTorque += d.brakes.handbrakeTorque;
      if (d.assists.abs && !(c.handbrake && !front) && Math.abs(vLong) > 2.5) {
        // ABS: never ask for more torque than the tire can turn into braking force, then trim on slip.
        const frictionTorque = effectiveMu(d.tire, load) * load * grip * radius * 0.98;
        brakeTorque = absModulate(Math.min(brakeTorque, frictionTorque), w.slipRatio, Math.abs(vLong));
      }
      const rolling = d.aero.rollingResistance * load * radius;

      // Implicit wheel-spin substeps.
      const h = dt / SUBSTEPS;
      const denom = Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR);
      let accFx = 0;
      let accFy = 0;
      let omega = w.omega;
      for (let sub = 0; sub < SUBSTEPS; sub++) {
        const kappa = (omega * radius - vLong) / denom;
        computeTireForces(d.tire, load, kappa, slipAngle, grip, tmpTire);
        const fx0 = tmpTire.fx;
        computeTireForces(d.tire, load, kappa + 1e-3, slipAngle, grip, tmpTire);
        const slope = Math.max(0, (tmpTire.fx - fx0) / 1e-3) * (radius / denom); // dFx/dω
        // Brakes and rolling resistance oppose the spin (or the road speed when the wheel is still).
        const spinSign = Math.abs(omega) > 1e-3 ? Math.sign(omega) : Math.sign(vLong);
        const resist = (brakeTorque + rolling) * spinSign;
        // Implicit step (stable for stiff tires and huge brake torques):
        // ω1 = (ω0 + h/I (T_drive − T_resist − r·Fx0 + r·slope·ω0)) / (1 + h r slope / I)
        const inertia = this.wheelInertia;
        const next =
          (omega + (h / inertia) * (driveTorque - resist - radius * fx0 + radius * slope * omega)) /
          (1 + (h * radius * slope) / inertia);
        // Resistive torque can stop the wheel but never spin it backwards.
        omega =
          spinSign !== 0 && Math.sign(next) !== spinSign && Math.abs(driveTorque) < Math.abs(resist)
            ? 0
            : next;
        const kappa1 = (omega * radius - vLong) / denom;
        computeTireForces(d.tire, load, kappa1, slipAngle, grip, tmpTire);
        accFx += tmpTire.fx;
        accFy += tmpTire.fy;
      }
      w.omega = omega;
      w.rotation += omega * dt;
      w.slipRatio = (omega * radius - vLong) / denom;
      w.slip = tmpTire.slip;
      let tireFx = accFx / SUBSTEPS;
      let tireFy = accFy / SUBSTEPS;

      // Low speed: blend toward a static-friction model so parked/stopped cars do not creep or jitter.
      const blend = Math.min(1, Math.abs(vLong) / 2.5);
      if (blend < 1) {
        const limitF = effectiveMu(d.tire, load) * load * grip;
        const staticLat = Math.max(-limitF, Math.min(limitF, ((-vLat * this.staticGain) / dt) * 0.5));
        tireFy = tireFy * blend + staticLat * (1 - blend);
        if (brakeTorque > 0 && Math.abs(driveTorque) < 1 && Math.abs(vLong) < 1.5) {
          const staticLong = Math.max(-limitF, Math.min(limitF, ((-vLong * this.staticGain) / dt) * 0.5));
          tireFx = tireFx * blend + staticLong * (1 - blend);
          w.omega = 0;
        }
      }
      w.fx = tireFx;
      w.fy = tireFy;

      // Apply: suspension along the contact normal at the contact point; tire forces a little
      // above the ground (a roll centre between road and CoM keeps body roll realistic).
      const rollCentre = d.comHeight * rollCentreFactor(d);
      const ax = px + this.up.x * rollCentre;
      const ay = py + this.up.y * rollCentre;
      const az = pz + this.up.z * rollCentre;
      this.impulse.x = nx * load * dt;
      this.impulse.y = ny * load * dt;
      this.impulse.z = nz * load * dt;
      this.point.x = px;
      this.point.y = py;
      this.point.z = pz;
      // Drive/brake forces at the contact patch (full squat and dive → real traction transfer);
      // side forces at the roll centre.
      this.body.applyImpulseAtPoint(this.impulse, this.point, true);
      this.impulse.x = fx * tireFx * dt;
      this.impulse.y = fy * tireFx * dt;
      this.impulse.z = fz * tireFx * dt;
      this.body.applyImpulseAtPoint(this.impulse, this.point, true);
      this.impulse.x = lx * tireFy * dt;
      this.impulse.y = ly * tireFy * dt;
      this.impulse.z = lz * tireFy * dt;
      this.point.x = ax;
      this.point.y = ay;
      this.point.z = az;
      this.body.applyImpulseAtPoint(this.impulse, this.point, true);
    }

    // ---- aero --------------------------------------------------------------------------------------
    if (speed > 0.5) {
      const drag = dragForce(d.aero, speed) * dt;
      this.impulse.x = (-this.linvel.x / speed) * drag;
      this.impulse.y = (-this.linvel.y / speed) * drag;
      this.impulse.z = (-this.linvel.z / speed) * drag;
      this.body.applyImpulse(this.impulse, true);
      const down = downForce(d.aero, speed) * dt;
      if (down > 0 && grounded > 0) {
        this.impulse.x = -this.up.x * down;
        this.impulse.y = -this.up.y * down;
        this.impulse.z = -this.up.z * down;
        this.body.applyImpulse(this.impulse, true);
      }
    }

    if (bike && this.balanced) this.balance(dt, forwardSpeed, grounded);

    // ---- telemetry ---------------------------------------------------------------------------------
    const tel = this.telemetry;
    tel.speed = speed;
    tel.forwardSpeed = forwardSpeed;
    tel.rpm = dt0.rpm;
    tel.gear = dt0.gear;
    tel.throttle = throttle;
    tel.brake = brake;
    tel.steer = this.steerAngle;
    tel.longitudinalG = (forwardSpeed - this.prevForward) / dt / GRAVITY;
    // Centripetal acceleration = yaw rate × forward speed (+ = toward the left).
    tel.lateralG = (this.angvel.y * forwardSpeed) / GRAVITY;
    this.prevForward = forwardSpeed;
  }

  private wheelDriveTorque(w: WheelState, frontAxle: number, rearAxle: number, index: number): number {
    if (!w.driven || w.detached) return 0;
    const d = this.def;
    const axleTorque = w.front ? frontAxle : rearAxle;
    if (d.kind === 'bike') return axleTorque;
    const leftWheel = this.wheels[index & ~1];
    const rightWheel = this.wheels[(index & ~1) + 1];
    splitAxleTorque(axleTorque, leftWheel.omega, rightWheel.omega, d.drive.limitedSlip, axle);
    return w.left ? axle.left : axle.right;
  }

  private ackermann(angle: number, leftWheel: boolean): number {
    if (Math.abs(angle) < 1e-4) return angle;
    const d = this.def;
    const radius = d.wheelbase / Math.tan(Math.abs(angle));
    // Turning left (angle > 0): the left wheel is on the inside.
    const inside = angle > 0 === leftWheel;
    const r = radius + (inside ? -d.track / 2 : d.track / 2);
    return Math.sign(angle) * Math.atan(d.wheelbase / Math.max(0.5, r));
  }

  /**
   * Two-wheeler balance. The physics body is held upright by a stiff roll controller (a leaning
   * rigid body slides its contact patches sideways and weaves at speed); the lean you see is
   * visual: `lean` follows atan(v·yawRate / g) and is applied by the renderer about the tire
   * contact line. Pitch is damped so hard braking cannot flip the bike.
   */
  private balance(dt: number, forwardSpeed: number, grounded: number): void {
    // Visual only (the body stays upright), so the measured turn rate can drive it safely.
    const yawRate = this.angvel.x * this.up.x + this.angvel.y * this.up.y + this.angvel.z * this.up.z;
    const turn = (forwardSpeed * yawRate) / GRAVITY;
    const visualTarget = grounded > 0 ? Math.max(-0.7, Math.min(0.7, Math.atan(turn))) : 0;
    this.lean += (visualTarget - this.lean) * Math.min(1, dt * 6);
    // Roll of the body (+ = top toward the left) and its rate.
    const roll = -Math.asin(Math.max(-1, Math.min(1, this.left.y)));
    const rollRate = -(this.angvel.x * this.fwd.x + this.angvel.y * this.fwd.y + this.angvel.z * this.fwd.z);
    const pitchRate = this.angvel.x * this.left.x + this.angvel.y * this.left.y + this.angvel.z * this.left.z;
    // Gains well above the gravity toppling stiffness (m·g·h ≈ 1.8 kN·m/rad), close to critical damping.
    const scale = (this.def.mass / 250) * (grounded > 0 ? 1 : 0.35);
    const rollAccel = -roll * 6000 - rollRate * 1500;
    const aboutForward = -rollAccel * scale;
    const aboutLeft = -pitchRate * 600 * scale;
    this.tmp.x = (this.fwd.x * aboutForward + this.left.x * aboutLeft) * dt;
    this.tmp.y = (this.fwd.y * aboutForward + this.left.y * aboutLeft) * dt;
    this.tmp.z = (this.fwd.z * aboutForward + this.left.z * aboutLeft) * dt;
    this.body.applyTorqueImpulse(this.tmp, true);
  }

  /** Engine speed for audio/HUD. */
  get rpm(): number {
    return this.drivetrain.rpm;
  }

  /**
   * Far traffic: the body becomes kinematic and follows poses given by `driveKinematic` (no
   * suspension or tire work, no ground collider needed). `false` hands it back to the simulation.
   */
  kinematic = false;

  setKinematic(on: boolean): void {
    if (on === this.kinematic) return;
    this.kinematic = on;
    const types = this.physics.rapier.RigidBodyType;
    this.body.setBodyType(on ? types.KinematicPositionBased : types.Dynamic, true);
    if (on) {
      this.body.setLinvel(this.zero, false);
      this.body.setAngvel(this.zero, false);
    }
  }

  /**
   * Kinematic mode: moves the body to its next pose (yaw about +Y, then pitch, + = nose up) and
   * keeps the wheels, steering and telemetry looking driven at `speed` m/s.
   */
  driveKinematic(
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    speed: number,
    steer: number,
    dt: number,
  ): void {
    const q = yawPitch(yaw, pitch, this.rotationScratch);
    this.posScratch.x = x;
    this.posScratch.y = y;
    this.posScratch.z = z;
    this.body.setNextKinematicTranslation(this.posScratch);
    this.body.setNextKinematicRotation(q);
    this.steerAngle = steer;
    const d = this.def;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (w.detached) continue;
      w.grounded = true;
      w.compression = this.restCompression[i];
      w.suspensionLength = d.suspension.restLength - w.compression;
      w.steer = w.front ? steer : 0;
      w.omega = speed / d.wheelRadius;
      w.rotation += w.omega * dt;
      w.slip = 0;
    }
    const tel = this.telemetry;
    tel.longitudinalG = (speed - this.prevForward) / Math.max(dt, 1e-3) / GRAVITY;
    tel.speed = Math.abs(speed);
    tel.forwardSpeed = speed;
    tel.groundedWheels = this.wheels.length;
    tel.steer = steer;
    tel.lateralG = 0;
    this.prevForward = speed;
    this.drivetrain.matchGear(speed / d.wheelRadius);
    tel.gear = this.drivetrain.gear;
    tel.rpm = this.drivetrain.rpm;
  }

  /** Leaves kinematic mode moving forward at `speed` from the given pose. */
  resume(x: number, y: number, z: number, yaw: number, pitch: number, speed: number): void {
    this.setKinematic(false);
    this.posScratch.x = x;
    this.posScratch.y = y;
    this.posScratch.z = z;
    this.body.setTranslation(this.posScratch, true);
    this.body.setRotation(yawPitch(yaw, pitch, this.rotationScratch), true);
    const fx = Math.sin(yaw) * Math.cos(pitch);
    const fz = Math.cos(yaw) * Math.cos(pitch);
    this.posScratch.x = fx * speed;
    this.posScratch.y = Math.sin(pitch) * speed;
    this.posScratch.z = fz * speed;
    this.body.setLinvel(this.posScratch, true);
    this.body.setAngvel(this.zero, true);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.omega = speed / this.def.wheelRadius;
      w.compression = this.restCompression[i];
    }
    this.drivetrain.matchGear(speed / this.def.wheelRadius);
    this.prevForward = speed;
  }

  private readonly zero = { x: 0, y: 0, z: 0 };
  private readonly posScratch = { x: 0, y: 0, z: 0 };
  private readonly rotationScratch = { x: 0, y: 0, z: 0, w: 1 };
  /** Static-load suspension compression per wheel (the hardpoints were placed for it). */
  private get restCompression(): number[] {
    if (!this.sag)
      this.sag = this.wheels.map((w) => this.def.wheelRadius + this.def.suspension.restLength - w.hy);
    return this.sag;
  }
  private sag: number[] | null = null;

  /** Teleports the vehicle (spawns, resets) and clears its motion. */
  teleport(x: number, y: number, z: number, yaw: number): void {
    const half = yaw / 2;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.omega = 0;
      w.compression = 0;
    }
    this.drivetrain.shiftTo(1);
    this.steerAngle = 0;
  }

  /** Revolutions per minute of a wheel (telemetry). */
  wheelRpm(index: number): number {
    return ((this.wheels[index]?.omega ?? 0) * RAD_S_TO_RPM) | 0;
  }
}

/** Quaternion for a heading (yaw about +Y, 0 = +Z) and a pitch (+ = nose up). */
export function yawPitch(
  yaw: number,
  pitch: number,
  out: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  // q = q_yaw · q_pitch, with nose-up pitch = rotation about +X by −pitch.
  const hy = yaw / 2;
  const hp = -pitch / 2;
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cp = Math.cos(hp);
  const sp = Math.sin(hp);
  out.x = cy * sp;
  out.y = sy * cp;
  out.z = -sy * sp;
  out.w = cy * cp;
  return out;
}

/**
 * Height of the point where tire side forces act, as a fraction of the CoM height. Tall vehicles
 * use a higher roll centre so they lean but do not tip over in hard manoeuvres.
 */
export function rollCentreFactor(d: VehicleDef): number {
  switch (d.style) {
    case 'bike':
      return 0.9;
    case 'van':
    case 'bus':
    case 'truck':
      return 0.68;
    case 'pickup':
      return 0.58;
    case 'hatch':
    case 'sedan':
    case 'coupe':
    case 'muscle':
    case 'boat':
      return 0.45;
  }
}

/** Cabin length/centre used by the hull collider and the body mesh. */
export function cabinLengthFor(d: VehicleDef): number {
  switch (d.style) {
    case 'van':
    case 'bus':
    case 'truck':
      return d.length * 0.92;
    case 'pickup':
      return d.length * 0.32;
    case 'hatch':
      return d.length * 0.52;
    case 'coupe':
    case 'muscle':
      return d.length * 0.38;
    case 'sedan':
    case 'bike':
    case 'boat':
      return d.length * 0.44;
  }
}

export function cabinCentreFor(d: VehicleDef): number {
  const centre = d.length / 2 - (d.rearOverhang + d.wheelbase / 2);
  switch (d.style) {
    case 'van':
    case 'bus':
    case 'truck':
      return centre;
    case 'pickup':
      return centre + d.length * 0.12;
    case 'hatch':
      return centre - d.length * 0.08;
    case 'sedan':
    case 'coupe':
    case 'muscle':
    case 'bike':
    case 'boat':
      return centre - d.length * 0.05;
  }
}
