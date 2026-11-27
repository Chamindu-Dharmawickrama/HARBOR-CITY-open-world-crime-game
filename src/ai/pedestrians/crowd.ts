import type { NpcCharacter, NpcManager } from '../../characters/npc/npc-character';
import type { CharacterAppearance } from '../../characters/rig/appearance';
import type { EventBus, GameEvents } from '../../core/events';
import { Rng } from '../../core/rng';
import { SpatialHash2D } from '../../core/spatial-hash';
import type { FixedContext, FixedSystem } from '../../ecs/scheduler';
import type { TransformStore } from '../../ecs/transform';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld } from '../../physics/physics-world';
import type { VehicleInstance, VehicleManager } from '../../vehicles/vehicle-manager';
import type { Crosswalk, DistrictId } from '../../world/gen/types';
import { Walk, type WalkState } from '../traffic/signals';
import type { TrafficView } from '../traffic/traffic-manager';
import type { PoiKind, SidewalkNav } from './sidewalk-nav';

export type ArchetypeId = 'commuter' | 'shopper' | 'jogger' | 'dockWorker' | 'nightCrowd';

/** How a kind of pedestrian behaves (content data). */
export interface Archetype {
  id: ArchetypeId;
  /** Walking (or running) speed range, m/s. */
  speed: readonly [number, number];
  /** Where they go. */
  destinations: readonly PoiKind[];
  /** Seconds spent at a destination. */
  dwell: readonly [number, number];
  /** Chance of walking with a companion. */
  group: number;
}

export interface CrowdOptions {
  maxPeds: number;
  spawnMin: number;
  spawnMax: number;
  despawn: number;
}

export interface CrowdPlayer {
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  onFoot: boolean;
}

export interface CrowdDeps {
  nav: SidewalkNav;
  npcs: NpcManager;
  vehicles: VehicleManager;
  physics: PhysicsWorld;
  bus: EventBus<GameEvents>;
  seed: number;
  archetypes: Readonly<Record<ArchetypeId, Archetype>>;
  /** Picks an archetype for a district at a time of day. */
  pickArchetype: (district: DistrictId | null, rng: Rng) => ArchetypeId;
  appearance: (rng: Rng, archetype: ArchetypeId) => CharacterAppearance;
  /** Pedestrian signal for a crosswalk (null when it has none). */
  walkSignal: (crosswalk: Crosswalk) => WalkState | null;
  view: () => TrafficView;
  target: () => number;
  player: () => CrowdPlayer | null;
}

type PedState = 'walk' | 'wait' | 'dwell' | 'flee' | 'cower' | 'evade' | 'down' | 'route';

/** One pedestrian of the crowd. */
export class Pedestrian {
  path: number[] = [];
  /** Current link: path[index] → path[index + 1], metres along it. */
  index = 0;
  along = 0;
  /** Lateral offset from the sidewalk centre line (+ = right of travel), and where it eases to. */
  side = 0;
  sideTarget = 0;
  speed: number;
  state: PedState = 'route';
  timer = 0;
  /** Crosswalk being crossed (−1) and whether it was started on a walk signal. */
  crossing = -1;
  readonly pos = { x: 0, y: 0, z: 0 };
  yaw = 0;
  vx = 0;
  vz = 0;
  leader: Pedestrian | null = null;
  readonly threat = { x: 0, z: 0 };
  readonly evadeDir = { x: 0, z: 0 };
  groundY = 0;
  slot: number;
  private readonly rayPhase: number;

  constructor(
    readonly npc: NpcCharacter,
    readonly archetype: Archetype,
    readonly rng: Rng,
    slot: number,
  ) {
    this.speed = rng.range(archetype.speed[0], archetype.speed[1]);
    this.slot = slot;
    this.side = rng.range(-0.6, 0.6);
    this.sideTarget = this.side;
    this.rayPhase = slot & 1;
  }

  /** Every other tick (alternating between pedestrians) the ground is probed. */
  probeThisTick(tick: number): boolean {
    return ((tick + this.rayPhase) & 1) === 0;
  }
}

export interface CrowdStats {
  spawned: number;
  despawned: number;
  /** Signalled crossings started on WALK (and, against the signal, only while fleeing). */
  walkCrossings: number;
  signalViolations: number;
  unsignalledCrossings: number;
  panics: number;
  hitByVehicle: number;
  killed: number;
  dodges: number;
  gotUp: number;
}

