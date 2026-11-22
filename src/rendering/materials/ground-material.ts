import * as THREE from 'three';
import { GLSL_NOISE, type SharedMaterialUniforms } from './glsl';

/**
 * Procedural ground material: one draw call renders terrain, roads (with lane markings,
 * crosswalks and stop lines), sidewalks, kerbs, plazas, gravel yards, seawalls, tunnel tiles and
 * steel. Surface type comes from the per-vertex `aData.x` (flat-interpolated).
 *
 * Road ribbons: aUv = (lateral offset m, distance along m); aData = (1, lanes/dir, flags, length)
 * where flags = startCrosswalk + 2·endCrosswalk + 4·classCode + 32·round(halfWidth·4).
 */
export function createGroundMaterial(shared: SharedMaterialUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uNight'] = shared.uNight;
    shader.uniforms['uTime'] = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aUv;
attribute vec4 aData;
flat varying float vSurface;
varying vec4 vGData;
varying vec2 vGUv;
varying vec3 vGWorld;
varying float vGUp;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vSurface = aData.x;
vGData = aData;
vGUv = aUv;
vGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGUp = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
uniform float uTime;
flat varying float vSurface;
varying vec4 vGData;
varying vec2 vGUv;
varying vec3 vGWorld;
varying float vGUp;
${GLSL_NOISE}
vec3 hc_ground(out float rough, out float metal, out vec3 emissiveOut) {
  rough = 0.9;
  metal = 0.0;
  emissiveOut = vec3(0.0);
  int s = int(vSurface + 0.5);
  vec2 w = vGWorld.xz;
  float n = hc_fbm(w * 0.35);
  float fine = hc_noise(w * 6.0);
  if (s == 0) {
    rough = 0.97;
    vec3 a = vec3(0.17, 0.29, 0.10);
    vec3 b = vec3(0.30, 0.38, 0.14);
    return mix(a, b, n) * (0.85 + 0.3 * fine);
  }
  if (s == 1 || s == 6) {
    rough = 0.82 - 0.1 * fine;
    vec3 asphalt = vec3(0.105, 0.108, 0.115) * (0.82 + 0.36 * n) + 0.04 * fine;
    if (s == 6) {
      asphalt *= 1.25;
      float stall = hc_band(fract(w.x / 2.7), 0.0, 0.04);
      return mix(asphalt, vec3(0.75), stall * 0.6);
    }
    float lanes = vGData.y;
    if (lanes < 0.5) return asphalt;
    float flags = vGData.z;
    float halfWidth = floor(flags / 32.0) / 4.0;
    float rest = flags - floor(flags / 32.0) * 32.0;
    float cls = floor(rest / 4.0);
    float startCross = mod(rest, 2.0);
    float endCross = mod(floor(rest / 2.0), 2.0);
    float u = vGUv.x;
    float v = vGUv.y;
    float len = vGData.w;
    float kerb = max(1.0, halfWidth - 0.5);
    float laneW = kerb / lanes;
    float paint = 0.0;
    vec3 paintColor = vec3(0.86, 0.86, 0.82);
    // Centre line: double yellow (not on alleys).
    if (cls != 2.0) {
      float yellow = hc_band(u, -0.22, -0.1) + hc_band(u, 0.1, 0.22);
      if (yellow > 0.0) { paint = yellow; paintColor = vec3(0.86, 0.66, 0.12); }
    }
    // Lane dividers: dashed white.
    float dash = step(fract(v / 9.0), 0.33);
    for (int k = 1; k < 4; k++) {
      float fk = float(k);
      if (fk >= lanes) break;
      paint = max(paint, (hc_band(u, fk * laneW - 0.08, fk * laneW + 0.08) + hc_band(u, -fk * laneW - 0.08, -fk * laneW + 0.08)) * dash);
    }
    // Edge lines on major roads.
    if (cls == 0.0 || cls == 3.0 || cls == 4.0 || cls == 5.0) {
      paint = max(paint, hc_band(abs(u), kerb - 0.35, kerb - 0.2));
    }
    // Crosswalks and stop lines near junction ends.
    float fromStart = v;
    float fromEnd = len - v;
    float zebra = step(fract((u + 50.0) / 1.0), 0.5) * step(abs(u), kerb - 0.3);
    if (startCross > 0.5 && fromStart > 0.6 && fromStart < 3.6) paint = max(paint, zebra);
    if (endCross > 0.5 && fromEnd > 0.6 && fromEnd < 3.6) paint = max(paint, zebra);
    if (startCross > 0.5) paint = max(paint, hc_band(fromStart, 4.1, 4.5) * step(u, 0.0));
    if (endCross > 0.5) paint = max(paint, hc_band(fromEnd, 4.1, 4.5) * step(0.0, u));
    paint *= 0.75 + 0.25 * hc_noise(w * 3.0);
    rough = mix(rough, 0.55, paint);
    return mix(asphalt, paintColor, clamp(paint, 0.0, 1.0));
  }
  if (s == 2) {
    rough = 0.88;
    vec2 tile = fract(w / 1.5);
    float joint = 1.0 - (hc_band(tile.x, -0.02, 0.02) + hc_band(tile.y, -0.02, 0.02)) * 0.5;
    return vec3(0.55, 0.54, 0.51) * (0.88 + 0.12 * n) * (0.92 + 0.08 * fine) * joint;
  }
  if (s == 3) {
    rough = 0.9;
    return vec3(0.52, 0.51, 0.49) * (0.85 + 0.2 * n);
  }
  if (s == 4) {
    rough = 0.98;
    return mix(vec3(0.34, 0.31, 0.27), vec3(0.45, 0.42, 0.37), fine) * (0.8 + 0.3 * n);
  }
  if (s == 5) {
    rough = 0.92;
    float row = floor(vGWorld.y / 0.9);
    float along = (vGWorld.x + vGWorld.z) / 1.8 + row * 0.5;
    float mortar = 1.0 - 0.35 * (hc_band(fract(vGWorld.y / 0.9), -0.04, 0.04) + hc_band(fract(along), -0.03, 0.03));
    float block = hc_hash12(vec2(floor(along), row));
    return vec3(0.33, 0.31, 0.28) * (0.8 + 0.35 * block) * mortar;
  }
  if (s == 7) {
    rough = 0.45;
    vec3 tileCol = vec3(0.70, 0.70, 0.66);
    vec2 t = fract(vec2(vGWorld.x + vGWorld.z, vGWorld.y) / vec2(0.6, 0.3));
    tileCol *= 1.0 - 0.25 * (hc_band(t.x, -0.03, 0.03) + hc_band(t.y, -0.05, 0.05));
    float ceiling = step(0.5, -vGUp);
    float lamp = step(fract((vGWorld.x + vGWorld.z) / 9.0), 0.22) * ceiling;
    emissiveOut = vec3(1.0, 0.86, 0.6) * lamp * 2.5;
    return tileCol;
  }
  if (s == 8) {
    rough = 0.55;
    metal = 0.5;
    return vec3(0.6) * (0.85 + 0.15 * n);
  }
  if (s == 9) {
    rough = 0.86;
    vec2 cell = floor(w / 3.0);
    float t = hc_hash12(cell);
    vec2 f = fract(w / 3.0);
    float joint = 1.0 - 0.3 * (hc_band(f.x, -0.015, 0.015) + hc_band(f.y, -0.015, 0.015));
    return mix(vec3(0.58, 0.53, 0.46), vec3(0.66, 0.62, 0.55), t) * joint * (0.92 + 0.08 * fine);
  }
  return vec3(0.5);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float hcRough;
float hcMetal;
vec3 hcEmissive;
diffuseColor.rgb *= hc_ground(hcRough, hcMetal, hcEmissive);`,
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
  material.customProgramCacheKey = () => 'hc-ground-v1';
  return material;
}
