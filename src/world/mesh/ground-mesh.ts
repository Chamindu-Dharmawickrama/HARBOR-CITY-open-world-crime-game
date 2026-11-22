import {
  add,
  clipPolygonConvex,
  distance,
  normalize,
  perpendicular,
  rectPolygon,
  resamplePolyline,
  scale,
  sub,
  subtractConvex,
  triangulate,
  type Polygon,
  type Vec2,
} from '../gen/geometry2d';
import type { TerrainModel } from '../gen/islands';
import { offsetPolyline3, type Point3 } from '../gen/nav';
import { SIDEWALK_HEIGHT } from '../gen/props';
import { GroundSurface, type CityLayout, type RoadClass } from '../gen/types';
import type { ChunkContents, ChunkIndex } from './chunk-index';
import { MeshBuilder, type MeshData } from './mesh-builder';
import { ROAD_SINK, type SurfaceIndex } from './surface-index';

export const ROAD_CLASS_CODE: Record<RoadClass, number> = {
  arterial: 0,
  street: 1,
  alley: 2,
  ring: 3,
  bridge: 4,
  tunnel: 5,
};

/** Extra width of road ribbons beyond the kerb line (hidden under the raised sidewalk). */
const ROAD_OVERLAP = 0.5;
const SEAWALL_BOTTOM = -3;
const COAST_CELL = 16;

export interface GroundContext {
  layout: CityLayout;
  terrain: TerrainModel;
  index: ChunkIndex;
  surfaces: SurfaceIndex;
  coastGrid: Map<number, number[]>[];
}

/** Per-island grids of coastline segments, used to find terrain cells that need clipping. */
export function buildCoastGrids(layout: CityLayout): Map<number, number[]>[] {
  return layout.islands.map((island) => {
    const grid = new Map<number, number[]>();
    const coast = island.coast;
    for (let s = 0; s < coast.length; s++) {
      const a = coast[s];
      const b = coast[(s + 1) % coast.length];
      for (
        let cx = Math.floor(Math.min(a.x, b.x) / COAST_CELL);
        cx <= Math.floor(Math.max(a.x, b.x) / COAST_CELL);
        cx++
      ) {
        for (
          let cz = Math.floor(Math.min(a.z, b.z) / COAST_CELL);
          cz <= Math.floor(Math.max(a.z, b.z) / COAST_CELL);
          cz++
        ) {
          const key = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
          const list = grid.get(key);
          if (list) list.push(s);
          else grid.set(key, [s]);
        }
      }
    }
    return grid;
  });
}

function coastNear(grid: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number): boolean {
  for (let cx = Math.floor(x0 / COAST_CELL); cx <= Math.floor(x1 / COAST_CELL); cx++) {
    for (let cz = Math.floor(z0 / COAST_CELL); cz <= Math.floor(z1 / COAST_CELL); cz++) {
      if (grid.has((cx + 0x8000) * 0x10000 + (cz + 0x8000))) return true;
    }
  }
  return false;
}

/** Ground geometry of one chunk. `detail` adds sidewalks and kerbs and uses a 4 m terrain grid. */
export function buildGroundMesh(ctx: GroundContext, chunk: ChunkContents, detail: boolean): MeshData {
  const m = new MeshBuilder();
  const size = ctx.index.chunkSize;
  buildTerrain(ctx, m, chunk.cx * size, chunk.cz * size, size, detail ? 4 : 16, detail);
  buildRoads(ctx, m, chunk);
  if (detail) {
    buildSidewalks(ctx, m, chunk);
    buildVergeSidewalks(ctx, m, chunk);
  }
  buildSeawalls(ctx, m, chunk);
  buildPiers(ctx, m, chunk, detail);
  return m.build();
}

