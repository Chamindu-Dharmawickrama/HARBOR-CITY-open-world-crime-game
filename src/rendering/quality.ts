export const QUALITY_PRESET_NAMES = ['low', 'medium', 'high'] as const;
export type QualityPresetName = (typeof QUALITY_PRESET_NAMES)[number];

/** Graphics settings driven by the quality preset. Fields are added as features land. */
export interface QualitySettings {
  readonly name: QualityPresetName;
  /** Multiplier on the device pixel ratio (below 1 renders at reduced resolution). */
  readonly renderScale: number;
  /** Upper bound on the device pixel ratio before renderScale is applied. */
  readonly maxPixelRatio: number;
  /** MSAA on the default framebuffer (fixed at renderer creation). */
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Camera far plane and fog end, metres. */
  readonly drawDistance: number;
  /** Radius of full-detail world streaming (meshes + colliders), metres. */
  readonly nearRing: number;
  /** Street furniture draw distance, metres. */
  readonly propDistance: number;
  /** Half size of the sun shadow frustum around the camera, metres. */
  readonly shadowExtent: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityPresetName, QualitySettings>> = {
  low: {
    name: 'low',
    renderScale: 0.75,
    maxPixelRatio: 1,
    antialias: false,
    shadows: true,
    shadowMapSize: 1024,
    drawDistance: 500,
    nearRing: 160,
    propDistance: 140,
    shadowExtent: 90,
  },
  medium: {
    name: 'medium',
    renderScale: 1,
    maxPixelRatio: 1.25,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    drawDistance: 800,
    nearRing: 220,
    propDistance: 220,
    shadowExtent: 130,
  },
  high: {
    name: 'high',
    renderScale: 1,
    maxPixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    drawDistance: 1200,
    nearRing: 260,
    propDistance: 300,
    shadowExtent: 180,
  },
};

export function isQualityPresetName(value: string): value is QualityPresetName {
  return (QUALITY_PRESET_NAMES as readonly string[]).includes(value);
}

export function getQuality(name: QualityPresetName): QualitySettings {
  return QUALITY_PRESETS[name];
}

/** Effective drawing-buffer pixel ratio for a device pixel ratio under the given settings. */
export function effectivePixelRatio(devicePixelRatio: number, quality: QualitySettings): number {
  return Math.min(devicePixelRatio, quality.maxPixelRatio) * quality.renderScale;
}
