import {
  distance,
  normalize,
  perpendicular,
  pointInPolygon,
  scale,
  sub,
  add,
  type Vec2,
} from '../gen/geometry2d';
import type { TerrainModel } from '../gen/islands';
import { offsetPolyline3, type Point3 } from '../gen/nav';
import { GroundSurface, type CityDef, type CityLayout, type RoadChain } from '../gen/types';
import type { ChunkIndex } from './chunk-index';
import { TRENCH_CAP_WIDTH, TRENCH_WALL_OFFSET } from '../gen/road-network';
import { emitRoadRibbon, roadFlags } from './ground-mesh';
import { MeshBuilder, type MeshData } from './mesh-builder';

const DECK_THICKNESS = 1.6;
const WALKWAY = 1.4;
const PARAPET = 1.05;
const TUNNEL_CLEARANCE = 6.5;

export interface LandmarkMeshes {
  /** Collidable structure: decks, walls, tunnel shell, towers, overpass slabs. */
  solid: MeshData;
  /** Visual-only detail: cables, hangers, truss members. */
  detail: MeshData;
}

export function buildLandmarks(
  layout: CityLayout,
  index: ChunkIndex,
  terrain: TerrainModel,
  city: CityDef,
): LandmarkMeshes {
  const solid = new MeshBuilder();
  const detail = new MeshBuilder();
  layout.chains.forEach((chain, ci) => {
    const line = index.centerlines[ci];
    if (!line || line.length < 2) return;
    if (chain.cls === 'bridge') {
      const crossing = city.crossings.find((c) => c.id === layout.edges[chain.edges[0]]?.crossing);
      buildBridge(solid, detail, chain, line, terrain, crossing?.style ?? 'truss');
    } else if (chain.cls === 'tunnel') {
      buildTunnel(solid, chain, line, terrain, index);
    }
  });
  buildOverpasses(solid, layout);
  return { solid: solid.build(), detail: detail.build() };
}

/** Square-section beam between two points (four side faces). */
export function beam(m: MeshBuilder, p0: Point3, p1: Point3, r: number): void {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  // Basis perpendicular to the axis.
  let ux = -az;
  let uy = 0;
  let uz = ax;
  if (Math.hypot(ux, uz) < 1e-3) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let k = 0; k < 4; k++) {
    const [s0, t0] = corners[k];
    const [s1, t1] = corners[(k + 1) % 4];
    const nx = (s0 + s1) * ux + (t0 + t1) * vx;
    const ny = (s0 + s1) * uy + (t0 + t1) * vy;
    const nz = (s0 + s1) * uz + (t0 + t1) * vz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    m.normal(nx / nl, ny / nl, nz / nl);
    const off = (s: number, t: number): [number, number, number] => [
      r * (s * ux + t * vx),
      r * (s * uy + t * vy),
      r * (s * uz + t * vz),
    ];
    const [ax0, ay0, az0] = off(s0, t0);
    const [ax1, ay1, az1] = off(s1, t1);
    const a = m.vertex(p0.x + ax0, p0.y + ay0, p0.z + az0, 0, 0);
    const b = m.vertex(p0.x + ax1, p0.y + ay1, p0.z + az1, 1, 0);
    const c = m.vertex(p1.x + ax1, p1.y + ay1, p1.z + az1, 1, len);
    const d = m.vertex(p1.x + ax0, p1.y + ay0, p1.z + az0, 0, len);
    // Wind so the quad faces its outward normal.
    const e1 = [p0.x + ax1 - (p0.x + ax0), p0.y + ay1 - (p0.y + ay0), p0.z + az1 - (p0.z + az0)] as const;
    const e2 = [dx, dy, dz] as const;
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * nx + cy * ny + cz * nz >= 0) m.quad(a, b, c, d);
    else m.quad(a, d, c, b);
  }
}

