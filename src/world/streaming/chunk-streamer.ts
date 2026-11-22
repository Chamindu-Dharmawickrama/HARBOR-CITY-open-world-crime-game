import type { Collider } from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { GROUPS_STATIC_WORLD } from '../../physics/collision-groups';
import type { PhysicsWorld } from '../../physics/physics-world';
import type { ChunkContents, ChunkIndex, ChunkKey } from '../mesh/chunk-index';
import type { ChunkPiece, ColliderData, PieceResult } from '../mesh/world-mesh-factory';
import type { PropManager } from '../props/prop-manager';
import {
  buildingFallbacks,
  chunkDistance,
  releaseDistance,
  wantsAt,
  type ChunkWants,
  type StreamingRings,
} from './chunk-planner';
import { meshByteSize, meshFromData } from './mesh-upload';
import type { WorkerPool } from './worker-pool';

const PIECES: readonly ChunkPiece[] = [
  'groundDetail',
  'groundCoarse',
  'buildings0',
  'buildings1',
  'buildings2',
];
const MAX_RETRIES = 2;

interface Slot {
  status: 'idle' | 'pending' | 'ready' | 'failed';
  mesh: THREE.Mesh | null;
  retries: number;
}

interface ChunkRuntime {
  contents: ChunkContents;
  slots: Record<ChunkPiece, Slot>;
  distance: number;
  wants: ChunkWants;
  colliders: Collider[] | null;
  colliderData: ColliderData | null;
  colliderRequested: boolean;
  shownGround: THREE.Mesh | null;
  shownBuildings: THREE.Mesh | null;
}

export interface StreamerDeps {
  pool: WorkerPool;
  index: ChunkIndex;
  scene: THREE.Scene;
  physics: PhysicsWorld;
  groundMaterial: THREE.Material;
  buildingMaterial: THREE.Material;
  props: PropManager;
  /** Wall clock in ms (injected; used only for the per-frame upload budget). */
  now: () => number;
}

export interface StreamerStats {
  chunks: number;
  meshes: number;
  pending: number;
  queued: number;
  colliderChunks: number;
  uploadsLastFrame: number;
  failed: number;
}

/**
 * Keeps the right level of detail loaded around the camera. Pieces are requested from the
 * worker pool by priority (nearest first), uploaded under a per-frame time budget, shown with
 * LOD fallbacks so nothing pops to empty, and released past their ring plus hysteresis.
 * Colliders (ground trimesh, building hulls, props) exist only in the near ring.
 */
export class ChunkStreamer {
  private readonly chunks: ChunkRuntime[];
  private readonly byKey = new Map<ChunkKey, ChunkRuntime>();
  private readonly uploads: { chunk: ChunkRuntime; result: PieceResult }[] = [];
  private uploadsLastFrame = 0;
  /** Camera position of the last update (progress() refers to this position). */
  lastX = Number.NaN;
  lastZ = Number.NaN;
  private readonly visible: THREE.Mesh[] = [];

  constructor(
    private readonly deps: StreamerDeps,
    public rings: StreamingRings,
  ) {
    this.chunks = deps.index.keys().map((key) => {
      const contents = deps.index.get(key) as ChunkContents;
      const slots = {} as Record<ChunkPiece, Slot>;
      for (const p of PIECES) slots[p] = { status: 'idle', mesh: null, retries: 0 };
      const runtime: ChunkRuntime = {
        contents,
        slots,
        distance: Infinity,
        wants: { ground: null, buildings: null, colliders: false },
        colliders: null,
        colliderData: null,
        colliderRequested: false,
        shownGround: null,
        shownBuildings: null,
      };
      this.byKey.set(key, runtime);
      return runtime;
    });
  }

  /** Meshes currently shown (for occlusion culling). */
  get shownMeshes(): readonly THREE.Mesh[] {
    return this.visible;
  }

  /**
   * @param budgetMs  CPU time allowed for creating meshes this frame.
   * @param budgetBytes  GPU upload volume allowed this frame: new meshes are uploaded on their first
   *   render, and too many at once stalls the GPU command buffer for 100+ ms.
   */
  update(x: number, z: number, budgetMs: number, budgetBytes = Infinity): void {
    this.lastX = x;
    this.lastZ = z;
    const size = this.deps.index.chunkSize;
    for (const chunk of this.chunks) {
      chunk.distance = chunkDistance(chunk.contents.cx, chunk.contents.cz, size, x, z);
      chunk.wants = wantsAt(chunk.distance, this.rings);
    }
    this.requestMissing();
    this.processUploads(budgetMs, budgetBytes);
    this.updateColliders();
    this.assignVisibility();
    this.release();
  }

