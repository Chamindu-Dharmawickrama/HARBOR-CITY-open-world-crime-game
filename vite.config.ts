import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The Rapier chunk inlines its WASM as base64 (~4.3 MB, 1.7 MB gzipped) and is loaded
    // asynchronously behind the loading screen; every other chunk is far below this limit.
    chunkSizeWarningLimit: 4600,
  },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
