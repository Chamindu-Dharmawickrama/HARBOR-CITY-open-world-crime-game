import {
  hypot,
  distance,
  pointSegmentDistance,
  segmentIntersection,
  signedArea,
  type Vec2,
} from './geometry2d';
import type { DistrictId, RoadClass } from './types';

export interface EdgeAttrs {
  cls: RoadClass;
  lanesPerDirection: number;
  width: number;
  speedLimit: number;
  district: DistrictId | null;
  arch: number;
  crossing: string | null;
}

export interface GraphNode {
  x: number;
  z: number;
  edges: number[];
  alive: boolean;
  /** Fixed height (tunnel/bridge nodes); NaN means "sample the terrain". */
  y: number;
}

export interface GraphEdge {
  a: number;
  b: number;
  attrs: EdgeAttrs;
  alive: boolean;
  /** Excluded from intersection splitting and face extraction (tunnels). */
  isolated: boolean;
}

export interface Face {
  nodes: number[];
  /** edges[i] joins nodes[i] and nodes[(i + 1) % n]. */
  edges: number[];
  area: number;
}

const CELL = 24;

function cellKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}

/**
 * Incrementally built planar road graph. Segments are inserted with automatic splitting at
 * crossings and snapping of near-coincident points, so the result is a proper planar
 * embedding suitable for face (block) extraction.
 */
export class PlanarGraph {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  private readonly nodeGrid = new Map<number, number[]>();
  private readonly edgeGrid = new Map<number, number[]>();

  constructor(readonly snapTolerance = 1.5) {}

  /** Returns an existing node within tolerance, or creates one. */
  node(x: number, z: number, fixedY = Number.NaN): number {
    const existing = this.findNode(x, z, this.snapTolerance);
    if (existing >= 0) return existing;
    return this.createNode(x, z, fixedY);
  }

  createNode(x: number, z: number, fixedY = Number.NaN): number {
    const id = this.nodes.length;
    this.nodes.push({ x, z, edges: [], alive: true, y: fixedY });
    const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    let list = this.nodeGrid.get(key);
    if (!list) this.nodeGrid.set(key, (list = []));
    list.push(id);
    return id;
  }

  findNode(x: number, z: number, tolerance: number): number {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = tolerance;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.nodeGrid.get(cellKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const id of list) {
          const n = this.nodes[id];
          if (!n.alive) continue;
          const d = hypot(n.x - x, n.z - z);
          if (d <= bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  edgeBetween(a: number, b: number): number {
    for (const e of this.nodes[a].edges) {
      const edge = this.edges[e];
      if ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)) return e;
    }
    return -1;
  }

  /** Adds an edge between two existing nodes without any splitting. */
  connect(a: number, b: number, attrs: EdgeAttrs, isolated = false): number {
    if (a === b) return -1;
    const existing = this.edgeBetween(a, b);
    if (existing >= 0) return existing;
    const id = this.edges.length;
    this.edges.push({ a, b, attrs: { ...attrs }, alive: true, isolated });
    this.nodes[a].edges.push(id);
    this.nodes[b].edges.push(id);
    if (!isolated) this.indexEdge(id);
    return id;
  }

  /**
   * Inserts segment p→q, splitting it (and existing edges) at every crossing and snapping to
   * nodes/edges within tolerance. Returns the node ids along the inserted path.
   */
  addSegment(p: Vec2, q: Vec2, attrs: EdgeAttrs): number[] {
    if (distance(p, q) < this.snapTolerance) return [];
    const start = this.nodeOnGraph(p);
    const end = this.nodeOnGraph(q);
    const sp = this.nodes[start];
    const ep = this.nodes[end];
    const a: Vec2 = { x: sp.x, z: sp.z };
    const b: Vec2 = { x: ep.x, z: ep.z };
    const hits: { t: number; node: number }[] = [
      { t: 0, node: start },
      { t: 1, node: end },
    ];
    const len = distance(a, b);
    if (len < 1e-6) return [start];

    for (const e of this.edgesNear(a, b)) {
      const edge = this.edges[e];
      if (!edge.alive || edge.isolated) continue;
      if (edge.a === start || edge.b === start || edge.a === end || edge.b === end) continue;
      const ea = this.nodes[edge.a];
      const eb = this.nodes[edge.b];
      const hit = segmentIntersection(a, b, ea, eb);
      if (!hit) continue;
      if (hit.t * len < this.snapTolerance || (1 - hit.t) * len < this.snapTolerance) continue;
      const edgeLen = distance(ea, eb);
      let node: number;
      if (hit.u * edgeLen < this.snapTolerance) node = edge.a;
      else if ((1 - hit.u) * edgeLen < this.snapTolerance) node = edge.b;
      else node = this.splitEdge(e, hit.point);
      hits.push({ t: hit.t, node });
    }
    // Snap to existing nodes lying on (or very near) the new segment.
    for (const id of this.nodesNear(a, b)) {
      if (id === start || id === end) continue;
      const n = this.nodes[id];
      const { distance: d, t } = pointSegmentDistance(n, a, b);
      if (d < this.snapTolerance && t > 0 && t < 1) hits.push({ t, node: id });
    }

    hits.sort((h1, h2) => h1.t - h2.t);
    const path: number[] = [];
    for (const h of hits) if (path[path.length - 1] !== h.node) path.push(h.node);
    for (let i = 0; i + 1 < path.length; i++) this.connect(path[i], path[i + 1], attrs);
    return path;
  }

  /** Splits edge e at point p (projected onto it); returns the new node id. */
  splitEdge(e: number, p: Vec2): number {
    const edge = this.edges[e];
    const ea = this.nodes[edge.a];
    const eb = this.nodes[edge.b];
    const { t } = pointSegmentDistance(p, ea, eb);
    const x = ea.x + (eb.x - ea.x) * t;
    const z = ea.z + (eb.z - ea.z) * t;
    const mid = this.createNode(x, z);
    const { a, b, attrs, isolated } = edge;
    this.removeEdge(e);
    this.connect(a, mid, attrs, isolated);
    this.connect(mid, b, attrs, isolated);
    return mid;
  }

  removeEdge(e: number): void {
    const edge = this.edges[e];
    if (!edge.alive) return;
    edge.alive = false;
    for (const n of [edge.a, edge.b]) {
      const node = this.nodes[n];
      node.edges = node.edges.filter((id) => id !== e);
    }
    if (!edge.isolated) this.unindexEdge(e);
  }

  degree(n: number): number {
    return this.nodes[n].edges.length;
  }

  edgeLength(e: number): number {
    const edge = this.edges[e];
    return distance(this.nodes[edge.a], this.nodes[edge.b]);
  }

  other(e: number, n: number): number {
    const edge = this.edges[e];
    return edge.a === n ? edge.b : edge.a;
  }

  aliveEdges(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.edges.length; i++) if (this.edges[i].alive) out.push(i);
    return out;
  }

