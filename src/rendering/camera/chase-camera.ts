import * as THREE from 'three';
import { clamp, damp, dampAngle } from '../../core/math';
import type { CameraCollision } from './orbit-camera';

export type ChaseMode = 'near' | 'far' | 'hood' | 'interior';
export const CHASE_MODES: readonly ChaseMode[] = ['near', 'far', 'hood', 'interior'];

export interface ChaseTarget {
  /** Interpolated vehicle position and orientation. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  speed: number;
  /** Vehicle length/height (for the boom) and the driver's eye point (local) for the interior view. */
  length: number;
  height: number;
  eye: THREE.Vector3;
}

const CHASE = {
  pitch: -0.16,
  radius: 0.32,
  lookReturnDelay: 1.4,
  fov: 62,
  fovBoost: 14,
} as const;

const fwd = new THREE.Vector3();
const local = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Vehicle camera: chase (near/far) behind the vehicle's heading with damped yaw, look-around that
 * springs back, a hood camera and a driver's-eye interior view. The chase boom uses the same
 * sweep collision as the on-foot camera (ignoring the vehicle itself).
 */
export class ChaseCamera {
  mode: ChaseMode = 'near';
  yaw = 0;
  pitch: number = CHASE.pitch;
  lookYaw = 0;
  lookPitch = 0;
  distance = 6;
  readonly position = new THREE.Vector3();
  readonly pivot = new THREE.Vector3();
  blocked = false;
  private idle = 0;
  private initialised = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly collision: CameraCollision,
  ) {}

  cycleMode(): void {
    this.mode = CHASE_MODES[(CHASE_MODES.indexOf(this.mode) + 1) % CHASE_MODES.length];
  }

  /** Jump straight behind the vehicle (entering it, teleports). */
  snap(): void {
    this.initialised = false;
  }

  boomLength(target: ChaseTarget): number {
    return this.mode === 'far' ? target.length * 1.5 + 4.5 : target.length * 0.95 + 2.6;
  }

  update(target: ChaseTarget, lookX: number, lookY: number, dt: number): void {
    fwd.set(0, 0, 1).applyQuaternion(target.quaternion);
    const heading = Math.atan2(fwd.x, fwd.z);
    const behind = heading + Math.PI;
    if (lookX !== 0 || lookY !== 0) {
      this.idle = 0;
      this.lookYaw -= lookX;
      this.lookPitch = clamp(this.lookPitch + lookY, -0.6, 0.9);
    } else {
      this.idle += dt;
      if (this.idle > CHASE.lookReturnDelay) {
        this.lookYaw = dampAngle(this.lookYaw, 0, 3, dt);
        this.lookPitch = damp(this.lookPitch, 0, 3, dt);
      }
    }
    if (!this.initialised) {
      this.yaw = behind;
      this.initialised = true;
    } else {
      // Tighter follow at speed; lazy when crawling so small wiggles do not swing the view.
      this.yaw = dampAngle(this.yaw, behind, 2.5 + Math.min(4, target.speed * 0.15), dt);
    }
    const camera = this.camera;
    const fov = CHASE.fov + Math.min(CHASE.fovBoost, Math.max(0, target.speed - 8) * 0.3);

    if (this.mode === 'hood' || this.mode === 'interior') {
      local.copy(
        this.mode === 'hood' ? local.set(0, target.height + 0.15, target.length * 0.22) : target.eye,
      );
      this.position.copy(local).applyQuaternion(target.quaternion).add(target.position);
      this.pivot.copy(this.position);
      camera.position.copy(this.position);
      euler.set(this.lookPitch + Math.asin(clamp(fwd.y, -1, 1)), behind + this.lookYaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(euler);
      this.distance = 0;
      this.blocked = false;
    } else {
      const yaw = this.yaw + this.lookYaw;
      const pitch = CHASE.pitch + this.lookPitch;
      const cosP = Math.cos(pitch);
      const fx = -Math.sin(yaw) * cosP;
      const fy = Math.sin(pitch);
      const fz = -Math.cos(yaw) * cosP;
      this.pivot.copy(target.position);
      this.pivot.y += target.height + 0.6;
      const want = this.boomLength(target);
      const free = this.collision.sweep(
        this.pivot.x,
        this.pivot.y,
        this.pivot.z,
        -fx,
        -fy,
        -fz,
        CHASE.radius,
        want,
      );
      this.blocked = free < want - 1e-3;
      if (free < this.distance) this.distance = free;
      else this.distance = Math.min(free, damp(this.distance, want, 3, dt));
      this.position.set(
        this.pivot.x - fx * this.distance,
        this.pivot.y - fy * this.distance,
        this.pivot.z - fz * this.distance,
      );
      camera.position.copy(this.position);
      euler.set(pitch, yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(euler);
    }
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
