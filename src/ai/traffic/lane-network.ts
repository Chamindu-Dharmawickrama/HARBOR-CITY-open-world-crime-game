import { mix32 } from '../../core/hash';
import type { CityLayout, DistrictId, RoadClass } from '../../world/gen/types';
import { cycleLength, DEFAULT_TIMING, type SignalTiming } from './signals';

/** Cars stop with their front this far before the end of an approach lane (behind the painted stop line). */
export const STOP_LINE_BACK = 4.6;
/** Connectors whose centre lines pass closer than this conflict (cars on them would touch). */
export const CONFLICT_DISTANCE = 1.9;
/**
 * Links shorter than this between two controlled junctions are internal to the junction pair:
 * no stop line or signal of their own; cars are admitted through both junctions at once.
 */
export const INTERNAL_LINK = 12;

export const Turn = { left: 0, right: 1, straight: 2, uturn: 3 } as const;
export type TurnKind = (typeof Turn)[keyof typeof Turn];

/** A point on a lane: position plus the unit travel direction in the XZ plane. */
export interface LanePoint {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}

export function createLanePoint(): LanePoint {
  return { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
}

export interface LaneProjection {
  s: number;
  /** Signed lateral offset, + = right of the travel direction. */
  lat: number;
  dist: number;
}

export interface JunctionControl {
  node: number;
  x: number;
  z: number;
  signalized: boolean;
  /** Index into `signals` (or −1). */
  signal: number;
  connectors: number[];
}

export interface SignalInfo {
  junction: number;
  node: number;
  timing: SignalTiming;
}

const CELL = 32;

function roadRank(cls: RoadClass | undefined): number {
  switch (cls) {
    case 'arterial':
    case 'ring':
    case 'bridge':
    case 'tunnel':
      return 2;
    case 'street':
      return 1;
    case 'alley':
    case undefined:
      return 0;
  }
}

/**
 * Runtime view of the generated lane graph for traffic: lane polylines packed into typed arrays
 * with cumulative distances, stop lines, signal phases, per-junction connector lists with
 * geometric conflict sets and turn types, and a spatial grid for locating lanes near a point.
 */
export class LaneNetwork {
  readonly count: number;
  readonly length: Float64Array;
  readonly speed: Float32Array;
  readonly connector: Uint8Array;
  /** Stop position (front bumper, distance along the lane) or −1 when the lane has no stop line. */
  readonly stopS: Float32Array;
  /** Approach lanes: signal index (−1 unsignalled) and phase. */
  readonly signal: Int32Array;
  readonly phase: Int8Array;
  /** Connectors and approach lanes: junction control index (−1 = none). */
  readonly junction: Int32Array;
  readonly turn: Int8Array;
  /** Road-class rank (2 major, 1 street, 0 alley) of the lane / a connector's source lane. */
  readonly rank: Int8Array;
  /** Connectors: the approach lane they start from. */
  readonly source: Int32Array;
  readonly next: readonly (readonly number[])[];
  readonly prev: readonly number[][];
  readonly conflicts: readonly (readonly number[])[];
  readonly inner: Int32Array;
  readonly outer: Int32Array;
  readonly width: Float32Array;
  readonly district: readonly (DistrictId | null)[];
  readonly roadClass: readonly (RoadClass | null)[];
  readonly junctions: JunctionControl[] = [];
  readonly signals: SignalInfo[] = [];
  /** Non-connector lanes long enough to spawn traffic on. */
  readonly spawnLanes: number[] = [];
  /** Short links between two controlled junctions (driven through without stopping). */
  readonly internal: Uint8Array;
  /** "junctionNode:edge" of approaches that are internal links (their signal heads stay dark). */
  readonly internalArms = new Set<string>();
  /** Road edges of internal links (pedestrians do not cross there). */
  readonly internalEdges = new Set<number>();
  private readonly start: Int32Array;
  private readonly npts: Int32Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly ps: Float64Array;
  private readonly grid = new Map<number, number[]>();

  constructor(layout: CityLayout) {
    const lanes = layout.lanes;
    const n = lanes.length;
    this.count = n;
    let total = 0;
    for (const lane of lanes) total += lane.points.length;
    this.start = new Int32Array(n);
    this.npts = new Int32Array(n);
    this.px = new Float64Array(total);
    this.py = new Float64Array(total);
    this.pz = new Float64Array(total);
    this.ps = new Float64Array(total);
    this.length = new Float64Array(n);
    this.speed = new Float32Array(n);
    this.connector = new Uint8Array(n);
    this.stopS = new Float32Array(n).fill(-1);
    this.signal = new Int32Array(n).fill(-1);
    this.phase = new Int8Array(n).fill(-1);
    this.junction = new Int32Array(n).fill(-1);
    this.turn = new Int8Array(n).fill(Turn.straight);
    this.rank = new Int8Array(n);
    this.source = new Int32Array(n).fill(-1);
    this.inner = new Int32Array(n).fill(-1);
    this.outer = new Int32Array(n).fill(-1);
    this.width = new Float32Array(n);
    const next: number[][] = [];
    const prev: number[][] = lanes.map(() => []);
    const district: (DistrictId | null)[] = [];
    const roadClass: (RoadClass | null)[] = [];
    let o = 0;
    for (const lane of lanes) {
      const id = lane.id;
      this.start[id] = o;
      this.npts[id] = lane.points.length;
      let acc = 0;
      for (let i = 0; i < lane.points.length; i++) {
        const p = layout.laneNodes[lane.points[i]];
        if (i > 0) {
          const dx = p.x - this.px[o + i - 1];
          const dz = p.z - this.pz[o + i - 1];
          acc += Math.sqrt(dx * dx + dz * dz);
        }
        this.px[o + i] = p.x;
        this.py[o + i] = p.y;
        this.pz[o + i] = p.z;
        this.ps[o + i] = acc;
      }
      o += lane.points.length;
      this.length[id] = acc;
      this.speed[id] = lane.speedLimit;
      this.connector[id] = lane.isConnector ? 1 : 0;
      this.inner[id] = lane.inner;
      this.outer[id] = lane.outer;
      this.width[id] = lane.width;
      next.push([...lane.next]);
      for (const m of lane.next) prev[m]?.push(id);
      const edge = layout.edges[lane.edge];
      district.push(edge?.district ?? null);
      roadClass.push(edge?.cls ?? null);
      this.rank[id] = roadRank(edge?.cls);
    }
    this.next = next;
    this.prev = prev;
    this.district = district;
    this.roadClass = roadClass;

    // Junction controls (one per junction node that has connectors).
    const junctionByNode = new Map(layout.junctions.map((j) => [j.node, j]));
    const controlByNode = new Map<number, number>();
    for (const lane of lanes) {
      if (!lane.isConnector) continue;
      const j = junctionByNode.get(lane.junction);
      if (!j) continue;
      let index = controlByNode.get(lane.junction);
      if (index === undefined) {
        index = this.junctions.length;
        controlByNode.set(lane.junction, index);
        const node = layout.nodes[lane.junction];
        this.junctions.push({
          node: lane.junction,
          x: node?.x ?? 0,
          z: node?.z ?? 0,
          signalized: j.signalized,
          signal: -1,
          connectors: [],
        });
      }
      this.junctions[index].connectors.push(lane.id);
      this.junction[lane.id] = index;
    }
    // Connector sources, turn kinds and ranks; approach lanes: stop lines, junction, phase.
    for (const lane of lanes) {
      if (!lane.isConnector) continue;
      const src = prev[lane.id][0] ?? -1;
      this.source[lane.id] = src;
      if (src >= 0) this.rank[lane.id] = this.rank[src];
      this.turn[lane.id] = this.classifyTurn(lane.id);
      if (src >= 0 && this.junction[lane.id] >= 0) {
        this.junction[src] = this.junction[lane.id];
        this.stopS[src] = Math.max(0.5, this.length[src] - STOP_LINE_BACK);
        if (lane.signalGroup >= 0) this.phase[src] = lane.signalGroup;
      }
    }
    this.buildSignals(lanes.map((l) => l.signalGroup));
    this.internal = new Uint8Array(n);
    for (let id = 0; id < n; id++) {
      const j = this.junction[id];
      if (j >= 0 && !this.connector[id] && this.junctions[j].signal >= 0 && this.phase[id] >= 0)
        this.signal[id] = this.junctions[j].signal;
      const fromJunction = prev[id].some((c) => this.connector[c] === 1 && this.junction[c] >= 0);
      if (!this.connector[id] && this.stopS[id] >= 0 && this.length[id] < INTERNAL_LINK && fromJunction) {
        this.internal[id] = 1;
        this.signal[id] = -1;
        this.stopS[id] = 0;
        const lane = lanes[id];
        const chainEdges = layout.chains[lane.chain]?.edges ?? [lane.edge];
        for (const e of chainEdges) {
          this.internalEdges.add(e);
          this.internalArms.add(`${lane.junction}:${e}`);
        }
      }
    }
    this.conflicts = this.buildConflicts();
    this.assignPhases();
    for (let id = 0; id < n; id++) {
      if (!this.connector[id] && this.length[id] >= 25) this.spawnLanes.push(id);
      this.indexLane(id);
    }
  }

  /** Point (and travel direction) at distance `s` along a lane (clamped to the lane). */
  sample(lane: number, s: number, out: LanePoint): LanePoint {
    const o = this.start[lane];
    const n = this.npts[lane];
    const ps = this.ps;
    if (n < 2) {
      out.x = this.px[o];
      out.y = this.py[o];
      out.z = this.pz[o];
      return out;
    }
    let i: number;
    if (s <= 0) i = 0;
    else if (s >= ps[o + n - 1]) i = n - 2;
    else {
      // Binary search for the segment containing s.
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ps[o + mid] <= s) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const a = o + i;
    const seg = ps[a + 1] - ps[a];
    const t = seg > 1e-9 ? Math.max(0, Math.min(1, (s - ps[a]) / seg)) : 0;
    const dx = this.px[a + 1] - this.px[a];
    const dz = this.pz[a + 1] - this.pz[a];
    out.x = this.px[a] + dx * t;
    out.y = this.py[a] + (this.py[a + 1] - this.py[a]) * t;
    out.z = this.pz[a] + dz * t;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    out.dx = dx / len;
    out.dz = dz / len;
    return out;
  }

  /**
   * Closest point on a lane to (x, z). With a hint, only segments within `window` metres of the
   * hinted distance are searched (cheap tracking of a moving vehicle).
   */
  project(lane: number, x: number, z: number, out: LaneProjection, hint = -1, window = 20): LaneProjection {
    const o = this.start[lane];
    const n = this.npts[lane];
    let best = Infinity;
    out.s = 0;
    out.lat = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = o + i;
      if (hint >= 0 && (this.ps[a + 1] < hint - window || this.ps[a] > hint + window)) continue;
      const ax = this.px[a];
      const az = this.pz[a];
      const dx = this.px[a + 1] - ax;
      const dz = this.pz[a + 1] - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
      const cx = ax + dx * t;
      const cz = az + dz * t;
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (d2 < best) {
        best = d2;
        const len = Math.sqrt(len2) || 1;
        out.s = this.ps[a] + t * len;
        // Right of travel = (−dz, dx).
        out.lat = ((x - cx) * -dz + (z - cz) * dx) / len;
      }
    }
    out.dist = Math.sqrt(best);
    return out;
  }

  /** Lanes with a segment within `radius` of (x, z) (written into `out`, duplicates removed). */
  lanesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const c0x = Math.floor((x - radius) / CELL);
    const c1x = Math.floor((x + radius) / CELL);
    const c0z = Math.floor((z - radius) / CELL);
    const c1z = Math.floor((z + radius) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** Index of the lane's first point (for iterating its polyline). */
  pointRange(lane: number): { start: number; count: number } {
    return { start: this.start[lane], count: this.npts[lane] };
  }

  pointX(i: number): number {
    return this.px[i];
  }

  pointY(i: number): number {
    return this.py[i];
  }

  pointZ(i: number): number {
    return this.pz[i];
  }

  /** The connector following approach lane `lane` toward `exit`, or −1. */
  connectorBetween(lane: number, exit: number): number {
    for (const c of this.next[lane]) if (this.next[c]?.includes(exit)) return c;
    return -1;
  }

  /** Right-of-way rank of a connector: road class first, then straight > right > left. */
  priority(connector: number): number {
    const turn = this.turn[connector];
    const turnRank = turn === Turn.straight ? 2 : turn === Turn.right ? 1 : 0;
    return this.rank[connector] * 3 + turnRank;
  }

  private classifyTurn(id: number): TurnKind {
    const o = this.start[id];
    const n = this.npts[id];
    if (n < 2) return Turn.straight;
    const d0x = this.px[o + 1] - this.px[o];
    const d0z = this.pz[o + 1] - this.pz[o];
    const d1x = this.px[o + n - 1] - this.px[o + n - 2];
    const d1z = this.pz[o + n - 1] - this.pz[o + n - 2];
    const angle = Math.atan2(d0x * d1z - d0z * d1x, d0x * d1x + d0z * d1z);
    if (Math.abs(angle) > 2.6) return Turn.uturn;
    if (Math.abs(angle) < 0.6) return Turn.straight;
    // Positive cross product (x east, z south): a right-hand turn.
    return angle > 0 ? Turn.right : Turn.left;
  }

  private buildSignals(signalGroups: readonly number[]): void {
    for (let j = 0; j < this.junctions.length; j++) {
      const control = this.junctions[j];
      if (!control.signalized) continue;
      const phaseRank = [0, 0];
      for (const c of control.connectors) {
        const group = signalGroups[c] ?? -1;
        if (group === 0 || group === 1) phaseRank[group] = Math.max(phaseRank[group], this.rank[c]);
      }
      const green: [number, number] = [phaseRank[0] >= 2 ? 20 : 13, phaseRank[1] >= 2 ? 20 : 13];
      const base = { ...DEFAULT_TIMING, green };
      // Deterministic per-junction offset so neighbouring lights do not switch in lockstep.
      const offset = ((mix32(control.node + 0x51ed) >>> 0) / 4294967296) * cycleLength(base);
      control.signal = this.signals.length;
      this.signals.push({ junction: j, node: control.node, timing: { ...base, offset } });
    }
  }

  /**
   * Signal phases. Junctions joined by internal links behave as one intersection and share one
   * controller (unsignalled members join it). Within each controlled group the approaches are
   * 2-coloured on their conflict graph: approaches whose straight-through paths cross get
   * different phases, head-on approaches share one, so skewed and split junctions are phased
   * correctly. Green times follow the most important road in each phase.
   */
  private assignPhases(): void {
    const parent = this.junctions.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let l = 0; l < this.count; l++) {
      if (!this.internal[l]) continue;
      for (const p of this.prev[l]) {
        if (this.junction[p] >= 0) parent[find(this.junction[p])] = find(this.junction[l]);
      }
    }
    const groups = new Map<number, number[]>();
    this.junctions.forEach((_, i) => {
      const root = find(i);
      let list = groups.get(root);
      if (!list) groups.set(root, (list = []));
      list.push(i);
    });
    const approachesOf = new Map<number, number[]>();
    for (let id = 0; id < this.count; id++) {
      if (this.connector[id] || this.internal[id] || this.stopS[id] < 0 || this.junction[id] < 0) continue;
      const root = find(this.junction[id]);
      let list = approachesOf.get(root);
      if (!list) approachesOf.set(root, (list = []));
      list.push(id);
    }
    for (const [root, list] of groups) {
      const signalled = list.find((j) => this.junctions[j].signal >= 0);
      if (signalled === undefined) {
        for (const a of approachesOf.get(root) ?? []) this.signal[a] = -1;
        continue;
      }
      const shared = this.junctions[signalled].signal;
      for (const j of list) this.junctions[j].signal = shared;
      const approaches = approachesOf.get(root) ?? [];
      const paths = approaches.map((a) => this.straightPath(a));
      const conflict = (i: number, k: number): boolean => {
        for (const ca of paths[i])
          for (const cb of paths[k]) if (this.conflicts[ca].includes(cb)) return true;
        return false;
      };
      // Two phases where they separate every crossing pair, otherwise three.
      let colour = colourApproaches(approaches.length, 2, conflict, (i) => this.rank[approaches[i]]);
      let phases = 2;
      if (colour.clashes > 0) {
        const three = colourApproaches(approaches.length, 3, conflict, (i) => this.rank[approaches[i]]);
        if (three.clashes < colour.clashes) {
          colour = three;
          phases = 3;
        }
      }
      const rankOf = new Array<number>(phases).fill(0);
      approaches.forEach((a, i) => {
        this.phase[a] = colour.colour[i];
        this.signal[a] = shared;
        rankOf[colour.colour[i]] = Math.max(rankOf[colour.colour[i]], this.rank[a]);
      });
      const timing = this.signals[shared].timing;
      // Three-phase plans run shorter greens so the whole cycle stays near a minute.
      const major = phases === 3 ? 14 : 20;
      const minor = phases === 3 ? 10 : 13;
      this.signals[shared].timing = { ...timing, green: rankOf.map((r) => (r >= 2 ? major : minor)) };
    }
  }

  /** Connectors an approach drives straight through (following internal links). */
  private straightPath(approach: number): number[] {
    const out: number[] = [];
    let lane = approach;
    for (let guard = 0; guard < 6; guard++) {
      const options = this.next[lane];
      let pick = -1;
      let best = Infinity;
      for (const c of options) {
        if (!this.connector[c]) continue;
        const score = this.turn[c] === Turn.straight ? 0 : this.turn[c] === Turn.uturn ? 3 : 1;
        if (score < best) {
          best = score;
          pick = c;
        }
      }
      if (pick < 0 || out.includes(pick)) break;
      out.push(pick);
      const exit = this.next[pick][0];
      if (exit === undefined || !this.internal[exit]) break;
      lane = exit;
    }
    return out;
  }

  /** Phase of the approach arriving at `junctionNode` along road `edge` (−1 if not signalled). */
  armPhase(junctionNode: number, edge: number, layout: CityLayout): { signal: number; phase: number } | null {
    for (const lane of layout.lanes) {
      if (lane.isConnector || lane.junction !== junctionNode) continue;
      const edges = layout.chains[lane.chain]?.edges ?? [lane.edge];
      if (!edges.includes(edge)) continue;
      if (this.signal[lane.id] < 0) return null;
      return { signal: this.signal[lane.id], phase: this.phase[lane.id] };
    }
    return null;
  }

  private buildConflicts(): number[][] {
    const conflicts: number[][] = Array.from({ length: this.count }, () => []);
    for (const control of this.junctions) {
      const list = control.connectors;
      for (let i = 0; i < list.length; i++) {
        for (let k = i + 1; k < list.length; k++) {
          const a = list[i];
          const b = list[k];
          if (this.source[a] === this.source[b] && this.source[a] >= 0) continue; // diverging
          const mergeInto = this.next[a][0] === this.next[b][0];
          if (mergeInto || this.polylineDistance(a, b) < CONFLICT_DISTANCE) {
            conflicts[a].push(b);
            conflicts[b].push(a);
          }
        }
      }
    }
    return conflicts;
  }

  private polylineDistance(a: number, b: number): number {
    let best = Infinity;
    const oa = this.start[a];
    const ob = this.start[b];
    for (let i = 0; i < this.npts[a] - 1; i++) {
      for (let k = 0; k < this.npts[b] - 1; k++) {
        const d = segmentDistance(
          this.px[oa + i],
          this.pz[oa + i],
          this.px[oa + i + 1],
          this.pz[oa + i + 1],
          this.px[ob + k],
          this.pz[ob + k],
          this.px[ob + k + 1],
          this.pz[ob + k + 1],
        );
        if (d < best) best = d;
      }
    }
    return best;
  }

  private indexLane(id: number): void {
    const o = this.start[id];
    for (let i = 0; i < this.npts[id] - 1; i++) {
      const x0 = Math.min(this.px[o + i], this.px[o + i + 1]);
      const x1 = Math.max(this.px[o + i], this.px[o + i + 1]);
      const z0 = Math.min(this.pz[o + i], this.pz[o + i + 1]);
      const z1 = Math.max(this.pz[o + i], this.pz[o + i + 1]);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          const key = cellKey(cx, cz);
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          if (list[list.length - 1] !== id) list.push(id);
        }
      }
    }
  }
}

