import { describe, expect, it } from 'vitest';
import type { SaveGame } from '../src/save/schema';
import {
  ARTEMIS_IV_VISIBLE_QUALIFIER,
  bindMenuContinueSave,
  menuMissions,
} from '../src/ui/mainMenu';

const save = {
  label: 'autosave',
  time: 412,
  activeVesselId: 'v2',
  vessels: [
    { id: 'v1', name: 'Wayfarer' },
    { id: 'v2', name: 'Pathfinder' },
  ],
} as unknown as SaveGame;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushAsyncBinding(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('main-menu mission hierarchy', () => {
  it('leads with Continue when an autosave exists', () => {
    const missions = menuMissions(save);
    expect(missions.map((mission) => mission.id)).toEqual([
      'continue', 'first-light', 'exploration', 'program', 'sandbox',
    ]);
    expect(missions.find((mission) => mission.primary)?.id).toBe('continue');
    expect(missions[0].detail).toContain('Pathfinder');
    expect(missions[0].detail).not.toContain('Wayfarer');
  });

  it('omits dead Continue and promotes First Light without a save', () => {
    const missions = menuMissions(null);
    expect(missions.map((mission) => mission.id)).toEqual([
      'first-light', 'exploration', 'program', 'sandbox',
    ]);
    expect(missions.find((mission) => mission.primary)?.id).toBe('first-light');
  });

  it('keeps Artemis IV development-gated by default', () => {
    expect(menuMissions(null).some((mission) => mission.id === 'artemis-iv')).toBe(false);
  });

  it('makes a new Artemis IV session primary while retaining First Light', () => {
    const missions = menuMissions(null, { artemisIvEnabled: true });
    expect(missions.map((mission) => mission.id)).toEqual([
      'artemis-iv', 'first-light', 'exploration', 'program', 'sandbox',
    ]);
    expect(missions.find((mission) => mission.primary)?.id).toBe('artemis-iv');
    expect(missions.some((mission) => mission.id === 'first-light')).toBe(true);
    expect(missions[0]).toMatchObject({
      title: 'ARTEMIS IV',
      detail: 'BEGIN MISSION',
      qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
    });
  });

  it('shows chapter-checkpoint resume without displacing a normal Continue', () => {
    const missions = menuMissions(save, {
      artemisIvEnabled: true,
      artemisIvState: { status: 'resume', chapter: 4 },
    });
    expect(missions.map((mission) => mission.id).slice(0, 3)).toEqual([
      'continue', 'artemis-iv', 'first-light',
    ]);
    expect(missions.find((mission) => mission.primary)?.id).toBe('continue');
    expect(missions[1]).toMatchObject({
      title: 'RESUME ARTEMIS IV · CHAPTER 4',
      detail: 'Resume begins at the chapter checkpoint',
      qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
      restart: {
        mission: 'artemis-iv',
        label: 'RESTART FROM CHAPTER 1',
      },
    });
  });

  it('offers an explicit First Light restart from launch', () => {
    expect(menuMissions(null).find((mission) => mission.id === 'first-light')).toMatchObject({
      restart: {
        mission: 'first-light',
        label: 'START OVER FROM LAUNCH',
      },
    });
  });

  it('turns a completed Artemis IV session into Fly Again', () => {
    const missions = menuMissions(null, {
      artemisIvEnabled: true,
      artemisIvState: { status: 'complete' },
    });
    expect(missions[0]).toMatchObject({
      id: 'artemis-iv',
      title: 'ARTEMIS IV',
      detail: 'FLY AGAIN',
      primary: true,
      qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
    });
  });
});

describe('main-menu Continue save binding', () => {
  it('uses the newest change when an earlier read resolves late', async () => {
    const initialRead = deferred<SaveGame | null>();
    const cloudRead = deferred<SaveGame | null>();
    const reads = [initialRead.promise, cloudRead.promise];
    let emitChange = () => {};
    const rendered: Array<SaveGame | null> = [];

    const stop = bindMenuContinueSave({
      read: async () => reads.shift() ?? null,
      subscribe: (listener) => {
        emitChange = listener;
        return () => { emitChange = () => {}; };
      },
    }, {
      setContinueSave: (next) => rendered.push(next),
    });

    emitChange();
    cloudRead.resolve(save);
    await flushAsyncBinding();
    expect(rendered).toEqual([save]);

    initialRead.resolve(null);
    await flushAsyncBinding();
    expect(rendered).toEqual([save]);
    stop();
  });

  it('removes Continue after an emitted deletion and stops cleanly', async () => {
    let current: SaveGame | null = save;
    let emitChange = () => {};
    const rendered: Array<SaveGame | null> = [];
    let unsubscribed = false;

    const stop = bindMenuContinueSave({
      read: async () => current,
      subscribe: (listener) => {
        emitChange = listener;
        return () => { unsubscribed = true; };
      },
    }, {
      setContinueSave: (next) => rendered.push(next),
    });
    await flushAsyncBinding();

    current = null;
    emitChange();
    await flushAsyncBinding();
    expect(rendered).toEqual([save, null]);

    stop();
    current = save;
    emitChange();
    await flushAsyncBinding();
    expect(unsubscribed).toBe(true);
    expect(rendered).toEqual([save, null]);
  });
});
