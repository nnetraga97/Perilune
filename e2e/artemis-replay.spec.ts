import { expect, test, type Page } from '@playwright/test';

interface ArtemisProbe {
  readonly time: number | null;
  readonly phase: string | null;
  readonly playing: boolean;
  readonly rate: number | null;
  readonly camera: string;
  readonly fieldOfView: number;
  readonly event: string | null;
  readonly dockings: readonly { readonly id: string; readonly status: string }[];
  readonly entities: readonly {
    readonly id: string;
    readonly attachedTo: string | null;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }[];
  readonly render: { readonly visuals: number; readonly proxyVisuals: number; readonly paths: number } | null;
}

interface SaveIndependentState {
  readonly time: number;
  readonly vesselCount: number;
  readonly sciencePoints: number;
  readonly campaign: unknown;
}

async function artemisProbe(page: Page): Promise<ArtemisProbe> {
  return page.evaluate(() => (window as unknown as {
    __TEST__: { artemisReplay(): ArtemisProbe };
  }).__TEST__.artemisReplay());
}

async function saveIndependentState(page: Page): Promise<SaveIndependentState> {
  await page.waitForFunction(() => Boolean(window.__TEST__));
  return page.evaluate(() => {
    const probe = (window as unknown as {
      __TEST__: {
        time(): number;
        vesselCount(): number;
        sciencePoints(): number;
        campaign(): unknown;
      };
    }).__TEST__;
    return {
      time: probe.time(),
      vesselCount: probe.vesselCount(),
      sciencePoints: probe.sciencePoints(),
      campaign: probe.campaign(),
    };
  });
}

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

async function enterReplay(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Artemis IV mission replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'mission-briefing');
  await expect(page.getByRole('heading', { name: 'ARTEMIS IV' })).toBeVisible();
  await expect(page.locator('.artemis-phase-overview-item')).toHaveCount(7);
  await expect(page.getByText('SOURCE-BACKED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Begin Replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'mission-replay', undefined, {
    timeout: 30_000,
  });
  await expect(page.locator('section[aria-label="Artemis IV mission replay"]')).toBeVisible();
  await expect.poll(() => artemisProbe(page), { timeout: 15_000 }).toMatchObject({
    phase: 'departure-context',
    playing: false,
    camera: 'director',
    render: { visuals: 3, proxyVisuals: 3, paths: 2 },
  });
}

