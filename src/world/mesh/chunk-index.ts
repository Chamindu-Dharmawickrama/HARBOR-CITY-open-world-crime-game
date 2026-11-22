import type { TerrainModel } from '../gen/islands';
import { chainCenterline, type Point3 } from '../gen/nav';
import type { PlanarGraph } from '../gen/planar-graph';
import { centroid, type Vec2 } from '../gen/geometry2d';
import type { CityLayout, Junction, RoadChain } from '../gen/types';

export type ChunkKey = string;

export function chunkKey(cx: number, cz: number): ChunkKey {
  return `${cx},${cz}`;
}

export function parseChunkKey(key: ChunkKey): [number, number] {
  const [a, b] = key.split(',');
  return [Number(a), Number(b)];
}

export interface ChainPiece {
  chain: number;
  /** Segment indices [from, to) into the chain centre line assigned to this chunk. */
  from: number;
  to: number;
}

export interface ChunkContents {
  key: ChunkKey;
  cx: number;
  cz: number;
  buildings: number[];
  chainPieces: ChainPiece[];
  junctions: number[];
  deadEnds: number[];
  blocks: number[];
  coast: { island: number; segment: number }[];
  piers: number[];
  props: number[];
  signs: number[];
  hasLand: boolean;
}

/** Chains that are built as global landmarks (bridges, tunnel) instead of per chunk. */
export function isLandmarkChain(chain: RoadChain): boolean {
  return chain.cls === 'bridge' || chain.cls === 'tunnel';
}

/**
 * Assigns every generated feature to the 128 m chunk that owns it (by centre / midpoint), and
 * precomputes trimmed road centre lines. Built identically on the main thread and in workers.
 */
export class ChunkIndex {
  readonly chunks = new Map<ChunkKey, ChunkContents>();
  readonly centerlines: Point3[][];
  readonly junctionByNode: Map<number, Junction>;

  constructor(
    readonly layout: CityLayout,
    readonly graph: PlanarGraph,
    readonly terrain: TerrainModel,
    readonly chunkSize: number,
  ) {
    this.junctionByNode = new Map(layout.junctions.map((j) => [j.node, j]));
    this.centerlines = layout.chains.map((chain) => chainCenterline(graph, chain, this.junctionByNode));
    const at = (x: number, z: number): ChunkContents =>
      this.ensure(Math.floor(x / chunkSize), Math.floor(z / chunkSize));

    layout.buildings.forEach((b, i) => at(b.center.x, b.center.z).buildings.push(i));
    layout.chains.forEach((chain, ci) => {
      if (isLandmarkChain(chain)) return;
      const line = this.centerlines[ci];
      let current: ChainPiece | null = null;
      let currentKey = '';
      for (let s = 0; s + 1 < line.length; s++) {
        const a = line[s];
        const b = line[s + 1];
        const chunk = at((a.x + b.x) / 2, (a.z + b.z) / 2);
        if (current && currentKey === chunk.key && current.to === s) {
          current.to = s + 1;
        } else {
          current = { chain: ci, from: s, to: s + 1 };
          currentKey = chunk.key;
          chunk.chainPieces.push(current);
        }
      }
    });
    layout.junctions.forEach((j, i) => {
      const n = layout.nodes[j.node] as Vec2;
      at(n.x, n.z).junctions.push(i);
    });
    layout.nodes.forEach((n, i) => {
      if (n.edges.length === 1) at(n.x, n.z).deadEnds.push(i);
    });
    layout.blocks.forEach((block, i) => {
      const c = centroid(block.curb);
      at(c.x, c.z).blocks.push(i);
    });
    layout.islands.forEach((island, ii) => {
      const coast = island.coast;
      for (let s = 0; s < coast.length; s++) {
        const a = coast[s];
        const b = coast[(s + 1) % coast.length];
        at((a.x + b.x) / 2, (a.z + b.z) / 2).coast.push({ island: ii, segment: s });
      }
    });
    layout.piers.forEach((pier, i) => {
      const c = centroid(pier.polygon);
      at(c.x, c.z).piers.push(i);
    });
    layout.props.forEach((p, i) => at(p.x, p.z).props.push(i));
    layout.signs.forEach((s, i) => at(s.x, s.z).signs.push(i));

    // Mark chunks containing any land (sampled on a 16 m grid) so empty sea chunks are skipped.
    for (const island of layout.islands) {
      const b = island.bounds;
      for (let cx = Math.floor(b.minX / chunkSize); cx <= Math.floor(b.maxX / chunkSize); cx++) {
        for (let cz = Math.floor(b.minZ / chunkSize); cz <= Math.floor(b.maxZ / chunkSize); cz++) {
          if (this.sampleLand(cx, cz)) this.ensure(cx, cz).hasLand = true;
        }
      }
    }
  }

  get(key: ChunkKey): ChunkContents | undefined {
    return this.chunks.get(key);
  }

  /** Keys of chunks with anything to show. */
  keys(): ChunkKey[] {
    return [...this.chunks.values()]
      .filter(
        (c) =>
          c.hasLand ||
          c.buildings.length > 0 ||
          c.chainPieces.length > 0 ||
          c.piers.length > 0 ||
          c.coast.length > 0,
      )
      .map((c) => c.key);
  }

  private sampleLand(cx: number, cz: number): boolean {
    const s = this.chunkSize;
    for (let x = 4; x < s; x += 16) {
      for (let z = 4; z < s; z += 16) {
        if (this.terrain.isLand(cx * s + x, cz * s + z)) return true;
      }
    }
    return false;
  }

  private ensure(cx: number, cz: number): ChunkContents {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = {
        key,
        cx,
        cz,
        buildings: [],
        chainPieces: [],
        junctions: [],
        deadEnds: [],
        blocks: [],
        coast: [],
        piers: [],
        props: [],
        signs: [],
        hasLand: false,
      };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }
}
