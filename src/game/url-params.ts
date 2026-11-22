import { seedFrom } from '../core/rng';
import type { GpuPreference } from '../rendering/game-renderer';
import { isQualityPresetName, type QualityPresetName } from '../rendering/quality';

export const DEFAULT_WORLD_SEED = 74613;

export interface UrlParams {
  /** Show the developer overlay at boot. */
  debug: boolean;
  /** Install the automation API (window.__HARBOR__). */
  test: boolean;
  seed: number;
  preset: QualityPresetName;
  /** Benchmark scenario to run, or null for normal play. */
  bench: string | null;
  gpu: GpuPreference;
}

function flag(params: URLSearchParams, name: string): boolean {
  if (!params.has(name)) return false;
  const value = (params.get(name) ?? '').toLowerCase();
  return value === '' || value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function parseUrlParams(search: string): UrlParams {
  const params = new URLSearchParams(search);
  const presetRaw = (params.get('preset') ?? 'medium').toLowerCase();
  const seedRaw = params.get('seed');
  const gpuRaw = params.get('gpu');
  const bench = params.get('bench');
  return {
    debug: flag(params, 'debug'),
    test: flag(params, 'test'),
    seed:
      seedRaw === null || seedRaw === ''
        ? DEFAULT_WORLD_SEED
        : seedFrom(/^\d+$/.test(seedRaw) ? Number(seedRaw) : seedRaw),
    preset: isQualityPresetName(presetRaw) ? presetRaw : 'medium',
    bench: bench === null || bench === '' ? null : bench,
    gpu: gpuRaw === 'low-power' || gpuRaw === 'high-performance' ? gpuRaw : 'default',
  };
}
