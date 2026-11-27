import type * as THREE from 'three';
import type { NpcCharacter } from '../characters/npc/npc-character';
import type { Entity } from '../ecs/entity';
import type { FixedSystem, RenderContext, RenderSystem } from '../ecs/scheduler';
import { interpolatePose, teleport, Transform, type PoseOut, type TransformStore } from '../ecs/transform';
import type { World } from '../ecs/world';
import type { PhysicsWorld } from '../physics/physics-world';
import { RigidBodyRef } from '../physics/rigid-body-sync';
import { buildVehicleModel } from './body/vehicle-mesh';
import { VehicleView, type VehicleMaterials } from './body/vehicle-view';
import { BoatSim } from './sim/boat-sim';
import { RaycastVehicle } from './sim/raycast-vehicle';
import { parkedControls } from './sim/vehicle-controls';
import type { VehicleSim, WaterQuery } from './sim/vehicle-sim';
import type { VehicleDef } from './vehicle-def';

export type DriverKind = 'none' | 'player' | 'npc';
/** Who keeps the vehicle in the world: parked-car streaming, the traffic system, or nobody (spawned). */
export type VehicleOwner = 'parked' | 'traffic' | 'free';

/** One vehicle in the world: simulation, view, ECS entity and gameplay state. */
export interface VehicleInstance {
  readonly id: number;
  readonly def: VehicleDef;
  readonly sim: VehicleSim;
  readonly view: VehicleView;
  readonly entity: Entity;
  readonly colour: number;
  /** Locked parked cars need a window smash and a hotwire. */
  locked: boolean;
  driver: DriverKind;
  /** Engine damage (0 = destroyed) out of def.durability; body damage counts dents. */
  engineHealth: number;
  onFire: boolean;
  /** Seconds the fire has burned (explodes after the fuse). */
  fireTime: number;
  wrecked: boolean;
  siren: boolean;
  /** Kept alive by the parked-car manager (the player used it). */
  persistent: boolean;
  /** Where it came from (parking spot index, or −1). */
  spot: number;
  /** Seconds a driverless vehicle has been at rest (it is put to sleep after a moment). */
  restTime: number;
  /** An NPC sitting at the wheel (carjack target). */
  occupant: NpcCharacter | null;
  /**
   * Seconds left in which impacts do no damage: a vehicle spawned overlapping something is pushed
   * apart by the solver with huge contact forces that are not a crash.
   */
  spawnGrace: number;
  owner: VehicleOwner;
  /** Controls are written by an AI driver (the manager leaves them alone). */
  aiDriven: boolean;
  /** Someone is getting in (or pulling the driver out): an AI driver must stop and wait. */
  held: boolean;
  /** Turn signal (−1 left, 1 right, 0 off) and hazard lights. */
  indicator: number;
  hazard: boolean;
}

export interface SpawnOptions {
  colour?: number;
  locked?: boolean;
  engineOn?: boolean;
  spot?: number;
  owner?: VehicleOwner;
}

const pose: PoseOut = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

