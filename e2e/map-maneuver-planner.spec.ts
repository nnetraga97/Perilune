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

  // Wheel zoom must remain centered on the followed craft even when the mouse
  // is far from screen center. Previously zoom-in moved the camera target to an
  // arbitrary ray/plane point and permanently detached it from the craft.
  const expectCraftCentered = async () => {
    await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
      mapMarkerSamples(): Record<'craft', { visible: boolean }>;
    }).mapMarkerSamples().craft.visible)).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const marker = (window.__TEST__ as unknown as {
        mapMarkerSamples(): Record<'craft', { x: number; y: number; visible: boolean }>;
      }).mapMarkerSamples().craft;
      return Math.hypot(marker.x - innerWidth / 2, marker.y - innerHeight / 2);
    })).toBeLessThan(2);
  };
  await expectCraftCentered();
  const centeredDistance = await page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState().distance);
  const wheelPoint = await page.evaluate(() => {
    const candidates = [
      [0.78, 0.72], [0.72, 0.28], [0.62, 0.18], [0.85, 0.55],
    ];
    for (const [xFraction, yFraction] of candidates) {
      const x = innerWidth * xFraction;
      const y = innerHeight * yFraction;
      if (document.elementFromPoint(x, y)?.id === 'game-canvas') return { x, y };
    }
    throw new Error('No off-center canvas point available for wheel zoom');
  });
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState().distance)).toBeGreaterThan(centeredDistance);
  await expectCraftCentered();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState().distance)).toBeLessThan(centeredDistance * 1.01);
  await expectCraftCentered();

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

  const panel = page.locator('.map-panel');
  await expect(page.locator('.map-axis')).toHaveCount(4); // three signed axes plus node time
  for (const direction of ['Retrograde', 'Prograde', 'Anti-normal', 'Normal', 'Radial in', 'Radial out']) {
    await expect(panel.getByTitle(direction, { exact: true })).toBeVisible();
  }
  await panel.getByTitle('Prograde', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.maneuverNode()?.prograde)).toBeCloseTo(1, 4);
  await panel.getByRole('spinbutton', {
    name: 'Prograde / retrograde delta-v in meters per second',
  }).fill('25');
  await expect.poll(() => page.evaluate(() => window.__TEST__.maneuverNode()?.prograde)).toBeCloseTo(25, 4);

  await panel.getByRole('button', { name: 'Add node in 2 minutes' }).click();
  await expect(panel.locator('.map-node-chip')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
    maneuverNodes(): unknown[];
  }).maneuverNodes().length)).toBe(2);
  await panel.locator('.map-node-chip').first().click();
  await expect(panel.locator('.map-node-chip').first()).toHaveClass(/active/);

  const cameraBefore = await page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState());
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState().distance)).toBeLessThan(cameraBefore.distance);
  await page.getByRole('button', { name: 'Fit entire system' }).click();
  await expect.poll(() => page.evaluate(() => (window.__TEST__ as unknown as {
    mapCameraState(): { distance: number };
  }).mapCameraState().distance)).toBeGreaterThan(100_000);

  const markers = await page.evaluate(() => (window.__TEST__ as unknown as {
    mapMarkerSamples(): Record<'craft' | 'ap' | 'pe', {
      x: number; y: number; visible: boolean; width: number; height: number;
    }>;
  }).mapMarkerSamples());
  expect(markers.craft.visible).toBe(true);
  expect(markers.craft.width).toBeGreaterThan(markers.craft.height * 2);
  for (const kind of ['ap', 'pe'] as const) {
    expect(markers[kind].visible, kind).toBe(true);
    expect(markers[kind].width, kind).toBeGreaterThan(markers[kind].height * 1.5);
    expect(markers[kind].width, kind).toBeLessThan(markers[kind].height * 1.8);
  }

  const initialBounds = await panel.boundingBox();
  expect(initialBounds).not.toBeNull();
  expect(initialBounds!.x).toBeGreaterThanOrEqual(48);
  const titleBar = panel.locator('.map-panel-bar');
  const titleBounds = await titleBar.boundingBox();
  expect(titleBounds).not.toBeNull();
  await page.mouse.move(titleBounds!.x + 80, titleBounds!.y + titleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBounds!.x + 160, titleBounds!.y + titleBounds!.height / 2 + 35, { steps: 5 });
  await page.mouse.up();
  const movedBounds = await panel.boundingBox();
  expect(movedBounds).not.toBeNull();
  expect(movedBounds!.x).toBeGreaterThan(initialBounds!.x + 60);
  expect(movedBounds!.y).toBeGreaterThan(initialBounds!.y + 20);

  const resize = panel.getByRole('separator', { name: 'Resize maneuver planner' });
  await expect(resize).toBeVisible();
  const resizeBounds = await resize.boundingBox();
  expect(resizeBounds).not.toBeNull();
  await page.mouse.move(resizeBounds!.x + resizeBounds!.width / 2, resizeBounds!.y + resizeBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBounds!.x + 70, resizeBounds!.y + 50, { steps: 5 });
  await page.mouse.up();
  const resizedBounds = await panel.boundingBox();
  expect(resizedBounds).not.toBeNull();
  expect(resizedBounds!.width).toBeGreaterThan(movedBounds!.width + 50);
  // The richer outcome section begins closer to the viewport height cap, but
  // the vertical resize handle must still move the panel before that cap.
  expect(resizedBounds!.height).toBeGreaterThan(movedBounds!.height + 15);
  expect(resizedBounds!.y + resizedBounds!.height).toBeLessThanOrEqual(720);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toHaveClass(/has-node/);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeLessThanOrEqual(390);
  expect(Math.abs(bounds!.y + bounds!.height - (844 - 58))).toBeLessThanOrEqual(2);
  await expect(resize).toBeHidden();
});
