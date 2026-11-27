import { expect, test, type Page } from '@playwright/test';
import { bootGame, probe, runCommand, screenshot, waitTicks } from './helpers';

interface TrafficProbe {
  count: number;
  physics: number;
  target: number;
  cap: number;
  stats: { redLightViolations: number; maxStalled: number; greenCrossings: number; forcedEntries: number };
  counters: { spawned: number; promotions: number };
  nearest: { mode: string; d: number; x: number; z: number; speed: number; driver: boolean }[];
}

interface PedsProbe {
  count: number;
  target: number;
  cap: number;
  fleeing: number;
  ragdolls: number;
  knockedDown: number;
  stats: { walkCrossings: number; signalViolations: number; hitByVehicle: number; panics: number };
  states: Record<string, number>;
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
      return p !== undefined && !p.placing && p.mode === 'ground';
    },
    undefined,
    { timeout: 90_000 },
  );
  await waitTicks(page, 20);
}

/** Polls a probe (every ~10 ticks) until the predicate holds; returns the last value. */
async function until<T>(
  page: Page,
  name: string,
  check: (value: T) => boolean,
  timeout = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe<T>(page, name);
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`probe ${name} never satisfied: ${JSON.stringify(value)}`);
    await waitTicks(page, 10);
  }
}

test.describe('M4 — traffic and pedestrians', () => {
  test('traffic drives the streets and pedestrians walk the sidewalks', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    const traffic = await until<TrafficProbe>(page, 'traffic', (v) => v.count >= 6 && v.physics >= 1);
    expect(traffic.count).toBeLessThanOrEqual(traffic.cap);
    const peds = await until<PedsProbe>(page, 'peds', (v) => v.count >= 8);
    expect(peds.count).toBeLessThanOrEqual(peds.cap);
    // Let it run, then check that the cars are moving, obeying the lights, never stuck.
    await waitTicks(page, 900);
    const later = await probe<TrafficProbe>(page, 'traffic');
    expect(later.stats.greenCrossings).toBeGreaterThan(0);
    expect(later.stats.redLightViolations).toBe(0);
    expect(later.stats.maxStalled).toBeLessThan(60);
    expect(later.nearest.some((c) => c.speed > 3)).toBe(true);
    expect(later.nearest.filter((c) => c.d < 60).every((c) => c.driver)).toBe(true);
    await screenshot(page, 'M4', 'street');
    expect(errors).toEqual([]);
  });

  test('pedestrians cross on walk signals', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    await command(page, 'nearsignal');
    await settle(page);
    await command(page, 'lanes on');
    const peds = await until<PedsProbe>(page, 'peds', (v) => v.stats.walkCrossings >= 2, 120_000);
    expect(peds.stats.signalViolations).toBe(0);
    await screenshot(page, 'M4', 'crosswalk');
    expect(errors).toEqual([]);
  });

  test('a gunshot makes people flee', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    await until<PedsProbe>(page, 'peds', (v) => v.count >= 8);
    await command(page, 'gunshot');
    const peds = await until<PedsProbe>(page, 'peds', (v) => v.fleeing >= 3, 20_000);
    expect(peds.stats.panics).toBeGreaterThanOrEqual(3);
    await waitTicks(page, 40);
    await screenshot(page, 'M4', 'panic');
    expect(errors).toEqual([]);
  });

  test('a car hitting a pedestrian ragdolls them', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    await until<PedsProbe>(page, 'peds', (v) => v.count >= 6);
    let hit = false;
    for (let attempt = 0; attempt < 4 && !hit; attempt++) {
      await command(page, 'pedtest 12');
      await waitTicks(page, 90);
      hit = (await probe<PedsProbe>(page, 'peds')).stats.hitByVehicle >= 1;
    }
    expect(hit).toBe(true);
    await screenshot(page, 'M4', 'ragdoll');
    const peds = await until<PedsProbe>(page, 'peds', (v) => v.knockedDown >= 1);
    expect(peds.knockedDown).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('carjack a traffic car: it stops, the driver is pulled out and it can be driven away', async ({
    page,
  }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    let driving = false;
    for (let attempt = 0; attempt < 6 && !driving; attempt++) {
      // A car standing (at a light or in a queue) with its driver, near the player.
      const traffic = await until<TrafficProbe>(
        page,
        'traffic',
        (v) => v.nearest.some((c) => c.mode === 'physics' && c.speed < 0.3 && c.driver && c.d < 120),
        120_000,
      );
      const car = traffic.nearest.find((c) => c.mode === 'physics' && c.speed < 0.3 && c.driver && c.d < 120);
      if (!car) continue;
      await command(page, `tpplayer ${car.x.toFixed(1)} ${(car.z + 3.2).toFixed(1)}`);
      await settle(page);
      await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyF'));
      await waitTicks(page, 2);
      await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyF'));
      try {
        await page.waitForFunction(
          () => (window.__HARBOR__?.probe('vehicle') as { phase: string }).phase === 'driving',
          undefined,
          { timeout: 15_000 },
        );
        driving = true;
      } catch {
        // The car drove off before we reached the door; try another one.
      }
    }
    expect(driving).toBe(true);
    // Reverse works in a car taken from traffic.
    await page.evaluate(() => window.__HARBOR__?.input.keyDown('KeyS'));
    await page.waitForFunction(
      () => ((window.__HARBOR__?.probe('vehicle') as { speedKmh: number }).speedKmh ?? 0) < -3,
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(() => window.__HARBOR__?.input.keyUp('KeyS'));
    await screenshot(page, 'M4', 'carjack-traffic');
    expect(errors).toEqual([]);
  });

  test('density follows the hour and the caps hold', async ({ page }) => {
    const errors = await bootGame(page, BOOT);
    await settle(page);
    await command(page, 'time 03:00 0');
    const night = await probe<{ target: number; cap: number }>(page, 'peds');
    const nightCars = await probe<{ target: number; cap: number }>(page, 'traffic');
    await command(page, 'time 17:30 0');
    const evening = await probe<{ target: number; cap: number }>(page, 'peds');
    const eveningCars = await probe<{ target: number; cap: number }>(page, 'traffic');
    expect(evening.target).toBeGreaterThan(night.target * 2);
    expect(eveningCars.target).toBeGreaterThan(nightCars.target * 2);
    expect(evening.target).toBeLessThanOrEqual(evening.cap);
    expect(eveningCars.target).toBeLessThanOrEqual(eveningCars.cap);
    // The populations follow the targets and never exceed the caps.
    await command(page, 'time 03:00 0');
    await until<PedsProbe>(page, 'peds', (v) => v.count <= v.target + 2, 90_000);
    for (let i = 0; i < 5; i++) {
      await waitTicks(page, 60);
      const p = await probe<PedsProbe>(page, 'peds');
      const t = await probe<TrafficProbe>(page, 'traffic');
      expect(p.count).toBeLessThanOrEqual(p.cap);
      expect(t.count).toBeLessThanOrEqual(t.cap);
    }
    expect(errors).toEqual([]);
  });
});
