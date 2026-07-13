import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  captureCheckpoint,
  readFlight,
  seedDiagnosticCraft,
  waitForAltitude,
} from './helpers/renderDiagnostics';

const diagnosticCraft = JSON.parse(readFileSync(
  new URL('./fixtures/veyra-diagnostic-craft.json', import.meta.url),
  'utf8',
)) as unknown;

for (const tier of ['medium', 'high'] as const) {
  test(`captures the real Veyra ascent and reverse cloud crossings on ${tier}`, async ({ page, browser }) => {
    test.setTimeout(360_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await seedDiagnosticCraft(page, diagnosticCraft);
    await page.goto(`/?quality=${tier}&renderDebug=1`);
    await page.getByText('Sandbox — just build and fly').click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
    await page.getByRole('button', { name: 'Veyra Diagnostic Orbiter' }).click();
    await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(12);
    await page.getByRole('button', { name: '▲ LAUNCH' }).click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');

    const startup = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__?.snapshot());
    expect(startup?.configuration).toMatchObject({ quality: tier, detailed: true });
    await captureCheckpoint(page, browser, tier, '00-pad', errors);

    await page.getByTitle('Stability assist').click();
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('Space');
    await page.keyboard.press('Period');
    await page.keyboard.press('Period');

    let upperStaged = false;
    const stageMonitor = setInterval(async () => {
      if (upperStaged) return;
      const flight = await readFlight(page).catch(() => null);
      if (flight && flight.altitude > 10_000 && flight.properAcceleration < 0.5 && flight.stage === 3) {
        upperStaged = true;
        await page.keyboard.press('Space');
      }
    }, 250);

    try {
      const ascent = [
        ['01-weather-before', 5_500],
        ['02-weather-crossing', 9_350],
        ['03-weather-after', 14_800],
        ['04-wisps-before', 15_500],
        ['05-wisps-crossing', 18_700],
        ['06-wisps-after', 24_000],
        ['07-low-atmosphere', 40_000],
        ['08-atmosphere-boundary', 82_000],
      ] as const;
      for (const [name, altitude] of ascent) {
        await waitForAltitude(page, altitude, 'ascending');
        await captureCheckpoint(page, browser, tier, name, errors);
      }
      await page.keyboard.press('KeyX');
      await captureCheckpoint(page, browser, tier, '09-high-altitude-cutoff', errors);

      await page.getByTitle('Retrograde').click();
      await waitForAltitude(page, 82_000, 'descending', 160_000);
      await captureCheckpoint(page, browser, tier, '10-descent-atmosphere-boundary', errors);
      await waitForAltitude(page, 24_000, 'descending');
      await captureCheckpoint(page, browser, tier, '11-descent-wisps-after', errors);
      await waitForAltitude(page, 18_700, 'descending');
      await captureCheckpoint(page, browser, tier, '12-descent-wisps-crossing', errors);
      await waitForAltitude(page, 15_500, 'descending');
      await captureCheckpoint(page, browser, tier, '13-descent-wisps-before', errors);
      await waitForAltitude(page, 14_800, 'descending');
      await captureCheckpoint(page, browser, tier, '14-descent-weather-after', errors);
      await waitForAltitude(page, 9_350, 'descending');
      await captureCheckpoint(page, browser, tier, '15-descent-weather-crossing', errors);
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      await waitForAltitude(page, 5_500, 'descending');
      await captureCheckpoint(page, browser, tier, '16-descent-low-altitude', errors);
    } finally {
      clearInterval(stageMonitor);
    }

    const finalSnapshot = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__?.snapshot());
    expect(finalSnapshot).toBeTruthy();
    expect(finalSnapshot!.entries.length).toBeGreaterThan(0);
    expect(finalSnapshot!.entries.length).toBeLessThanOrEqual(4_096);
    expect(errors, `application errors:\n${errors.join('\n')}`).toEqual([]);
  });
}
