import { describe, expect, it } from 'vitest';
import { Rng } from '../../core/rng';
import {
  area,
  bounds,
  centroid,
  clipPolygonConvex,
  convexHull,
  convexPolygonsOverlap,
  distanceToPolygonEdge,
  ensureCCW,
  insetPolygon,
  insetPolygonRobust,
  isConvex,
  isSelfIntersecting,
  lineIntersection,
  minAreaRect,
  orientedRect,
  pointInPolygon,
  pointSegmentDistance,
  rectPolygon,
  resamplePolyline,
  segmentIntersection,
  signedArea,
  simplifyPolygon,
  splitConvex,
  subtractConvex,
  triangulate,
  v2,
  type Polygon,
  type Vec2,
} from './geometry2d';
import { Noise2D } from './noise';

const square = (s: number): Polygon => rectPolygon(0, 0, s, s);

function triangulatedArea(poly: Polygon, tris: number[]): number {
  let total = 0;
  for (let i = 0; i < tris.length; i += 3) {
    total += area([poly[tris[i]], poly[tris[i + 1]], poly[tris[i + 2]]]);
  }
  return total;
}

describe('basic polygon measures', () => {
  it('area, orientation, centroid, bounds', () => {
    const sq = square(10);
    expect(signedArea(sq)).toBeCloseTo(100);
    expect(signedArea([...sq].reverse())).toBeCloseTo(-100);
    expect(centroid(sq)).toEqual({ x: 5, z: 5 });
    expect(bounds(sq)).toEqual({ minX: 0, minZ: 0, maxX: 10, maxZ: 10 });
    expect(signedArea(ensureCCW([...sq].reverse()))).toBeGreaterThan(0);
    expect(ensureCCW(sq)).toBe(sq);
  });

  it('point in polygon handles concave shapes', () => {
    const l: Polygon = ensureCCW([v2(0, 0), v2(10, 0), v2(10, 4), v2(4, 4), v2(4, 10), v2(0, 10)]);
    expect(pointInPolygon(v2(2, 8), l)).toBe(true);
    expect(pointInPolygon(v2(8, 8), l)).toBe(false);
    expect(pointInPolygon(v2(8, 2), l)).toBe(true);
    expect(distanceToPolygonEdge(v2(2, 2), l)).toBeCloseTo(2);
  });

  it('segment and line intersection', () => {
    const hit = segmentIntersection(v2(0, 0), v2(10, 0), v2(5, -5), v2(5, 5));
    expect(hit?.point).toEqual({ x: 5, z: 0 });
    expect(hit?.t).toBeCloseTo(0.5);
    expect(segmentIntersection(v2(0, 0), v2(1, 0), v2(2, -1), v2(2, 1))).toBeNull();
    expect(segmentIntersection(v2(0, 0), v2(1, 0), v2(0, 1), v2(1, 1))).toBeNull();
    expect(lineIntersection(v2(0, 0), v2(1, 0), v2(2, -1), v2(2, 1))).toEqual({ x: 2, z: 0 });
    expect(pointSegmentDistance(v2(5, 3), v2(0, 0), v2(10, 0))).toEqual({ distance: 3, t: 0.5 });
  });
});

describe('clipping', () => {
  it('clips a polygon by a convex window', () => {
    const clipped = clipPolygonConvex(square(10), rectPolygon(5, 5, 20, 20));
    expect(area(clipped)).toBeCloseTo(25);
  });

  it('clips concave subjects', () => {
    const u: Polygon = ensureCCW([
      v2(0, 0),
      v2(9, 0),
      v2(9, 9),
      v2(6, 9),
      v2(6, 3),
      v2(3, 3),
      v2(3, 9),
      v2(0, 9),
    ]);
    const clipped = clipPolygonConvex(u, rectPolygon(0, 0, 9, 6));
    expect(area(clipped)).toBeCloseTo(9 * 6 - 3 * 3);
  });

  it('subtractConvex produces disjoint pieces summing to the difference', () => {
    const pieces = subtractConvex(square(10), rectPolygon(3, 3, 6, 6));
    const total = pieces.reduce((s, p) => s + area(p), 0);
    expect(total).toBeCloseTo(100 - 9);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        expect(convexPolygonsOverlap(pieces[i], pieces[j])).toBe(false);
      }
    }
    expect(subtractConvex(square(2), rectPolygon(-5, -5, 5, 5))).toEqual([]);
    expect(
      subtractConvex(square(2), rectPolygon(10, 10, 12, 12)).reduce((s, p) => s + area(p), 0),
    ).toBeCloseTo(4);
  });

  it('splitConvex splits area exactly', () => {
    const [a, b] = splitConvex(square(10), v2(4, 0), v2(0, 1));
    expect(area(a) + area(b)).toBeCloseTo(100);
    expect(Math.min(area(a), area(b))).toBeCloseTo(40);
  });
});