function terrainVertex(
  ctx: GroundContext,
  m: MeshBuilder,
  x: number,
  z: number,
  detail: boolean,
  district: Parameters<SurfaceIndex['sample']>[2],
): number {
  const t = ctx.terrain;
  const h = t.landHeightFor(district, x, z);
  const hx = t.landHeightFor(district, x + 1, z) - t.landHeightFor(district, x - 1, z);
  const hz = t.landHeightFor(district, x, z + 1) - t.landHeightFor(district, x, z - 1);
  const len = Math.hypot(hx, 2, hz);
  m.normal(-hx / len, 2 / len, -hz / len);
  let y = h;
  let surface: number;
  if (detail) {
    const s = ctx.surfaces.sample(x, z, district);
    y += s.offset;
    surface = s.surface;
  } else {
    // Coarse terrain sits slightly lower everywhere so the road ribbons always cover it.
    y -= 0.3;
    surface = ctx.surfaces.sample(x, z, district).surface;
  }
  m.setData(surface, 0, 0, 0);
  return m.vertex(x, y, z, x, z);
}

function buildTerrain(
  ctx: GroundContext,
  m: MeshBuilder,
  ox: number,
  oz: number,
  size: number,
  cell: number,
  detail: boolean,
): void {
  m.color(0xffffff);
  const { layout, terrain } = ctx;
  layout.islands.forEach((island, ii) => {
    const b = island.bounds;
    if (b.maxX < ox || b.minX > ox + size || b.maxZ < oz || b.minZ > oz + size) return;
    const grid = ctx.coastGrid[ii];
    const district = island.district;
    const shared = new Map<number, number>();
    const corner = (gx: number, gz: number): number => {
      const key = gx * 4096 + gz;
      let v = shared.get(key);
      if (v === undefined) {
        v = terrainVertex(ctx, m, ox + gx * cell, oz + gz * cell, detail, district);
        shared.set(key, v);
      }
      return v;
    };
    const steps = Math.round(size / cell);
    for (let gx = 0; gx < steps; gx++) {
      for (let gz = 0; gz < steps; gz++) {
        const x0 = ox + gx * cell;
        const z0 = oz + gz * cell;
        const x1 = x0 + cell;
        const z1 = z0 + cell;
        const nearCoast = coastNear(grid, x0, z0, x1, z1);
        const holes = layout.holes.filter((h) => overlapsRect(h.polygon, x0, z0, x1, z1));
        if (!nearCoast && holes.length === 0) {
          if (
            !terrain.isLand((x0 + x1) / 2, (z0 + z1) / 2) ||
            terrain.districtAt((x0 + x1) / 2, (z0 + z1) / 2) !== district
          )
            continue;
          const a = corner(gx, gz);
          const b2 = corner(gx + 1, gz);
          const c = corner(gx + 1, gz + 1);
          const d = corner(gx, gz + 1);
          // (x0,z0)→(x1,z0)→(x1,z1)→(x0,z1) is CCW in x/z, so emit it as upward triangles.
          m.upTriangle(a, b2, c);
          m.upTriangle(a, c, d);
          continue;
        }
        let pieces: Polygon[] = nearCoast
          ? [clipPolygonConvex(island.coast, rectPolygon(x0, z0, x1, z1))]
          : [rectPolygon(x0, z0, x1, z1)];
        for (const hole of holes)
          pieces = pieces.flatMap((p) => (p.length >= 3 ? subtractConvex(p, hole.polygon) : []));
        for (const piece of pieces) {
          if (piece.length < 3) continue;
          const tris = triangulate(piece);
          const ids = piece.map((p) => terrainVertex(ctx, m, p.x, p.z, detail, district));
          for (let t = 0; t < tris.length; t += 3) {
            m.upTriangle(ids[tris[t]], ids[tris[t + 1]], ids[tris[t + 2]]);
          }
        }
      }
    }
  });
}

function overlapsRect(poly: Polygon, x0: number, z0: number, x1: number, z1: number): boolean {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return minX < x1 && maxX > x0 && minZ < z1 && maxZ > z0;
}

/**
 * Road ribbon flags decoded by the ground shader: bit0 crosswalk at start, bit1 crosswalk at
 * end, + 4 × class code, + 32 × half width in quarter metres.
 */
