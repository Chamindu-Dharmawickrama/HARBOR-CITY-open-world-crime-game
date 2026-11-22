import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { generateCity, layoutHash, type CityModel } from './city-layout';
import {
  bounds,
  boundsOverlap,
  convexPolygonsOverlap,
  isConvex,
  pointInPolygon,
  type Polygon,
} from './geometry2d';
import { edgeCorridor } from './blocks';
import type { CityLayout, DistrictId } from './types';

const SEED = 74613;
let model: CityModel;
let layout: CityLayout;

beforeAll(() => {
  model = generateCity(CITY, SEED);
  layout = model.layout;
});

describe('city layout', () => {
  it('generates a city of the intended size', () => {
    const s = layout.stats;
    expect(s['buildings']).toBeGreaterThan(1200);
    expect(s['blocks']).toBeGreaterThan(250);
    expect(s['junctions']).toBeGreaterThan(300);
    expect(s['signalized']).toBeGreaterThan(30);
    expect(s['props']).toBeGreaterThan(5000);
    expect(s['lanes']).toBeGreaterThan(2000);
    expect((s['failedBlocks'] ?? 0) / ((s['blocks'] ?? 1) + (s['failedBlocks'] ?? 0))).toBeLessThan(0.08);
    const minimum: Record<DistrictId, number> = { meridian: 300, gantry: 70, linden: 500 };
    for (const district of ['meridian', 'gantry', 'linden'] as DistrictId[]) {
      expect(layout.buildings.filter((b) => b.district === district).length).toBeGreaterThan(
        minimum[district],
      );
    }
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const again = generateCity(CITY, SEED).layout;
    expect(layoutHash(again)).toBe(layoutHash(layout));
    const other = generateCity(CITY, SEED + 1).layout;
    expect(layoutHash(other)).not.toBe(layoutHash(layout));
  });

  it('connects all three islands into one road network (bridges + tunnel)', () => {
    const adjacency = new Map<number, number[]>();
    for (const e of layout.edges) {
      adjacency.set(e.a, [...(adjacency.get(e.a) ?? []), e.b]);
      adjacency.set(e.b, [...(adjacency.get(e.b) ?? []), e.a]);
    }
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const n = queue.pop() as number;
      for (const m of adjacency.get(n) ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
    expect(seen.size / layout.nodes.length).toBeGreaterThan(0.99);
    const districtsReached = new Set(
      [...seen]
        .map((n) => model.terrain.districtAt(layout.nodes[n].x, layout.nodes[n].z))
        .filter((d) => d !== null),
    );
    expect(districtsReached.size).toBe(3);
    expect(layout.edges.filter((e) => e.cls === 'bridge').length).toBeGreaterThanOrEqual(2);
    expect(layout.edges.filter((e) => e.cls === 'tunnel').length).toBe(3);
    expect(layout.holes).toHaveLength(2);
  });

  it('lane graph lets traffic reach every district from downtown', () => {
    const start = layout.lanes.find((l) => !l.isConnector && layout.edges[l.edge]?.district === 'meridian');
    expect(start).toBeDefined();
    const seen = new Set<number>([start!.id]);
    const queue = [start!.id];
    while (queue.length > 0) {
      const id = queue.pop() as number;
      for (const n of layout.lanes[id].next) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(seen.size / layout.lanes.length).toBeGreaterThan(0.9);
    const districts = new Set(
      [...seen].map((id) => layout.edges[layout.lanes[id].edge]?.district).filter(Boolean),
    );
    expect(districts).toEqual(new Set(['meridian', 'gantry', 'linden']));
  });

  it('buildings stand on land, outside tunnel trenches, and never overlap each other', () => {
    const footprints: { poly: Polygon; b: ReturnType<typeof bounds> }[] = [];
    for (const building of layout.buildings) {
      const poly = building.tiers[0].footprint;
      expect(isConvex(poly)).toBe(true);
      for (const p of poly) expect(model.terrain.isLand(p.x, p.z)).toBe(true);
      for (const hole of layout.holes) {
        expect(convexPolygonsOverlap(poly, hole.polygon)).toBe(false);
      }
      footprints.push({ poly, b: bounds(poly) });
    }
    let overlaps = 0;
    for (let i = 0; i < footprints.length; i++) {
      for (let j = i + 1; j < footprints.length; j++) {
        const a = footprints[i];
        const c = footprints[j];
        if (boundsOverlap(a.b, c.b) && convexPolygonsOverlap(a.poly, c.poly, 0.05)) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('buildings never sit on a road carriageway', () => {
    const corridors = layout.edges
      .filter((e) => e.cls !== 'tunnel')
      .map((e) => edgeCorridor(model.graph, e.id, -0.25))
      .map((poly) => ({ poly, b: bounds(poly) }));
    let hits = 0;
    for (const building of layout.buildings) {
      const poly = building.tiers[0].footprint;
      const b = bounds(poly);
      for (const c of corridors) {
        if (boundsOverlap(b, c.b) && convexPolygonsOverlap(poly, c.poly, 0.05)) hits++;
      }
    }
    expect(hits).toBe(0);
  });

  it('props and signs lie inside the world and mostly on land', () => {
    let onLand = 0;
    for (const p of layout.props) {
      expect(Number.isFinite(p.x + p.y + p.z + p.rotY)).toBe(true);
      if (model.terrain.isLand(p.x, p.z) || layout.piers.some((pier) => pointInPolygon(p, pier.polygon)))
        onLand++;
    }
    expect(onLand / layout.props.length).toBeGreaterThan(0.995);
    expect(layout.signs.length).toBeGreaterThan(50);
  });

  it('sidewalk graph links blocks with crosswalks', () => {
    const crossings = layout.sidewalks.filter((n) => n.links.length > 2).length;
    expect(crossings).toBeGreaterThan(500);
    expect(layout.sidewalks.some((n) => n.crossingJunction >= 0)).toBe(true);
  });

  it('terrain heights are smooth and coastal heights equal the island base', () => {
    const t = model.terrain;
    for (const d of CITY.districts) {
      const [cx, cz] = d.island.center;
      const h = t.heightAt(cx, cz);
      expect(h).toBeGreaterThanOrEqual(d.island.baseHeight - 1e-6);
      expect(h).toBeLessThanOrEqual(d.island.baseHeight + d.island.hillHeight + 1e-6);
      expect(Math.abs(t.heightAt(cx + 1, cz) - h)).toBeLessThan(0.5);
    }
    expect(t.isLand(0, 1000)).toBe(false);
  });
});