function sideWall(
  m: MeshBuilder,
  line: Point3[],
  yBottom: (i: number) => number,
  yTop: (i: number) => number,
  facingRight: boolean,
): void {
  let u = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    if (facingRight) m.wall(a.x, a.z, b.x, b.z, yBottom(i), yTop(i), yBottom(i + 1), yTop(i + 1), u);
    else m.wall(b.x, b.z, a.x, a.z, yBottom(i + 1), yTop(i + 1), yBottom(i), yTop(i), u);
    u += distance(a, b);
  }
}

function strip(m: MeshBuilder, left: Point3[], right: Point3[], yOffset: number, facingUp: boolean): void {
  for (let i = 0; i + 1 < left.length; i++) {
    const l0 = left[i];
    const r0 = right[i];
    const l1 = left[i + 1];
    const r1 = right[i + 1];
    m.normal(0, facingUp ? 1 : -1, 0);
    const a = m.vertex(l0.x, l0.y + yOffset, l0.z, l0.x, l0.z);
    const b = m.vertex(r0.x, r0.y + yOffset, r0.z, r0.x, r0.z);
    const c = m.vertex(r1.x, r1.y + yOffset, r1.z, r1.x, r1.z);
    const d = m.vertex(l1.x, l1.y + yOffset, l1.z, l1.x, l1.z);
    // left→right→forward is upward-facing (see emitRoadRibbon).
    if (facingUp) m.quadUp(a, b, c, d);
    else m.quad(a, d, c, b);
  }
}