export function roadFlags(
  startJunction: boolean,
  endJunction: boolean,
  cls: RoadClass,
  halfWidth: number,
): number {
  return (
    (startJunction ? 1 : 0) +
    (endJunction ? 2 : 0) +
    ROAD_CLASS_CODE[cls] * 4 +
    32 * Math.round(halfWidth * 4)
  );
}

export function emitRoadRibbon(
  m: MeshBuilder,
  line: readonly Point3[],
  from: number,
  to: number,
  halfWidth: number,
  lanesPerDirection: number,
  flags: number,
  yOffset = 0,
): void {
  const left = offsetPolyline3(line, -halfWidth);
  const right = offsetPolyline3(line, halfWidth);
  const dist: number[] = [0];
  for (let i = 1; i < line.length; i++) dist.push(dist[i - 1] + distance(line[i - 1], line[i]));
  const total = dist[dist.length - 1];
  m.color(0xffffff).normal(0, 1, 0).setData(GroundSurface.asphalt, lanesPerDirection, flags, total);
  for (let s = from; s < to; s++) {
    const l0 = left[s];
    const r0 = right[s];
    const l1 = left[s + 1];
    const r1 = right[s + 1];
    const a = m.vertex(l0.x, l0.y + yOffset, l0.z, -halfWidth, dist[s]);
    const b = m.vertex(r0.x, r0.y + yOffset, r0.z, halfWidth, dist[s]);
    const c = m.vertex(r1.x, r1.y + yOffset, r1.z, halfWidth, dist[s + 1]);
    const d = m.vertex(l1.x, l1.y + yOffset, l1.z, -halfWidth, dist[s + 1]);
    m.quadUp(a, b, c, d);
  }
}

function buildRoads(ctx: GroundContext, m: MeshBuilder, chunk: ChunkContents): void {
  const { layout, index } = ctx;
  for (const piece of chunk.chainPieces) {
    const chain = layout.chains[piece.chain];
    const line = index.centerlines[piece.chain];
    if (!chain || !line || line.length < 2) continue;
    const startJ = index.junctionByNode.has(chain.nodes[0]);
    const endJ = index.junctionByNode.has(chain.nodes[chain.nodes.length - 1]);
    const hw = chain.width / 2 + ROAD_OVERLAP;
    emitRoadRibbon(
      m,
      line,
      piece.from,
      piece.to,
      hw,
      chain.lanesPerDirection,
      roadFlags(startJ, endJ, chain.cls, hw),
    );
  }
  m.color(0xffffff).normal(0, 1, 0).setData(GroundSurface.asphalt, 0, 0, 0);
  for (const ji of chunk.junctions) {
    const junction = layout.junctions[ji];
    if (!junction) continue;
    const y = (layout.nodes[junction.node] as { y: number }).y;
    fan(m, junction.polygon, y);
  }
  for (const ni of chunk.deadEnds) {
    const node = layout.nodes[ni];
    const edge = node ? layout.edges[node.edges[0]] : undefined;
    if (!node || !edge || edge.cls === 'tunnel' || edge.cls === 'bridge') continue;
    const radius = edge.width * 0.8;
    const circle: Polygon = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      circle.push({ x: node.x + Math.cos(a) * radius, z: node.z + Math.sin(a) * radius });
    }
    fan(m, circle, node.y);
  }
}

/** Upward fan triangulation of a convex CCW polygon at a fixed height. */
function fan(m: MeshBuilder, poly: Polygon, y: number): void {
  if (poly.length < 3) return;
  const ids = poly.map((p) => m.vertex(p.x, y, p.z, p.x, p.z));
  for (let k = 1; k + 1 < ids.length; k++) m.upTriangle(ids[0], ids[k], ids[k + 1]);
}

