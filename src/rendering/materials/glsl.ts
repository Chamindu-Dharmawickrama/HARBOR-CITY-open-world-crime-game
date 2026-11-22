/** Shared GLSL helpers (hash, value noise, fbm) injected into procedural materials. */
export const GLSL_NOISE = /* glsl */ `
float hc_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hc_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hc_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hc_hash12(i);
  float b = hc_hash12(i + vec2(1.0, 0.0));
  float c = hc_hash12(i + vec2(0.0, 1.0));
  float d = hc_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float hc_fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * hc_noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
// Antialiased band: 1 inside [edge0, edge1], fading over one pixel.
float hc_band(float x, float edge0, float edge1) {
  float w = fwidth(x) + 1e-4;
  return smoothstep(edge0 - w, edge0 + w, x) * (1.0 - smoothstep(edge1 - w, edge1 + w, x));
}
`;

/** Uniforms shared by every procedural material (time of day, wetness, …). */
export interface SharedMaterialUniforms {
  uNight: { value: number };
  uTime: { value: number };
}

export function createSharedUniforms(): SharedMaterialUniforms {
  return { uNight: { value: 0 }, uTime: { value: 0 } };
}