function buildBridge(
  solid: MeshBuilder,
  detail: MeshBuilder,
  chain: RoadChain,
  line: Point3[],
  terrain: TerrainModel,
  style: 'suspension' | 'truss' | 'immersed',
): void {
  const hw = chain.width / 2;
  emitRoadRibbon(
    solid,
    line,
    0,
    line.length - 1,
    hw,
    chain.lanesPerDirection,
    roadFlags(false, false, chain.cls, hw),
    0.02,
  );
  const walkIn = { l: offsetPolyline3(line, -hw), r: offsetPolyline3(line, hw) };
  const walkOut = { l: offsetPolyline3(line, -(hw + WALKWAY)), r: offsetPolyline3(line, hw + WALKWAY) };
  solid.color(0xffffff).setData(GroundSurface.sidewalk, 0, 0, 0);
  strip(solid, walkOut.l, walkIn.l, 0.2, true);
  strip(solid, walkIn.r, walkOut.r, 0.2, true);
  // Kerbs between carriageway and walkways.
  solid.setData(GroundSurface.concrete, 0, 0, 0);
  sideWall(
    solid,
    walkIn.l,
    (i) => walkIn.l[i].y - 0.05,
    (i) => walkIn.l[i].y + 0.2,
    true,
  );
  sideWall(
    solid,
    walkIn.r,
    (i) => walkIn.r[i].y - 0.05,
    (i) => walkIn.r[i].y + 0.2,
    false,
  );
  // Outer deck faces with parapet, inner parapet faces and parapet tops.
  solid.setData(style === 'suspension' ? GroundSurface.concrete : GroundSurface.steel, 0, 0, 0);
  sideWall(
    solid,
    walkOut.r,
    (i) => walkOut.r[i].y - DECK_THICKNESS,
    (i) => walkOut.r[i].y + 0.2 + PARAPET,
    true,
  );
  sideWall(
    solid,
    walkOut.l,
    (i) => walkOut.l[i].y - DECK_THICKNESS,
    (i) => walkOut.l[i].y + 0.2 + PARAPET,
    false,
  );
  const parapetInR = offsetPolyline3(line, hw + WALKWAY - 0.3);
  const parapetInL = offsetPolyline3(line, -(hw + WALKWAY - 0.3));
  sideWall(
    solid,
    parapetInR,
    (i) => parapetInR[i].y + 0.2,
    (i) => parapetInR[i].y + 0.2 + PARAPET,
    false,
  );
  sideWall(
    solid,
    parapetInL,
    (i) => parapetInL[i].y + 0.2,
    (i) => parapetInL[i].y + 0.2 + PARAPET,
    true,
  );
  strip(solid, parapetInR, walkOut.r, 0.2 + PARAPET, true);
  strip(solid, walkOut.l, parapetInL, 0.2 + PARAPET, true);
  strip(solid, walkOut.l, walkOut.r, -DECK_THICKNESS, false);

  const total = line.reduce((acc, p, i) => (i === 0 ? 0 : acc + distance(line[i - 1], p)), 0);
  const pointAt = (t: number): { p: Point3; dir: Vec2 } => {
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const seg = distance(a, b);
      if (acc + seg >= t * total) {
        const f = seg > 0 ? (t * total - acc) / seg : 0;
        return {
          p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f },
          dir: normalize(sub(b, a)),
        };
      }
      acc += seg;
    }
    const last = line[line.length - 1];
    return { p: last, dir: normalize(sub(last, line[line.length - 2])) };
  };

  // Piers into the water every ~36 m.
  solid.setData(GroundSurface.concrete, 0, 0, 0);
  for (let d = 18; d < total - 10; d += 36) {
    const { p, dir } = pointAt(d / total);
    if (terrain.isLand(p.x, p.z)) continue;
    const side = perpendicular(dir);
    for (const s of [-1, 1]) {
      const c = add(p, scale(side, s * (hw * 0.6)));
      beam(solid, { x: c.x, y: -6, z: c.z }, { x: c.x, y: p.y - DECK_THICKNESS, z: c.z }, 1.1);
    }
  }

  const edgeOffset = hw + WALKWAY + 0.9;
  if (style === 'suspension') {
    const towerTs = [0.27, 0.73];
    const deckMax = Math.max(...line.map((p) => p.y));
    const towerTop = deckMax + 40;
    const towers = towerTs.map((t) => pointAt(t));
    solid.setData(GroundSurface.concrete, 0, 0, 0);
    for (const { p, dir } of towers) {
      const side = perpendicular(dir);
      const legs = [-1, 1].map((s) => add(p, scale(side, s * edgeOffset)));
      for (const leg of legs)
        beam(solid, { x: leg.x, y: -6, z: leg.z }, { x: leg.x, y: towerTop, z: leg.z }, 1.3);
      for (const y of [p.y + 9, towerTop - 4, towerTop - 0.6]) {
        beam(solid, { x: legs[0].x, y, z: legs[0].z }, { x: legs[1].x, y, z: legs[1].z }, 0.9);
      }
    }
    // Main cables: anchor → tower → sagging main span → tower → anchor; hangers every 8 m.
    detail.color(0xffffff).setData(GroundSurface.steel, 0, 0, 0);
    for (const s of [-1, 1]) {
      const cablePoints: Point3[] = [];
      const samples = 64;
      for (let k = 0; k <= samples; k++) {
        const t = k / samples;
        const { p, dir } = pointAt(t);
        const side = perpendicular(dir);
        const c = add(p, scale(side, s * edgeOffset));
        let y: number;
        const [t0, t1] = towerTs as [number, number];
        if (t <= t0) y = p.y + 1.5 + (towerTop - 1 - (p.y + 1.5)) * (t / t0);
        else if (t >= t1) y = p.y + 1.5 + (towerTop - 1 - (p.y + 1.5)) * ((1 - t) / (1 - t1));
        else {
          const u = (t - t0) / (t1 - t0);
          const sag = 4 * u * (1 - u);
          y = towerTop - 1 - (towerTop - 1 - (p.y + 4)) * sag;
        }
        cablePoints.push({ x: c.x, y, z: c.z });
      }
      for (let k = 0; k + 1 < cablePoints.length; k++) beam(detail, cablePoints[k], cablePoints[k + 1], 0.32);
      for (let d = 8; d < total; d += 8) {
        const k = Math.round((d / total) * samples);
        const top = cablePoints[k];
        const { p } = pointAt(d / total);
        if (top.y - p.y > 1.5) beam(detail, { x: top.x, y: p.y + 0.2, z: top.z }, top, 0.08);
      }
    }
  } else {
    // Steel through-truss: top chords, verticals and alternating diagonals on both sides.
    detail.color(0xffffff).setData(GroundSurface.steel, 0, 0, 0);
    const height = 7.5;
    const panel = 10;
    for (const s of [-1, 1]) {
      const nodes: { bottom: Point3; top: Point3 }[] = [];
      for (let d = 0; d <= total; d += panel) {
        const { p, dir } = pointAt(Math.min(1, d / total));
        if (terrain.isLand(p.x, p.z) && d > panel && d < total - panel) continue;
        const c = add(p, scale(perpendicular(dir), s * edgeOffset));
        nodes.push({ bottom: { x: c.x, y: p.y + 0.2, z: c.z }, top: { x: c.x, y: p.y + height, z: c.z } });
      }
      nodes.forEach((n, i) => {
        beam(detail, n.bottom, n.top, 0.22);
        const next = nodes[i + 1];
        if (!next) return;
        beam(detail, n.top, next.top, 0.3);
        beam(detail, i % 2 === 0 ? n.bottom : n.top, i % 2 === 0 ? next.top : next.bottom, 0.18);
      });
    }
  }
}

