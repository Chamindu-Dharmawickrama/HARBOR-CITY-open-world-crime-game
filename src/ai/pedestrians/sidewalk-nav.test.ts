import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { generateCity, type CityModel } from '../../world/gen/city-layout';
import { LaneNetwork } from '../traffic/lane-network';
import { POI_KINDS, SidewalkNav } from './sidewalk-nav';

let model: CityModel;
let nav: SidewalkNav;

beforeAll(() => {
  model = generateCity(CITY, 74613);
  const net = new LaneNetwork(model.layout);
  nav = new SidewalkNav(model.layout, (x, z) => model.terrain.districtAt(x, z), net.internalEdges);
});

describe('sidewalk navigation', () => {
  it('routes along sidewalk links and across crosswalks', () => {
    const a = nav.nearest(560, 430, 80);
    const b = nav.nearest(760, 230, 120);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    const path: number[] = [];
    expect(nav.findPath(a, b, path)).toBe(true);
    expect(path[0]).toBe(a);
    expect(path[path.length - 1]).toBe(b);
    let crossings = 0;
    for (let i = 1; i < path.length; i++) {
      expect(nav.links[path[i - 1]]).toContain(path[i]);
      expect(nav.distance(path[i - 1], path[i])).toBeLessThan(40);
      if (nav.crossing(path[i - 1], path[i]) >= 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it('finds places of every kind to walk to', () => {
    for (const kind of POI_KINDS) expect(nav.poisByKind.get(kind)?.length ?? 0).toBeGreaterThan(5);
    const docks = (nav.poisByKind.get('dock') ?? []).map((i) => nav.pois[i].node);
    expect(docks.filter((n) => nav.district[n] === 'gantry').length / docks.length).toBeGreaterThan(0.8);
  });

  it('has signalled and unsignalled crosswalks and no crossings over internal junction links', () => {
    expect(nav.crosswalks.some((c) => c.signalized)).toBe(true);
    expect(nav.crosswalks.some((c) => !c.signalized)).toBe(true);
    const net = new LaneNetwork(model.layout);
    for (const c of nav.crosswalks) {
      if (net.internalEdges.has(c.edge)) expect(nav.links[c.a]).not.toContain(c.b);
    }
  });

  it('gives up on impossible routes within the expansion budget', () => {
    const island = nav.nearest(-900, 700, 400);
    const far = nav.nearest(900, -600, 400);
    const path: number[] = [];
    const found = nav.findPath(island, far, path, 50);
    expect(found).toBe(false);
    expect(path).toHaveLength(0);
  });
});
