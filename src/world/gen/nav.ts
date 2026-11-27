import { SpatialHash2D } from '../../core/spatial-hash';
import {
  add,
  distance,
  insetPolygon,
  lineIntersection,
  normalize,
  perpendicular,
  resamplePolyline,
  scale,
  sub,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import type { PlanarGraph } from './planar-graph';
import { SIDEWALK_HEIGHT } from './props';
import { laneWidthFor } from './road-profile';
import type { Block, Crosswalk, Junction, Lane, LaneNode, RoadChain, SidewalkNode } from './types';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Road surface height along edge e at parameter t (bridges follow a parabolic arch). */
export function edgeHeight(graph: PlanarGraph, e: number, fromNode: number, t: number): number {
  const edge = graph.edges[e];
  const a = graph.nodes[fromNode] as { y: number };
  const b = graph.nodes[graph.other(e, fromNode)] as { y: number };
  return a.y + (b.y - a.y) * t + edge.attrs.arch * 4 * t * (1 - t);
}

/**
 * Centre line of a chain from its first to last node, trimmed back from junctions, sampled
 * at every node and additionally every `bridgeStep` metres on arched bridge edges.
 */
export function chainCenterline(
  graph: PlanarGraph,
  chain: RoadChain,
  junctionByNode: Map<number, Junction>,
  bridgeStep = 8,
): Point3[] {
  const raw: Point3[] = [];
  for (let i = 0; i < chain.edges.length; i++) {
    const e = chain.edges[i];
    const from = chain.nodes[i];
    const a = graph.nodes[from] as { x: number; z: number; y: number };
    const b = graph.nodes[chain.nodes[i + 1]] as { x: number; z: number; y: number };
    const edge = graph.edges[e];
    const steps = edge.attrs.arch > 0 ? Math.max(2, Math.ceil(distance(a, b) / bridgeStep)) : 1;
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      raw.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: edgeHeight(graph, e, from, t) });
    }
  }
  const startTrim =
    junctionByNode.get(chain.nodes[0])?.trims.find((t) => t.edge === chain.edges[0])?.distance ?? 0;
  const lastEdge = chain.edges[chain.edges.length - 1];
  const endTrim =
    junctionByNode.get(chain.nodes[chain.nodes.length - 1])?.trims.find((t) => t.edge === lastEdge)
      ?.distance ?? 0;
  return trimPolyline3(raw, startTrim, endTrim);
}

/** Removes `start` metres from the beginning and `end` metres from the end (XZ distance). */
export function trimPolyline3(points: Point3[], start: number, end: number): Point3[] {
  const total = polylineLength3(points);
  if (start + end >= total - 0.5) {
    const mid = Math.max(0, Math.min(total, (total + start - end) / 2));
    const p = pointAtDistance(points, mid);
    const q = pointAtDistance(points, Math.min(total, mid + 0.25));
    return [p, q];
  }
  const out: Point3[] = [pointAtDistance(points, start)];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += distance(points[i - 1], points[i]);
    if (acc > start + 1e-6 && acc < total - end - 1e-6) out.push(points[i]);
  }
  out.push(pointAtDistance(points, total - end));
  return out;
}

export function polylineLength3(points: readonly Point3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1], points[i]);
  return len;
}

export function pointAtDistance(points: readonly Point3[], d: number): Point3 {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = distance(a, b);
    if (acc + seg >= d) {
      const t = seg < 1e-9 ? 0 : (d - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += seg;
  }
  return { ...points[points.length - 1] };
}

/**
 * Offsets a polyline sideways with mitred joints; positive = right of the travel direction.
 * (With +x east and +z south, `perpendicular(dir)` points to the right of travel.)
 */
export function offsetPolyline3(points: readonly Point3[], offset: number): Point3[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    let right = perpendicular(normalize(sub(next, prev)));
    if (i > 0 && i < n - 1) {
      const r1 = perpendicular(normalize(sub(p, prev)));
      const r2 = perpendicular(normalize(sub(next, p)));
      const m = normalize(add(r1, r2));
      right = scale(m, 1 / Math.max(0.35, m.x * r1.x + m.z * r1.z));
    }
    return { x: p.x + right.x * offset, y: p.y, z: p.z + right.z * offset };
  });
}

export interface LaneGraphResult {
  lanes: Lane[];
  laneNodes: LaneNode[];
}

interface ApproachLanes {
  chain: number;
  /** Lanes arriving at the junction, index 0 = innermost. */
  incoming: number[];
  /** Lanes leaving the junction, index 0 = innermost. */
  outgoing: number[];
  /** Direction pointing away from the junction along this chain. */
  dir: Vec2;
  phase: number;
}

