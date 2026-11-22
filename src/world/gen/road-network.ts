import type { Rng, RngStreams } from '../../core/rng';
import {
  add,
  convexPolygonsOverlap,
  distance,
  dot,
  insetPolygon,
  isSelfIntersecting,
  minAreaRect,
  normalize,
  orientedRect,
  perpendicular,
  pointInPolygon,
  resamplePolyline,
  rotate,
  scale,
  segmentIntersection,
  simplifyPolygon,
  sub,
  type Polygon,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import { Noise2D } from './noise';
import { PlanarGraph, type EdgeAttrs } from './planar-graph';
import type { CityDef, CrossingDef, DistrictDef, DistrictId, Hole, IslandShape, RoadClass } from './types';

/** Depth of the immersed tunnel floor below the water surface. */
export const TUNNEL_FLOOR_Y = -9;
/**
 * Trench opening beyond the tunnel carriageway: the retaining wall stands 1 m outside the kerb
 * and its parapet cap is 0.7 m wide, so the terrain cut-out ends just under the cap.
 */
export const TRENCH_WALL_OFFSET = 1;
export const TRENCH_CAP_WIDTH = 0.7;

export function roadAttrs(cls: RoadClass, district: DistrictId | null, lanesOverride?: number): EdgeAttrs {
  const downtown = district === 'meridian';
  switch (cls) {
    case 'arterial':
      return attrs(cls, district, 2, downtown ? 15 : 14, 16.7);
    case 'ring':
      return downtown ? attrs(cls, district, 2, 14, 16.7) : attrs(cls, district, 1, 9, 16.7);
    case 'street':
      return attrs(cls, district, 1, district === 'linden' ? 7.5 : 9, 11.1);
    case 'alley':
      return attrs(cls, district, 1, 5.5, 5.6);
    case 'bridge':
      return attrs(cls, null, lanesOverride ?? 2, (lanesOverride ?? 2) * 2 * 3.4 + 2, 22.2);
    case 'tunnel':
      return attrs(cls, null, lanesOverride ?? 1, (lanesOverride ?? 1) * 2 * 3.4 + 2, 19.4);
  }
}

function attrs(
  cls: RoadClass,
  district: DistrictId | null,
  lanes: number,
  width: number,
  speed: number,
): EdgeAttrs {
  return { cls, lanesPerDirection: lanes, width, speedLimit: speed, district, arch: 0, crossing: null };
}

export interface RoadNetwork {
  graph: PlanarGraph;
  rings: Map<DistrictId, Polygon>;
  holes: Hole[];
}

export function buildRoadNetwork(
  city: CityDef,
  islands: readonly IslandShape[],
  terrain: TerrainModel,
  rngs: RngStreams,
): RoadNetwork {
  const graph = new PlanarGraph(1.5);
  const rings = new Map<DistrictId, Polygon>();
  for (const def of city.districts) {
    const island = islands.find((i) => i.district === def.id);
    if (!island) throw new Error(`No island for ${def.id}`);
    const ring = ringPolygon(island.coast, def.roads.ringInset);
    rings.set(def.id, ring);
    for (let i = 0; i < ring.length; i++) {
      graph.addSegment(ring[i], ring[(i + 1) % ring.length], roadAttrs('ring', def.id));
    }
    addGrid(graph, def, ring, rngs.get(`roads:${def.id}`), rngs.rootSeed);
  }
  graph.pruneShortDeadEnds(14);
  for (const def of city.districts) cullStreets(graph, def, rngs.get(`cull:${def.id}`));
  graph.pruneShortDeadEnds(14);
  for (const def of city.districts) addAlleys(graph, def, terrain, rngs.get(`alleys:${def.id}`));
  graph.pruneShortDeadEnds(14);

  const holes: Hole[] = [];
  for (const crossing of city.crossings) {
    if (crossing.kind === 'bridge') addBridge(graph, crossing, rings);
    else holes.push(...addTunnel(graph, crossing, islands));
  }
  graph.pruneShortDeadEnds(14, (e) => graph.edges[e].attrs.crossing !== null);
  graph.subdivideLongEdges(40, (edge) => !edge.isolated && edge.attrs.cls !== 'bridge');
  for (const node of graph.nodes) {
    if (node.alive && Number.isNaN(node.y)) node.y = terrain.heightAt(node.x, node.z);
  }
  return { graph, rings, holes };
}

/** Waterfront ring road: the coastline resampled and inset, falling back to coarser/smoother outlines. */
export function ringPolygon(coast: Polygon, inset: number): Polygon {
  for (const spacing of [16, 24, 36, 50]) {
    let outline = simplifyPolygon(resamplePolyline([...coast, coast[0]], spacing).slice(0, -1));
    for (let smoothing = 0; smoothing < 3; smoothing++) {
      const ring = insetPolygon(outline, inset);
      if (ring && !isSelfIntersecting(ring)) return ring;
      outline = smooth(outline);
    }
  }
  throw new Error('ringPolygon: could not inset coastline');
}

function smooth(poly: Polygon): Polygon {
  const n = poly.length;
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n];
    const b = poly[(i + 1) % n];
    return { x: (a.x + 2 * p.x + b.x) / 4, z: (a.z + 2 * p.z + b.z) / 4 };
  });
}