  /** A copy holding only live nodes/edges, renumbered contiguously in their original order. */
  compacted(): PlanarGraph {
    const out = new PlanarGraph(this.snapTolerance);
    const nodeMap = new Map<number, number>();
    this.nodes.forEach((node, id) => {
      if (node.alive && node.edges.length > 0) nodeMap.set(id, out.createNode(node.x, node.z, node.y));
    });
    for (const edge of this.edges) {
      if (!edge.alive) continue;
      const a = nodeMap.get(edge.a);
      const b = nodeMap.get(edge.b);
      if (a === undefined || b === undefined) continue;
      out.connect(a, b, edge.attrs, edge.isolated);
    }
    return out;
  }

  /** Removes dead-end spurs shorter than minLength, repeatedly (clipping debris). */
  pruneShortDeadEnds(minLength: number, keep: (e: number) => boolean = () => false): number {
    let removed = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of this.aliveEdges()) {
        const edge = this.edges[e];
        if (edge.isolated || keep(e)) continue;
        const da = this.degree(edge.a);
        const db = this.degree(edge.b);
        if ((da === 1 || db === 1) && this.edgeLength(e) < minLength) {
          this.removeEdge(e);
          removed++;
          changed = true;
        }
      }
    }
    for (const node of this.nodes) if (node.edges.length === 0) node.alive = false;
    return removed;
  }

  /** Subdivides edges longer than maxLength into equal parts (keeps attributes). */
  subdivideLongEdges(maxLength: number, filter: (e: GraphEdge) => boolean = () => true): void {
    for (const e of this.aliveEdges()) {
      const edge = this.edges[e];
      if (!filter(edge)) continue;
      const len = this.edgeLength(e);
      if (len <= maxLength) continue;
      const parts = Math.ceil(len / maxLength);
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];
      const { attrs, isolated } = edge;
      const ids = [edge.a];
      for (let i = 1; i < parts; i++) {
        const t = i / parts;
        ids.push(
          this.createNode(
            a.x + (b.x - a.x) * t,
            a.z + (b.z - a.z) * t,
            Number.isNaN(a.y) ? Number.NaN : a.y + (b.y - a.y) * t,
          ),
        );
      }
      ids.push(edge.b);
      this.removeEdge(e);
      for (let i = 0; i + 1 < ids.length; i++) this.connect(ids[i], ids[i + 1], attrs, isolated);
    }
  }

  /**
   * Bounded faces of the planar embedding formed by edges passing `filter` (interior faces are
   * traced counter-clockwise; the unbounded outer face of each component is dropped). Dead-end
   * spurs inside a face are removed from its outline.
   */
  faces(filter: (e: GraphEdge) => boolean): Face[] {
    const usable = (e: number): boolean => {
      const edge = this.edges[e];
      return edge.alive && !edge.isolated && filter(edge);
    };
    const sorted = new Map<number, { node: number; edge: number; angle: number }[]>();
    for (let n = 0; n < this.nodes.length; n++) {
      const node = this.nodes[n];
      if (!node.alive) continue;
      const list = node.edges
        .filter(usable)
        .map((e) => {
          const o = this.nodes[this.other(e, n)];
          return { node: this.other(e, n), edge: e, angle: Math.atan2(o.z - node.z, o.x - node.x) };
        })
        .sort((p, q) => p.angle - q.angle);
      sorted.set(n, list);
    }
    const visited = new Set<number>();
    const faces: Face[] = [];
    for (let e = 0; e < this.edges.length; e++) {
      if (!usable(e)) continue;
      for (const dir of [0, 1]) {
        const key = e * 2 + dir;
        if (visited.has(key)) continue;
        const nodes: number[] = [];
        const edges: number[] = [];
        let curEdge = e;
        let from = dir === 0 ? this.edges[e].a : this.edges[e].b;
        let guard = 0;
        while (guard++ < 100_000) {
          const edge = this.edges[curEdge];
          const to = edge.a === from ? edge.b : edge.a;
          const hk = curEdge * 2 + (edge.a === from ? 0 : 1);
          if (visited.has(hk)) break;
          visited.add(hk);
          nodes.push(from);
          edges.push(curEdge);
          const around = sorted.get(to) ?? [];
          const idx = around.findIndex((x) => x.edge === curEdge);
          const next = around[(idx - 1 + around.length) % around.length];
          if (!next) break;
          from = to;
          curEdge = next.edge;
        }
        if (nodes.length < 3) continue;
        const cleaned = removeSpikes(nodes, edges);
        if (cleaned.nodes.length < 3) continue;
        const poly = cleaned.nodes.map((id) => this.nodes[id]);
        const a = signedArea(poly);
        if (a > 1e-6) faces.push({ ...cleaned, area: a });
      }
    }
    return faces;
  }

  private nodeOnGraph(p: Vec2): number {
    const existing = this.findNode(p.x, p.z, this.snapTolerance);
    if (existing >= 0) return existing;
    for (const e of this.edgesNear(p, p)) {
      const edge = this.edges[e];
      if (!edge.alive || edge.isolated) continue;
      const { distance: d, t } = pointSegmentDistance(p, this.nodes[edge.a], this.nodes[edge.b]);
      if (d < this.snapTolerance && t > 0 && t < 1) return this.splitEdge(e, p);
    }
    return this.createNode(p.x, p.z);
  }

  private edgeCells(e: number): number[] {
    const edge = this.edges[e];
    const a = this.nodes[edge.a];
    const b = this.nodes[edge.b];
    return rangeCells(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z));
  }

  private indexEdge(e: number): void {
    for (const key of this.edgeCells(e)) {
      let list = this.edgeGrid.get(key);
      if (!list) this.edgeGrid.set(key, (list = []));
      list.push(e);
    }
  }

  private unindexEdge(e: number): void {
    for (const key of this.edgeCells(e)) {
      const list = this.edgeGrid.get(key);
      if (!list) continue;
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    }
  }

  private edgesNear(a: Vec2, b: Vec2): number[] {
    const tol = this.snapTolerance;
    const seen = new Set<number>();
    for (const key of rangeCells(
      Math.min(a.x, b.x) - tol,
      Math.min(a.z, b.z) - tol,
      Math.max(a.x, b.x) + tol,
      Math.max(a.z, b.z) + tol,
    )) {
      for (const e of this.edgeGrid.get(key) ?? []) seen.add(e);
    }
    return [...seen].sort((x, y) => x - y);
  }

  private nodesNear(a: Vec2, b: Vec2): number[] {
    const tol = this.snapTolerance;
    const out: number[] = [];
    for (const key of rangeCells(
      Math.min(a.x, b.x) - tol,
      Math.min(a.z, b.z) - tol,
      Math.max(a.x, b.x) + tol,
      Math.max(a.z, b.z) + tol,
    )) {
      for (const id of this.nodeGrid.get(key) ?? []) if (this.nodes[id].alive) out.push(id);
    }
    return out;
  }
}

function rangeCells(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
  const out: number[] = [];
  const cx0 = Math.floor(minX / CELL);
  const cz0 = Math.floor(minZ / CELL);
  const cx1 = Math.floor(maxX / CELL);
  const cz1 = Math.floor(maxZ / CELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) out.push(cellKey(cx, cz));
  return out;
}

/** Removes out-and-back spikes (a dead-end edge traversed twice) from a face boundary. */
export function removeSpikes(nodes: number[], edges: number[]): { nodes: number[]; edges: number[] } {
  const n = [...nodes];
  const e = [...edges];
  let changed = true;
  while (changed && n.length >= 3) {
    changed = false;
    for (let i = 0; i < n.length; i++) {
      const prev = (i - 1 + n.length) % n.length;
      const next = (i + 1) % n.length;
      if (n[prev] === n[next] && e[prev] === e[i]) {
        // P(→X via s), X(→P via s), P(→Q): drop the first P and X; the second P keeps P→Q.
        const remove = [prev, i].sort((a, b) => b - a);
        for (const r of remove) {
          n.splice(r, 1);
          e.splice(r, 1);
        }
        changed = true;
        break;
      }
    }
  }
  return { nodes: n, edges: e };
}
