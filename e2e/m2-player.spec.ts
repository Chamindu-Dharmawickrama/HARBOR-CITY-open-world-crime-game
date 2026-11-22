import { expect, test, type Page } from '@playwright/test';
import { bootGame, probe, runCommand, screenshot, waitTicks } from './helpers';

interface PlayerProbe {
  x: number;
  y: number;
  z: number;
  mode: string;
  grounded: boolean;
  crouched: boolean;
  speed: number;
  health: number;
  dead: boolean;
  deaths: number;
  placing: boolean;
  landings: number;
  waterEntries: number;
  anim: string;
}

interface CameraProbe {
  x: number;
  y: number;
  z: number;
  distance: number;
  blocked: boolean;
  audited: number;
  clipped: number;
  aiming: boolean;
  shoulder: number;
}

interface Spot {
  x: number;
  y: number;
  z: number;
}

const BOOT = 'test=1&preset=low';

async function command(page: Page, line: string): Promise<string> {
  const result = await runCommand(page, line);
  expect(result.ok, result.output).toBe(true);
  return result.output;
}

/** Waits until the player stands on (or swims in) loaded ground after a spawn/teleport. */
async function settled(page: Page): Promise<PlayerProbe> {
  await page.waitForFunction(
    () => {
      const p = window.__HARBOR__?.probe('player') as { placing: boolean; mode: string } | undefined;
      return p !== undefined && !p.placing && (p.mode === 'ground' || p.mode === 'swim');
    },
    undefined,
    { timeout: 90_000 },
  );
  await waitTicks(page, 20);
  return probe<PlayerProbe>(page, 'player');
}

async function hold(page: Page, keys: string[], ticks: number): Promise<void> {
  for (const key of keys) await page.evaluate((k) => window.__HARBOR__?.input.keyDown(k), key);
  await waitTicks(page, ticks);
  for (const key of keys) await page.evaluate((k) => window.__HARBOR__?.input.keyUp(k), key);
}

async function tap(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => window.__HARBOR__?.input.keyDown(k), key);
  await waitTicks(page, 2);
  await page.evaluate((k) => window.__HARBOR__?.input.keyUp(k), key);
}

async function course(page: Page, spot: string): Promise<{ player: PlayerProbe; spot: Spot }> {
  await command(page, `tpplayer ${spot}`);
  const player = await settled(page);
  const spots = await probe<Record<string, Spot>>(page, 'course');
  return { player, spot: spots[spot] };
}

