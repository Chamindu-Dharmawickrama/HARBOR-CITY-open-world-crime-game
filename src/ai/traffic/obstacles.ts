import { SpatialHash2D } from '../../core/spatial-hash';

/** Something on or near the road that traffic must not hit (the player, a person, a stray car). */
export interface TrafficObstacle {
  x: number;
  y: number;
  z: number;
  radius: number;
  vx: number;
  vz: number;
  /** A vehicle (honk at it) rather than a person (wait patiently). */
  vehicle: boolean;
}

/** Per-tick set of obstacles with a spatial index; rebuilt by the owner every fixed step. */
export class ObstacleField {
  readonly items: TrafficObstacle[] = [];
  count = 0;
  private readonly hash: SpatialHash2D;
  private readonly found: number[] = [];

  constructor(readonly capacity = 512) {
    this.hash = new SpatialHash2D(16, capacity);
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) this.hash.remove(i);
    this.count = 0;
  }

  add(x: number, y: number, z: number, radius: number, vx: number, vz: number, vehicle: boolean): void {
    if (this.count >= this.capacity) return;
    let o = this.items[this.count];
    if (!o) {
      o = { x: 0, y: 0, z: 0, radius: 0, vx: 0, vz: 0, vehicle: false };
      this.items.push(o);
    }
    o.x = x;
    o.y = y;
    o.z = z;
    o.radius = radius;
    o.vx = vx;
    o.vz = vz;
    o.vehicle = vehicle;
    this.hash.insert(this.count, x - radius, z - radius, x + radius, z + radius);
    this.count++;
  }

  /** Obstacle indices within `radius` of (x, z); the array is reused by the next call. */
  near(x: number, z: number, radius: number): readonly number[] {
    this.hash.queryRect(x - radius, z - radius, x + radius, z + radius, this.found);
    return this.found;
  }
}
