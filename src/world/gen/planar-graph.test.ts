import { describe, expect, it } from 'vitest';
import { v2 } from './geometry2d';
import { PlanarGraph, removeSpikes, type EdgeAttrs } from './planar-graph';

const street: EdgeAttrs = {
  cls: 'street',
  lanesPerDirection: 1,
  width: 8,
  speedLimit: 11,
  district: null,
  arch: 0,
  crossing: null,
};

function grid(n: number, size: number): PlanarGraph {
  const g = new PlanarGraph(0.5);
  for (let i = 0; i <= n; i++) {
    g.addSegment(v2(i * size, 0), v2(i * size, n * size), street);
    g.addSegment(v2(0, i * size), v2(n * size, i * size), street);
  }
  return g;
}

describe('PlanarGraph', () => {
  it('splits crossing segments into a proper grid', () => {
    const g = grid(2, 100);
    const alive = g.aliveEdges();
    expect(alive).toHaveLength(12);
    expect(g.nodes.filter((n) => n.alive)).toHaveLength(9);
    const centre = g.findNode(100, 100, 0.1);
    expect(g.degree(centre)).toBe(4);
  });

  it('extracts interior faces counter-clockwise, dropping the outer face', () => {
    const faces = grid(2, 100).faces(() => true);
    expect(faces).toHaveLength(4);
    for (const f of faces) {
      expect(f.area).toBeCloseTo(10_000);
      expect(f.nodes).toHaveLength(4);
      expect(f.edges).toHaveLength(4);
    }
  });

  it('snaps endpoints onto existing edges (T-junctions)', () => {
    const g = new PlanarGraph(1);
    g.addSegment(v2(0, 0), v2(100, 0), street);
    g.addSegment(v2(50, 0.4), v2(50, 80), street);
    const t = g.findNode(50, 0, 1);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(g.degree(t)).toBe(3);
  });

  it('does not duplicate edges when the same segment is added twice', () => {
    const g = new PlanarGraph(1);
    g.addSegment(v2(0, 0), v2(10, 0), street);
    g.addSegment(v2(0, 0), v2(10, 0), street);
    expect(g.aliveEdges()).toHaveLength(1);
  });

  it('removes dead-end spikes from face outlines', () => {
    const g = grid(1, 100);
    g.addSegment(v2(0, 50), v2(40, 50), street);
    const faces = g.faces(() => true);
    expect(faces).toHaveLength(1);
    expect(faces[0]?.area).toBeCloseTo(10_000);
    expect(new Set(faces[0]?.nodes).size).toBe(faces[0]?.nodes.length);
  });

  it('prunes short dead ends repeatedly', () => {
    const g = grid(1, 100);
    g.addSegment(v2(100, 100), v2(103, 100), street);
    g.addSegment(v2(103, 100), v2(105, 100), street);
    expect(g.pruneShortDeadEnds(4)).toBe(2);
    expect(g.aliveEdges()).toHaveLength(4);
  });

  it('isolated edges neither split nor appear in faces', () => {
    const g = grid(1, 100);
    const a = g.createNode(-50, 50);
    const b = g.createNode(150, 50);
    g.connect(a, b, { ...street, cls: 'tunnel' }, true);
    expect(g.faces(() => true)).toHaveLength(1);
    expect(g.aliveEdges()).toHaveLength(5);
  });

  it('subdivides long edges', () => {
    const g = new PlanarGraph(1);
    g.addSegment(v2(0, 0), v2(100, 0), street);
    g.subdivideLongEdges(30);
    const lengths = g.aliveEdges().map((e) => g.edgeLength(e));
    expect(lengths).toHaveLength(4);
    for (const l of lengths) expect(l).toBeCloseTo(25);
  });
});

describe('removeSpikes', () => {
  it('drops an out-and-back segment and keeps the onward edge', () => {
    // A(e0)→B(e1)→X(e1)→B(e2)→C(e3)→A
    const out = removeSpikes([0, 1, 9, 1, 2], [10, 11, 11, 12, 13]);
    expect(out.nodes).toEqual([0, 1, 2]);
    expect(out.edges).toEqual([10, 12, 13]);
  });
});
