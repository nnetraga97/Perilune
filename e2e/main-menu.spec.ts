import { expect, test, type Page } from '@playwright/test';

async function expectNoViewportOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
}

test('landing page and utility launchers use the approved hierarchy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const menu = page.locator('.perilune-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('background-image', /perilune-command-deck-bg\.jpg/);
  await expect(page.getByRole('button', { name: 'Continue Mission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'First Light tutorial' })).toHaveClass(/perilune-mission-primary/);
  await expect(page.getByRole('button', { name: 'Save & Load' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.screenshot({ path: 'test-results/perilune-menu-desktop.png', fullPage: true });

  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  const launcher = page.locator('.ed-utility-host .k-launcher');
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole('button', { name: 'Science' })).toBeVisible();
  await expect(launcher.getByRole('button', { name: 'Saves' })).toBeVisible();
  const settings = launcher.getByRole('button', { name: 'Settings' });
  await settings.hover();
  await expect(settings.locator('.k-icon-tooltip')).toBeVisible();
  await settings.focus();
  const tooltip = settings.locator('.k-icon-tooltip');
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(1440);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('command deck keeps medium-width geometry inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 850, height: 900 });
  await page.goto('/');
  const deck = page.locator('.perilune-command-deck');
  await expect(deck).toBeVisible();
  const deckBox = await deck.boundingBox();
  expect(deckBox).not.toBeNull();
  expect(deckBox!.x).toBeGreaterThanOrEqual(0);
  expect(deckBox!.x + deckBox!.width).toBeLessThanOrEqual(850);
  expect(deckBox!.y + deckBox!.height).toBeLessThanOrEqual(900);
  await expectNoViewportOverflow(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/perilune-menu-intermediate.png', fullPage: true });
});

test('command deck becomes a two-column layout on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/');
  const deck = page.locator('.perilune-command-deck');
  await expect(deck).toBeVisible();
  await expect(deck).toHaveCSS('grid-template-columns', /[0-9.]+px [0-9.]+px/);
  await expectNoViewportOverflow(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/perilune-menu-narrow.png', fullPage: true });
});

test('a live autosave appears in the catalog and enables Continue Mission', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await page.locator('.ed-part', { hasText: 'Voyager Pod' }).dragTo(page.locator('#game-canvas'), {
    targetPosition: { x: 640, y: 400 },
  });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);
  await page.getByRole('button', { name: '▲ LAUNCH' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await page.getByRole('button', { name: 'Saves' }).click();
  await expect(page.locator('.utility-save', { hasText: 'AUTOSAVE' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue Mission' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue Mission' })).toHaveClass(/perilune-mission-primary/);
  await expect(page.getByRole('button', { name: 'First Light tutorial' })).not.toHaveClass(/perilune-mission-primary/);
});
