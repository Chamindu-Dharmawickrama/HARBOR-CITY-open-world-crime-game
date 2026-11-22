import type { Rng, RngStreams } from '../../core/rng';
import {
  quantizePolygon,
  hypot,
  add,
  area,
  bounds,
  boundsOverlap,
  centroid,
  convexHull,
  convexPolygonsOverlap,
  distance,
  insetPolygonRobust,
  minAreaRect,
  orientedRect,
  perpendicular,
  pointSegmentDistance,
  scale,
  simplifyPolygon,
  splitConvex,
  sub,
  type Polygon,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import type { PlanarGraph } from './planar-graph';
import type { Block, DistrictDef, Hole, LandUse, Lot } from './types';

const MIN_BLOCK_AREA = 350;
const MAX_BLOCK_AREA = 160_000;

export interface BlockBuildResult {
  blocks: Block[];
  lots: Lot[];
  /** Road corridors of dead-end spurs (not part of any face outline). */
  spurCorridors: Polygon[];
  failedBlocks: number;
}

export function buildBlocks(
  graph: PlanarGraph,
  terrain: TerrainModel,
  holes: readonly Hole[],
  rngs: RngStreams,
): BlockBuildResult {
  const faces = graph.faces((edge) => edge.attrs.cls !== 'bridge');
  const blocks: Block[] = [];
  const lots: Lot[] = [];
  let failedBlocks = 0;
  const faceEdges = new Set<number>();
  for (const face of faces) for (const e of face.edges) faceEdges.add(e);
  const spurCorridors = graph
    .aliveEdges()
    .filter((e) => {
      const edge = graph.edges[e];
      return !edge.isolated && edge.attrs.cls !== 'bridge' && !faceEdges.has(e);
    })
    .map((e) => edgeCorridor(graph, e, 3.5));
  // Every carriageway (plus a small margin): no lot may overlap a road, even where an inset
  // dropped a collapsed edge and the curb line passes over a short road stub.
  const carriageways = new PolygonIndex(
    graph
      .aliveEdges()
      .filter((e) => !graph.edges[e].isolated)
      .map((e) => edgeCorridor(graph, e, 0.5)),
  );
  const holeIndex = new PolygonIndex(holes.map((h) => h.polygon));
  const spurIndex = new PolygonIndex(spurCorridors);

  for (const face of faces) {
    if (face.area < MIN_BLOCK_AREA || face.area > MAX_BLOCK_AREA) continue;
    const outline = cleanFaceOutline(
      face.nodes.map((n) => {
        const node = graph.nodes[n] as Vec2;
        return { x: node.x, z: node.z };
      }),
      face.edges.map((e) => graph.edges[e].attrs.width / 2),
      [...face.edges],
    );
    const curbInset = outline ? insetPolygonRobust(outline.poly, outline.halfWidths) : null;
    if (!outline || !curbInset || area(curbInset.polygon) < MIN_BLOCK_AREA * 0.4) {
      failedBlocks++;
      continue;
    }
    const curb = quantizePolygon(curbInset.polygon);
    const c = centroid(curb);
    const districtId = terrain.districtAt(c.x, c.z);
    if (!districtId) {
      failedBlocks++;
      continue;
    }
    const def = terrain.district(districtId);
    const rng = rngs.get(`blocks:${districtId}`);
    const inner =
      insetPolygonRobust(
        outline.poly,
        outline.halfWidths.map((w) => w + def.sidewalkWidth),
      )?.polygon ?? null;
    if (inner) inner.splice(0, inner.length, ...quantizePolygon(inner));
    const use = chooseBlockUse(def, rng, inner === null ? 0 : area(inner));
    const block: Block = {
      id: blocks.length,
      district: districtId,
      curb,
      inner: inner ?? curb,
      curbEdges: curbInset.sourceEdges.map((i) => outline.edges[i] ?? -1),
      use: inner === null ? 'plaza' : use,
      y: terrain.heightAt(c.x, c.z),
    };
    blocks.push(block);
    if (block.use !== 'lots') continue;
    for (const lotPoly of subdivideLots(block.inner, def, rng)) {
      if (!hasFrontage(lotPoly, block.inner)) continue;
      if (holeIndex.overlaps(lotPoly) || spurIndex.overlaps(lotPoly) || carriageways.overlaps(lotPoly))
        continue;
      lots.push({
        id: lots.length,
        block: block.id,
        polygon: lotPoly,
        use: chooseLotUse(def, rng, centroid(lotPoly)),
      });
    }
  }
  return { blocks, lots, spurCorridors, failedBlocks };
}

export interface FaceOutline {
  poly: Polygon;
  halfWidths: number[];
  /** Road edge per outline edge; -1 for chamfers (no road runs along them). */
  edges: number[];
}

const MIN_OUTLINE_EDGE = 6;
const MIN_CORNER_ANGLE = (40 * Math.PI) / 180;
const CHAMFER_DISTANCE = 10;

/**
 * Prepares a face outline for insetting: collapses very short edges (junction slivers left by
 * warped streets) and chamfers acute corners (streets meeting the waterfront ring at shallow
 * angles). Both would otherwise flip when inset by half a road width.
 */
export function cleanFaceOutline(poly: Polygon, halfWidths: number[], edges: number[]): FaceOutline | null {
  const p = [...poly];
  const w = [...halfWidths];
  const ids = [...edges];
  let guard = 0;
  while (p.length > 3 && guard++ < 500) {
    let shortest = -1;
    let shortestLen = MIN_OUTLINE_EDGE;
    for (let i = 0; i < p.length; i++) {
      const len = distance(p[i], p[(i + 1) % p.length]);
      if (len < shortestLen) {
        shortestLen = len;
        shortest = i;
      }
    }
    if (shortest < 0) break;
    const j = (shortest + 1) % p.length;
    const mid = scale(add(p[shortest], p[j]), 0.5);
    p[shortest] = mid;
    p.splice(j, 1);
    w.splice(shortest, 1);
    ids.splice(shortest, 1);
    if (j === 0) {
      // The wrap-around edge collapsed into the last vertex: make it the first vertex again so
      // edge k (still old edge k) keeps running from vertex k to k + 1.
      p.unshift(p.pop() as Vec2);
    }
  }
  if (p.length < 3) return null;

  const outPoly: Polygon = [];
  const outW: number[] = [];
  const outIds: number[] = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const prev = p[(i - 1 + n) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const toPrev = sub(prev, cur);
    const toNext = sub(next, cur);
    const lp = hypot(toPrev.x, toPrev.z);
    const ln = hypot(toNext.x, toNext.z);
    const cos = (toPrev.x * toNext.x + toPrev.z * toNext.z) / Math.max(1e-9, lp * ln);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const convex = toNext.x * toPrev.z - toNext.z * toPrev.x > 0;
    const prevIndex = (i - 1 + n) % n;
    if (convex && angle < MIN_CORNER_ANGLE) {
      const cut = Math.min(CHAMFER_DISTANCE, lp * 0.4, ln * 0.4);
      outPoly.push(add(cur, scale(toPrev, cut / lp)));
      outW.push(w[prevIndex]);
      outIds.push(ids[prevIndex]);
      outPoly.push(add(cur, scale(toNext, cut / ln)));
      outW.push(Math.max(w[prevIndex], w[i]));
      outIds.push(-1);
    } else {
      outPoly.push(cur);
      outW.push(w[prevIndex]);
      outIds.push(ids[prevIndex]);
    }
  }
  // outW/outIds were collected per incoming edge; rotate so entry k describes edge k → k+1.
  outW.push(outW.shift() as number);
  outIds.push(outIds.shift() as number);
  return { poly: outPoly, halfWidths: outW, edges: outIds };
}

/** Oriented rectangle covering an edge plus `margin` either side of its carriageway. */
export function edgeCorridor(graph: PlanarGraph, e: number, margin: number): Polygon {
  const edge = graph.edges[e];
  const a = graph.nodes[edge.a] as Vec2;
  const b = graph.nodes[edge.b] as Vec2;
  const mid = scale(add(a, b), 0.5);
  return orientedRect(mid, sub(b, a), distance(a, b) / 2 + margin, edge.attrs.width / 2 + margin);
}

function chooseBlockUse(def: DistrictDef, rng: Rng, innerArea: number): Block['use'] {
  const park = def.landUse.park ?? 0;
  const plaza = def.landUse.plaza ?? 0;
  const roll = rng.next();
  if (innerArea > 1500 && roll < park) return 'park';
  if (innerArea > 600 && roll < park + plaza) return 'plaza';
  return 'lots';
}

const LOT_USES: readonly LandUse[] = ['tower', 'midrise', 'shop', 'warehouse', 'house', 'parking', 'yard'];

function chooseLotUse(def: DistrictDef, rng: Rng, p: Vec2): LandUse {
  const [cx, cz] = def.island.center;
  const towerRadius = def.buildings.towerRadius;
  const nearCore = towerRadius > 0 ? Math.max(0, 1 - hypot(p.x - cx, p.z - cz) / towerRadius) : 0;
  const weights = LOT_USES.map((use) => {
    const w = def.landUse[use] ?? 0;
    if (use === 'tower') return w * nearCore * 2;
    if (use === 'midrise') return w + (def.landUse.tower ?? 0) * (1 - nearCore);
    return w;
  });
  return rng.pickWeighted(LOT_USES, weights);
}

/** Recursive oriented splits until lots fall inside the district's lot-area range. */
export function subdivideLots(poly: Polygon, def: DistrictDef, rng: Rng, depth = 0): Polygon[] {
  const a = area(poly);
  const [minArea, maxArea] = def.buildings.lotArea;
  const target = rng.range(minArea, maxArea);
  if (a <= target * 1.35 || depth > 10) return a >= minArea * 0.35 ? [poly] : [];
  const box = minAreaRect(poly);
  const offset = rng.range(-0.18, 0.18) * box.halfLength;
  const point = add(box.center, scale(box.axis, offset));
  const pieces = splitConvex(poly, point, perpendicular(box.axis));
  const out: Polygon[] = [];
  for (const piece of pieces) {
    const clean = simplifyPolygon(piece, 1e-4);
    if (clean.length >= 3 && area(clean) > 20) out.push(...subdivideLots(clean, def, rng, depth + 1));
  }
  return out;
}

/** A lot has frontage when one of its edges (≥ 4 m) runs along the block's property line. */
export function hasFrontage(lot: Polygon, blockInner: Polygon): boolean {
  for (let i = 0; i < lot.length; i++) {
    const a = lot[i];
    const b = lot[(i + 1) % lot.length];
    if (distance(a, b) < 4) continue;
    const mid = scale(add(a, b), 0.5);
    for (let j = 0; j < blockInner.length; j++) {
      const p = blockInner[j];
      const q = blockInner[(j + 1) % blockInner.length];
      if (pointSegmentDistance(mid, p, q).distance < 0.6) return true;
    }
  }
  return false;
}

const INDEX_CELL = 64;

/** Grid index of convex polygons for fast "does this polygon overlap any of them" queries. */
export class PolygonIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly boxes: ReturnType<typeof bounds>[];

  constructor(private readonly polygons: readonly Polygon[]) {
    this.boxes = polygons.map((p) => bounds(p));
    this.boxes.forEach((b, i) => {
      for (let cx = Math.floor(b.minX / INDEX_CELL); cx <= Math.floor(b.maxX / INDEX_CELL); cx++) {
        for (let cz = Math.floor(b.minZ / INDEX_CELL); cz <= Math.floor(b.maxZ / INDEX_CELL); cz++) {
          const key = `${cx},${cz}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  /** True if the convex hull of `poly` overlaps any indexed (convex) polygon. */
  overlaps(poly: Polygon): boolean {
    const hull = convexHull(poly);
    const b = bounds(hull);
    const checked = new Set<number>();
    for (let cx = Math.floor(b.minX / INDEX_CELL); cx <= Math.floor(b.maxX / INDEX_CELL); cx++) {
      for (let cz = Math.floor(b.minZ / INDEX_CELL); cz <= Math.floor(b.maxZ / INDEX_CELL); cz++) {
        for (const i of this.cells.get(`${cx},${cz}`) ?? []) {
          if (checked.has(i)) continue;
          checked.add(i);
          if (boundsOverlap(b, this.boxes[i]) && convexPolygonsOverlap(hull, this.polygons[i], 0.05)) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
