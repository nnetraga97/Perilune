import { mkdir, writeFile } from 'node:fs/promises';
import type { Browser, Page } from '@playwright/test';

export interface DiagnosticProbe {
  screen(): string;
  partCount(): number;
  altitude(): number | null;
  verticalSpeed(): number | null;
  flightVector(): {
    noseUpCos: number;
    verticalSpeed: number;
    horizontalSpeed: number;
  } | null;
  properAcceleration(): number;
  situation(): string | null;
  currentStage(): number | null;
  fuel(): number;
  activeBody(): string | null;
  time(): number;
  orbit(): { apoapsisAltitude: number; periapsisAltitude: number; eccentricity: number } | null;
  renderCheckpoint(): {
    canvasWidth: number;
    canvasHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    stats: Record<string, unknown>;
  };
}

declare global {
  interface Window {
    __TEST__: DiagnosticProbe;
  }
}

export async function seedDiagnosticCraft(page: Page, craft: unknown): Promise<void> {
  await page.addInitScript(async ({ value }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('perilune', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('saves', 'readwrite');
        transaction.objectStore('saves').put(JSON.stringify(value), 'craft:Veyra Diagnostic Orbiter');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { value: craft });
}

export async function readFlight(page: Page): Promise<{
  altitude: number;
  verticalSpeed: number;
  properAcceleration: number;
  situation: string | null;
  stage: number | null;
  fuel: number;
  time: number;
}> {
  return page.evaluate(() => ({
    altitude: window.__TEST__.altitude() ?? 0,
    verticalSpeed: window.__TEST__.verticalSpeed() ?? 0,
    properAcceleration: window.__TEST__.properAcceleration(),
    situation: window.__TEST__.situation(),
    stage: window.__TEST__.currentStage(),
    fuel: window.__TEST__.fuel(),
    time: window.__TEST__.time(),
  }));
}

export async function waitForAltitude(
  page: Page,
  altitude: number,
  direction: 'ascending' | 'descending',
  timeout = 120_000,
): Promise<void> {
  await page.waitForFunction(
    ({ target, descending }) => {
      const current = window.__TEST__.altitude();
      const vertical = window.__TEST__.verticalSpeed();
      if (current === null || vertical === null) return false;
      return descending ? current <= target && vertical < 0 : current >= target && vertical > 0;
    },
    { target: altitude, descending: direction === 'descending' },
    { timeout },
  );
}

export async function waitForOrbitMetric(
  page: Page,
  metric: 'apoapsisAltitude' | 'periapsisAltitude',
  threshold: number,
  comparison: 'above' | 'below',
  timeout = 120_000,
): Promise<void> {
  await page.waitForFunction(
    ({ key, value, above }) => {
      const orbit = window.__TEST__.orbit();
      if (!orbit || !Number.isFinite(orbit[key])) return false;
      return above ? orbit[key] >= value : orbit[key] <= value;
    },
    { key: metric, value: threshold, above: comparison === 'above' },
    { timeout },
  );
}

export async function latestCloudClassification(
  page: Page,
  shell: 'weather' | 'wisps',
): Promise<string | null> {
  return page.evaluate((shellName) => {
    const entries = window.__RENDER_DIAGNOSTICS__?.snapshot().entries ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.event === 'cloud-shell-sample' && entry.data.shell === shellName) {
        return typeof entry.data.classification === 'string' ? entry.data.classification : null;
      }
    }
    return null;
  }, shell);
}

export async function captureCheckpoint(
  page: Page,
  browser: Browser,
  tier: 'medium' | 'high',
  name: string,
  errors: readonly string[],
  manifestDigest: string,
): Promise<void> {
  const directory = `test-results/veyra-render-diagnostics/${tier}`;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
  const payload = await page.evaluate(() => ({
    flight: {
      altitude: window.__TEST__.altitude(),
      verticalSpeed: window.__TEST__.verticalSpeed(),
      flightVector: window.__TEST__.flightVector(),
      situation: window.__TEST__.situation(),
      time: window.__TEST__.time(),
      orbit: window.__TEST__.orbit(),
      body: window.__TEST__.activeBody(),
    },
    render: window.__TEST__.renderCheckpoint(),
    diagnostics: window.__RENDER_DIAGNOSTICS__?.snapshot() ?? null,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }));
  if (payload.flight.body !== 'veyra') {
    throw new Error(`Diagnostic checkpoint ${name} lost the active Veyra vessel`);
  }
  await writeFile(`${directory}/${name}.json`, JSON.stringify({
    tier,
    checkpoint: name,
    manifestDigest,
    browser: browser.browserType().name(),
    browserVersion: browser.version(),
    consoleErrors: [...errors],
    shaderErrors: errors.filter((error) => /shader/i.test(error)),
    assetErrors: errors.filter((error) => /asset|texture|ktx/i.test(error)),
    ...payload,
  }, null, 2));
}
