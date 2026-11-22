import * as THREE from 'three';

export interface SkyColors {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sun: THREE.Color;
}

export const DAY_SKY: SkyColors = {
  zenith: new THREE.Color(0x3d78c2),
  horizon: new THREE.Color(0xc6dbea),
  ground: new THREE.Color(0x7d8a8f),
  sun: new THREE.Color(0xfff2d8),
};

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sun, 900.0) * 18.0 + pow(sun, 12.0) * 0.35);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Gradient sky dome with a sun disc and glow. Always drawn behind everything (depth = far). */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(colors: SkyColors = DAY_SKY) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uZenith: { value: colors.zenith.clone() },
        uHorizon: { value: colors.horizon.clone() },
        uGround: { value: colors.ground.clone() },
        uSunColor: { value: colors.sun.clone() },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'] as { value: THREE.Vector3 }).value.copy(dir).normalize();
  }

  /** Keeps the dome centred on the camera. */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(10);
  }

  /** Builds a prefiltered environment map of this sky for PBR reflections. */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const scene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    dome.scale.setScalar(100);
    scene.add(dome);
    const target = pmrem.fromScene(scene, 0, 0.1, 1000);
    pmrem.dispose();
    dome.geometry.dispose();
    return target.texture;
  }
}
