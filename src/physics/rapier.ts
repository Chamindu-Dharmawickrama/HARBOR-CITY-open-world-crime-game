import type RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

let loading: Promise<Rapier> | null = null;

/**
 * Loads and initialises Rapier once. The module is dynamically imported so its inlined WASM
 * (~3 MB) is a separate chunk that downloads while the loading screen is already visible.
 */
export function loadRapier(): Promise<Rapier> {
  loading ??= import('@dimforge/rapier3d-compat').then(async (module) => {
    const rapier = module.default;
    await rapier.init();
    return rapier;
  });
  return loading;
}
