import { expect, test, type Page } from '@playwright/test';

const STAND_IN_LABEL =
  'UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD';

test.use({ deviceScaleFactor: 2 });

async function skipToChapter(page: Page, chapter: number): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`Skip Artemis IV chapter ${chapter}$`) }).click();
  await expect(page.locator('.game-dialog-title')).toHaveText(`Skip Artemis IV Chapter ${chapter}?`);
  await page.getByRole('button', { name: `SKIP TO CHAPTER ${chapter + 1}` }).click();
  await expect(page.locator('.artiv-guide-progress')).toContainText(`CHAPTER ${chapter + 1}`);
}

test('Artemis IV chapters can be skipped and Chapter 3 offers real automatic docking', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Artemis IV guided lunar landing mission' }).click();
  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await expect(page.locator('.artiv-guide-progress')).toContainText('CHAPTER 1', { timeout: 120_000 });

  await skipToChapter(page, 1);
  await skipToChapter(page, 2);
  await expect(page.locator('.artiv-guide-title')).toHaveText('Complete docking');
  await expect(page.getByText('Stable hold', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'TARGET LANDER' }).click();
  const guidedDocking = page.getByRole('button', { name: 'AUTO-DOCK' });
  await expect(guidedDocking).toBeVisible();
  await guidedDocking.click();
  await expect(page.locator('.artiv-guide-title')).toHaveText('Two crew transfer to the lander');

  for (const chapter of [3, 4, 5, 6, 7]) await skipToChapter(page, chapter);
  await expect(page.locator('.artiv-guide-title')).toHaveText('Find and redock with Orion');
  await page.getByRole('button', { name: 'TARGET ORION' }).click();
  await page.getByRole('button', { name: 'RUN PREPARED PHASING' }).click();
  await page.getByRole('button', { name: 'AUTO-DOCK' }).click();
  await expect(page.locator('.artiv-guide-title')).toHaveText('Crew and samples return to Orion');
});

test('Artemis IV Chapter 5 can automatically land through the real safety predicate', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Artemis IV guided lunar landing mission' }).click();
  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await expect(page.locator('.artiv-guide-progress')).toContainText('CHAPTER 1', { timeout: 120_000 });

  for (const chapter of [1, 2, 3, 4]) await skipToChapter(page, chapter);
  await expect(page.locator('.artiv-guide-title')).toHaveText('Remove sideways speed first');
  await page.getByRole('button', { name: 'AUTO-LAND' }).click();
  await expect(page.locator('.artiv-guide-title')).toHaveText('Chapter complete');
  await expect(page.getByRole('button', { name: 'CONTINUE TO CHAPTER 6' })).toBeVisible();
});

