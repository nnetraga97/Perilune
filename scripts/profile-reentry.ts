import { chromium, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWayfarerDemonstrator } from '../src/content/crafts';
import { createReentryFixtureSave, loadReentrySave, seedReentrySave } from '../e2e/helpers/reentryFixture';
import { observeSanitizedMacHost } from './lib/host-observation.mjs';
import { allocateLoopbackPort, stopProcessTree, waitForServerOrExit } from './lib/profiler-process.mjs';

interface PerfSnapshot {
  readonly frameMs: number;
  readonly frameP95: number;
  readonly renderMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly gpuTimingSupported: boolean;
  readonly flightGpuMs: number | null;
  readonly gpuQueriesValid: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
}

interface BrowserIdentity {
  readonly userAgent: string;
  readonly webglVendor: string;
  readonly webglRenderer: string;
  readonly webglVersion: string;
}

const argumentsMap = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (!argument.startsWith('--')) continue;
  const [key, inline] = argument.slice(2).split('=', 2);
  if (inline !== undefined) argumentsMap.set(key, inline);
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) argumentsMap.set(key, process.argv[++index]);
  else argumentsMap.set(key, 'true');
}

const mode = argumentsMap.get('mode') === 'reference' ? 'reference' : 'smoke';
const durationSeconds = Number(argumentsMap.get('duration') ?? (mode === 'reference' ? 30 : 4));
const runCount = Number(argumentsMap.get('runs') ?? (mode === 'reference' ? 3 : 1));
if (!(durationSeconds > 0) || !Number.isInteger(runCount) || runCount < 1) {
  throw new Error('--duration must be positive and --runs must be a positive integer');
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function median(values: readonly number[]): number { return percentile(values, 0.5); }

async function collectRun(page: Page, origin: string, enabled: boolean, durationMs: number) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await seedReentrySave(page, createReentryFixtureSave(createWayfarerDemonstrator()));
  await page.goto(`${origin}/?quality=medium&renderDebug=1${enabled ? '' : '&reentryVfx=0'}`);
  await loadReentrySave(page);
  const browserIdentity = await page.evaluate((): BrowserIdentity => {
    const canvas = document.querySelector('#game-canvas') as HTMLCanvasElement | null;
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      webglVendor: gl && debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : '',
      webglRenderer: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '',
      webglVersion: gl ? String(gl.getParameter(gl.VERSION)) : '',
    };
  });
  if (enabled) {
    await page.waitForFunction(() => {
      const stats = (window as unknown as {
        __TEST__: { reentryStats(): { glow: boolean; trails: boolean; bowshock: boolean; particles: number } | null };
      }).__TEST__.reentryStats();
      return stats?.glow === true && stats.trails === true && stats.bowshock === true && stats.particles > 0;
    }, undefined, { timeout: 10_000 });
  } else {
    await page.waitForTimeout(750);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4_000);
  const samples: PerfSnapshot[] = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const snapshot = await page.evaluate(() => (window as unknown as { __PERF__: PerfSnapshot }).__PERF__);
    if (snapshot?.drawingBufferWidth === 1920 && snapshot.drawingBufferHeight === 1080) samples.push(snapshot);
    await page.waitForTimeout(250);
  }
  if (samples.length < 4) throw new Error('Profiler collected too few settled samples');
  const gpu = samples.flatMap((sample) => sample.flightGpuMs === null ? [] : [sample.flightGpuMs]);
  return {
    enabled,
    browserIdentity,
    samples: samples.length,
    errors,
    frameMeanMedianMs: median(samples.map((sample) => sample.frameMs)),
    frameP95MedianMs: median(samples.map((sample) => sample.frameP95)),
    renderMedianMs: median(samples.map((sample) => sample.renderMs)),
    renderP95Ms: percentile(samples.map((sample) => sample.renderMs), 0.95),
    flightGpuMedianMs: gpu.length > 0 ? median(gpu) : null,
    flightGpuP95Ms: gpu.length > 0 ? percentile(gpu, 0.95) : null,
    gpuTimingSupported: samples.some((sample) => sample.gpuTimingSupported),
    gpuQueriesValid: Math.max(...samples.map((sample) => sample.gpuQueriesValid)),
    drawCallsMedian: median(samples.map((sample) => sample.drawCalls)),
    trianglesMedian: median(samples.map((sample) => sample.triangles)),
  };
}

