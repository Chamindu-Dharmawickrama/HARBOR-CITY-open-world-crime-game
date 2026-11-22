import type { Rng, RngStreams } from '../../core/rng';
import {
  hypot,
  add,
  bounds,
  centroid,
  distance,
  distanceToPolygonEdge,
  insetPolygon,
  minAreaRect,
  normalize,
  orientedRect,
  perpendicular,
  pointInPolygon,
  scale,
  sub,
  type Polygon,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import type { GraphEdge, PlanarGraph } from './planar-graph';
import type {
  Block,
  BuildingSpec,
  CityDef,
  CrossingDef,
  Junction,
  Lot,
  Pier,
  PropSpec,
  PropType,
  SignSpec,
} from './types';

export const SIDEWALK_HEIGHT = 0.15;
/** Height of a billboard face centre above the roof it stands on. */
export const BILLBOARD_FACE_HEIGHT = 4.2;

interface PropSink {
  props: PropSpec[];
  add(type: PropType, x: number, y: number, z: number, rotY: number, variant?: number): void;
}

function sink(): PropSink {
  const props: PropSpec[] = [];
  return {
    props,
    add(type, x, y, z, rotY, variant = 0) {
      props.push({ id: props.length, type, x, y, z, rotY, variant });
    },
  };
}

const facing = (dir: Vec2): number => Math.atan2(dir.x, dir.z);

export function placeProps(
  graph: PlanarGraph,
  junctions: readonly Junction[],
  blocks: readonly Block[],
  lots: readonly Lot[],
  buildings: readonly BuildingSpec[],
  piers: readonly Pier[],
  signs: readonly SignSpec[],
  spurCorridors: readonly Polygon[],
  city: CityDef,
  terrain: TerrainModel,
  rngs: RngStreams,
): PropSpec[] {
  const out = sink();
  const junctionNodes = junctions.map((j) => ({ p: graph.nodes[j.node], r: j.radius }));
  const nearJunction = (p: Vec2, extra: number): boolean =>
    junctionNodes.some(
      (j) =>
        Math.abs(j.p.x - p.x) < j.r + extra &&
        Math.abs(j.p.z - p.z) < j.r + extra &&
        distance(j.p, p) < j.r + extra,
    );
  const inSpur = (p: Vec2): boolean => spurCorridors.some((c) => pointInPolygon(p, c));

  for (const block of blocks) {
    const def = terrain.district(block.district);
    const rng = rngs.get(`props:${def.id}`);
    placeStreetFurniture(out, graph, block, def.props, rng, terrain, nearJunction, inSpur);
    if (block.use === 'park') placePark(out, block, rng, terrain);
    if (block.use === 'plaza') placePlaza(out, block, rng, terrain);
  }
  for (const junction of junctions)
    if (junction.signalized) placeTrafficLights(out, graph, junction, terrain);
  for (const building of buildings) placeRooftop(out, building, rngs.get(`roof:${building.district}`));
  for (const lot of lots) {
    if (lot.use === 'yard') placeContainers(out, lot, rngs.get('containers'), terrain, city);
  }
  for (const pier of piers) placePierProps(out, pier);
  // Rooftop billboard frames (the sign face itself is rendered from the SignSpec).
  for (const sign of signs) {
    if (sign.billboard) out.add('billboard', sign.x, sign.y - BILLBOARD_FACE_HEIGHT, sign.z, sign.rotY, 0);
  }
  return out.props;
}

function placeStreetFurniture(
  out: PropSink,
  graph: PlanarGraph,
  block: Block,
  rules: CityDef['districts'][number]['props'],
  rng: Rng,
  terrain: TerrainModel,
  nearJunction: (p: Vec2, extra: number) => boolean,
  inSpur: (p: Vec2) => boolean,
): void {
  const curb = block.curb;
  let lampCarry = rng.range(0, rules.lampSpacing);
  let hydrantCarry = rng.range(0, rules.hydrantSpacing);
  let treeCarry = rules.treeSpacing > 0 ? rng.range(0, rules.treeSpacing) : 0;
  for (let i = 0; i < curb.length; i++) {
    const a = curb[i];
    const b = curb[(i + 1) % curb.length];
    const len = distance(a, b);
    if (len < 1) continue;
    const dir = normalize(sub(b, a));
    const inward = perpendicular(dir);
    const road = graph.edges[block.curbEdges[i] ?? -1] as GraphEdge | undefined;
    const isMajor = road?.attrs.cls === 'arterial' || road?.attrs.cls === 'ring';
    const walk = (spacing: number, carry: number, inset: number, emit: (p: Vec2) => void): number => {
      let t = carry;
      while (t < len) {
        const p = add(add(a, scale(dir, t)), scale(inward, inset));
        if (!nearJunction(p, 4) && !inSpur(p)) emit(p);
        t += spacing;
      }
      return t - len;
    };
    lampCarry = walk(rules.lampSpacing, lampCarry, 0.6, (p) =>
      out.add('lamp', p.x, terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT, p.z, facing(scale(inward, -1))),
    );
    hydrantCarry = walk(rules.hydrantSpacing, hydrantCarry, 0.7, (p) =>
      out.add('hydrant', p.x, terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT, p.z, facing(inward)),
    );
    const treesHere = rules.treeSpacing > 0 && (block.district === 'linden' || isMajor);
    if (treesHere) {
      treeCarry = walk(rules.treeSpacing, treeCarry, 1.7, (p) =>
        out.add(
          'tree',
          p.x,
          terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT,
          p.z,
          rng.range(0, Math.PI * 2),
          rng.int(0, 3),
        ),
      );
    }
    if (len > 20 && rng.chance(rules.binChance)) {
      const p = add(add(a, scale(dir, Math.min(9, len * 0.3))), scale(inward, 0.8));
      if (!inSpur(p)) out.add('bin', p.x, terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT, p.z, facing(inward));
    }
  }
}

function scatterInside(
  poly: Polygon,
  spacing: number,
  margin: number,
  rng: Rng,
  emit: (p: Vec2) => void,
): void {
  const b = bounds(poly);
  for (let x = b.minX + spacing / 2; x < b.maxX; x += spacing) {
    for (let z = b.minZ + spacing / 2; z < b.maxZ; z += spacing) {
      const p = { x: x + rng.range(-0.35, 0.35) * spacing, z: z + rng.range(-0.35, 0.35) * spacing };
      if (pointInPolygon(p, poly) && distanceToPolygonEdge(p, poly) > margin) emit(p);
    }
  }
}

function placePark(out: PropSink, block: Block, rng: Rng, terrain: TerrainModel): void {
  scatterInside(block.inner, 13, 3, rng, (p) => {
    if (rng.chance(0.75))
      out.add('tree', p.x, terrain.heightAt(p.x, p.z), p.z, rng.range(0, Math.PI * 2), rng.int(0, 3));
  });
  benchesAlong(out, block.inner, 24, 1.2, rng, terrain);
  lampsInside(out, block.inner, 30, terrain, rng);
}

function placePlaza(out: PropSink, block: Block, rng: Rng, terrain: TerrainModel): void {
  benchesAlong(out, block.inner, 16, 2, rng, terrain);
  lampsInside(out, block.inner, 22, terrain, rng);
  const c = centroid(block.inner);
  if (pointInPolygon(c, block.inner)) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const p = { x: c.x + Math.cos(a) * 9, z: c.z + Math.sin(a) * 9 };
      if (pointInPolygon(p, block.inner))
        out.add('tree', p.x, terrain.heightAt(p.x, p.z), p.z, a, rng.int(0, 3));
    }
  }
}