test('Artemis IV starts from the public mission card with its checked Chapter 1 route', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  const mission = page.getByRole('button', {
    name: 'Artemis IV guided lunar landing mission',
  });
  await expect(mission).toBeVisible();
  await expect(mission).toHaveClass(/perilune-mission-primary/);
  await expect(mission.locator('.perilune-mission-qualifier')).toHaveText(STAND_IN_LABEL);

  await mission.click();
  await expect(page.locator('.game-dialog-title')).toHaveText(
    'Artemis IV · Guided Lunar Landing',
  );
  await expect(page.locator('.game-dialog-message')).toContainText(
    'four astronauts launch in Orion, two land near the lunar South Pole',
  );
  await expect(page.locator('.game-dialog-message')).toContainText(
    'It is not a Starship HLS model or an official NASA or SpaceX flight configuration.',
  );
  await expect(page.locator('.game-dialog-message')).toHaveCSS('white-space', 'pre-line');
  const flightPlan = page.getByRole('img', {
    name: /Artemis IV representative flight plan/,
  });
  await expect(flightPlan).toBeVisible();
  await expect(flightPlan).toHaveAttribute('src', '/ui/artemis-iv-flight-plan.svg');
  await expect(page.getByRole('link', { name: 'Open the Artemis IV flight plan at full size' }))
    .toHaveAttribute('target', '_blank');
  await expect(page.locator('.game-dialog-mission-profile')).toHaveCSS('overflow-y', 'auto');

  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight', null, {
    timeout: 120_000,
  });

  const guide = page.locator('.artiv-guide');
  await expect(guide).toBeVisible({ timeout: 120_000 });
  await expect(guide.locator('.artiv-guide-progress')).toHaveText('CHAPTER 1 · STEP 1 OF 2');
  await expect(guide.locator('.artiv-guide-accuracy')).toHaveText(STAND_IN_LABEL);
  await expect(guide.locator('.artiv-guide-title')).toHaveText('Refine the lunar encounter');
  await expect(guide.locator('.tut-box, .tut-title, .tut-step-kind')).toHaveCount(0);
  await expect(page.locator('.map-panel')).toBeVisible();
  const guideBox = await guide.boundingBox();
  const flightDataBox = await page.locator('.hud-right').boundingBox();
  expect(guideBox).not.toBeNull();
  expect(flightDataBox).not.toBeNull();
  expect(guideBox!.x + guideBox!.width).toBeLessThanOrEqual(flightDataBox!.x);
  await expect.poll(() => page.evaluate(() => window.__TEST__?.activeBody())).toBe('earth');
  await expect.poll(() => page.evaluate(() => window.__TEST__?.situation())).toBe('suborbital');
  await expect.poll(() => page.evaluate(() => window.__TEST__?.maneuverNode()?.prograde))
    .toBeCloseTo(15, 6);
  const missionRender = await page.evaluate(() => window.__TEST__?.renderCheckpoint());
  expect(missionRender?.drawingBufferWidth).toBe(missionRender?.canvasWidth);
  expect(missionRender?.drawingBufferHeight).toBe(missionRender?.canvasHeight);

  await page.setViewportSize({ width: 393, height: 852 });
  const compactGuideBox = await guide.boundingBox();
  expect(compactGuideBox).not.toBeNull();
  expect(compactGuideBox!.x).toBeGreaterThanOrEqual(0);
  expect(compactGuideBox!.x + compactGuideBox!.width).toBeLessThanOrEqual(393);
  expect(compactGuideBox!.y).toBeGreaterThanOrEqual(0);
  expect(compactGuideBox!.y + compactGuideBox!.height).toBeLessThanOrEqual(852);

  await page.setViewportSize({ width: 1280, height: 720 });
  const guideHeader = guide.locator('.artiv-guide-header');
  await expect(guideHeader).toHaveAttribute('title', /Drag to move mission guide/);
  const beforeDrag = await guide.boundingBox();
  const headerBox = await guideHeader.boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(headerBox).not.toBeNull();
  await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    headerBox!.x + headerBox!.width / 2 - 180,
    headerBox!.y + headerBox!.height / 2 + 70,
    { steps: 4 },
  );
  await page.mouse.up();
  const afterDrag = await guide.boundingBox();
  expect(afterDrag).not.toBeNull();
  expect(afterDrag!.x).toBeLessThan(beforeDrag!.x - 150);
  expect(afterDrag!.y).toBeGreaterThan(beforeDrag!.y + 50);
  await guideHeader.focus();
  await page.keyboard.press('ArrowRight');
  const afterKeyboardMove = await guide.boundingBox();
  expect(afterKeyboardMove!.x).toBeCloseTo(afterDrag!.x + 10, 0);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue Mission' })).toHaveCount(0);
  await expect(mission.locator('.perilune-mission-title')).toHaveText(
    'RESUME ARTEMIS IV · CHAPTER 1',
  );
  await page.getByRole('button', { name: 'Restart Artemis IV from Chapter 1' }).click();
  await expect(page.locator('.game-dialog-title')).toHaveText('Restart Artemis IV?');
  await expect(page.getByRole('button', { name: 'RESTART FROM CHAPTER 1' })).toBeVisible();
  await page.getByRole('button', { name: 'KEEP CHECKPOINT' }).click();
  await mission.click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight', null, {
    timeout: 120_000,
  });
  await expect(page.locator('.artiv-guide .artiv-guide-progress')).toHaveText(
    'CHAPTER 1 · STEP 1 OF 2',
  );
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('leaving during Artemis asset preparation cannot resurrect the mission', async ({ page }) => {
  let releaseAsset!: () => void;
  const assetGate = new Promise<void>((resolve) => { releaseAsset = resolve; });
  await page.route('**/missions/artemis-iv/models/*.glb*', async (route) => {
    await assetGate;
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', {
    name: 'Artemis IV guided lunar landing mission',
  }).click();
  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await expect(page.locator('.game-dialog-title')).toHaveText('Preparing Artemis IV');

  // This forced click models another app route replacing the pending mission.
  await page.getByRole('button', { name: 'First Light tutorial' }).click({ force: true });
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  releaseAsset();

  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => window.__TEST__?.screen())).toBe('editor');
  await expect(page.locator('input.ed-name')).toHaveValue('First Light Launch Vehicle');
  await expect(page.locator('.artiv-guide')).toBeHidden();
  await expect(page.locator('.game-dialog-title')).toHaveCount(0);
  const restoredRender = await page.evaluate(() => window.__TEST__?.renderCheckpoint());
  expect(restoredRender?.drawingBufferWidth).toBe((restoredRender?.canvasWidth ?? 0) * 2);
  expect(restoredRender?.drawingBufferHeight).toBe((restoredRender?.canvasHeight ?? 0) * 2);
});