function linePositions(min: number, max: number, range: readonly [number, number], rng: Rng): number[] {
  const out: number[] = [];
  let p = min + rng.range(range[0], range[1]) * 0.5;
  while (p < max - range[0] * 0.35) {
    out.push(p);
    p += rng.range(range[0], range[1]);
  }
  return out;
}

function addGrid(graph: PlanarGraph, def: DistrictDef, ring: Polygon, rng: Rng, seed: number): void {
  const { orientation, blockSizeU, blockSizeV, warp, warpScale, arterialEvery } = def.roads;
  const [cx, cz] = def.island.center;
  const toLocal = (p: Vec2): Vec2 => rotate({ x: p.x - cx, z: p.z - cz }, -orientation);
  const toWorld = (p: Vec2): Vec2 => add(rotate(p, orientation), { x: cx, z: cz });
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of ring) {
    const l = toLocal(p);
    minU = Math.min(minU, l.x);
    maxU = Math.max(maxU, l.x);
    minV = Math.min(minV, l.z);
    maxV = Math.max(maxV, l.z);
  }
  const noiseA = new Noise2D(`${seed}:warpA:${def.id}`);
  const noiseB = new Noise2D(`${seed}:warpB:${def.id}`);
  const arterialPhase = Math.floor(arterialEvery / 2);
  const step = warp > 0 ? 40 : Infinity;

  const emit = (fixed: number, from: number, to: number, alongU: boolean, index: number): void => {
    const cls: RoadClass = index % arterialEvery === arterialPhase ? 'arterial' : 'street';
    const pts: Vec2[] = [];
    const count = Number.isFinite(step) ? Math.max(1, Math.ceil((to - from) / step)) : 1;
    for (let k = 0; k <= count; k++) {
      const s = from + ((to - from) * k) / count;
      const offset =
        warp > 0 ? warp * (alongU ? noiseA : noiseB).fbm(s * warpScale, fixed * warpScale + 7.7, 2) : 0;
      pts.push(toWorld(alongU ? { x: s, z: fixed + offset } : { x: fixed + offset, z: s }));
    }
    for (const piece of clipPolylineToPolygon(pts, ring)) {
      for (let k = 0; k + 1 < piece.length; k++) {
        graph.addSegment(piece[k], piece[k + 1], roadAttrs(cls, def.id));
      }
    }
  };

  linePositions(minU, maxU, blockSizeU, rng).forEach((u, i) => emit(u, minV - 30, maxV + 30, false, i));
  linePositions(minV, maxV, blockSizeV, rng).forEach((v, i) => emit(v, minU - 30, maxU + 30, true, i));
}

/** Pieces of a polyline that lie inside a (possibly concave) polygon. */
export function clipPolylineToPolygon(points: readonly Vec2[], poly: Polygon): Vec2[][] {
  const pieces: Vec2[][] = [];
  let current: Vec2[] = [];
  const flush = (): void => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ts: number[] = [0, 1];
    for (let j = 0; j < poly.length; j++) {
      const hit = segmentIntersection(a, b, poly[j], poly[(j + 1) % poly.length]);
      if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9) ts.push(hit.t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
      if (pointInPolygon(mid, poly)) {
        const last = current[current.length - 1];
        if (!last || distance(last, p0) > 1e-6) {
          flush();
          current.push(p0);
        }
        current.push(p1);
      } else {
        flush();
      }
    }
  }
  flush();
  return pieces;
}

