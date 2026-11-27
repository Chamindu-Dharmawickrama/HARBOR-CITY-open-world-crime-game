import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { ALL_VEHICLES } from '../../content/vehicles';
import { PhysicsWorld } from '../../physics/physics-world';
import { loadRapier, type Rapier } from '../../physics/rapier';
import { RaycastVehicle } from '../../vehicles/sim/raycast-vehicle';
import { generateCity } from '../../world/gen/city-layout';
import { createLanePoint, LaneNetwork } from './lane-network';
import { drivePhysicsCar } from './physics-driver';
import { Light } from './signals';
import { TrafficSim, type DriverProfile } from './traffic-sim';

let rapier: Rapier;
let net: LaneNetwork;
const DT = 1 / 60;
const PROFILE: DriverProfile = {
  speedFactor: 1,
  idm: { a: 2, b: 2.8, T: 1.4, s0: 2.5, delta: 4 },
  gap: 3.5,
};

beforeAll(async () => {
  rapier = await loadRapier();
  net = new LaneNetwork(generateCity(CITY, 74613).layout);
});

describe('physics traffic driver', () => {
  it('follows city lanes through junctions, keeps to its lane and stops at red lights', () => {
    // A signalled approach lane with a long run-up: the car starts on it and drives on.
    const start =
      net.spawnLanes.find((l) => net.signal[l] >= 0 && net.length[l] > 90 && net.speed[l] > 10) ??
      net.spawnLanes[0];
    const p = net.sample(start, 10, createLanePoint());
    // Make that light turn red right at the start, so the car meets it red on arrival.
    const signal = net.signals[net.signal[start]];
    const phase = net.phase[start];
    const t0 = signal.timing;
    let greenStart = 0;
    for (let i = 0; i < phase; i++) greenStart += t0.green[i] + t0.amber + t0.allRed;
    signal.timing = { ...t0, offset: greenStart + (t0.green[phase] ?? 0) + t0.amber + 0.1 };
    const physics = new PhysicsWorld(rapier);
    // Flat pad under the whole run; lanes are followed in plan (x, z) only.
    physics.createFixedBox({ halfExtents: [2000, 1, 2000], position: [p.x, p.y - 1, p.z], friction: 1 });
    physics.world.step();
    const def = ALL_VEHICLES.find((d) => d.id === 'meridian');
    if (!def) throw new Error('meridian');
    const vehicle = new RaycastVehicle(physics, def, p.x, p.y + 0.05, p.z, Math.atan2(p.dx, p.dz));
    vehicle.engineOn = true;
    const sim = new TrafficSim(net, 5);
    const car = sim.addCar(start, 10, 0, def.length, def.width, PROFILE);
    car.physics = true;
    let worstLat = 0;
    let latSum = 0;
    let samples = 0;
    const lanes = new Set<number>();
    let stoppedAtRed = 0;
    let worstStopError = 0;
    for (let t = 0; t < 90; t += DT) {
      const b = vehicle.body.translation();
      const lat = sim.track(car, b.x, b.z, vehicle.telemetry.forwardSpeed, DT);
      if (t > 2) {
        worstLat = Math.max(worstLat, lat);
        latSum += lat;
        samples++;
      }
      lanes.add(car.lane);
      sim.step(DT, t);
      drivePhysicsCar(sim, car, vehicle);
      vehicle.step(DT);
      physics.step();
      if (car.v < 0.2 && car.light === Light.red && car.stopDistance < 8) {
        stoppedAtRed++;
        worstStopError = Math.max(worstStopError, Math.abs(car.stopDistance - 0.6));
      }
    }
    expect(sim.stats.redLightViolations).toBe(0);
    expect(sim.stats.forcedEntries).toBe(0);
    expect(latSum / samples).toBeLessThan(0.6);
    expect(worstLat).toBeLessThan(2.5);
    expect(lanes.size).toBeGreaterThan(6);
    expect(sim.stats.distance).toBeGreaterThan(400);
    // It waited at the red light, stopped close to the line (STOP_GAP 0.6 m before it).
    expect(stoppedAtRed).toBeGreaterThan(60);
    expect(worstStopError).toBeLessThan(1.5);
    // The car never rolled backwards.
    expect(vehicle.drivetrain.gear).toBeGreaterThanOrEqual(1);
    vehicle.dispose();
  }, 60_000);

  it('switches between kinematic and physics and keeps moving', () => {
    const lane = net.spawnLanes.find((l) => net.length[l] > 150) ?? net.spawnLanes[0];
    const p = net.sample(lane, 20, createLanePoint());
    const physics = new PhysicsWorld(rapier);
    physics.createFixedBox({ halfExtents: [800, 1, 800], position: [p.x, p.y - 1, p.z], friction: 1 });
    physics.world.step();
    const def = ALL_VEHICLES.find((d) => d.id === 'brisa');
    if (!def) throw new Error('brisa');
    const yaw = Math.atan2(p.dx, p.dz);
    const vehicle = new RaycastVehicle(physics, def, p.x, p.y + 0.05, p.z, yaw);
    vehicle.engineOn = true;
    vehicle.setKinematic(true);
    for (let i = 0; i < 30; i++) {
      vehicle.driveKinematic(p.x + p.dx * i * 0.2, p.y, p.z + p.dz * i * 0.2, yaw, 0, 12, 0, DT);
      physics.step();
    }
    const k = vehicle.body.translation();
    expect(Math.hypot(k.x - (p.x + p.dx * 5.8), k.z - (p.z + p.dz * 5.8))).toBeLessThan(0.05);
    expect(vehicle.telemetry.speed).toBeCloseTo(12);
    vehicle.resume(k.x, p.y + 0.02, k.z, yaw, 0, 12);
    for (let i = 0; i < 60; i++) {
      vehicle.controls.throttle = 0.2;
      vehicle.step(DT);
      physics.step();
    }
    expect(vehicle.body.isDynamic()).toBe(true);
    expect(vehicle.telemetry.forwardSpeed).toBeGreaterThan(10);
    expect(Math.abs(vehicle.body.translation().y - p.y)).toBeLessThan(0.3);
    vehicle.dispose();
  });
});
