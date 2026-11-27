import type { NpcManager } from '../../characters/npc/npc-character';
import type { CharacterAppearance } from '../../characters/rig/appearance';
import { Rng } from '../../core/rng';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld } from '../../physics/physics-world';
import type { ParkingKind, ParkingSpot } from '../../world/gen/parking';
import type { DistrictId } from '../../world/gen/types';
import type { VehicleDef } from '../vehicle-def';
import type { VehicleInstance, VehicleManager } from '../vehicle-manager';

/** Which models park where, and how often spots are taken (content data). */
export interface ParkingRules {
  /** Model id weights per district (and for boats). */
  models: Readonly<Record<DistrictId | 'boat', Readonly<Record<string, number>>>>;
  /** Chance a spot of each kind holds a vehicle. */
  occupancy: Readonly<Record<ParkingKind, number>>;
  /** Chance a parked car is locked / has a driver at the wheel (carjack target). */
  locked: number;
  occupied: number;
}

export interface ParkedVehiclesOptions {
  maxVehicles: number;
  /** Spawn within this radius; despawn untouched ones beyond `despawnRadius`. */
  spawnRadius: number;
  despawnRadius: number;
  /** Do not pop vehicles into existence closer than this (after the initial fill). */
  minSpawnDistance: number;
}

const GROUND = interactionGroups(0xffff, Group.WORLD);
const CELL = 64;
/** Vehicles created per update (spreads the cost of building bodies and meshes over frames). */
const SPAWNS_PER_UPDATE = 2;

/**
 * Keeps the streets furnished: fills parking spots near the player with deterministic vehicles
 * (the same spot always gets the same car, colour, lock state), up to a budget, nearest first,
 * only once the ground collider under the spot has streamed in. Untouched vehicles far away are
 * removed; vehicles the player used are kept until much farther.
 */
export class ParkedVehicles {
  private readonly grid = new Map<string, ParkingSpot[]>();
  private readonly bySpot = new Map<number, VehicleInstance>();
  /** Spots whose car was taken: left empty until the player has gone away. */
  private readonly vacated = new Set<number>();
  private readonly hit = createRayHit();
  private readonly candidates: { spot: ParkingSpot; d2: number }[] = [];
  private initialFill = true;
  private timer = 0;

