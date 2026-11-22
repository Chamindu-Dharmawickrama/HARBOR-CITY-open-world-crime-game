import { expect, test, type Page } from '@playwright/test';
import { CITY } from '../src/content/city';
import { generateCity, layoutHash } from '../src/world/gen/city-layout';
import { bootGame, probe, runCommand, screenshot, waitTicks } from './helpers';

interface CityProbe {
  hash: string;
  stats: Record<string, number>;
}

interface StreamingProbe {
  progress: number;
  meshes: number;
  failed: number;
  colliderChunks: number;
}

interface StatsProbe {
  drawCalls: number;
  triangles: number;
}

const BOOT = 'test=1&preset=low&debug=1';

async function goto(page: Page, place: string): Promise<void> {
  const result = await runCommand(page, `goto ${place}`);
  expect(result.ok, result.output).toBe(true);
  // Wait until the streamer has planned for the new camera position AND loaded everything there.
  await page.waitForFunction(
    () => {
      const api = window.__HARBOR__;
      if (!api) return false;
      const s = api.probe('streaming') as { progress: number; x: number; z: number };
      const c = api.probe('camera') as { x: number; z: number };
      return Math.hypot(s.x - c.x, s.z - c.z) < 1 && s.progress >= 0.999;
    },
    undefined,
    { timeout: 90_000 },
  );
  await waitTicks(page, 10);
}

test.describe('M1 — streamed city', () => {
  test('generates the same city in the browser as in Node for the default seed', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    const city = await probe<CityProbe>(page, 'city');
    const expected = layoutHash(generateCity(CITY, 74613).layout);
    expect(city.hash).toBe(expected);
    expect(city.stats['buildings']).toBeGreaterThan(1200);
    await expect(page.getByTestId('debug-overlay')).toContainText('streaming');
    expect(errors).toEqual([]);
  });

  for (const place of ['downtown', 'docks', 'suburbs', 'copperline', 'halvard', 'tunnel', 'street']) {
    test(`streams and renders ${place}`, async ({ page }) => {
      const errors = await bootGame(page, BOOT);
      await goto(page, place);
      const streaming = await probe<StreamingProbe>(page, 'streaming');
      expect(streaming.failed).toBe(0);
      expect(streaming.meshes).toBeGreaterThan(10);
      const stats = await probe<StatsProbe>(page, 'stats');
      expect(stats.drawCalls).toBeGreaterThan(5);
      expect(stats.triangles).toBeGreaterThan(5000);
      const color = await page.evaluate(() => window.__HARBOR__?.canvasProbe());
      expect(color?.luminanceVariance ?? 0).toBeGreaterThan(0.002);
      await runCommand(page, 'overlay off');
      await screenshot(page, 'M1', place);
      expect(errors).toEqual([]);
    });
  }

  test('streamed colliders match the ground and catch falling crates', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await goto(page, 'street');
    const streaming = await probe<StreamingProbe>(page, 'streaming');
    expect(streaming.colliderChunks).toBeGreaterThan(0);
    const ray = JSON.parse((await runCommand(page, 'raycast')).output) as {
      hit: boolean;
      y: number;
      terrain: number;
    };
    expect(ray.hit).toBe(true);
    expect(Math.abs(ray.y - ray.terrain)).toBeLessThan(0.6);
    await runCommand(page, 'drop 4');
    await waitTicks(page, 240);
    const boxes = await probe<{ y: number }[]>(page, 'boxes');
    expect(boxes).toHaveLength(4);
    for (const b of boxes) {
      expect(b.y).toBeGreaterThan(ray.y - 1);
      expect(b.y).toBeLessThan(ray.y + 6);
    }
    expect(errors).toEqual([]);
  });

  test('a heavy impact knocks a street prop loose', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await goto(page, 'street');
    const result = await runCommand(page, 'knocktest');
    expect(result.ok, result.output).toBe(true);
    await waitTicks(page, 120);
    const knocked = await probe<number[]>(page, 'knocked');
    expect(knocked.length).toBeGreaterThanOrEqual(1);
    const props = await probe<{ debris: number }>(page, 'props');
    expect(props.debris).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });
});
