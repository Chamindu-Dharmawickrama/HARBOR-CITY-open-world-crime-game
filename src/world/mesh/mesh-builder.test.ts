import { describe, expect, it } from 'vitest';
import { area, rectPolygon, triangulateWithHole, type Vec2 } from '../gen/geometry2d';
import { MeshBuilder, mergeMeshes, type MeshData } from './mesh-builder';

function triangleNormal(mesh: MeshData, t: number): [number, number, number] {
  const p = (i: number): [number, number, number] => {
    const v = mesh.indices[t * 3 + i];
    return [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
  };
  const [a, b, c] = [p(0), p(1), p(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
}

describe('MeshBuilder', () => {
  it('walls of a CCW footprint face outward', () => {
    const square = rectPolygon(0, 0, 10, 10);
    const m = new MeshBuilder();
    for (let i = 0; i < 4; i++) {
      const a = square[i];
      const b = square[(i + 1) % 4];
      m.wall(a.x, a.z, b.x, b.z, 0, 3, 0, 3, 0);
    }
    const mesh = m.build();
    expect(mesh.indices.length / 3).toBe(8);
    for (let t = 0; t < 8; t++) {
      const n = triangleNormal(mesh, t);
      const v = mesh.indices[t * 3];
      const cx = mesh.positions[v * 3] - 5;
      const cz = mesh.positions[v * 3 + 2] - 5;
      expect(n[0] * cx + n[2] * cz).toBeGreaterThan(0);
      expect(Math.abs(n[1])).toBeLessThan(1e-9);
    }
    const nx = mesh.normals[0];
    const nz = mesh.normals[2];
    const [gx, , gz] = triangleNormal(mesh, 0);
    expect(nx * gx + nz * gz).toBeGreaterThan(0);
  });

  it('upTriangle turns xz-CCW triangles upward', () => {
    const m = new MeshBuilder();
    const a = m.vertex(0, 0, 0);
    const b = m.vertex(1, 0, 0);
    const c = m.vertex(0, 0, 1);
    m.upTriangle(a, b, c);
    expect(triangleNormal(m.build(), 0)[1]).toBeGreaterThan(0);
  });

  it('tracks bounds and merges meshes with rebased indices', () => {
    const a = new MeshBuilder();
    a.quad(a.vertex(0, 0, 0), a.vertex(1, 0, 0), a.vertex(1, 1, 0), a.vertex(0, 1, 0));
    const b = new MeshBuilder();
    b.triangle(b.vertex(5, 5, 5), b.vertex(6, 5, 5), b.vertex(5, 6, 5));
    const merged = mergeMeshes([a.build(), b.build()]);
    expect(merged.positions.length).toBe(7 * 3);
    expect(Array.from(merged.indices.slice(6))).toEqual([4, 5, 6]);
    expect(merged.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(merged.normals.slice(0, 3))).toEqual([0, 127, 0]);
    expect(Array.from(merged.bounds)).toEqual([0, 0, 0, 6, 6, 5]);
    expect(mergeMeshes([]).indices.length).toBe(0);
  });
});

describe('triangulateWithHole', () => {
  it('covers exactly the ring area', () => {
    const outer = rectPolygon(0, 0, 20, 20);
    const hole = rectPolygon(4, 4, 16, 16);
    const { points, indices } = triangulateWithHole(outer, hole);
    let total = 0;
    for (let i = 0; i < indices.length; i += 3) {
      total += area([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]] as Vec2[]);
    }
    expect(total).toBeCloseTo(400 - 144, 3);
  });
});
