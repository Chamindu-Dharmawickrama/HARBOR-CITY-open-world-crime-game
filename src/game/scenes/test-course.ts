import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Collider } from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../../physics/physics-world';
import type { TerrainModel } from '../../world/gen/islands';

/** Named spots on the course: [x, y, z, yaw] with yaw 0 facing +Z. */
export interface CourseSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const COURSE_SPOTS = [
  'start',
  'wall12',
  'wall26',
  'kerb',
  'tower10',
  'tower30',
  'water',
  'ceiling',
  'wallwalk',
] as const;
export type CourseSpotName = (typeof COURSE_SPOTS)[number];

const WIDTH = 44;
const DEPTH = 32;
const DECK_HEIGHT = 1.2;

interface Block {
  min: [number, number, number];
  max: [number, number, number];
  colour: number;
}

const DECK = 0x8d8f8a;
const HAZARD = 0xc9a227;
const TOWER = 0x6f7f8f;
const ROOF = 0xb5523b;
const WALL = 0xb9b2a4;

/** Course layout in local metres (x ∈ [0, 44], z ∈ [0, 32]; y relative to the deck top). */
function blocks(): Block[] {
  const b = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    colour: number,
  ): Block => ({
    min: [x0, y0, z0],
    max: [x1, y1, z1],
    colour,
  });
  return [
    b(0, -4.2, 0, WIDTH, 0, DEPTH, DECK), // pontoon deck (open water on every side)
    b(12, 0, 22, 22, 1.2, 22.8, HAZARD), // climbable 1.2 m wall
    b(26, 0, 22, 36, 2.6, 22.8, HAZARD), // too-high 2.6 m wall
    b(3, 0, 22, 9, 0.3, 26, DECK), // 0.3 m kerb
    b(30, 0, 3, 35, 10, 8, TOWER), // 10 m tower
    b(38, 0, 3, 42, 30, 7, TOWER), // 30 m tower
    b(3, 0, 6, 3.4, 1.7, 14, WALL), // low tunnel (1.3 m clearance) for crouching
    b(8.6, 0, 6, 9, 1.7, 14, WALL),
    b(3, 1.3, 6, 9, 1.7, 14, ROOF),
    b(14, 0, 10, 24, 8, 11, WALL), // tall wall + corner for camera-collision checks
    b(24, 0, 10, 25, 8, 18, WALL),
  ];
}

/**
 * Developer obstacle course on a pontoon in open water near the docks: walls to climb (and one
 * too high), a kerb, 10 m and 30 m towers for fall damage, a low tunnel for crouching, tall walls
 * for camera-collision checks, and water all around for swimming and climbing out.
 */
export class TestCourse {
  readonly deckY: number;
  readonly mesh: THREE.Mesh;
  private readonly colliders: Collider[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    readonly originX: number,
    readonly originZ: number,
    waterLevel: number,
  ) {
    this.deckY = waterLevel + DECK_HEIGHT;
    const parts: THREE.BufferGeometry[] = [];
    const colour = new THREE.Color();
    for (const block of blocks()) {
      const [x0, y0, z0] = block.min;
      const [x1, y1, z1] = block.max;
      const hx = (x1 - x0) / 2;
      const hy = (y1 - y0) / 2;
      const hz = (z1 - z0) / 2;
      const cx = originX + x0 + hx;
      const cy = this.deckY + y0 + hy;
      const cz = originZ + z0 + hz;
      this.colliders.push(physics.createFixedBox({ halfExtents: [hx, hy, hz], position: [cx, cy, cz] }));
      const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2).translate(cx, cy, cz);
      geometry.deleteAttribute('uv');
      colour.setHex(block.colour, THREE.SRGBColorSpace);
      const count = geometry.getAttribute('position').count;
      const colours = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) colours.set([colour.r, colour.g, colour.b], i * 3);
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      parts.push(geometry);
    }
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error('TestCourse: geometry merge failed');
    this.mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    );
    this.mesh.name = 'testCourse';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  spot(name: CourseSpotName): CourseSpot {
    const x = this.originX;
    const z = this.originZ;
    const y = this.deckY;
    switch (name) {
      case 'start':
        // Open lane x ≈ 10.5 runs the full depth of the deck.
        return { x: x + 10.5, y, z: z + 31, yaw: Math.PI };
      case 'wall12':
        return { x: x + 17, y, z: z + 20.6, yaw: 0 };
      case 'wall26':
        return { x: x + 31, y, z: z + 20.6, yaw: 0 };
      case 'kerb':
        return { x: x + 6, y, z: z + 19, yaw: 0 };
      case 'tower10':
        return { x: x + 32.5, y: y + 10, z: z + 5.5, yaw: -Math.PI / 2 };
      case 'tower30':
        return { x: x + 40, y: y + 30, z: z + 5, yaw: 0 };
      case 'water':
        return { x: x - 7, y: y - DECK_HEIGHT, z: z + 17, yaw: Math.PI / 2 };
      case 'ceiling':
        return { x: x + 6, y, z: z + 17, yaw: Math.PI };
      case 'wallwalk':
        return { x: x + 13, y, z: z + 12.2, yaw: Math.PI / 2 };
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    for (const c of this.colliders) this.physics.removeCollider(c);
  }
}

/**
 * Finds the nearest spot to (x, z) where the whole course plus a margin sits on open water,
 * away from the given keep-out points (bridges, tunnel). Deterministic for a given city.
 */
export function findOpenWater(
  terrain: TerrainModel,
  x: number,
  z: number,
  keepOut: readonly { x: number; z: number; radius: number }[],
): { x: number; z: number } {
  const margin = 14;
  const clear = (ox: number, oz: number): boolean => {
    for (let px = ox - margin; px <= ox + WIDTH + margin; px += 4) {
      for (let pz = oz - margin; pz <= oz + DEPTH + margin; pz += 4) {
        if (terrain.isLand(px, pz)) return false;
      }
    }
    for (const k of keepOut) {
      const cx = Math.max(ox - margin, Math.min(k.x, ox + WIDTH + margin));
      const cz = Math.max(oz - margin, Math.min(k.z, oz + DEPTH + margin));
      if ((cx - k.x) ** 2 + (cz - k.z) ** 2 < k.radius * k.radius) return false;
    }
    return true;
  };
  for (let r = 0; r <= 2400; r += 24) {
    const steps = Math.max(1, Math.round((2 * Math.PI * r) / 40));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const ox = x + Math.cos(a) * r - WIDTH / 2;
      const oz = z + Math.sin(a) * r - DEPTH / 2;
      if (clear(ox, oz)) return { x: ox, z: oz };
    }
  }
  throw new Error('findOpenWater: no open water found for the test course');
}
