/**
 * Pure 2D geometry on the XZ plane (x = east, z = south). Polygons are arrays of points in
 * counter-clockwise order when viewed from above with +x right and -z up, which in these
 * coordinates means POSITIVE signed area via `signedArea` (shoelace in x/z).
 */

export interface Vec2 {
  x: number;
  z: number;
}

export type Polygon = Vec2[];

export const EPSILON = 1e-9;

/**
 * Euclidean length via sqrt. Math.hypot is not required to round identically across JS engines
 * (or engine versions); sqrt is correctly rounded everywhere, which keeps generation deterministic
 * between the main thread, workers, Node tests and other browsers.
 */
export function hypot(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** Rounds a coordinate to a fixed grid (absorbs last-bit float differences between engines). */
export function quantize(value: number, step = 1e-5): number {
  return Math.round(value / step) * step;
}

export function quantizePolygon(poly: readonly Vec2[], step = 1e-5): Polygon {
  return poly.map((p) => ({ x: quantize(p.x, step), z: quantize(p.z, step) }));
}

export function v2(x: number, z: number): Vec2 {
  return { x, z };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, z: a.z * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

/** 2D cross product (z-component of the 3D cross of (x, 0, z) vectors, sign per shoelace). */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.z - a.z * b.x;
}

export function length(a: Vec2): number {
  return hypot(a.x, a.z);
}

export function distance(a: Vec2, b: Vec2): number {
  return hypot(a.x - b.x, a.z - b.z);
}

export function normalize(a: Vec2): Vec2 {
  const len = hypot(a.x, a.z);
  return len < EPSILON ? { x: 0, z: 0 } : { x: a.x / len, z: a.z / len };
}

/** Left-hand perpendicular in shoelace orientation (rotate +90°: (x, z) → (-z, x)). */
export function perpendicular(a: Vec2): Vec2 {
  return { x: -a.z, z: a.x };
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

export function rotate(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.z * s, z: a.x * s + a.z * c };
}

/** Shoelace signed area (positive = counter-clockwise in this module's convention). */
export function signedArea(poly: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

export function area(poly: readonly Vec2[]): number {
  return Math.abs(signedArea(poly));
}

export function ensureCCW(poly: Polygon): Polygon {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function centroid(poly: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cz = 0;
  let a2 = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j];
    const q = poly[i];
    const f = p.x * q.z - q.x * p.z;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
    a2 += f;
  }
  if (Math.abs(a2) < EPSILON) {
    let sx = 0;
    let sz = 0;
    for (const p of poly) {
      sx += p.x;
      sz += p.z;
    }
    return { x: sx / Math.max(1, poly.length), z: sz / Math.max(1, poly.length) };
  }
  return { x: cx / (3 * a2), z: cz / (3 * a2) };
}

export function perimeter(poly: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) total += distance(poly[j], poly[i]);
  return total;
}

export interface Bounds2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function bounds(points: readonly Vec2[]): Bounds2 {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function boundsOverlap(a: Bounds2, b: Bounds2, margin = 0): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX - margin <= a.maxX &&
    a.minZ - margin <= b.maxZ &&
    b.minZ - margin <= a.maxZ
  );
}

/** Even–odd point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Closest distance from p to segment ab, and the parameter t of the closest point. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): { distance: number; t: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 < EPSILON ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2));
  return { distance: hypot(a.x + abx * t - p.x, a.z + abz * t - p.z), t };
}

/** Distance from p to the polygon boundary. */
export function distanceToPolygonEdge(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, pointSegmentDistance(p, poly[j], poly[i]).distance);
  }
  return best;
}

export interface SegmentHit {
  /** Parameter along the first segment. */
  t: number;
  /** Parameter along the second segment. */
  u: number;
  point: Vec2;
}

/** Proper intersection of segments ab and cd (parallel/collinear segments return null). */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentHit | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPSILON) return null;
  const ac = sub(c, a);
  const t = cross(ac, s) / denom;
  const u = cross(ac, r) / denom;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  return { t, u, point: { x: a.x + r.x * t, z: a.z + r.z * t } };
}

/** Intersection of the infinite lines through ab and cd, or null if parallel. */
export function lineIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPSILON) return null;
  const t = cross(sub(c, a), s) / denom;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
}

/**
 * Clips a polygon against the half-plane to the LEFT of the directed line a→b (inclusive).
 * For a CCW convex clip polygon, its interior is to the left of every edge.
 */
