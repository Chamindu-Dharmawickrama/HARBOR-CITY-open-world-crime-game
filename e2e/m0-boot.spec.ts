import { expect, test } from '@playwright/test';
import { bootGame, probe, runCommand, screenshot, waitTicks } from './helpers';

interface PlaygroundProbe {
  boxes: number;
  minY: number;
  maxY: number;
  meanY: number;
  totalSpawned: number;
}

interface CameraProbe {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

interface StatsProbe {
  bodies: number;
  entities: number;
  drawCalls: number;
  gpu: string;
}

test.describe('M0 — engine boot', () => {
  test('boots with no console errors, shows the overlay and renders a non-blank scene', async ({ page }) => {
    const errors = await bootGame(page, 'test=1&preset=low&debug=1');
    await expect(page.getByTestId('debug-overlay')).toBeVisible();
    await waitTicks(page, 45);
    const color = await page.evaluate(() => window.__HARBOR__?.canvasProbe());
    expect(color?.luminanceVariance ?? 0).toBeGreaterThan(0.001);
    const stats = await probe<StatsProbe>(page, 'stats');
    expect(stats.drawCalls).toBeGreaterThan(0);
    expect(stats.entities).toBeGreaterThan(0);
    await screenshot(page, 'M0', 'boot-overlay');
    expect(errors).toEqual([]);
  });

  test('physics: dropped boxes fall and never pass through the ground', async ({ page }) => {
    const errors = await bootGame(page);
    await runCommand(page, 'autospawn off');
    await runCommand(page, 'reset');
    const spawn = await runCommand(page, 'spawn 20');
    expect(spawn.ok).toBe(true);
    const before = await probe<PlaygroundProbe>(page, 'playground');
    expect(before.boxes).toBe(20);
    await waitTicks(page, 240);
    const after = await probe<PlaygroundProbe>(page, 'playground');
    expect(after.boxes).toBe(20);
    expect(after.meanY).toBeLessThan(before.meanY - 5);
    expect(after.minY).toBeGreaterThan(-0.5);
    const stats = await probe<StatsProbe>(page, 'stats');
    expect(stats.bodies).toBe(20);
    await screenshot(page, 'M0', 'physics-settled');
    expect(errors).toEqual([]);
  });

  test('input: virtual device drives the camera through the binding layer', async ({ page }) => {
    const errors = await bootGame(page);
    const start = await probe<CameraProbe>(page, 'camera');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await waitTicks(page, 40);
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    const moved = await probe<CameraProbe>(page, 'camera');
    expect(moved.z).toBeLessThan(start.z - 1);
    await page.evaluate(() => window.__HARBOR__?.input.mouseMove(200, 0));
    await waitTicks(page, 5);
    const turned = await probe<CameraProbe>(page, 'camera');
    expect(turned.yaw).toBeLessThan(moved.yaw - 0.2);
    expect(errors).toEqual([]);
  });

  test('dev console: real keystrokes open it, run commands, and block game input', async ({ page }) => {
    const errors = await bootGame(page);
    await runCommand(page, 'autospawn off');
    await page.keyboard.press('Backquote');
    const input = page.getByTestId('console-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    const cameraBefore = await probe<CameraProbe>(page, 'camera');
    await input.pressSequentially('wwwwwwww');
    await input.fill('reset');
    await input.press('Enter');
    await input.fill('spawn 7');
    await input.press('Enter');
    await expect(page.locator('.hc-console-log')).toContainText('Spawned 7 box(es); 7 in scene.');
    const cameraAfter = await probe<CameraProbe>(page, 'camera');
    expect(cameraAfter.z).toBeCloseTo(cameraBefore.z, 3);
    await input.fill('nonsense');
    await input.press('Enter');
    await expect(page.locator('.hc-console-log')).toContainText('Unknown command');
    await screenshot(page, 'M0', 'dev-console');
    await input.press('Escape');
    await expect(input).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('pause, single-step and resume the fixed-step simulation', async ({ page }) => {
    const errors = await bootGame(page);
    await runCommand(page, 'pause');
    const pausedAt = await page.evaluate(() => window.__HARBOR__?.tick() ?? 0);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__HARBOR__?.tick() ?? 0)).toBe(pausedAt);
    expect((await runCommand(page, 'step 5')).ok).toBe(true);
    await page.waitForFunction((t) => (window.__HARBOR__?.tick() ?? 0) >= t, pausedAt + 5);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__HARBOR__?.tick() ?? 0)).toBe(pausedAt + 5);
    await runCommand(page, 'resume');
    await waitTicks(page, 10);
    expect(errors).toEqual([]);
  });
});
