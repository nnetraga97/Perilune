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
  await expectNoViewportOverflow(page);
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
  expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(900);
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

test('First Light opens with the prepared Sol trainer and guided launch card', async ({ page }) => {
  const launchRequests: string[] = [];
  page.on('request', (request) => launchRequests.push(request.url()));
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/');
  await page.getByRole('button', { name: 'First Light tutorial' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  await expect(page.locator('input.ed-name')).toHaveValue('First Light Launch Vehicle');
  await expect.poll(() => page.evaluate(() => window.__TEST__?.partCount())).toBe(35);
  await expect.poll(() => page.evaluate(() => window.__TEST__?.stageCount())).toBe(7);
  const tutorial = page.locator('.tut-box');
  await expect(tutorial).toBeVisible();
  await expect(page.locator('.tut-title')).toHaveText('The mission: make an orbit');
  await expect(page.locator('.tut-text')).toContainText('moving sideways fast enough to keep falling around Earth');
  await expect(page.getByRole('button', { name: 'Previous step' })).toBeDisabled();
  await expect(tutorial.getByRole('button', { name: 'Revert to launch' })).toBeDisabled();
  await expect(page.locator('.tut-continue')).toBeHidden();
  const tutorialBox = await tutorial.boundingBox();
  expect(tutorialBox).not.toBeNull();
  expect(tutorialBox!.x).toBeGreaterThanOrEqual(0);
  expect(tutorialBox!.x + tutorialBox!.width).toBeLessThanOrEqual(393);
  expect(tutorialBox!.y).toBeGreaterThanOrEqual(0);
  expect(tutorialBox!.y + tutorialBox!.height).toBeLessThanOrEqual(852);

  const handle = page.locator('.tut-header');
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 40);
  await page.mouse.up();
  const movedBox = await tutorial.boundingBox();
  expect(movedBox).not.toBeNull();
  expect(movedBox!.y).toBeGreaterThan(tutorialBox!.y + 20);
  expect(movedBox!.x).toBeGreaterThanOrEqual(0);
  expect(movedBox!.x + movedBox!.width).toBeLessThanOrEqual(393);
  expect(movedBox!.y + movedBox!.height).toBeLessThanOrEqual(852);

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  expect(launchRequests.some((url) => url.includes('/moon/site01/'))).toBe(false);
  const tutorialRevert = tutorial.getByRole('button', { name: 'Revert to launch' });
  await expect(tutorialRevert).toBeEnabled();
  await page.keyboard.press('z');
  await expect(page.locator('.tut-title')).toHaveText('Engage launch guidance');
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await tutorialRevert.click();
  await expect(page.locator('.tut-title')).toHaveText('Set full throttle');
  await expect.poll(() => page.evaluate(() => window.__TEST__?.altitude())).toBeLessThan(100);
});

test('Second Light starts from a prepared Earth orbit with a Moon node', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'First Light tutorial' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  const tutorial = page.locator('.tut-box');
  const secondLight = tutorial.getByRole('button', { name: 'Start Second Light' });
  await expect(secondLight).toBeVisible();
  await secondLight.click();

  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await expect(page.locator('.tut-title')).toHaveText('Read the Moon transfer node');
  await expect(secondLight).toBeHidden();
  await expect(page.locator('.map-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle automatic execution for selected maneuver' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__TEST__?.activeBody())).toBe('earth');
  const orbit = await page.evaluate(() => window.__TEST__?.orbit());
  expect(orbit?.apoapsisAltitude).toBeCloseTo(200_000, -2);
  expect(orbit?.periapsisAltitude).toBeCloseTo(200_000, -2);
  await expect(tutorial.getByRole('button', { name: 'Revert to launch' })).toBeEnabled();
});

test('a live autosave appears in the catalog and enables Continue Mission', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await page.locator('.ed-part', { hasText: 'Voyager Pod' }).dragTo(page.locator('#game-canvas'), {
    targetPosition: { x: 640, y: 400 },
  });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await page.getByRole('button', { name: 'Saves' }).click();
  await expect(page.locator('.utility-save', { hasText: 'AUTOSAVE' })).toBeVisible();

  await page.reload();
  const continueMission = page.getByRole('button', { name: 'Continue Mission' });
  await expect(continueMission).toBeVisible();
  await expect(continueMission).toBeEnabled();
  await expect(continueMission).toHaveClass(/perilune-mission-primary/);
  await expect(page.getByRole('button', { name: 'First Light tutorial' })).not.toHaveClass(/perilune-mission-primary/);
  await continueMission.click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
});
