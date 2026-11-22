import { add, convexHull, normalize, perpendicular, scale, sub, type Polygon, type Vec2 } from './geometry2d';
import type { GraphEdge, PlanarGraph } from './planar-graph';
import type { Junction, RoadChain } from './types';

/**
 * Splits the road graph into chains: maximal runs of edges through degree-2 nodes that share
 * class and width. Chains start/end at junctions (degree ≥ 3), dead ends, or class changes.
 */
export function buildChains(graph: PlanarGraph): { chains: RoadChain[]; edgeChain: Map<number, number> } {
  const chains: RoadChain[] = [];
  const edgeChain = new Map<number, number>();
  const sameKind = (a: GraphEdge, b: GraphEdge): boolean =>
    a.attrs.cls === b.attrs.cls && a.attrs.width === b.attrs.width && a.isolated === b.isolated;
  const passThrough = (node: number, incoming: number): number | null => {
    const n = graph.nodes[node];
    if (!n || n.edges.length !== 2) return null;
    const next = n.edges[0] === incoming ? n.edges[1] : n.edges[0];
    if (next === undefined || edgeChain.has(next)) return null;
    return sameKind(graph.edges[incoming], graph.edges[next]) ? next : null;
  };

  const startChain = (startEdge: number, startNode: number): void => {
    const nodes = [startNode];
    const edges: number[] = [];
    let edge = startEdge;
    let node = startNode;
    for (;;) {
      edges.push(edge);
      edgeChain.set(edge, chains.length);
      node = graph.other(edge, node);
      nodes.push(node);
      if (node === startNode) break;
      const next = passThrough(node, edge);
      if (next === null) break;
      edge = next;
    }
    const first = graph.edges[startEdge];
    chains.push({
      id: chains.length,
      nodes,
      edges,
      cls: first.attrs.cls,
      width: first.attrs.width,
      lanesPerDirection: first.attrs.lanesPerDirection,
    });
  };

  const isChainBoundary = (node: number): boolean => {
    const n = graph.nodes[node];
    if (!n) return true;
    if (n.edges.length !== 2) return true;
    return !sameKind(graph.edges[n.edges[0]], graph.edges[n.edges[1]]);
  };

  for (let node = 0; node < graph.nodes.length; node++) {
    const n = graph.nodes[node];
    if (!n?.alive || !isChainBoundary(node)) continue;
    for (const e of n.edges) {
      if (!edgeChain.has(e) && graph.edges[e].alive) startChain(e, node);
    }
  }
  // Remaining edges form closed loops of degree-2 nodes.
  for (const e of graph.aliveEdges()) {
    if (!edgeChain.has(e)) startChain(e, graph.edges[e].a);
  }
  return { chains, edgeChain };
}

export type JunctionTrim = Junction['trims'][number];

/** Junction polygons, per-edge trim distances and signal control for nodes of degree ≥ 3. */
export function buildJunctions(graph: PlanarGraph): Junction[] {
  const junctions: Junction[] = [];
  graph.nodes.forEach((node, id) => {
    if (!node.alive || node.edges.length < 3) return;
    const incident = node.edges.map((e) => {
      const edge = graph.edges[e];
      const other = graph.nodes[graph.other(e, id)] as Vec2;
      return { e, edge, dir: normalize(sub(other, node)), half: edge.attrs.width / 2 };
    });
    const trims: JunctionTrim[] = incident.map((inc) => {
      let trim = 0;
      for (const other of incident) {
        if (other === inc) continue;
        const sin = Math.abs(inc.dir.x * other.dir.z - inc.dir.z * other.dir.x);
        trim = Math.max(trim, other.half / Math.max(0.35, sin));
      }
      return { edge: inc.e, distance: Math.min(30, trim) + 1.5 };
    });
    const corners: Vec2[] = [];
    incident.forEach((inc, i) => {
      const t = trims[i].distance;
      const base = add(node, scale(inc.dir, t));
      const side = scale(perpendicular(inc.dir), inc.half);
      corners.push(add(base, side), sub(base, side));
    });
    const polygon: Polygon = convexHull(corners);
    const classes = incident.map((inc) => inc.edge.attrs.cls);
    const major = classes.filter((c) => c === 'arterial' || c === 'ring' || c === 'bridge').length;
    const crossing = incident.some((inc) => inc.edge.attrs.crossing !== null);
    const signalized =
      (node.edges.length >= 4 && major >= 1) || (crossing && node.edges.length >= 3) || major >= 3;
    junctions.push({
      node: id,
      polygon,
      radius: Math.max(...trims.map((t) => t.distance)),
      signalized,
      trims,
    });
  });
  return junctions;
}

/** Trim distance at `node` for edge `edge` (0 if the node is not a junction). */
export function trimAt(junctionByNode: Map<number, Junction>, node: number, edge: number): number {
  const j = junctionByNode.get(node);
  if (!j) return 0;
  return j.trims.find((t) => t.edge === edge)?.distance ?? 0;
}
