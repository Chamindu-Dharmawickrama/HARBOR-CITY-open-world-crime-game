import * as THREE from 'three';
import type { PlayerCharacter } from '../../characters/player/player-character';
import type {
  PlayerCameraSystem,
  PlayerPresentation,
  SeatOverride,
} from '../../characters/player/player-systems';
import type { EventBus, GameEvents } from '../../core/events';
import type { Vec2Out } from '../../core/input/deadzone';
import type { InputSystem } from '../../core/input/input-system';
import type { FixedContext, RenderContext } from '../../ecs/scheduler';
import { Group, interactionGroups } from '../../physics/collision-groups';
import type { PhysicsWorld } from '../../physics/physics-world';
import { ChaseCamera, type ChaseTarget } from '../../rendering/camera/chase-camera';
import type { CameraCollision } from '../../rendering/camera/orbit-camera';
import { RaycastVehicle } from '../sim/raycast-vehicle';
import type { VehicleInstance, VehicleManager } from '../vehicle-manager';

export type DrivePhase =
  'foot' | 'approach' | 'smash' | 'opening' | 'jackPull' | 'entering' | 'hotwire' | 'driving' | 'exiting';

export const DRIVE = {
  /** How close a vehicle must be to be entered (to its centre / to a boat's hull). */
  enterRange: 6,
  /** Close enough to the door to start getting in. */
  doorReach: 0.55,
  approachTimeout: 3.5,
  openTime: 0.35,
  enterTime: 0.55,
  exitTime: 0.5,
  jackTime: 0.6,
  smashTime: 0.5,
  hotwireTime: 2.5,
  /** Above this speed (m/s) getting out means bailing out. */
  bailSpeed: 4,
  /** Impact force (N per kg of bike) that throws a rider off a motorbike. */
  bikeThrowForce: 120,
} as const;

const EXIT_GROUPS = interactionGroups(0xffff, Group.WORLD | Group.VEHICLE | Group.PROP);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/**
 * The player and vehicles: walk to the door, smash a locked car's window, pull an NPC driver
 * out, climb in, hotwire, drive (inputs → vehicle controls), and get out — or bail out at speed /
 * get thrown off a bike. Owns the chase camera while driving.
 */
