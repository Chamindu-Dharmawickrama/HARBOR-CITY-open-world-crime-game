import {
  distance,
  hypot,
  minAreaRect,
  normalize,
  perpendicular,
  pointInPolygon,
  sub,
  type Vec2,
} from './geometry2d';
import type { TerrainModel } from './islands';
import type { CityLayout, DistrictId } from './types';

export type ParkingKind = 'lot' | 'curb' | 'boat';

/** A place a vehicle can be parked: position on the ground, facing yaw (0 = +Z). */
export interface ParkingSpot {
  index: number;
  kind: ParkingKind;
  district: DistrictId | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Curb parking only on streets wide enough to keep a parking strip beside the traffic lane. */
const CURB_MIN_WIDTH = 9;
const CURB_SPACING = 6.6;
const CURB_INSET = 1.05;
const STALL_WIDTH = 2.7;
const STALL_DEPTH = 5.4;
const AISLE = 6.5;

function yawOf(dir: Vec2): number {
  return Math.atan2(dir.x, dir.z);
}

/**
 * Deterministic parking spots from the city layout: stall grids in parking lots (two rows
 * facing a central aisle, repeated), parallel spots along both curbs of wide streets between
 * junctions, and boat moorings beside piers.
 */
export function generateParkingSpots(layout: CityLayout, terrain: TerrainModel): ParkingSpot[] {
  const spots: ParkingSpot[] = [];
  const add = (
    kind: ParkingKind,
    district: DistrictId | null,
    x: number,
    z: number,
    yaw: number,
    y?: number,
  ): void => {
    spots.push({ index: spots.length, kind, district, x, y: y ?? terrain.heightAt(x, z), z, yaw });
  };

  // Lots.
  for (const lot of layout.lots) {
    if (lot.use !== 'parking') continue;
    const block = layout.blocks[lot.block];
    const box = minAreaRect(lot.polygon);
    const axis = box.axis;
    const across = perpendicular(axis);
    // Rows run along the long axis; stalls face across it.
    const rowPitch = STALL_DEPTH * 2 + AISLE;
    const rows = Math.max(1, Math.floor((box.halfWidth * 2 - 1) / rowPitch + 0.4));
    const stalls = Math.floor((box.halfLength * 2 - 2) / STALL_WIDTH);
    for (let r = 0; r < rows; r++) {
      const rowCentre = -box.halfWidth + 0.5 + (r + 0.5) * rowPitch;
      for (const side of [-1, 1]) {
        const offset = rowCentre + side * (AISLE / 2 + STALL_DEPTH / 2);
        if (Math.abs(offset) > box.halfWidth - STALL_DEPTH / 2) continue;
        for (let s = 0; s < stalls; s++) {
          const along = -box.halfLength + 1 + (s + 0.5) * STALL_WIDTH;
          const c = {
            x: box.center.x + axis.x * along + across.x * offset,
            z: box.center.z + axis.z * along + across.z * offset,
          };
          // The whole stall must lie in the lot.
          const corners = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map(([a, b]) => ({
            x: c.x + axis.x * a * STALL_WIDTH * 0.45 + across.x * b * STALL_DEPTH * 0.45,
            z: c.z + axis.z * a * STALL_WIDTH * 0.45 + across.z * b * STALL_DEPTH * 0.45,
          }));
          if (!corners.every((p) => pointInPolygon(p, lot.polygon))) continue;
          // Nose toward the aisle.
          const facing = { x: across.x * -side, z: across.z * -side };
          add('lot', block?.district ?? null, c.x, c.z, yawOf(facing));
        }
      }
    }
  }

  // Curbs.
  const trimAt = new Map<string, number>();
  for (const j of layout.junctions) for (const t of j.trims) trimAt.set(`${j.node}:${t.edge}`, t.distance);
  for (const edge of layout.edges) {
    if (edge.cls !== 'street' || edge.width < CURB_MIN_WIDTH) continue;
    const a = layout.nodes[edge.a];
    const b = layout.nodes[edge.b];
    if (!a || !b) continue;
    const len = distance(a, b);
    const start = (trimAt.get(`${edge.a}:${edge.id}`) ?? 0) + 7;
    const end = len - (trimAt.get(`${edge.b}:${edge.id}`) ?? 0) - 7;
    if (end - start < CURB_SPACING) continue;
    const dir = normalize(sub(b, a));
    const right = perpendicular(dir);
    const offset = edge.width / 2 - CURB_INSET;
    for (let d = start + CURB_SPACING / 2; d <= end - CURB_SPACING / 2; d += CURB_SPACING) {
      const t = d / len;
      const y = a.y + (b.y - a.y) * t;
      const px = a.x + dir.x * d;
      const pz = a.z + dir.z * d;
      // Right-hand traffic: cars on the right of a→b face a→b, on the left they face b→a.
      add('curb', edge.district, px + right.x * offset, pz + right.z * offset, yawOf(dir), y);
      add(
        'curb',
        edge.district,
        px - right.x * offset,
        pz - right.z * offset,
        yawOf({ x: -dir.x, z: -dir.z }),
        y,
      );
    }
  }

  // Boat moorings beside piers (on the water, parallel to the pier's long side).
  for (const pier of layout.piers) {
    const box = minAreaRect(pier.polygon);
    const across = perpendicular(box.axis);
    for (const side of [-1, 1]) {
      const off = box.halfWidth + 3.2;
      const x = box.center.x + across.x * off * side;
      const z = box.center.z + across.z * off * side;
      if (terrain.isLand(x, z) || hypot(box.halfLength, 0) < 6) continue;
      add('boat', null, x, z, yawOf(box.axis), terrain.waterLevel);
    }
  }
  return spots;
}
