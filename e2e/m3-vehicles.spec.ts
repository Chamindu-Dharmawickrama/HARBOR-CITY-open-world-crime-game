import { expect, test, type Page } from '@playwright/test';
import { bootGame, probe, runCommand, screenshot, waitTicks } from './helpers';

interface VehicleProbe {
  phase: string;
  id: number | null;
  model?: string;
  kind?: string;
  speedKmh?: number;
  gear?: number;
  engineOn?: boolean;
  engineHealth?: number;
  onFire?: boolean;
  wrecked?: boolean;
  glass?: string;
  dented?: boolean;
  chase: string;
  hotwire: number;
  entries: number;
}

interface VehiclesProbe {
  count: number;
  parked: number;
  npcs: number;
  fleeing: number;
  explosions: number;
  list: {
    id: number;
    model: string;
    d: number;
    driver: string;
    wrecked: boolean;
    locked: boolean;
    occupied: boolean;
  }[];
}

const BOOT = 'test=1&preset=low';

async function command(page: Page, line: string): Promise<string> {
  const result = await runCommand(page, line);
  expect(result.ok, result.output).toBe(true);
  return result.output;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = window.__HARBOR__?.probe('player') as { placing: boolean; mode: string } | undefined;
      return p !== undefined && !p.placing && (p.mode === 'ground' || p.mode === 'swim');
    },
    undefined,
    { timeout: 90_000 },
  );
  await waitTicks(page, 20);
}

async function key(page: Page, code: string, down: boolean): Promise<void> {
  await page.evaluate(
    ([c, d]) => (d ? window.__HARBOR__?.input.keyDown(c) : window.__HARBOR__?.input.keyUp(c)),
    [code, down] as const,
  );
}

async function tap(page: Page, code: string): Promise<void> {
  await key(page, code, true);
  await waitTicks(page, 2);
  await key(page, code, false);
}

async function phase(page: Page, wanted: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (w) => (window.__HARBOR__?.probe('vehicle') as { phase: string }).phase === w,
    wanted,
    {
      timeout,
    },
  );
}

async function vehicleOver(page: Page, field: 'speedKmh', value: number): Promise<void> {
  await page.waitForFunction(
    ([f, v]) => ((window.__HARBOR__?.probe('vehicle') as Record<string, number>)[f as string] ?? 0) > v,
    [field, value] as const,
    { timeout: 60_000 },
  );
}

async function toPad(page: Page, spot = 'pad'): Promise<void> {
  await settle(page);
  await command(page, `tpplayer ${spot}`);
  await settle(page);
}

