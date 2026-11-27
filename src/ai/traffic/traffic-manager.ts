import type { NpcManager } from '../../characters/npc/npc-character';
import type { CharacterAppearance } from '../../characters/rig/appearance';
import type { EventBus, GameEvents } from '../../core/events';
import { Rng } from '../../core/rng';
import type { FixedContext, FixedSystem } from '../../ecs/scheduler';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld } from '../../physics/physics-world';
import { RaycastVehicle } from '../../vehicles/sim/raycast-vehicle';
import type { VehicleDef } from '../../vehicles/vehicle-def';
import type { VehicleInstance, VehicleManager } from '../../vehicles/vehicle-manager';
import type { DistrictId } from '../../world/gen/types';
import type { IdmParams } from './idm';
import { createLanePoint, type LaneNetwork, Turn } from './lane-network';
import { ObstacleField } from './obstacles';
import { drivePhysicsCar } from './physics-driver';
import { type DriverProfile, type TrafficCar, TrafficSim } from './traffic-sim';

/** Which models drive where (content data). */
export interface TrafficRules {
  /** Model id weights per district (lanes outside districts — bridges, tunnel — use 'meridian'). */
  models: Readonly<Record<DistrictId, Readonly<Record<string, number>>>>;
  /** Models only seen on major roads (buses, trucks). */
  majorRoadOnly: readonly string[];
}

export interface TrafficOptions {
  /** Hard cap on traffic vehicles (quality preset). */
  maxCars: number;
  /** New cars appear between these distances from the camera, preferably out of view (m). */
  spawnMin: number;
  spawnMax: number;
  /** Cars farther than this are removed (m). */
  despawn: number;
  /** Full physics within this radius of the camera (kinematic lane following beyond) (m). */
  physicsRadius: number;
  /** Drivers are visible (and can be pulled out) within this radius (m). */
  driverRadius: number;
}

/** Where the camera is and where it looks (spawning out of view). */
export interface TrafficView {
  x: number;
  y: number;
  z: number;
  /** Unit view direction in XZ, and the cosine of the half field of view (with margin). */
  fx: number;
  fz: number;
  cosHalfFov: number;
}

export interface TrafficDeps {
  net: LaneNetwork;
  vehicles: VehicleManager;
  npcs: NpcManager;
  physics: PhysicsWorld;
  bus: EventBus<GameEvents>;
  catalogue: readonly VehicleDef[];
  rules: TrafficRules;
  appearance: (rng: Rng) => CharacterAppearance;
  seed: number;
  view: () => TrafficView;
  /** Desired number of cars right now (density for the hour and district, already capped). */
  target: () => number;
  /** Adds everything traffic must not drive into this tick (people, the player, stray vehicles). */
  fillObstacles: (field: ObstacleField, traffic: ReadonlySet<VehicleInstance>) => void;
}

type Mode = 'kinematic' | 'physics';

interface Entry {
  car: TrafficCar;
  vehicle: VehicleInstance;
  sim: RaycastVehicle;
  mode: Mode;
  /** Seconds left standing still after a knock (hazards on). */
  shaken: number;
  /** Seconds left driving away from gunfire. */
  fleeing: number;
  honkTimer: number;
  /** Lateral distance from the plan last tick (physics). */
  deviation: number;
}

export interface TrafficCounters {
  spawned: number;
  despawned: number;
  /** Removed by the gridlock detector (stuck out of view). */
  gridlockRemovals: number;
  /** Handed over to the player or abandoned after a crash / gunfire. */
  released: number;
  promotions: number;
  demotions: number;
  honks: number;
}

const GROUND = interactionGroups(0xffff, Group.WORLD);
const BLOCKERS = interactionGroups(0xffff, Group.VEHICLE | Group.CHARACTER | Group.RAGDOLL);
const KNOCK_ACCEL = 30;

/**
 * City traffic: keeps a density-driven number of AI cars around the camera, driven by the
 * traffic model (TrafficSim). Cars near the camera are full raycast-vehicle physics steered by
 * the physics driver; farther cars follow their lanes kinematically and are promoted to physics
 * when they come close (once the ground collider under them has streamed in). Drivers are real
 * NPCs (carjackable) near the camera. Cars react to knocks (stop, hazards, abandon when badly
 * damaged), gunfire (drive off, bail out when it is close) and sirens (pull over), honk at
 * vehicles blocking them, and stuck cars are cleared out of view.
 */