function buildSidewalks(ctx: GroundContext, m: MeshBuilder, chunk: ChunkContents): void {
  const { layout, terrain, surfaces } = ctx;
  for (const bi of chunk.blocks) {
    const block = layout.blocks[bi];
    if (!block) continue;
    const width = terrain.district(block.district).sidewalkWidth;
    const ring = resamplePolyline([...block.curb, block.curb[0]], 6).slice(0, -1);
    const n = ring.length;
    if (n < 3) continue;
    const inner: Vec2[] = ring.map((p, i) => {
      const prev = ring[(i - 1 + n) % n];
      const next = ring[(i + 1) % n];
      const n1 = perpendicular(normalize(sub(p, prev)));
      const n2 = perpendicular(normalize(sub(next, p)));
      const mid = normalize(add(n1, n2));
      const cos = Math.max(0.5, mid.x * n1.x + mid.z * n1.z);
      return add(p, scale(mid, width / cos));
    });
    const h = ring.map((p) => terrain.heightAt(p.x, p.z));
    const hi = inner.map((p) => terrain.heightAt(p.x, p.z));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const c0 = ring[i];
      const c1 = ring[j];
      // Skip sidewalk where a road crosses it (dead-end spurs entering the block).
      const probe = add(scale(add(c0, c1), 0.5), scale(perpendicular(normalize(sub(c1, c0))), width / 2));
      if (surfaces.inRoad(probe.x, probe.z)) continue;
      const i0 = inner[i];
      const i1 = inner[j];
      m.color(0xffffff).normal(0, 1, 0).setData(GroundSurface.sidewalk, 0, 0, 0);
      const a = m.vertex(c0.x, h[i] + SIDEWALK_HEIGHT, c0.z, c0.x, c0.z);
      const b = m.vertex(c1.x, h[j] + SIDEWALK_HEIGHT, c1.z, c1.x, c1.z);
      const c = m.vertex(i1.x, hi[j] + SIDEWALK_HEIGHT, i1.z, i1.x, i1.z);
      const d = m.vertex(i0.x, hi[i] + SIDEWALK_HEIGHT, i0.z, i0.x, i0.z);
      m.quadUp(a, d, c, b);
      // Kerb face toward the road (the curb ring is CCW, so wall() faces outward).
      m.setData(GroundSurface.concrete, 0, 0, 0);
      m.wall(
        c0.x,
        c0.z,
        c1.x,
        c1.z,
        h[i] - ROAD_SINK,
        h[i] + SIDEWALK_HEIGHT,
        h[j] - ROAD_SINK,
        h[j] + SIDEWALK_HEIGHT,
        0,
      );
    }
  }
}

function buildSeawalls(ctx: GroundContext, m: MeshBuilder, chunk: ChunkContents): void {
  const { layout, terrain } = ctx;
  m.color(0xffffff).setData(GroundSurface.seawall, 0, 0, 0);
  for (const { island, segment } of chunk.coast) {
    const shape = layout.islands[island];
    if (!shape) continue;
    const coast = shape.coast;
    const a = coast[segment];
    const b = coast[(segment + 1) % coast.length];
    const ha = terrain.landHeightFor(shape.district, a.x, a.z);
    const hb = terrain.landHeightFor(shape.district, b.x, b.z);
    if (
      layout.holes.some((hole) =>
        overlapsRect(
          hole.polygon,
          Math.min(a.x, b.x),
          Math.min(a.z, b.z),
          Math.max(a.x, b.x),
          Math.max(a.z, b.z),
        ),
      )
    )
      continue;
    m.wall(a.x, a.z, b.x, b.z, SEAWALL_BOTTOM, ha, SEAWALL_BOTTOM, hb, 0);
  }
}

function buildPiers(ctx: GroundContext, m: MeshBuilder, chunk: ChunkContents, detail: boolean): void {
  m.color(0xffffff);
  for (const pi of chunk.piers) {
    const pier = ctx.layout.piers[pi];
    if (!pier) continue;
    const top = pier.y + SIDEWALK_HEIGHT;
    m.normal(0, 1, 0).setData(GroundSurface.concrete, 0, 0, 0);
    fan(m, pier.polygon, top);
    m.setData(GroundSurface.concrete, 0, 0, 0);
    const poly = pier.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      m.wall(a.x, a.z, b.x, b.z, top - 1.2, top, top - 1.2, top, 0);
    }
    if (!detail) continue;
    // Pillars every ~10 m along both long sides.
    const long = distance(poly[0], poly[1]) > distance(poly[1], poly[2]) ? 0 : 1;
    for (const side of [long, long + 2]) {
      const a = poly[side % 4];
      const b = poly[(side + 1) % 4];
      const len = distance(a, b);
      const dir = normalize(sub(b, a));
      const inward = perpendicular(dir);
      for (let t = 4; t < len - 2; t += 10) {
        const c = add(add(a, scale(dir, t)), scale(inward, 1));
        box(m, c.x, c.z, 0.45, -4, top - 1.2);
      }
    }
  }
}

