import { beforeAll, describe, expect, it } from 'vitest';
import { CITY } from '../../content/city';
import { generateCity } from '../gen/city-layout';
import type { MeshData } from './mesh-builder';
import { WorldMeshFactory, type ChunkPiece } from './world-mesh-factory';

let factory: WorldMeshFactory;

function validate(mesh: MeshData, label: string): void {
  const vertexCount = mesh.positions.length / 3;
  expect(mesh.normals.length, label).toBe(vertexCount * 3);
  expect(mesh.uvs.length, label).toBe(vertexCount * 2);
  expect(mesh.data.length, label).toBe(vertexCount * 4);
  expect(mesh.indices.length % 3, label).toBe(0);
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i])) throw new Error(`${label}: non-finite position at ${i}`);
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    if (mesh.indices[i] >= vertexCount) throw new Error(`${label}: index out of range`);
  }
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const len = Math.hypot(mesh.normals[i] / 127, mesh.normals[i + 1] / 127, mesh.normals[i + 2] / 127);
    if (Math.abs(len - 1) > 0.03) throw new Error(`${label}: normal not unit length (${len})`);
  }
}

beforeAll(() => {
  factory = new WorldMeshFactory(generateCity(CITY, 74613), CITY);
});

describe('world meshes', () => {
  it('builds valid geometry for every chunk and piece within budget', () => {
    const keys = factory.index.keys();
    expect(keys.length).toBeGreaterThan(150);
    const pieces: ChunkPiece[] = ['groundDetail', 'groundCoarse', 'buildings0', 'buildings1', 'buildings2'];
    const totals: Record<string, number> = {};
    let slowest = 0;
    for (const key of keys) {
      for (const piece of pieces) {
        const t0 = performance.now();
        const { mesh } = factory.build(key, piece, false);
        slowest = Math.max(slowest, performance.now() - t0);
        validate(mesh, `${key}/${piece}`);
        totals[piece] = (totals[piece] ?? 0) + mesh.indices.length / 3;
      }
    }
    // Coarser pieces must actually be cheaper.
    expect(totals['groundCoarse']).toBeLessThan(totals['groundDetail'] * 0.5);
    expect(totals['buildings2']).toBeLessThan(totals['buildings1']);
    expect(totals['buildings1']).toBeLessThan(totals['buildings0']);
    // A single piece must build fast enough for streaming on a worker.
    expect(slowest).toBeLessThan(400);
  });

  it('detail ground in a downtown chunk has terrain, roads and sidewalks with raised kerbs', () => {
    const downtownKey = factory.index.keys().find((k) => {
      const c = factory.index.get(k)!;
      return (
        c.blocks.length > 2 &&
        c.chainPieces.length > 3 &&
        factory.model.terrain.districtAt(c.cx * 128 + 64, c.cz * 128 + 64) === 'meridian'
      );
    });
    expect(downtownKey).toBeDefined();
    const { mesh, colliders } = factory.build(downtownKey!, 'groundDetail', true);
    const surfaces = new Set<number>();
    for (let i = 0; i < mesh.data.length; i += 4) surfaces.add(mesh.data[i]);
    expect(surfaces.has(1)).toBe(true); // asphalt
    expect(surfaces.has(2)).toBe(true); // sidewalk
    expect(colliders).not.toBeNull();
    expect(colliders!.groundIndices.length).toBe(mesh.indices.length);
    expect(colliders!.hulls.length).toBeGreaterThan(0);
  });

  it('landmarks include both bridges and the tunnel', () => {
    const { solid, detail } = factory.landmarks();
    validate(solid, 'landmarks/solid');
    validate(detail, 'landmarks/detail');
    expect(solid.indices.length / 3).toBeGreaterThan(2000);
    expect(detail.indices.length / 3).toBeGreaterThan(1000);
    // The tunnel floor reaches well below sea level.
    expect(solid.bounds[1]).toBeLessThan(-8);
  });
});

describe('ground mesh orientation', () => {
  it('every horizontal ground triangle in every chunk faces up', () => {
    let horizontal = 0;
    const down: string[] = [];
    for (const key of factory.index.keys()) {
      for (const piece of ['groundDetail', 'groundCoarse'] as const) {
        const { mesh } = factory.build(key, piece, false);
        for (let t = 0; t < mesh.indices.length / 3; t++) {
          const v = [0, 1, 2].map((i) => mesh.indices[t * 3 + i]);
          const p = v.map((i) => [
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
          ]);
          const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
          const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
          const nx = u[1] * w[2] - u[2] * w[1];
          const ny = u[2] * w[0] - u[0] * w[2];
          const nz = u[0] * w[1] - u[1] * w[0];
          const len = Math.hypot(nx, ny, nz);
          if (len < 1e-9 || Math.abs(ny / len) < 0.7) continue;
          horizontal++;
          if (ny < 0) down.push(key + '/' + piece + ' surface ' + String(mesh.data[v[0] * 4]));
        }
      }
    }
    expect(horizontal).toBeGreaterThan(100_000);
    expect(down).toEqual([]);
  });
});