function buildTunnel(
  solid: MeshBuilder,
  chain: RoadChain,
  line: Point3[],
  terrain: TerrainModel,
  index: ChunkIndex,
): void {
  const hw = chain.width / 2;
  const startJ = index.junctionByNode.has(chain.nodes[0]);
  const endJ = index.junctionByNode.has(chain.nodes[chain.nodes.length - 1]);
  // Densify so walls follow the descent smoothly.
  const dense: Point3[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const steps = Math.max(1, Math.ceil(distance(a, b) / 6));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  dense.push(line[line.length - 1]);
  emitRoadRibbon(
    solid,
    dense,
    0,
    dense.length - 1,
    hw + 1,
    chain.lanesPerDirection,
    roadFlags(startJ, endJ, chain.cls, hw + 1),
    0,
  );

  const wallOffset = hw + TRENCH_WALL_OFFSET;
  const ground = dense.map((p) => (terrain.isLand(p.x, p.z) ? terrain.heightAt(p.x, p.z) : 0));
  const covered = dense.map((p, i) => !terrain.isLand(p.x, p.z) || ground[i] - p.y > TUNNEL_CLEARANCE + 0.5);
  const left = offsetPolyline3(dense, -wallOffset);
  const right = offsetPolyline3(dense, wallOffset);
  const wallTop = (i: number): number => {
    const p = dense[i];
    return covered[i] ? p.y + TUNNEL_CLEARANCE : Math.max(p.y + 1.2, ground[i] + 0.9);
  };
  solid.color(0xffffff).setData(GroundSurface.tunnel, 0, 0, 0);
  // Inward-facing side walls.
  sideWall(solid, right, (i) => dense[i].y - 0.3, wallTop, false);
  sideWall(solid, left, (i) => dense[i].y - 0.3, wallTop, true);
  // Ceiling (facing down) and the shell roof above it (facing up, for anything that lands on it).
  for (let i = 0; i + 1 < dense.length; i++) {
    if (!covered[i] || !covered[i + 1]) continue;
    strip(solid, left.slice(i, i + 2), right.slice(i, i + 2), TUNNEL_CLEARANCE, false);
    strip(solid, left.slice(i, i + 2), right.slice(i, i + 2), TUNNEL_CLEARANCE + 0.5, true);
    if (covered[i - 1] === false) {
      // Portal face above the entrance, facing back along the open trench.
      const p = dense[i];
      const l = left[i];
      const r = right[i];
      solid.setData(GroundSurface.concrete, 0, 0, 0);
      solid.wall(
        l.x,
        l.z,
        r.x,
        r.z,
        p.y + TUNNEL_CLEARANCE,
        Math.max(ground[i], p.y + TUNNEL_CLEARANCE) + 1,
        p.y + TUNNEL_CLEARANCE,
        Math.max(ground[i], p.y + TUNNEL_CLEARANCE) + 1,
        0,
      );
      solid.setData(GroundSurface.tunnel, 0, 0, 0);
    }
    if (covered[i + 2] === false) {
      const p = dense[i + 1];
      const l = left[i + 1];
      const r = right[i + 1];
      solid.setData(GroundSurface.concrete, 0, 0, 0);
      solid.wall(
        r.x,
        r.z,
        l.x,
        l.z,
        p.y + TUNNEL_CLEARANCE,
        Math.max(ground[i + 1], p.y + TUNNEL_CLEARANCE) + 1,
        p.y + TUNNEL_CLEARANCE,
        Math.max(ground[i + 1], p.y + TUNNEL_CLEARANCE) + 1,
        0,
      );
      solid.setData(GroundSurface.tunnel, 0, 0, 0);
    }
  }
  // Parapet caps along open trench walls.
  solid.setData(GroundSurface.concrete, 0, 0, 0);
  for (const [side, sign] of [
    [right, 1],
    [left, -1],
  ] as const) {
    const outer = offsetPolyline3(dense, sign * (wallOffset + TRENCH_CAP_WIDTH));
    for (let i = 0; i + 1 < dense.length; i++) {
      if (covered[i] && covered[i + 1]) continue;
      const pair =
        sign > 0
          ? [side.slice(i, i + 2), outer.slice(i, i + 2)]
          : [outer.slice(i, i + 2), side.slice(i, i + 2)];
      const lifted = pair.map((pts) => pts.map((p, k) => ({ ...p, y: wallTop(i + k) }))) as [
        Point3[],
        Point3[],
      ];
      strip(solid, lifted[0], lifted[1], 0, true);
    }
  }
}

/** Concrete slabs carrying surface roads over the tunnel trenches. */
function buildOverpasses(solid: MeshBuilder, layout: CityLayout): void {
  solid.color(0xffffff).setData(GroundSurface.concrete, 0, 0, 0);
  for (const hole of layout.holes) {
    for (const edge of layout.edges) {
      if (edge.cls === 'tunnel' || edge.cls === 'bridge') continue;
      const a = layout.nodes[edge.a] as { x: number; z: number; y: number };
      const b = layout.nodes[edge.b] as { x: number; z: number; y: number };
      const samples = 12;
      let inside = false;
      for (let k = 0; k <= samples && !inside; k++) {
        const t = k / samples;
        inside = pointInPolygon({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, hole.polygon);
      }
      if (!inside) continue;
      const dir = normalize(sub(b, a));
      const side = scale(perpendicular(dir), edge.width / 2 + 0.6);
      const quad = [add(a, side), add(b, side), sub(b, side), sub(a, side)];
      const ya = a.y - 0.03;
      const yb = b.y - 0.03;
      const heights = [ya, yb, yb, ya];
      // Underside (facing down) and side faces down to 1.2 m below the road.
      solid.normal(0, -1, 0);
      const ids = quad.map((p, i) => solid.vertex(p.x, heights[i] - 1.2, p.z, p.x, p.z));
      solid.upTriangle(ids[0], ids[2], ids[1]);
      solid.upTriangle(ids[0], ids[3], ids[2]);
      const q0 = quad[0];
      const q1 = quad[1];
      const q2 = quad[2];
      const q3 = quad[3];
      solid.wall(q1.x, q1.z, q0.x, q0.z, yb - 1.2, yb, ya - 1.2, ya, 0);
      solid.wall(q3.x, q3.z, q2.x, q2.z, ya - 1.2, ya, yb - 1.2, yb, 0);
    }
  }
}
