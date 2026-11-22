import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../core/events';
import { InputSystem } from '../../core/input/input-system';
import { VirtualInputDevice } from '../../core/input/virtual-device';
import { PhysicsWorld } from '../../physics/physics-world';
import { loadRapier, type Rapier } from '../../physics/rapier';
import { OrbitCamera, type OrbitTarget } from '../../rendering/camera/orbit-camera';
import { CharacterMotor, emptyCommand, MOTOR } from '../controller/character-motor';
import { createCameraClipCheck, createCameraCollision } from './physics-queries';
import { cameraRelativeMove, PLAYER, PlayerCharacter, yawFacingCamera } from './player-character';

const DT = 1 / 60;
let rapier: Rapier;

beforeAll(async () => {
  rapier = await loadRapier();
});

function box(
  physics: PhysicsWorld,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  physics.createFixedBox({
    halfExtents: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
    position: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  });
}

function setup(): {
  physics: PhysicsWorld;
  player: PlayerCharacter;
  device: VirtualInputDevice;
  input: InputSystem;
  bus: EventBus<GameEvents>;
  events: string[];
  view: { yaw: number; pitch: number };
  step: (seconds: number) => void;
} {
  const physics = new PhysicsWorld(rapier);
  box(physics, -150, -5, -150, 150, 0, 150);
  box(physics, 20, 0, -2, 24, 10, 2); // 10 m tower
  physics.world.step();
  const device = new VirtualInputDevice();
  const input = new InputSystem([device]);
  const bus = new EventBus<GameEvents>();
  const events: string[] = [];
  for (const type of ['player:landed', 'player:damaged', 'player:died', 'player:respawned'] as const) {
    bus.on(type, () => events.push(type));
  }
  const view = { yaw: 0, pitch: 0 };
  const env = { waterLevel: -10, isWater: () => false };
  const player = new PlayerCharacter(physics, env, input, bus, view, 0, 0, 0, () => ({
    x: -10,
    y: 0,
    z: -10,
    yaw: 0,
  }));
  const step = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      input.update();
      input.beginFixedStep();
      player.step(DT);
      physics.step();
      bus.flush();
    }
  };
  return { physics, player, device, input, bus, events, view, step };
}

