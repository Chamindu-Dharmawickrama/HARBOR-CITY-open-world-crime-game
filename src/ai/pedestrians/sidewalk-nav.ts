import type { CityLayout, Crosswalk, DistrictId } from '../../world/gen/types';

/** Kinds of places people walk to. */
export type PoiKind = 'shop' | 'park' | 'work' | 'home' | 'dock' | 'nightlife';
export const POI_KINDS: readonly PoiKind[] = ['shop', 'park', 'work', 'home', 'dock', 'nightlife'];

export interface Poi {
  node: number;
  kind: PoiKind;
}

/** District lookup for sidewalk nodes (the terrain model's, injected). */
export type DistrictLookup = (x: number, z: number) => DistrictId | null;

const CELL = 24;
/** Crossing a road costs this much extra (m) so routes do not zigzag across streets. */
const CROSSING_PENALTY = 10;

/**
 * The sidewalk graph for pedestrians: node positions, adjacency (crosswalks across internal
 * junction links removed), which links are crosswalks, points of interest by kind, a grid for
 * nearest-node queries, and A* routing (binary heap, bounded expansion).
 */
export class SidewalkNav {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly links: readonly (readonly number[])[];
  readonly district: readonly (DistrictId | null)[];
  readonly crosswalks: readonly Crosswalk[];
  readonly pois: readonly Poi[];
  readonly poisByKind: ReadonlyMap<PoiKind, readonly number[]>;
  private readonly crossingByLink = new Map<number, number>();
  private readonly grid = new Map<number, number[]>();
  // A* scratch.
  private readonly g: Float64Array;
  private readonly from: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private search = 0;
  private readonly heap: number[] = [];
  private readonly heapF: number[] = [];

  constructor(layout: CityLayout, districtAt: DistrictLookup, blockedEdges: ReadonlySet<number> = new Set()) {
    const nodes = layout.sidewalks;
    const n = nodes.length;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    const district: (DistrictId | null)[] = [];
    for (const node of nodes) {
      this.x[node.id] = node.x;
      this.y[node.id] = node.y;
      this.z[node.id] = node.z;
      district.push(districtAt(node.x, node.z));
      const key = cellKey(Math.floor(node.x / CELL), Math.floor(node.z / CELL));
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(node.id);
    }
    this.district = district;
    this.crosswalks = layout.crosswalks;
    const blocked = new Set<number>();
    for (const c of layout.crosswalks) {
      if (blockedEdges.has(c.edge)) {
        blocked.add(c.a * n + c.b);
        blocked.add(c.b * n + c.a);
        continue;
      }
      this.crossingByLink.set(c.a * n + c.b, c.id);
      this.crossingByLink.set(c.b * n + c.a, c.id);
    }
    this.links = nodes.map((node) => node.links.filter((m) => !blocked.has(node.id * n + m)));
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    const { pois, byKind } = this.buildPois(layout);
    this.pois = pois;
    this.poisByKind = byKind;
  }

  /** Crosswalk id of the link a → b, or −1. */
  crossing(a: number, b: number): number {
    return this.crossingByLink.get(a * this.count + b) ?? -1;
  }

