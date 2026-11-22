import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropType } from '../gen/types';

/** Emissive channel values: 0 none, 1 lit at night, 2 always lit. */
const NIGHT = 1;
const ALWAYS = 2;

interface Part {
  geometry: THREE.BufferGeometry;
  color: number;
  emissive?: number;
}

function paint(part: Part): THREE.BufferGeometry {
  // Every part must be indexed: mergeGeometries and BatchedMesh need a consistent layout, and
  // some primitives (polyhedra) come without an index.
  const g = part.geometry;
  const count = g.getAttribute('position').count;
  if (!g.index) g.setIndex(Array.from({ length: count }, (_, i) => i));
  const color = new THREE.Color(part.color);
  const colors = new Float32Array(count * 3);
  const emissive = new Float32Array(count).fill(part.emissive ?? 0);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aEmissive', new THREE.BufferAttribute(emissive, 1));
  g.deleteAttribute('uv');
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  x: number,
  y: number,
  z: number,
  segments = 8,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, segments).translate(x, y, z);
}

/** Cylinder rotated by (rx, rz) about its own centre, then moved to (x, y, z). */
function cylAt(
  r: number,
  h: number,
  rx: number,
  rz: number,
  x: number,
  y: number,
  z: number,
  segments = 10,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, h, segments).rotateX(rx).rotateZ(rz).translate(x, y, z);
}

function assemble(parts: Part[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map(paint), false);
  if (!merged) throw new Error('prop geometry merge failed');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

const POLE = 0x3b3f43;

function lamp(): THREE.BufferGeometry {
  return assemble([
    { geometry: cyl(0.07, 0.11, 6.6, 0, 3.3, 0), color: POLE },
    { geometry: box(0.08, 0.08, 1.7, 0, 6.45, 0.8), color: POLE },
    { geometry: box(0.5, 0.14, 0.32, 0, 6.38, 1.55), color: 0x2f3236 },
    { geometry: box(0.42, 0.04, 0.26, 0, 6.29, 1.55), color: 0xffd9a0, emissive: NIGHT },
  ]);
}

function hydrant(): THREE.BufferGeometry {
  return assemble([
    { geometry: cyl(0.15, 0.17, 0.62, 0, 0.31, 0), color: 0xb5291f },
    { geometry: cyl(0.1, 0.15, 0.14, 0, 0.69, 0), color: 0xb5291f },
    { geometry: cylAt(0.06, 0.4, 0, Math.PI / 2, 0, 0.42, 0, 6), color: 0x9a2219 },
  ]);
}

function bin(): THREE.BufferGeometry {
  return assemble([
    { geometry: cyl(0.27, 0.24, 0.9, 0, 0.45, 0, 10), color: 0x2f4f3a },
    { geometry: cyl(0.29, 0.29, 0.06, 0, 0.93, 0, 10), color: 0x263f2f },
  ]);
}

function bench(): THREE.BufferGeometry {
  const wood = 0x7a5532;
  const metal = 0x2b2d30;
  return assemble([
    { geometry: box(1.7, 0.07, 0.46, 0, 0.46, 0.02), color: wood },
    { geometry: box(1.7, 0.4, 0.06, 0, 0.75, -0.2), color: wood },
    { geometry: box(0.06, 0.46, 0.46, -0.75, 0.23, 0), color: metal },
    { geometry: box(0.06, 0.46, 0.46, 0.75, 0.23, 0), color: metal },
  ]);
}

function trafficLight(): THREE.BufferGeometry {
  return assemble([
    { geometry: cyl(0.09, 0.11, 3.4, 0, 1.7, 0), color: POLE },
    { geometry: box(0.36, 1.0, 0.28, 0, 3.0, 0.12), color: 0x1e2124 },
    { geometry: cylAt(0.11, 0.04, Math.PI / 2, 0, 0, 3.32, 0.27), color: 0x441010 },
    { geometry: cylAt(0.11, 0.04, Math.PI / 2, 0, 0, 3.0, 0.27), color: 0x443010 },
    { geometry: cylAt(0.11, 0.04, Math.PI / 2, 0, 0, 2.68, 0.27), color: 0x3cff6a, emissive: ALWAYS },
  ]);
}

function tree(variant: number): THREE.BufferGeometry {
  const bark = 0x4a3726;
  if (variant === 1) {
    return assemble([
      { geometry: cyl(0.14, 0.2, 2.2, 0, 1.1, 0), color: bark },
      { geometry: new THREE.ConeGeometry(2.0, 4.2, 9).translate(0, 4.0, 0), color: 0x2a4d2c },
      { geometry: new THREE.ConeGeometry(1.5, 3.2, 9).translate(0, 5.8, 0), color: 0x2f5531 },
    ]);
  }
  const canopy = variant === 2 ? 1.7 : 2.5;
  return assemble([
    { geometry: cyl(0.15, 0.22, 3.2, 0, 1.6, 0), color: bark },
    {
      geometry: new THREE.IcosahedronGeometry(canopy, 1).translate(0, 3.0 + canopy, 0),
      color: variant === 2 ? 0x4b7a34 : 0x3d6b2f,
    },
    {
      geometry: new THREE.IcosahedronGeometry(canopy * 0.7, 1).translate(canopy * 0.45, 2.6 + canopy, 0.3),
      color: 0x467536,
    },
  ]);
}

function billboardFrame(): THREE.BufferGeometry {
  const steel = 0x55585c;
  return assemble([
    { geometry: box(0.2, 2.4, 0.2, -4, 1.2, -0.4), color: steel },
    { geometry: box(0.2, 2.4, 0.2, 4, 1.2, -0.4), color: steel },
    { geometry: box(12.4, 4.4, 0.2, 0, 4.2, -0.25), color: 0x2a2c2f },
    { geometry: box(12.0, 0.12, 0.6, 0, 1.95, 0.05), color: steel },
  ]);
}

function acUnit(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.4, 0.95, 1.0, 0, 0.475, 0), color: 0x9a9c9e },
    { geometry: cyl(0.38, 0.38, 0.05, 0, 0.97, 0, 12), color: 0x3b3d40 },
  ]);
}