export class TrafficManager {
  readonly sim: TrafficSim;
  readonly obstacles = new ObstacleField(768);
  readonly entries: Entry[] = [];
  readonly counters: TrafficCounters = {
    spawned: 0,
    despawned: 0,
    gridlockRemovals: 0,
    released: 0,
    promotions: 0,
    demotions: 0,
    honks: 0,
  };
  enabled = true;
  private readonly byVehicle = new Map<VehicleInstance, Entry>();
  private readonly trafficSet = new Set<VehicleInstance>();
  private readonly rng: Rng;
  private readonly point = createLanePoint();
  private readonly back = createLanePoint();
  private readonly front = createLanePoint();
  private readonly hit = createRayHit();
  private readonly found: number[] = [];
  private spawnTimer = 0;
  private lodTimer = 0;
  private driverTimer = 0;
  /** The first seconds fill the streets anywhere around the camera (then only out of view). */
  private initialFill = true;
  private fillTime = 0;
  private dt = 1 / 60;

  constructor(
    private readonly deps: TrafficDeps,
    readonly options: TrafficOptions,
  ) {
    this.sim = new TrafficSim(deps.net, deps.seed, this.obstacles);
    this.rng = new Rng(`${deps.seed}:traffic`);
    deps.vehicles.listeners.removed.push((v) => {
      const e = this.byVehicle.get(v);
      if (e) this.forget(e);
    });
    deps.bus.on('vehicle:impact', ({ vehicle, force }) => this.onImpact(vehicle, force));
    deps.bus.on('combat:shot', ({ x, z }) => this.onShot(x, z));
    deps.bus.on('vehicle:exploded', ({ x, z }) => this.onShot(x, z));
  }

  get count(): number {
    return this.entries.length;
  }

  get physicsCount(): number {
    let n = 0;
    for (const e of this.entries) if (e.mode === 'physics') n++;
    return n;
  }

  createSystem(): FixedSystem {
    return {
      name: 'traffic',
      phase: 'ai',
      fixedUpdate: (ctx) => this.fixedUpdate(ctx),
    };
  }

  /** Removes every traffic car (debug / tests). */
  clear(): void {
    for (const e of [...this.entries]) this.despawn(e);
  }

