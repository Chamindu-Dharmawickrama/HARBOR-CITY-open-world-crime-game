import * as THREE from 'three';
import { GLSL_NOISE, type SharedMaterialUniforms } from './glsl';

export const MAX_WATER_HOLES = 4;

/** Oriented rectangle where the water surface is cut away (tunnel trenches). */
export interface WaterHole {
  centerX: number;
  centerZ: number;
  axisX: number;
  axisZ: number;
  halfLength: number;
  halfWidth: number;
}

/**
 * Opaque harbour water: animated multi-octave normals, sky reflections from the environment
 * map, and holes where tunnel trenches descend below sea level.
 */
export function createWaterMaterial(
  shared: SharedMaterialUniforms,
  holes: readonly WaterHole[],
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0x1b3846, roughness: 0.12, metalness: 0.0 });
  const holeA = Array.from({ length: MAX_WATER_HOLES }, (_, i) => {
    const h = holes[i];
    return h
      ? new THREE.Vector4(h.centerX, h.centerZ, h.halfLength, h.halfWidth)
      : new THREE.Vector4(0, 0, -1, -1);
  });
  const holeB = Array.from({ length: MAX_WATER_HOLES }, (_, i) => {
    const h = holes[i];
    return h ? new THREE.Vector2(h.axisX, h.axisZ) : new THREE.Vector2(1, 0);
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uTime'] = shared.uTime;
    shader.uniforms['uHoleA'] = { value: holeA };
    shader.uniforms['uHoleB'] = { value: holeB };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWWorld;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\nvWWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec4 uHoleA[${MAX_WATER_HOLES}];
uniform vec2 uHoleB[${MAX_WATER_HOLES}];
varying vec3 vWWorld;
${GLSL_NOISE}
vec2 hc_waveSlope(vec2 p, float t) {
  vec2 s = vec2(0.0);
  s += vec2(cos(p.x * 0.11 + t * 0.9), cos(p.y * 0.13 - t * 0.7)) * 0.10;
  s += vec2(cos(dot(p, vec2(0.31, 0.22)) + t * 1.6), cos(dot(p, vec2(-0.18, 0.37)) + t * 1.3)) * 0.06;
  float e = 0.35;
  float n0 = hc_fbm(p * 0.35 + t * 0.15);
  s += (vec2(hc_fbm((p + vec2(e, 0.0)) * 0.35 + t * 0.15), hc_fbm((p + vec2(0.0, e)) * 0.35 + t * 0.15)) - n0) / e * 0.35;
  return s;
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
for (int i = 0; i < ${MAX_WATER_HOLES}; i++) {
  vec4 a = uHoleA[i];
  if (a.z < 0.0) continue;
  vec2 d = vWWorld.xz - a.xy;
  vec2 ax = uHoleB[i];
  float along = dot(d, ax);
  float across = dot(d, vec2(-ax.y, ax.x));
  if (abs(along) < a.z && abs(across) < a.w) discard;
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec2 slope = hc_waveSlope(vWWorld.xz, uTime);
  vec3 worldN = normalize(vec3(-slope.x, 1.0, -slope.y));
  normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
}`,
      );
  };
  material.customProgramCacheKey = () => 'hc-water-v1';
  return material;
}

export function createWaterMesh(
  material: THREE.Material,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  y: number,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set((minX + maxX) / 2, y, (minZ + maxZ) / 2);
  mesh.receiveShadow = true;
  mesh.name = 'water';
  return mesh;
}
