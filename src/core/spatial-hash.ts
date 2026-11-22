/**
 * Uniform-grid spatial hash on the XZ plane for proximity queries.
 * Items are identified by an integer slot in [0, capacity) — typically an entity index.
 * Queries write into a caller-owned array (no per-query allocation once it has grown).
 */
export class SpatialHash2D {
  private readonly cells = new Map<number, number[]>();
  private readonly minCX: Int32Array;
  private readonly minCZ: Int32Array;
  private readonly maxCX: Int32Array;
  private readonly maxCZ: Int32Array;
  private readonly bounds: Float32Array;
  private readonly present: Uint8Array;
  private readonly stamps: Uint32Array;
  private stamp = 0;
  private count = 0;
  private readonly inverseCell: number;

  constructor(
    readonly cellSize: number,
    readonly capacity: number,
  ) {
    if (cellSize <= 0) throw new Error('SpatialHash2D: cellSize must be > 0');
    this.inverseCell = 1 / cellSize;
    this.minCX = new Int32Array(capacity);
    this.minCZ = new Int32Array(capacity);
    this.maxCX = new Int32Array(capacity);
    this.maxCZ = new Int32Array(capacity);
    this.bounds = new Float32Array(capacity * 4);
    this.present = new Uint8Array(capacity);
    this.stamps = new Uint32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  has(slot: number): boolean {
    return this.present[slot] === 1;
  }

  insertPoint(slot: number, x: number, z: number): void {
    this.insert(slot, x, z, x, z);
  }

  insert(slot: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    if (slot < 0 || slot >= this.capacity) throw new Error(`SpatialHash2D: slot ${slot} out of range`);
    if (this.present[slot] === 1) {
      this.update(slot, minX, minZ, maxX, maxZ);
      return;
    }
    this.present[slot] = 1;
    this.count++;
    this.writeBounds(slot, minX, minZ, maxX, maxZ);
    this.minCX[slot] = this.cellOf(minX);
    this.minCZ[slot] = this.cellOf(minZ);
    this.maxCX[slot] = this.cellOf(maxX);
    this.maxCZ[slot] = this.cellOf(maxZ);
    this.addToCells(slot);
  }

  updatePoint(slot: number, x: number, z: number): void {
    this.update(slot, x, z, x, z);
  }

  update(slot: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    if (this.present[slot] !== 1) {
      this.insert(slot, minX, minZ, maxX, maxZ);
      return;
    }
    this.writeBounds(slot, minX, minZ, maxX, maxZ);
    const nMinCX = this.cellOf(minX);
    const nMinCZ = this.cellOf(minZ);
    const nMaxCX = this.cellOf(maxX);
    const nMaxCZ = this.cellOf(maxZ);
    if (
      nMinCX === this.minCX[slot] &&
      nMinCZ === this.minCZ[slot] &&
      nMaxCX === this.maxCX[slot] &&
      nMaxCZ === this.maxCZ[slot]
    ) {
      return;
    }
    this.removeFromCells(slot);
    this.minCX[slot] = nMinCX;
    this.minCZ[slot] = nMinCZ;
    this.maxCX[slot] = nMaxCX;
    this.maxCZ[slot] = nMaxCZ;
    this.addToCells(slot);
  }

  remove(slot: number): void {
    if (this.present[slot] !== 1) return;
    this.removeFromCells(slot);
    this.present[slot] = 0;
    this.count--;
  }

  clear(): void {
    for (const list of this.cells.values()) list.length = 0;
    this.present.fill(0);
    this.count = 0;
  }

  /** Slots whose AABB overlaps the query rectangle. Returns the number written to `out`. */
  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number {
    out.length = 0;
    const stamp = this.nextStamp();
    const cx0 = this.cellOf(minX);
    const cz0 = this.cellOf(minZ);
    const cx1 = this.cellOf(maxX);
    const cz1 = this.cellOf(maxZ);
    const b = this.bounds;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const slot = list[i];
          if (this.stamps[slot] === stamp) continue;
          this.stamps[slot] = stamp;
          const o = slot * 4;
          if (b[o] > maxX || b[o + 2] < minX) continue;
          if (b[o + 1] > maxZ || b[o + 3] < minZ) continue;
          out.push(slot);
        }
      }
    }
    return out.length;
  }

  /** Slots whose AABB intersects the circle (x, z, radius). */
  queryRadius(x: number, z: number, radius: number, out: number[]): number {
    this.queryRect(x - radius, z - radius, x + radius, z + radius, out);
    const b = this.bounds;
    const r2 = radius * radius;
    let write = 0;
    for (let i = 0; i < out.length; i++) {
      const slot = out[i];
      const o = slot * 4;
      const nx = Math.max(b[o], Math.min(x, b[o + 2]));
      const nz = Math.max(b[o + 1], Math.min(z, b[o + 3]));
      const dx = nx - x;
      const dz = nz - z;
      if (dx * dx + dz * dz <= r2) out[write++] = slot;
    }
    out.length = write;
    return write;
  }

  private nextStamp(): number {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.stamps.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  private cellOf(value: number): number {
    return Math.floor(value * this.inverseCell);
  }

  private writeBounds(slot: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const o = slot * 4;
    this.bounds[o] = Math.min(minX, maxX);
    this.bounds[o + 1] = Math.min(minZ, maxZ);
    this.bounds[o + 2] = Math.max(minX, maxX);
    this.bounds[o + 3] = Math.max(minZ, maxZ);
  }

  private addToCells(slot: number): void {
    for (let cx = this.minCX[slot]; cx <= this.maxCX[slot]; cx++) {
      for (let cz = this.minCZ[slot]; cz <= this.maxCZ[slot]; cz++) {
        const key = cellKey(cx, cz);
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(slot);
      }
    }
  }

  private removeFromCells(slot: number): void {
    for (let cx = this.minCX[slot]; cx <= this.maxCX[slot]; cx++) {
      for (let cz = this.minCZ[slot]; cz <= this.maxCZ[slot]; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        const index = list.indexOf(slot);
        if (index >= 0) {
          list[index] = list[list.length - 1];
          list.pop();
        }
      }
    }
  }
}

/** Packs signed cell coordinates (±32767) into one non-negative integer key. */
function cellKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}
