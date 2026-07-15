import { expect, test, type Page } from '@playwright/test';
import { seedDiagnosticCraft } from './helpers/renderDiagnostics';

const mulePadCraft = Object.freeze({
  name: 'Veyra Diagnostic Orbiter',
  version: 1,
  parts: [
    {
      key: 1,
      defId: 'tank-m8',
      parentKey: null,
      attach: 'root',
      position: { x: 0, y: 2.7, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      resources: { propellant: 3_200 },
      symmetry: 0,
    },
    {
      key: 2,
      defId: 'eng-mule',
      parentKey: 1,
      attach: 'stack-bottom',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      resources: {},
      symmetry: 0,
    },
  ],
  stages: [{ partKeys: [2] }],
  nextKey: 3,
});

interface PadRenderSnapshot {
  transition: Record<string, unknown> | null;
  terrain: Record<string, unknown> | null;
  anomalies: readonly string[];
}

async function padRenderSnapshot(page: Page): Promise<PadRenderSnapshot> {
  return page.evaluate(() => {
    const snapshot = window.__RENDER_DIAGNOSTICS__?.snapshot();
    const entries = snapshot?.entries ?? [];
    const latest = (event: string): Record<string, unknown> | null => {
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index].event === event) return entries[index].data;
      }
      return null;
    };
    return {
      transition: latest('presentation-state'),
      terrain: latest('terrain-sample'),
      anomalies: snapshot?.anomalyCodes ?? [],
    };
  });
}

test('stationary Veyra launch anchors its fallback and establishes terrain without camera input', async ({ page }) => {
  test.setTimeout(120_000);
  await seedDiagnosticCraft(page, mulePadCraft);
  await page.goto('/?quality=high&renderDebug=1');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await page.getByRole('button', { name: 'Veyra Diagnostic Orbiter' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(2);
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');

  await expect.poll(
    async () => (await padRenderSnapshot(page)).transition?.compactAnchorSource,
    { timeout: 5_000 },
  ).toBe('surface');
  const anchored = await padRenderSnapshot(page);
  expect(anchored.transition?.compactAnchorHeightMeters).toEqual(expect.any(Number));
  expect(anchored.transition?.compactAnchorHeightMeters as number).toBeGreaterThan(5_000);
  expect(anchored.transition?.compactRadiusMeters as number).toBeGreaterThan(1_005_000);

  await expect.poll(
    async () => (await padRenderSnapshot(page)).terrain?.coverageReady,
    { timeout: 30_000, intervals: [100, 250, 500, 1_000] },
  ).toBe(true);
  await expect.poll(
    async () => (await padRenderSnapshot(page)).transition?.state,
    { timeout: 5_000 },
  ).toBe('terrain');
  await expect.poll(
    async () => (await padRenderSnapshot(page)).terrain?.pending,
    { timeout: 30_000, intervals: [100, 250, 500, 1_000] },
  ).toBe(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapStart = await page.evaluate(() => (
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
  ));
  await page.waitForTimeout(30_000);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapEnd = await page.evaluate(() => (
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
  ));
  if (heapStart > 0 && heapEnd > 0) expect(heapEnd - heapStart).toBeLessThan(30 * 1024 * 1024);
  const settled = await padRenderSnapshot(page);
  expect(
    settled.terrain?.selectionReused,
    `selection invalidation: ${String(settled.terrain?.selectionInvalidation)}`,
  ).toBe(true);
  expect(settled.terrain?.oldestPendingAgeMs as number).toBeLessThanOrEqual(5_000);

  await page.locator('#game-canvas').hover();
  for (let index = 0; index < 40; index++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(500);
  await expect.poll(
    async () => (await padRenderSnapshot(page)).terrain?.coverageReady,
    { timeout: 10_000 },
  ).toBe(true);
  const zoomed = await padRenderSnapshot(page);
  expect(zoomed.transition?.state).toBe('terrain');
  expect(zoomed.terrain?.desiredLeaves as number).toBeLessThanOrEqual(640);
  expect(zoomed.terrain?.balanceViolations).toBe(0);
  expect(zoomed.terrain?.selectionPasses as number).toBeLessThanOrEqual(2);
  expect(zoomed.anomalies).not.toEqual(expect.arrayContaining([
    'terrain-coverage-readiness-lost',
    'transition-coverage-readiness-lost',
    'transition-rollback-without-request-change',
    'transition-zero-visible-coverage',
    'terrain-desired-leaf-cap-unreachable',
    'terrain-neighbor-depth-violation',
  ]));
});
