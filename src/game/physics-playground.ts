import * as THREE from 'three';
import type { InputSystem } from '../core/input/input-system';
import { SlotAllocator } from '../core/pool';
import type { Rng } from '../core/rng';
import { entityIndex, type Entity } from '../ecs/entity';
import type { FixedSystem } from '../ecs/scheduler';
import { teleport, Transform } from '../ecs/transform';
import type { World } from '../ecs/world';
import type { PhysicsWorld } from '../physics/physics-world';
import { RigidBodyRef } from '../physics/rigid-body-sync';
import { hideInstance, InstanceRef } from '../rendering/render-sync';

export interface PlaygroundOptions {
  maxBoxes: number;
  /** Seconds between automatic spawns (0 disables auto-spawn). */
  spawnInterval: number;
}

export interface PlaygroundProbe {
  boxes: number;
  minY: number;
  maxY: number;
  meanY: number;
  totalSpawned: number;
}

const BOX_COLORS = [0xe4572e, 0x29335c, 0xf3a712, 0xa8c686, 0x669bbc, 0xd9d9d9, 0x8e5572];
const GROUND_HALF = 120;

/**
 * M0 engine test scene: a ground slab with ramps and pillars, and a stream of rigid boxes
 * (instanced rendering, recycled from a fixed pool). Exercises ECS, physics sync, interpolation,
 * input and the profiler end to end.
 */
export class PhysicsPlayground {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: SlotAllocator;
  private readonly live: { entity: Entity; slot: number }[] = [];
  private spawnTimer = 0;
  private spawned = 0;
  /** Timed spawning on/off (tests switch it off for exact counts). */
  autoSpawn = true;
  private readonly color = new THREE.Color();
  private readonly euler = new THREE.Euler();
  private readonly quaternion = new THREE.Quaternion();
  private readonly staticMeshes: THREE.Object3D[] = [];