/** Edges of the run through degree-2 nodes containing edge e (stops at junctions/dead ends). */
export function edgeRun(graph: PlanarGraph, e: number): { edges: number[]; ends: [number, number] } {
  const edges = [e];
  const seen = new Set([e]);
  const ends: number[] = [];
  const startEdge = graph.edges[e];
  for (const startNode of [startEdge.a, startEdge.b]) {
    let node = startNode;
    let prev = e;
    for (;;) {
      if (graph.degree(node) !== 2) break;
      const next = (graph.nodes[node]?.edges ?? []).find((x) => x !== prev);
      if (next === undefined || seen.has(next)) break;
      const ne = graph.edges[next];
      if (ne.attrs.cls !== startEdge.attrs.cls) break;
      seen.add(next);
      edges.push(next);
      prev = next;
      node = graph.other(next, node);
    }
    ends.push(node);
  }
  return { edges, ends: [ends[0], ends[1]] };
}

function cullStreets(graph: PlanarGraph, def: DistrictDef, rng: Rng): void {
  if (def.roads.cullChance <= 0) return;
  const candidates = graph.aliveEdges().filter((e) => {
    const edge = graph.edges[e];
    return edge.attrs.cls === 'street' && edge.attrs.district === def.id;
  });
  const done = new Set<number>();
  for (const e of candidates) {
    if (done.has(e) || !graph.edges[e].alive) continue;
    const run = edgeRun(graph, e);
    for (const r of run.edges) done.add(r);
    if (!rng.chance(def.roads.cullChance)) continue;
    const [na, nb] = run.ends;
    if (graph.degree(na) < 4 || graph.degree(nb) < 4) continue;
    const length = run.edges.reduce((s, r) => s + graph.edgeLength(r), 0);
    if (length > 220) continue;
    for (const r of run.edges) graph.removeEdge(r);
  }
}

function addAlleys(graph: PlanarGraph, def: DistrictDef, terrain: TerrainModel, rng: Rng): void {
  if (def.roads.alleyChance <= 0) return;
  const faces = graph.faces((edge) => edge.attrs.district === def.id && edge.attrs.cls !== 'bridge');
  for (const face of faces) {
    if (face.area < 7000 || face.area > 40_000 || !rng.chance(def.roads.alleyChance)) continue;
    const poly = face.nodes.map((n) => graph.nodes[n] as Vec2);
    const box = minAreaRect(poly);
    if (box.halfLength < 55 || box.halfWidth < 28) continue;
    const across = perpendicular(box.axis);
    const shift = scale(box.axis, rng.range(-0.15, 0.15) * box.halfLength);
    const center = add(box.center, shift);
    if (terrain.districtAt(center.x, center.z) !== def.id) continue;
    const p = add(center, scale(across, -(box.halfWidth + 6)));
    const q = add(center, scale(across, box.halfWidth + 6));
    for (const piece of clipPolylineToPolygon([p, q], poly)) {
      graph.addSegment(piece[0], piece[piece.length - 1], roadAttrs('alley', def.id));
    }
  }
}

/** First intersection of segment a→b with polygon edges, ordered from `a`. */
function intersectionsAlong(a: Vec2, b: Vec2, poly: Polygon): { t: number; point: Vec2 }[] {
  const hits: { t: number; point: Vec2 }[] = [];
  for (let j = 0; j < poly.length; j++) {
    const hit = segmentIntersection(a, b, poly[j], poly[(j + 1) % poly.length]);
    if (hit) hits.push({ t: hit.t, point: hit.point });
  }
  return hits.sort((x, y) => x.t - y.t);
}

function addBridge(graph: PlanarGraph, crossing: CrossingDef, rings: Map<DistrictId, Polygon>): void {
  const a: Vec2 = { x: crossing.a[0], z: crossing.a[1] };
  const b: Vec2 = { x: crossing.b[0], z: crossing.b[1] };
  const ringA = rings.get(crossing.from);
  const ringB = rings.get(crossing.to);
  if (!ringA || !ringB) throw new Error(`Bridge ${crossing.id}: unknown district`);
  const exitA = intersectionsAlong(a, b, ringA).pop();
  const entryB = intersectionsAlong(a, b, ringB)[0];
  if (!exitA || !entryB) throw new Error(`Bridge ${crossing.id} does not cross both ring roads`);
  const attrs = { ...roadAttrs('bridge', null, crossing.lanesPerDirection), crossing: crossing.id };
  attrs.arch = crossing.style === 'suspension' ? 14 : 10;
  graph.addSegment(exitA.point, entryB.point, attrs);
}

