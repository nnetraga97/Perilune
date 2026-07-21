import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { SOL_REFERENCE_STATION_IDS } from './helpers/solReferenceStations';

const outputRoot = path.resolve('test-results/sol-visual-reference');

async function screenshotLuminance(pathname: string): Promise<Record<string, number>> {
  const { data, info } = await sharp(pathname).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const values = new Float32Array(info.width * info.height);
  let clippedBlack = 0;
  let clippedWhite = 0;
  for (let pixel = 0; pixel < values.length; pixel++) {
    const offset = pixel * info.channels;
    const luminance = (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) / 255;
    values[pixel] = luminance;
    if (luminance <= 1 / 255) clippedBlack++;
    if (luminance >= 254 / 255) clippedWhite++;
  }
  values.sort();
  const percentile = (fraction: number): number => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  return {
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
    clippedBlackFraction: clippedBlack / values.length,
    clippedWhiteFraction: clippedWhite / values.length,
  };
}

for (const quality of ['low', 'medium', 'high'] as const) {
  test.describe(`Sol visual references ${quality}`, () => {
    for (const station of SOL_REFERENCE_STATION_IDS) {
      test(`${station}`, async ({ page, browserName }) => {
        test.setTimeout(90_000);
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') runtimeErrors.push(message.text());
        });
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(`/?proto=sol-visual-reference&quality=${quality}&station=${station}`);
        await page.waitForFunction(() => (
          (window as Window & { __solVisualReference?: { ready: boolean } }).__solVisualReference?.ready === true
        ));
        const metadata = await page.evaluate(() => (
          (window as Window & { __solVisualReference?: { metadata: Record<string, unknown> } })
            .__solVisualReference!.metadata
        ));
        await mkdir(path.join(outputRoot, quality), { recursive: true });
        const imagePath = path.join(outputRoot, quality, `${station}.png`);
        const sidecarPath = path.join(outputRoot, quality, `${station}.json`);
        await page.screenshot({ path: imagePath });
        const postToneMapLuminance = await screenshotLuminance(imagePath);
        await writeFile(sidecarPath, `${JSON.stringify({ browserName, runtimeErrors, postToneMapLuminance, ...metadata }, null, 2)}\n`);
        expect(runtimeErrors).toEqual([]);
        expect(metadata).toMatchObject({ quality, shadows: quality !== 'low' });
      });
    }
  });
}