describe('inset', () => {
  it('insets a square uniformly', () => {
    const inset = insetPolygon(square(10), 2);
    expect(inset).not.toBeNull();
    expect(area(inset!)).toBeCloseTo(36);
  });

  it('supports per-edge distances', () => {
    const inset = insetPolygon(square(10), [1, 2, 3, 4]);
    expect(area(inset!)).toBeCloseTo((10 - 2 - 4) * (10 - 1 - 3));
  });

  it('robust inset drops collapsing edges instead of failing', () => {
    // A 4.2 m chamfer between two 135° corners shrinks by ~5 m when inset by 6 m and inverts.
    const chamfered = ensureCCW([v2(0, 0), v2(100, 0), v2(100, 97), v2(97, 100), v2(0, 100)]);
    expect(insetPolygon(chamfered, 6)).toBeNull();
    const robust = insetPolygonRobust(chamfered, 6);
    expect(robust).not.toBeNull();
    expect(robust!.polygon).toHaveLength(4);
    expect(area(robust!.polygon)).toBeCloseTo(88 * 88, 0);
    expect(robust!.sourceEdges).toHaveLength(4);
    expect(insetPolygonRobust(square(10), 6)).toBeNull();
    const plain = insetPolygonRobust(square(10), [1, 2, 3, 4]);
    expect(plain!.sourceEdges).toEqual([0, 1, 2, 3]);
    expect(area(plain!.polygon)).toBeCloseTo(24);
  });

  it('rejects insets that would invert the polygon', () => {
    expect(insetPolygon(square(10), 6)).toBeNull();
    expect(insetPolygon([v2(0, 0), v2(1, 0)], 0.1)).toBeNull();
  });
});

describe('hull, OBB, convexity, simplify', () => {
  it('convex hull of random points contains all points', () => {
    const rng = new Rng(4);
    const pts: Vec2[] = Array.from({ length: 200 }, () => v2(rng.range(-50, 50), rng.range(-50, 50)));
    const hull = convexHull(pts);
    expect(isConvex(hull)).toBe(true);
    expect(signedArea(hull)).toBeGreaterThan(0);
    for (const p of pts) expect(pointInPolygon(p, hull) || distanceToPolygonEdge(p, hull) < 1e-6).toBe(true);
  });

  it('minAreaRect recovers a rotated rectangle', () => {
    const rect = orientedRect(v2(10, 20), v2(Math.cos(0.4), Math.sin(0.4)), 8, 3);
    const obb = minAreaRect(rect);
    expect(obb.halfLength).toBeCloseTo(8);
    expect(obb.halfWidth).toBeCloseTo(3);
    expect(obb.center.x).toBeCloseTo(10);
    expect(Math.abs(obb.axis.x * Math.cos(0.4) + obb.axis.z * Math.sin(0.4))).toBeCloseTo(1);
  });

  it('detects convexity and self-intersection', () => {
    expect(isConvex(square(3))).toBe(true);
    expect(isConvex(ensureCCW([v2(0, 0), v2(4, 0), v2(2, 1), v2(4, 4), v2(0, 4)]))).toBe(false);
    expect(isSelfIntersecting([v2(0, 0), v2(4, 4), v2(4, 0), v2(0, 4)])).toBe(true);
    expect(isSelfIntersecting(square(4))).toBe(false);
  });

  it('simplify removes duplicates and collinear points', () => {
    const p = simplifyPolygon([v2(0, 0), v2(5, 0), v2(5, 0), v2(10, 0), v2(10, 10), v2(0, 10), v2(0, 0)]);
    expect(p).toHaveLength(4);
  });
});

describe('triangulate', () => {
  it('triangulates convex and concave polygons with exact area', () => {
    const sq = square(10);
    expect(triangulatedArea(sq, triangulate(sq))).toBeCloseTo(100);
    const l: Polygon = ensureCCW([v2(0, 0), v2(10, 0), v2(10, 4), v2(4, 4), v2(4, 10), v2(0, 10)]);
    const tris = triangulate(l);
    expect(tris.length / 3).toBe(4);
    expect(triangulatedArea(l, tris)).toBeCloseTo(area(l));
  });

  it('handles clockwise input and returns CCW triangles', () => {
    const cw = [...square(4)].reverse();
    const tris = triangulate(cw);
    for (let i = 0; i < tris.length; i += 3) {
      expect(signedArea([cw[tris[i]], cw[tris[i + 1]], cw[tris[i + 2]]])).toBeGreaterThan(0);
    }
  });

  it('triangulates a noisy star polygon fully', () => {
    const rng = new Rng(9);
    const poly: Polygon = [];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const r = 20 + rng.range(-6, 6);
      poly.push(v2(Math.cos(a) * r, Math.sin(a) * r));
    }
    const tris = triangulate(poly);
    expect(tris.length / 3).toBe(58);
    expect(triangulatedArea(poly, tris)).toBeCloseTo(area(poly), 4);
  });
});

describe('polyline resampling', () => {
  it('places points at roughly even spacing', () => {
    const pts = resamplePolyline([v2(0, 0), v2(10, 0), v2(10, 10)], 2.5);
    expect(pts[0]).toEqual({ x: 0, z: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 10, z: 10 });
    expect(pts.length).toBe(9);
  });
});

describe('Noise2D', () => {
  it('is deterministic, bounded and continuous', () => {
    const a = new Noise2D(5);
    const b = new Noise2D(5);
    const c = new Noise2D(6);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.137;
      const z = i * 0.071;
      const v = a.sample(x, z);
      expect(v).toBe(b.sample(x, z));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      expect(Math.abs(a.sample(x + 0.001, z) - v)).toBeLessThan(0.01);
      diff += Math.abs(v - c.sample(x, z));
    }
    expect(diff).toBeGreaterThan(1);
    expect(a.sample(3, 7)).toBeCloseTo(0);
    expect(Math.abs(a.fbm(1.3, 2.7, 5))).toBeLessThan(1);
  });
});
