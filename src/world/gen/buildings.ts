import type { Rng, RngStreams } from '../../core/rng';
import {
  hypot,
  add,
  area,
  centroid,
  convexHull,
  distance,
  insetPolygon,
  isConvex,
  minAreaRect,
  normalize,
  orientedRect,
  pointInPolygon,
  pointSegmentDistance,
  scale,
  sub,
  type Polygon,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import { BILLBOARD_FACE_HEIGHT } from './props';
import type {
  Block,
  BuildingSpec,
  BuildingTier,
  CityDef,
  DistrictDef,
  FacadeStyleName,
  Lot,
  RoofKind,
  SignSpec,
} from './types';

const BAY_WIDTH: Record<FacadeStyleName, readonly [number, number]> = {
  glass: [1.6, 2.2],
  office: [2.4, 3.2],
  brick: [2.8, 3.6],
  shopfront: [3.2, 4.2],
  industrial: [5, 8],
  house: [3, 4],
};

export interface BuildingBuildResult {
  buildings: BuildingSpec[];
  signs: SignSpec[];
}

export function buildBuildings(
  lots: readonly Lot[],
  blocks: readonly Block[],
  city: CityDef,
  terrain: TerrainModel,
  rngs: RngStreams,
): BuildingBuildResult {
  const buildings: BuildingSpec[] = [];
  const signs: SignSpec[] = [];
  const businessCount = city.businessNames.length;
  for (const lot of lots) {
    if (lot.use === 'parking' || lot.use === 'yard' || lot.use === 'park' || lot.use === 'plaza') continue;
    const block = blocks[lot.block];
    const def = terrain.district(block.district);
    const rng = rngs.get(`buildings:${def.id}`);
    const spec = makeBuilding(lot, def, terrain, rng, buildings.length);
    if (!spec) continue;
    buildings.push(spec);
    const wantsSign =
      spec.style === 'shopfront' || (spec.style !== 'house' && def.id === 'meridian' && rng.chance(0.35));
    if (wantsSign && businessCount > 0) {
      const sign = frontSign(spec, block, rng.int(0, businessCount), signs.length);
      if (sign) {
        spec.sign = sign.atlas;
        signs.push(sign);
      }
    }
    if (
      spec.roof === 'flat' &&
      spec.height > 10 &&
      spec.height < 48 &&
      rng.chance(def.props.billboardChance)
    ) {
      const slogan = rng.int(0, city.billboardSlogans.length);
      signs.push(roofBillboard(spec, block, businessCount + slogan, signs.length));
    }
  }
  return { buildings, signs };
}

function makeBuilding(
  lot: Lot,
  def: DistrictDef,
  terrain: TerrainModel,
  rng: Rng,
  id: number,
): BuildingSpec | null {
  const rules = def.buildings;
  const setback = rng.range(rules.setback[0], rules.setback[1]);
  let footprint = insetPolygon(lot.polygon, setback) ?? insetPolygon(lot.polygon, 0.5);
  if (!footprint) return null;
  if (!isConvex(footprint)) {
    const hull = convexHull(footprint);
    if (!hull.every((p) => pointInPolygon(p, lot.polygon))) return null;
    footprint = hull;
  }
  if (lot.use === 'house') footprint = houseFootprint(footprint, rng);
  if (!footprint || area(footprint) < 36) return null;

  const style = pickStyle(def, lot.use, rng);
  const floorHeight = style === 'industrial' ? rules.floorHeight : rules.floorHeight * rng.range(0.95, 1.08);
  let height: number;
  let roof: RoofKind = 'flat';
  const tiers: BuildingTier[] = [];
  switch (lot.use) {
    case 'tower': {
      const [cx, cz] = def.island.center;
      const c = centroid(footprint);
      const core = Math.max(0, 1 - hypot(c.x - cx, c.z - cz) / Math.max(1, rules.towerRadius));
      height =
        rules.towerHeight[0] +
        (rules.towerHeight[1] - rules.towerHeight[0]) * Math.pow(core, 0.7) * rng.range(0.55, 1);
      const podium = Math.min(height * 0.18, rng.range(12, 20));
      tiers.push({ footprint, top: snapFloors(podium, floorHeight) });
      const shaft = insetPolygon(footprint, rng.range(2, 5));
      if (shaft && area(shaft) > 120) {
        const shaftTop = snapFloors(height * rng.range(0.8, 0.92), floorHeight);
        tiers.push({ footprint: shaft, top: shaftTop });
        const crown = insetPolygon(shaft, rng.range(1.5, 3.5));
        if (crown && area(crown) > 60) tiers.push({ footprint: crown, top: snapFloors(height, floorHeight) });
        else tiers[1].top = snapFloors(height, floorHeight);
      } else {
        tiers[0].top = snapFloors(height, floorHeight);
      }
      break;
    }
    case 'midrise': {
      height = snapFloors(rng.range(rules.height[0], rules.height[1]), floorHeight);
      if (height > 28 && rng.chance(0.4)) {
        const top = insetPolygon(footprint, 2.5);
        if (top && area(top) > 60) {
          tiers.push({ footprint, top: height - floorHeight * 2 }, { footprint: top, top: height });
          break;
        }
      }
      tiers.push({ footprint, top: height });
      break;
    }
    case 'shop':
      height = floorHeight * rng.int(1, 3) + 0.8;
      tiers.push({ footprint, top: height });
      break;
    case 'warehouse':
      height = rng.range(rules.height[0], rules.height[1]);
      roof = rng.chance(0.35) ? 'sawtooth' : 'flat';
      tiers.push({ footprint, top: height });
      break;
    case 'house':
      height = floorHeight * rng.int(1, 3);
      roof = 'gable';
      tiers.push({ footprint, top: height });
      break;
    case 'park':
    case 'plaza':
    case 'parking':
    case 'yard':
      return null;
  }
  height = tiers[tiers.length - 1].top;

  let baseY = Infinity;
  for (const p of footprint) baseY = Math.min(baseY, terrain.heightAt(p.x, p.z));
  const c = centroid(footprint);
  baseY = Math.min(baseY, terrain.heightAt(c.x, c.z)) - 0.3;
  return {
    id,
    lot: lot.id,
    district: def.id,
    baseY,
    tiers,
    height,
    roof,
    style,
    color: rng.pick(rules.palette),
    roofColor: rng.pick(rules.roofPalette),
    floorHeight,
    bayWidth: rng.range(BAY_WIDTH[style][0], BAY_WIDTH[style][1]),
    seed: rng.nextU32() & 0xffff,
    sign: -1,
    center: c,
  };
}

function snapFloors(height: number, floorHeight: number): number {
  return Math.max(floorHeight, Math.round(height / floorHeight) * floorHeight);
}

function pickStyle(def: DistrictDef, use: Lot['use'], rng: Rng): FacadeStyleName {
  if (use === 'house') return 'house';
  if (use === 'shop') return 'shopfront';
  if (use === 'warehouse') return rng.chance(0.85) ? 'industrial' : 'brick';
  if (use === 'tower') return rng.chance(0.55) ? 'glass' : 'office';
  const entries = Object.entries(def.buildings.styles) as [FacadeStyleName, number][];
  const filtered = entries.filter(([s]) => s !== 'house' && s !== 'industrial');
  if (filtered.length === 0) return 'office';
  return rng.pickWeighted(
    filtered.map(([s]) => s),
    filtered.map(([, w]) => w),
  );
}

/**
 * A rectangular house aligned with the lot, centred on the lot's centroid and shrunk until it
 * fits entirely inside the available area (irregular lots can't hold a full-size box).
 */
function houseFootprint(available: Polygon, rng: Rng): Polygon | null {
  const box = minAreaRect(available);
  const center = centroid(available);
  let halfLength = Math.min(box.halfLength, rng.range(5, 8));
  let halfWidth = Math.min(box.halfWidth, rng.range(4, 5.5));
  for (let attempt = 0; attempt < 6; attempt++) {
    const rect = orientedRect(center, box.axis, halfLength, halfWidth);
    if (rect.every((p) => pointInPolygon(p, available))) return rect;
    halfLength *= 0.85;
    halfWidth *= 0.85;
  }
  return null;
}

/** Index of the footprint edge closest to the block curb (the street-facing side). */
function frontageEdge(footprint: Polygon, block: Block): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % footprint.length];
    if (distance(a, b) < 3) continue;
    const mid = scale(add(a, b), 0.5);
    let d = Infinity;
    for (let j = 0; j < block.curb.length; j++) {
      d = Math.min(
        d,
        pointSegmentDistance(mid, block.curb[j], block.curb[(j + 1) % block.curb.length]).distance,
      );
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Outward normal of a CCW polygon edge a→b (right-hand side). */
function outwardNormal(a: Vec2, b: Vec2): Vec2 {
  const d = normalize(sub(b, a));
  return { x: d.z, z: -d.x };
}

function frontSign(spec: BuildingSpec, block: Block, atlas: number, id: number): SignSpec | null {
  const footprint = spec.tiers[0].footprint;
  const i = frontageEdge(footprint, block);
  const a = footprint[i];
  const b = footprint[(i + 1) % footprint.length];
  const len = distance(a, b);
  if (len < 4) return null;
  const n = outwardNormal(a, b);
  const mid = add(scale(add(a, b), 0.5), scale(n, 0.12));
  return {
    id,
    x: mid.x,
    y: spec.baseY + 0.3 + Math.min(spec.floorHeight * 0.82, spec.tiers[0].top - 0.8),
    z: mid.z,
    rotY: Math.atan2(n.x, n.z),
    width: Math.min(len * 0.7, 7),
    height: 1.1,
    atlas,
    billboard: false,
  };
}

function roofBillboard(spec: BuildingSpec, block: Block, atlas: number, id: number): SignSpec {
  const top = spec.tiers[spec.tiers.length - 1];
  const i = frontageEdge(top.footprint, block);
  const a = top.footprint[i];
  const b = top.footprint[(i + 1) % top.footprint.length];
  const n = outwardNormal(a, b);
  const mid = add(scale(add(a, b), 0.5), scale(n, -1.5));
  return {
    id,
    x: mid.x,
    y: spec.baseY + top.top + BILLBOARD_FACE_HEIGHT,
    z: mid.z,
    rotY: Math.atan2(n.x, n.z),
    width: 12,
    height: 4,
    atlas,
    billboard: true,
  };
}
