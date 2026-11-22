import * as THREE from 'three';
import type { RenderSystem } from '../ecs/scheduler';
import type { PhysicsWorld } from '../physics/physics-world';

/** Draws every Rapier collider as line segments when enabled (F4). */
export class PhysicsDebugDraw implements RenderSystem {
  readonly name = 'physicsDebugDraw';
  readonly phase = 'ui' as const;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;
  private enabledFlag = false;

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
  ) {
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: true });
    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 10;
    scene.add(this.lines);
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
    this.lines.visible = enabled;
  }

  renderUpdate(): void {
    if (!this.enabledFlag) return;
    const { vertices, colors } = this.physics.debugBuffers();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.geometry.setDrawRange(0, vertices.length / 3);
  }
}
