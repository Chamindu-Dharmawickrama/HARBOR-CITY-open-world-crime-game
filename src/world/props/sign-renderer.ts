import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SignSpec } from '../gen/types';

export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 16;
const CELL_W = 512;
const CELL_H = 128;

const SIGN_STYLES: readonly { bg: string; fg: string; border: string }[] = [
  { bg: '#1b1f2a', fg: '#ffcf5c', border: '#ffcf5c' },
  { bg: '#2a0f19', fg: '#ff6ea8', border: '#ff6ea8' },
  { bg: '#0f2420', fg: '#64f0c8', border: '#3cc2a0' },
  { bg: '#f2ead8', fg: '#2a2a2a', border: '#8a1f1f' },
  { bg: '#132238', fg: '#9fd1ff', border: '#9fd1ff' },
  { bg: '#3a1d0b', fg: '#ffb36b', border: '#ffb36b' },
];

const BILLBOARD_STYLES: readonly { bg: string; fg: string; accent: string }[] = [
  { bg: '#ffd23f', fg: '#1d1d1d', accent: '#e4572e' },
  { bg: '#1e88e5', fg: '#ffffff', accent: '#ffd23f' },
  { bg: '#e4572e', fg: '#ffffff', accent: '#1d1d1d' },
  { bg: '#2e2e2e', fg: '#ffffff', accent: '#4caf50' },
  { bg: '#f5f5f5', fg: '#222222', accent: '#7b1fa2' },
];

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  start: number,
  weight: string,
): void {
  let size = start;
  do {
    ctx.font = `${weight} ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 12);
}

/**
 * Generates the sign atlas: business names first (index = position in `names`), then
 * billboard slogans (index = names.length + i). Cells are 512×128 on a 2048×2048 canvas.
 */
export function buildSignAtlas(names: readonly string[], slogans: readonly string[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * ATLAS_COLUMNS;
  canvas.height = CELL_H * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const rng = new Rng('sign-atlas');
  const entries = [
    ...names.map((text) => ({ text, billboard: false })),
    ...slogans.map((text) => ({ text, billboard: true })),
  ];
  entries.slice(0, ATLAS_COLUMNS * ATLAS_ROWS).forEach((entry, i) => {
    const x = (i % ATLAS_COLUMNS) * CELL_W;
    const y = Math.floor(i / ATLAS_COLUMNS) * CELL_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, CELL_H);
    ctx.clip();
    if (entry.billboard) {
      const style = rng.pick(BILLBOARD_STYLES);
      ctx.fillStyle = style.bg;
      ctx.fillRect(x, y, CELL_W, CELL_H);
      ctx.fillStyle = style.accent;
      ctx.fillRect(x, y + CELL_H - 16, CELL_W, 16);
      ctx.fillStyle = style.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const [headline, tagline] = entry.text.split(/ — |: |\. /);
      fitText(ctx, headline ?? entry.text, CELL_W - 30, 44, '900');
      ctx.fillText(headline ?? entry.text, x + CELL_W / 2, y + (tagline ? 42 : 56));
      if (tagline) {
        fitText(ctx, tagline, CELL_W - 40, 26, '600');
        ctx.fillText(tagline, x + CELL_W / 2, y + 86);
      }
    } else {
      const style = rng.pick(SIGN_STYLES);
      ctx.fillStyle = style.bg;
      ctx.fillRect(x, y, CELL_W, CELL_H);
      ctx.strokeStyle = style.border;
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 8, y + 8, CELL_W - 16, CELL_H - 16);
      ctx.fillStyle = style.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = style.fg;
      ctx.shadowBlur = 12;
      fitText(ctx, entry.text.toUpperCase(), CELL_W - 60, 62, '800');
      ctx.fillText(entry.text.toUpperCase(), x + CELL_W / 2, y + CELL_H / 2 + 2);
    }
    ctx.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  return texture;
}

/** All shop signs and billboard faces as one instanced quad mesh (they are cheap; no streaming). */
export class SignRenderer {
  readonly mesh: THREE.InstancedMesh;

  constructor(signs: readonly SignSpec[], atlas: THREE.Texture, uNight: { value: number }) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const atlasIndex = new Float32Array(signs.length);
    signs.forEach((s, i) => (atlasIndex[i] = s.atlas));
    geometry.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(atlasIndex, 1));
    const material = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.55, metalness: 0 });
    material.onBeforeCompile = (shader) => {
      shader.uniforms['uNight'] = uNight;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAtlas;')
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
vMapUv = vec2((mod(aAtlas, ${ATLAS_COLUMNS}.0) + uv.x) / ${ATLAS_COLUMNS}.0, 1.0 - (floor(aAtlas / ${ATLAS_COLUMNS}.0) + 1.0 - uv.y) / ${ATLAS_ROWS}.0);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uNight * 1.8;`,
        );
    };
    material.customProgramCacheKey = () => 'hc-sign-v1';
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, signs.length));
    this.mesh.count = signs.length;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'signs';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    signs.forEach((s, i) => {
      q.setFromAxisAngle(up, s.rotY);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(s.width, s.height, 1));
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
