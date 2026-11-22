import * as THREE from 'three';
import { entityIndex, type Entity } from '../ecs/entity';
import { teleport, Transform } from '../ecs/transform';
import type { World } from '../ecs/world';
import type { PhysicsWorld } from '../physics/physics-world';
import { RigidBodyRef } from '../physics/rigid-body-sync';
import { RenderObject } from '../rendering/render-sync';

const MAX_BOXES = 64;

/** Developer tool: drops dynamic crates into the world (collision and prop-knock checks). */
export class DebugBoxes {
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xc9732b, roughness: 0.7 });
  private readonly boxes: { entity: Entity; mesh: THREE.Mesh }[] = [];

  constructor(
    private readonly world: World,
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
  ) {}

  get count(): number {
    return this.boxes.length;
  }

  drop(x: number, y: number, z: number, size = 1, vy = 0, density = 400): Entity {
    if (this.boxes.length >= MAX_BOXES)
      this.remove(this.boxes.shift() as { entity: Entity; mesh: THREE.Mesh });
    const body = this.physics.createDynamicBox({
      halfExtents: [size / 2, size / 2, size / 2],
      position: [x, y, z],
      linearVelocity: [0, vy, 0],
      density,
      ccd: true,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.scale.setScalar(size);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const entity = this.world.create();
    this.world.add(entity, Transform);
    teleport(this.world.soa(Transform), entity, x, y, z);
    this.world.set(entity, RigidBodyRef, body);
    this.world.set(entity, RenderObject, mesh);
    this.boxes.push({ entity, mesh });
    return entity;
  }

  /** Lowest box y (after settling this tells whether the ground collider caught it). */
  positions(): { x: number; y: number; z: number }[] {
    const t = this.world.soa(Transform).f;
    return this.boxes.map(({ entity }) => {
      const i = entityIndex(entity);
      return { x: t.px[i], y: t.py[i], z: t.pz[i] };
    });
  }

  clear(): void {
    while (this.boxes.length > 0) this.remove(this.boxes.pop() as { entity: Entity; mesh: THREE.Mesh });
  }

  private remove(box: { entity: Entity; mesh: THREE.Mesh }): void {
    const body = this.world.get(box.entity, RigidBodyRef);
    if (body) this.physics.removeBody(body);
    this.world.destroy(box.entity);
    this.scene.remove(box.mesh);
  }
}