  constructor(
    private readonly spots: readonly ParkingSpot[],
    private readonly catalogue: readonly VehicleDef[],
    private readonly rules: ParkingRules,
    private readonly vehicles: VehicleManager,
    private readonly physics: PhysicsWorld,
    private readonly npcs: NpcManager,
    private readonly seed: number,
    private readonly appearance: (rng: Rng) => CharacterAppearance,
    private readonly options: ParkedVehiclesOptions,
  ) {
    for (const s of spots) {
      const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}`;
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(s);
    }
    vehicles.listeners.removed.push((v) => {
      if (v.spot >= 0 && this.bySpot.get(v.spot) === v) this.bySpot.delete(v.spot);
    });
  }

  get parkedCount(): number {
    return this.bySpot.size;
  }

  /** The vehicle a spot would hold (deterministic), or null if it stays empty. */
  plan(spot: ParkingSpot): { def: VehicleDef; colour: number; locked: boolean; occupied: boolean } | null {
    const rng = new Rng(`${this.seed}:park:${spot.index}`);
    if (!rng.chance(this.rules.occupancy[spot.kind])) return null;
    const table = this.rules.models[spot.kind === 'boat' ? 'boat' : (spot.district ?? 'meridian')];
    const entries = Object.entries(table);
    let total = 0;
    for (const [, w] of entries) total += w;
    let pick = rng.range(0, total);
    let id = entries[0]?.[0] ?? '';
    for (const [key, w] of entries) {
      pick -= w;
      if (pick <= 0) {
        id = key;
        break;
      }
    }
    const def = this.catalogue.find((d) => d.id === id);
    if (!def) return null;
    const colour = def.colours[rng.int(0, def.colours.length)];
    const land = spot.kind !== 'boat' && def.kind === 'car';
    return {
      def,
      colour,
      locked: land && rng.chance(this.rules.locked),
      occupied: spot.kind === 'curb' && def.kind === 'car' && rng.chance(this.rules.occupied),
    };
  }

  /** Call every frame with the streaming centre; does the work a few times a second. */
  update(x: number, z: number, dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.despawnFar(x, z);
    this.spawnNear(x, z);
  }

  private despawnFar(x: number, z: number): void {
    const far2 = this.options.despawnRadius ** 2;
    for (const v of [...this.vehicles.vehicles]) {
      // Traffic manages its own vehicles.
      if (v.driver === 'player' || v.owner === 'traffic') continue;
      const t = v.sim.body.translation();
      const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
      const limit = v.persistent ? far2 * 4 : far2;
      if (d2 <= limit) continue;
      if (v.occupant) {
        this.npcs.remove(v.occupant);
        v.occupant = null;
      }
      if (v.spot >= 0) this.bySpot.delete(v.spot);
      this.vehicles.remove(v);
    }
    // Forget vacated spots once the player is far from them.
    for (const index of this.vacated) {
      const s = this.spots[index];
      if (s && (s.x - x) ** 2 + (s.z - z) ** 2 > far2) this.vacated.delete(index);
    }
    // A parked car that moved away from its spot no longer counts as parked there.
    for (const [index, v] of this.bySpot) {
      const s = this.spots[index];
      const t = v.sim.body.translation();
      if (s && (t.x - s.x) ** 2 + (t.z - s.z) ** 2 > 25) {
        this.bySpot.delete(index);
        this.vacated.add(index);
        v.persistent = true;
      }
    }
  }

  private spawnNear(x: number, z: number): void {
    const { spawnRadius, minSpawnDistance, maxVehicles } = this.options;
    const r = spawnRadius;
    this.candidates.length = 0;
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const cell = this.grid.get(`${cx},${cz}`);
        if (!cell) continue;
        for (const s of cell) {
          if (this.bySpot.has(s.index) || this.vacated.has(s.index)) continue;
          const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d2 > r * r) continue;
          if (!this.initialFill && d2 < minSpawnDistance * minSpawnDistance) continue;
          this.candidates.push({ spot: s, d2 });
        }
      }
    }
    this.candidates.sort((a, b) => a.d2 - b.d2);
    let spawned = 0;
    for (const { spot } of this.candidates) {
      if (this.bySpot.size >= maxVehicles || spawned >= SPAWNS_PER_UPDATE) break;
      const plan = this.plan(spot);
      if (!plan) {
        this.vacated.add(spot.index);
        continue;
      }
      // Wait for the streamed ground under the spot (boats float on the water level).
      let y = spot.y;
      if (spot.kind !== 'boat') {
        if (!this.physics.castRay(spot.x, spot.y + 4, spot.z, 0, -1, 0, 10, this.hit, GROUND)) continue;
        y = this.hit.y;
      }
      const v = this.vehicles.spawn(
        plan.def,
        spot.x,
        y + (spot.kind === 'boat' ? -0.3 : 0.05),
        spot.z,
        spot.yaw,
        {
          colour: plan.colour,
          locked: plan.locked,
          spot: spot.index,
          engineOn: plan.occupied,
          owner: 'parked',
        },
      );
      if (plan.occupied) this.seatDriver(v, spot);
      this.bySpot.set(spot.index, v);
      spawned++;
    }
    if (this.candidates.length === 0 || spawned < SPAWNS_PER_UPDATE) this.initialFill = false;
  }

  private seatDriver(v: VehicleInstance, spot: ParkingSpot): void {
    const rng = new Rng(`${this.seed}:driver:${spot.index}`);
    const npc = this.npcs.spawn(this.appearance(rng), spot.x, spot.y + 1, spot.z);
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
    v.driver = 'npc';
  }
}