export class PlayerVehicleController {
  phase: DrivePhase = 'foot';
  vehicle: VehicleInstance | null = null;
  /** Door index being used (−1 for bikes/boats). */
  door = -1;
  timer = 0;
  /** 0..1 while hotwiring (HUD progress bar). */
  hotwire = 0;
  private needsHotwire = false;
  private jacking = false;
  readonly chase: ChaseCamera;
  private readonly seat: SeatOverride = {
    anchor: new THREE.Object3D(),
    seat: new THREE.Vector3(),
    door: new THREE.Vector3(),
    blend: 0,
    clip: 'sitDrive',
    steer: 0,
    hidden: false,
  };
  private readonly look: Vec2Out = { x: 0, y: 0 };
  private readonly target: ChaseTarget = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    speed: 0,
    length: 4,
    height: 1.5,
    eye: new THREE.Vector3(),
  };
  /** Entered vehicles count (stats/tests). */
  entries = 0;
  /** Manual gearbox for cars and bikes the player drives (E/Q shift). */
  manualGearbox = false;

  constructor(
    private readonly player: PlayerCharacter,
    private readonly presentation: PlayerPresentation,
    private readonly onFootCamera: PlayerCameraSystem,
    private readonly vehicles: VehicleManager,
    private readonly physics: PhysicsWorld,
    private readonly input: InputSystem,
    private readonly bus: EventBus<GameEvents>,
    camera: THREE.PerspectiveCamera,
    private readonly collision: CameraCollision,
  ) {
    this.chase = new ChaseCamera(camera, collision);
    bus.on('vehicle:impact', ({ vehicle, force }) => this.onImpact(vehicle, force));
    vehicles.listeners.removed.push((v) => {
      if (v === this.vehicle) this.leave(false, true);
    });
  }

  private seatedPhase(): boolean {
    return (
      this.phase === 'entering' ||
      this.phase === 'hotwire' ||
      this.phase === 'driving' ||
      this.phase === 'exiting'
    );
  }

  get driving(): boolean {
    return this.phase === 'driving' || this.phase === 'hotwire';
  }

  /** Inside or getting in/out: the on-foot controls and camera are off. */
  get busy(): boolean {
    return this.phase !== 'foot';
  }

  /** Puts the player straight into the driver's seat (spawn commands, tests of driving). */
  enterImmediately(v: VehicleInstance): void {
    if (this.vehicle) this.leave(false, true);
    this.vehicle = v;
    this.door = v.view.model.doors.length > 0 ? 0 : -1;
    this.prepareSeat(v);
    this.seat.blend = 1;
    this.player.sit();
    this.presentation.seat = this.seat;
    v.driver = 'player';
    v.persistent = true;
    v.sim.engineOn = !v.wrecked;
    this.phase = 'driving';
    this.beginDriving(false);
  }

  fixedUpdate(ctx: FixedContext): void {
    const dt = ctx.dt;
    const player = this.player;
    const input = this.input;
    if (player.dead && this.vehicle) {
      this.leave(false, true);
      return;
    }
    // Moved out of the seat by something else (a teleport): let go of the vehicle.
    if (this.vehicle && !player.seated && this.seatedPhase()) {
      this.leave(false, true);
      return;
    }
    switch (this.phase) {
      case 'foot':
        if (input.pressed('interact') && player.alive && !player.placing && player.controlsEnabled)
          this.tryStart();
        return;
      case 'approach':
        this.stepApproach(dt);
        return;
      case 'smash':
        this.timer -= dt;
        if (this.timer <= 0) {
          const v = this.current();
          v.view.setGlass('cracked');
          const p = v.sim.body.translation();
          this.bus.emit('vehicle:windowSmashed', { vehicle: v.id, x: p.x, y: p.y + 1, z: p.z });
          this.needsHotwire = true;
          v.locked = false;
          this.openDoor();
        }
        return;
      case 'opening':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.jacking && this.current().occupant) {
            this.phase = 'jackPull';
            this.timer = DRIVE.jackTime;
          } else this.startEntering();
        }
        return;
      case 'jackPull': {
        const v = this.current();
        const npc = v.occupant;
        this.timer -= dt;
        if (npc?.seat) npc.seat.blend = Math.max(0, this.timer / DRIVE.jackTime);
        if (this.timer <= 0) {
          if (npc) {
            const at = this.doorWorld(v, 0.9);
            const p = player.motor.position;
            npc.ejectAndFlee(at.x, at.y + 0.05, at.z, Math.atan2(at.x - p.x, at.z - p.z), p.x, p.z);
            v.occupant = null;
          }
          this.startEntering();
        }
        return;
      }
      case 'entering':
        this.seat.blend = Math.min(1, this.seat.blend + dt / DRIVE.enterTime);
        this.keepPlayerAtSeat();
        if (this.seat.blend >= 1) {
          this.closeDoor();
          const v = this.current();
          v.driver = 'player';
          v.persistent = true;
          if (this.needsHotwire && !v.sim.engineOn) {
            this.phase = 'hotwire';
            this.hotwire = 0;
          } else {
            v.sim.engineOn = !v.wrecked;
            this.phase = 'driving';
          }
          this.beginDriving(this.jacking);
        }
        return;
      case 'hotwire': {
        this.keepPlayerAtSeat();
        const v = this.current();
        this.hotwire = Math.min(1, this.hotwire + dt / DRIVE.hotwireTime);
        if (this.hotwire >= 1) {
          v.sim.engineOn = !v.wrecked;
          this.phase = 'driving';
          this.bus.emit('vehicle:hotwired', { vehicle: v.id });
        }
        if (input.pressed('interact')) this.startExit();
        return;
      }
      case 'driving':
        this.stepDriving();
        return;
      case 'exiting':
        this.seat.blend = Math.max(0, this.seat.blend - dt / DRIVE.exitTime);
        this.keepPlayerAtSeat();
        if (this.seat.blend <= 0) this.leave(false, false);
        return;
    }
  }

  /** Render: chase camera, steering hands, interior visibility. */
  renderUpdate(ctx: RenderContext): void {
    const v = this.vehicle;
    if (
      !v ||
      (this.phase !== 'driving' &&
        this.phase !== 'hotwire' &&
        this.phase !== 'entering' &&
        this.phase !== 'exiting')
    )
      return;
    const input = this.input;
    if (this.phase === 'driving' && input.pressedThisFrame('cameraMode')) this.chase.cycleMode();
    this.input.readLook(ctx.frameSeconds, this.look);
    const root = v.view.root;
    const t = this.target;
    t.position.copy(root.position);
    t.quaternion.copy(root.quaternion);
    t.speed = v.sim.speed;
    t.length = v.def.length;
    t.height = v.def.kind === 'bike' ? 1.2 : v.def.height;
    t.eye.copy(v.view.model.seat).add(tmpV.set(0, v.def.kind === 'bike' ? 1.45 : 1.08, 0.05));
    this.seat.steer = v.sim.controls.steer;
    this.seat.hidden = this.chase.mode === 'interior' && this.phase === 'driving' && v.def.kind !== 'bike';
    this.chase.update(t, this.look.x, this.look.y, ctx.frameSeconds);
  }

  // ---- getting in --------------------------------------------------------------------------------

  private tryStart(): void {
    const p = this.player.motor.position;
    const v = this.vehicles.nearest(
      p.x,
      p.y,
      p.z,
      DRIVE.enterRange + 3,
      (c) => !c.wrecked && c.driver !== 'player',
    );
    if (!v) return;
    // Within reach of its hull (big vehicles count from their surface, not their centre).
    const t = v.sim.body.translation();
    const reach = Math.hypot(p.x - t.x, p.z - t.z) - Math.max(v.def.length, v.def.width) / 2;
    if (reach > DRIVE.enterRange - 2) return;
    this.vehicle = v;
    // An AI driver stops and waits while the player gets in (or pulls them out).
    v.held = true;
    this.prepareSeat(v);
    this.door = this.chooseDoor(v);
    this.jacking = v.occupant !== null;
    this.needsHotwire = false;
    this.phase = 'approach';
    this.timer = DRIVE.approachTimeout;
  }

  private chooseDoor(v: VehicleInstance): number {
    const doors = v.view.model.doors;
    if (doors.length === 0) return -1;
    const p = this.player.motor.position;
    let best = 0;
    let bestD = Infinity;
    doors.forEach((d, i) => {
      const w = this.localToWorld(v, d.stand, this.scratchWorld);
      // Front doors preferred (the driver's door most of all).
      const dist = Math.hypot(w.x - p.x, w.z - p.z) + (d.front ? 0 : 1.5) + (d.side > 0 ? 0 : 0.5);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    // A carjack always goes for the driver (left front).
    if (v.occupant)
      best = Math.max(
        0,
        doors.findIndex((d) => d.front && d.side > 0),
      );
    return best;
  }

  private stepApproach(dt: number): void {
    const v = this.current();
    const player = this.player;
    const p = player.motor.position;
    const target = this.doorWorld(v, 0);
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    this.timer -= dt;
    // Moving the stick / keys away cancels.
    const moving =
      Math.hypot(this.input.axis('moveX'), this.input.axis('moveY')) > 0.6 &&
      this.timer < DRIVE.approachTimeout - 0.3;
    const reach = v.def.kind === 'boat' ? 3 : v.def.kind === 'bike' ? 0.9 : DRIVE.doorReach;
    if (dist <= reach || (this.timer <= 0 && dist < 2.5)) {
      player.autoMove = null;
      // Start the blend from exactly where the player stands.
      this.worldToLocal(v, p.x, p.y, p.z, this.seat.door);
      if (v.locked && v.view.model.doors.length > 0) {
        this.phase = 'smash';
        this.timer = DRIVE.smashTime;
        this.presentation.animator.punch();
        player.motor.yaw = Math.atan2(v.sim.body.translation().x - p.x, v.sim.body.translation().z - p.z);
      } else this.openDoor();
      return;
    }
    if (this.timer <= 0 || moving || this.input.pressed('interact')) {
      player.autoMove = null;
      this.phase = 'foot';
      v.held = false;
      this.vehicle = null;
      return;
    }
    const speed = dist > 2.5 ? 'run' : 'walk';
    player.autoMove = { x: dx / dist, z: dz / dist, speed, faceYaw: null };
  }

  private openDoor(): void {
    const v = this.current();
    if (this.door >= 0) v.view.doorTarget[this.door] = 1;
    this.phase = 'opening';
    this.timer = this.door >= 0 ? DRIVE.openTime : 0;
  }

  private closeDoor(): void {
    const v = this.current();
    if (this.door >= 0) v.view.doorTarget[this.door] = 0;
  }

  private startEntering(): void {
    const v = this.current();
    this.player.sit();
    this.presentation.seat = this.seat;
    this.seat.blend = 0;
    this.phase = 'entering';
    // A carjacked car keeps running; unlocked parked cars have their keys.
    if (!this.needsHotwire && !v.wrecked) v.sim.engineOn = true;
  }

  private cameraTaken = false;

  private beginDriving(jacked: boolean): void {
    const v = this.current();
    if (v.sim instanceof RaycastVehicle) v.sim.drivetrain.automatic = !this.manualGearbox;
    this.onFootCamera.enabled = false;
    this.cameraTaken = true;
    this.chase.snap();
    this.collision.ignore = v.sim.body;
    this.entries++;
    this.bus.emit('vehicle:entered', { vehicle: v.id, model: v.def.id, jacked });
  }

  // ---- driving -----------------------------------------------------------------------------------

  private stepDriving(): void {
    const v = this.current();
    const input = this.input;
    this.keepPlayerAtSeat();
    const c = v.sim.controls;
    if (v.wrecked || !this.player.controlsEnabled) {
      c.throttle = 0;
      c.brake = v.wrecked ? 1 : 0;
      c.steer = 0;
      c.handbrake = false;
    } else {
      c.throttle = Math.max(0, input.axis('throttle'));
      c.brake = Math.max(0, input.axis('brake'));
      c.steer = input.axis('steer');
      c.handbrake = input.down('handbrake');
    }
    if (v.sim instanceof RaycastVehicle && !v.sim.drivetrain.automatic && this.player.controlsEnabled) {
      const box = v.sim.drivetrain;
      if (input.pressed('gearUp')) box.shiftTo(box.gear + 1);
      if (input.pressed('gearDown')) box.shiftTo(box.gear - 1);
    }
    if (this.player.controlsEnabled && input.pressed('horn')) {
      if (v.def.lightBar) v.siren = !v.siren;
      this.bus.emit('vehicle:horn', { vehicle: v.id, siren: v.siren });
    }
    if (this.player.controlsEnabled && input.pressed('interact')) {
      if (v.sim.speed > DRIVE.bailSpeed && v.def.kind !== 'boat') this.bail();
      else this.startExit();
    }
  }

  private startExit(): void {
    const v = this.current();
    this.phase = 'exiting';
    this.seat.door.copy(this.exitPointLocal(v));
    if (this.door >= 0) v.view.doorTarget[this.door] = 1;
    v.sim.controls.throttle = 0;
    v.sim.controls.brake = 1;
    v.sim.controls.handbrake = true;
  }

  /** Jumps out of a moving vehicle: tumbles with part of its speed and takes a knock. */
  private bail(): void {
    const v = this.current();
    const lv = v.sim.body.linvel();
    const side = this.localToWorld(
      v,
      this.scratchLocal.set(v.def.width / 2 + 0.9, 0.3, 0),
      new THREE.Vector3(),
    );
    const t = v.sim.body.translation();
    const sx = (side.x - t.x) / Math.max(0.01, Math.hypot(side.x - t.x, side.z - t.z));
    const sz = (side.z - t.z) / Math.max(0.01, Math.hypot(side.x - t.x, side.z - t.z));
    const speed = v.sim.speed;
    this.leave(true, true, side, lv.x * 0.6 + sx * 3, 2.5, lv.z * 0.6 + sz * 3);
    this.player.damage(Math.min(45, speed * 1.3), 'bail', false);
  }

  private onImpact(vehicleId: number, force: number): void {
    const v = this.vehicle;
    if (!v || v.id !== vehicleId || this.phase !== 'driving' || v.def.kind !== 'bike') return;
    if (force < v.def.mass * DRIVE.bikeThrowForce) return;
    // Thrown over the bars.
    const lv = v.sim.body.linvel();
    const front = this.localToWorld(v, this.scratchLocal.set(0, 1.4, 1.2), new THREE.Vector3());
    if (v.sim instanceof RaycastVehicle) v.sim.balanced = false;
    this.leave(true, true, front, lv.x * 0.8, 4, lv.z * 0.8);
    this.player.damage(Math.min(60, force / v.def.mass / 6), 'thrown', false);
  }

  /**
   * Leaves the vehicle: at its exit point (or `at`), optionally flung with a velocity. `instant`
   * skips the door (bail-outs, death, the vehicle disappearing).
   */
  private leave(bailed: boolean, instant: boolean, at?: THREE.Vector3, vx = 0, vy = 0, vz = 0): void {
    const v = this.vehicle;
    const player = this.player;
    player.autoMove = null;
    if (v) {
      v.held = false;
      if (this.door >= 0 && !instant) v.view.doorTarget[this.door] = 0;
      if (instant && this.door >= 0) v.view.doorTarget[this.door] = 0;
      v.driver = 'none';
      v.sim.controls.throttle = 0;
      v.sim.controls.steer = 0;
      if (
        this.phase === 'driving' ||
        this.phase === 'hotwire' ||
        this.phase === 'exiting' ||
        this.phase === 'entering' ||
        this.phase === 'jackPull'
      ) {
        const point = at ?? this.localToWorld(v, this.exitPointLocal(v), new THREE.Vector3());
        const t = v.sim.body.translation();
        const yaw = Math.atan2(point.x - t.x, point.z - t.z);
        if (player.seated) player.stand(point.x, point.y, point.z, yaw, vx, vy, vz);
        this.bus.emit('vehicle:exited', { vehicle: v.id, bailed });
      }
    }
    this.presentation.seat = null;
    this.collision.ignore = null;
    if (this.cameraTaken) {
      this.cameraTaken = false;
      this.onFootCamera.enabled = true;
      this.onFootCamera.snapBehind();
    }
    this.vehicle = null;
    this.door = -1;
    this.phase = 'foot';
    this.hotwire = 0;
  }

  // ---- geometry helpers --------------------------------------------------------------------------

  private current(): VehicleInstance {
    if (!this.vehicle) throw new Error('PlayerVehicleController: no vehicle');
    return this.vehicle;
  }

  private prepareSeat(v: VehicleInstance): void {
    const seat = this.seat;
    seat.anchor = v.view.mesh;
    seat.seat.copy(v.view.model.seat);
    seat.clip = v.def.kind === 'bike' ? 'sitRide' : 'sitDrive';
    seat.blend = 0;
    seat.door.copy(this.exitPointLocal(v));
  }

  /** Local stand point for getting in/out: the chosen door, a bike's side, or a boat's beam. */
  private standLocal(v: VehicleInstance, outward: number, out: THREE.Vector3): THREE.Vector3 {
    const door = this.door >= 0 ? v.view.model.doors[this.door] : undefined;
    if (door) return out.set(door.stand.x + door.side * outward, door.stand.y, door.stand.z);
    if (v.def.kind === 'bike') return out.set(0.85 + outward, 0, -0.15);
    return out.set(v.def.width / 2 + 0.8 + outward, v.def.height * 0.55, -0.5);
  }

  /** First clear exit point: the chosen door, then the other doors, behind the vehicle, the roof. */
  private exitPointLocal(v: VehicleInstance): THREE.Vector3 {
    const candidates: THREE.Vector3[] = [this.standLocal(v, 0, new THREE.Vector3())];
    for (const d of v.view.model.doors) candidates.push(d.stand);
    candidates.push(new THREE.Vector3(0, 0, -(v.def.length / 2 + 1.2)));
    candidates.push(new THREE.Vector3(-(v.def.width / 2 + 0.85), 0, 0));
    const body = v.sim.body;
    for (const c of candidates) {
      const w = this.localToWorld(v, c, this.scratchWorld);
      if (!this.physics.overlapsSphere(w.x, w.y + 1, w.z, 0.38, EXIT_GROUPS, body)) return c.clone();
    }
    return new THREE.Vector3(0, v.def.height + 0.3, 0);
  }

  private doorWorld(v: VehicleInstance, outward: number): THREE.Vector3 {
    return this.localToWorld(v, this.standLocal(v, outward, this.scratchLocal), this.scratchDoor);
  }

  private readonly scratchWorld = new THREE.Vector3();
  private readonly scratchLocal = new THREE.Vector3();
  private readonly scratchDoor = new THREE.Vector3();
  private readonly scratchSeat = new THREE.Vector3();

  private localToWorld(v: VehicleInstance, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const t = v.sim.body.translation();
    const r = v.sim.body.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);
    return out
      .copy(local)
      .applyQuaternion(tmpQ)
      .add(tmpV.set(t.x, t.y, t.z));
  }

  private worldToLocal(
    v: VehicleInstance,
    x: number,
    y: number,
    z: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const t = v.sim.body.translation();
    const r = v.sim.body.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w).invert();
    return out.set(x - t.x, y - t.y, z - t.z).applyQuaternion(tmpQ);
  }

  /** The seated motor follows the seat so probes, streaming and AI see the player in the car. */
  private keepPlayerAtSeat(): void {
    const v = this.vehicle;
    if (!v || !this.player.seated) return;
    const w = this.localToWorld(v, this.seat.seat, this.scratchSeat);
    this.player.motor.teleport(w.x, w.y, w.z);
  }
}
