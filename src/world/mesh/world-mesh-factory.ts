import type { CityModel } from '../gen/city-layout';
import type { CityDef } from '../gen/types';
import { buildBuildingMesh, buildingHulls, type BuildingLod } from './building-mesh';
import { ChunkIndex, type ChunkKey } from './chunk-index';
import { buildCoastGrids, buildGroundMesh, type GroundContext } from './ground-mesh';
import { buildLandmarks, type LandmarkMeshes } from './landmark-mesh';
import type { MeshData } from './mesh-builder';
import { SurfaceIndex } from './surface-index';

export type ChunkPiece = 'groundDetail' | 'groundCoarse' | 'buildings0' | 'buildings1' | 'buildings2';

export interface ColliderData {
  groundVertices: Float32Array;
  groundIndices: Uint32Array;
  /** One point cloud (x,y,z…) per convex building tier. */
  hulls: Float32Array[];
}

export interface PieceResult {
  key: ChunkKey;
  piece: ChunkPiece;
  mesh: MeshData;
  colliders: ColliderData | null;
}

/** Builds chunk geometry on demand from the deterministic city model. Worker-safe. */
export class WorldMeshFactory {
  readonly index: ChunkIndex;
  private readonly ground: GroundContext;

  constructor(
    readonly model: CityModel,
    readonly city: CityDef,
  ) {
    this.index = new ChunkIndex(model.layout, model.graph, model.terrain, city.chunkSize);
    this.ground = {
      layout: model.layout,
      terrain: model.terrain,
      index: this.index,
      surfaces: new SurfaceIndex(model.layout, model.graph),
      coastGrid: buildCoastGrids(model.layout),
    };
  }

  build(key: ChunkKey, piece: ChunkPiece, withColliders: boolean): PieceResult {
    const chunk = this.index.get(key);
    if (!chunk) throw new Error(`Unknown chunk ${key}`);
    let mesh: MeshData;
    switch (piece) {
      case 'groundDetail':
        mesh = buildGroundMesh(this.ground, chunk, true);
        break;
      case 'groundCoarse':
        mesh = buildGroundMesh(this.ground, chunk, false);
        break;
      case 'buildings0':
      case 'buildings1':
      case 'buildings2': {
        const lod = Number(piece.slice(-1)) as BuildingLod;
        mesh = buildBuildingMesh(
          chunk.buildings.map((i) => this.model.layout.buildings[i]).filter((b) => b !== undefined),
          lod,
        );
        break;
      }
    }
    let colliders: ColliderData | null = null;
    if (withColliders && piece === 'groundDetail') {
      colliders = {
        groundVertices: mesh.positions.slice(),
        // Rapier trimeshes take 32-bit indices regardless of the render index width.
        groundIndices: Uint32Array.from(mesh.indices),
        hulls: chunk.buildings.flatMap((i) => {
          const b = this.model.layout.buildings[i];
          return b ? buildingHulls(b) : [];
        }),
      };
    }
    return { key, piece, mesh, colliders };
  }

  landmarks(): LandmarkMeshes {
    return buildLandmarks(this.model.layout, this.index, this.model.terrain, this.city);
  }
}

export function colliderTransferables(c: ColliderData): ArrayBuffer[] {
  return [
    c.groundVertices.buffer as ArrayBuffer,
    c.groundIndices.buffer as ArrayBuffer,
    ...c.hulls.map((h) => h.buffer as ArrayBuffer),
  ];
}
