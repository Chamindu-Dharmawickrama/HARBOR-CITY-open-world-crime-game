import { beforeAll, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../physics/physics-world';
import { loadRapier, type Rapier } from '../../physics/rapier';
import { fallDamage } from '../stats/vitals';
import { CharacterMotor, emptyCommand, MOTOR, type MotorCommand } from './character-motor';

const DT = 1 / 60;
const WATER = -2.5;
let rapier: Rapier;

beforeAll(async () => {
  rapier = await loadRapier();
});

/** Ground top at y=0 for x ∈ [-30, 60]; open water (level -2.5) west of x = -30. */
function course(): { physics: PhysicsWorld; motor: (x: number, y: number, z: number) => CharacterMotor } {
  const physics = new PhysicsWorld(rapier);
  const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void => {
    physics.createFixedBox({
      halfExtents: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
      position: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    });
  };
  box(-30, -6, -60, 60, 0, 60); // ground slab / quay
  box(-5, 0, 10, 5, 1.2, 11); // 1.2 m wall
  box(15, 0, 10, 25, 2.6, 11); // 2.6 m wall
  box(-5, 0, -10, 5, 0.3, -6); // 0.3 m step
  box(37, 0, -3, 43, 10, 3); // 10 m platform
  box(-15, 1.3, -25, -5, 2, -15); // low ceiling (1.3 m clearance)
  physics.world.step();
  const env = { waterLevel: WATER, isWater: (x: number) => x < -30 };
  return { physics, motor: (x, y, z) => new CharacterMotor(physics, env, x, y, z) };
}

function run(
  physics: PhysicsWorld,
  motor: CharacterMotor,
  seconds: number,
  cmd: Partial<MotorCommand> = {},
  firstOnly: Partial<MotorCommand> = {},
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    motor.step({ ...emptyCommand(), ...cmd, ...(i === 0 ? firstOnly : {}) }, DT);
    physics.step();
  }
}

describe('CharacterMotor (Rapier character controller)', () => {
  it('settles on the ground and runs at run speed', () => {
    const { physics, motor } = course();
    const m = motor(30, 0.5, -40);
    run(physics, m, 0.5);
    expect(m.grounded).toBe(true);
    expect(m.position.y).toBeCloseTo(0, 1);
    const z0 = m.position.z;
    run(physics, m, 2, { moveZ: 1 });
    expect(m.position.z - z0).toBeGreaterThan(8);
    expect(m.speed).toBeCloseTo(MOTOR.runSpeed, 0);
    expect(Math.abs(m.yaw)).toBeLessThan(0.05);
  });

  it('sprints faster than it runs and walks slower', () => {
    const { physics, motor } = course();
    const m = motor(30, 0, -40);
    run(physics, m, 1.5, { moveX: 1, speed: 'sprint' });
    expect(m.speed).toBeCloseTo(MOTOR.sprintSpeed, 0);
    run(physics, m, 1.5, { moveX: 1, speed: 'walk' });
    expect(m.speed).toBeCloseTo(MOTOR.walkSpeed, 0);
  });

  it('steps up a 0.3 m kerb without jumping', () => {
    const { physics, motor } = course();
    const m = motor(0, 0, -13);
    run(physics, m, 3.5, { moveZ: 1, speed: 'walk' });
    expect(m.position.z).toBeGreaterThan(-9.5);
    expect(m.position.y).toBeCloseTo(0.3, 1);
  });

  it('jumps about a metre and lands without damage', () => {
    const { physics, motor } = course();
    const m = motor(30, 0, 0);
    run(physics, m, 0.3);
    let peak = 0;
    m.step({ ...emptyCommand(), jump: true }, DT);
    physics.step();
    for (let i = 0; i < 120; i++) {
      m.step(emptyCommand(), DT);
      physics.step();
      peak = Math.max(peak, m.position.y);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.2);
    expect(m.grounded).toBe(true);
    expect(m.landings).toBe(1);
    expect(fallDamage(m.lastImpactSpeed, MOTOR.gravity)).toBe(0);
  });

  it('climbs a 1.2 m wall when jumping at it', () => {
    const { physics, motor } = course();
    const m = motor(0, 0, 8.8);
    run(physics, m, 0.3, { moveZ: 0.2 });
    m.step({ ...emptyCommand(), moveZ: 1, jump: true }, DT);
    physics.step();
    expect(m.mode).toBe('climb');
    run(physics, m, 1.6);
    expect(m.mode).toBe('ground');
    expect(m.position.y).toBeCloseTo(1.2, 1);
    expect(m.position.z).toBeGreaterThan(10);
  });

  it('cannot climb a 2.6 m wall (it just jumps)', () => {
    const { physics, motor } = course();
    const m = motor(20, 0, 8.8);
    run(physics, m, 0.3, { moveZ: 0.2 });
    m.step({ ...emptyCommand(), moveZ: 1, jump: true }, DT);
    physics.step();
    expect(m.mode).toBe('air');
    run(physics, m, 1.5, { moveZ: 1 });
    expect(m.position.y).toBeCloseTo(0, 1);
    expect(m.position.z).toBeLessThan(10);
  });

  it('a 10 m fall hurts and a 30 m fall kills', () => {
    const { physics, motor } = course();
    const m = motor(40, 10, 0);
    run(physics, m, 0.3);
    expect(m.position.y).toBeCloseTo(10, 1);
    run(physics, m, 4, { moveX: 1, speed: 'walk' });
    expect(m.landings).toBeGreaterThanOrEqual(1);
    const damage10 = fallDamage(m.lastImpactSpeed, MOTOR.gravity);
    expect(damage10).toBeGreaterThan(20);
    expect(damage10).toBeLessThan(60);

    m.teleport(50, 30, 30);
    run(physics, m, 3);
    expect(fallDamage(m.lastImpactSpeed, MOTOR.gravity)).toBeGreaterThan(100);
  });

  it('swims in open water and climbs out onto the quay', () => {
    const { physics, motor } = course();
    const m = motor(-36, 0, 0);
    run(physics, m, 2);
    expect(m.mode).toBe('swim');
    expect(m.waterEntries).toBe(1);
    expect(m.position.y).toBeCloseTo(WATER - MOTOR.floatDepth, 0);
    run(physics, m, 4.5, { moveX: 1 });
    expect(m.position.x).toBeGreaterThan(-31);
    m.step({ ...emptyCommand(), moveX: 1, jump: true }, DT);
    physics.step();
    expect(m.mode).toBe('climb');
    run(physics, m, 3);
    expect(m.mode).toBe('ground');
    expect(m.position.y).toBeCloseTo(0, 1);
    expect(m.position.x).toBeGreaterThan(-30);
  });

  it('crouches, moves slowly, and cannot stand up under a low ceiling', () => {
    const { physics, motor } = course();
    const m = motor(-10, 0, -30);
    run(physics, m, 0.3);
    m.step({ ...emptyCommand(), crouchToggle: true }, DT);
    physics.step();
    expect(m.crouched).toBe(true);
    run(physics, m, 3, { moveZ: 1 });
    expect(m.speed).toBeCloseTo(MOTOR.crouchSpeed, 0);
    expect(m.position.z).toBeGreaterThan(-25);
    m.step({ ...emptyCommand(), crouchToggle: true }, DT);
    physics.step();
    expect(m.crouched).toBe(true);
    run(physics, m, 7, { moveZ: 1 });
    expect(m.position.z).toBeGreaterThan(-15);
    m.step({ ...emptyCommand(), crouchToggle: true }, DT);
    physics.step();
    expect(m.crouched).toBe(false);
  });
});
