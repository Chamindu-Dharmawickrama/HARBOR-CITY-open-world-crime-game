#!/usr/bin/env node
/**
 * Headed GPU benchmark. Builds the game, serves dist/, opens Chromium with GPU access for each
 * quality preset, runs the in-game benchmark scenario (?bench=<scenario>) and writes the results
 * to bench-results/. Frame pacing is uncapped (vsync off) so results show real headroom.
 *
 *   npm run bench -- --presets=low,medium,high --scenario=playground --gpu=low-power
 *
 * Options: --scenario=<name> (default playground) · --presets=<list> (default medium)
 *          --gpu=default|low-power|high-performance · --width/--height (default 1920x1080)
 *          --no-build · --headless (software fallback; numbers are not representative)
 *          --vsync (normal presentation at the display rate; checks real-world hitching)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}`;

function parseArgs(argv) {
  const options = {
    scenario: 'playground',
    presets: ['medium'],
    gpu: 'default',
    width: 1920,
    height: 1080,
    build: true,
    headless: false,
    vsync: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'scenario' && value) options.scenario = value;
    else if (key === 'presets' && value) options.presets = value.split(',').filter(Boolean);
    else if (key === 'gpu' && value) options.gpu = value;
    else if (key === 'width' && value) options.width = Number(value);
    else if (key === 'height' && value) options.height = Number(value);
    else if (key === 'no-build') options.build = false;
    else if (key === 'headless') options.headless = true;
    else if (key === 'vsync') options.vsync = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not start at ${url}`);
}

function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

function formatRow(r) {
  const f = (n, d = 1) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(d));
  return [
    r.preset.padEnd(7),
    f(r.fps).padStart(6),
    f(r.frameMs.mean, 2).padStart(7),
    f(r.frameMs.p95, 2).padStart(7),
    f(r.frameMs.p99, 2).padStart(7),
    f(r.cpuMs.mean, 2).padStart(7),
    f(r.drawCalls.mean, 0).padStart(6),
    f(r.triangles.mean / 1000, 0).padStart(7),
    f(r.heapGrowthMBps, 2).padStart(8),
    String(r.framesOver50ms ?? 'n/a').padStart(5),
    `${r.width}x${r.height}`,
  ].join('  ');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) {
    const build = spawnSync('npx vite build', { stdio: 'inherit', shell: true });
    if (build.status !== 0) throw new Error('vite build failed');
  }
  const server = spawn(`npx vite preview --port ${PORT} --strictPort`, {
    stdio: 'ignore',
    shell: true,
  });
  const results = [];
  try {
    await waitForServer(BASE_URL, 30_000);
    for (const preset of options.presets) {
      const browser = await chromium.launch({
        headless: options.headless,
        args: [
          '--ignore-gpu-blocklist',
          ...(options.gpu === 'high-performance' ? ['--force_high_performance_gpu'] : []),
          ...(options.gpu === 'low-power' ? ['--force_low_power_gpu'] : []),
          '--enable-gpu-rasterization',
          ...(options.vsync ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']),
          `--window-size=${options.width},${options.height}`,
        ],
      });
      try {
        const page = await browser.newPage({
          viewport: { width: options.width, height: options.height },
          deviceScaleFactor: 1,
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        const query = `bench=${options.scenario}&preset=${preset}&gpu=${options.gpu}`;
        await page.goto(`${BASE_URL}/?${query}`);
        await page.waitForFunction(() => window.__HARBOR__?.bench.done === true, undefined, {
          timeout: 180_000,
        });
        const result = await page.evaluate(() => window.__HARBOR__.bench.result);
        results.push({ ...result, errors });
        console.log(`  ${preset}: ${result.fps.toFixed(1)} fps on ${result.gpu}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    stopServer(server);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join('bench-results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${options.scenario}.json`);
  const machine = {
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
  };
  writeFileSync(file, JSON.stringify({ options, machine, results }, null, 2));

  const pacing = options.vsync
    ? 'vsync'
    : 'uncapped (vsync off; D3D present-queue stalls can appear as >50 ms frames)';
  console.log(`\nScenario ${options.scenario} · ${pacing} · ${machine.cpu}`);
  console.log(`GPU: ${results[0]?.gpu ?? 'n/a'}`);
  console.log('preset     fps  avg ms  p95 ms  p99 ms  cpu ms  draws  ktris  heapMB/s  >50ms  resolution');
  for (const r of results) console.log(formatRow(r));
  for (const r of results) {
    if (r.longTasks)
      console.log(
        `  ${r.preset} long tasks: ${r.longTasks.count} (max ${r.longTasks.maxMs.toFixed(0)} ms, total ${r.longTasks.totalMs.toFixed(0)} ms)`,
      );
    for (const h of (r.hitches ?? []).slice(0, 5)) {
      console.log(
        `  hitch ${r.preset} t=${h.atSeconds.toFixed(1)}s frame ${h.frameMs.toFixed(1)} ms cpu ${h.cpuMs.toFixed(1)} ms: ${h.systems.map((x) => `${x.name} ${x.ms.toFixed(1)}`).join(', ')}`,
      );
    }
  }
  const failures = results.filter((r) => r.errors.length > 0);
  for (const r of failures) console.log(`\n${r.preset} console errors:\n  ${r.errors.join('\n  ')}`);
  console.log(`\nSaved ${file}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