function waterTank(): THREE.BufferGeometry {
  const wood = 0x6b4d33;
  return assemble([
    { geometry: box(0.2, 2.2, 0.2, -1.1, 1.1, -1.1), color: 0x3a3a3a },
    { geometry: box(0.2, 2.2, 0.2, 1.1, 1.1, -1.1), color: 0x3a3a3a },
    { geometry: box(0.2, 2.2, 0.2, -1.1, 1.1, 1.1), color: 0x3a3a3a },
    { geometry: box(0.2, 2.2, 0.2, 1.1, 1.1, 1.1), color: 0x3a3a3a },
    { geometry: cyl(1.6, 1.6, 2.6, 0, 3.5, 0, 14), color: wood },
    { geometry: new THREE.ConeGeometry(1.75, 1.1, 14).translate(0, 5.35, 0), color: 0x4a3524 },
  ]);
}

function container(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(2.44, 2.59, 12.19, 0, 1.295, 0), color: 0xe6e6e6 },
    { geometry: box(2.3, 0.08, 12.1, 0, 2.63, 0), color: 0xb8b8b8 },
  ]);
}

function crane(): THREE.BufferGeometry {
  const yellow = 0xd9a521;
  const legs = [-9, 9].flatMap((x) =>
    [-5, 5].map((z) => ({ geometry: box(1.1, 26, 1.1, x, 13, z), color: yellow })),
  );
  return assemble([
    ...legs,
    { geometry: box(20, 1.6, 1.4, 0, 26.6, -5), color: yellow },
    { geometry: box(20, 1.6, 1.4, 0, 26.6, 5), color: yellow },
    { geometry: box(1.4, 1.6, 26, 0, 27.2, 3), color: yellow },
    { geometry: box(3, 2.5, 3, 0, 24.5, 0), color: 0x8a8d90 },
  ]);
}

function bollard(): THREE.BufferGeometry {
  return assemble([{ geometry: cyl(0.16, 0.2, 0.6, 0, 0.3, 0, 8), color: 0x2a2a2a }]);
}

/** Geometry key for a prop (type + variant where the variant changes shape). */
export function propGeometryKey(type: PropType, variant: number): string {
  return type === 'tree' ? `tree${variant % 3}` : type;
}

export function buildPropLibrary(): Map<string, THREE.BufferGeometry> {
  return new Map<string, THREE.BufferGeometry>([
    ['lamp', lamp()],
    ['hydrant', hydrant()],
    ['bin', bin()],
    ['bench', bench()],
    ['trafficLight', trafficLight()],
    ['tree0', tree(0)],
    ['tree1', tree(1)],
    ['tree2', tree(2)],
    ['billboard', billboardFrame()],
    ['acUnit', acUnit()],
    ['waterTank', waterTank()],
    ['container', container()],
    ['crane', crane()],
    ['bollard', bollard()],
  ]);
}

/** Palette for per-instance container colours. */
export const CONTAINER_COLORS = [0xa33b2b, 0x2d5f8a, 0x3c7a3f, 0xc98b2b, 0x6b6f73, 0x7b3f6e];

export interface PropPhysicsSpec {
  /** Half extents of the static collider (local, centred at `centerY`). */
  half: readonly [number, number, number];
  centerY: number;
  /** Contact force (N) that knocks the prop loose; Infinity = never. */
  knockForce: number;
  /** Mass of the loose debris (kg). */
  mass: number;
}

export const PROP_PHYSICS: Partial<Record<PropType, PropPhysicsSpec>> = {
  lamp: { half: [0.12, 3.3, 0.12], centerY: 3.3, knockForce: 45_000, mass: 160 },
  hydrant: { half: [0.18, 0.36, 0.18], centerY: 0.36, knockForce: 70_000, mass: 90 },
  bin: { half: [0.28, 0.45, 0.28], centerY: 0.45, knockForce: 6_000, mass: 25 },
  bench: { half: [0.85, 0.45, 0.28], centerY: 0.45, knockForce: 18_000, mass: 60 },
  trafficLight: { half: [0.12, 1.7, 0.12], centerY: 1.7, knockForce: 70_000, mass: 140 },
  tree: { half: [0.22, 1.6, 0.22], centerY: 1.6, knockForce: Infinity, mass: 0 },
  container: { half: [1.22, 1.3, 6.1], centerY: 1.3, knockForce: Infinity, mass: 0 },
  bollard: { half: [0.18, 0.3, 0.18], centerY: 0.3, knockForce: Infinity, mass: 0 },
};

/** Prop material: vertex colours + an emissive channel lit at night (or always for signals). */
export function createPropMaterial(uNight: { value: number }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uNight'] = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmissive;\nvarying float vEmissive;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmissive = aEmissive;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vEmissive;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float hcGlow = vEmissive > 1.5 ? 1.6 : vEmissive * uNight * 3.0;
totalEmissiveRadiance += diffuseColor.rgb * hcGlow;`,
      );
  };
  material.customProgramCacheKey = () => 'hc-prop-v1';
  return material;
}
