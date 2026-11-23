import * as THREE from 'three';

/** Light element codes baked into the `aLight` vertex attribute of the lights group. */
export const LightCode = {
  head: 0,
  tail: 1,
  reverse: 2,
  indicatorLeft: 3,
  indicatorRight: 4,
  barRed: 5,
  barBlue: 6,
  /** Always-on markers (taxi roof sign). */
  marker: 7,
} as const;

/** Per-vehicle light state, written by the vehicle view each frame. */
export interface LightUniforms {
  uHead: { value: number };
  uBrake: { value: number };
  uReverse: { value: number };
  uIndicatorLeft: { value: number };
  uIndicatorRight: { value: number };
  /** Light bar phase 0..1 (0 = off); red and blue alternate. */
  uBar: { value: number };
  uBarOn: { value: number };
}

/** Shared paint material (colour is baked into vertex colours). */
export function createPaintMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.35 });
}

export function createGlassMaterial(cracked = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: cracked ? 0x6f7b86 : 0x1c2833,
    roughness: cracked ? 0.6 : 0.05,
    metalness: cracked ? 0.1 : 0.6,
  });
}

/** Burnt-out wreck look (replaces paint and glass). */
export function createBurntMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x1b1816, roughness: 0.95, metalness: 0.15 });
}

/**
 * Emissive lights driven by per-vehicle uniforms: every lamp carries its code in `aLight`, so
 * head/brake/reverse/indicator/light-bar states cost one draw call and no extra geometry.
 */
export function createLightMaterial(): { material: THREE.MeshStandardMaterial; uniforms: LightUniforms } {
  const uniforms: LightUniforms = {
    uHead: { value: 0 },
    uBrake: { value: 0 },
    uReverse: { value: 0 },
    uIndicatorLeft: { value: 0 },
    uIndicatorRight: { value: 0 },
    uBar: { value: 0 },
    uBarOn: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLight;\nvarying float vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vLight;
uniform float uHead; uniform float uBrake; uniform float uReverse;
uniform float uIndicatorLeft; uniform float uIndicatorRight; uniform float uBar; uniform float uBarOn;
float lightLevel(float code) {
  if (code < 0.5) return 0.25 + 3.0 * uHead;
  if (code < 1.5) return 0.35 + 0.9 * uHead + 2.8 * uBrake;
  if (code < 2.5) return 0.05 + 3.0 * uReverse;
  if (code < 3.5) return 0.1 + 3.5 * uIndicatorLeft;
  if (code < 4.5) return 0.1 + 3.5 * uIndicatorRight;
  if (code < 5.5) return 0.1 + 5.0 * uBarOn * step(0.5, fract(uBar));
  if (code < 6.5) return 0.1 + 5.0 * uBarOn * (1.0 - step(0.5, fract(uBar)));
  return 1.2;
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * lightLevel(vLight);',
      );
  };
  material.customProgramCacheKey = () => 'vehicle-lights';
  return { material, uniforms };
}
