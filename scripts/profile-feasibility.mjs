import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const values = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (!argument.startsWith('--')) continue;
  const [key, inline] = argument.slice(2).split('=', 2);
  if (inline !== undefined) values.set(key, inline);
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) values.set(key, process.argv[++index]);
  else values.set(key, 'true');
}

const mode = values.get('mode') === 'reference' ? 'reference' : 'smoke';
const tier = values.get('tier') === 'low' ? 'low' : 'medium';
const stage = Number(values.get('stage') ?? 0);
if (!Number.isInteger(stage) || stage < 0 || stage > 5) throw new Error('stage must be 0 through 5');

const reference = values.get('reference') ?? null;
const expectedReference = tier === 'medium' ? 'iris-xe' : 'uhd-620';
const metadataKeys = ['model', 'firmware', 'driver', 'os', 'power', 'sustained-power'];
const missingMetadata = reference ? metadataKeys.filter((key) => !values.get(key)) : [];
if (reference && mode !== 'reference') throw new Error('--reference requires --mode=reference');
if (missingMetadata.length > 0) {
  throw new Error(`A certifying reference run requires: ${missingMetadata.join(', ')}`);
}

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const preview = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
preview.stdout.on('data', (chunk) => process.stdout.write(chunk));
preview.stderr.on('data', (chunk) => process.stderr.write(chunk));

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:4173/');
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Timed out waiting for the preview server');
}

const browserPaths = [
  values.get('browser-path'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = browserPaths.find((path) => existsSync(path));
let browser;
let exitCode = 0;

try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath,
    headless: mode !== 'reference',
    args: ['--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  const disabled = values.get('disabled') ?? '';
  const url = `http://127.0.0.1:4173/?proto=feasibility&mode=${mode}&tier=${tier}&stage=${stage}` +
    (disabled ? `&disabled=${encodeURIComponent(disabled)}` : '');
  await page.goto(url);
  const timeout = mode === 'reference' ? 1_000_000 : 60_000;
  await page.waitForFunction(() => window.__FEASIBILITY_DONE__ === true, undefined, { timeout });
  const state = await page.evaluate(() => window.__FEASIBILITY__);
  const browserIdentity = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
  }));
  if (!state?.summary) throw new Error('Feasibility harness completed without a summary');

  const activeBudget = tier === 'medium' ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
  const totalBudget = tier === 'medium' ? 384 * 1024 * 1024 : 256 * 1024 * 1024;
  const gates = [
    { name: 'fpsMedian', actual: state.summary.fpsMedian, limit: tier === 'medium' ? 60 : 30, comparison: '>=', pass: state.summary.fpsMedian >= (tier === 'medium' ? 60 : 30) },
    { name: 'frameP95Ms', actual: state.summary.frameP95Ms, limit: tier === 'medium' ? 16.7 : 33.3, comparison: '<', pass: state.summary.frameP95Ms < (tier === 'medium' ? 16.7 : 33.3) },
    { name: 'activeGpuBytes', actual: state.scene.estimatedGpuBytes, limit: activeBudget, comparison: '<=', pass: state.scene.estimatedGpuBytes <= activeBudget },
    { name: 'totalRendererGpuBytes', actual: state.scene.estimatedRendererGpuBytes, limit: totalBudget, comparison: '<=', pass: state.scene.estimatedRendererGpuBytes <= totalBudget },
  ];
  if (tier === 'medium') {
    gates.push(
      { name: 'submissionP95Ms', actual: state.summary.submissionP95Ms, limit: 4, comparison: '<=', pass: state.summary.submissionP95Ms <= 4 },
      { name: 'terrainP95Ms', actual: state.summary.terrainP95Ms, limit: 2, comparison: '<=', pass: state.summary.terrainP95Ms <= 2 },
      {
        name: 'gpuP95Ms',
        actual: state.summary.gpuP95Ms,
        limit: 8,
        comparison: '<=',
        pass: state.summary.gpuP95Ms !== null && state.summary.validGpuSamples > 0 && state.summary.gpuP95Ms <= 8,
      },
    );
  }

  const eligible = mode === 'reference' && reference === expectedReference &&
    missingMetadata.length === 0 && !values.get('disabled');
  const record = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    mode,
    tier,
    reductionStage: stage,
    reference,
    metadata: Object.fromEntries(metadataKeys.map((key) => [key, values.get(key) ?? null])),
    browser: browserIdentity,
    runtimeErrors,
    state,
    certification: {
      eligible,
      expectedReference,
      passed: eligible && runtimeErrors.length === 0 && gates.every((gate) => gate.pass),
      gates,
      note: eligible
        ? 'Reference hardware record; gate result is authoritative for this run.'
        : 'Non-certifying observation; do not infer Iris Xe or UHD 620 performance from this run.',
    },
  };

  const outputDir = resolve(root, 'artifacts/performance');
  mkdirSync(outputDir, { recursive: true });
  const stamp = record.recordedAt.replaceAll(':', '-').replaceAll('.', '-');
  const outputPath = resolve(outputDir, `planet-feasibility-${tier}-${mode}-${stamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
  console.log(JSON.stringify(record.certification, null, 2));

  if (runtimeErrors.length > 0) exitCode = 1;
  if (eligible && !record.certification.passed) exitCode = 1;
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}

process.exitCode = exitCode;
