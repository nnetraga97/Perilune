import { expect, test, type Page } from '@playwright/test';

async function openSandbox(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
}

async function attachSurfacePart(page: Page, cardText: string, parentDefId: string): Promise<void> {
  const before = await page.evaluate(() => window.__TEST__.partCount());
  const target = await page.evaluate((definitionId) => {
    const probe = (window as any).__TEST__;
    const part = probe.parts().find((candidate: { defId: string }) => candidate.defId === definitionId);
    if (!part) return null;
    return probe.projectEditor(part.x, part.y, part.z);
  }, parentDefId);
  expect(target).not.toBeNull();
  await page.locator('.ed-part', { hasText: cardText }).dragTo(page.locator('#game-canvas'), {
    targetPosition: target!,
  });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(before + 1);
}

test('collects science and recovers its undelivered value through the flight UI', async ({ page }) => {
  await openSandbox(page);
  await page.locator('.ed-part', { hasText: 'Voyager Pod' }).dragTo(page.locator('#game-canvas'), {
    targetPosition: { x: 640, y: 400 },
  });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);
  await page.locator('.ed-cats').getByRole('button', { name: 'Science', exact: true }).click();
  await attachSurfacePart(page, 'Thermoscope', 'pod-voyager');

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  const science = page.locator('.hud-sys').getByRole('button', { name: /^Science/ });
  await expect(science).toBeEnabled();
  await science.click();
  await expect(page.locator('.hud-science-aboard')).toContainText('SCI ABOARD');

  await page.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByText('Vessel recovered')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__TEST__.sciencePoints())).toBeGreaterThan(0);
});

test('collects on the pad, establishes a live link in flight, and transmits', async ({ page }) => {
  test.setTimeout(240_000);
  await openSandbox(page);
  await page.getByRole('button', { name: 'Load built-in craft Wayfarer Heavy Demonstrator' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(21);
  await page.locator('.ed-cats').getByRole('button', { name: 'Science', exact: true }).click();
  await attachSurfacePart(page, 'Thermoscope', 'pod-voyager');
  await page.locator('.ed-cats').getByRole('button', { name: 'Utility', exact: true }).click();
  await attachSurfacePart(page, 'Whipline Antenna', 'tank-m4');

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await page.locator('.hud-sys').getByRole('button', { name: /^Science/ }).click();
  await expect(page.locator('.hud-science-aboard')).toContainText('SCI ABOARD');

  await page.keyboard.press('KeyZ');
  await page.keyboard.press('Space');
  const transmit = page.locator('.hud-sys').getByRole('button', { name: 'Transmit' });
  await expect(transmit).toBeEnabled({ timeout: 60_000 });
  await transmit.click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.sciencePoints())).toBeGreaterThan(0);

  await page.locator('.hud-utility-host .k-launcher').getByRole('button', { name: 'Science' }).click();
  await expect(page.locator('.utility-total')).toContainText('TRANSMITTED');
  await expect(page.locator('.utility-section').filter({ hasText: 'Thermoscope Reading' }).first()).toContainText('T ');
});