function nearestJunction(graph: PlanarGraph, p: Vec2, maxDistance: number, district: DistrictId): number {
  let best = -1;
  let bestD = maxDistance;
  graph.nodes.forEach((node, id) => {
    if (!node.alive || node.edges.length < 3) return;
    const edgesHere = node.edges.map((e) => graph.edges[e]);
    if (
      edgesHere.some((e) => e.attrs.cls === 'ring') ||
      edgesHere.every((e) => e.attrs.district !== district)
    )
      return;
    const d = distance(node, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  });
  if (best < 0) throw new Error(`No junction near (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
  return best;
}

function segmentHitsPolygon(a: Vec2, b: Vec2, poly: Polygon): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let j = 0; j < poly.length; j++) {
    if (segmentIntersection(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
  }
  return false;
}

function addTunnel(graph: PlanarGraph, crossing: CrossingDef, islands: readonly IslandShape[]): Hole[] {
  const portalA = nearestJunction(graph, { x: crossing.a[0], z: crossing.a[1] }, 140, crossing.from);
  const portalB = nearestJunction(graph, { x: crossing.b[0], z: crossing.b[1] }, 140, crossing.to);
  const pa = graph.nodes[portalA] as Vec2;
  const pb = graph.nodes[portalB] as Vec2;
  const coastA = islands.find((i) => i.district === crossing.from)?.coast;
  const coastB = islands.find((i) => i.district === crossing.to)?.coast;
  if (!coastA || !coastB) throw new Error(`Tunnel ${crossing.id}: unknown district`);
  const exitA = intersectionsAlong(pa, pb, coastA).pop();
  const entryB = intersectionsAlong(pa, pb, coastB)[0];
  if (!exitA || !entryB) throw new Error(`Tunnel ${crossing.id} does not cross both coasts`);
  const dir = normalize(sub(pb, pa));

  const trench = (from: Vec2, to: Vec2): Polygon => {
    const end = add(to, scale(normalize(sub(to, from)), 10));
    const mid = scale(add(from, end), 0.5);
    const halfWidth =
      roadAttrs('tunnel', null, crossing.lanesPerDirection).width / 2 +
      TRENCH_WALL_OFFSET +
      TRENCH_CAP_WIDTH * 0.8;
    return orientedRect(mid, sub(end, from), distance(from, end) / 2, halfWidth);
  };
  const trenchA = trench(pa, exitA.point);
  const trenchB = trench(pb, entryB.point);

  for (const [portal, poly, outward] of [
    [portalA, trenchA, dir],
    [portalB, trenchB, scale(dir, -1)],
  ] as const) {
    for (const e of graph.aliveEdges()) {
      const edge = graph.edges[e];
      if (edge.isolated || edge.attrs.cls === 'ring') continue;
      const ea = graph.nodes[edge.a] as Vec2;
      const eb = graph.nodes[edge.b] as Vec2;
      if (edge.a === portal || edge.b === portal) {
        const away = edge.a === portal ? sub(eb, ea) : sub(ea, eb);
        if (dot(normalize(away), outward) < 0.6) continue;
      }
      const thin = orientedRect(scale(add(ea, eb), 0.5), sub(eb, ea), distance(ea, eb) / 2, 0.5);
      if (segmentHitsPolygon(ea, eb, poly) || convexPolygonsOverlap(thin, poly)) graph.removeEdge(e);
    }
  }

  const tunnel = { ...roadAttrs('tunnel', null, crossing.lanesPerDirection), crossing: crossing.id };
  const ca = graph.createNode(exitA.point.x, exitA.point.z, TUNNEL_FLOOR_Y);
  const cb = graph.createNode(entryB.point.x, entryB.point.z, TUNNEL_FLOOR_Y);
  graph.connect(portalA, ca, tunnel, true);
  graph.connect(ca, cb, tunnel, true);
  graph.connect(cb, portalB, tunnel, true);
  return [
    { polygon: trenchA, crossing: crossing.id },
    { polygon: trenchB, crossing: crossing.id },
  ];
}
