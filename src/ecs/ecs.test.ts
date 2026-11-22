import { describe, expect, it } from 'vitest';
import { Profiler } from '../core/profiler';
import { defineObject, defineSoA, defineTag } from './component';
import { EntityManager, entityGeneration, entityIndex, makeEntity, NULL_ENTITY } from './entity';
import { Scheduler } from './scheduler';
import { createTransformSnapshotSystem, interpolatePose, setPose, teleport, Transform } from './transform';
import { World } from './world';

const Velocity = defineSoA('Velocity', ['x', 'y', 'z'] as const);
const Name = defineObject<string>('Name');
const Frozen = defineTag('Frozen');

describe('EntityManager', () => {
  it('packs index and generation', () => {
    const e = makeEntity(123, 7);
    expect(entityIndex(e)).toBe(123);
    expect(entityGeneration(e)).toBe(7);
    expect(entityIndex(NULL_ENTITY)).toBe((1 << 20) - 1);
  });

  it('recycles indices with a new generation; stale handles are dead', () => {
    const em = new EntityManager(4);
    const a = em.create();
    expect(em.isAlive(a)).toBe(true);
    em.destroy(a);
    expect(em.isAlive(a)).toBe(false);
    const b = em.create();
    expect(entityIndex(b)).toBe(entityIndex(a));
    expect(b).not.toBe(a);
    expect(em.isAlive(a)).toBe(false);
    expect(em.destroy(a)).toBe(false);
  });

  it('throws when out of capacity', () => {
    const em = new EntityManager(2);
    em.create();
    em.create();
    expect(() => em.create()).toThrow();
  });
});

describe('World and queries', () => {
  it('adds, reads and removes components of each kind', () => {
    const world = new World(64);
    const e = world.create();
    world.add(e, Velocity);
    world.soa(Velocity).f.x[entityIndex(e)] = 3;
    world.set(e, Name, 'cab');
    world.add(e, Frozen);
    expect(world.has(e, Velocity)).toBe(true);
    expect(world.get(e, Name)).toBe('cab');
    expect(world.has(e, Frozen)).toBe(true);
    world.remove(e, Name);
    expect(world.get(e, Name)).toBeUndefined();
    expect(world.has(e, Name)).toBe(false);
    expect(world.soa(Velocity).f.x[entityIndex(e)]).toBe(3);
  });

  it('queries update incrementally, including none-filters', () => {
    const world = new World(64);
    const moving = world.query([Velocity], [Frozen]);
    const a = world.create();
    const b = world.create();
    world.add(a, Velocity);
    world.add(b, Velocity);
    expect(moving.size).toBe(2);
    world.add(b, Frozen);
    expect(moving.entities).toEqual([a]);
    world.remove(b, Frozen);
    expect(moving.size).toBe(2);
    world.destroy(a);
    expect(moving.entities).toEqual([b]);
  });

  it('a query created late sees existing entities', () => {
    const world = new World(64);
    const e = world.create();
    world.add(e, Velocity);
    world.set(e, Name, 'late');
    const q = world.query([Velocity, Name]);
    expect(q.entities).toEqual([e]);
    expect(world.query([Name, Velocity])).toBe(q);
  });

  it('destroyDeferred is safe while iterating', () => {
    const world = new World(64);
    const q = world.query([Velocity]);
    for (let i = 0; i < 10; i++) world.add(world.create(), Velocity);
    for (let i = 0; i < q.entities.length; i++) world.destroyDeferred(q.entities[i]);
    expect(q.size).toBe(10);
    expect(world.flushDestroyed()).toBe(10);
    expect(q.size).toBe(0);
    expect(world.entityCount).toBe(0);
  });

  it('recycled entities do not inherit components', () => {
    const world = new World(4);
    const a = world.create();
    world.set(a, Name, 'old');
    world.destroy(a);
    const b = world.create();
    expect(entityIndex(b)).toBe(entityIndex(a));
    expect(world.get(b, Name)).toBeUndefined();
    expect(world.has(b, Name)).toBe(false);
  });

  it('rejects operations on dead entities and empty queries', () => {
    const world = new World(4);
    const e = world.create();
    world.destroy(e);
    expect(() => world.add(e, Velocity)).toThrow();
    expect(() => world.query([])).toThrow();
  });

  it('object store survives swap-removal', () => {
    const world = new World(16);
    const es = [world.create(), world.create(), world.create()];
    es.forEach((e, i) => world.set(e, Name, `n${i}`));
    world.destroy(es[0]);
    expect(world.get(es[1], Name)).toBe('n1');
    expect(world.get(es[2], Name)).toBe('n2');
  });
});

describe('Transform', () => {
  it('interpolates position and rotation between ticks', () => {
    const world = new World(8);
    const t = world.soa(Transform);
    const e = world.create();
    world.add(e, Transform);
    teleport(t, e, 0, 0, 0);
    const snapshot = createTransformSnapshotSystem(world);
    snapshot.fixedUpdate({ dt: 1 / 60, tick: 1, time: 0 });
    const s = Math.sin(Math.PI / 4);
    setPose(t, e, 10, 0, 0, 0, s, 0, Math.cos(Math.PI / 4));
    const pose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    interpolatePose(t, e, 0.5, pose);
    expect(pose.x).toBeCloseTo(5);
    const halfAngle = 2 * Math.acos(pose.qw);
    expect(halfAngle).toBeCloseTo(Math.PI / 4, 2);
    expect(Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw)).toBeCloseTo(1);
  });

  it('takes the shortest arc when quaternion signs differ', () => {
    const world = new World(8);
    const t = world.soa(Transform);
    const e = world.create();
    world.add(e, Transform);
    teleport(t, e, 0, 0, 0, 0, 0, 0, 1);
    setPose(t, e, 0, 0, 0, 0, 0, 0, -1);
    const pose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 0 };
    interpolatePose(t, e, 0.5, pose);
    expect(Math.abs(pose.qw)).toBeCloseTo(1);
  });
});

describe('Scheduler', () => {
  it('runs fixed phases in order and times systems', () => {
    let clock = 0;
    const profiler = new Profiler(() => clock);
    const scheduler = new Scheduler(profiler);
    const order: string[] = [];
    scheduler.addFixed({ name: 'late', phase: 'late', fixedUpdate: () => order.push('late') });
    scheduler.addFixed({
      name: 'physics',
      phase: 'physics',
      fixedUpdate: () => {
        order.push('physics');
        clock += 2;
      },
    });
    scheduler.addFixed({ name: 'input', phase: 'input', fixedUpdate: () => order.push('input') });
    scheduler.runFixed({ dt: 1 / 60, tick: 1, time: 0 });
    profiler.endFrame();
    expect(order).toEqual(['input', 'physics', 'late']);
    expect(profiler.average('physics')).toBe(2);
    expect(scheduler.describe().fixed.physics).toEqual(['physics']);
  });

  it('can disable systems and rejects duplicate names', () => {
    const scheduler = new Scheduler(new Profiler(() => 0));
    let runs = 0;
    scheduler.addRender({ name: 'cam', phase: 'camera', renderUpdate: () => runs++ });
    expect(scheduler.setEnabled('cam', false)).toBe(true);
    scheduler.runRender({ alpha: 0, frameSeconds: 0, time: 0 });
    expect(runs).toBe(0);
    expect(scheduler.setEnabled('missing', false)).toBe(false);
    expect(() => scheduler.addRender({ name: 'cam', phase: 'ui', renderUpdate: () => undefined })).toThrow();
  });
});
