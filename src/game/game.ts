import { CITY } from '../content/city';
import { createEngine } from './engine';
import { setupCityScene } from './scenes/city-scene';
import { setupPlaygroundScene } from './scenes/playground-scene';
import type { UrlParams } from './url-params';

export const BENCH_SCENARIOS = ['playground', 'flythrough', 'traffic'] as const;

/** Composition root: builds the engine, then the requested scene, then starts the loop. */
export async function startGame(root: HTMLElement, params: UrlParams): Promise<void> {
  if (params.bench !== null && !(BENCH_SCENARIOS as readonly string[]).includes(params.bench)) {
    throw new Error(`Unknown bench scenario "${params.bench}". Known: ${BENCH_SCENARIOS.join(', ')}`);
  }
  const engine = await createEngine(root, params);
  if (params.scene === 'playground' || params.bench === 'playground') setupPlaygroundScene(engine);
  else await setupCityScene(engine, CITY);
  engine.start();
}