/**
 * Greedy graph colouring of junction approaches (most important first): each takes the colour
 * with the fewest conflicting neighbours; `clashes` counts conflicting pairs left sharing a colour.
 */
export function colourApproaches(
  count: number,
  colours: number,
  conflict: (a: number, b: number) => boolean,
  importance: (a: number) => number,
): { colour: Int8Array; clashes: number } {
  const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => importance(y) - importance(x));
  const colour = new Int8Array(count).fill(-1);
  const against = new Int32Array(colours);
  for (const i of order) {
    against.fill(0);
    for (let k = 0; k < count; k++) if (k !== i && colour[k] >= 0 && conflict(i, k)) against[colour[k]]++;
    let best = 0;
    for (let c = 1; c < colours; c++) if (against[c] < against[best]) best = c;
    colour[i] = best;
  }
  let clashes = 0;
  for (let i = 0; i < count; i++)
    for (let k = i + 1; k < count; k++) if (colour[i] === colour[k] && conflict(i, k)) clashes++;
  return { colour, clashes };
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.sqrt((px - ax - dx * t) ** 2 + (pz - az - dz * t) ** 2);
}

/** Distance between segments AB and CD in the XZ plane. */
export function segmentDistance(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number {
  const o1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const o2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const o3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const o4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(
    pointSegment(ax, az, cx, cz, dx, dz),
    pointSegment(bx, bz, cx, cz, dx, dz),
    pointSegment(cx, cz, ax, az, bx, bz),
    pointSegment(dx, dz, ax, az, bx, bz),
  );
}