  /** Fraction of the pieces wanted right now that are loaded (1 = fully streamed in). */
  progress(): number {
    let wanted = 0;
    let ready = 0;
    for (const chunk of this.chunks) {
      for (const piece of [chunk.wants.ground, chunk.wants.buildings]) {
        if (!piece) continue;
        wanted++;
        const status = chunk.slots[piece].status;
        if (status === 'ready' || status === 'failed') ready++;
      }
      if (chunk.wants.colliders) {
        wanted++;
        if (chunk.colliders) ready++;
      }
    }
    return wanted === 0 ? 1 : ready / wanted;
  }

  stats(): StreamerStats {
    let meshes = 0;
    let pending = 0;
    let failed = 0;
    let colliderChunks = 0;
    for (const chunk of this.chunks) {
      for (const p of PIECES) {
        const s = chunk.slots[p];
        if (s.status === 'ready') meshes++;
        if (s.status === 'pending') pending++;
        if (s.status === 'failed') failed++;
      }
      if (chunk.colliders) colliderChunks++;
    }
    return {
      chunks: this.chunks.length,
      meshes,
      pending,
      queued: this.uploads.length,
      colliderChunks,
      uploadsLastFrame: this.uploadsLastFrame,
      failed,
    };
  }

  dispose(): void {
    for (const chunk of this.chunks) {
      for (const p of PIECES) this.unload(chunk, p);
      this.removeColliders(chunk);
    }
  }

  private requestMissing(): void {
    const maxInFlight = this.deps.pool.size * 3;
    if (this.deps.pool.inFlight >= maxInFlight) return;
    const wanted: { chunk: ChunkRuntime; piece: ChunkPiece; priority: number }[] = [];
    for (const chunk of this.chunks) {
      const { ground, buildings } = chunk.wants;
      const nearBonus = chunk.wants.colliders ? -1000 : 0;
      if (ground && chunk.slots[ground].status === 'idle')
        wanted.push({ chunk, piece: ground, priority: chunk.distance + nearBonus });
      if (buildings && chunk.slots[buildings].status === 'idle')
        wanted.push({ chunk, piece: buildings, priority: chunk.distance + nearBonus + 1 });
      if (
        chunk.wants.colliders &&
        !chunk.colliders &&
        !chunk.colliderRequested &&
        chunk.slots.groundDetail.status === 'ready'
      ) {
        // Ground detail was loaded without colliders (it entered via the mid ring): fetch them.
        wanted.push({ chunk, piece: 'groundDetail', priority: chunk.distance - 2000 });
      }
    }
    wanted.sort((a, b) => a.priority - b.priority);
    for (const w of wanted) {
      if (this.deps.pool.inFlight >= maxInFlight) break;
      this.request(w.chunk, w.piece);
    }
  }

  private request(chunk: ChunkRuntime, piece: ChunkPiece): void {
    const slot = chunk.slots[piece];
    const withColliders = piece === 'groundDetail' && chunk.wants.colliders;
    const colliderOnly = piece === 'groundDetail' && slot.status === 'ready';
    if (!colliderOnly) slot.status = 'pending';
    if (withColliders) chunk.colliderRequested = true;
    this.deps.pool.build(chunk.contents.key, piece, withColliders).then(
      (result) => {
        if (colliderOnly) {
          chunk.colliderData = result.colliders;
          return;
        }
        this.uploads.push({ chunk, result });
      },
      (error: unknown) => {
        console.error(`[streaming] ${chunk.contents.key}/${piece} failed`, error);
        if (withColliders) chunk.colliderRequested = false;
        if (colliderOnly) return;
        slot.retries++;
        slot.status = slot.retries > MAX_RETRIES ? 'failed' : 'idle';
      },
    );
  }

  private processUploads(budgetMs: number, budgetBytes: number): void {
    const start = this.deps.now();
    let done = 0;
    let bytes = 0;
    // Nearest first, so the area around the camera fills in before the distance.
    if (this.uploads.length > 1) this.uploads.sort((a, b) => a.chunk.distance - b.chunk.distance);
    while (this.uploads.length > 0) {
      if (done > 0 && (this.deps.now() - start > budgetMs || bytes >= budgetBytes)) break;
      const { chunk, result } = this.uploads.shift() as { chunk: ChunkRuntime; result: PieceResult };
      const slot = chunk.slots[result.piece];
      if (slot.status !== 'pending') continue;
      const isGround = result.piece === 'groundDetail' || result.piece === 'groundCoarse';
      const mesh = meshFromData(
        result.mesh,
        isGround ? this.deps.groundMaterial : this.deps.buildingMaterial,
        `${chunk.contents.key}:${result.piece}`,
      );
      mesh.receiveShadow = true;
      mesh.castShadow = result.piece === 'buildings0' || result.piece === 'buildings1';
      mesh.visible = false;
      this.deps.scene.add(mesh);
      slot.mesh = mesh;
      slot.status = 'ready';
      bytes += meshByteSize(result.mesh);
      if (result.colliders) chunk.colliderData = result.colliders;
      done++;
    }
    this.uploadsLastFrame = done;
  }

