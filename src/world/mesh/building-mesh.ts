import {
  add,
  distance,
  insetPolygon,
  minAreaRect,
  orientedRect,
  perpendicular,
  scale,
  type Polygon,
  type Vec2,
} from '../gen/geometry2d';
import { FacadeStyle, type BuildingSpec, type BuildingTier } from '../gen/types';
import { MeshBuilder, type MeshData } from './mesh-builder';

/** Roof style codes for the building shader (walls use FacadeStyle 0–5). */
export const RoofStyle = {
  flat: 20,
  tiles: 21,
  metal: 22,
  skylight: 23,
  parapetCap: 24,
} as const;

export type BuildingLod = 0 | 1 | 2;

const PARAPET = 1.1;

export function buildBuildingMesh(buildings: readonly BuildingSpec[], lod: BuildingLod): MeshData {
  const m = new MeshBuilder();
  for (const b of buildings) {
    if (lod === 2) farBox(m, b);
    else detailed(m, b, lod === 0);
  }
  return m.build();
}

function facade(m: MeshBuilder, b: BuildingSpec): void {
  m.color(b.color).setData(FacadeStyle[b.style], b.floorHeight, b.bayWidth, b.seed);
}

function roofData(m: MeshBuilder, b: BuildingSpec, style: number): void {
  m.color(b.roofColor).setData(style, b.floorHeight, b.bayWidth, b.seed);
}

function walls(m: MeshBuilder, poly: Polygon, y0: number, y1: number, vBase: number): void {
  let u = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    m.wall(a.x, a.z, c.x, c.z, y0, y1, y0, y1, u, vBase);
    u += distance(a, c);
  }
}

/** Inward-facing walls (e.g. the inside of a parapet). */
function wallsInward(m: MeshBuilder, poly: Polygon, y0: number, y1: number, vBase: number): void {
  for (let i = poly.length - 1; i >= 0; i--) {
    const a = poly[(i + 1) % poly.length];
    const c = poly[i];
    m.wall(a.x, a.z, c.x, c.z, y0, y1, y0, y1, 0, vBase);
  }
}

function cap(m: MeshBuilder, poly: Polygon, y: number): void {
  m.normal(0, 1, 0);
  const ids = poly.map((p) => m.vertex(p.x, y, p.z, p.x, p.z));
  for (let k = 1; k + 1 < ids.length; k++) m.upTriangle(ids[0], ids[k], ids[k + 1]);
}

/** Flat ring between an outer and an inset polygon with the same vertex count. */
function ring(m: MeshBuilder, outer: Polygon, inner: Polygon, y: number): void {
  m.normal(0, 1, 0);
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o0 = outer[i];
    const o1 = outer[j];
    const i0 = inner[i];
    const i1 = inner[j];
    const a = m.vertex(o0.x, y, o0.z, o0.x, o0.z);
    const b = m.vertex(o1.x, y, o1.z, o1.x, o1.z);
    const c = m.vertex(i1.x, y, i1.z, i1.x, i1.z);
    const d = m.vertex(i0.x, y, i0.z, i0.x, i0.z);
    m.upTriangle(a, b, c);
    m.upTriangle(a, c, d);
  }
}