function benchesAlong(
  out: PropSink,
  poly: Polygon,
  spacing: number,
  inset: number,
  rng: Rng,
  terrain: TerrainModel,
): void {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = distance(a, b);
    const dir = normalize(sub(b, a));
    const inward = perpendicular(dir);
    for (let t = spacing / 2 + rng.range(0, 4); t < len - 3; t += spacing) {
      const p = add(add(a, scale(dir, t)), scale(inward, inset));
      out.add('bench', p.x, terrain.heightAt(p.x, p.z), p.z, facing(inward));
    }
  }
}

function lampsInside(out: PropSink, poly: Polygon, spacing: number, terrain: TerrainModel, rng: Rng): void {
  const inner = insetPolygon(poly, 2) ?? poly;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    const len = distance(a, b);
    const dir = normalize(sub(b, a));
    for (let t = rng.range(2, spacing / 2); t < len; t += spacing) {
      const p = add(a, scale(dir, t));
      out.add('lamp', p.x, terrain.heightAt(p.x, p.z), p.z, facing(perpendicular(dir)));
    }
  }
}

function placeTrafficLights(
  out: PropSink,
  graph: PlanarGraph,
  junction: Junction,
  terrain: TerrainModel,
): void {
  const node = graph.nodes[junction.node] as Vec2;
  for (const trim of junction.trims) {
    const edge = graph.edges[trim.edge];
    if (edge.isolated) continue;
    const other = graph.nodes[graph.other(trim.edge, junction.node)] as Vec2;
    const d = normalize(sub(other, node));
    // Traffic approaching from this edge travels along -d; its kerb is on the right of -d.
    const right = perpendicular(scale(d, -1));
    const p = add(add(node, scale(d, trim.distance + 0.8)), scale(right, edge.attrs.width / 2 + 1));
    out.add('trafficLight', p.x, terrain.heightAt(p.x, p.z) + SIDEWALK_HEIGHT, p.z, facing(d));
  }
}

