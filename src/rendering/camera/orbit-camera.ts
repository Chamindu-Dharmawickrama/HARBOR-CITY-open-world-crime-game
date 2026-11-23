import * as THREE from 'three';
import { clamp, damp, dampAngle, stepCriticalSpring, type SpringState } from '../../core/math';

/** Sphere sweeps against the world (injected, so rendering stays independent of physics). */
export interface CameraCollision {
  /** A physics body to ignore (the vehicle the camera is following), or null. */
  ignore: unknown;
  /** Free distance for a sphere of `radius` moved from the origin along the unit direction. */
  sweep(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    radius: number,
    maxDistance: number,
  ): number;
}

export const ORBIT = {
  /** Follow distances cycled by the camera-mode button. */
  distances: [2.9, 4.3, 6.4] as readonly number[],
  followShoulder: 0.32,
  followFov: 62,
  aimDistance: 1.65,
  aimShoulder: 0.55,
  aimFov: 48,
  /** Pivot height above the feet as a fraction of the character's height. */
  pivotFactor: 0.88,
  aimPivotFactor: 0.94,
  pitchMin: -1.25,
  pitchMax: 0.95,
  /** Collision sphere radius — covers the near-plane corners (near 0.2 m, 62° FOV, 16:9). */
  radius: 0.32,
  near: 0.2,
  /** Horizontal / vertical follow spring frequencies (rad/s). */
  followOmega: 22,
  verticalOmega: 11,
  /** How fast the boom extends again after a collision pulled it in (1/s). */
  extendRate: 3.5,
  /** Gentle auto-recentre behind a moving character after this many seconds without look input. */
  recentreDelay: 1.6,
  recentreRate: 1.4,
} as const;

export interface OrbitTarget {
  /** Feet position (interpolated). */
  x: number;
  y: number;
  z: number;
  height: number;
  /** Facing yaw of the character (0 = +Z) and its horizontal speed — for auto-recentring. */
  heading: number;
  speed: number;
}

/**
 * Third-person spring-arm camera: orbit with yaw/pitch, critically damped follow, over-the-shoulder
 * aim mode with shoulder swap, three follow distances, and collision that never lets the view
 * pass through walls (the boom snaps in immediately and eases back out).
 *
 * Yaw convention matches the fly camera: yaw 0 looks north (−Z), positive yaw turns left.
 */
export class OrbitCamera {
  yaw = 0;
  pitch = -0.18;
  distanceIndex = 1;
  shoulder: 1 | -1 = 1;
  aiming = false;
  /** Current (collision-limited) boom length and the length collision allows this frame. */
  distance: number = ORBIT.distances[1];
  freeDistance = 0;
  /** True when the last update shortened the boom because of geometry. */
  blocked = false;
  readonly position = new THREE.Vector3();
  readonly pivot = new THREE.Vector3();
  private readonly sx: SpringState = { value: 0, velocity: 0 };
  private readonly sy: SpringState = { value: 0, velocity: 0 };
  private readonly sz: SpringState = { value: 0, velocity: 0 };
  private aimBlend = 0;
  private idleLook = 0;
  private initialised = false;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly collision: CameraCollision,
  ) {}

  get desiredDistance(): number {
    const follow = ORBIT.distances[this.distanceIndex];
    return follow + (ORBIT.aimDistance - follow) * this.aimBlend;
  }

  cycleDistance(): void {
    this.distanceIndex = (this.distanceIndex + 1) % ORBIT.distances.length;
  }

  swapShoulder(): void {
    this.shoulder = this.shoulder === 1 ? -1 : 1;
  }

  /** Places the camera behind the target without smoothing (spawns, teleports). */
  snap(target: OrbitTarget): void {
    this.initialised = false;
    this.yaw = target.heading + Math.PI;
    this.distance = this.desiredDistance;
  }

  /** Forward direction on the ground plane (unit) — movement is relative to this. */
  groundForward(out: { x: number; z: number }): void {
    out.x = -Math.sin(this.yaw);
    out.z = -Math.cos(this.yaw);
  }

  /**
   * @param lookX/lookY Look input this frame (radians; +x right, +y up).
   */
  update(target: OrbitTarget, lookX: number, lookY: number, dt: number): void {
    this.yaw -= lookX;
    this.pitch = clamp(this.pitch + lookY, ORBIT.pitchMin, ORBIT.pitchMax);
    this.aimBlend = clamp(this.aimBlend + (this.aiming ? dt * 7 : -dt * 5), 0, 1);
    const aim = this.aimBlend;

    // Auto-recentre behind a moving character when the player is not steering the camera.
    if (lookX !== 0 || lookY !== 0) this.idleLook = 0;
    else this.idleLook += dt;
    if (!this.aiming && this.idleLook > ORBIT.recentreDelay && target.speed > 2.5) {
      this.yaw = dampAngle(
        this.yaw,
        target.heading + Math.PI,
        ORBIT.recentreRate * Math.min(1, target.speed / 7),
        dt,
      );
    }

    // Pivot: critically damped follow of the character's upper body.
    const pivotY =
      target.y + target.height * (ORBIT.pivotFactor + (ORBIT.aimPivotFactor - ORBIT.pivotFactor) * aim);
    if (!this.initialised) {
      this.sx.value = target.x;
      this.sy.value = pivotY;
      this.sz.value = target.z;
      this.sx.velocity = 0;
      this.sy.velocity = 0;
      this.sz.velocity = 0;
      this.initialised = true;
    } else {
      stepCriticalSpring(this.sx, target.x, ORBIT.followOmega, dt);
      stepCriticalSpring(this.sy, pivotY, ORBIT.verticalOmega, dt);
      stepCriticalSpring(this.sz, target.z, ORBIT.followOmega, dt);
    }

    const cosP = Math.cos(this.pitch);
    const fx = -Math.sin(this.yaw) * cosP;
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.yaw) * cosP;
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const r = ORBIT.radius;

    // 1) Shoulder offset, swept sideways from the (unsmoothed-height) head so it never pokes into a wall.
    const shoulder =
      (ORBIT.followShoulder + (ORBIT.aimShoulder - ORBIT.followShoulder) * aim) * this.shoulder;
    const headX = this.sx.value;
    const headY = this.sy.value;
    const headZ = this.sz.value;
    const side = this.collision.sweep(
      headX,
      headY,
      headZ,
      rx * Math.sign(shoulder),
      0,
      rz * Math.sign(shoulder),
      r,
      Math.abs(shoulder),
    );
    this.pivot.set(headX + rx * side * Math.sign(shoulder), headY, headZ + rz * side * Math.sign(shoulder));

    // 2) Boom: sweep back from the pivot; snap in on contact, ease back out when clear.
    const want = this.desiredDistance;
    const free = this.collision.sweep(this.pivot.x, this.pivot.y, this.pivot.z, -fx, -fy, -fz, r, want);
    this.freeDistance = free;
    this.blocked = free < want - 1e-3;
    if (free < this.distance) this.distance = free;
    else this.distance = Math.min(free, damp(this.distance, want, ORBIT.extendRate, dt));
    const d = Math.max(0, this.distance);
    this.position.set(this.pivot.x - fx * d, this.pivot.y - fy * d, this.pivot.z - fz * d);

    const camera = this.camera;
    camera.position.copy(this.position);
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
    const fov = ORBIT.followFov + (ORBIT.aimFov - ORBIT.followFov) * aim;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Sets yaw/pitch to look along a world direction (used by tests and scripted cameras). */
  lookAlong(dx: number, dy: number, dz: number): void {
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), ORBIT.pitchMin, ORBIT.pitchMax);
  }
}
