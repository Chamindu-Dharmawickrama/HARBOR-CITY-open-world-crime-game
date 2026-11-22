import type { ChunkPiece } from '../mesh/world-mesh-factory';

export interface StreamingRings {
  /** Full detail + colliders + prop colliders. */
  near: number;
  /** Full ground, simplified buildings. */
  mid: number;
  /** Coarse ground and box buildings out to the draw distance. */
  far: number;
  /** Extra distance before something loaded is released (prevents thrashing at ring edges). */
  hysteresis: number;
}

export function ringsFor(drawDistance: number, nearRing: number): StreamingRings {
  const far = drawDistance;
  const mid = Math.min(far * 0.65, Math.max(nearRing + 120, far * 0.5));
  return { near: nearRing, mid, far, hysteresis: 48 };
}

/** Distance in the XZ plane from (x, z) to the nearest point of a chunk square. */
export function chunkDistance(cx: number, cz: number, size: number, x: number, z: number): number {
  const minX = cx * size;
  const minZ = cz * size;
  const dx = Math.max(minX - x, 0, x - (minX + size));
  const dz = Math.max(minZ - z, 0, z - (minZ + size));
  return Math.hypot(dx, dz);
}

export type GroundPiece = 'groundDetail' | 'groundCoarse';
export type BuildingPiece = 'buildings0' | 'buildings1' | 'buildings2';

export interface ChunkWants {
  ground: GroundPiece | null;
  buildings: BuildingPiece | null;
  colliders: boolean;
}

/** What a chunk at `distance` should show. */
export function wantsAt(distance: number, rings: StreamingRings): ChunkWants {
  if (distance <= rings.near) return { ground: 'groundDetail', buildings: 'buildings0', colliders: true };
  if (distance <= rings.mid) return { ground: 'groundDetail', buildings: 'buildings1', colliders: false };
  if (distance <= rings.far) return { ground: 'groundCoarse', buildings: 'buildings2', colliders: false };
  return { ground: null, buildings: null, colliders: false };
}

/** The outer radius beyond which a loaded piece is released. */
export function releaseDistance(piece: ChunkPiece, rings: StreamingRings): number {
  switch (piece) {
    case 'buildings0':
      return rings.near + rings.hysteresis;
    case 'groundDetail':
    case 'buildings1':
      return rings.mid + rings.hysteresis;
    case 'groundCoarse':
    case 'buildings2':
      return rings.far + rings.hysteresis;
  }
}

/** Best ready fallback for a building LOD that is not loaded yet (closest detail level first). */
export function buildingFallbacks(wanted: BuildingPiece): BuildingPiece[] {
  switch (wanted) {
    case 'buildings0':
      return ['buildings0', 'buildings1', 'buildings2'];
    case 'buildings1':
      return ['buildings1', 'buildings0', 'buildings2'];
    case 'buildings2':
      return ['buildings2', 'buildings1', 'buildings0'];
  }
}
