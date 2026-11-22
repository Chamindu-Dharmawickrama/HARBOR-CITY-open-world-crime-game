/**
 * Worker-safe mesh accumulation into plain typed arrays (no Three.js dependency), so chunk
 * geometry can be built in a Web Worker and transferred to the main thread without copies.
 *
 * Vertex layout (compact, to keep GPU uploads small while streaming): position f32×3,
 * normal i8×3 (normalised), uv f32×2, colour u8×3 (normalised), data f32×4 (material-specific).
 * Indices are 16-bit whenever the mesh has fewer than 65 536 vertices.
 */
export interface MeshData {
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  colors: Uint8Array;
  data: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** [minX, minY, minZ, maxX, maxY, maxZ] */
  bounds: Float32Array;
}

export function meshTransferables(mesh: MeshData): ArrayBuffer[] {
  return [mesh.positions, mesh.normals, mesh.uvs, mesh.colors, mesh.data, mesh.indices, mesh.bounds].map(
    (a) => a.buffer as ArrayBuffer,
  );
}

/** Signed-normalised byte encoding of unit-vector components. */
export function quantizeNormals(src: Float32Array): Int8Array {
  const out = new Int8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(src[i] * 127)));
  return out;
}

export function quantizeColors(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(src[i] * 255)));
  return out;
}

/** 16-bit indices when every vertex index fits, otherwise 32-bit. */
export function compactIndices(src: ArrayLike<number>, vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount < 65_536 ? Uint16Array.from(src) : Uint32Array.from(src);
}

class GrowableF32 {
  array: Float32Array;
  length = 0;
  constructor(initial: number) {
    this.array = new Float32Array(initial);
  }
  push3(a: number, b: number, c: number): void {
    this.reserve(3);
    const arr = this.array;
    arr[this.length++] = a;
    arr[this.length++] = b;
    arr[this.length++] = c;
  }
  push2(a: number, b: number): void {
    this.reserve(2);
    this.array[this.length++] = a;
    this.array[this.length++] = b;
  }
  push4(a: number, b: number, c: number, d: number): void {
    this.reserve(4);
    const arr = this.array;
    arr[this.length++] = a;
    arr[this.length++] = b;
    arr[this.length++] = c;
    arr[this.length++] = d;
  }
  private reserve(n: number): void {
    if (this.length + n <= this.array.length) return;
    const next = new Float32Array(Math.max(this.array.length * 2, this.length + n));
    next.set(this.array.subarray(0, this.length));
    this.array = next;
  }
  slice(): Float32Array {
    return this.array.slice(0, this.length);
  }
}

class GrowableU32 {
  array: Uint32Array;
  length = 0;
  constructor(initial: number) {
    this.array = new Uint32Array(initial);
  }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.array.length) {
      const next = new Uint32Array(Math.max(this.array.length * 2, this.length + 3));
      next.set(this.array.subarray(0, this.length));
      this.array = next;
    }
    this.array[this.length++] = a;
    this.array[this.length++] = b;
    this.array[this.length++] = c;
  }
  slice(): Uint32Array {
    return this.array.slice(0, this.length);
  }
}

export interface VertexAttributes {
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
  d0: number;
  d1: number;
  d2: number;
  d3: number;
}

export class MeshBuilder {
  private readonly positions = new GrowableF32(3 * 1024);
  private readonly normals = new GrowableF32(3 * 1024);
  private readonly uvs = new GrowableF32(2 * 1024);
  private readonly colors = new GrowableF32(3 * 1024);
  private readonly data = new GrowableF32(4 * 1024);
  private readonly indices = new GrowableU32(3 * 1024);
  private count = 0;
  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;

  /** Current attribute state applied to subsequently added vertices. */
  readonly attr: VertexAttributes = {
    nx: 0,
    ny: 1,
    nz: 0,
    u: 0,
    v: 0,
    r: 1,
    g: 1,
    b: 1,
    d0: 0,
    d1: 0,
    d2: 0,
    d3: 0,
  };

  get vertexCount(): number {
    return this.count;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  color(hex: number): this {
    this.attr.r = ((hex >> 16) & 255) / 255;
    this.attr.g = ((hex >> 8) & 255) / 255;
    this.attr.b = (hex & 255) / 255;
    return this;
  }

  setData(d0: number, d1 = 0, d2 = 0, d3 = 0): this {
    this.attr.d0 = d0;
    this.attr.d1 = d1;
    this.attr.d2 = d2;
    this.attr.d3 = d3;
    return this;
  }

  normal(nx: number, ny: number, nz: number): this {
    this.attr.nx = nx;
    this.attr.ny = ny;
    this.attr.nz = nz;
    return this;
  }

  /** Adds a vertex with the current attribute state; returns its index. */
  vertex(x: number, y: number, z: number, u = this.attr.u, v = this.attr.v): number {
    const a = this.attr;
    this.positions.push3(x, y, z);
    this.normals.push3(a.nx, a.ny, a.nz);
    this.uvs.push2(u, v);
    this.colors.push3(a.r, a.g, a.b);
    this.data.push4(a.d0, a.d1, a.d2, a.d3);
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    return this.count++;
  }

  /** Triangle with vertices in counter-clockwise order as seen from its front side. */
  triangle(a: number, b: number, c: number): void {
    this.indices.push3(a, b, c);
  }

  /** Quad a-b-c-d counter-clockwise as seen from the front (two triangles). */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push3(a, b, c);
    this.indices.push3(a, c, d);
  }

