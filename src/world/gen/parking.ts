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
import { CURB_PARKING_INSET, hasCurbParking } from './road-profile';
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

const CURB_SPACING = 6.6;
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

  // Curbs (never where another road's carriageway passes, e.g. beside a junction cluster).
  const onOtherRoad = (x: number, z: number, own: number): boolean => {
    for (const other of layout.edges) {
      if (other.id === own) continue;
      const a = layout.nodes[other.a];
      const b = layout.nodes[other.b];
      if (!a || !b) continue;
      const reach = other.width / 2 + 1.2;
      if (x < Math.min(a.x, b.x) - reach || x > Math.max(a.x, b.x) + reach) continue;
      if (z < Math.min(a.z, b.z) - reach || z > Math.max(a.z, b.z) + reach) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
      if (hypot(x - a.x - dx * t, z - a.z - dz * t) < reach) return true;
    }
    return false;
  };
  const trimAt = new Map<string, number>();
  for (const j of layout.junctions) for (const t of j.trims) trimAt.set(`${j.node}:${t.edge}`, t.distance);
  for (const edge of layout.edges) {
    // Curb parking only where the street keeps a parking strip beside its traffic lanes.
    if (!hasCurbParking(edge.cls, edge.width)) continue;
    const a = layout.nodes[edge.a];
    const b = layout.nodes[edge.b];
    if (!a || !b) continue;
    const len = distance(a, b);
    const start = (trimAt.get(`${edge.a}:${edge.id}`) ?? 0) + 7;
    const end = len - (trimAt.get(`${edge.b}:${edge.id}`) ?? 0) - 7;
    if (end - start < CURB_SPACING) continue;
    const dir = normalize(sub(b, a));
    const right = perpendicular(dir);
    const offset = edge.width / 2 - CURB_PARKING_INSET;
    for (let d = start + CURB_SPACING / 2; d <= end - CURB_SPACING / 2; d += CURB_SPACING) {
      const t = d / len;
      const y = a.y + (b.y - a.y) * t;
      const px = a.x + dir.x * d;
      const pz = a.z + dir.z * d;
      // Right-hand traffic: cars on the right of a→b face a→b, on the left they face b→a.
      const rx = px + right.x * offset;
      const rz = pz + right.z * offset;
      if (!onOtherRoad(rx, rz, edge.id)) add('curb', edge.district, rx, rz, yawOf(dir), y);
      const lx = px - right.x * offset;
      const lz = pz - right.z * offset;
      if (!onOtherRoad(lx, lz, edge.id))
        add('curb', edge.district, lx, lz, yawOf({ x: -dir.x, z: -dir.z }), y);
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
