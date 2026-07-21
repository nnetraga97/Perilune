import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';

const outputRoot = path.resolve('test-results/sol-ocean-wave-reference');

async function regionBytes(
  image: Buffer,
  top: number,
  height: number,
): Promise<Buffer> {
  return sharp(image).removeAlpha().extract({ left: 0, top, width: 1280, height }).raw().toBuffer();
}

function normalizedDifference(first: Buffer, second: Buffer): number {
  expect(first.length).toBe(second.length);
  let sum = 0;
  for (let index = 0; index < first.length; index++) {
    sum += Math.abs(first[index] - second[index]);
  }
  return sum / (first.length * 255);
}

test('filtered ocean waves move near-water shading while preserving the horizon', async ({ page }) => {
  test.setTimeout(180_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await mkdir(outputRoot, { recursive: true });
  const images: Buffer[] = [];
  for (const time of [0, 5]) {
    await page.goto(
      `/?proto=sol-visual-reference&quality=medium&station=earth-ocean-horizon&diagnostic=no-clouds&time=${time}`,
    );
    await page.waitForFunction(() => (
      (window as Window & { __solVisualReference?: { ready: boolean } })
        .__solVisualReference?.ready === true
    ));
    const metadata = await page.evaluate(() => (
      (window as Window & { __solVisualReference?: { metadata: Record<string, unknown> } })
        .__solVisualReference!.metadata
    ));
    expect(metadata).toMatchObject({ referenceTimeSeconds: time });
    images.push(await page.screenshot({ path: path.join(outputRoot, `earth-ocean-time-${time}.png`) }));
  }
  const nearDifference = normalizedDifference(
    await regionBytes(images[0], 320, 380),
    await regionBytes(images[1], 320, 380),
  );
  const horizonDifference = normalizedDifference(
    await regionBytes(images[0], 255, 35),
    await regionBytes(images[1], 255, 35),
  );
  expect(runtimeErrors).toEqual([]);
  expect(nearDifference).toBeGreaterThan(0.0005);
  expect(horizonDifference).toBeLessThan(nearDifference * 0.75);
});
