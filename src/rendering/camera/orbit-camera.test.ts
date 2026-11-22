import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ORBIT, OrbitCamera, type CameraCollision, type OrbitTarget } from './orbit-camera';

const DT = 1 / 60;
const open: CameraCollision = { sweep: (_ox, _oy, _oz, _dx, _dy, _dz, _r, max) => max };

/** A wall plane z = wallZ (solid for z > wallZ): sweeps stop `radius` short of it. */
function wallAt(wallZ: number): CameraCollision {
  return {
    sweep(_ox, _oy, oz, _dx, _dy, dz, radius, max) {
      if (dz <= 0) return max;
      const free = (wallZ - radius - oz) / dz;
      return Math.max(0, Math.min(max, free));
    },
  };
}

function target(overrides: Partial<OrbitTarget> = {}): OrbitTarget {
  return { x: 0, y: 0, z: 0, height: 1.8, heading: 0, speed: 0, ...overrides };
}

describe('OrbitCamera', () => {
  it('sits behind and above the pivot at the follow distance, looking along its yaw', () => {
    const camera = new THREE.PerspectiveCamera();
    const orbit = new OrbitCamera(camera, open);
    orbit.yaw = 0; // looking north (−Z)
    orbit.pitch = 0;
    for (let i = 0; i < 30; i++) orbit.update(target(), 0, 0, DT);
    const d = ORBIT.distances[1];
    expect(camera.position.z).toBeCloseTo(d, 3);
    expect(camera.position.x).toBeCloseTo(ORBIT.followShoulder, 3);
    expect(camera.position.y).toBeCloseTo(1.8 * ORBIT.pivotFactor, 3);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.z).toBeCloseTo(-1, 5);
  });

  it('look input turns and tilts, with pitch clamped', () => {
    const orbit = new OrbitCamera(new THREE.PerspectiveCamera(), open);
    orbit.update(target(), 0.5, 0, DT);
    expect(orbit.yaw).toBeCloseTo(-0.5);
    orbit.update(target(), 0, 10, DT);
    expect(orbit.pitch).toBe(ORBIT.pitchMax);
    orbit.update(target(), 0, -10, DT);
    expect(orbit.pitch).toBe(ORBIT.pitchMin);
  });

  it('snaps in front of a wall immediately and eases back out when it clears', () => {
    const camera = new THREE.PerspectiveCamera();
    let collision = open;
    const orbit = new OrbitCamera(camera, { sweep: (...a) => collision.sweep(...a) });
    orbit.pitch = 0;
    for (let i = 0; i < 30; i++) orbit.update(target(), 0, 0, DT);
    collision = wallAt(1.5);
    orbit.update(target(), 0, 0, DT);
    expect(orbit.blocked).toBe(true);
    expect(camera.position.z).toBeLessThanOrEqual(1.5 - ORBIT.radius + 1e-6);
    collision = open;
    orbit.update(target(), 0, 0, DT);
    expect(camera.position.z).toBeLessThan(1.6); // no pop back out
    for (let i = 0; i < 180; i++) orbit.update(target(), 0, 0, DT);
    expect(orbit.distance).toBeCloseTo(ORBIT.distances[1], 2);
  });

  it('aim mode moves in over the shoulder, narrows the FOV, and swaps shoulders', () => {
    const camera = new THREE.PerspectiveCamera(ORBIT.followFov);
    const orbit = new OrbitCamera(camera, open);
    orbit.pitch = 0;
    orbit.aiming = true;
    for (let i = 0; i < 60; i++) orbit.update(target(), 0, 0, DT);
    expect(orbit.distance).toBeCloseTo(ORBIT.aimDistance, 2);
    expect(camera.fov).toBeCloseTo(ORBIT.aimFov, 3);
    expect(camera.position.x).toBeCloseTo(ORBIT.aimShoulder, 2);
    orbit.swapShoulder();
    for (let i = 0; i < 5; i++) orbit.update(target(), 0, 0, DT);
    expect(camera.position.x).toBeCloseTo(-ORBIT.aimShoulder, 2);
  });

  it('cycles follow distances', () => {
    const orbit = new OrbitCamera(new THREE.PerspectiveCamera(), open);
    const seen = new Set<number>();
    for (let i = 0; i < ORBIT.distances.length; i++) {
      seen.add(orbit.desiredDistance);
      orbit.cycleDistance();
    }
    expect(seen.size).toBe(ORBIT.distances.length);
  });

  it('recentres behind a moving character after a pause in look input', () => {
    const orbit = new OrbitCamera(new THREE.PerspectiveCamera(), open);
    orbit.yaw = 1.2;
    const moving = target({ heading: 0, speed: 6 }); // facing +Z → camera yaw π behind it
    for (let i = 0; i < 60 * 6; i++) orbit.update(moving, 0, 0, DT);
    expect(Math.abs(Math.atan2(Math.sin(orbit.yaw - Math.PI), Math.cos(orbit.yaw - Math.PI)))).toBeLessThan(
      0.1,
    );
  });

  it('ground forward matches the view yaw', () => {
    const orbit = new OrbitCamera(new THREE.PerspectiveCamera(), open);
    orbit.yaw = Math.PI / 2; // looking west (−X)
    const f = { x: 0, z: 0 };
    orbit.groundForward(f);
    expect(f.x).toBeCloseTo(-1);
    expect(f.z).toBeCloseTo(0);
  });
});
