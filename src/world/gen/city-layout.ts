import { Hasher } from '../../core/hash';
import { RngStreams } from '../../core/rng';
import { buildBlocks } from './blocks';
import { buildBuildings } from './buildings';
import type { Vec2 } from './geometry2d';
import { islandShape, TerrainModel } from './islands';
import { buildLaneGraph, buildSidewalkGraph } from './nav';
import type { GraphEdge, GraphNode, PlanarGraph } from './planar-graph';
import { placePiers, placeProps } from './props';
import { buildRoadNetwork } from './road-network';
import { buildChains, buildJunctions } from './road-topology';
import type { CityDef, CityLayout, Pier, RoadEdge, RoadNode } from './types';

/** Everything derived from (city definition, seed). Deterministic; safe to run in a worker. */
export interface CityModel {
  layout: CityLayout;
  terrain: TerrainModel;
  graph: PlanarGraph;
}

export function generateCity(city: CityDef, seed: number): CityModel {
  const rngs = new RngStreams(seed);
  const islands = city.districts.map((d) => islandShape(d, seed));
  const terrain = new TerrainModel(city, islands, seed);
  const network = buildRoadNetwork(city, islands, terrain, rngs);
  const graph = network.graph.compacted();
  const { chains } = buildChains(graph);
  const junctions = buildJunctions(graph);
  const { blocks, lots, spurCorridors, failedBlocks } = buildBlocks(graph, terrain, network.holes, rngs);
  const { buildings, signs } = buildBuildings(lots, blocks, city, terrain, rngs);

  const piers: Pier[] = [];
  const docks = city.districts.find((d) => d.id === 'gantry');
  const docksIsland = islands.find((i) => i.district === 'gantry');
  if (docks && docksIsland) {
    const center: Vec2 = { x: docks.island.center[0], z: docks.island.center[1] };
    piers.push(
      ...placePiers(docksIsland.coast, center, city.crossings, docks.island.baseHeight, rngs.get('piers'), 6),
    );
  }
  const props = placeProps(
    graph,
    junctions,
    blocks,
    lots,
    buildings,
    piers,
    signs,
    spurCorridors,
    city,
    terrain,
    rngs,
  );
  const { lanes, laneNodes } = buildLaneGraph(graph, chains, junctions);
  const sidewalks = buildSidewalkGraph(graph, blocks, junctions, terrain);

  const nodes: RoadNode[] = graph.nodes.map((n: GraphNode, id) => ({
    id,
    x: n.x,
    z: n.z,
    y: n.y,
    edges: [...n.edges],
  }));
  const edges: RoadEdge[] = graph.edges.map((e: GraphEdge, id) => ({ id, a: e.a, b: e.b, ...e.attrs }));
  const layout: CityLayout = {
    seed,
    islands,
    nodes,
    edges,
    chains,
    junctions,
    blocks,
    lots,
    buildings,
    props,
    signs,
    holes: network.holes,
    piers,
    lanes,
    laneNodes,
    sidewalks,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      chains: chains.length,
      junctions: junctions.length,
      signalized: junctions.filter((j) => j.signalized).length,
      blocks: blocks.length,
      failedBlocks,
      lots: lots.length,
      buildings: buildings.length,
      props: props.length,
      signs: signs.length,
      lanes: lanes.length,
      sidewalkNodes: sidewalks.length,
    },
  };
  return { layout, terrain, graph };
}

/** Stable fingerprint of a generated layout (determinism checks across runs and machines). */
export function layoutHash(layout: CityLayout): string {
  const h = new Hasher();
  for (const n of layout.nodes) h.addFloat(n.x).addFloat(n.z).addFloat(n.y, 1e-3);
  for (const e of layout.edges) h.addInt(e.a).addInt(e.b).addString(e.cls);
  for (const b of layout.buildings) {
    h.addFloat(b.height).addInt(b.seed).addString(b.style);
    for (const p of b.tiers[0]?.footprint ?? []) h.addFloat(p.x).addFloat(p.z);
  }
  for (const p of layout.props) h.addString(p.type).addFloat(p.x).addFloat(p.z);
  h.addInt(layout.lanes.length).addInt(layout.sidewalks.length);
  return h.hex();
}

/** Hash of each generation stage, to locate where two runs diverge. */
export function layoutStageHashes(layout: CityLayout): Record<string, string> {
  const coast = new Hasher();
  for (const i of layout.islands) for (const p of i.coast) coast.addFloat(p.x, 1e-6).addFloat(p.z, 1e-6);
  const roads = new Hasher();
  for (const n of layout.nodes) roads.addFloat(n.x, 1e-6).addFloat(n.z, 1e-6);
  const blocks = new Hasher();
  for (const b of layout.blocks) {
    blocks.addString(b.use);
    for (const p of b.curb) blocks.addFloat(p.x, 1e-6).addFloat(p.z, 1e-6);
    for (const p of b.inner) blocks.addFloat(p.x, 1e-6).addFloat(p.z, 1e-6);
  }
  const lots = new Hasher();
  for (const l of layout.lots) {
    lots.addString(l.use);
    for (const p of l.polygon) lots.addFloat(p.x, 1e-6).addFloat(p.z, 1e-6);
  }
  const buildings = new Hasher();
  for (const b of layout.buildings) buildings.addFloat(b.height, 1e-6).addInt(b.seed);
  const props = new Hasher();
  for (const p of layout.props) props.addFloat(p.x, 1e-6).addFloat(p.z, 1e-6);
  return {
    coast: coast.hex(),
    roads: roads.hex(),
    blocks: blocks.hex(),
    lots: lots.hex(),
    buildings: buildings.hex(),
    props: props.hex(),
  };
}