  /** Creates colliders for at most one chunk per frame (trimesh BVH builds are not free). */
  private updateColliders(): void {
    let created = false;
    for (const chunk of this.chunks) {
      const keep = chunk.distance <= this.rings.near + this.rings.hysteresis;
      if (!keep && chunk.colliders) this.removeColliders(chunk);
      if (!keep) {
        chunk.colliderData = null;
        chunk.colliderRequested = false;
        continue;
      }
      if (!created && chunk.wants.colliders && !chunk.colliders && chunk.colliderData) {
        this.createColliders(chunk, chunk.colliderData);
        chunk.colliderData = null;
        created = true;
      }
    }
  }

  private createColliders(chunk: ChunkRuntime, data: ColliderData): void {
    const { rapier, world } = this.deps.physics;
    const colliders: Collider[] = [];
    if (data.groundIndices.length > 0) {
      const desc = rapier.ColliderDesc.trimesh(data.groundVertices, data.groundIndices)
        .setCollisionGroups(GROUPS_STATIC_WORLD)
        .setFriction(0.9);
      colliders.push(world.createCollider(desc));
    }
    for (const hull of data.hulls) {
      const desc = rapier.ColliderDesc.convexHull(hull);
      if (desc)
        colliders.push(world.createCollider(desc.setCollisionGroups(GROUPS_STATIC_WORLD).setFriction(0.7)));
    }
    chunk.colliders = colliders;
    this.deps.props.addColliders(chunk.contents.props);
  }

  private removeColliders(chunk: ChunkRuntime): void {
    if (!chunk.colliders) return;
    for (const c of chunk.colliders) this.deps.physics.removeCollider(c);
    chunk.colliders = null;
    this.deps.props.removeColliders(chunk.contents.props);
  }

  private assignVisibility(): void {
    this.visible.length = 0;
    for (const chunk of this.chunks) {
      const { ground, buildings } = chunk.wants;
      let groundMesh: THREE.Mesh | null = null;
      if (ground) {
        const order: ChunkPiece[] =
          ground === 'groundDetail' ? ['groundDetail', 'groundCoarse'] : ['groundCoarse', 'groundDetail'];
        for (const p of order) {
          const s = chunk.slots[p];
          if (s.status === 'ready' && s.mesh) {
            groundMesh = s.mesh;
            break;
          }
        }
      }
      let buildingMesh: THREE.Mesh | null = null;
      if (buildings) {
        for (const p of buildingFallbacks(buildings)) {
          const s = chunk.slots[p];
          if (s.status === 'ready' && s.mesh) {
            buildingMesh = s.mesh;
            break;
          }
        }
      }
      if (chunk.shownGround && chunk.shownGround !== groundMesh) chunk.shownGround.visible = false;
      if (chunk.shownBuildings && chunk.shownBuildings !== buildingMesh) chunk.shownBuildings.visible = false;
      chunk.shownGround = groundMesh;
      chunk.shownBuildings = buildingMesh;
      if (groundMesh) {
        groundMesh.visible = true;
        this.visible.push(groundMesh);
      }
      if (buildingMesh) {
        buildingMesh.visible = true;
        this.visible.push(buildingMesh);
      }
    }
  }

  private release(): void {
    for (const chunk of this.chunks) {
      for (const p of PIECES) {
        const slot = chunk.slots[p];
        if (slot.status !== 'ready') continue;
        if (slot.mesh === chunk.shownGround || slot.mesh === chunk.shownBuildings) continue;
        if (chunk.distance > releaseDistance(p, this.rings)) this.unload(chunk, p);
      }
    }
  }

  private unload(chunk: ChunkRuntime, piece: ChunkPiece): void {
    const slot = chunk.slots[piece];
    if (slot.mesh) {
      this.deps.scene.remove(slot.mesh);
      slot.mesh.geometry.dispose();
      slot.mesh = null;
    }
    if (slot.status === 'ready') slot.status = 'idle';
  }

  /** Test/debug helper: the shown pieces for a chunk key. */
  shownPieces(key: ChunkKey): { ground: string | null; buildings: string | null; colliders: boolean } {
    const chunk = this.byKey.get(key);
    if (!chunk) return { ground: null, buildings: null, colliders: false };
    const name = (m: THREE.Mesh | null): string | null => (m ? (m.name.split(':')[1] ?? null) : null);
    return {
      ground: name(chunk.shownGround),
      buildings: name(chunk.shownBuildings),
      colliders: chunk.colliders !== null,
    };
  }
}