test('an uncached slow Moon pack stays flight-scale through no-vessel preparation frames', async ({ page }) => {
  await page.goto('/');
  const mission = page.getByRole('button', {
    name: 'Artemis IV guided lunar landing mission',
  });
  await mission.click();
  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight', null, {
    timeout: 120_000,
  });

  await page.route('**/planets/generated/moon/high/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.evaluate(() => {
    const key = 'perilune.missions.artemis-iv.chapter-session';
    const serialized = localStorage.getItem(key);
    if (!serialized) throw new Error('Artemis IV session was not persisted');
    const document = JSON.parse(serialized) as { currentChapter: number; completed: boolean };
    document.currentChapter = 2;
    document.completed = false;
    localStorage.setItem(key, JSON.stringify(document));
  });
  await page.reload();
  await page.getByRole('button', {
    name: 'Artemis IV guided lunar landing mission',
  }).click();
  await page.waitForFunction(() => (
    window.__TEST__?.screen() === 'flight'
    || document.querySelector('.game-dialog-title')?.textContent?.includes('unavailable')
  ), null, { timeout: 120_000 });

  await expect(page.locator('.game-dialog-title')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__TEST__?.activeBody())).toBe('moon');
  const checkpoint = await page.evaluate(() => window.__TEST__?.renderCheckpoint());
  expect(checkpoint?.stats.residentFlightPacks).toBe(1);
  expect(checkpoint?.stats.rendererFailures).toBe(0);
});

test('every playable chapter cold-resumes through its checked body and guide checkpoint', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {
    name: 'Artemis IV guided lunar landing mission',
  }).click();
  await page.getByRole('button', { name: 'BEGIN MISSION' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight', null, {
    timeout: 120_000,
  });

  for (let chapter = 1; chapter <= 10; chapter++) {
    await page.evaluate((nextChapter) => {
      const key = 'perilune.missions.artemis-iv.chapter-session';
      const serialized = localStorage.getItem(key);
      if (!serialized) throw new Error('Artemis IV session was not persisted');
      const document = JSON.parse(serialized) as { currentChapter: number; completed: boolean };
      document.currentChapter = nextChapter;
      document.completed = false;
      localStorage.setItem(key, JSON.stringify(document));
    }, chapter);
    await page.reload();
    const mission = page.getByRole('button', {
      name: 'Artemis IV guided lunar landing mission',
    });
    await expect(mission.locator('.perilune-mission-title')).toHaveText(
      `RESUME ARTEMIS IV · CHAPTER ${chapter}`,
    );
    await mission.click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'flight', null, {
      timeout: 120_000,
    });
    await expect(page.locator('.artiv-guide-progress')).toContainText(
      `CHAPTER ${chapter} · STEP 1 OF`,
    );
    await expect.poll(() => page.evaluate(() => window.__TEST__?.activeBody())).toBe(
      chapter === 1 || chapter === 10 ? 'earth' : 'moon',
    );
  }
});
