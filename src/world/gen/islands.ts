import { smoothstep } from '../../core/math';
import { ensureCCW, pointInPolygon, type Polygon, type Vec2 } from './geometry2d';
import { Noise2D } from './noise';
import type { CityDef, DistrictDef, DistrictId, IslandShape } from './types';

const COAST_VERTICES = 288;
/** Sea floor height used for points that are not on any island. */
export const SEA_FLOOR = -8;

/** Superellipse coastline with low-frequency radial noise (seamless around the loop). */
export function generateCoastline(def: DistrictDef, seed: number): Polygon {
  const { center, halfSize, exponent, rotation, coastNoise } = def.island;
  const noise = new Noise2D(`${seed}:coast:${def.id}`);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points: Polygon = [];
  for (let i = 0; i < COAST_VERTICES; i++) {
    const theta = (i / COAST_VERTICES) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const ex = 2 / exponent;
    const lx = halfSize[0] * Math.sign(c) * Math.pow(Math.abs(c), ex);
    const lz = halfSize[1] * Math.sign(s) * Math.pow(Math.abs(s), ex);
    const wobble = 1 + coastNoise * noise.fbm(c * 1.7 + 11.3, s * 1.7 + 4.1, 4);
    const x = lx * wobble;
    const z = lz * wobble;
    points.push({ x: center[0] + x * cos - z * sin, z: center[1] + x * sin + z * cos });
  }
  return ensureCCW(points);
}

export function islandShape(def: DistrictDef, seed: number): IslandShape {
  const coast = generateCoastline(def, seed);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of coast) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { district: def.id, coast, bounds: { minX, minZ, maxX, maxZ } };
}

interface IslandRuntime {
  def: DistrictDef;
  shape: IslandShape;
  hills: Noise2D;
  cos: number;
  sin: number;
  /** Superellipse radius below which a point is certainly inland (accounts for coast noise). */
  safeRho: number;
}

/**
 * Analytic ground height and land membership for the whole city. Heights are smooth, fade to
 * the island base height near the coast, and are identical everywhere they are sampled
 * (terrain, roads, buildings, colliders), so nothing floats or sinks.
 */
export class TerrainModel {
  private readonly islands: IslandRuntime[];

  constructor(
    readonly city: CityDef,
    shapes: readonly IslandShape[],
    seed: number,
  ) {
    this.islands = city.districts.map((def) => {
      const shape = shapes.find((s) => s.district === def.id);
      if (!shape) throw new Error(`TerrainModel: missing island for ${def.id}`);
      return {
        def,
        shape,
        hills: new Noise2D(`${seed}:hills:${def.id}`),
        cos: Math.cos(-def.island.rotation),
        sin: Math.sin(-def.island.rotation),
        safeRho: 1 - def.island.coastNoise * 1.6 - 0.02,
      };
    });
  }

  get waterLevel(): number {
    return this.city.waterLevel;
  }

  /** Normalised superellipse radius: < 1 inside the un-noised island outline. */
  private rho(island: IslandRuntime, x: number, z: number): number {
    const { center, halfSize, exponent } = island.def.island;
    const dx = x - center[0];
    const dz = z - center[1];
    const lx = (dx * island.cos - dz * island.sin) / halfSize[0];
    const lz = (dx * island.sin + dz * island.cos) / halfSize[1];
    return Math.pow(Math.pow(Math.abs(lx), exponent) + Math.pow(Math.abs(lz), exponent), 1 / exponent);
  }

  private islandRuntimeAt(x: number, z: number): IslandRuntime | null {
    for (const island of this.islands) {
      const b = island.shape.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const r = this.rho(island, x, z);
      if (r < island.safeRho) return island;
      if (r > 1.2) continue;
      if (pointInPolygon({ x, z }, island.shape.coast)) return island;
    }
    return null;
  }

  districtAt(x: number, z: number): DistrictId | null {
    return this.islandRuntimeAt(x, z)?.def.id ?? null;
  }

  district(id: DistrictId): DistrictDef {
    const island = this.islands.find((i) => i.def.id === id);
    if (!island) throw new Error(`Unknown district ${id}`);
    return island.def;
  }

  isLand(x: number, z: number): boolean {
    return this.islandRuntimeAt(x, z) !== null;
  }

  /** Ground height ignoring land membership (useful just outside the coast, e.g. piers). */
  landHeightFor(id: DistrictId, x: number, z: number): number {
    const island = this.islands.find((i) => i.def.id === id) as IslandRuntime;
    const { baseHeight, hillHeight, hillScale } = island.def.island;
    if (hillHeight <= 0) return baseHeight;
    const inland = smoothstep(0.98, 0.72, this.rho(island, x, z));
    const n = island.hills.fbm(x * hillScale, z * hillScale, 3);
    return baseHeight + hillHeight * inland * Math.max(0, 0.5 + 0.75 * n);
  }

  heightAt(x: number, z: number): number {
    const island = this.islandRuntimeAt(x, z);
    if (!island) return SEA_FLOOR;
    return this.landHeightFor(island.def.id, x, z);
  }

  /** Base (coastal) height of the island containing p, or the water level. */
  baseHeightAt(p: Vec2): number {
    const island = this.islandRuntimeAt(p.x, p.z);
    return island ? island.def.island.baseHeight : this.city.waterLevel;
  }
}