export function clipByHalfPlane(poly: readonly Vec2[], a: Vec2, b: Vec2): Polygon {
  const out: Polygon = [];
  const n = poly.length;
  if (n === 0) return out;
  const side = (p: Vec2): number => cross(sub(b, a), sub(p, a));
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i + n - 1) % n];
    const sc = side(cur);
    const sp = side(prev);
    if (sc >= 0) {
      if (sp < 0) out.push(intersectAtSides(prev, cur, sp, sc));
      out.push(cur);
    } else if (sp >= 0) {
      out.push(intersectAtSides(prev, cur, sp, sc));
    }
  }
  return out;
}

function intersectAtSides(p: Vec2, q: Vec2, sp: number, sq: number): Vec2 {
  const t = sp / (sp - sq);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
}

/** Sutherland–Hodgman: clips `subject` (any simple polygon) by a CONVEX CCW `clip` polygon. */
export function clipPolygonConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Polygon {
  let output: Polygon = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    output = clipByHalfPlane(output, clip[i], clip[(i + 1) % clip.length]);
  }
  return output;
}

/**
 * Subtracts a CONVEX CCW polygon `hole` from a polygon: returns disjoint pieces whose union is
 * poly \ hole (each piece = poly ∩ outside(edge_i) ∩ inside(edge_0..i-1)).
 */
export function subtractConvex(poly: readonly Vec2[], hole: readonly Vec2[]): Polygon[] {
  const pieces: Polygon[] = [];
  let remaining: Polygon = [...poly];
  for (let i = 0; i < hole.length && remaining.length >= 3; i++) {
    const a = hole[i];
    const b = hole[(i + 1) % hole.length];
    const outside = clipByHalfPlane(remaining, b, a);
    if (outside.length >= 3 && area(outside) > 1e-6) pieces.push(outside);
    remaining = clipByHalfPlane(remaining, a, b);
  }
  return pieces;
}

/** Axis-aligned rectangle as a CCW polygon. */
export function rectPolygon(minX: number, minZ: number, maxX: number, maxZ: number): Polygon {
  return ensureCCW([v2(minX, minZ), v2(maxX, minZ), v2(maxX, maxZ), v2(minX, maxZ)]);
}

/** Oriented rectangle around a centre with half extents along `dir` and its perpendicular (CCW). */
export function orientedRect(center: Vec2, dir: Vec2, halfLength: number, halfWidth: number): Polygon {
  const d = normalize(dir);
  const p = perpendicular(d);
  return ensureCCW([
    add(add(center, scale(d, -halfLength)), scale(p, -halfWidth)),
    add(add(center, scale(d, halfLength)), scale(p, -halfWidth)),
    add(add(center, scale(d, halfLength)), scale(p, halfWidth)),
    add(add(center, scale(d, -halfLength)), scale(p, halfWidth)),
  ]);
}

/** Removes consecutive duplicates and collinear vertices. */
export function simplifyPolygon(poly: readonly Vec2[], tolerance = 1e-6): Polygon {
  const deduped: Polygon = [];
  for (const p of poly) {
    const last = deduped[deduped.length - 1];
    if (!last || distance(last, p) > tolerance) deduped.push(p);
  }
  if (deduped.length > 1 && distance(deduped[0], deduped[deduped.length - 1]) <= tolerance) deduped.pop();
  const out: Polygon = [];
  const n = deduped.length;
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i + n - 1) % n];
    const cur = deduped[i];
    const next = deduped[(i + 1) % n];
    const c = cross(sub(cur, prev), sub(next, cur));
    if (Math.abs(c) > tolerance * Math.max(1, distance(prev, next))) out.push(cur);
  }
  return out;
}

export function isConvex(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const z = cross(sub(b, a), sub(c, b));
    if (Math.abs(z) < 1e-9) continue;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** True if any two non-adjacent edges of the polygon cross. */
export function isSelfIntersecting(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const hit = segmentIntersection(a, b, c, d);
      if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6 && hit.u > 1e-6 && hit.u < 1 - 1e-6) return true;
    }
  }
  return false;
}

/**
 * Offsets a simple CCW polygon inward by per-edge distances (edge i runs from vertex i to i+1),
 * joining offset edges at their line intersections (mitre). Returns null if the result is
 * degenerate (inverted, self-intersecting or too small).
 */