test('Artemis IV replay is deterministic, controllable, reversible, and save-independent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const before = await saveIndependentState(page);
  const flightFieldOfView = (await artemisProbe(page)).fieldOfView;

  await enterReplay(page);
  expect((await artemisProbe(page)).fieldOfView).not.toBe(flightFieldOfView);
  await expect(page.getByRole('slider', { name: 'Mission timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play mission replay' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Playback rate' })).toHaveValue('1000');
  await expect(page.getByText('RELATIVE NAVIGATION', { exact: true })).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: 'test-results/artemis-replay-desktop.png', fullPage: true });

  const pausedAt = (await artemisProbe(page)).time ?? 0;
  await page.getByRole('button', { name: 'Play mission replay' }).click();
  await expect.poll(async () => (await artemisProbe(page)).time ?? 0).toBeGreaterThan(pausedAt);
  await page.getByRole('button', { name: 'Pause mission replay' }).click();
  await expect.poll(async () => (await artemisProbe(page)).playing).toBe(false);
  await page.waitForTimeout(100);
  const pauseSettledAt = (await artemisProbe(page)).time;
  await page.waitForTimeout(250);
  expect((await artemisProbe(page)).time).toBe(pauseSettledAt);

  await page.getByRole('combobox', { name: 'Playback rate' }).selectOption('10');
  await expect.poll(async () => (await artemisProbe(page)).rate).toBe(10);
  await page.getByRole('button', { name: 'Play mission replay' }).click();
  const timeline = page.getByRole('slider', { name: 'Mission timeline' });
  await timeline.focus();
  const focusedTimelineAt = Number(await timeline.inputValue());
  await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(focusedTimelineAt);
  await page.getByRole('button', { name: 'Pause mission replay' }).click();

  await page.getByRole('button', { name: 'Go to phase 5: Soft Capture' }).click();
  await expect.poll(async () => (await artemisProbe(page)).phase).toBe('soft-capture');
  await expect.poll(async () => (await artemisProbe(page)).dockings.map((docking) => docking.status))
    .toEqual(['soft-captured', 'soft-captured']);
  await expect(page.getByRole('heading', { name: 'Soft Capture' })).toBeVisible();

  await page.getByRole('button', { name: 'Go to phase 6: Hard Dock' }).click();
  await expect.poll(async () => (await artemisProbe(page)).dockings.map((docking) => docking.status))
    .toEqual(['hard-docked', 'hard-docked']);
  await expect.poll(async () => (await artemisProbe(page)).entities
    .filter((entity) => entity.id === 'orion' || entity.id === 'i-hab')
    .map((entity) => entity.attachedTo)).toEqual(['gateway', 'gateway']);

  await page.getByRole('button', { name: 'Go to phase 4: Final Approach' }).click();
  await expect.poll(async () => (await artemisProbe(page)).dockings.map((docking) => docking.status))
    .toEqual(['independent', 'independent']);
  await expect.poll(async () => (await artemisProbe(page)).entities
    .filter((entity) => entity.id === 'orion' || entity.id === 'i-hab')
    .map((entity) => entity.attachedTo)).toEqual([null, null]);

  await page.getByRole('button', { name: 'Gateway', exact: true }).click();
  await expect.poll(async () => (await artemisProbe(page)).camera).toBe('gateway-orbit');
  await expect(page.getByRole('button', { name: 'Return to Director' })).toBeVisible();

  expect(await page.locator('.mission-replay').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  expect(await page.evaluate(() => document.elementFromPoint(720, 450)?.id)).toBe('game-canvas');
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.mouse.move(800, 500, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await artemisProbe(page)).camera).toBe('free');
  await page.getByRole('button', { name: 'Return to Director' }).click();
  await expect.poll(async () => (await artemisProbe(page)).camera).toBe('director');

  await page.getByText('Layers', { exact: true }).click();
  await page.getByLabel('Source notes').check();
  const sourceNotes = page.locator('.mission-replay-source-notes');
  await expect(sourceNotes.getByRole('heading', { name: 'SOURCES & ASSUMPTIONS' })).toBeVisible();
  await expect(sourceNotes.getByText(/Concept replay\. Mission facts/)).toBeVisible();
  await page.screenshot({ path: 'test-results/artemis-replay-sources.png', fullPage: true });

  await page.getByRole('button', { name: 'Exit Replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'menu');
  await expect.poll(async () => (await artemisProbe(page)).render).toBeNull();
  expect((await artemisProbe(page)).fieldOfView).toBe(flightFieldOfView);
  expect(await saveIndependentState(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Artemis IV mission replay' })).toBeFocused();

  // A second entry catches retained Three.js objects, stale clock state, and
  // async preparation callbacks escaping a completed lifecycle.
  await enterReplay(page);
  await page.getByRole('slider', { name: 'Mission timeline' }).focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__TEST__?.screen() === 'menu');
  await expect.poll(async () => (await artemisProbe(page)).render).toBeNull();
  expect((await artemisProbe(page)).fieldOfView).toBe(flightFieldOfView);
  expect(await saveIndependentState(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Artemis IV mission replay' })).toBeFocused();
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Artemis briefing and replay remain usable on a phone viewport', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Artemis IV mission replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'mission-briefing');
  await expect(page.getByRole('heading', { name: 'ARTEMIS IV' })).toBeVisible();
  await expect(page.locator('.artemis-phase-overview-item')).toHaveCount(7);
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: 'test-results/artemis-briefing-mobile.png', fullPage: true });

  await page.getByRole('button', { name: 'Begin Replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'mission-replay', undefined, {
    timeout: 30_000,
  });
  await expect.poll(async () => (await artemisProbe(page)).render?.visuals ?? 0, { timeout: 15_000 }).toBe(3);
  await expect(page.getByRole('button', { name: 'Play mission replay' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gateway', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Mission timeline' })).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: 'test-results/artemis-replay-mobile.png', fullPage: true });

  await page.getByRole('button', { name: 'Exit Replay' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'menu');
  await expect.poll(async () => (await artemisProbe(page)).render).toBeNull();
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