function placeRooftop(out: PropSink, building: BuildingSpec, rng: Rng): void {
  if (building.roof !== 'flat' || building.style === 'house') return;
  const top = building.tiers[building.tiers.length - 1];
  const usable = insetPolygon(top.footprint, 2.5);
  if (!usable) return;
  const y = building.baseY + top.top;
  const box = minAreaRect(usable);
  const count = Math.min(6, Math.floor((box.halfLength * box.halfWidth * 4) / 140));
  for (let i = 0; i < count; i++) {
    const p = add(
      add(box.center, scale(box.axis, rng.range(-1, 1) * box.halfLength * 0.8)),
      scale(perpendicular(box.axis), rng.range(-1, 1) * box.halfWidth * 0.8),
    );
    if (pointInPolygon(p, usable)) out.add('acUnit', p.x, y, p.z, facing(box.axis), rng.int(0, 2));
  }
  if (
    (building.style === 'brick' || building.style === 'office') &&
    building.height < 60 &&
    rng.chance(0.35)
  ) {
    out.add('waterTank', box.center.x, y, box.center.z, rng.range(0, Math.PI), 0);
  }
}

function placeContainers(out: PropSink, lot: Lot, rng: Rng, terrain: TerrainModel, city: CityDef): void {
  const box = minAreaRect(lot.polygon);
  const usable = insetPolygon(lot.polygon, 4);
  if (!usable || box.halfLength < 14 || box.halfWidth < 8) return;
  const y = terrain.heightAt(box.center.x, box.center.z);
  const across = perpendicular(box.axis);
  const rowPitch = 3.2;
  const colPitch = 13;
  for (let u = -box.halfLength + 8; u < box.halfLength - 7; u += colPitch) {
    for (let v = -box.halfWidth + 3; v < box.halfWidth - 2.5; v += rowPitch) {
      if (rng.chance(0.18)) continue;
      const p = add(add(box.center, scale(box.axis, u)), scale(across, v));
      if (!pointInPolygon(p, usable)) continue;
      const stack = rng.int(1, 4);
      for (let s = 0; s < stack; s++)
        out.add('container', p.x, y + s * 2.6, p.z, facing(box.axis), rng.int(0, 6));
    }
  }
  if (rng.chance(0.4)) {
    const d = Math.min(
      ...city.districts
        .filter((dd) => dd.id === 'gantry')
        .map((dd) => hypot(box.center.x - dd.island.center[0], box.center.z - dd.island.center[1])),
    );
    if (d > 200) out.add('crane', box.center.x, y, box.center.z, facing(box.axis), 0);
  }
}

function placePierProps(out: PropSink, pier: Pier): void {
  const box = minAreaRect(pier.polygon);
  const across = perpendicular(box.axis);
  for (const side of [-1, 1]) {
    for (let u = -box.halfLength + 4; u < box.halfLength - 2; u += 12) {
      const p = add(add(box.center, scale(box.axis, u)), scale(across, side * (box.halfWidth - 0.8)));
      out.add('bollard', p.x, pier.y, p.z, 0, 0);
    }
  }
}

/** Piers jut from the docks coastline away from the island centre, clear of the crossings. */
export function placePiers(
  coast: Polygon,
  center: Vec2,
  crossings: readonly CrossingDef[],
  baseHeight: number,
  rng: Rng,
  count: number,
): Pier[] {
  const piers: Pier[] = [];
  const n = coast.length;
  const avoid = crossings.flatMap((c) => [
    { x: c.a[0], z: c.a[1] },
    { x: c.b[0], z: c.b[1] },
    { x: (c.a[0] + c.b[0]) / 2, z: (c.a[1] + c.b[1]) / 2 },
  ]);
  let attempts = 0;
  while (piers.length < count && attempts++ < count * 40) {
    const i = rng.int(0, n);
    const a = coast[i];
    const b = coast[(i + 1) % n];
    const p = scale(add(a, b), 0.5);
    const outward = normalize(sub(p, center));
    // Only the south and west shores (open water away from the other islands).
    if (outward.z < 0.25 && outward.x > -0.4) continue;
    if (avoid.some((q) => distance(q, p) < 180)) continue;
    if (piers.some((other) => distance(centroid(other.polygon), p) < 110)) continue;
    const length = rng.range(70, 110);
    const halfWidth = rng.range(9, 12);
    const start = sub(p, scale(outward, 6));
    const mid = add(start, scale(outward, length / 2));
    piers.push({ polygon: orientedRect(mid, outward, length / 2, halfWidth), y: baseHeight });
  }
  return piers;
}
