import { describe, expect, it } from 'vitest';
import { summarizePixels } from './game-renderer';
import {
  effectivePixelRatio,
  getQuality,
  isQualityPresetName,
  QUALITY_PRESET_NAMES,
  QUALITY_PRESETS,
} from './quality';

describe('quality presets', () => {
  it('every preset is complete and ordered by cost', () => {
    expect(QUALITY_PRESET_NAMES).toEqual(['low', 'medium', 'high']);
    const [low, medium, high] = QUALITY_PRESET_NAMES.map(getQuality);
    expect(low?.drawDistance).toBeLessThan(medium?.drawDistance ?? 0);
    expect(medium?.drawDistance).toBeLessThan(high?.drawDistance ?? 0);
    expect(low?.shadowMapSize).toBeLessThanOrEqual(medium?.shadowMapSize ?? 0);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(preset.renderScale).toBeGreaterThan(0);
      expect(preset.renderScale).toBeLessThanOrEqual(1);
      expect(Number.isInteger(Math.log2(preset.shadowMapSize))).toBe(true);
    }
  });

  it('validates preset names', () => {
    expect(isQualityPresetName('medium')).toBe(true);
    expect(isQualityPresetName('ultra')).toBe(false);
  });

  it('effective pixel ratio caps then scales', () => {
    expect(effectivePixelRatio(2, getQuality('low'))).toBe(0.75);
    expect(effectivePixelRatio(1, getQuality('medium'))).toBe(1);
    expect(effectivePixelRatio(3, getQuality('high'))).toBe(2);
  });
});

describe('summarizePixels', () => {
  it('flat images have zero variance; contrast raises it', () => {
    const flat = new Uint8Array(16).fill(128);
    expect(summarizePixels(flat).luminanceVariance).toBeCloseTo(0);
    const contrast = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const probe = summarizePixels(contrast);
    expect(probe.luminanceVariance).toBeCloseTo(0.25, 2);
    expect(probe.meanR).toBeCloseTo(0.5);
  });

  it('handles empty buffers', () => {
    expect(summarizePixels(new Uint8Array(0)).luminanceVariance).toBe(0);
  });
});