export function buildLaneGraph(
  graph: PlanarGraph,
  chains: readonly RoadChain[],
  junctions: readonly Junction[],
): LaneGraphResult {
  const lanes: Lane[] = [];
  const laneNodes: LaneNode[] = [];
  const junctionByNode = new Map(junctions.map((j) => [j.node, j]));
  const endpoints = new Map<number, ApproachLanes[]>();

  const addNode = (p: Point3): number => {
    laneNodes.push({ id: laneNodes.length, x: p.x, y: p.y, z: p.z });
    return laneNodes.length - 1;
  };
  const addLane = (
    points: Point3[],
    edge: number,
    index: number,
    speed: number,
    junction: number,
    isConnector: boolean,
    signalGroup = -1,
    chain = -1,
    dir = 0,
    offset = 0,
    width = 3,
  ): number => {
    const id = lanes.length;
    lanes.push({
      id,
      points: points.map(addNode),
      edge,
      index,
      speedLimit: speed,
      next: [],
      junction,
      signalGroup,
      isConnector,
      chain,
      dir,
      inner: -1,
      outer: -1,
      offset,
      width,
    });
    return id;
  };
  const register = (node: number, approach: ApproachLanes): void => {
    let list = endpoints.get(node);
    if (!list) endpoints.set(node, (list = []));
    list.push(approach);
  };

  for (const chain of chains) {
    const center = chainCenterline(graph, chain, junctionByNode);
    if (center.length < 2) continue;
    const lanesPerDir = Math.max(1, chain.lanesPerDirection);
    // Curb-parking streets keep their parking strips clear of the traffic lanes.
    const laneWidth = laneWidthFor(chain.cls, chain.width, lanesPerDir);
    const speed = graph.edges[chain.edges[0]].attrs.speedLimit;
    const firstNode = chain.nodes[0];
    const lastNode = chain.nodes[chain.nodes.length - 1];
    const forward: number[] = [];
    const backward: number[] = [];
    const reversed = [...center].reverse();
    for (let i = 0; i < lanesPerDir; i++) {
      const off = (i + 0.5) * laneWidth;
      const e = chain.edges[0];
      forward.push(
        addLane(offsetPolyline3(center, off), e, i, speed, lastNode, false, -1, chain.id, 1, off, laneWidth),
      );
      backward.push(
        addLane(
          offsetPolyline3(reversed, off),
          e,
          i,
          speed,
          firstNode,
          false,
          -1,
          chain.id,
          -1,
          off,
          laneWidth,
        ),
      );
    }
    for (const side of [forward, backward]) {
      for (let i = 0; i < side.length; i++) {
        lanes[side[i]].inner = i > 0 ? side[i - 1] : -1;
        lanes[side[i]].outer = i < side.length - 1 ? side[i + 1] : -1;
      }
    }
    const startDir = normalize(sub(center[1], center[0]));
    const endDir = normalize(sub(center[center.length - 2], center[center.length - 1]));
    register(firstNode, { chain: chain.id, incoming: backward, outgoing: forward, dir: startDir, phase: 0 });
    register(lastNode, { chain: chain.id, incoming: forward, outgoing: backward, dir: endDir, phase: 0 });
  }

  for (const [node, approaches] of endpoints) {
    const junction = junctionByNode.get(node);
    if (approaches.length === 1) {
      const a = approaches[0];
      // Dead end: every incoming lane turns around into the outgoing lane with the same index.
      for (let i = 0; i < a.incoming.length; i++) {
        const from = lanes[a.incoming[i]];
        const to = lanes[a.outgoing[Math.min(i, a.outgoing.length - 1)]];
        const p0 = laneNodes[from.points[from.points.length - 1]] as Point3;
        const p2 = laneNodes[to.points[0]] as Point3;
        const ahead = scale(a.dir, -Math.max(4, distance(p0, p2)));
        const control = { ...add(scale(add(p0, p2), 0.5), ahead), y: (p0.y + p2.y) / 2 };
        const id = addLane(bezier(p0, control, p2, 6), from.edge, i, 5, node, true);
        from.next.push(id);
        lanes[id].next.push(to.id);
      }
      continue;
    }
    if (junction?.signalized) assignPhases(approaches);
    for (const a of approaches) {
      for (const b of approaches) {
        if (a === b) continue;
        const inDir = scale(a.dir, -1);
        const outDir = b.dir;
        const turn = Math.atan2(
          inDir.x * outDir.z - inDir.z * outDir.x,
          inDir.x * outDir.x + inDir.z * outDir.z,
        );
        if (Math.abs(turn) > 2.8) continue;
        const straight = Math.abs(turn) < 0.6;
        // turn > 0: turning toward +perpendicular of travel = right-hand turn in this frame.
        const rightTurn = !straight && turn > 0;
        const pairs: [number, number][] = [];
        if (straight) {
          for (let i = 0; i < a.incoming.length; i++) pairs.push([i, Math.min(i, b.outgoing.length - 1)]);
        } else if (rightTurn) {
          pairs.push([a.incoming.length - 1, b.outgoing.length - 1]);
        } else {
          pairs.push([0, 0]);
        }
        for (const [ia, ib] of pairs) {
          const from = lanes[a.incoming[ia]];
          const to = lanes[b.outgoing[ib]];
          if (!junction) {
            from.next.push(to.id);
            continue;
          }
          const p0 = laneNodes[from.points[from.points.length - 1]] as Point3;
          const p2 = laneNodes[to.points[0]] as Point3;
          const hit = lineIntersection(p0, add(p0, inDir), p2, add(p2, outDir));
          const mid = scale(add(p0, p2), 0.5);
          const c = hit && distance(hit, mid) < distance(p0, p2) * 1.5 ? hit : mid;
          const control = { x: c.x, z: c.z, y: (p0.y + p2.y) / 2 };
          const id = addLane(
            bezier(p0, control, p2, straight ? 3 : 6),
            from.edge,
            ia,
            straight ? from.speedLimit : 7,
            node,
            true,
            junction.signalized ? a.phase : -1,
          );
          from.next.push(id);
          lanes[id].next.push(to.id);
        }
      }
    }
  }
  return { lanes, laneNodes };
}