describe('camera-relative movement', () => {
  it('forward follows the camera yaw; right is 90° clockwise from it', () => {
    const out = { x: 0, z: 0 };
    cameraRelativeMove(0, 1, 0, out); // camera looks north (−Z)
    expect(out.x).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(-1);
    cameraRelativeMove(1, 0, 0, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(0);
    cameraRelativeMove(0, 1, Math.PI / 2, out); // camera looks west
    expect(out.x).toBeCloseTo(-1);
    // Facing the camera direction: a body yaw whose forward (sin, cos) is the view direction.
    const yaw = yawFacingCamera(Math.PI / 2);
    expect(Math.sin(yaw)).toBeCloseTo(-1);
  });
});

describe('PlayerCharacter (Rapier)', () => {
  it('runs where the camera looks, sprints until exhausted, then recovers', () => {
    const { player, device, view, step } = setup();
    step(0.3);
    view.yaw = Math.PI / 2; // west
    device.keyDown('KeyW');
    step(1);
    expect(player.motor.position.x).toBeLessThan(-2.5);
    expect(Math.abs(player.motor.position.z)).toBeLessThan(0.2);
    expect(player.motor.speed).toBeCloseTo(MOTOR.runSpeed, 0);

    view.yaw = Math.PI; // south (+Z), across the open slab
    device.keyDown('ShiftLeft');
    step(2);
    expect(player.motor.speed).toBeCloseTo(MOTOR.sprintSpeed, 0);
    // Full stamina lasts 100 / drain seconds of sprinting (2 s of it already spent above).
    let sprinted = 2;
    while (!player.vitals.exhausted && sprinted < 20) {
      step(0.1);
      sprinted += 0.1;
    }
    expect(player.vitals.exhausted).toBe(true);
    expect(sprinted).toBeCloseTo(100 / PLAYER.sprintDrain, 0);
    step(0.5);
    expect(player.motor.speed).toBeLessThan(MOTOR.runSpeed + 0.3); // cannot sprint while exhausted
    device.releaseAll();
    step(3);
    expect(player.vitals.exhausted).toBe(false);
  });

  it('walk modifier and aiming slow the player; aiming faces the camera', () => {
    const { player, device, view, step } = setup();
    step(0.3);
    device.keyDown('KeyW');
    device.keyDown('KeyZ');
    step(1.5);
    expect(player.motor.speed).toBeCloseTo(MOTOR.walkSpeed, 0);
    device.keyUp('KeyZ');
    view.yaw = 1;
    device.mouseButton(2, true);
    step(1.5);
    expect(player.aiming).toBe(true);
    expect(player.motor.speed).toBeCloseTo(MOTOR.walkSpeed, 0);
    expect(Math.cos(player.motor.yaw - yawFacingCamera(1))).toBeGreaterThan(0.99);
  });

  it('walking off a 10 m tower hurts (armour does not help); damage events fire', () => {
    const { player, device, view, events, step } = setup();
    player.vitals.armor = 100;
    player.placeAt(21, 0, 12);
    step(0.5);
    expect(player.motor.position.y).toBeCloseTo(10, 1);
    view.yaw = -Math.PI / 2; // east → off the far edge at x = 24
    device.keyDown('KeyW');
    device.keyDown('KeyZ');
    step(4);
    expect(events).toContain('player:landed');
    expect(events).toContain('player:damaged');
    expect(player.vitals.health).toBeLessThan(80);
    expect(player.vitals.health).toBeGreaterThan(30);
    expect(player.vitals.armor).toBe(100);
    expect(player.dead).toBe(false);
  });

  it('a 30 m fall kills: FLATLINED, then respawn at the respawn point with full health', () => {
    const { player, events, step } = setup();
    player.motor.teleport(0, 30, 10);
    step(3);
    expect(player.dead).toBe(true);
    expect(events).toContain('player:died');
    expect(player.deathCause).toBe('fall');
    step(PLAYER.respawnDelay + 0.5);
    expect(events).toContain('player:respawned');
    expect(player.dead).toBe(false);
    expect(player.vitals.health).toBe(player.vitals.maxHealth);
    expect(player.motor.position.x).toBeCloseTo(-10, 0);
    expect(player.motor.position.z).toBeCloseTo(-10, 0);
  });

  it('placement waits for ground to exist below the target', () => {
    const { physics, player, step } = setup();
    player.placeAt(200, 200, 40);
    step(0.5);
    expect(player.placing).toBe(true);
    expect(player.motor.position.y).toBeCloseTo(40, 3);
    box(physics, 190, -1, 190, 210, 0.5, 210);
    step(0.2);
    expect(player.placing).toBe(false);
    expect(player.motor.position.y).toBeCloseTo(0.5, 1);
  });
});

describe('third-person camera never clips (scripted path through tight geometry)', () => {
  it('audits every frame while walking along walls, into a corner and through an alley', () => {
    const physics = new PhysicsWorld(rapier);
    box(physics, -60, -5, -60, 60, 0, 60);
    box(physics, -20, 0, 2, 20, 12, 4); // long wall north of the path
    box(physics, 20, 0, -12, 22, 12, 4); // corner wall at the east end
    box(physics, -20, 0, -10, 10, 12, -8.4); // alley: south wall 1.6 m from…
    box(physics, -20, 0, -6.8, 10, 12, -5); // …the north wall
    box(physics, -20, 6, -8.4, 10, 7, -6.8); // a bridge over the alley
    physics.world.step();
    const motor = new CharacterMotor(physics, { waterLevel: -10, isWater: () => false }, -18, 0, 1.2);
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 500);
    const orbit = new OrbitCamera(camera, createCameraCollision(physics));
    const clipped = createCameraClipCheck(physics);
    const target: OrbitTarget = { x: 0, y: 0, z: 0, height: 1.8, heading: 0, speed: 0 };
    let audited = 0;
    let clips = 0;
    let blockedFrames = 0;
    const path: [number, number][] = [
      [19, 1.2], // along the wall to the corner
      [19, -7.6], // down past the corner
      [-18, -7.6], // through the alley
    ];
    let leg = 0;
    for (let frame = 0; frame < 60 * 40 && leg < path.length; frame++) {
      const [tx, tz] = path[leg];
      const p = motor.position;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) {
        leg++;
        continue;
      }
      motor.step({ ...emptyCommand(), moveX: dx / dist, moveZ: dz / dist }, DT);
      physics.step();
      target.x = p.x;
      target.y = p.y;
      target.z = p.z;
      target.heading = motor.yaw;
      target.speed = motor.speed;
      // Constant camera sweep: 2 turns per 10 s, pitch oscillating, aim toggling every 3 s.
      orbit.aiming = Math.floor(frame / 180) % 2 === 1;
      orbit.update(target, 0.02, Math.sin(frame / 50) * 0.02, DT);
      const cam = orbit.position;
      const pv = orbit.pivot;
      audited++;
      if (orbit.blocked) blockedFrames++;
      if (clipped(cam.x, cam.y, cam.z, pv.x, pv.y, pv.z, p.x, p.y + 1.55, p.z, 0.27) !== 0) clips++;
    }
    expect(leg).toBe(path.length);
    expect(audited).toBeGreaterThan(600);
    expect(blockedFrames).toBeGreaterThan(100); // the walls really were in the way
    expect(clips).toBe(0);
  });
});
