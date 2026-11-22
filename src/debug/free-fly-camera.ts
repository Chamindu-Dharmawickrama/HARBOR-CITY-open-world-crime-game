import * as THREE from 'three';
import { clamp } from '../core/math';
import type { Vec2Out } from '../core/input/deadzone';
import type { InputSystem } from '../core/input/input-system';
import type { RenderContext, RenderSystem } from '../ecs/scheduler';

const PITCH_LIMIT = 1.55;

/**
 * Debug fly camera: WASD/left stick to move, mouse (pointer-locked)/right stick to look,
 * E/Q (Space/Ctrl, RB/LB) for up/down, Shift for fast. Runs at render rate.
 */
export class FreeFlyCamera implements RenderSystem {
  readonly name = 'freeFlyCamera';
  readonly phase = 'camera' as const;
  enabled = true;
  baseSpeed = 20;
  fastMultiplier = 5;
  yaw = 0;
  pitch = -0.25;
  private readonly look: Vec2Out = { x: 0, y: 0 };
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: InputSystem,
  ) {}

  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.camera.position.set(x, y, z);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.applyRotation();
  }

  lookAt(x: number, y: number, z: number): void {
    const dx = x - this.camera.position.x;
    const dy = y - this.camera.position.y;
    const dz = z - this.camera.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -PITCH_LIMIT, PITCH_LIMIT);
    this.applyRotation();
  }

  renderUpdate(ctx: RenderContext): void {
    if (!this.enabled) return;
    const input = this.input;
    input.readLook(ctx.frameSeconds, this.look);
    this.yaw -= this.look.x;
    this.pitch = clamp(this.pitch + this.look.y, -PITCH_LIMIT, PITCH_LIMIT);
    this.applyRotation();
    const speed = this.baseSpeed * (input.down('sprint') ? this.fastMultiplier : 1) * ctx.frameSeconds;
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const position = this.camera.position;
    position.addScaledVector(this.forward, input.axis('moveY') * speed);
    position.addScaledVector(this.right, input.axis('moveX') * speed);
    position.y += input.axis('flyY') * speed;
  }

  private applyRotation(): void {
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