function assignPhases(approaches: ApproachLanes[]): void {
  const ref = approaches[0];
  for (const a of approaches) {
    const cos = Math.abs(a.dir.x * ref.dir.x + a.dir.z * ref.dir.z);
    a.phase = cos > 0.7 ? 0 : 1;
  }
}

function bezier(p0: Point3, c: Point3, p2: Point3, segments: number): Point3[] {
  const out: Point3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
      z: u * u * p0.z + 2 * u * t * c.z + t * t * p2.z,
    });
  }
  return out;
}

export interface SidewalkGraphResult {
  nodes: SidewalkNode[];
  crosswalks: Crosswalk[];
}

/** Sidewalk rings around every block plus crosswalk links across each junction approach. */
export function buildSidewalkGraph(
  graph: PlanarGraph,
  blocks: readonly Block[],
  junctions: readonly Junction[],
  terrain: TerrainModel,
): SidewalkGraphResult {
  const nodes: SidewalkNode[] = [];
  const crosswalks: Crosswalk[] = [];
  for (const block of blocks) {
    const sidewalk = terrain.district(block.district).sidewalkWidth;
    const path = insetPolygon(block.curb, sidewalk / 2) ?? block.curb;
    const ring = resamplePolyline([...path, path[0]], 12).slice(0, -1);
    if (ring.length < 3) continue;
    const first = nodes.length;
    ring.forEach((p, i) => {
      nodes.push({
        id: first + i,
        x: p.x,
        y: terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT,
        z: p.z,
        links: [first + ((i + 1) % ring.length), first + ((i - 1 + ring.length) % ring.length)],
        crossingJunction: -1,
      });
    });
  }
  const hash = new SpatialHash2D(16, Math.max(1, nodes.length));
  for (const n of nodes) hash.insertPoint(n.id, n.x, n.z);
  const found: number[] = [];
  const nearest = (p: Vec2, maxD: number): number => {
    hash.queryRadius(p.x, p.z, maxD, found);
    let best = -1;
    let bestD = maxD;
    for (const id of found) {
      const d = distance(nodes[id], p);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };
  for (const junction of junctions) {
    const center = graph.nodes[junction.node] as Vec2;
    for (const trim of junction.trims) {
      const edge = graph.edges[trim.edge];
      if (edge.isolated || edge.attrs.cls === 'bridge') continue;
      const other = graph.nodes[graph.other(trim.edge, junction.node)] as Vec2;
      const d = normalize(sub(other, center));
      const c = add(center, scale(d, trim.distance + 2.5));
      const side = perpendicular(d);
      const reach = edge.attrs.width / 2 + 2;
      const l = nearest(add(c, scale(side, reach)), 7);
      const r = nearest(sub(c, scale(side, reach)), 7);
      if (l < 0 || r < 0 || l === r) continue;
      const nl = nodes[l];
      const nr = nodes[r];
      if (nl.links.includes(r)) continue;
      nl.links.push(r);
      nr.links.push(l);
      crosswalks.push({
        id: crosswalks.length,
        a: l,
        b: r,
        junction: junction.node,
        edge: trim.edge,
        signalized: junction.signalized,
      });
      if (junction.signalized) {
        nl.crossingJunction = junction.node;
        nr.crossingJunction = junction.node;
      }
    }
  }
  return { nodes, crosswalks };
}