  /** Nearest node to (x, z) within `maxDistance`, or −1. */
  nearest(x: number, z: number, maxDistance: number): number {
    let best = -1;
    let bestD = maxDistance * maxDistance;
    const c0x = Math.floor((x - maxDistance) / CELL);
    const c1x = Math.floor((x + maxDistance) / CELL);
    const c0z = Math.floor((z - maxDistance) / CELL);
    const c1z = Math.floor((z + maxDistance) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) {
          if (this.links[id].length === 0) continue;
          const d = (this.x[id] - x) ** 2 + (this.z[id] - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  /** Nodes within `radius` of (x, z) (into `out`). */
  nodesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const r2 = radius * radius;
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) {
          if (this.links[id].length > 0 && (this.x[id] - x) ** 2 + (this.z[id] - z) ** 2 <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  distance(a: number, b: number): number {
    return Math.sqrt((this.x[a] - this.x[b]) ** 2 + (this.z[a] - this.z[b]) ** 2);
  }

  /**
   * A* from `start` to `goal`; writes the node sequence (start … goal) into `out`. Returns false
   * when no route is found within `maxExpand` expansions.
   */
  findPath(start: number, goal: number, out: number[], maxExpand = 6000): boolean {
    out.length = 0;
    if (start < 0 || goal < 0) return false;
    if (start === goal) {
      out.push(start);
      return true;
    }
    const s = ++this.search;
    const heap = this.heap;
    const heapF = this.heapF;
    heap.length = 0;
    heapF.length = 0;
    this.g[start] = 0;
    this.from[start] = -1;
    this.stamp[start] = s;
    this.push(start, this.distance(start, goal));
    let expanded = 0;
    while (heap.length > 0) {
      const node = this.pop();
      if (this.closed[node] === s) continue;
      this.closed[node] = s;
      if (node === goal) {
        for (let k = goal; k >= 0; k = this.from[k]) out.push(k);
        out.reverse();
        return true;
      }
      if (++expanded > maxExpand) return false;
      for (const m of this.links[node]) {
        if (this.closed[m] === s) continue;
        const cost =
          this.g[node] + this.distance(node, m) + (this.crossing(node, m) >= 0 ? CROSSING_PENALTY : 0);
        if (this.stamp[m] === s && cost >= this.g[m]) continue;
        this.stamp[m] = s;
        this.g[m] = cost;
        this.from[m] = node;
        this.push(m, cost + this.distance(m, goal));
      }
    }
    return false;
  }

  private push(node: number, f: number): void {
    const heap = this.heap;
    const fs = this.heapF;
    let i = heap.length;
    heap.push(node);
    fs.push(f);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fs[parent] <= f) break;
      heap[i] = heap[parent];
      fs[i] = fs[parent];
      i = parent;
    }
    heap[i] = node;
    fs[i] = f;
  }

  private pop(): number {
    const heap = this.heap;
    const fs = this.heapF;
    const top = heap[0];
    const lastNode = heap.pop() as number;
    const lastF = fs.pop() as number;
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mf = lastF;
        if (l < heap.length && fs[l] < mf) {
          m = l;
          mf = fs[l];
        }
        if (r < heap.length && fs[r] < mf) m = r;
        if (m === i) break;
        heap[i] = heap[m];
        fs[i] = fs[m];
        i = m;
      }
      heap[i] = lastNode;
      fs[i] = lastF;
    }
    return top;
  }

  private buildPois(layout: CityLayout): { pois: Poi[]; byKind: Map<PoiKind, number[]> } {
    const pois: Poi[] = [];
    const seen = new Set<string>();
    const add = (x: number, z: number, kind: PoiKind): void => {
      const node = this.nearest(x, z, 40);
      if (node < 0) return;
      const key = `${node}:${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      pois.push({ node, kind });
    };
    for (const b of layout.buildings) {
      const meridian = b.district === 'meridian';
      if (b.sign >= 0) {
        add(b.center.x, b.center.z, 'shop');
        if (meridian) add(b.center.x, b.center.z, 'nightlife');
      }
      if (b.style === 'house') add(b.center.x, b.center.z, 'home');
      else if (b.district === 'gantry' && b.style === 'industrial') add(b.center.x, b.center.z, 'dock');
      else if (b.height > 24 || b.style === 'office' || b.style === 'glass')
        add(b.center.x, b.center.z, 'work');
      else if (b.style === 'brick' && b.district !== 'gantry') add(b.center.x, b.center.z, 'home');
    }
    for (const block of layout.blocks) {
      if (block.use === 'lots') continue;
      let cx = 0;
      let cz = 0;
      for (const p of block.curb) {
        cx += p.x;
        cz += p.z;
      }
      cx /= block.curb.length;
      cz /= block.curb.length;
      add(cx, cz, 'park');
      if (block.use === 'plaza' && block.district === 'meridian') add(cx, cz, 'nightlife');
    }
    for (const lot of layout.lots) {
      if (lot.use !== 'yard') continue;
      const p = lot.polygon[0];
      if (p) add(p.x, p.z, 'dock');
    }
    const byKind = new Map<PoiKind, number[]>(POI_KINDS.map((k) => [k, []]));
    pois.forEach((p, i) => byKind.get(p.kind)?.push(i));
    return { pois, byKind };
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}
