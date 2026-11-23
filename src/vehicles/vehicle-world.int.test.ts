import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildClipLibrary } from '../characters/anim/clip';
import { NpcManager } from '../characters/npc/npc-character';
import { randomAppearance } from '../characters/rig/appearance';
import { createCharacterMaterial } from '../characters/rig/character-mesh';
import { ANIMATION_CLIPS } from '../content/animations';
import { PARKING_RULES } from '../content/parking';
import { ALL_VEHICLES } from '../content/vehicles';
import { EventBus, type GameEvents } from '../core/events';
import { Rng } from '../core/rng';
import { World } from '../ecs/world';
import { PhysicsWorld } from '../physics/physics-world';
import { loadRapier, type Rapier } from '../physics/rapier';
import { ParticleSystem } from '../rendering/particles/particle-system';
import type { ParkingSpot } from '../world/gen/parking';
import { createBurntMaterial, createGlassMaterial, createPaintMaterial } from './body/vehicle-materials';
import { DAMAGE, VehicleDamage } from './damage/vehicle-damage';
import { ParkedVehicles } from './parked/parked-vehicles';
import type { VehicleDef } from './vehicle-def';
import { VehicleManager } from './vehicle-manager';

const DT = 1 / 60;
let rapier: Rapier;
beforeAll(async () => {
  rapier = await loadRapier();
});

function def(id: string): VehicleDef {
  const d = ALL_VEHICLES.find((v) => v.id === id);
  if (!d) throw new Error(id);
  return d;
}

function setup(): {
  physics: PhysicsWorld;
  manager: VehicleManager;
  damage: VehicleDamage;
  npcs: NpcManager;
  bus: EventBus<GameEvents>;
  events: string[];
  step: (seconds: number) => void;
} {
  const physics = new PhysicsWorld(rapier);
  physics.createFixedBox({ halfExtents: [400, 1, 400], position: [0, -1, 0] });
  physics.createFixedBox({ halfExtents: [10, 2, 0.5], position: [0, 2, 80] }); // crash wall
  physics.world.step();
  const world = new World(4096);
  const scene = new THREE.Scene();
  const water = { waterLevel: -20, isWater: () => false };
  const manager = new VehicleManager(
    physics,
    world,
    scene,
    {
      paint: createPaintMaterial(),
      glass: createGlassMaterial(),
      crackedGlass: createGlassMaterial(true),
      burnt: createBurntMaterial(),
      hidden: new THREE.MeshBasicMaterial({ visible: false }),
    },
    water,
  );
  const bus = new EventBus<GameEvents>();
  const events: string[] = [];
  for (const type of ['vehicle:impact', 'vehicle:onFire', 'vehicle:exploded', 'vehicle:damaged'] as const) {
    bus.on(type, () => events.push(type));
  }
  const damage = new VehicleDamage(
    physics,
    manager,
    scene,
    new ParticleSystem(64, false, 'smoke'),
    new ParticleSystem(64, true, 'glow'),
    bus,
    new Rng('test'),
  );
  const npcs = new NpcManager(
    physics,
    water,
    world,
    scene,
    buildClipLibrary(ANIMATION_CLIPS),
    createCharacterMaterial(),
  );
  const fixedVehicles = manager.createFixedSystem();
  const fixedDamage = damage.createFixedSystem();
  let tick = 0;
  const step = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      tick++;
      const ctx = { dt: DT, tick, time: tick * DT };
      fixedVehicles.fixedUpdate(ctx);
      physics.step();
      fixedDamage.fixedUpdate(ctx);
      bus.flush();
    }
  };
  return { physics, manager, damage, npcs, bus, events, step };
}