/** Axis-aligned square column (half size `r`) between y0 and y1. */
export function box(m: MeshBuilder, x: number, z: number, r: number, y0: number, y1: number): void {
  const corners: Vec2[] = [
    { x: x - r, z: z - r },
    { x: x + r, z: z - r },
    { x: x + r, z: z + r },
    { x: x - r, z: z + r },
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    m.wall(a.x, a.z, b.x, b.z, y0, y1, y0, y1, 0);
  }
}

const VERGE_WIDTH = 3.5;

/**
 * Sidewalk + kerb along road sides that no block borders (waterfront promenade, spurs, tunnel
 * and bridge approaches), so every road edge ends in a kerb instead of bare terrain.
 */
function buildVergeSidewalks(ctx: GroundContext, m: MeshBuilder, chunk: ChunkContents): void {
  const { layout, index, surfaces, terrain } = ctx;
  for (const piece of chunk.chainPieces) {
    const chain = layout.chains[piece.chain];
    const line = index.centerlines[piece.chain];
    if (!chain || !line || line.length < 2) continue;
    const hw = chain.width / 2;
    for (const side of [-1, 1]) {
      const inner = offsetPolyline3(line, side * hw);
      const outer = offsetPolyline3(line, side * (hw + VERGE_WIDTH));
      for (let s = piece.from; s < piece.to; s++) {
        const i0 = inner[s];
        const i1 = inner[s + 1];
        const o0 = outer[s];
        const o1 = outer[s + 1];
        const probeX = (o0.x + o1.x + i0.x + i1.x) / 4;
        const probeZ = (o0.z + o1.z + i0.z + i1.z) / 4;
        if (!terrain.isLand(probeX, probeZ)) continue;
        const district = terrain.districtAt(probeX, probeZ);
        if (!district) continue;
        if (surfaces.inRoad(probeX, probeZ)) continue;
        const under = surfaces.sample(probeX, probeZ, district);
        if (under.offset !== 0 || under.surface === GroundSurface.sidewalk) continue;
        const top = SIDEWALK_HEIGHT;
        m.color(0xffffff).normal(0, 1, 0).setData(GroundSurface.sidewalk, 0, 0, 0);
        const a = m.vertex(i0.x, i0.y + top, i0.z, i0.x, i0.z);
        const b = m.vertex(i1.x, i1.y + top, i1.z, i1.x, i1.z);
        const c = m.vertex(o1.x, o1.y + top, o1.z, o1.x, o1.z);
        const d = m.vertex(o0.x, o0.y + top, o0.z, o0.x, o0.z);
        // Ribbon convention (emitRoadRibbon): quad(left0, right0, right1, left1) faces up. On the
        // right side the inner edge is 'left'; on the left side the outer edge is.
        if (side > 0) m.quadUp(a, d, c, b);
        else m.quadUp(a, b, c, d);
        m.setData(GroundSurface.concrete, 0, 0, 0);
        // Kerb face toward the road.
        if (side > 0)
          m.wall(i1.x, i1.z, i0.x, i0.z, i1.y - ROAD_SINK, i1.y + top, i0.y - ROAD_SINK, i0.y + top, 0);
        else m.wall(i0.x, i0.z, i1.x, i1.z, i0.y - ROAD_SINK, i0.y + top, i1.y - ROAD_SINK, i1.y + top, 0);
      }
    }
  }
}
