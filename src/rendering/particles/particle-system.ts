import * as THREE from 'three';

export interface ParticleSpec {
  /** Start size (m) and growth per second (m/s). */
  size: number;
  growth: number;
  life: number;
  r: number;
  g: number;
  b: number;
  /** Start opacity; fades to 0 over the life. */
  alpha: number;
  /** Upward acceleration (+ = rises like smoke, − = falls like sparks). */
  buoyancy: number;
  /** Velocity damping per second. */
  drag: number;
}

const VERTEX = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = vColor.a * smoothstep(0.5, 0.1, d);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <fog_fragment>
}`;

/**
 * Pooled, CPU-simulated billboard particles drawn as one THREE.Points (soft round sprites, no
 * texture). One instance per blend mode: normal (smoke, dust, glass) and additive (fire, sparks).
 * Allocation-free per frame; the oldest particle is recycled when the pool is full.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private count = 0;
  private cursor = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  /** Per particle: age, life, growth, start alpha, buoyancy, drag. */
  private readonly sim: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly uniforms = { uScale: { value: 400 } };

  constructor(capacity: number, additive: boolean, name: string) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.sim = new Float32Array(capacity * 6);
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.uniforms]),
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // Keep a live reference to the merged uniform.
    this.uniforms.uScale = material.uniforms['uScale'] as { value: number };
    this.points = new THREE.Points(this.geometry, material);
    this.points.name = name;
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  get alive(): number {
    return this.count;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, spec: ParticleSpec): void {
    let i: number;
    if (this.count < this.capacity) i = this.count++;
    else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = spec.r;
    this.col[i * 4 + 1] = spec.g;
    this.col[i * 4 + 2] = spec.b;
    this.col[i * 4 + 3] = spec.alpha;
    this.size[i] = spec.size;
    const s = i * 6;
    this.sim[s] = 0;
    this.sim[s + 1] = spec.life;
    this.sim[s + 2] = spec.growth;
    this.sim[s + 3] = spec.alpha;
    this.sim[s + 4] = spec.buoyancy;
    this.sim[s + 5] = spec.drag;
  }

  /** Advances and uploads. `viewportHeight` and the camera FOV set the sprite scale. */
  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.uniforms.uScale.value = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    let i = 0;
    while (i < this.count) {
      const s = i * 6;
      const age = this.sim[s] + dt;
      const life = this.sim[s + 1];
      if (age >= life) {
        this.kill(i);
        continue;
      }
      this.sim[s] = age;
      const drag = Math.exp(-this.sim[s + 5] * dt);
      const p = i * 3;
      this.vel[p] = this.vel[p] * drag;
      this.vel[p + 1] = (this.vel[p + 1] + this.sim[s + 4] * dt) * drag;
      this.vel[p + 2] = this.vel[p + 2] * drag;
      this.pos[p] = this.pos[p] + this.vel[p] * dt;
      this.pos[p + 1] = this.pos[p + 1] + this.vel[p + 1] * dt;
      this.pos[p + 2] = this.pos[p + 2] + this.vel[p + 2] * dt;
      this.size[i] = Math.max(0.01, this.size[i] + this.sim[s + 2] * dt);
      const t = age / life;
      this.col[i * 4 + 3] = this.sim[s + 3] * (1 - t) * Math.min(1, t * 8 + 0.2);
      i++;
    }
    this.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Swap-remove particle i with the last live one. */
  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.size[i] = this.size[last];
    this.sim.copyWithin(i * 6, last * 6, last * 6 + 6);
  }
}

/** Ready-made looks. */
export const PARTICLES = {
  smoke: {
    size: 0.8,
    growth: 1.4,
    life: 2.6,
    r: 0.35,
    g: 0.35,
    b: 0.36,
    alpha: 0.45,
    buoyancy: 1.6,
    drag: 0.8,
  },
  blackSmoke: {
    size: 1.2,
    growth: 2.2,
    life: 3.5,
    r: 0.08,
    g: 0.08,
    b: 0.08,
    alpha: 0.6,
    buoyancy: 2.2,
    drag: 0.6,
  },
  fire: { size: 0.7, growth: 0.6, life: 0.55, r: 1.0, g: 0.45, b: 0.1, alpha: 0.9, buoyancy: 3.5, drag: 1.2 },
  flash: { size: 7, growth: 10, life: 0.3, r: 1.0, g: 0.85, b: 0.55, alpha: 1, buoyancy: 0, drag: 0 },
  fireball: { size: 2.5, growth: 6, life: 0.9, r: 1.0, g: 0.5, b: 0.12, alpha: 0.9, buoyancy: 3, drag: 2 },
  spark: {
    size: 0.12,
    growth: -0.05,
    life: 0.7,
    r: 1.0,
    g: 0.75,
    b: 0.3,
    alpha: 1,
    buoyancy: -9.8,
    drag: 0.3,
  },
  glass: {
    size: 0.07,
    growth: 0,
    life: 1.1,
    r: 0.75,
    g: 0.85,
    b: 0.9,
    alpha: 0.9,
    buoyancy: -9.8,
    drag: 0.4,
  },
  dust: {
    size: 0.5,
    growth: 1.2,
    life: 1.2,
    r: 0.55,
    g: 0.52,
    b: 0.48,
    alpha: 0.35,
    buoyancy: 0.4,
    drag: 2.5,
  },
} satisfies Record<string, ParticleSpec>;
