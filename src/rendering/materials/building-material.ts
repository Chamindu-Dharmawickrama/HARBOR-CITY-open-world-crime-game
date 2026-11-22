import * as THREE from 'three';
import { GLSL_NOISE, type SharedMaterialUniforms } from './glsl';

/**
 * Procedural facade/roof material. Walls: aUv = (metres along the perimeter, metres above the
 * building base); aData = (style, floorHeight, bayWidth, seed). Styles 0–5 are facades
 * (glass, office, brick, shopfront, industrial, house); 20–24 are roofs (flat, tiles, metal,
 * skylight, parapet cap). Windows light up at night (uNight) with per-window variation.
 */
export function createBuildingMaterial(shared: SharedMaterialUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uNight'] = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aUv;
attribute vec4 aData;
flat varying vec4 vBData;
varying vec2 vBUv;
varying vec3 vBWorld;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vBData = aData;
vBUv = aUv;
vBWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
flat varying vec4 vBData;
varying vec2 vBUv;
varying vec3 vBWorld;
${GLSL_NOISE}
// Returns (window mask, window lit amount) for a facade point.
vec2 hc_windows(int style, vec2 cell, vec2 idx, float seed) {
  vec4 r; // left, right, bottom, top of the window inside the bay/floor cell
  if (style == 0) r = vec4(0.04, 0.96, 0.08, 0.98);
  else if (style == 1) r = vec4(0.16, 0.84, 0.3, 0.86);
  else if (style == 2) r = vec4(0.27, 0.73, 0.28, 0.82);
  else if (style == 3) r = vec4(0.27, 0.73, 0.28, 0.82);
  else if (style == 4) r = vec4(0.12, 0.88, 0.66, 0.86);
  else r = vec4(0.3, 0.7, 0.32, 0.78);
  if (style == 3 && idx.y < 0.5) r = vec4(0.06, 0.94, 0.06, 0.8);
  float wx = hc_band(cell.x, r.x, r.y);
  float wy = hc_band(cell.y, r.z, r.w);
  float mask = wx * wy;
  float h = hc_hash13(vec3(idx, seed));
  float lit = step(h, 0.38 + 0.2 * hc_hash13(vec3(floor(idx.y / 3.0), seed, 7.0)));
  return vec2(mask, lit);
}
vec3 hc_building(vec3 base, out float rough, out float metal, out vec3 emissiveOut) {
  rough = 0.85;
  metal = 0.0;
  emissiveOut = vec3(0.0);
  int style = int(vBData.x + 0.5);
  float seed = vBData.w;
  if (style >= 20) {
    vec2 w = vBWorld.xz;
    if (style == 20) { rough = 0.95; return base * (0.75 + 0.35 * hc_fbm(w * 0.7)); }
    if (style == 21) { rough = 0.8; float row = hc_band(fract(vBWorld.y / 0.32), 0.0, 0.12); return base * (1.0 - 0.3 * row) * (0.9 + 0.2 * hc_noise(w * 2.0)); }
    if (style == 22) { rough = 0.5; metal = 0.6; return vec3(0.55, 0.57, 0.58) * (0.85 + 0.15 * hc_band(fract((w.x + w.y) / 0.6), 0.0, 0.2)); }
    if (style == 23) { rough = 0.12; metal = 0.4; emissiveOut = vec3(1.0, 0.85, 0.6) * uNight * 0.6; return vec3(0.12, 0.16, 0.2); }
    rough = 0.9;
    return vec3(0.62, 0.61, 0.58);
  }
  float floorH = max(2.4, vBData.y);
  float bay = max(1.0, vBData.z);
  vec2 uv = vBUv;
  if (uv.y < 0.0) { rough = 0.9; return base * 0.55; }
  vec2 cell = vec2(fract(uv.x / bay), fract(uv.y / floorH));
  vec2 idx = vec2(floor(uv.x / bay), floor(uv.y / floorH));
  vec2 win = hc_windows(style, cell, idx, seed);
  vec3 wall = base * (0.86 + 0.18 * hc_fbm(vBWorld.xz * 0.2 + vBWorld.y * 0.13));
  if (style == 2) {
    float course = hc_band(fract(uv.y / 0.3), 0.0, 0.08) + hc_band(fract((uv.x + step(0.5, fract(uv.y / 0.6)) * 0.45) / 0.9), 0.0, 0.04);
    wall *= 1.0 - 0.18 * clamp(course, 0.0, 1.0);
  }
  if (style == 4) wall *= 0.9 + 0.1 * hc_band(fract(uv.x / 0.5), 0.0, 0.5);
  if (style == 0) {
    float mullion = 1.0 - win.x;
    wall = mix(vec3(0.22, 0.25, 0.28), base, 0.35);
    win.x = 1.0 - mullion * 0.85;
  }
  vec3 glass = mix(vec3(0.05, 0.07, 0.09), vec3(0.16, 0.2, 0.26), hc_hash13(vec3(idx, seed + 3.0)));
  rough = mix(0.88, 0.06, win.x);
  metal = mix(0.0, style == 0 ? 0.7 : 0.35, win.x);
  vec3 warm = mix(vec3(1.0, 0.78, 0.48), vec3(0.75, 0.85, 1.0), step(0.8, hc_hash13(vec3(idx, seed + 9.0))));
  emissiveOut = warm * win.x * win.y * uNight * 1.6;
  return mix(wall, glass, win.x);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float hcRough;
float hcMetal;
vec3 hcEmissive;
diffuseColor.rgb = hc_building(vColor.rgb, hcRough, hcMetal, hcEmissive);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = hcRough;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = hcMetal;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += hcEmissive;`,
      );
  };
  material.customProgramCacheKey = () => 'hc-building-v1';
  return material;
}
