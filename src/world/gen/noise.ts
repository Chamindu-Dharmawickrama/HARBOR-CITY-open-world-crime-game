import { Rng } from '../../core/rng';

/** Seeded 2D gradient (Perlin-style) noise in roughly [-1, 1], plus fractal sums. */
export class Noise2D {
  private readonly perm = new Uint8Array(512);
  private readonly gradX = new Float32Array(256);
  private readonly gradZ = new Float32Array(256);

  constructor(seed: number | string) {
    const rng = new Rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    rng.shuffle(p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const angle = rng.range(0, Math.PI * 2);
      this.gradX[i] = Math.cos(angle);
      this.gradZ[i] = Math.sin(angle);
    }
  }

  /** Smooth noise at (x, z); value in about [-1, 1], zero at integer lattice points. */
  sample(x: number, z: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const ix = x0 & 255;
    const iz = z0 & 255;
    const g00 = this.dotGrad(ix, iz, fx, fz);
    const g10 = this.dotGrad(ix + 1, iz, fx - 1, fz);
    const g01 = this.dotGrad(ix, iz + 1, fx, fz - 1);
    const g11 = this.dotGrad(ix + 1, iz + 1, fx - 1, fz - 1);
    const u = fade(fx);
    const v = fade(fz);
    const a = g00 + (g10 - g00) * u;
    const b = g01 + (g11 - g01) * u;
    return (a + (b - a) * v) * 1.41421356;
  }

  /** Fractal Brownian motion: `octaves` layers, each at double frequency and `gain` amplitude. */
  fbm(x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.sample(x * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  private dotGrad(ix: number, iz: number, dx: number, dz: number): number {
    const h = this.perm[this.perm[ix & 255] + (iz & 255)];
    return this.gradX[h] * dx + this.gradZ[h] * dz;
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
