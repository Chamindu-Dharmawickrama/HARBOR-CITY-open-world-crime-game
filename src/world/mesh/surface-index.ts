import { bounds, pointInPolygon, pointSegmentDistance, type Bounds2, type Vec2 } from '../gen/geometry2d';
import type { GraphEdge, PlanarGraph } from '../gen/planar-graph';
import {
  GroundSurface,
  type CityLayout,
  type DistrictId,
  type GroundSurfaceName,
  type LandUse,
} from '../gen/types';

const CELL = 32;

interface Indexed {
  id: number;
  b: Bounds2;
}

class Grid {
  private readonly cells = new Map<number, Indexed[]>();
  add(id: number, b: Bounds2): void {
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
      for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
        const key = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push({ id, b });
      }
    }
  }
  at(x: number, z: number): readonly Indexed[] {
    return this.cells.get((Math.floor(x / CELL) + 0x8000) * 0x10000 + (Math.floor(z / CELL) + 0x8000)) ?? [];
  }
}

const LOT_SURFACE: Partial<Record<LandUse, GroundSurfaceName>> = {
  parking: 'lot',
  yard: 'gravel',
  house: 'grass',
  park: 'grass',
  plaza: 'plaza',
};

const VERGE_SURFACE: Record<DistrictId, GroundSurfaceName> = {
  meridian: 'plaza',
  gantry: 'concrete',
  linden: 'grass',
};

export interface GroundSample {
  /** Height offset relative to the natural terrain height. */
  offset: number;
  surface: number;
}

/** Height offsets applied to terrain vertices so roads/sidewalks never z-fight with it. */
export const ROAD_SINK = 0.25;
export const BLOCK_RAISE = 0.13;

/**
 * Answers "what is on the ground here?" for terrain vertices: road corridor (sunk under the
 * road mesh), sidewalk ring (covered by the sidewalk mesh), block interior (raised to just
 * under sidewalk level, with the lot's surface), or open verge.
 */
export class SurfaceIndex {
  private readonly roads = new Grid();
  private readonly junctions = new Grid();
  private readonly blocks = new Grid();
  private readonly lots = new Grid();
  private readonly segments: { a: Vec2; b: Vec2; half: number }[] = [];

  constructor(
    private readonly layout: CityLayout,
    graph: PlanarGraph,
  ) {
    graph.edges.forEach((edge: GraphEdge) => {
      if (edge.isolated || edge.attrs.cls === 'bridge') return;
      const a = graph.nodes[edge.a] as Vec2;
      const b = graph.nodes[edge.b] as Vec2;
      const half = edge.attrs.width / 2 + 0.6;
      const id = this.segments.length;
      this.segments.push({ a, b, half });
      this.roads.add(id, {
        minX: Math.min(a.x, b.x) - half,
        minZ: Math.min(a.z, b.z) - half,
        maxX: Math.max(a.x, b.x) + half,
        maxZ: Math.max(a.z, b.z) + half,
      });
    });
    layout.junctions.forEach((j, i) => this.junctions.add(i, bounds(j.polygon)));
    layout.blocks.forEach((block, i) => this.blocks.add(i, bounds(block.curb)));
    layout.lots.forEach((lot, i) => this.lots.add(i, bounds(lot.polygon)));
  }

  inRoad(x: number, z: number): boolean {
    const p = { x, z };
    for (const item of this.roads.at(x, z)) {
      const s = this.segments[item.id];
      if (pointSegmentDistance(p, s.a, s.b).distance <= s.half) return true;
    }
    for (const item of this.junctions.at(x, z)) {
      if (pointInPolygon(p, (this.layout.junctions[item.id] as { polygon: Vec2[] }).polygon)) return true;
    }
    return false;
  }

  sample(x: number, z: number, district: DistrictId): GroundSample {
    const p = { x, z };
    for (const item of this.blocks.at(x, z)) {
      const { b } = item;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const block = this.layout.blocks[item.id];
      if (!block || !pointInPolygon(p, block.curb)) continue;
      if (!pointInPolygon(p, block.inner)) return { offset: 0, surface: GroundSurface.sidewalk };
      if (block.use === 'park') return { offset: BLOCK_RAISE, surface: GroundSurface.grass };
      if (block.use === 'plaza') return { offset: BLOCK_RAISE, surface: GroundSurface.plaza };
      return { offset: BLOCK_RAISE, surface: GroundSurface[this.lotSurface(p, district)] };
    }
    // Terrain under a road is sunk out of sight but keeps the verge surface: the road ribbons
    // alone define road edges, so they stay crisp regardless of terrain resolution.
    const verge = GroundSurface[VERGE_SURFACE[district]];
    if (this.inRoad(x, z)) return { offset: -ROAD_SINK, surface: verge };
    return { offset: 0, surface: verge };
  }

  private lotSurface(p: Vec2, district: DistrictId): GroundSurfaceName {
    for (const item of this.lots.at(p.x, p.z)) {
      const lot = this.layout.lots[item.id];
      if (!lot || !pointInPolygon(p, lot.polygon)) continue;
      const surface = LOT_SURFACE[lot.use];
      if (surface) return surface;
      break;
    }
    return district === 'linden' ? 'grass' : district === 'gantry' ? 'gravel' : 'plaza';
  }
}
