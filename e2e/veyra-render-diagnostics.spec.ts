import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  captureCheckpoint,
  latestCloudClassification,
  readTerrainAcceptance,
  readFlight,
  seedDiagnosticCraft,
  waitForAltitude,
  waitForOrbitMetric,
} from './helpers/renderDiagnostics';

const diagnosticCraft = JSON.parse(readFileSync(
  new URL('./fixtures/veyra-diagnostic-craft.json', import.meta.url),
  'utf8',
)) as unknown;

for (const tier of ['medium', 'high'] as const) {
  test(`captures a Veyra orbit, deorbit, and reverse cloud crossings on ${tier}`, async ({ page, browser }) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await seedDiagnosticCraft(page, diagnosticCraft);
    await page.goto(`/?quality=${tier}&renderDebug=1`);
    await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
    await page.getByRole('button', { name: 'Veyra Diagnostic Orbiter' }).click();
    await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(20);
    await page.getByRole('button', { name: 'Launch this craft' }).click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');

    const startup = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__?.snapshot());
    expect(startup?.configuration).toMatchObject({ quality: tier, detailed: true });
    const manifestDigest = startup?.entries.find((entry) => entry.event === 'world-scene-created')?.data.manifestDigest;
    expect(manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    const digest = manifestDigest as string;
    await captureCheckpoint(page, browser, tier, '00-pad', errors, digest);

    await page.getByTitle('Stability assist').click();
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('Space');

    let upperStaged = false;
    let ascentCutoff = false;
    let guidanceActive = true;
    let pitchKey: 'KeyW' | 'KeyS' | null = null;
    let monitorBusy = false;
    const setPitchKey = async (next: 'KeyW' | 'KeyS' | null) => {
      if (pitchKey === next) return;
      if (pitchKey) await page.keyboard.up(pitchKey);
      pitchKey = next;
      if (pitchKey) await page.keyboard.down(pitchKey);
    };
    const stageMonitor = setInterval(async () => {
      if (upperStaged) return;
      const flight = await readFlight(page).catch(() => null);
      if (flight && flight.altitude > 30_000 && flight.stage === 1
        && (flight.properAcceleration < 0.5 || flight.fuel <= 950)) {
        upperStaged = true;
        await page.keyboard.press('Space');
      }
    }, 100);
    const flightMonitor = setInterval(async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        const flight = await readFlight(page).catch(() => null);
        if (!flight) return;
        const vector = await page.evaluate(() => window.__TEST__.flightVector()).catch(() => null);
        if (guidanceActive && vector) {
          if (flight.altitude >= 47_000) {
            guidanceActive = false;
            await setPitchKey(null);
            await page.getByTitle('Prograde').click();
            await page.keyboard.press('Period');
            await page.keyboard.press('Period');
          } else if (Math.hypot(vector.verticalSpeed, vector.horizontalSpeed) >= 70) {
            const flightPathAngle = Math.atan2(vector.horizontalSpeed, Math.max(1, vector.verticalSpeed));
            const targetNoseAngle = Math.min(flightPathAngle + 0.12, 0.9);
            const noseAngle = Math.acos(Math.max(-1, Math.min(1, vector.noseUpCos)));
            if (noseAngle < targetNoseAngle - 0.01) await setPitchKey('KeyW');
            else if (noseAngle > targetNoseAngle + 0.01) await setPitchKey('KeyS');
            else await setPitchKey(null);
          }
        }
        if (!ascentCutoff) {
          const state = await page.evaluate(() => ({
            orbit: window.__TEST__.orbit(),
            vector: window.__TEST__.flightVector(),
          })).catch(() => null);
          if (state?.orbit && state.vector
            && state.orbit.apoapsisAltitude >= 105_000
            && state.vector.horizontalSpeed >= 1_200) {
            ascentCutoff = true;
            await page.keyboard.press('KeyX');
          }
        }
      } finally {
        monitorBusy = false;
      }
    }, 25);

    try {
      const checkpoint = async (
        name: string,
        altitude: number,
        shell?: 'weather' | 'wisps',
        classification?: 'inside' | 'outside' | 'crossing',
      ) => {
        await waitForAltitude(page, altitude, 'ascending');
        if (shell && classification) {
          await expect.poll(() => latestCloudClassification(page, shell)).toBe(classification);
        }
        await captureCheckpoint(page, browser, tier, name, errors, digest);
      };

      await waitForAltitude(page, 7_000, 'ascending');
      await checkpoint('01-weather-crossing', 9_350, 'weather', 'crossing');
      await checkpoint('02-wisps-inside', 12_000, 'wisps', 'inside');
      await checkpoint('03-weather-outside', 16_000, 'weather', 'outside');
      await checkpoint('04-wisps-crossing', 18_700, 'wisps', 'crossing');
      await checkpoint('05-wisps-outside', 25_000, 'wisps', 'outside');
      await checkpoint('06-low-atmosphere', 40_000);
      await checkpoint('07-atmosphere-boundary', 82_000);
      await expect.poll(() => ascentCutoff, { timeout: 60_000 }).toBe(true);
      expect(upperStaged).toBe(true);
      await captureCheckpoint(page, browser, tier, '08-ascent-cutoff', errors, digest);

      await page.getByTitle('Prograde').click();
      await page.waitForFunction(() => {
        const altitude = window.__TEST__.altitude();
        const vertical = window.__TEST__.verticalSpeed();
        return altitude !== null && vertical !== null && altitude > 80_000 && vertical < 150;
      }, undefined, { timeout: 160_000 });
      await page.keyboard.press('KeyZ');
      await waitForOrbitMetric(page, 'periapsisAltitude', 85_000, 'above', 120_000);
      await page.keyboard.press('KeyX');
      await expect.poll(() => page.evaluate(() => window.__TEST__.situation())).toBe('orbit');
      const stableOrbit = await page.evaluate(() => window.__TEST__.orbit());
      expect(stableOrbit?.periapsisAltitude).toBeGreaterThanOrEqual(85_000);
      expect(stableOrbit?.eccentricity).toBeLessThan(0.15);
      await captureCheckpoint(page, browser, tier, '09-stable-orbit', errors, digest);

      await page.getByTitle('Retrograde').click();
      await page.waitForTimeout(2_000);
      await page.keyboard.press('KeyZ');
      await waitForOrbitMetric(page, 'periapsisAltitude', 40_000, 'below', 120_000);
      await page.keyboard.press('KeyX');
      await captureCheckpoint(page, browser, tier, '10-deorbit-burn', errors, digest);
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');

      await waitForAltitude(page, 82_000, 'descending', 160_000);
      await captureCheckpoint(page, browser, tier, '11-descent-atmosphere-boundary', errors, digest);
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');
      await waitForAltitude(page, 25_000, 'descending');
      await expect.poll(() => latestCloudClassification(page, 'wisps')).toBe('outside');
      await captureCheckpoint(page, browser, tier, '12-descent-wisps-outside', errors, digest);
      await waitForAltitude(page, 18_700, 'descending');
      await expect.poll(() => latestCloudClassification(page, 'wisps')).toBe('crossing');
      await captureCheckpoint(page, browser, tier, '13-descent-wisps-crossing', errors, digest);
      await waitForAltitude(page, 16_000, 'descending');
      await expect.poll(() => latestCloudClassification(page, 'weather')).toBe('outside');
      await captureCheckpoint(page, browser, tier, '14-descent-weather-outside', errors, digest);
      await waitForAltitude(page, 12_000, 'descending');
      await expect.poll(() => latestCloudClassification(page, 'wisps')).toBe('inside');
      await captureCheckpoint(page, browser, tier, '15-descent-wisps-inside', errors, digest);
      await waitForAltitude(page, 9_350, 'descending');
      await expect.poll(() => latestCloudClassification(page, 'weather')).toBe('crossing');
      await captureCheckpoint(page, browser, tier, '16-descent-weather-crossing', errors, digest);
      await waitForAltitude(page, 5_500, 'descending');
      await captureCheckpoint(page, browser, tier, '17-descent-low-altitude', errors, digest);
    } finally {
      await setPitchKey(null).catch(() => undefined);
      clearInterval(stageMonitor);
      clearInterval(flightMonitor);
    }

    const finalSnapshot = await page.evaluate(() => window.__RENDER_DIAGNOSTICS__?.snapshot());
    const terrainAcceptance = await readTerrainAcceptance(page);
    expect(finalSnapshot).toBeTruthy();
    expect(finalSnapshot!.entries.length).toBeGreaterThan(0);
    expect(finalSnapshot!.entries.length).toBeLessThanOrEqual(4_096);
    expect(terrainAcceptance.samples).toBeGreaterThan(0);
    expect(terrainAcceptance.postReadySamples).toBeGreaterThan(0);
    expect(terrainAcceptance.maximumCoverageGaps).toBe(0);
    expect(terrainAcceptance.readinessLosses).toBe(0);
    expect(terrainAcceptance.reservationViolations).toBe(0);
    expect(terrainAcceptance.forbiddenAnomalies).toEqual([]);
    expect(terrainAcceptance.scheduleP95Ms).toBeLessThanOrEqual(2);
    expect(terrainAcceptance.installP95Ms).toBeLessThanOrEqual(2);
    expect(errors, `application errors:\n${errors.join('\n')}`).toEqual([]);
  });
}