const root = resolve(import.meta.dirname, '..');
const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const port = await allocateLoopbackPort();
const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
preview.stdout.on('data', (chunk) => process.stdout.write(chunk));
preview.stderr.on('data', (chunk) => process.stderr.write(chunk));
let browser;
try {
  await waitForServerOrExit(preview, `http://127.0.0.1:${port}/`);
  const origin = `http://127.0.0.1:${port}`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    executablePath: existsSync(chrome) ? chrome : undefined,
    headless: mode !== 'reference',
    args: ['--disable-dev-shm-usage'],
  });
  type RunResult = Awaited<ReturnType<typeof collectRun>>;
  const results: Array<RunResult & { run: number }> = [];
  for (let run = 0; run < runCount; run++) {
    for (const enabled of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const result = await collectRun(page, origin, enabled, durationSeconds * 1_000);
      results.push({ run: run + 1, ...result });
      console.log(`${enabled ? 'enabled' : 'disabled'} run ${run + 1}: frame p95 ${result.frameP95MedianMs.toFixed(2)} ms, GPU ${result.flightGpuMedianMs?.toFixed(2) ?? 'n/a'} ms`);
      await context.close();
    }
  }
  const enabled = results.filter((result) => result.enabled);
  const disabled = results.filter((result) => !result.enabled);
  const aggregate = (runs: typeof results) => ({
    frameP95MedianMs: median(runs.map((run) => run.frameP95MedianMs)),
    renderP95MedianMs: median(runs.map((run) => run.renderP95Ms)),
    flightGpuMedianMs: runs.every((run) => run.flightGpuMedianMs !== null)
      ? median(runs.map((run) => run.flightGpuMedianMs as number)) : null,
    drawCallsMedian: median(runs.map((run) => run.drawCallsMedian)),
    trianglesMedian: median(runs.map((run) => run.trianglesMedian)),
  });
  const enabledAggregate = aggregate(enabled);
  const disabledAggregate = aggregate(disabled);
  const delta = {
    frameP95Ms: enabledAggregate.frameP95MedianMs - disabledAggregate.frameP95MedianMs,
    renderP95Ms: enabledAggregate.renderP95MedianMs - disabledAggregate.renderP95MedianMs,
    flightGpuMs: enabledAggregate.flightGpuMedianMs !== null && disabledAggregate.flightGpuMedianMs !== null
      ? enabledAggregate.flightGpuMedianMs - disabledAggregate.flightGpuMedianMs : null,
    drawCalls: enabledAggregate.drawCallsMedian - disabledAggregate.drawCallsMedian,
    triangles: enabledAggregate.trianglesMedian - disabledAggregate.trianglesMedian,
  };
  const host = observeSanitizedMacHost();
  const referenceHardware = host.chip === 'Apple M3 Max' && host.gpuCoreCount === 30
    && host.memoryBytes >= 32 * 1024 ** 3 && host.powerSource === 'AC Power';
  const allErrors = results.flatMap((result) => result.errors);
  const browserIdentities = results.map((result) => JSON.stringify(result.browserIdentity));
  const browserIdentityStable = new Set(browserIdentities).size === 1
    && results[0].browserIdentity.webglVendor.length > 0
    && results[0].browserIdentity.webglRenderer.length > 0;
  const gates = [
    { name: 'reference-hardware', pass: mode !== 'reference' || referenceHardware },
    { name: 'browser-identity', pass: mode !== 'reference' || browserIdentityStable },
    { name: 'runtime-errors', pass: allErrors.length === 0 },
    { name: 'enabled-frame-p95', limit: 16.7, value: enabledAggregate.frameP95MedianMs, pass: enabledAggregate.frameP95MedianMs <= 16.7 },
    { name: 'frame-p95-delta', limit: 1.5, value: delta.frameP95Ms, pass: delta.frameP95Ms <= 1.5 },
    { name: 'render-p95-delta', limit: 1.0, value: delta.renderP95Ms, pass: delta.renderP95Ms <= 1.0 },
    { name: 'flight-gpu', limit: 8, value: enabledAggregate.flightGpuMedianMs, pass: enabledAggregate.flightGpuMedianMs === null || enabledAggregate.flightGpuMedianMs <= 8 },
    { name: 'flight-gpu-delta', limit: 2, value: delta.flightGpuMs, pass: delta.flightGpuMs === null || delta.flightGpuMs <= 2 },
  ];
  const record = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    mode,
    durationSeconds,
    runCount,
    host,
    browser: {
      executable: existsSync(chrome) ? chrome : 'playwright chromium',
      version: browser.version(),
      headless: mode !== 'reference',
      identity: results[0].browserIdentity,
    },
    fixture: { quality: 'medium', viewport: [1920, 1080], pausedAfterFullStack: true },
    results,
    aggregate: { enabled: enabledAggregate, disabled: disabledAggregate, delta },
    gates,
    passed: gates.every((gate) => gate.pass),
  };
  const directory = resolve(root, 'artifacts/performance');
  await mkdir(directory, { recursive: true });
  const stamp = record.recordedAt.replaceAll(':', '-').replaceAll('.', '-');
  const path = resolve(directory, `reentry-vfx-${mode}-${stamp}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${path}`);
  console.log(JSON.stringify({ aggregate: record.aggregate, gates, passed: record.passed }, null, 2));
  if (!record.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  await stopProcessTree(preview);
}