describe('vehicles in the world (Rapier)', () => {
  it('a parked car settles on its wheels, holds still and goes to sleep', () => {
    const { manager, step } = setup();
    const v = manager.spawn(def('meridian'), 0, 0.1, 0, 0);
    const start = v.sim.body.translation();
    const x0 = start.x;
    const z0 = start.z;
    step(4);
    const t = v.sim.body.translation();
    expect(Math.hypot(t.x - x0, t.z - z0)).toBeLessThan(0.05);
    expect(t.y).toBeGreaterThan(-0.05);
    expect(t.y).toBeLessThan(0.1);
    expect(v.sim.body.isSleeping()).toBe(true);
    expect(v.engineHealth).toBe(v.def.durability);
  });

  it('a hard crash dents the body and hurts the engine, but one crash is never fatal', () => {
    const { manager, step, events } = setup();
    const v = manager.spawn(def('meridian'), 0, 0.1, 0, 0);
    v.driver = 'player';
    v.sim.engineOn = true;
    v.sim.controls.throttle = 1;
    v.sim.controls.brake = 0;
    v.sim.controls.handbrake = false;
    step(8);
    expect(events).toContain('vehicle:impact');
    expect(v.view.hasOwnGeometry).toBe(true);
    expect(v.engineHealth).toBeLessThan(v.def.durability * 0.95);
    expect(v.engineHealth).toBeGreaterThanOrEqual(v.def.durability * (1 - DAMAGE.maxCrash) - 1);
    expect(v.wrecked).toBe(false);
    expect(v.view.glass).not.toBe('intact');
  });

  it('spawning on top of another vehicle does no damage (spawn grace)', () => {
    const { manager, step } = setup();
    const a = manager.spawn(def('brisa'), 30, 0.1, 0, 0);
    const b = manager.spawn(def('brisa'), 30.5, 0.6, 0.5, 0.3);
    step(1);
    expect(a.engineHealth).toBe(a.def.durability);
    expect(b.engineHealth).toBe(b.def.durability);
  });

  it('a burning engine explodes after the fuse; the blast pushes and damages neighbours', () => {
    const { manager, damage, step, events } = setup();
    const v = manager.spawn(def('meridian'), -40, 0.1, 0, 0);
    const near = manager.spawn(def('brisa'), -37, 0.1, 0, 0); // parked alongside
    const nearStart = near.sim.body.translation().x;
    const far = manager.spawn(def('brisa'), -40, 0.1, 60, 0);
    step(2);
    damage.damage(v, v.def.durability * 0.9);
    expect(v.onFire).toBe(true);
    step(DT);
    expect(events).toContain('vehicle:onFire');
    step(DAMAGE.fuse + 0.5);
    expect(v.wrecked).toBe(true);
    expect(damage.explosions).toBeGreaterThanOrEqual(1);
    expect(events).toContain('vehicle:exploded');
    expect(v.view.burnt).toBe(true);
    expect(near.engineHealth).toBeLessThan(near.def.durability * 0.6);
    expect(near.sim.body.translation().x).toBeGreaterThan(nearStart + 0.3); // shoved away
    expect(far.engineHealth).toBe(far.def.durability);
  });

  it('repair restores health, glass and dents', () => {
    const { manager, damage, step } = setup();
    const v = manager.spawn(def('meridian'), 0, 0.1, 0, 0);
    v.driver = 'player';
    v.sim.engineOn = true;
    v.sim.controls.throttle = 1;
    v.sim.controls.brake = 0;
    v.sim.controls.handbrake = false;
    step(8);
    damage.repair(v);
    expect(v.engineHealth).toBe(v.def.durability);
    expect(v.view.glass).toBe('intact');
  });

  it('parked vehicles: deterministic per spot, spawn near the centre within the budget, leave when far', () => {
    const { manager, physics, npcs, step } = setup();
    const spots: ParkingSpot[] = [];
    for (let i = 0; i < 40; i++)
      spots.push({ index: i, kind: 'curb', district: 'meridian', x: -100 + i * 7, y: 0, z: -60, yaw: 0 });
    const make = (): ParkedVehicles =>
      new ParkedVehicles(spots, ALL_VEHICLES, PARKING_RULES, manager, physics, npcs, 42, randomAppearance, {
        maxVehicles: 6,
        spawnRadius: 120,
        despawnRadius: 160,
        minSpawnDistance: 0,
      });
    const parked = make();
    const plans = spots.map((s) => parked.plan(s)?.def.id ?? null);
    expect(spots.map((s) => make().plan(s)?.def.id ?? null)).toEqual(plans);
    expect(plans.filter((p) => p !== null).length).toBeGreaterThan(5);
    for (let i = 0; i < 10; i++) parked.update(0, -60, 1);
    expect(parked.parkedCount).toBe(6);
    step(2);
    parked.update(5000, 5000, 1);
    expect(parked.parkedCount).toBe(0);
    expect(manager.vehicles).toHaveLength(0);
  });
});