function detailed(m: MeshBuilder, b: BuildingSpec, lod0: boolean): void {
  const base = b.baseY;
  b.tiers.forEach((tier: BuildingTier, t: number) => {
    const bottom = t === 0 ? base : base + b.tiers[t - 1].top;
    const top = base + tier.top;
    const isLast = t === b.tiers.length - 1;
    facade(m, b);
    if (isLast && b.roof === 'gable') {
      walls(m, tier.footprint, bottom, top, base);
      gableRoof(m, b, tier.footprint, top);
      return;
    }
    if (isLast && b.roof === 'sawtooth' && lod0) {
      walls(m, tier.footprint, bottom, top, base);
      sawtoothRoof(m, b, tier.footprint, top);
      return;
    }
    const parapetHere = lod0 && b.style !== 'house';
    walls(m, tier.footprint, bottom, parapetHere ? top + PARAPET : top, base);
    if (parapetHere) {
      const inner = insetPolygon(tier.footprint, 0.35);
      if (inner) {
        facade(m, b);
        wallsInward(m, inner, top, top + PARAPET, base);
        roofData(m, b, RoofStyle.parapetCap);
        ring(m, tier.footprint, inner, top + PARAPET);
        roofData(m, b, RoofStyle.flat);
        cap(m, inner, top);
      } else {
        roofData(m, b, RoofStyle.flat);
        cap(m, tier.footprint, top + PARAPET);
      }
    } else {
      roofData(m, b, RoofStyle.flat);
      cap(m, tier.footprint, top);
    }
    if (lod0 && t === 0 && b.tiers.length > 1) cornice(m, b, tier.footprint, top);
  });
}

function cornice(m: MeshBuilder, b: BuildingSpec, footprint: Polygon, top: number): void {
  const outer = insetPolygon(footprint, -0.45);
  if (!outer || outer.length !== footprint.length) return;
  roofData(m, b, RoofStyle.parapetCap);
  walls(m, outer, top - 0.6, top, b.baseY);
  ring(m, outer, footprint, top);
}

function gableRoof(m: MeshBuilder, b: BuildingSpec, footprint: Polygon, top: number): void {
  const box = minAreaRect(footprint);
  const axis = box.axis;
  const across = perpendicular(axis);
  const ridgeHeight = Math.max(1.6, box.halfWidth * 0.75);
  const overhang = 0.4;
  const hl = box.halfLength + overhang;
  const hw = box.halfWidth + overhang;
  const c = box.center;
  const p = (u: number, v: number): Vec2 => add(add(c, scale(axis, u)), scale(across, v));
  const e0 = p(-hl, -hw);
  const e1 = p(hl, -hw);
  const e2 = p(hl, hw);
  const e3 = p(-hl, hw);
  const r0 = p(-hl, 0);
  const r1 = p(hl, 0);
  const eave = top - overhang * 0.75;
  const ridge = top + ridgeHeight;
  roofData(m, b, RoofStyle.tiles);
  upQuad(m, at(e0, eave), at(e1, eave), at(r1, ridge), at(r0, ridge));
  upQuad(m, at(e2, eave), at(e3, eave), at(r0, ridge), at(r1, ridge));
  // Gable end triangles in the facade style, facing ±axis.
  facade(m, b);
  const apexY = ridge - overhang * 0.5;
  outwardTriangle(
    m,
    at(p(-box.halfLength, -box.halfWidth), top),
    at(p(-box.halfLength, box.halfWidth), top),
    at(p(-box.halfLength, 0), apexY),
    scale(axis, -1),
    b.baseY,
  );
  outwardTriangle(
    m,
    at(p(box.halfLength, box.halfWidth), top),
    at(p(box.halfLength, -box.halfWidth), top),
    at(p(box.halfLength, 0), apexY),
    axis,
    b.baseY,
  );
}

interface P3 {
  x: number;
  y: number;
  z: number;
}

