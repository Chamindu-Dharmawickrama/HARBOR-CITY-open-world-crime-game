import * as THREE from 'three';
import { effectivePixelRatio, type QualitySettings } from './quality';

export type GpuPreference = 'default' | 'low-power' | 'high-performance';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface ColorProbe {
  meanR: number;
  meanG: number;
  meanB: number;
  /** Variance of per-pixel luminance (0–1 scale). Near zero means a blank/flat image. */
  luminanceVariance: number;
}

const PROBE_WIDTH = 64;
const PROBE_HEIGHT = 36;

/** Owns the WebGL renderer, the main scene and the main camera. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gpuName: string;
  private quality: QualitySettings;
  private cssWidth = 1;
  private cssHeight = 1;
  private probeTarget: THREE.WebGLRenderTarget | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    quality: QualitySettings,
    gpu: GpuPreference,
  ) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      powerPreference: gpu,
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Stats are reset once per frame by beginFrame() so multi-pass frames are counted in full.
    this.renderer.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, quality.drawDistance);
    this.gpuName = detectGpuName(this.renderer.getContext());
  }

  get settings(): QualitySettings {
    return this.quality;
  }

  applyQuality(quality: QualitySettings): void {
    const shadowsChanged = quality.shadows !== this.quality.shadows;
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.camera.far = quality.drawDistance;
    this.camera.updateProjectionMatrix();
    if (shadowsChanged) {
      this.scene.traverse((object) => {
        const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) for (const m of material) m.needsUpdate = true;
        else if (material) material.needsUpdate = true;
      });
    }
    this.resize(this.cssWidth, this.cssHeight);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, Math.floor(cssWidth));
    this.cssHeight = Math.max(1, Math.floor(cssHeight));
    this.renderer.setPixelRatio(effectivePixelRatio(window.devicePixelRatio || 1, this.quality));
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.camera.updateProjectionMatrix();
  }

  get drawingBufferSize(): { width: number; height: number; pixelRatio: number } {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { width: size.x, height: size.y, pixelRatio: this.renderer.getPixelRatio() };
  }

  beginFrame(): void {
    this.renderer.info.reset();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  stats(out: RenderStats): RenderStats {
    const info = this.renderer.info;
    out.drawCalls = info.render.calls;
    out.triangles = info.render.triangles;
    out.lines = info.render.lines;
    out.geometries = info.memory.geometries;
    out.textures = info.memory.textures;
    out.programs = info.programs?.length ?? 0;
    return out;
  }

  /** Renders the current view into a small offscreen target and summarises its colours. */
  probe(): ColorProbe {
    this.probeTarget ??= new THREE.WebGLRenderTarget(PROBE_WIDTH, PROBE_HEIGHT, { depthBuffer: true });
    const pixels = new Uint8Array(PROBE_WIDTH * PROBE_HEIGHT * 4);
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.probeTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.probeTarget, 0, 0, PROBE_WIDTH, PROBE_HEIGHT, pixels);
    this.renderer.setRenderTarget(previous);
    return summarizePixels(pixels);
  }

  dispose(): void {
    this.probeTarget?.dispose();
    this.renderer.dispose();
  }
}

export function summarizePixels(rgba: Uint8Array): ColorProbe {
  const count = Math.floor(rgba.length / 4);
  if (count === 0) return { meanR: 0, meanG: 0, meanB: 0, luminanceVariance: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  let lum = 0;
  let lumSq = 0;
  for (let i = 0; i < count; i++) {
    const pr = rgba[i * 4] / 255;
    const pg = rgba[i * 4 + 1] / 255;
    const pb = rgba[i * 4 + 2] / 255;
    const l = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
    r += pr;
    g += pg;
    b += pb;
    lum += l;
    lumSq += l * l;
  }
  const meanLum = lum / count;
  return {
    meanR: r / count,
    meanG: g / count,
    meanB: b / count,
    luminanceVariance: Math.max(0, lumSq / count - meanLum * meanLum),
  };
}

function detectGpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return String(gl.getParameter(gl.RENDERER));
  } catch {
    return 'unknown';
  }
}
