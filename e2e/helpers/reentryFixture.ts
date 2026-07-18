import type { Page } from '@playwright/test';
import type { Craft } from '../../src/sim/vessel';
import type { SaveGame } from '../../src/save/schema';

export interface ReentryFixtureOptions {
  readonly altitude?: number;
  readonly airspeed?: number;
  readonly descentSpeed?: number;
  readonly label?: string;
}

/**
 * Build a production-schema save whose active craft starts under a repeatable
 * real aero/thermal load. The browser restores and validates this document
 * through the same persistence path as a player save. The high-altitude,
 * high-speed default keeps dynamic pressure below the structural limit while
 * exercising the complete VFX stack.
 */
export function createReentryFixtureSave(
  sourceCraft: Readonly<Craft>,
  options: Readonly<ReentryFixtureOptions> = {},
): SaveGame {
  const altitude = options.altitude ?? 72_000;
  const airspeed = options.airspeed ?? 18_000;
  const descentSpeed = options.descentSpeed ?? 300;
  const label = options.label ?? 'Reentry visual fixture';
  const craft = structuredClone(sourceCraft) as Craft;
  const id = 'reentry-vfx-fixture-vessel';
  return {
    saveVersion: 9,
    createdAt: 1_721_174_400_000,
    label,
    time: 12_000,
    activeVesselId: id,
    vessels: [{
      id,
      name: label,
      craft: {
        name: craft.name,
        version: craft.version,
        parts: craft.parts.map((part) => ({
          ...part,
          position: { ...part.position },
          rotation: { ...part.rotation },
          resources: { ...part.resources },
          interstageShroud: part.interstageShroud ? { ...part.interstageShroud } : undefined,
        })),
        stages: craft.stages.map((stage) => ({ partKeys: [...stage.partKeys] })),
        actionGroups: structuredClone(craft.actionGroups),
        nextKey: craft.nextKey,
      },
      bodyId: 'veyra',
      regime: 'active',
      pos: { x: 1_000_000 + altitude, y: 0, z: 0 },
      vel: { x: -descentSpeed, y: airspeed, z: 0 },
      att: { x: 0, y: 0, z: 0, w: 1 },
      angVel: { x: 0, y: 0, z: 0 },
      situation: 'suborbital',
      sas: 'stability',
      throttle: 0,
      currentStage: 0,
      isDebris: false,
      crew: ['Miro Tal'],
      charge: 150,
      scienceBuffer: {},
      railsElements: null,
      railsLandedPos: null,
      railsLandedAtt: null,
      surfacePose: null,
      target: null,
    }],
    science: { points: 0, ledger: {} },
    flags: {},
    campaign: {
      mode: 'sandbox',
      funds: 0,
      reputation: 0,
      unlockedTech: [],
      activeContracts: [],
      completedContracts: [],
      upgradeLevels: { 'field-methods': 0, 'downlink-coding': 0 },
    },
    isru: { scanned: [] },
    alarms: [],
  };
}

export async function seedReentrySave(
  page: Page,
  save: Readonly<SaveGame>,
  slot = 'auto',
): Promise<void> {
  await page.addInitScript(async ({ key, value }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('perilune', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('saves', 'readwrite');
        transaction.objectStore('saves').put(JSON.stringify(value), `save:${key}`);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { key: slot, value: save });
}

export async function loadReentrySave(page: Page): Promise<void> {
  const continueMission = page.getByRole('button', { name: 'Continue Mission' });
  await continueMission.waitFor({ state: 'visible' });
  await continueMission.click();
  await page.waitForFunction(() => (
    window as unknown as { __TEST__?: { screen(): string } }
  ).__TEST__?.screen() === 'flight');
}
