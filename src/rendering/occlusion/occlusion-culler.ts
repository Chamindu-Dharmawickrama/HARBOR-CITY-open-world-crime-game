const TILE = 8;
const NEAR_W = 0.5;

/** Index triples for the 12 triangles of a box with corners ordered by (x, y, z) bits. */
const BOX_TRIANGLES = [
  0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3,
];

/**
 * Software occlusion culling. Large occluders (building boxes known to be inside the real
 * geometry) are rasterised into a small depth buffer storing view depth (clip w). Each
 * occluder triangle writes its FARTHEST vertex depth, so the buffer never claims an occluder is
 * nearer than it is — culling is conservative (may keep hidden things, never hides visible
 * ones). A per-tile max-depth level makes most tests O(tiles).
 */
export class OcclusionCuller {
  readonly depth: Float32Array;
  private readonly tileMax: Float32Array;
  private readonly tilesX: number;
  private readonly tilesY: number;
  private readonly vp = new Float32Array(16);
  private readonly sx = new Float32Array(8);
  private readonly sy = new Float32Array(8);
  private readonly sw = new Float32Array(8);
  occluders = 0;
  tested = 0;
  culled = 0;

  constructor(
    readonly width = 256,
    readonly height = 128,
  ) {
    this.depth = new Float32Array(width * height);
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    this.tileMax = new Float32Array(this.tilesX * this.tilesY);
  }

  /** Starts a frame with a column-major view-projection matrix (Three.js `elements` layout). */
  begin(viewProjection: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) this.vp[i] = viewProjection[i];
    this.depth.fill(Infinity);
    this.occluders = 0;
    this.tested = 0;
    this.culled = 0;
  }

  /** Adds an oriented box occluder: footprint centre, half extents along a unit axis, y range. */
  addOccluder(
    cx: number,
    cz: number,
    axisX: number,
    axisZ: number,
    halfLength: number,
    halfWidth: number,
    y0: number,
    y1: number,
  ): void {
    const px = -axisZ;
    const pz = axisX;
    for (let i = 0; i < 8; i++) {
      const sl = i & 1 ? 1 : -1;
      const sh = i & 2 ? 1 : -1;
      const sw = i & 4 ? 1 : -1;
      this.project(
        i,
        cx + axisX * halfLength * sl + px * halfWidth * sw,
        sh > 0 ? y1 : y0,
        cz + axisZ * halfLength * sl + pz * halfWidth * sw,
      );
    }
    let drawn = false;
    for (let t = 0; t < BOX_TRIANGLES.length; t += 3) {
      if (this.rasterize(BOX_TRIANGLES[t], BOX_TRIANGLES[t + 1], BOX_TRIANGLES[t + 2])) drawn = true;
    }
    if (drawn) this.occluders++;
  }

  /** Builds the coarse max-depth tiles. Call after all occluders, before testing. */
  finish(): void {
    const { width, height, depth } = this;
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        let max = 0;
        const x1 = Math.min(width, (tx + 1) * TILE);
        const y1 = Math.min(height, (ty + 1) * TILE);
        for (let y = ty * TILE; y < y1; y++) {
          for (let x = tx * TILE; x < x1; x++) {
            const d = depth[y * width + x];
            if (d > max) max = d;
          }
        }
        this.tileMax[ty * this.tilesX + tx] = max;
      }
    }
  }

  /** True if the axis-aligned box is completely hidden behind occluders. */
  isOccluded(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    this.tested++;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let nearest = Infinity;
    for (let i = 0; i < 8; i++) {
      this.project(i, i & 1 ? maxX : minX, i & 2 ? maxY : minY, i & 4 ? maxZ : minZ);
      const w = this.sw[i];
      if (w < NEAR_W) return false;
      nearest = Math.min(nearest, w);
      x0 = Math.min(x0, this.sx[i]);
      x1 = Math.max(x1, this.sx[i]);
      y0 = Math.min(y0, this.sy[i]);
      y1 = Math.max(y1, this.sy[i]);
    }
    const px0 = Math.max(0, Math.floor(x0));
    const py0 = Math.max(0, Math.floor(y0));
    const px1 = Math.min(this.width - 1, Math.floor(x1));
    const py1 = Math.min(this.height - 1, Math.floor(y1));
    if (px0 > px1 || py0 > py1) return false; // off-screen: leave it to frustum culling
    // Any part of the box beyond the screen edge cannot be proven hidden.
    if (x0 < 0 || y0 < 0 || x1 >= this.width || y1 >= this.height) return false;
    const tx0 = Math.floor(px0 / TILE);
    const ty0 = Math.floor(py0 / TILE);
    const tx1 = Math.floor(px1 / TILE);
    const ty1 = Math.floor(py1 / TILE);
    let allTilesCloser = true;
    for (let ty = ty0; ty <= ty1 && allTilesCloser; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (this.tileMax[ty * this.tilesX + tx] >= nearest) {
          allTilesCloser = false;
          break;
        }
      }
    }
    if (!allTilesCloser) {
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          if (this.depth[y * this.width + x] >= nearest) return false;
        }
      }
    }
    this.culled++;
    return true;
  }

  private project(i: number, x: number, y: number, z: number): void {
    const m = this.vp;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    this.sw[i] = cw;
    const inv = cw > 1e-6 ? 1 / cw : 0;
    this.sx[i] = (cx * inv * 0.5 + 0.5) * this.width;
    this.sy[i] = (1 - (cy * inv * 0.5 + 0.5)) * this.height;
  }

  private rasterize(a: number, b: number, c: number): boolean {
    const wa = this.sw[a];
    const wb = this.sw[b];
    const wc = this.sw[c];
    if (wa < NEAR_W || wb < NEAR_W || wc < NEAR_W) return false;
    const ax = this.sx[a];
    const ay = this.sy[a];
    const bx = this.sx[b];
    const by = this.sy[b];
    const cx = this.sx[c];
    const cy = this.sy[c];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) return false;
    const sign = area > 0 ? 1 : -1;
    const depth = Math.max(wa, wb, wc);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) return false;
    let wrote = false;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign;
        const e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign;
        const e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const idx = y * this.width + x;
        if (depth < this.depth[idx]) {
          this.depth[idx] = depth;
          wrote = true;
        }
      }
    }
    return wrote;
  }
}
