import { expect, test } from '@playwright/test';

test('map orbit has a forgiving click target and a compact six-direction planner', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  const pod = page.locator('.ed-part', { hasText: 'Voyager Pod' });
  await pod.dragTo(page.locator('#game-canvas'), { targetPosition: { x: 640, y: 400 } });
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await page.getByRole('button', { name: 'Map' }).click();

  await page.waitForFunction(() => {
    const samples = (window.__TEST__ as unknown as {
      mapOrbitSamples(): Array<{ x: number; y: number; visible: boolean }>;
    }).mapOrbitSamples();
    return samples.some((point, index) => {
      const next = samples[index + 1];
      if (!next || !point.visible || !next.visible) return false;
      const dx = next.x - point.x;
      const dy = next.y - point.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0.05) return false;
      const x = (point.x + next.x) / 2 - dy / length * 8;
      const y = (point.y + next.y) / 2 + dx / length * 8;
      return document.elementFromPoint(x, y)?.id === 'game-canvas' &&
        x > 360 && x < innerWidth - 40 && y > 40 && y < innerHeight - 80;
    });
  });
  const point = await page.evaluate(() => {
    const samples = (window.__TEST__ as unknown as {
      mapOrbitSamples(): Array<{ x: number; y: number; visible: boolean }>;
    }).mapOrbitSamples();
    for (let index = 0; index < samples.length - 1; index++) {
      const start = samples[index];
      const end = samples[index + 1];
      if (!start.visible || !end.visible) continue;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0.05) continue;
      const x = (start.x + end.x) / 2 - dy / length * 8;
      const y = (start.y + end.y) / 2 + dx / length * 8;
      if (x > 360 && x < innerWidth - 40 && y > 40 && y < innerHeight - 80 &&
          document.elementFromPoint(x, y)?.id === 'game-canvas') {
        return { x, y };
      }
    }
    throw new Error('No usable projected orbit segment');
  });

  // The drawn conic is about a pixel wide; this deliberately clicks eight
  // pixels away and should still land inside the 12 px mouse hit band.
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.__TEST__.maneuverNode())).not.toBeNull();

  await expect(page.locator('.map-axis')).toHaveCount(4); // three signed axes plus node time
  for (const direction of ['Retrograde', 'Prograde', 'Anti-normal', 'Normal', 'Radial in', 'Radial out']) {
    await expect(page.locator('.map-panel').getByTitle(direction, { exact: true })).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator('.map-panel');
  await expect(panel).toHaveClass(/has-node/);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeLessThanOrEqual(390);
  expect(Math.abs(bounds!.y + bounds!.height - 844)).toBeLessThanOrEqual(2);
});
