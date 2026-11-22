import type { CityDef } from '../gen/types';
import type { ChunkKey } from '../mesh/chunk-index';
import type { LandmarkMeshes } from '../mesh/landmark-mesh';
import type { ChunkPiece, PieceResult } from '../mesh/world-mesh-factory';

export type WorkerRequest =
  | { type: 'init'; seed: number; city: CityDef }
  | { type: 'build'; id: number; key: ChunkKey; piece: ChunkPiece; colliders: boolean }
  | { type: 'landmarks'; id: number };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'built'; id: number; result: PieceResult }
  | { type: 'landmarks'; id: number; meshes: LandmarkMeshes }
  | { type: 'error'; id: number; message: string };
