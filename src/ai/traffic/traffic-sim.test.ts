import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { Rng } from '../../core/rng';
import { generateCity } from '../../world/gen/city-layout';
import { LaneNetwork } from './lane-network';
import { ObstacleField } from './obstacles';
import { TrafficSim, type DriverProfile } from './traffic-sim';

let net: LaneNetwork;
const CARS = 160;

beforeAll(() => {
  net = new LaneNetwork(generateCity(CITY, 74613).layout);
});

function profile(rng: Rng): DriverProfile {
  return {
    speedFactor: rng.range(0.85, 1.08),
    idm: {
      a: rng.range(1.6, 2.4),
      b: rng.range(2.4, 3.2),
      T: rng.range(1.1, 1.7),
      s0: rng.range(2, 3),
      delta: 4,
    },
    gap: rng.range(3, 4.5),
  };
}

function populate(sim: TrafficSim, count: number, rng: Rng): void {
  let guard = 0;
  while (sim.cars.length < count && guard++ < count * 50) {
    const lane = net.spawnLanes[rng.int(0, net.spawnLanes.length)];
    const s = rng.range(5, Math.max(6, net.length[lane] - 20));
    const length = rng.chance(0.1) ? 7 : rng.range(4, 5);
    if (!sim.isClear(lane, s, length, 12)) continue;
    sim.addCar(lane, s, rng.range(0, net.speed[lane] * 0.8), length, 1.9, profile(rng));
  }
}

/** Cars currently on two conflicting connectors at once (must never happen). */
function conflictPairs(sim: TrafficSim): number {
  let pairs = 0;
  const onConnector = new Map<number, number>();
  for (const c of sim.cars)
    if (net.connector[c.lane]) onConnector.set(c.lane, (onConnector.get(c.lane) ?? 0) + 1);
  for (const [lane] of onConnector) for (const k of net.conflicts[lane]) if (onConnector.has(k)) pairs++;
  return pairs;
}

/** Same-lane cars overlapping bumpers. */
function overlaps(sim: TrafficSim): number {
  let n = 0;
  const byLane = new Map<number, typeof sim.cars>();
  for (const c of sim.cars) byLane.set(c.lane, [...(byLane.get(c.lane) ?? []), c]);
  for (const list of byLane.values()) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) {
      if (list[i].s - list[i].length / 2 < list[i - 1].s + list[i - 1].length / 2 - 0.05) n++;
    }
  }
  return n;
}

describe('traffic simulation (headless, whole city)', () => {
  it('runs 10 minutes with no red-light running, no junction conflicts and no gridlock', () => {
    const rng = new Rng(4242);
    const sim = new TrafficSim(net, 99);
    // About the in-game High density (45 cars near the player), spread over the whole city.
    populate(sim, CARS, rng);
    expect(sim.cars.length).toBe(CARS);
    const dt = 1 / 20;
    let conflicts = 0;
    let bumperOverlaps = 0;
    for (let tick = 0; tick < 10 * 60 * 20; tick++) {
      sim.step(dt, tick * dt);
      if (tick % 10 === 0) {
        conflicts += conflictPairs(sim);
        bumperOverlaps += overlaps(sim);
      }
    }
    const s = sim.stats;
    expect(s.redLightViolations).toBe(0);
    expect(s.forcedEntries).toBe(0);
    expect(conflicts).toBe(0);
    expect(bumperOverlaps).toBe(0);
    // No gridlock: nobody stands still for a minute unless held by a red light, and even at the
    // busiest three-phase junctions no car waits much more than one cycle.
    expect(s.maxStalled).toBeLessThan(60);
    expect(s.gridlocked).toBe(0);
    expect(s.maxStationary).toBeLessThan(100);
    // Traffic actually flows: signals are crossed and the fleet averages a city speed.
    expect(s.greenCrossings).toBeGreaterThan(1500);
    expect(s.amberCrossings).toBeGreaterThan(20);
    expect(s.admissions).toBeGreaterThan(4000);
    expect(s.distance / (CARS * 600)).toBeGreaterThan(4);
    expect(s.laneChanges).toBeGreaterThan(10);
  }, 120_000);

  it('stops for an obstacle on its path and drives on when it clears', () => {
    const field = new ObstacleField();
    const sim = new TrafficSim(net, 7, field);
    const lane = net.spawnLanes.find((l) => net.length[l] > 120 && net.speed[l] > 10) ?? net.spawnLanes[0];
    const car = sim.addCar(lane, 5, 8, 4.5, 1.9, profile(new Rng(1)));
    const at = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    net.sample(lane, 70, at);
    const dt = 1 / 60;
    for (let t = 0; t < 20; t += dt) {
      field.clear();
      field.add(at.x, at.y, at.z, 0.4, 0, 0, false);
      sim.step(dt, t);
    }
    expect(car.lane).toBe(lane);
    expect(car.v).toBeLessThan(0.1);
    expect(car.front).toBeLessThan(70);
    expect(car.front).toBeGreaterThan(60);
    expect(car.reason).toBe('obstacle');
    for (let t = 20; t < 30; t += dt) {
      field.clear();
      sim.step(dt, t);
    }
    expect(car.v).toBeGreaterThan(3);
  });

  it('a held car stops and the queue behind it waits', () => {
    const sim = new TrafficSim(net, 3);
    // A lane without neighbours: the follower cannot simply change lanes to pass.
    const lane =
      net.spawnLanes.find((l) => net.length[l] > 150 && net.inner[l] < 0 && net.outer[l] < 0) ??
      net.spawnLanes[0];
    const lead = sim.addCar(lane, 60, 8, 4.5, 1.9, profile(new Rng(2)));
    const follower = sim.addCar(lane, 30, 8, 4.5, 1.9, profile(new Rng(3)));
    lead.hold = true;
    for (let t = 0; t < 12; t += 1 / 60) sim.step(1 / 60, t);
    expect(lead.v).toBeLessThan(0.05);
    expect(follower.v).toBeLessThan(0.05);
    expect(lead.s - follower.s).toBeGreaterThan(4.5);
  });
});
