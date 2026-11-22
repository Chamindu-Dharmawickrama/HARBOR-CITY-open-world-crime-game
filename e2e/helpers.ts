import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { HarborTestApi } from '../src/debug/test-api';

export type { HarborTestApi };

/**
 * Opens the game with the given query, collects console errors and page errors, and waits
 * until the test API reports ready (engine booted and a few frames rendered).
 */
export async function bootGame(page: Page, query = 'test=1&preset=low'): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.__HARBOR__?.ready === true, undefined, { timeout: 90_000 });
  return errors;
}

/** Waits until the simulation has advanced by at least `ticks` fixed steps. */
export async function waitTicks(page: Page, ticks: number): Promise<number> {
  const start = await page.evaluate(() => window.__HARBOR__?.tick() ?? 0);
  await page.waitForFunction((target) => (window.__HARBOR__?.tick() ?? 0) >= target, start + ticks, {
    timeout: 90_000,
  });
  return page.evaluate(() => window.__HARBOR__?.tick() ?? 0);
}

export async function runCommand(page: Page, command: string): Promise<{ ok: boolean; output: string }> {
  return page.evaluate((c) => {
    const api = window.__HARBOR__;
    if (!api) throw new Error('test API missing');
    return api.run(c);
  }, command);
}

export async function probe<T>(page: Page, name: string): Promise<T> {
  return (await page.evaluate((n) => {
    const api = window.__HARBOR__;
    if (!api) throw new Error('test API missing');
    return api.probe(n);
  }, name)) as T;
}

/** Saves a screenshot under test-results/screenshots/<milestone>/<name>.png. */
export async function screenshot(page: Page, milestone: string, name: string): Promise<string> {
  const dir = path.join('test-results', 'screenshots', milestone);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