test.describe('M2 — player on foot', () => {
  test('spawns on a downtown sidewalk and walks with the third-person camera', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    const start = await settled(page);
    expect(start.mode).toBe('ground');
    expect(start.health).toBe(100);
    await expect(page.getByTestId('hud-vitals')).toBeVisible();
    await screenshot(page, 'M2', 'spawn');
    await hold(page, ['KeyW'], 90);
    const after = await probe<PlayerProbe>(page, 'player');
    expect(Math.hypot(after.x - start.x, after.z - start.z)).toBeGreaterThan(3);
    const camera = await probe<CameraProbe>(page, 'playerCamera');
    expect(Math.hypot(camera.x - after.x, camera.z - after.z)).toBeGreaterThan(1);
    expect(camera.clipped).toBe(0);
    await screenshot(page, 'M2', 'walk');
    expect(errors).toEqual([]);
  });

  test('sprints, jumps, crouches and aims over the shoulder', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    const { player: start } = await course(page, 'start');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('ShiftLeft'));
    await hold(page, ['KeyW'], 60);
    const sprinting = await probe<PlayerProbe>(page, 'player');
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('ShiftLeft'));
    expect(sprinting.speed).toBeGreaterThan(5.5);
    expect(Math.hypot(sprinting.x - start.x, sprinting.z - start.z)).toBeGreaterThan(4);

    const landings = (await probe<PlayerProbe>(page, 'player')).landings;
    await tap(page, 'Space');
    await page.waitForFunction(
      (n) => ((window.__HARBOR__?.probe('player') as { landings: number }).landings ?? 0) > n,
      landings,
      { timeout: 60_000 },
    );
    expect((await probe<PlayerProbe>(page, 'player')).mode).toBe('ground');

    await tap(page, 'KeyC');
    await waitTicks(page, 20);
    expect((await probe<PlayerProbe>(page, 'player')).crouched).toBe(true);
    await screenshot(page, 'M2', 'crouch');
    await tap(page, 'KeyC');
    await waitTicks(page, 5);
    expect((await probe<PlayerProbe>(page, 'player')).crouched).toBe(false);

    await page.evaluate(() => window.__HARBOR__?.input.mouseButton(2, true));
    await waitTicks(page, 30);
    let camera = await probe<CameraProbe>(page, 'playerCamera');
    expect(camera.aiming).toBe(true);
    expect(camera.distance).toBeLessThan(2.2);
    await screenshot(page, 'M2', 'aim');
    await tap(page, 'KeyX');
    await waitTicks(page, 5);
    camera = await probe<CameraProbe>(page, 'playerCamera');
    expect(camera.shoulder).toBe(-1);
    await page.evaluate(() => window.__HARBOR__?.input.mouseButton(2, false));
    expect(errors).toEqual([]);
  });

  test('climbs a 1.2 m wall but not a 2.6 m wall', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    const { spot } = await course(page, 'wall12');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await waitTicks(page, 10);
    await tap(page, 'Space');
    await waitTicks(page, 90);
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    // The wall is 0.8 m thick: the only way to its far side (z > spot + 2.2) is over the top.
    const climbed = await probe<PlayerProbe>(page, 'player');
    expect(climbed.z).toBeGreaterThan(spot.z + 2.3);
    expect(climbed.mode).toBe('ground');
    await screenshot(page, 'M2', 'climb');

    const { spot: high } = await course(page, 'wall26');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await waitTicks(page, 10);
    await tap(page, 'Space');
    await waitTicks(page, 90);
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    const blocked = await probe<PlayerProbe>(page, 'player');
    expect(blocked.y).toBeLessThan(high.y + 0.2);
    expect(blocked.z).toBeLessThan(high.z + 1.4);
    expect(errors).toEqual([]);
  });

  test('a 10 m fall hurts; a 30 m fall FLATLINES and the player respawns', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    const { player: top } = await course(page, 'tower10');
    expect(top.health).toBe(100);
    const landed = top.landings;
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await page.waitForFunction(
      (n) => (window.__HARBOR__?.probe('player') as { landings: number }).landings > n,
      landed,
      { timeout: 60_000 },
    );
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    await waitTicks(page, 10);
    const hurt = await probe<PlayerProbe>(page, 'player');
    expect(hurt.dead).toBe(false);
    expect(hurt.health).toBeLessThan(85);
    expect(hurt.health).toBeGreaterThan(20);

    await course(page, 'tower30');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await page.waitForFunction(
      () => (window.__HARBOR__?.probe('player') as { dead: boolean }).dead,
      undefined,
      {
        timeout: 60_000,
      },
    );
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    await expect(page.getByTestId('status-screen')).toContainText('FLATLINED');
    await screenshot(page, 'M2', 'flatlined');
    await page.waitForFunction(
      () => {
        const p = window.__HARBOR__?.probe('player') as { dead: boolean; deaths: number };
        return !p.dead && p.deaths === 1;
      },
      undefined,
      { timeout: 90_000 },
    );
    const respawned = await settled(page);
    expect(respawned.health).toBe(100);
    const status = await probe<{ visible: boolean }>(page, 'status');
    expect(status.visible).toBe(false);
    expect(errors).toEqual([]);
  });

  test('swims in the harbour and climbs out onto the pontoon', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    const { player: swimmer, spot } = await course(page, 'water');
    expect(swimmer.mode).toBe('swim');
    await screenshot(page, 'M2', 'swim');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyW'));
    await page.waitForFunction(
      (x) => (window.__HARBOR__?.probe('player') as { x: number }).x > x + 6,
      spot.x,
      { timeout: 60_000 },
    );
    await tap(page, 'Space');
    await waitTicks(page, 150);
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyW'));
    const out = await probe<PlayerProbe>(page, 'player');
    expect(out.mode).toBe('ground');
    expect(out.y).toBeGreaterThan(spot.y + 1);
    expect(errors).toEqual([]);
  });

  test('camera never clips while walking along walls with a sweeping view', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    await course(page, 'wallwalk');
    // Look south so the boom points back into the tall wall north of the path.
    await command(page, 'camlook 180 -8');
    await command(page, 'camaudit reset');
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyA'));
    let blockedSeen = false;
    for (let i = 0; i < 16; i++) {
      await page.evaluate((dx) => window.__HARBOR__?.input.mouseMove(dx, 0), i % 8 < 4 ? 60 : -60);
      await waitTicks(page, 12);
      if ((await probe<CameraProbe>(page, 'playerCamera')).blocked) blockedSeen = true;
    }
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyA'));
    const camera = await probe<CameraProbe & { firstClip: unknown }>(page, 'playerCamera');
    expect(blockedSeen).toBe(true);
    expect(camera.audited).toBeGreaterThan(30);
    expect(camera.clipped, JSON.stringify(camera.firstClip)).toBe(0);
    await screenshot(page, 'M2', 'camera-wall');
    expect(errors).toEqual([]);
  });

  test('pause menu: rebinding a key persists across a reload', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settled(page);
    // Escape is the pause action: the menu opens and the simulation stops (so no tick waits here).
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('Escape'));
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('Escape'));
    const pausedAt = await page.evaluate(() => window.__HARBOR__?.tick() ?? 0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__HARBOR__?.tick() ?? 0)).toBe(pausedAt);
    await page.getByTestId('menu-controls').click();
    await expect(page.getByTestId('controls-panel')).toBeVisible();
    await page.locator('button[data-action="jump"][data-device="kbm"][data-ordinal="0"]').click();
    await page.keyboard.press('KeyJ');
    await expect(page.locator('button[data-action="jump"][data-device="kbm"][data-ordinal="0"]')).toHaveText(
      'J',
    );
    await screenshot(page, 'M2', 'controls');
    const stored = await probe<{ bindings: { jump: { code?: string }[] } }>(page, 'settings');
    expect(stored.bindings.jump.some((b) => b.code === 'KeyJ')).toBe(true);
    await page.getByTestId('menu-back').click();
    await page.getByTestId('menu-resume').click();
    await expect(page.getByTestId('pause-menu')).toBeHidden();
    await waitTicks(page, 5);

    await page.reload();
    await page.waitForFunction(() => window.__HARBOR__?.ready === true, undefined, { timeout: 90_000 });
    const reloaded = await probe<{ bindings: { jump: { code?: string }[] } }>(page, 'settings');
    expect(reloaded.bindings.jump.some((b) => b.code === 'KeyJ')).toBe(true);
    expect(reloaded.bindings.jump.some((b) => b.code === 'Space')).toBe(false);
    expect(errors).toEqual([]);
  });
});
