/**
 * M1 gate: the playable loop, driven through the real UI in a real browser.
 * Build a rocket in the Workshop with mouse clicks → launch → throttle up →
 * stage → climb → quicksave → quickload → still flying.
 */
import { expect, test, Page } from '@playwright/test';

interface TestProbe {
  screen(): string;
  partCount(): number;
  stageCount(): number;
  stackSpots(): Array<{ kind: string; x: number; y: number; z: number }>;
  projectEditor(x: number, y: number, z: number): { x: number; y: number };
  altitude(): number | null;
  situation(): string | null;
  throttle(): number;
  vesselCount(): number;
  fuel(): number;
  time(): number;
}

declare global {
  interface Window {
    __TEST__: TestProbe;
  }
}

async function probe<T>(page: Page, fn: (t: TestProbe) => T): Promise<T> {
  return page.evaluate(
    (src) => (0, eval)(`(${src})`)(window.__TEST__),
    fn.toString(),
  ) as Promise<T>;
}

/** Click the canvas at the screen position of a free stack node. */
async function clickStackSpot(page: Page, kind: 'stack-top' | 'stack-bottom'): Promise<void> {
  const pt = await page.evaluate((k) => {
    const spots = window.__TEST__.stackSpots().filter((s) => s.kind === k);
    if (!spots.length) return null;
    // For bottom spots take the lowest; for top the highest.
    spots.sort((a, b) => (k === 'stack-bottom' ? a.y - b.y : b.y - a.y));
    const s = spots[0];
    return window.__TEST__.projectEditor(s.x, s.y, s.z);
  }, kind);
  expect(pt, `no free ${kind} node found`).not.toBeNull();
  await page.mouse.move(pt!.x, pt!.y);
  await page.waitForTimeout(120); // let a frame process updatePointer
  await page.mouse.click(pt!.x, pt!.y);
  await page.waitForTimeout(120);
}

test('full playable loop: build, launch, fly, quicksave/load', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  // ---------------------------------------------------------- build rocket
  // 1. Pod (root part placed at fixed spot regardless of pointer).
  await page.locator('.ed-part', { hasText: 'Voyager Pod' }).click();
  await page.mouse.move(640, 400);
  await page.waitForTimeout(120);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(150);
  expect(await probe(page, (t) => t.partCount())).toBe(1);

  // 2. Fuel tank below the pod.
  await page.getByRole('button', { name: 'Tanks' }).click();
  await page.locator('.ed-part', { hasText: 'PL-400 Tank' }).click();
  await clickStackSpot(page, 'stack-bottom');
  expect(await probe(page, (t) => t.partCount())).toBe(2);

  // 3. Engine below the tank.
  await page.getByRole('button', { name: 'Engines' }).click();
  await page.locator('.ed-part', { hasText: 'Pike' }).click();
  await clickStackSpot(page, 'stack-bottom');
  expect(await probe(page, (t) => t.partCount())).toBe(3);

  // 4. Parachute on top of the pod.
  await page.getByRole('button', { name: 'Utility' }).click();
  await page.locator('.ed-part', { hasText: 'Homecoming Chute' }).click();
  await clickStackSpot(page, 'stack-top');
  expect(await probe(page, (t) => t.partCount())).toBe(4);

  // 5. Auto-stage: engine fires first, chute arms last.
  await page.getByRole('button', { name: 'Auto-stage' }).click();
  await page.waitForTimeout(120);
  expect(await probe(page, (t) => t.stageCount())).toBeGreaterThanOrEqual(2);

  await page.screenshot({ path: 'test-results/editor-rocket.png' });

  // ------------------------------------------------------------- launch!
  await page.getByRole('button', { name: '▲ LAUNCH' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  expect(await probe(page, (t) => t.situation())).toBeTruthy();

  // Throttle to full and ignite.
  await page.keyboard.press('KeyZ'); // full throttle
  await page.keyboard.press('Space'); // stage: ignition
  await page.waitForTimeout(400);
  expect(await probe(page, (t) => t.throttle())).toBeGreaterThan(0.9);

  // Climb: altitude must increase substantially within 25 s real time.
  const alt0 = (await probe(page, (t) => t.altitude())) ?? 0;
  await page.waitForFunction(
    (a0) => (window.__TEST__.altitude() ?? 0) > a0 + 400,
    alt0,
    { timeout: 40_000 },
  );
  const situation = await probe(page, (t) => t.situation());
  expect(['flying', 'suborbital']).toContain(situation);

  await page.screenshot({ path: 'test-results/flight-ascent.png' });

  // ------------------------------------------------- quicksave / quickload
  const altBeforeSave = (await probe(page, (t) => t.altitude())) ?? 0;
  const fuelBeforeSave = await probe(page, (t) => t.fuel());
  await page.keyboard.press('F5');
  await page.waitForTimeout(600);
  // Keep climbing a bit, then load back.
  await page.waitForTimeout(2500);
  await page.keyboard.press('F9');
  await page.waitForFunction(
    () => window.__TEST__.screen() === 'flight' && window.__TEST__.vesselCount() > 0,
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(400);
  const altAfterLoad = (await probe(page, (t) => t.altitude())) ?? 0;
  const fuelAfterLoad = await probe(page, (t) => t.fuel());
  // Loaded state should match the saved moment (within a few sim seconds of drift).
  expect(Math.abs(altAfterLoad - altBeforeSave)).toBeLessThan(2500);
  expect(fuelAfterLoad).toBeGreaterThan(0);
  expect(fuelAfterLoad).toBeGreaterThanOrEqual(fuelBeforeSave * 0.9);

  // Map view opens and closes without errors.
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/map-view.png' });
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(300);

  // No console errors through the whole loop.
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