  private fixedUpdate(ctx: FixedContext): void {
    const dt = ctx.dt;
    this.dt = dt;
    if (!this.enabled) {
      if (this.entries.length > 0) this.clear();
      return;
    }
    const view = this.deps.view();
    this.fillTime += dt;
    if (this.fillTime > 8) this.initialFill = false;
    // 1) Measure physics cars, apply holds and reactions.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const v = e.vehicle;
      // Taken by the player, or wrecked: no longer traffic. (Far cars have no seated NPC; their
      // driver appears when the camera comes close.)
      if (v.driver !== 'npc' || v.wrecked) {
        this.release(e, false);
        continue;
      }
      if (e.mode === 'physics') {
        const t = e.sim.body.translation();
        e.deviation = this.sim.track(e.car, t.x, t.z, e.sim.telemetry.forwardSpeed, dt);
        const up = 1 - 2 * (e.sim.body.rotation().x ** 2 + e.sim.body.rotation().z ** 2);
        // Knocked far off its lane or onto its side: the driver gives up.
        if (e.deviation > 7 || up < 0.4) {
          this.release(e, true);
          continue;
        }
      }
      if (e.shaken > 0) e.shaken -= dt;
      if (e.fleeing > 0) {
        e.fleeing -= dt;
        if (e.fleeing <= 0) e.car.urgency = 1;
      }
      e.car.hold = v.held || e.shaken > 0;
      v.hazard = e.shaken > 0;
    }
    this.sirens();
    // 2) Plan.
    this.obstacles.clear();
    this.deps.fillObstacles(this.obstacles, this.trafficSet);
    this.sim.step(dt, ctx.time);
    // 3) Act.
    for (const e of this.entries) {
      const car = e.car;
      if (e.mode === 'physics') drivePhysicsCar(this.sim, car, e.sim);
      else this.moveKinematic(e, dt);
      e.vehicle.indicator = this.indicatorFor(car);
      if (car.blockedByObstacle > 2.5 && car.obstacleIsVehicle) {
        e.honkTimer -= dt;
        if (e.honkTimer <= 0) {
          e.honkTimer = 4 + this.rng.range(0, 3);
          this.counters.honks++;
          this.deps.bus.emit('vehicle:horn', { vehicle: e.vehicle.id, siren: false });
        }
      } else e.honkTimer = Math.min(e.honkTimer, 0.5);
    }
    // 4) Bookkeeping at lower rates.
    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.lodTimer = 0.25;
      this.updateLod(view);
    }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.initialFill ? 0.05 : 0.5;
      this.despawnFar(view);
      this.spawnNear(view);
    }
    this.driverTimer -= dt;
    if (this.driverTimer <= 0) {
      this.driverTimer = 0.5;
      this.updateDrivers(view);
    }
  }

  // ---- motion ---------------------------------------------------------------------------------

  private moveKinematic(e: Entry, dt: number): void {
    const car = e.car;
    const def = e.vehicle.def;
    this.sim.pose(car, this.point);
    const half = def.wheelbase / 2;
    this.sim.lookahead(car, -half, this.back);
    this.sim.lookahead(car, half, this.front);
    const dx = this.front.x - this.back.x;
    const dz = this.front.z - this.back.z;
    const run = Math.sqrt(dx * dx + dz * dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(this.front.y - this.back.y, run);
    // Front wheels follow the path a little further ahead.
    this.sim.lookahead(car, half + 3, this.front);
    const ax = this.front.x - this.point.x;
    const az = this.front.z - this.point.z;
    const left = ax * Math.cos(yaw) - az * Math.sin(yaw);
    const steer = Math.atan2(2 * def.wheelbase * left, ax * ax + az * az + 1);
    e.sim.driveKinematic(this.point.x, this.point.y, this.point.z, yaw, pitch, car.v, steer, dt);
    // Brake lights.
    e.sim.controls.brake = car.accel < -0.6 ? 0.6 : 0;
    e.sim.controls.throttle = car.accel > 0.2 ? 0.4 : 0;
  }

  private indicatorFor(car: TrafficCar): number {
    if (car.indicator !== 0) return car.indicator;
    if (car.gate >= 0 && car.stopDistance < 35) {
      const turn = this.deps.net.turn[car.gate];
      if (turn === Turn.left || turn === Turn.uturn) return -1;
      if (turn === Turn.right) return 1;
    }
    return car.pullOver > 0 ? 1 : 0;
  }

  // ---- level of detail ------------------------------------------------------------------------

  private updateLod(view: TrafficView): void {
    const r = this.options.physicsRadius;
    for (const e of this.entries) {
      const t = e.sim.body.translation();
      const d2 = (t.x - view.x) ** 2 + (t.z - view.z) ** 2;
      if (e.mode === 'kinematic' && d2 < r * r) this.promote(e);
      else if (e.mode === 'physics' && d2 > (r + 25) ** 2 && !e.vehicle.held && e.deviation < 1.5)
        this.demote(e);
    }
  }

  /** Kinematic → physics, once the ground collider under the car exists. */
  private promote(e: Entry): boolean {
    this.sim.pose(e.car, this.point);
    const { x, y, z } = this.point;
    if (!this.deps.physics.castRay(x, y + 2.5, z, 0, -1, 0, 6, this.hit, GROUND)) return false;
    const half = e.vehicle.def.wheelbase / 2;
    this.sim.lookahead(e.car, -half, this.back);
    this.sim.lookahead(e.car, half, this.front);
    const yaw = Math.atan2(this.front.x - this.back.x, this.front.z - this.back.z);
    const run = Math.hypot(this.front.x - this.back.x, this.front.z - this.back.z) || 1;
    const pitch = Math.atan2(this.front.y - this.back.y, run);
    e.sim.resume(x, this.hit.y + 0.03, z, yaw, pitch, e.car.v);
    e.mode = 'physics';
    e.car.physics = true;
    e.deviation = 0;
    this.counters.promotions++;
    return true;
  }

  /** Physics → kinematic (far away): snaps onto the lane at the tracked position. */
  private demote(e: Entry): void {
    e.sim.setKinematic(true);
    e.mode = 'kinematic';
    e.car.physics = false;
    e.car.lat = 0;
    this.counters.demotions++;
  }

  // ---- population -----------------------------------------------------------------------------

  private despawnFar(view: TrafficView): void {
    const o = this.options;
    const target = Math.min(o.maxCars, this.deps.target());
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.vehicle.held) continue;
      const t = e.sim.body.translation();
      const dx = t.x - view.x;
      const dz = t.z - view.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const visible = this.inView(view, dx, dz, d);
      let remove = d > o.despawn;
      // Thin out (lower density, smaller cap) where nobody sees it.
      if (!remove && !visible && d > o.spawnMin && this.entries.length > target + 1) remove = true;
      // Gridlock detector: stuck cars disappear once out of sight.
      if (!remove && e.car.stuck && !visible && d > 40) {
        remove = true;
        this.counters.gridlockRemovals++;
      }
      if (remove) this.despawn(e);
    }
  }

  private spawnNear(view: TrafficView): void {
    const o = this.options;
    const target = Math.min(o.maxCars, this.deps.target());
    if (this.entries.length >= target) return;
    const net = this.deps.net;
    let spawned = 0;
    for (let attempt = 0; attempt < 12 && spawned < 2 && this.entries.length < target; attempt++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const min = this.initialFill ? 25 : o.spawnMin;
      const radius = this.rng.range(min, o.spawnMax);
      const px = view.x + Math.sin(angle) * radius;
      const pz = view.z + Math.cos(angle) * radius;
      if (
        !this.initialFill &&
        this.inView(view, px - view.x, pz - view.z, radius) &&
        radius < o.spawnMax * 0.85
      )
        continue;
      net.lanesNear(px, pz, 20, this.found);
      if (this.found.length === 0) continue;
      const lane = this.found[this.rng.int(0, this.found.length)];
      if (net.connector[lane] || net.length[lane] < 25) continue;
      const def = this.pickModel(lane);
      if (!def) continue;
      const proj = net.project(lane, px, pz, { s: 0, lat: 0, dist: 0 });
      const stop = net.stopS[lane] >= 0 ? net.stopS[lane] : net.length[lane];
      const s = Math.max(def.length, Math.min(proj.s, stop - def.length - 4));
      if (s <= def.length || !this.sim.isClear(lane, s, def.length, 10)) continue;
      if (this.spawn(def, lane, s, view)) spawned++;
    }
  }

  private pickModel(lane: number): VehicleDef | null {
    const net = this.deps.net;
    const table = this.deps.rules.models[net.district[lane] ?? 'meridian'];
    let total = 0;
    for (const id in table) total += table[id];
    let r = this.rng.range(0, total);
    let pick = '';
    for (const id in table) {
      r -= table[id];
      if (r <= 0) {
        pick = id;
        break;
      }
    }
    if (this.deps.rules.majorRoadOnly.includes(pick) && net.rank[lane] < 2) return null;
    return this.deps.catalogue.find((d) => d.id === pick && d.kind === 'car') ?? null;
  }

  private spawn(def: VehicleDef, lane: number, s: number, view: TrafficView): boolean {
    const net = this.deps.net;
    const p = net.sample(lane, s, this.point);
    // Never inside another vehicle or a person (parked cars, the player's car, people crossing).
    for (const along of [-def.length / 3, 0, def.length / 3]) {
      if (
        this.deps.physics.overlapsSphere(
          p.x + p.dx * along,
          p.y + 1,
          p.z + p.dz * along,
          def.width / 2 + 0.4,
          BLOCKERS,
        )
      )
        return false;
    }
    const yaw = Math.atan2(p.dx, p.dz);
    const speed = net.speed[lane] * this.rng.range(0.55, 0.85);
    const v = this.deps.vehicles.spawn(def, p.x, p.y + 0.03, p.z, yaw, {
      colour: def.colours[this.rng.int(0, def.colours.length)],
      engineOn: true,
      owner: 'traffic',
    });
    if (!(v.sim instanceof RaycastVehicle)) {
      this.deps.vehicles.remove(v);
      return false;
    }
    v.driver = 'npc';
    v.aiDriven = true;
    v.sim.controls.allowReverse = false;
    const car = this.sim.addCar(lane, s, speed, def.length, def.width, this.profile());
    const e: Entry = {
      car,
      vehicle: v,
      sim: v.sim,
      mode: 'kinematic',
      shaken: 0,
      fleeing: 0,
      honkTimer: 0,
      deviation: 0,
    };
    v.sim.setKinematic(true);
    this.entries.push(e);
    this.byVehicle.set(v, e);
    this.trafficSet.add(v);
    this.counters.spawned++;
    const d2 = (p.x - view.x) ** 2 + (p.z - view.z) ** 2;
    if (d2 < this.options.physicsRadius ** 2) this.promote(e);
    if (e.mode === 'kinematic') this.moveKinematic(e, this.dt);
    if (d2 < this.options.driverRadius ** 2) this.seatDriver(e);
    return true;
  }

  private profile(): DriverProfile {
    const r = this.rng;
    // A few drivers are noticeably calmer or pushier than average.
    const temper = r.range(-1, 1);
    const idm: IdmParams = {
      a: 1.5 + 0.5 * temper + r.range(0, 0.4),
      b: 2.6 + 0.4 * temper,
      T: 1.5 - 0.3 * temper,
      s0: 2.2 + r.range(0, 0.8),
      delta: 4,
    };
    return { speedFactor: 0.92 + 0.12 * temper, idm, gap: 3.8 - 0.8 * temper };
  }

  private despawn(e: Entry): void {
    const v = e.vehicle;
    if (v.occupant) {
      this.deps.npcs.remove(v.occupant);
      v.occupant = null;
    }
    this.forget(e);
    this.deps.vehicles.remove(v);
    this.counters.despawned++;
  }

  /** Stops tracking a vehicle as traffic (it stays in the world). */
  private forget(e: Entry): void {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.byVehicle.delete(e.vehicle);
    this.trafficSet.delete(e.vehicle);
    this.sim.removeCar(e.car);
    e.vehicle.aiDriven = false;
    e.vehicle.indicator = 0;
    // Back to ordinary controls (the player may reverse a car taken from traffic).
    e.sim.controls.allowReverse = true;
  }

  /**
   * The car is no longer traffic: taken by the player, or abandoned after a crash or gunfire
   * (`abandon`: the driver gets out and runs). It stays where it is as an ordinary vehicle.
   */
  private release(e: Entry, abandon: boolean): void {
    const v = e.vehicle;
    if (e.mode === 'kinematic') {
      // Hand over to physics where it stands (or just stop if there is no ground collider yet).
      if (!this.promote(e)) e.sim.setKinematic(false);
    }
    this.forget(e);
    v.owner = 'free';
    v.hazard = abandon;
    if (abandon && v.occupant && v.driver === 'npc') {
      const npc = v.occupant;
      const t = v.sim.body.translation();
      const door = v.view.model.doors.find((d) => d.front && d.side > 0);
      const q = v.sim.body.rotation();
      const yaw = 2 * Math.atan2(q.y, q.w);
      const side = (door?.stand.x ?? v.def.width / 2 + 0.6) + 0.5;
      const x = t.x + Math.cos(yaw) * side;
      const z = t.z - Math.sin(yaw) * side;
      npc.ejectAndFlee(x, t.y + 0.1, z, yaw + Math.PI / 2, t.x, t.z);
      v.occupant = null;
      v.driver = 'none';
    } else if (v.driver === 'npc' && !v.occupant) v.driver = 'none';
    this.counters.released++;
  }

  private updateDrivers(view: TrafficView): void {
    const inner = this.options.driverRadius;
    const outer = inner + 20;
    let seated = 0;
    for (const e of this.entries) {
      const t = e.sim.body.translation();
      const d2 = (t.x - view.x) ** 2 + (t.z - view.z) ** 2;
      const v = e.vehicle;
      if (!v.occupant && d2 < inner * inner && seated < 3) {
        this.seatDriver(e);
        seated++;
      } else if (v.occupant && d2 > outer * outer && !v.held) {
        this.deps.npcs.remove(v.occupant);
        v.occupant = null;
      }
    }
  }

  private seatDriver(e: Entry): void {
    const v = e.vehicle;
    if (v.occupant) return;
    const t = v.sim.body.translation();
    const rng = new Rng(`${this.deps.seed}:traffic-driver:${v.id}`);
    const npc = this.deps.npcs.spawn(this.deps.appearance(rng), t.x, t.y + 1, t.z);
    npc.sit({
      anchor: v.view.mesh,
      seat: v.view.model.seat.clone(),
      door: (v.view.model.doors.find((d) => d.front && d.side > 0)?.stand ?? v.view.model.seat).clone(),
      blend: 1,
      clip: 'sitDrive',
      steer: 0,
      hidden: false,
    });
    v.occupant = npc;
  }

  private inView(view: TrafficView, dx: number, dz: number, d: number): boolean {
    if (d < 1) return true;
    return (dx * view.fx + dz * view.fz) / d > view.cosHalfFov;
  }

  // ---- reactions ------------------------------------------------------------------------------

  private onImpact(vehicleId: number, force: number): void {
    for (const e of this.entries) {
      if (e.vehicle.id !== vehicleId) continue;
      const accel = force / e.vehicle.def.mass;
      if (accel < KNOCK_ACCEL) return;
      const v = e.vehicle;
      // Badly hurt or burning: the driver bails out. Otherwise stop for a moment, hazards on.
      if (v.onFire || v.engineHealth < v.def.durability * 0.35) this.release(e, true);
      else e.shaken = Math.max(e.shaken, 2.5 + Math.min(3, accel / 40));
      return;
    }
  }

  /** Gunfire or an explosion at (x, z): nearby drivers speed away; very close and slow ones bail out. */
  private onShot(x: number, z: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const t = e.sim.body.translation();
      const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d2 > 50 * 50) continue;
      if (d2 < 14 * 14 && e.car.v < 3 && e.mode === 'physics') {
        this.release(e, true);
        continue;
      }
      e.fleeing = 12;
      e.car.urgency = 1.35;
    }
  }

  /** Vehicles with their siren on clear the road: traffic ahead of them pulls over. */
  private sirens(): void {
    for (const s of this.deps.vehicles.vehicles) {
      if (!s.siren || s.owner === 'traffic' || s.sim.speed < 3) continue;
      const st = s.sim.body.translation();
      const sq = s.sim.body.rotation();
      const sx = 2 * (sq.x * sq.z + sq.w * sq.y);
      const sz = 1 - 2 * (sq.x * sq.x + sq.y * sq.y);
      for (const e of this.entries) {
        const t = e.sim.body.translation();
        const dx = t.x - st.x;
        const dz = t.z - st.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 55 * 55 || d2 < 1) continue;
        const ahead = (dx * sx + dz * sz) / Math.sqrt(d2);
        const q = e.sim.body.rotation();
        const fx = 2 * (q.x * q.z + q.w * q.y);
        const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        // In front of the siren and heading the same way.
        if (ahead > 0.6 && fx * sx + fz * sz > 0.5) e.car.pullOver = Math.max(e.car.pullOver, 2);
      }
    }
  }

  /** Nearest traffic cars to (x, z) for probes. */
  describe(x: number, z: number, count: number): Record<string, unknown>[] {
    return this.entries
      .map((e) => {
        const t = e.sim.body.translation();
        return { e, d: Math.hypot(t.x - x, t.z - z), t };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map(({ e, d, t }) => ({
        id: e.vehicle.id,
        model: e.vehicle.def.id,
        mode: e.mode,
        d: Math.round(d),
        x: t.x,
        z: t.z,
        lane: e.car.lane,
        speed: Number(e.car.v.toFixed(2)),
        reason: e.car.reason,
        light: e.car.light,
        driver: e.vehicle.occupant !== null,
      }));
  }
}
