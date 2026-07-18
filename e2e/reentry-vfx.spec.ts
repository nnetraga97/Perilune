import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createWayfarerDemonstrator } from '../src/content/crafts';
import {
  createReentryFixtureSave,
  loadReentrySave,
  seedReentrySave,
} from './helpers/reentryFixture';

interface VisualThresholds {
  readonly minimumWarmPixels: number;
  readonly maximumWarmPixels: number;
  readonly minimumHotPixels: number;
  readonly minimumHorizontalSpread: number;
  readonly minimumVerticalSpread: number;
}

async function plasmaSignature(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  // Keep the signature on the camera-centered craft. Veyra's ochre terrain
  // can enter the lower half of the canvas and must not count as plasma.
  const left = Math.floor(width * 0.33);
  const top = Math.floor(height * 0.28);
  const cropWidth = Math.max(1, Math.floor(width * 0.34));
  const cropHeight = Math.max(1, Math.floor(height * 0.27));
  const { data, info } = await image.extract({ left, top, width: cropWidth, height: cropHeight })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let warmPixels = 0;
  let hotPixels = 0;
  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const warm = red >= 135 && red - green >= 22 && green - blue >= 10;
      const hot = red >= 225 && green >= 155 && blue <= 155;
      if (hot) hotPixels++;
      if (!warm) continue;
      warmPixels++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    warmPixels,
    hotPixels,
    horizontalSpread: maxX >= minX ? maxX - minX + 1 : 0,
    verticalSpread: maxY >= minY ? maxY - minY + 1 : 0,
    crop: { width: info.width, height: info.height },
  };
}

test('renders a bounded full-stack plasma signature from real thermal state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const save = createReentryFixtureSave(createWayfarerDemonstrator());
  await seedReentrySave(page, save);
  await page.goto('/?quality=medium&renderDebug=1');
  await loadReentrySave(page);
  await page.locator('#game-canvas').hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => page.evaluate(() => window.__TEST__.reentryStats()), { timeout: 10_000 })
    .toMatchObject({ active: true, glow: true, trails: true, bowshock: true, occlusion: true });
  await expect.poll(() => page.evaluate(() => window.__TEST__.reentryStats()?.particles ?? 0))
    .toBeGreaterThan(0);
  await page.keyboard.press('F2');
  await page.waitForTimeout(150);
  const png = await page.locator('#game-canvas').screenshot();
  const signature = await plasmaSignature(png);
  const thresholds = JSON.parse(await readFile(
    new URL('./baselines/reentry/visual-thresholds.json', import.meta.url),
    'utf8',
  )) as VisualThresholds;
  expect(signature.warmPixels).toBeGreaterThanOrEqual(thresholds.minimumWarmPixels);
  expect(signature.warmPixels).toBeLessThanOrEqual(thresholds.maximumWarmPixels);
  expect(signature.hotPixels).toBeGreaterThanOrEqual(thresholds.minimumHotPixels);
  expect(signature.horizontalSpread).toBeGreaterThanOrEqual(thresholds.minimumHorizontalSpread);
  expect(signature.verticalSpread).toBeGreaterThanOrEqual(thresholds.minimumVerticalSpread);
  expect(errors).toEqual([]);
  await mkdir('test-results/reentry-vfx', { recursive: true });
  await writeFile('test-results/reentry-vfx/full-stack.png', png);
  await writeFile('test-results/reentry-vfx/full-stack-signature.json', `${JSON.stringify({
    thresholds,
    signature,
    stats: await page.evaluate(() => window.__TEST__.reentryStats()),
  }, null, 2)}\n`);
});

test('the profiling kill switch removes the complete effect stack', async ({ page }) => {
  const save = createReentryFixtureSave(createWayfarerDemonstrator());
  await seedReentrySave(page, save);
  await page.goto('/?quality=medium&reentryVfx=0');
  await loadReentrySave(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__TEST__.reentryStats())).toBeNull();
});
