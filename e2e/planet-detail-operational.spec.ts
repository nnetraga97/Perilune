import { expect, test } from '@playwright/test';
import sharp from 'sharp';

function floatStripTiff(width: number, height: number): Buffer {
  const entries: ReadonlyArray<readonly [number, number, number]> = [
    [256, 4, width], [257, 4, height], [258, 3, 32], [259, 3, 1], [262, 3, 1],
    [273, 4, 134], [277, 3, 1], [278, 4, height], [279, 4, width * height * 4], [339, 3, 3],
  ];
  const bytes = Buffer.alloc(134 + width * height * 4);
  bytes.writeUInt8(0x49, 0); bytes.writeUInt8(0x49, 1); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    bytes.writeUInt16LE(tag, offset); bytes.writeUInt16LE(type, offset + 2); bytes.writeUInt32LE(1, offset + 4);
    if (type === 3) bytes.writeUInt16LE(value, offset + 8); else bytes.writeUInt32LE(value, offset + 8);
  });
  bytes.writeUInt32LE(0, 130);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    bytes.writeFloatLE(-800 + x * 0.8 + y * 0.35, 134 + (y * width + x) * 4);
  }
  return bytes;
}

async function waitForReference(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(() => (
    (window as Window & { __solVisualReference?: { ready: boolean } }).__solVisualReference?.ready === true
  ));
  return page.evaluate(() => (
    (window as Window & { __solVisualReference?: { metadata: Record<string, unknown> } })
      .__solVisualReference!.metadata
  ));
}

test('offline and corrupt detail responses retain the resident parent without runtime errors', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/gibs\.earthdata\.nasa\.gov|trek\.nasa\.gov|\/api\/planet-data/, async (route) => {
    if (route.request().url().includes('trekarcgis')) {
      await route.abort('internetdisconnected');
    } else {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: '<html>not an image</html>' });
    }
  });
  await page.goto('/?proto=sol-visual-reference&quality=medium&station=moon-low-orbit');
  const metadata = await waitForReference(page);
  const stats = metadata.rendererStats as Record<string, unknown>;
  expect(errors).toEqual([]);
  expect(['disabled', 'failed']).toContain(stats.detailState);
  expect(['disabled', 'failed']).toContain(stats.terrainDetailState);
  expect(stats.detailGpuBytes).toBe(0);
  expect(stats.terrainDetailGpuBytes).toBe(0);
});

test('cold source pages become warm persistent-cache hits and class debug is opt-in', async ({ page }) => {
  test.setTimeout(120_000);
  const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#777777' } })
    .jpeg({ quality: 80 })
    .toBuffer();
  const earthTile = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#557060' } })
    .jpeg({ quality: 80 })
    .toBuffer();
  const heightTiff = floatStripTiff(258, 258);
  let wacNetworkRequests = 0;
  await page.route(/trek\.nasa\.gov/, async (route) => {
    if (route.request().url().includes('/tiles/Moon/EQ/')) {
      wacNetworkRequests++;
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: tile });
    } else if (route.request().url().includes('trekarcgis')) {
      await route.fulfill({ status: 200, contentType: 'image/tiff', body: heightTiff });
    } else {
      await route.abort('failed');
    }
  });
  await page.route(/gibs\.earthdata\.nasa\.gov/, (route) => route.fulfill({
    status: 200, contentType: 'image/jpeg', body: earthTile,
  }));
  await page.goto('/?proto=sol-visual-reference&quality=medium&station=moon-low-orbit');
  const cold = await waitForReference(page);
  const coldRequests = wacNetworkRequests;
  expect(coldRequests).toBeGreaterThan(0);
  wacNetworkRequests = 0;
  await page.reload();
  const warm = await waitForReference(page);
  expect(wacNetworkRequests).toBeLessThan(coldRequests);
  expect((cold.rendererStats as Record<string, unknown>).detailState).toBe('ready');
  expect((warm.rendererStats as Record<string, unknown>).detailState).toBe('ready');
  expect((cold.rendererStats as Record<string, unknown>)).toMatchObject({
    terrainDetailState: 'ready',
    terrainDetailHeightMode: 'shading-only',
    terrainDetailNumericDatasetId: 'nasa-moontrek-lola-global-128ppd-v04',
  });
  expect(Number((cold.rendererStats as Record<string, unknown>).terrainDetailNormalPages)).toBeGreaterThan(0);

  await page.goto('/?proto=sol-visual-reference&quality=medium&station=earth-ksc-coast-transect&diagnostic=surface-class');
  const classDebug = await waitForReference(page);
  expect(classDebug.diagnosticLayer).toBe('surface-class');
});
