import { mkdir, writeFile } from 'node:fs/promises';
import type { Browser, Page } from '@playwright/test';

export interface DiagnosticProbe {
  screen(): string;
  partCount(): number;
  altitude(): number | null;
  verticalSpeed(): number | null;
  properAcceleration(): number;
  situation(): string | null;
  currentStage(): number | null;
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
  time: number;
}> {
  return page.evaluate(() => ({
    altitude: window.__TEST__.altitude() ?? 0,
    verticalSpeed: window.__TEST__.verticalSpeed() ?? 0,
    properAcceleration: window.__TEST__.properAcceleration(),
    situation: window.__TEST__.situation(),
    stage: window.__TEST__.currentStage(),
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

export async function captureCheckpoint(
  page: Page,
  browser: Browser,
  tier: 'medium' | 'high',
  name: string,
  errors: readonly string[],
): Promise<void> {
  const directory = `test-results/veyra-render-diagnostics/${tier}`;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
  const payload = await page.evaluate(() => ({
    flight: {
      altitude: window.__TEST__.altitude(),
      verticalSpeed: window.__TEST__.verticalSpeed(),
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
    browser: browser.browserType().name(),
    browserVersion: browser.version(),
    consoleErrors: [...errors],
    shaderErrors: errors.filter((error) => /shader/i.test(error)),
    assetErrors: errors.filter((error) => /asset|texture|ktx/i.test(error)),
    ...payload,
  }, null, 2));
}