  /**
   * Vertical wall from (x0,z0) to (x1,z1) between heights yBottom..yTop, facing to the right of
   * the direction of travel (outward for a CCW-in-xz footprint). uv = (distance along, height).
   */
  wall(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y0Bottom: number,
    y0Top: number,
    y1Bottom: number,
    y1Top: number,
    uStart: number,
    vBase = 0,
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    this.normal(dz / len, 0, -dx / len);
    const uEnd = uStart + len;
    const a = this.vertex(x0, y0Bottom, z0, uStart, y0Bottom - vBase);
    const b = this.vertex(x1, y1Bottom, z1, uEnd, y1Bottom - vBase);
    const c = this.vertex(x1, y1Top, z1, uEnd, y1Top - vBase);
    const d = this.vertex(x0, y0Top, z0, uStart, y0Top - vBase);
    // (d - a) × (c - a) points along the outward normal (dz, 0, -dx).
    this.quad(a, d, c, b);
  }

  /**
   * Quad a-b-c-d that should face up; each triangle is emitted only if it really does. Offset
   * strips (sidewalks, ribbons) fold over themselves at tight concave bends — the folded sliver
   * is dropped instead of showing a downward face (neighbouring strips already cover the spot).
   */
  quadUp(a: number, b: number, c: number, d: number): void {
    if (this.faceUpY(a, b, c) > 0) this.indices.push3(a, b, c);
    if (this.faceUpY(a, c, d) > 0) this.indices.push3(a, c, d);
  }

  /** Y component of the (unnormalised) face normal of triangle a-b-c. */
  private faceUpY(a: number, b: number, c: number): number {
    const p = this.positions.array;
    const ux = p[b * 3] - p[a * 3];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const wx = p[c * 3] - p[a * 3];
    const wz = p[c * 3 + 2] - p[a * 3 + 2];
    return uz * wx - ux * wz;
  }

  /**
   * Upward-facing triangle from points that are counter-clockwise in x/z (the convention of
   * world/gen/geometry2d): their natural winding faces down, so it is reversed here.
   */
  upTriangle(a: number, b: number, c: number): void {
    this.indices.push3(a, c, b);
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  build(): MeshData {
    return {
      positions: this.positions.slice(),
      normals: quantizeNormals(this.normals.slice()),
      uvs: this.uvs.slice(),
      colors: quantizeColors(this.colors.slice()),
      data: this.data.slice(),
      indices: compactIndices(this.indices.slice(), this.count),
      bounds: new Float32Array(
        this.count === 0
          ? [0, 0, 0, 0, 0, 0]
          : [this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ],
      ),
    };
  }
}

/** Merges several meshes into one (indices rebased). */
export function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  let vertices = 0;
  let indices = 0;
  for (const m of meshes) {
    vertices += m.positions.length / 3;
    indices += m.indices.length;
  }
  const out: MeshData = {
    positions: new Float32Array(vertices * 3),
    normals: new Int8Array(vertices * 3),
    uvs: new Float32Array(vertices * 2),
    colors: new Uint8Array(vertices * 3),
    data: new Float32Array(vertices * 4),
    indices: vertices < 65_536 ? new Uint16Array(indices) : new Uint32Array(indices),
    bounds: new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
  };
  let vOffset = 0;
  let iOffset = 0;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    out.positions.set(m.positions, vOffset * 3);
    out.normals.set(m.normals, vOffset * 3);
    out.uvs.set(m.uvs, vOffset * 2);
    out.colors.set(m.colors, vOffset * 3);
    out.data.set(m.data, vOffset * 4);
    for (let i = 0; i < m.indices.length; i++) out.indices[iOffset + i] = m.indices[i] + vOffset;
    if (n > 0) {
      for (let k = 0; k < 3; k++) {
        out.bounds[k] = Math.min(out.bounds[k], m.bounds[k]);
        out.bounds[k + 3] = Math.max(out.bounds[k + 3], m.bounds[k + 3]);
      }
    }
    vOffset += n;
    iOffset += m.indices.length;
  }
  if (vertices === 0) out.bounds.fill(0);
  return out;
}
