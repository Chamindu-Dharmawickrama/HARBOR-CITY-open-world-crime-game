import { beforeAll, describe, expect, it } from 'vitest';
import { Profiler } from '../core/profiler';
import { entityIndex } from '../ecs/entity';
import { Scheduler } from '../ecs/scheduler';
import { createTransformSnapshotSystem, teleport, Transform } from '../ecs/transform';
import { World } from '../ecs/world';
import { filterOf, Group, groupsInteract, interactionGroups, membershipOf } from './collision-groups';
import { createRayHit, PhysicsWorld } from './physics-world';
import { loadRapier, type Rapier } from './rapier';
import { createPhysicsStepSystem, createRigidBodySyncSystem, RigidBodyRef } from './rigid-body-sync';

let rapier: Rapier;

beforeAll(async () => {
  rapier = await loadRapier();
});

describe('collision groups', () => {
  it('packs membership and filter', () => {
    const g = interactionGroups(Group.VEHICLE, Group.WORLD | Group.VEHICLE);
    expect(membershipOf(g)).toBe(Group.VEHICLE);
    expect(filterOf(g)).toBe(Group.WORLD | Group.VEHICLE);
  });

  it('interaction requires both directions to match', () => {
    const world = interactionGroups(Group.WORLD, 0xffff);
    const ghost = interactionGroups(Group.DEBRIS, Group.WORLD);
    const car = interactionGroups(Group.VEHICLE, Group.WORLD | Group.VEHICLE);
    expect(groupsInteract(world, car)).toBe(true);
    expect(groupsInteract(ghost, car)).toBe(false);
    expect(groupsInteract(ghost, world)).toBe(true);
  });
});

describe('PhysicsWorld (Rapier in Node)', () => {
  it('a dropped box comes to rest on the ground', () => {
    const physics = new PhysicsWorld(rapier);
    physics.createFixedBox({ halfExtents: [50, 0.5, 50], position: [0, -0.5, 0] });
    const body = physics.createDynamicBox({ halfExtents: [0.5, 0.5, 0.5], position: [0, 10, 0] });
    for (let i = 0; i < 600; i++) physics.step();
    const p = body.translation();
    expect(p.y).toBeGreaterThan(0.45);
    expect(p.y).toBeLessThan(0.56);
    expect(physics.bodyCount).toBe(1);
    expect(physics.colliderCount).toBe(2);
    physics.dispose();
  });

  it('free fall matches g within 1% after one second', () => {
    const physics = new PhysicsWorld(rapier);
    const body = physics.createDynamicBox({ halfExtents: [0.5, 0.5, 0.5], position: [0, 100, 0] });
    for (let i = 0; i < 60; i++) physics.step();
    expect(body.linvel().y).toBeCloseTo(-9.81, 1);
    physics.dispose();
  });

  it('castRay reports distance, point and normal; respects groups', () => {
    const physics = new PhysicsWorld(rapier);
    physics.createFixedBox({ halfExtents: [5, 0.5, 5], position: [0, -0.5, 0] });
    physics.world.step();
    const hit = createRayHit();
    expect(physics.castRay(0, 10, 0, 0, -2, 0, 100, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(10);
    expect(hit.y).toBeCloseTo(0);
    expect(hit.ny).toBeCloseTo(1);
    const onlyVehicles = interactionGroups(0xffff, Group.VEHICLE);
    expect(physics.castRay(0, 10, 0, 0, -1, 0, 100, hit, onlyVehicles)).toBe(false);
    expect(physics.castRay(0, 10, 0, 0, 0, 0, 100, hit)).toBe(false);
    physics.dispose();
  });

  it('rigid body sync drives ECS transforms through the scheduler', () => {
    const physics = new PhysicsWorld(rapier);
    physics.createFixedBox({ halfExtents: [50, 0.5, 50], position: [0, -0.5, 0] });
    const world = new World(64);
    const scheduler = new Scheduler(new Profiler(() => 0));
    scheduler
      .addFixed(createTransformSnapshotSystem(world))
      .addFixed(createPhysicsStepSystem(physics))
      .addFixed(createRigidBodySyncSystem(world));
    const e = world.create();
    world.add(e, Transform);
    teleport(world.soa(Transform), e, 0, 5, 0);
    world.set(
      e,
      RigidBodyRef,
      physics.createDynamicBox({ halfExtents: [0.5, 0.5, 0.5], position: [0, 5, 0] }),
    );
    const t = world.soa(Transform).f;
    const i = entityIndex(e);
    scheduler.runFixed({ dt: 1 / 60, tick: 1, time: 0 });
    expect(t.py[i]).toBeLessThan(5);
    expect(t.ppy[i]).toBe(5);
    for (let n = 0; n < 300; n++) scheduler.runFixed({ dt: 1 / 60, tick: n + 2, time: 0 });
    expect(t.py[i]).toBeCloseTo(0.5, 1);
    physics.dispose();
  });

  it('stacked boxes stay stable and fall asleep', () => {
    const physics = new PhysicsWorld(rapier);
    physics.createFixedBox({ halfExtents: [20, 0.5, 20], position: [0, -0.5, 0] });
    const bodies = Array.from({ length: 5 }, (_, k) =>
      physics.createDynamicBox({ halfExtents: [0.5, 0.5, 0.5], position: [0, 0.5 + k * 1.001, 0] }),
    );
    for (let i = 0; i < 900; i++) physics.step();
    const top = bodies[4]?.translation();
    expect(top?.y).toBeCloseTo(4.5, 0);
    expect(Math.abs(top?.x ?? 99)).toBeLessThan(0.1);
    expect(physics.countAwakeDynamic()).toBe(0);
    physics.dispose();
  });
});