export function insetPolygon(poly: readonly Vec2[], distances: number | readonly number[]): Polygon | null {
  const n = poly.length;
  if (n < 3) return null;
  const d = (i: number): number => (typeof distances === 'number' ? distances : (distances[i] ?? 0));
  const lines: [Vec2, Vec2][] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const inward = perpendicular(normalize(sub(b, a)));
    const off = scale(inward, d(i));
    lines.push([add(a, off), add(b, off)]);
  }
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n];
    const cur = lines[i];
    const hit = lineIntersection(prev[0], prev[1], cur[0], cur[1]);
    out.push(hit ?? cur[0]);
  }
  if (signedArea(out) <= 1e-6) return null;
  if (isSelfIntersecting(out)) return null;
  // Every vertex must have moved inward (no edge flipped direction).
  for (let i = 0; i < n; i++) {
    const origDir = sub(poly[(i + 1) % n], poly[i]);
    const newDir = sub(out[(i + 1) % n], out[i]);
    if (dot(origDir, newDir) <= 0) return null;
  }
  return out;
}

export interface RobustInset {
  polygon: Polygon;
  /** Original edge index for each edge of the result (edge k runs vertex k → k+1). */
  sourceEdges: number[];
}

/**
 * Inward offset that tolerates collapsing edges: whenever an offset edge would invert, its
 * line is dropped and the neighbouring offset lines are re-intersected (a straight-skeleton
 * style event), repeated until stable. Returns null if fewer than three edges survive or the
 * result is degenerate.
 */
export function insetPolygonRobust(
  poly: readonly Vec2[],
  distances: number | readonly number[],
): RobustInset | null {
  const n = poly.length;
  if (n < 3) return null;
  const d = (i: number): number => (typeof distances === 'number' ? distances : (distances[i] ?? 0));
  interface OffsetLine {
    source: number;
    a: Vec2;
    b: Vec2;
    dir: Vec2;
  }
  let lines: OffsetLine[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (distance(a, b) < 1e-9) continue;
    const dir = normalize(sub(b, a));
    const off = scale(perpendicular(dir), d(i));
    lines.push({ source: i, a: add(a, off), b: add(b, off), dir });
  }
  const vertexFor = (prev: OffsetLine, cur: OffsetLine): Vec2 =>
    lineIntersection(prev.a, prev.b, cur.a, cur.b) ?? scale(add(prev.b, cur.a), 0.5);
  for (let iteration = 0; iteration <= n && lines.length >= 3; iteration++) {
    const m = lines.length;
    const verts = lines.map((cur, k) => vertexFor(lines[(k - 1 + m) % m], cur));
    let worst = -1;
    // Small tolerance: edges that merely touch zero length are not collapse events.
    let worstValue = -1e-7;
    for (let k = 0; k < m; k++) {
      const along = dot(sub(verts[(k + 1) % m], verts[k]), lines[k].dir);
      if (along < worstValue) {
        worstValue = along;
        worst = k;
      }
    }
    if (worst < 0) {
      if (signedArea(verts) <= 1e-6 || isSelfIntersecting(verts)) return null;
      return { polygon: verts, sourceEdges: lines.map((l) => l.source) };
    }
    lines = lines.filter((_, k) => k !== worst);
  }
  return null;
}

/** Monotone-chain convex hull, CCW. */
export function convexHull(points: readonly Vec2[]): Polygon {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length < 3) return pts;
  const lower: Polygon = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 1])) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Polygon = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 1])) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

export interface OrientedBox {
  center: Vec2;
  /** Unit direction of the long axis. */
  axis: Vec2;
  halfLength: number;
  halfWidth: number;
}

/** Minimum-area oriented bounding box (rotating calipers over hull edges). */
export function minAreaRect(points: readonly Vec2[]): OrientedBox {
  const hull = convexHull(points);
  let best: OrientedBox = {
    center: centroid(hull.length ? hull : [...points]),
    axis: { x: 1, z: 0 },
    halfLength: 0,
    halfWidth: 0,
  };
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const axis = normalize(sub(b, a));
    if (axis.x === 0 && axis.z === 0) continue;
    const perp = perpendicular(axis);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = dot(p, axis);
      const v = dot(p, perp);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const boxArea = (maxU - minU) * (maxV - minV);
    if (boxArea < bestArea) {
      bestArea = boxArea;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const center = add(scale(axis, cu), scale(perp, cv));
      const hl = (maxU - minU) / 2;
      const hw = (maxV - minV) / 2;
      best =
        hl >= hw
          ? { center, axis, halfLength: hl, halfWidth: hw }
          : { center, axis: perp, halfLength: hw, halfWidth: hl };
    }
  }
  return best;
}

