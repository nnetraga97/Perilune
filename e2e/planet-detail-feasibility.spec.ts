import { expect, test } from '@playwright/test';

test('planet detail prototype pins adapters, budgets, fallback, and cube gutters', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?proto=planet-detail');
  await page.waitForFunction(() => Boolean((window as unknown as { __PLANET_DETAIL_PROTO__?: unknown }).__PLANET_DETAIL_PROTO__));
  const snapshot = await page.evaluate(() => (window as unknown as { __PLANET_DETAIL_PROTO__: {
    sources: Array<{ datasetId: string; direct: boolean; address: string }>;
    budgets: { mediumGpuBytes: number; highGpuBytes: number; mediumRequests: number; highRequests: number };
    cubePage: { width: number; height: number; gutter: number; checksum: number };
    fallback: string;
    numericSources: Array<{ datasetId: string; verticalDatum: string; url: string }>;
  } }).__PLANET_DETAIL_PROTO__);
  expect(errors).toEqual([]);
  expect(snapshot.sources.map((source) => source.datasetId)).toEqual([
    'nasa-gibs-bmng-500m-v1', 'nasa-moontrek-wac-303ppd-v02', 'usda-naip-ksc-2025-29992',
  ]);
  expect(snapshot.sources[2]).toMatchObject({ direct: false });
  expect(snapshot.sources[2].address).toContain('/api/planet-data?datasetId=usda-naip-ksc-2025-29992');
  expect(snapshot.budgets).toEqual({
    mediumGpuBytes: 32 * 1024 * 1024,
    highGpuBytes: 64 * 1024 * 1024,
    mediumRequests: 96,
    highRequests: 192,
  });
  expect(snapshot.cubePage).toMatchObject({ width: 68, height: 68, gutter: 2 });
  expect(snapshot.cubePage.checksum).not.toBe(0);
  expect(snapshot.fallback).toBe('resident-parent');
  expect(snapshot.numericSources.map((source) => source.datasetId)).toEqual([
    'usgs-3dep-ksc-1m-86037', 'nasa-moontrek-lola-global-128ppd-v04',
  ]);
  expect(snapshot.numericSources[0].verticalDatum).toBe('NAVD88/GEOID18');
});