function faceNormal(a: P3, b: P3, c: P3): P3 {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const wx = c.x - a.x;
  const wy = c.y - a.y;
  const wz = c.z - a.z;
  const nx = uy * wz - uz * wy;
  const ny = uz * wx - ux * wz;
  const nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Planar quad a-b-c-d (any winding) emitted so that it faces up (+y). */
function upQuad(m: MeshBuilder, a: P3, b: P3, c: P3, d: P3): void {
  let n = faceNormal(a, b, c);
  const flip = n.y < 0;
  if (flip) n = { x: -n.x, y: -n.y, z: -n.z };
  m.normal(n.x, n.y, n.z);
  const ids = [a, b, c, d].map((p) => m.vertex(p.x, p.y, p.z, p.x, p.z));
  const [ia, ib, ic, id] = ids as [number, number, number, number];
  if (flip) {
    m.triangle(ia, ic, ib);
    m.triangle(ia, id, ic);
  } else {
    m.triangle(ia, ib, ic);
    m.triangle(ia, ic, id);
  }
}

/** Triangle emitted so that it faces along the horizontal `outward` direction. */
function outwardTriangle(m: MeshBuilder, a: P3, b: P3, c: P3, outward: Vec2, vBase: number): void {
  let n = faceNormal(a, b, c);
  const flip = n.x * outward.x + n.z * outward.z < 0;
  if (flip) n = { x: -n.x, y: -n.y, z: -n.z };
  m.normal(n.x, n.y, n.z);
  const ia = m.vertex(a.x, a.y, a.z, 0, a.y - vBase);
  const ib = m.vertex(b.x, b.y, b.z, distance(a, b), b.y - vBase);
  const ic = m.vertex(c.x, c.y, c.z, distance(a, c), c.y - vBase);
  if (flip) m.triangle(ia, ic, ib);
  else m.triangle(ia, ib, ic);
}

const at = (p: Vec2, y: number): P3 => ({ x: p.x, y, z: p.z });

function sawtoothRoof(m: MeshBuilder, b: BuildingSpec, footprint: Polygon, top: number): void {
  const box = minAreaRect(footprint);
  const teeth = Math.max(2, Math.round((box.halfLength * 2) / 9));
  const toothLength = (box.halfLength * 2) / teeth;
  const across = perpendicular(box.axis);
  const height = 2.4;
  for (let k = 0; k < teeth; k++) {
    const u0 = -box.halfLength + k * toothLength;
    const u1 = u0 + toothLength;
    const p = (u: number, v: number): Vec2 => add(add(box.center, scale(box.axis, u)), scale(across, v));
    const a = p(u0, -box.halfWidth);
    const c = p(u0, box.halfWidth);
    const d = p(u1, box.halfWidth);
    const e = p(u1, -box.halfWidth);
    // Sloped metal plane from the low edge (u0) up to the high edge (u1).
    roofData(m, b, RoofStyle.metal);
    upQuad(m, at(a, top), at(c, top), at(d, top + height), at(e, top + height));
    // Vertical glazing face at u1 facing -axis.
    roofData(m, b, RoofStyle.skylight);
    m.wall(d.x, d.z, e.x, e.z, top, top + height, top, top + height, 0, top);
    // Side triangles.
    facade(m, b);
    outwardTriangle(m, at(a, top), at(e, top), at(e, top + height), scale(across, -1), top);
    outwardTriangle(m, at(d, top), at(c, top), at(d, top + height), across, top);
  }
}

function farBox(m: MeshBuilder, b: BuildingSpec): void {
  const footprint = b.tiers[0].footprint;
  const box = minAreaRect(footprint);
  const rect = orientedRect(box.center, box.axis, box.halfLength, box.halfWidth);
  const height = b.roof === 'gable' ? b.height + Math.max(1.6, box.halfWidth * 0.75) * 0.5 : b.height;
  facade(m, b);
  walls(m, rect, b.baseY, b.baseY + height, b.baseY);
  roofData(m, b, b.roof === 'gable' ? RoofStyle.tiles : RoofStyle.flat);
  cap(m, rect, b.baseY + height);
}

/** Convex hull points (footprint × bottom/top) per tier, for physics colliders. */
export function buildingHulls(b: BuildingSpec): Float32Array[] {
  return b.tiers.map((tier, t) => {
    const bottom = t === 0 ? b.baseY : b.baseY + b.tiers[t - 1].top;
    const top =
      b.baseY +
      tier.top +
      (t === b.tiers.length - 1 && b.roof === 'flat' && b.style !== 'house' ? PARAPET : 0);
    const out = new Float32Array(tier.footprint.length * 6);
    tier.footprint.forEach((p, i) => {
      out.set([p.x, bottom, p.z, p.x, top, p.z], i * 6);
    });
    return out;
  });
}