/** Creates, steps, renders and removes vehicles. */
export class VehicleManager {
  readonly vehicles: VehicleInstance[] = [];
  private readonly byBodyHandle = new Map<number, VehicleInstance>();
  private readonly byColliderHandle = new Map<number, VehicleInstance>();
  private readonly transforms: TransformStore;
  private nextId = 1;
  private barPhase = 0;
  readonly listeners: {
    spawned: ((v: VehicleInstance) => void)[];
    removed: ((v: VehicleInstance) => void)[];
  } = {
    spawned: [],
    removed: [],
  };

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: World,
    private readonly scene: THREE.Scene,
    private readonly materials: VehicleMaterials,
    private readonly water: WaterQuery,
  ) {
    this.transforms = world.soa(Transform);
  }

  spawn(
    def: VehicleDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
    options: SpawnOptions = {},
  ): VehicleInstance {
    const colour = options.colour ?? def.colours[0];
    const sim: VehicleSim =
      def.kind === 'boat'
        ? new BoatSim(this.physics, def, this.water, x, y, z, yaw)
        : new RaycastVehicle(this.physics, def, x, y, z, yaw);
    sim.engineOn = options.engineOn ?? false;
    if (!sim.engineOn) parkedControls(sim.controls);
    const view = new VehicleView(buildVehicleModel(def, colour), def, this.materials);
    this.scene.add(view.root);
    const entity = this.world.create();
    this.world.add(entity, Transform);
    const half = yaw / 2;
    teleport(this.transforms, entity, x, y, z, 0, Math.sin(half), 0, Math.cos(half));
    this.world.set(entity, RigidBodyRef, sim.body);
    const instance: VehicleInstance = {
      id: this.nextId++,
      def,
      sim,
      view,
      entity,
      colour,
      locked: options.locked ?? false,
      driver: 'none',
      engineHealth: def.durability,
      onFire: false,
      fireTime: 0,
      wrecked: false,
      siren: false,
      persistent: false,
      spot: options.spot ?? -1,
      restTime: 0,
      occupant: null,
      spawnGrace: 1.5,
      owner: options.owner ?? 'free',
      aiDriven: false,
      held: false,
      indicator: 0,
      hazard: false,
    };
    this.vehicles.push(instance);
    this.byBodyHandle.set(sim.body.handle, instance);
    for (let i = 0; i < sim.body.numColliders(); i++)
      this.byColliderHandle.set(sim.body.collider(i).handle, instance);
    view.setTransform(x, y, z, 0, Math.sin(half), 0, Math.cos(half));
    for (const listener of this.listeners.spawned) listener(instance);
    return instance;
  }

  remove(v: VehicleInstance): void {
    const i = this.vehicles.indexOf(v);
    if (i < 0) return;
    this.vehicles.splice(i, 1);
    this.byBodyHandle.delete(v.sim.body.handle);
    for (let c = 0; c < v.sim.body.numColliders(); c++)
      this.byColliderHandle.delete(v.sim.body.collider(c).handle);
    for (const listener of this.listeners.removed) listener(v);
    // Unlink the body before freeing it: the rigid-body sync must never touch a removed body.
    this.world.destroy(v.entity);
    v.view.dispose();
    v.sim.dispose();
  }

  byCollider(handle: number): VehicleInstance | undefined {
    return this.byColliderHandle.get(handle);
  }

  byBody(handle: number): VehicleInstance | undefined {
    return this.byBodyHandle.get(handle);
  }

  /** Nearest vehicle whose centre is within `radius` of (x, z) (optionally matching a filter). */
  nearest(
    x: number,
    y: number,
    z: number,
    radius: number,
    filter?: (v: VehicleInstance) => boolean,
  ): VehicleInstance | null {
    let best: VehicleInstance | null = null;
    let bestD = radius * radius;
    for (const v of this.vehicles) {
      if (filter && !filter(v)) continue;
      const t = v.sim.body.translation();
      const d = (t.x - x) ** 2 + (t.z - z) ** 2 + ((t.y - y) * 0.5) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /** Fixed step: every vehicle simulation (driverless ones hold their brakes). */
  createFixedSystem(): FixedSystem {
    return {
      name: 'vehicles',
      phase: 'prePhysics',
      fixedUpdate: (ctx): void => {
        for (const v of this.vehicles) {
          if (v.spawnGrace > 0) v.spawnGrace -= ctx.dt;
          // Without a driver (or an AI writing the controls) the brakes hold the vehicle.
          if ((v.driver !== 'player' && !v.aiDriven) || v.wrecked) {
            if (v.sim.speed < 1.5 || v.wrecked) parkedControls(v.sim.controls);
            else {
              // Driverless but rolling (bailed out): coast to a stop.
              v.sim.controls.throttle = 0;
              v.sim.controls.brake = 0.15;
              v.sim.controls.handbrake = false;
            }
          }
          // Parked and settled: let Rapier sleep the body (it wakes on contact), so idle
          // vehicles cost nothing per tick. Checked before this tick's suspension impulses,
          // which momentarily add ~g·dt of vertical speed.
          const body = v.sim.body;
          if (v.driver === 'none' && !v.onFire && !body.isSleeping()) {
            const lv = body.linvel();
            const av = body.angvel();
            const still =
              lv.x * lv.x + lv.y * lv.y + lv.z * lv.z < 0.01 &&
              av.x * av.x + av.y * av.y + av.z * av.z < 0.01;
            v.restTime = still ? v.restTime + ctx.dt : 0;
            if (v.restTime > 1) {
              body.sleep();
              v.restTime = 0;
            }
          }
          // Far traffic is kinematic: its pose comes from the traffic system.
          if (!(v.sim instanceof RaycastVehicle && v.sim.kinematic)) v.sim.step(ctx.dt);
        }
      },
    };
  }

  /** Render: interpolated placement, wheels, doors, lights. */
  createRenderSystem(): RenderSystem {
    return {
      name: 'vehicleViews',
      // Before character animation: seated riders read this frame's vehicle pose.
      phase: 'interpolate',
      renderUpdate: (ctx: RenderContext): void => {
        this.barPhase = (this.barPhase + ctx.frameSeconds * 2.2) % 1;
        for (const v of this.vehicles) {
          interpolatePose(this.transforms, v.entity, ctx.alpha, pose);
          v.view.setTransform(pose.x, pose.y, pose.z, pose.qx, pose.qy, pose.qz, pose.qw);
          if (v.sim instanceof RaycastVehicle) {
            v.view.updateWheels(v.sim.wheels);
            if (v.def.kind === 'bike') v.view.setLean(v.sim.lean);
          }
          v.view.update(ctx.frameSeconds);
          const t = v.sim.telemetry;
          const driven = v.driver !== 'none' && v.sim.engineOn;
          v.view.setLights(
            v.sim.engineOn ? 0.35 : 0,
            driven && t.gear >= 0 && v.sim.controls.brake > 0.1 && t.forwardSpeed > 0.3,
            driven && t.gear < 0,
            v.onFire || v.hazard || v.indicator < 0,
            v.onFire || v.hazard || v.indicator > 0,
            v.siren,
            this.barPhase,
          );
        }
      },
    };
  }

  dispose(): void {
    while (this.vehicles.length > 0) this.remove(this.vehicles[0]);
  }
}