const GROUND = interactionGroups(0xffff, Group.WORLD);
const MAX_SIDE = 0.9;
const PATHS_PER_TICK = 3;
const PANIC_RADIUS = 55;
const KNOCK_SPEED = 3.5;

/**
 * Sidewalk crowds: a density-driven number of pedestrians around the camera with routines per
 * archetype (commuters, shoppers, joggers, dock workers, night crowds) walking A* routes between
 * places, keeping right and stepping around each other (spatial hash), walking in pairs, crossing
 * on WALK signals or when the road is clear, panicking and fleeing from gunshots and explosions,
 * jumping out of the way of speeding cars, and ragdolling when a vehicle hits them.
 */
export class Crowd {
  readonly peds: Pedestrian[] = [];
  readonly stats: CrowdStats = {
    spawned: 0,
    despawned: 0,
    walkCrossings: 0,
    signalViolations: 0,
    unsignalledCrossings: 0,
    panics: 0,
    hitByVehicle: 0,
    killed: 0,
    dodges: 0,
    gotUp: 0,
  };
  enabled = true;
  private readonly hash: SpatialHash2D;
  private readonly byNpc = new Map<NpcCharacter, Pedestrian>();
  private readonly bySlot: (Pedestrian | undefined)[] = [];
  private readonly freeSlots: number[] = [];
  private readonly rng: Rng;
  private readonly found: number[] = [];
  private readonly nodes: number[] = [];
  private readonly hit = createRayHit();
  private readonly transforms: TransformStore;
  private spawnTimer = 0;
  private pathBudget = 0;
  private fillTime = 0;
  private tick = 0;
  private readonly local = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly deps: CrowdDeps,
    readonly options: CrowdOptions,
  ) {
    this.rng = new Rng(`${deps.seed}:crowd`);
    const capacity = Math.max(8, options.maxPeds * 2 + 16);
    this.hash = new SpatialHash2D(4, capacity);
    for (let i = capacity - 1; i >= 0; i--) this.freeSlots.push(i);
    this.transforms = deps.npcs.transformStore;
    deps.npcs.listeners.removed.push((npc) => {
      const ped = this.byNpc.get(npc);
      if (ped) this.forget(ped);
    });
    deps.bus.on('combat:shot', ({ x, z }) => this.panic(x, z, PANIC_RADIUS));
    deps.bus.on('vehicle:exploded', ({ x, z }) => this.panic(x, z, PANIC_RADIUS));
  }

  get count(): number {
    return this.peds.length;
  }

  createSystem(): FixedSystem {
    return { name: 'crowd', phase: 'ai', fixedUpdate: (ctx) => this.fixedUpdate(ctx) };
  }

  /** Removes everyone (debug / tests). */
  clear(): void {
    for (const p of [...this.peds]) this.despawn(p);
  }

  /** Scares everyone within `radius` of (x, z). Returns how many panicked. */
  panic(x: number, z: number, radius: number): number {
    let n = 0;
    for (const p of this.peds) {
      if (p.npc.knockedDown || p.state === 'down') continue;
      const d2 = (p.pos.x - x) ** 2 + (p.pos.z - z) ** 2;
      if (d2 > radius * radius) continue;
      p.threat.x = x;
      p.threat.z = z;
      if (d2 < 100 && p.rng.chance(0.35)) {
        p.state = 'cower';
        p.timer = p.rng.range(1.5, 3.5);
        p.npc.animator.flinch(1);
      } else this.startFleeing(p);
      n++;
    }
    if (n > 0) {
      this.stats.panics += n;
      this.deps.bus.emit('ped:panicked', { count: n, x, z });
    }
    return n;
  }

  /** People (and bodies) traffic must not drive into. */
  forEachObstacle(visit: (x: number, z: number, vx: number, vz: number) => void): void {
    for (const p of this.peds) visit(p.pos.x, p.pos.z, p.vx, p.vz);
  }

  private fixedUpdate(ctx: FixedContext): void {
    const dt = ctx.dt;
    this.tick++;
    if (!this.enabled) {
      if (this.peds.length > 0) this.clear();
      return;
    }
    this.fillTime += dt;
    this.pathBudget = PATHS_PER_TICK;
    const view = this.deps.view();
    for (const p of this.peds) this.hash.insertPoint(p.slot, p.pos.x, p.pos.z);
    const player = this.deps.player();
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      this.updatePed(p, dt, player);
    }
    this.vehicleHits();
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.despawnFar(view);
      this.spawnNear(view);
      this.animationLod(view);
    }
  }

  // ---- one pedestrian --------------------------------------------------------------------------

  private updatePed(p: Pedestrian, dt: number, player: CrowdPlayer | null): void {
    const npc = p.npc;
    if (npc.knockedDown) {
      this.updateDown(p);
      return;
    }
    if (!npc.driven) return; // running on its own motor (pulled out of a car)
    p.timer -= dt;
    switch (p.state) {
      case 'route':
        if (this.pathBudget > 0) this.route(p);
        this.place(p, 0, dt);
        return;
      case 'dwell':
        if (p.timer <= 0) p.state = 'route';
        this.place(p, 0, dt);
        return;
      case 'cower':
        if (p.timer <= 0) this.startFleeing(p);
        this.place(p, 0, dt);
        return;
      case 'wait':
        this.waitAtKerb(p, dt);
        return;
      case 'evade':
        this.evade(p, dt);
        return;
      case 'walk':
      case 'flee':
        this.walk(p, dt, player);
        return;
      case 'down':
        return;
    }
  }

  /** Picks a destination for the archetype and finds a route there (A*, budgeted per tick). */
  private route(p: Pedestrian): void {
    const nav = this.deps.nav;
    const start = this.currentNode(p);
    if (start < 0) {
      p.state = 'dwell';
      p.timer = 2;
      return;
    }
    let goal = -1;
    for (let attempt = 0; attempt < 6 && goal < 0; attempt++) {
      if (p.archetype.id === 'jogger' || p.archetype.destinations.length === 0) {
        nav.nodesNear(nav.x[start], nav.z[start], 260, this.nodes);
        const c = this.nodes[p.rng.int(0, Math.max(1, this.nodes.length))] ?? -1;
        if (c >= 0 && nav.distance(start, c) > 100) goal = c;
        continue;
      }
      const kind = p.archetype.destinations[p.rng.int(0, p.archetype.destinations.length)];
      const list = nav.poisByKind.get(kind) ?? [];
      if (list.length === 0) continue;
      // Sample a few places and take one at a walkable distance.
      for (let k = 0; k < 8; k++) {
        const poi = nav.pois[list[p.rng.int(0, list.length)]];
        const d = nav.distance(start, poi.node);
        if (d > 40 && d < 420) {
          goal = poi.node;
          break;
        }
      }
    }
    if (goal < 0) {
      nav.nodesNear(nav.x[start], nav.z[start], 140, this.nodes);
      goal = this.nodes[p.rng.int(0, Math.max(1, this.nodes.length))] ?? -1;
    }
    this.pathBudget--;
    if (goal < 0 || !nav.findPath(start, goal, p.path, 5000) || p.path.length < 2) {
      p.state = 'dwell';
      p.timer = p.rng.range(1, 3);
      return;
    }
    p.index = 0;
    p.along = 0;
    p.state = 'walk';
    p.crossing = -1;
  }

  private startFleeing(p: Pedestrian): void {
    const nav = this.deps.nav;
    const start = this.currentNode(p);
    p.state = 'flee';
    p.timer = p.rng.range(10, 15);
    p.crossing = -1;
    if (start < 0) return;
    // Run to the reachable spot farthest from the threat among a handful of candidates.
    nav.nodesNear(nav.x[start], nav.z[start], 90, this.nodes);
    let best = -1;
    let bestD = -1;
    for (let k = 0; k < 14 && this.nodes.length > 0; k++) {
      const c = this.nodes[p.rng.int(0, this.nodes.length)];
      const d = (nav.x[c] - p.threat.x) ** 2 + (nav.z[c] - p.threat.z) ** 2;
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best >= 0 && nav.findPath(start, best, p.path, 3000) && p.path.length >= 2) {
      p.index = 0;
      p.along = 0;
    } else {
      // Nowhere to go along the sidewalks: dodge straight away from the threat.
      const dx = p.pos.x - p.threat.x;
      const dz = p.pos.z - p.threat.z;
      const len = Math.hypot(dx, dz) || 1;
      p.evadeDir.x = dx / len;
      p.evadeDir.z = dz / len;
      p.state = 'evade';
      p.timer = 1.2;
    }
  }

  private currentNode(p: Pedestrian): number {
    if (p.path.length >= 2 && p.index < p.path.length - 1) {
      const a = p.path[p.index];
      const b = p.path[p.index + 1];
      const len = this.deps.nav.distance(a, b);
      return p.along > len / 2 ? b : a;
    }
    if (p.path.length > 0 && p.index < p.path.length) return p.path[Math.min(p.index, p.path.length - 1)];
    return this.deps.nav.nearest(p.pos.x, p.pos.z, 30);
  }

  private walk(p: Pedestrian, dt: number, player: CrowdPlayer | null): void {
    const nav = this.deps.nav;
    if (p.index >= p.path.length - 1) {
      this.arrive(p);
      return;
    }
    if (p.state === 'flee' && p.timer <= 0) p.state = 'walk';
    const fleeing = p.state === 'flee';
    const a = p.path[p.index];
    const b = p.path[p.index + 1];
    const len = Math.max(0.01, nav.distance(a, b));
    // About to step onto a crosswalk: check the signal or the traffic.
    if (p.along === 0 && p.crossing < 0) {
      const cw = nav.crossing(a, b);
      if (cw >= 0 && !fleeing && !this.mayCross(nav.crosswalks[cw], a, b)) {
        p.state = 'wait';
        p.crossing = -1;
        p.timer = 0;
        this.place(p, 0, dt);
        return;
      }
      if (cw >= 0) this.beginCrossing(p, cw, fleeing);
    }
    let speed = fleeing ? Math.max(p.speed * 2.2, 5.6) : p.speed;
    if (p.leader && !fleeing) {
      // Keep pace with the companion: a step behind, beside them.
      speed = Math.min(p.leader.speed * 1.25, Math.max(0, speed));
    }
    speed *= this.avoidance(p, player, a, b);
    p.along += speed * dt;
    if (p.along >= len) {
      p.along -= len;
      p.index++;
      p.crossing = -1;
      if (p.index >= p.path.length - 1) {
        p.along = 0;
        this.place(p, speed, dt);
        this.arrive(p);
        return;
      }
      p.along = 0; // stop at each node: the next link may be a crosswalk to check
    }
    this.place(p, speed, dt);
  }

  private arrive(p: Pedestrian): void {
    p.path.length = 0;
    p.index = 0;
    p.along = 0;
    if (p.state === 'flee' && p.timer > 0) {
      this.startFleeing(p);
      return;
    }
    p.state = 'dwell';
    p.timer = p.rng.range(p.archetype.dwell[0], p.archetype.dwell[1]);
  }

  /** May this pedestrian step off the kerb now? */
  private mayCross(cw: Crosswalk, a: number, b: number): boolean {
    const signal = this.deps.walkSignal(cw);
    if (signal !== null) {
      if (signal !== Walk.walk) return false;
      // Even on WALK, do not step in front of a car still coming through.
      return !this.vehicleApproaching(a, b, 2.2);
    }
    return !this.vehicleApproaching(a, b, 4.5);
  }

  private beginCrossing(p: Pedestrian, cw: number, fleeing: boolean): void {
    const crosswalk = this.deps.nav.crosswalks[cw];
    p.crossing = cw;
    if (!crosswalk.signalized) {
      this.stats.unsignalledCrossings++;
      return;
    }
    const signal = this.deps.walkSignal(crosswalk);
    if (signal === Walk.walk) this.stats.walkCrossings++;
    else if (fleeing) this.stats.signalViolations++;
  }

  /** A vehicle will reach the crossing a→b within `seconds` (or is standing on it). */
  private vehicleApproaching(a: number, b: number, seconds: number): boolean {
    const nav = this.deps.nav;
    const mx = (nav.x[a] + nav.x[b]) / 2;
    const mz = (nav.z[a] + nav.z[b]) / 2;
    for (const v of this.deps.vehicles.vehicles) {
      const t = v.sim.body.translation();
      const dx = mx - t.x;
      const dz = mz - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 40 * 40) continue;
      const d = Math.sqrt(d2);
      if (d < v.def.length / 2 + 2.5 && v.sim.speed > 0.5) return true;
      const lv = v.sim.body.linvel();
      const closing = (lv.x * dx + lv.z * dz) / Math.max(0.01, d);
      if (closing > 1.5 && d / closing < seconds) return true;
    }
    return false;
  }

  private waitAtKerb(p: Pedestrian, dt: number): void {
    const nav = this.deps.nav;
    const a = p.path[p.index];
    const b = p.path[p.index + 1];
    if (a === undefined || b === undefined) {
      p.state = 'route';
      return;
    }
    // Stand back from the kerb, facing the road.
    this.place(p, 0, dt, nav.x[b] - nav.x[a], nav.z[b] - nav.z[a]);
    if (p.timer > 0) return;
    p.timer = 0.25;
    const cw = nav.crossing(a, b);
    if (cw < 0 || this.mayCross(nav.crosswalks[cw], a, b)) {
      p.state = 'walk';
      if (cw >= 0) this.beginCrossing(p, cw, false);
    }
  }

  /** Lateral stepping and slowing for people (and the player) ahead; returns a speed factor. */
  private avoidance(p: Pedestrian, player: CrowdPlayer | null, a: number, b: number): number {
    const nav = this.deps.nav;
    const dx = nav.x[b] - nav.x[a];
    const dz = nav.z[b] - nav.z[a];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    let factor = 1;
    let push = 0;
    const consider = (ox: number, oz: number, ovx: number, ovz: number): void => {
      const rx = ox - p.pos.x;
      const rz = oz - p.pos.z;
      const ahead = rx * fx + rz * fz;
      const lateral = rx * -fz + rz * fx; // + = to my right
      if (ahead < -0.4 || ahead > 2.2 || Math.abs(lateral) > 1.1) return;
      const oncoming = ovx * fx + ovz * fz < -0.3;
      // Step to the side away from them (oncoming people pass on the right).
      push += oncoming ? -0.6 : lateral > 0 ? -0.5 : 0.5;
      if (ahead > 0 && Math.abs(lateral) < 0.65) factor = Math.min(factor, ahead < 0.9 ? 0.25 : 0.6);
    };
    this.hash.queryRadius(p.pos.x, p.pos.z, 2.4, this.found);
    for (const slot of this.found) {
      if (slot === p.slot) continue;
      const o = this.bySlot[slot];
      if (!o || o === p.leader) continue;
      consider(o.pos.x, o.pos.z, o.vx, o.vz);
    }
    if (player?.onFoot) {
      consider(player.x, player.z, player.vx, player.vz);
      const d2 = (player.x - p.pos.x) ** 2 + (player.z - p.pos.z) ** 2;
      // Bumped by a sprinting player: a startled flinch.
      if (d2 < 0.6 && player.speed > 4.5) p.npc.animator.flinch(0.6);
    }
    if (p.leader) p.sideTarget = Math.max(-MAX_SIDE, Math.min(MAX_SIDE, p.leader.side + 0.75));
    else if (push !== 0) p.sideTarget = Math.max(-MAX_SIDE, Math.min(MAX_SIDE, p.side + push));
    return factor;
  }

  /** Sets the pedestrian's pose from its path position (or holds it there). */
  private place(p: Pedestrian, speed: number, dt: number, faceX?: number, faceZ?: number): void {
    const nav = this.deps.nav;
    let x = p.pos.x;
    let z = p.pos.z;
    let yaw = p.yaw;
    if (p.path.length >= 2 && p.index < p.path.length - 1) {
      const a = p.path[p.index];
      const b = p.path[p.index + 1];
      const dx = nav.x[b] - nav.x[a];
      const dz = nav.z[b] - nav.z[a];
      const len = Math.hypot(dx, dz) || 1;
      const t = Math.min(1, p.along / len);
      const step = Math.min(1, dt * 2.5);
      p.side += (p.sideTarget - p.side) * step;
      const crossing = p.crossing >= 0;
      const side = crossing ? p.side * 0.5 : p.side;
      x = nav.x[a] + dx * t - (dz / len) * side;
      z = nav.z[a] + dz * t + (dx / len) * side;
      if (speed > 0.05) yaw = Math.atan2(dx, dz);
      p.groundY = nav.y[a] + (nav.y[b] - nav.y[a]) * t - (crossing && t > 0.25 && t < 0.75 ? 0.15 : 0);
    }
    if (faceX !== undefined && faceZ !== undefined) yaw = Math.atan2(faceX, faceZ);
    let y = p.groundY;
    if (p.probeThisTick(this.tick)) {
      if (this.deps.physics.castRay(x, y + 1.2, z, 0, -1, 0, 2.6, this.hit, GROUND)) p.groundY = this.hit.y;
      y = p.groundY;
    }
    p.vx = dt > 0 ? (x - p.pos.x) / dt : 0;
    p.vz = dt > 0 ? (z - p.pos.z) / dt : 0;
    p.pos.x = x;
    p.pos.y = y;
    p.pos.z = z;
    p.yaw = turnToward(p.yaw, yaw, dt * 8);
    p.npc.moveTo(x, y, z, p.yaw, speed, dt, this.transforms);
  }

  /** A quick sideways jump (out of a car's way, or away from a threat when trapped). */
  private evade(p: Pedestrian, dt: number): void {
    const speed = 4.5;
    const x = p.pos.x + p.evadeDir.x * speed * dt;
    const z = p.pos.z + p.evadeDir.z * speed * dt;
    p.vx = p.evadeDir.x * speed;
    p.vz = p.evadeDir.z * speed;
    p.pos.x = x;
    p.pos.z = z;
    if (
      p.probeThisTick(this.tick) &&
      this.deps.physics.castRay(x, p.pos.y + 1.2, z, 0, -1, 0, 2.6, this.hit, GROUND)
    )
      p.groundY = this.hit.y;
    p.pos.y = p.groundY;
    p.yaw = turnToward(p.yaw, Math.atan2(p.evadeDir.x, p.evadeDir.z), dt * 10);
    p.npc.moveTo(x, p.pos.y, z, p.yaw, speed, dt, this.transforms);
    if (p.timer <= 0) {
      p.path.length = 0;
      p.threat.x = p.pos.x - p.evadeDir.x * 10;
      p.threat.z = p.pos.z - p.evadeDir.z * 10;
      this.startFleeing(p);
      if (p.state === 'evade') p.state = 'route';
    }
  }

  private updateDown(p: Pedestrian): void {
    const npc = p.npc;
    p.vx = 0;
    p.vz = 0;
    if (npc.ragdoll) {
      npc.ragdoll.pelvis(this.local);
      p.pos.x = this.local.x;
      p.pos.z = this.local.z;
      return;
    }
    p.pos.x = npc.downRoot.x;
    p.pos.z = npc.downRoot.z;
    if (npc.state === 'down' && npc.timer <= 0) {
      npc.getUp();
      this.stats.gotUp++;
    } else if (npc.state === 'idle') {
      // Back on their feet: run from whatever hit them, along the sidewalks again.
      npc.driven = true;
      p.path.length = 0;
      p.groundY = npc.downRoot.y;
      p.pos.y = npc.downRoot.y;
      p.yaw = npc.downRoot.yaw;
      this.startFleeing(p);
    }
  }

  // ---- vehicles ---------------------------------------------------------------------------------

  /** Vehicles hitting pedestrians (ragdoll, or a shove at low speed) and people dodging speeders. */
  private vehicleHits(): void {
    for (const v of this.deps.vehicles.vehicles) {
      const speed = v.sim.speed;
      if (speed < 1.2) continue;
      const t = v.sim.body.translation();
      const reach = v.def.length / 2 + 2.5 + speed * 0.9;
      this.hash.queryRadius(t.x, t.z, reach, this.found);
      if (this.found.length === 0) continue;
      const q = v.sim.body.rotation();
      // Body axes: forward (+Z), left (+X).
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
      const lz = 2 * (q.x * q.z - q.w * q.y);
      const front = v.def.length - v.def.rearOverhang - v.def.wheelbase / 2;
      const rear = v.def.rearOverhang + v.def.wheelbase / 2;
      const half = v.def.width / 2;
      const lv = v.sim.body.linvel();
      for (const slot of this.found) {
        const p = this.bySlot[slot];
        if (!p || p.npc.knockedDown || !p.npc.driven) continue;
        const rx = p.pos.x - t.x;
        const rz = p.pos.z - t.z;
        const along = rx * fx + rz * fz;
        const across = rx * lx + rz * lz;
        const dy = p.pos.y - t.y;
        if (
          along < front + 0.35 &&
          along > -rear - 0.35 &&
          Math.abs(across) < half + 0.32 &&
          dy > -1 &&
          dy < v.def.height
        ) {
          this.struck(p, v, lv.x, lv.y, lv.z, speed, across);
          continue;
        }
        // Speeding toward them — and they can see it coming: jump aside.
        const sees = -(rx * Math.sin(p.yaw) + rz * Math.cos(p.yaw)) > -0.3 * Math.hypot(rx, rz);
        if (speed > 6 && along > front && p.state !== 'evade' && sees) {
          const tta = (along - front) / speed;
          if (tta < 1.1 && Math.abs(across) < half + 0.9) {
            const away = across >= 0 ? 1 : -1;
            p.evadeDir.x = lx * away;
            p.evadeDir.z = lz * away;
            p.state = 'evade';
            p.timer = 0.65;
            p.path.length = 0;
            this.stats.dodges++;
          }
        }
      }
    }
  }

  private struck(
    p: Pedestrian,
    v: VehicleInstance,
    vx: number,
    vy: number,
    vz: number,
    speed: number,
    across: number,
  ): void {
    const npc = p.npc;
    if (speed > KNOCK_SPEED) {
      // Thrown: most of the vehicle's velocity plus a lift that grows with the speed.
      const damage = speed * speed * 0.8;
      npc.health = Math.max(0, npc.health - damage);
      npc.driven = false;
      p.state = 'down';
      this.deps.npcs.knockDown(npc, vx * 0.85, vy + 1.2 + speed * 0.12, vz * 0.85);
      this.stats.hitByVehicle++;
      if (!npc.alive) this.stats.killed++;
      this.deps.bus.emit('ped:hitByVehicle', { vehicle: v.id, speed, killed: !npc.alive });
      return;
    }
    // A nudge: stumble aside and run.
    npc.animator.flinch(0.8);
    const q = v.sim.body.rotation();
    const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const lz = 2 * (q.x * q.z - q.w * q.y);
    const away = across >= 0 ? 1 : -1;
    p.evadeDir.x = lx * away;
    p.evadeDir.z = lz * away;
    p.state = 'evade';
    p.timer = 0.5;
    p.path.length = 0;
  }

  // ---- population -------------------------------------------------------------------------------

  private spawnNear(view: TrafficView): void {
    const o = this.options;
    const target = Math.min(o.maxPeds, this.deps.target());
    if (this.peds.length >= target || this.freeSlots.length < 2) return;
    const nav = this.deps.nav;
    const initial = this.fillTime < 6;
    nav.nodesNear(view.x, view.z, o.spawnMax, this.nodes);
    if (this.nodes.length === 0) return;
    let spawned = 0;
    for (let attempt = 0; attempt < 10 && spawned < (initial ? 4 : 2); attempt++) {
      if (this.peds.length >= target) break;
      const node = this.nodes[this.rng.int(0, this.nodes.length)];
      const dx = nav.x[node] - view.x;
      const dz = nav.z[node] - view.z;
      const d = Math.hypot(dx, dz);
      if (d < (initial ? 6 : o.spawnMin)) continue;
      const visible = d > 1 && (dx * view.fx + dz * view.fz) / d > view.cosHalfFov;
      if (!initial && visible && d < o.spawnMax * 0.8) continue;
      // Not on top of someone.
      this.hash.queryRadius(nav.x[node], nav.z[node], 2, this.found);
      if (this.found.length > 0) continue;
      const leader = this.spawnAt(node, null);
      spawned++;
      if (
        leader &&
        leader.archetype.group > 0 &&
        this.rng.chance(leader.archetype.group) &&
        this.peds.length < target
      )
        this.spawnAt(node, leader);
    }
  }

  private spawnAt(node: number, leader: Pedestrian | null): Pedestrian | null {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const nav = this.deps.nav;
    const rng = new Rng(`${this.deps.seed}:ped:${this.stats.spawned}`);
    const id = leader?.archetype.id ?? this.deps.pickArchetype(nav.district[node], rng);
    const archetype = this.deps.archetypes[id];
    const npc = this.deps.npcs.spawn(this.deps.appearance(rng, id), nav.x[node], nav.y[node], nav.z[node]);
    npc.driven = true;
    npc.state = 'walk';
    const p = new Pedestrian(npc, archetype, rng, slot);
    p.pos.x = nav.x[node] + (leader ? 0.6 : 0);
    p.pos.y = nav.y[node];
    p.pos.z = nav.z[node];
    p.groundY = nav.y[node];
    p.yaw = rng.range(-Math.PI, Math.PI);
    if (leader) {
      p.leader = leader;
      p.path = leader.path;
      p.index = leader.index;
      p.state = leader.state === 'walk' ? 'walk' : 'route';
    }
    this.peds.push(p);
    this.bySlot[slot] = p;
    this.byNpc.set(npc, p);
    this.hash.insertPoint(slot, p.pos.x, p.pos.z);
    this.stats.spawned++;
    npc.moveTo(p.pos.x, p.pos.y, p.pos.z, p.yaw, 0, 1 / 60, this.transforms);
    return p;
  }

  private despawnFar(view: TrafficView): void {
    const o = this.options;
    const target = Math.min(o.maxPeds, this.deps.target());
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const dx = p.pos.x - view.x;
      const dz = p.pos.z - view.z;
      const d = Math.hypot(dx, dz);
      const visible = d > 1 && (dx * view.fx + dz * view.fz) / d > view.cosHalfFov;
      let remove = d > o.despawn;
      if (!remove && !visible && d > o.spawnMin && this.peds.length > target + 2 && !p.npc.knockedDown)
        remove = true;
      if (!remove && p.npc.state === 'dead' && !visible && d > 30) remove = true;
      if (remove) this.despawn(p);
    }
  }

  private animationLod(view: TrafficView): void {
    for (const p of this.peds) {
      const dx = p.pos.x - view.x;
      const dz = p.pos.z - view.z;
      const d = Math.hypot(dx, dz);
      const behind = d > 12 && (dx * view.fx + dz * view.fz) / d < 0;
      p.npc.animStride = behind ? 6 : d < 35 ? 1 : d < 70 ? 2 : 4;
    }
  }

  private despawn(p: Pedestrian): void {
    this.deps.npcs.remove(p.npc);
    this.stats.despawned++;
  }

  private forget(p: Pedestrian): void {
    const i = this.peds.indexOf(p);
    if (i < 0) return;
    this.peds.splice(i, 1);
    this.byNpc.delete(p.npc);
    this.hash.remove(p.slot);
    this.bySlot[p.slot] = undefined;
    this.freeSlots.push(p.slot);
    for (const o of this.peds) if (o.leader === p) o.leader = null;
  }

  /** Takes over an NPC that is standing around (a driver who fled their car) as a pedestrian. */
  adopt(npc: NpcCharacter, archetype: ArchetypeId): boolean {
    if (this.byNpc.has(npc) || this.freeSlots.length === 0) return false;
    const pos = npc.motor.position;
    const node = this.deps.nav.nearest(pos.x, pos.z, 30);
    if (node < 0) return false;
    const slot = this.freeSlots.pop() as number;
    const p = new Pedestrian(
      npc,
      this.deps.archetypes[archetype],
      new Rng(`${this.deps.seed}:adopt:${slot}:${this.tick}`),
      slot,
    );
    p.pos.x = pos.x;
    p.pos.y = pos.y;
    p.pos.z = pos.z;
    p.groundY = pos.y;
    p.yaw = npc.motor.yaw;
    // Walk straight over to the sidewalk, then on as usual.
    p.path = [node, node];
    p.state = 'route';
    npc.driven = true;
    npc.state = 'walk';
    this.peds.push(p);
    this.bySlot[slot] = p;
    this.byNpc.set(npc, p);
    this.hash.insertPoint(slot, p.pos.x, p.pos.z);
    return true;
  }

  /** Counts by state for probes. */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.peds) {
      const key = p.npc.knockedDown ? p.npc.state : p.state;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
}

function turnToward(current: number, target: number, maxStep: number): number {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}