  constructor(
    private readonly world: World,
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly rng: Rng,
    readonly options: PlaygroundOptions,
  ) {
    this.slots = new SlotAllocator(options.maxBoxes);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geometry, material, options.maxBoxes);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < options.maxBoxes; i++) {
      hideInstance(this.mesh, i);
      this.mesh.setColorAt(i, this.color.setHex(0xffffff));
    }
    scene.add(this.mesh);
    this.buildStatic();
  }

  get boxCount(): number {
    return this.live.length;
  }

  /** Spawns a box; recycles the oldest box when the pool is full. */
  spawnBox(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): Entity {
    let slot = this.slots.allocate();
    if (slot < 0) {
      this.despawnOldest();
      slot = this.slots.allocate();
    }
    const rng = this.rng;
    const sx = rng.range(0.5, 1.6);
    const sy = rng.range(0.5, 1.6);
    const sz = rng.range(0.5, 1.6);
    this.euler.set(rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2));
    const q = this.quaternion.setFromEuler(this.euler);
    const rotation = [q.x, q.y, q.z, q.w] as const;
    const body = this.physics.createDynamicBox({
      halfExtents: [sx / 2, sy / 2, sz / 2],
      position: [x, y, z],
      rotation,
      linearVelocity: [vx, vy, vz],
      ccd: Math.hypot(vx, vy, vz) > 20,
    });
    const entity = this.world.create();
    this.world.add(entity, Transform);
    teleport(this.world.soa(Transform), entity, x, y, z, rotation[0], rotation[1], rotation[2], rotation[3]);
    this.world.set(entity, RigidBodyRef, body);
    this.world.set(entity, InstanceRef, { mesh: this.mesh, index: slot, sx, sy, sz });
    this.mesh.setColorAt(slot, this.color.setHex(rng.pick(BOX_COLORS)));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.live.push({ entity, slot });
    this.spawned++;
    return entity;
  }

  spawnRandom(count: number): void {
    for (let i = 0; i < count; i++) {
      const rng = this.rng;
      this.spawnBox(rng.range(-25, 25), rng.range(12, 40), rng.range(-25, 25));
    }
  }

  clear(): void {
    while (this.live.length > 0) this.despawnOldest();
  }

  probe(): PlaygroundProbe {
    const t = this.world.soa(Transform);
    let minY = Infinity;
    let maxY = -Infinity;
    let sum = 0;
    for (const { entity } of this.live) {
      const y = t.f.py[entityIndex(entity)];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sum += y;
    }
    const n = this.live.length;
    return {
      boxes: n,
      minY: n ? minY : 0,
      maxY: n ? maxY : 0,
      meanY: n ? sum / n : 0,
      totalSpawned: this.spawned,
    };
  }

  /** Auto-spawns on a timer and throws a box from the camera when `fire` is pressed. */
  createSystem(
    input: InputSystem,
    aim: () => { origin: THREE.Vector3; direction: THREE.Vector3 },
  ): FixedSystem {
    return {
      name: 'playgroundSpawner',
      phase: 'gameplay',
      fixedUpdate: (ctx): void => {
        if (this.autoSpawn && this.options.spawnInterval > 0 && this.live.length < this.options.maxBoxes) {
          this.spawnTimer += ctx.dt;
          while (this.spawnTimer >= this.options.spawnInterval) {
            this.spawnTimer -= this.options.spawnInterval;
            this.spawnRandom(1);
          }
        }
        if (input.pressed('fire')) {
          const { origin, direction } = aim();
          const speed = 28;
          this.spawnBox(
            origin.x + direction.x * 2,
            origin.y + direction.y * 2,
            origin.z + direction.z * 2,
            direction.x * speed,
            direction.y * speed,
            direction.z * speed,
          );
        }
      },
    };
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const object of this.staticMeshes) this.scene.remove(object);
  }

  private despawnOldest(): void {
    const oldest = this.live.shift();
    if (!oldest) return;
    const body = this.world.get(oldest.entity, RigidBodyRef);
    if (body) this.physics.removeBody(body);
    this.world.destroy(oldest.entity);
    hideInstance(this.mesh, oldest.slot);
    this.slots.release(oldest.slot);
  }

  private buildStatic(): void {
    const groundTexture = makeGridTexture();
    groundTexture.wrapS = THREE.RepeatWrapping;
    groundTexture.wrapT = THREE.RepeatWrapping;
    groundTexture.repeat.set(GROUND_HALF / 4, GROUND_HALF / 4);
    groundTexture.anisotropy = 8;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
      new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 0.92 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.addStatic(ground);
    this.physics.createFixedBox({ halfExtents: [GROUND_HALF, 0.5, GROUND_HALF], position: [0, -0.5, 0] });

    const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b2a7, roughness: 0.8 });
    const addBlock = (
      hx: number,
      hy: number,
      hz: number,
      x: number,
      y: number,
      z: number,
      tiltX = 0,
    ): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), concrete);
      mesh.position.set(x, y, z);
      mesh.rotation.x = tiltX;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.addStatic(mesh);
      const q = new THREE.Quaternion().setFromEuler(mesh.rotation);
      this.physics.createFixedBox({
        halfExtents: [hx, hy, hz],
        position: [x, y, z],
        rotation: [q.x, q.y, q.z, q.w],
      });
    };
    addBlock(6, 0.4, 14, -18, 3.5, 0, 0.32);
    addBlock(6, 0.4, 14, 18, 3.5, 0, 0.32);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      addBlock(1.2, 4, 1.2, Math.cos(a) * 34, 4, Math.sin(a) * 34);
    }
    addBlock(10, 1, 10, 0, 1, -40);

    const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5b4a3a, 1.1);
    this.addStatic(hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    sun.position.set(40, 70, 25);
    sun.castShadow = true;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.addStatic(sun);
    this.addStatic(sun.target);
  }

  private addStatic(object: THREE.Object3D): void {
    this.scene.add(object);
    this.staticMeshes.push(object);
  }
}

/** Procedural 4 m grid tile (no external assets). */
function makeGridTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#6f7a6b';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#66715f';
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