test.describe('M3 — vehicles', () => {
  test('parked cars line the streets near the spawn', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    await page.waitForFunction(
      () => (window.__HARBOR__?.probe('vehicles') as { parked: number }).parked >= 4,
      undefined,
      {
        timeout: 60_000,
      },
    );
    const parking = await probe<{ spots: number; lot: number; curb: number }>(page, 'parking');
    expect(parking.lot).toBeGreaterThan(100);
    expect(parking.curb).toBeGreaterThan(100);
    await command(page, 'viewcar');
    await waitTicks(page, 5);
    await screenshot(page, 'M3', 'parked');
    expect(errors).toEqual([]);
  });

  test('walk up, get in with F, drive, steer, brake and get out', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await toPad(page);
    await command(page, 'spawncar meridian parked');
    await waitTicks(page, 30);
    await tap(page, 'KeyF');
    await phase(page, 'driving');
    let v = await probe<VehicleProbe>(page, 'vehicle');
    expect(v.model).toBe('meridian');
    expect(v.engineOn).toBe(true);
    await expect(page.getByTestId('vehicle-toast')).toContainText('Arbor Meridian');
    await key(page, 'KeyW', true);
    await vehicleOver(page, 'speedKmh', 35);
    await screenshot(page, 'M3', 'drive-chase');
    await key(page, 'KeyD', true);
    await waitTicks(page, 40);
    await key(page, 'KeyD', false);
    await key(page, 'KeyW', false);
    await tap(page, 'KeyV');
    await tap(page, 'KeyV');
    await waitTicks(page, 5);
    expect((await probe<VehicleProbe>(page, 'vehicle')).chase).toBe('hood');
    await screenshot(page, 'M3', 'drive-hood');
    await tap(page, 'KeyV');
    await tap(page, 'KeyV');
    await key(page, 'KeyS', true);
    await page.waitForFunction(
      () => Math.abs((window.__HARBOR__?.probe('vehicle') as { speedKmh: number }).speedKmh ?? 99) < 2,
      undefined,
      { timeout: 60_000 },
    );
    await key(page, 'KeyS', false);
    await tap(page, 'KeyF');
    await phase(page, 'foot');
    const player = await probe<{ mode: string; health: number }>(page, 'player');
    expect(player.health).toBe(100);
    v = await probe<VehicleProbe>(page, 'vehicle');
    expect(v.id).toBeNull();
    expect(errors).toEqual([]);
  });

  test('carjack: the driver is pulled out and runs', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await toPad(page);
    await command(page, 'spawncar cab driver');
    await waitTicks(page, 30);
    await tap(page, 'KeyF');
    await phase(page, 'jackPull');
    await screenshot(page, 'M3', 'carjack');
    await phase(page, 'driving');
    const vehicles = await probe<VehiclesProbe>(page, 'vehicles');
    expect(vehicles.fleeing).toBeGreaterThanOrEqual(1);
    expect((await probe<VehicleProbe>(page, 'vehicle')).engineOn).toBe(true);
    expect(errors).toEqual([]);
  });

  test('break into a locked car and hotwire it', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await toPad(page);
    await command(page, 'spawncar brisa locked');
    await waitTicks(page, 30);
    await tap(page, 'KeyF');
    await phase(page, 'hotwire');
    await expect(page.getByTestId('hotwire-bar')).toBeVisible();
    const v = await probe<VehicleProbe>(page, 'vehicle');
    expect(v.glass).toBe('cracked');
    expect(v.engineOn).toBe(false);
    await screenshot(page, 'M3', 'hotwire');
    await phase(page, 'driving');
    expect((await probe<VehicleProbe>(page, 'vehicle')).engineOn).toBe(true);
    expect(errors).toEqual([]);
  });

  test('crashes dent the body, then the engine burns and explodes', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await toPad(page, 'barrier');
    await command(page, 'spawncar meridian enter');
    await phase(page, 'driving');
    await key(page, 'KeyW', true);
    await page.waitForFunction(
      () => ((window.__HARBOR__?.probe('vehicle') as { engineHealth: number }).engineHealth ?? 1000) < 990,
      undefined,
      { timeout: 60_000 },
    );
    await key(page, 'KeyW', false);
    await waitTicks(page, 30);
    const crashed = await probe<VehicleProbe>(page, 'vehicle');
    expect(crashed.dented).toBe(true);
    await screenshot(page, 'M3', 'crash');
    // Get out, step back, set the engine alight from the console and wait for the bang.
    await tap(page, 'KeyF');
    await phase(page, 'foot');
    await command(page, 'tpplayer barrier');
    await settle(page);
    await command(page, 'vdamage 880 nearest');
    await page.waitForFunction(
      () => (window.__HARBOR__?.probe('vehicles') as { explosions: number }).explosions >= 1,
      undefined,
      { timeout: 60_000 },
    );
    await waitTicks(page, 20);
    await screenshot(page, 'M3', 'explosion');
    const vehicles = await probe<VehiclesProbe>(page, 'vehicles');
    expect(vehicles.list.some((x) => x.wrecked)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('ride a motorbike and pilot a boat', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await toPad(page);
    await command(page, 'spawncar sprint enter');
    await phase(page, 'driving');
    await key(page, 'KeyW', true);
    await vehicleOver(page, 'speedKmh', 30);
    await key(page, 'KeyA', true);
    await waitTicks(page, 30);
    await screenshot(page, 'M3', 'bike');
    await key(page, 'KeyA', false);
    await key(page, 'KeyW', false);
    expect((await probe<VehicleProbe>(page, 'vehicle')).kind).toBe('bike');

    await command(page, 'tpplayer mooring');
    await page.waitForFunction(
      () => (window.__HARBOR__?.probe('player') as { mode: string; placing: boolean }).mode === 'swim',
      undefined,
      { timeout: 60_000 },
    );
    await command(page, 'spawncar gullwing');
    await waitTicks(page, 60);
    await tap(page, 'KeyF');
    await phase(page, 'driving');
    await key(page, 'KeyW', true);
    await vehicleOver(page, 'speedKmh', 20);
    await screenshot(page, 'M3', 'boat');
    await key(page, 'KeyW', false);
    expect((await probe<VehicleProbe>(page, 'vehicle')).kind).toBe('boat');
    expect(errors).toEqual([]);
  });
});