/**
 * Ear-clipping triangulation of a simple polygon (either winding). Returns vertex index triples
 * in CCW order (this module's convention). Degenerate input yields as many triangles as possible.
 */
export function triangulate(poly: readonly Vec2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = signedArea(poly) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  const tris: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(sub(b, a), sub(c, b)) <= 1e-12) continue;
      let containsOther = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTriangle(poly[j], a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      tris.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Remaining polygon is degenerate (collinear/self-touching): drop a vertex and continue.
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3) {
    const [ia, ib, ic] = idx as [number, number, number];
    if (cross(sub(poly[ib], poly[ia]), sub(poly[ic], poly[ib])) > 1e-12) tris.push(ia, ib, ic);
  }
  return tris;
}

/**
 * Triangulates the region between a simple outer polygon and one simple hole fully inside it.
 * The hole is bridged to a mutually visible outer vertex, producing one weakly simple polygon
 * that is ear-clipped. Returns the merged point list and CCW index triples into it.
 */
export function triangulateWithHole(
  outer: readonly Vec2[],
  hole: readonly Vec2[],
): { points: Vec2[]; indices: number[] } {
  const o = signedArea(outer) > 0 ? [...outer] : [...outer].reverse();
  const h = signedArea(hole) > 0 ? [...hole].reverse() : [...hole];
  // Hole vertex with the largest x, and the closest outer vertex visible from it.
  let hi = 0;
  for (let i = 1; i < h.length; i++) if (h[i].x > h[hi].x) hi = i;
  const hp = h[hi];
  const candidates = o.map((p, i) => ({ i, d: distance(p, hp) })).sort((a, b) => a.d - b.d);
  let oi = -1;
  for (const { i } of candidates) {
    const p = o[i];
    let blocked = false;
    for (const poly of [o, h]) {
      for (let k = 0; k < poly.length && !blocked; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        const hit = segmentIntersection(hp, p, a, b);
        if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) blocked = true;
      }
    }
    if (!blocked) {
      oi = i;
      break;
    }
  }
  if (oi < 0) return { points: [...o], indices: triangulate(o) };
  const merged: Vec2[] = [];
  for (let k = 0; k <= o.length; k++) merged.push(o[(oi + k) % o.length]);
  for (let k = 0; k <= h.length; k++) merged.push(h[(hi + k) % h.length]);
  return { points: merged, indices: triangulateMerged(merged) };
}

/** Ear clipping tolerant of the duplicated bridge vertices of a hole-bridged polygon. */
function triangulateMerged(poly: readonly Vec2[]): number[] {
  const n = poly.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  const tris: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(sub(b, a), sub(c, b)) <= 1e-10) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if ((p.x === a.x && p.z === a.z) || (p.x === b.x && p.z === b.z) || (p.x === c.x && p.z === c.z))
          continue;
        if (pointInTriangle(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) idx.splice(0, 1);
  }
  if (idx.length === 3) {
    const [ia, ib, ic] = idx as [number, number, number];
    if (cross(sub(poly[ib], poly[ia]), sub(poly[ic], poly[ib])) > 1e-10) tris.push(ia, ib, ic);
  }
  return tris;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

/** Splits a convex polygon by the line through `point` with direction `dir` into [left, right]. */
export function splitConvex(poly: readonly Vec2[], point: Vec2, dir: Vec2): [Polygon, Polygon] {
  const b = add(point, dir);
  return [clipByHalfPlane(poly, point, b), clipByHalfPlane(poly, b, point)];
}

/** Polygons overlap (area-wise) — exact for convex polygons via separating axis test. */
export function convexPolygonsOverlap(a: readonly Vec2[], b: readonly Vec2[], tolerance = 1e-6): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const axis = perpendicular(normalize(sub(q, p)));
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of a) {
        const d = dot(v, axis);
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const v of b) {
        const d = dot(v, axis);
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB + tolerance || maxB <= minA + tolerance) return false;
    }
  }
  return true;
}

/** Resamples a polyline at roughly `spacing` metres, returning points (including endpoints). */
export function resamplePolyline(points: readonly Vec2[], spacing: number): Vec2[] {
  if (points.length < 2) return [...points];
  const out: Vec2[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = distance(a, b);
    let t = spacing - carry;
    while (t < segLen) {
      out.push(lerp2(a, b, t / segLen));
      t += spacing;
    }
    carry = segLen - (t - spacing);
  }
  const last = points[points.length - 1];
  if (distance(out[out.length - 1], last) > spacing * 0.25) out.push(last);
  return out;
}
