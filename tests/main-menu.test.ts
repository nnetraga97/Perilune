import { describe, expect, it } from 'vitest';
import type { SaveGame } from '../src/save/schema';
import { bindMenuContinueSave, menuMissions } from '../src/ui/mainMenu';

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
    expect(missions.map((mission) => mission.id)).toEqual(['continue', 'first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('continue');
    expect(missions[0].detail).toContain('Pathfinder');
    expect(missions[0].detail).not.toContain('Wayfarer');
  });

  it('omits dead Continue and promotes First Light without a save', () => {
    const missions = menuMissions(null);
    expect(missions.map((mission) => mission.id)).toEqual(['first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('first-light');
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
