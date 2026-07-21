import { describe, expect, it } from 'vitest';
import {
  ARTEMIS_IV_MISSION_VERSION,
  ARTEMIS_IV_SESSION_DOCUMENT_VERSION,
  ARTEMIS_IV_SESSION_STORAGE_KEY,
  ArtemisIvSessionStore,
  type ArtemisIvSessionDocument,
  type ArtemisIvSessionStorage,
} from '../src/missions/artemisIv/session';
import { SAVE_VERSION, type SaveGame } from '../src/save/schema';

function checkpoint(): SaveGame {
  return {
    saveVersion: SAVE_VERSION,
    createdAt: 1,
    label: 'Artemis IV chapter 3 checkpoint',
    time: 1234,
    activeVesselId: null,
    vessels: [],
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

function session(): ArtemisIvSessionDocument {
  return {
    documentVersion: ARTEMIS_IV_SESSION_DOCUMENT_VERSION,
    missionVersion: ARTEMIS_IV_MISSION_VERSION,
    currentChapter: 3,
    completedAcknowledgements: [
      'provider-stand-in-understood',
      'crew-transfer-to-lander',
    ],
    completed: false,
    chapterStartSave: checkpoint(),
  };
}

function memoryStorage(): ArtemisIvSessionStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe('Artemis IV local chapter session', () => {
  it('round-trips one namespaced document containing a validated checkpoint', () => {
    const storage = memoryStorage();
    const store = new ArtemisIvSessionStore(storage);

    expect(store.write(session())).toBe(true);
    expect([...storage.values.keys()]).toEqual([ARTEMIS_IV_SESSION_STORAGE_KEY]);
    expect(store.read()).toEqual({ status: 'ready', document: session() });

    expect(store.clear()).toBe(true);
    expect(store.read()).toEqual({ status: 'empty' });
  });

  it('does not replace the last good checkpoint with invalid data', () => {
    const storage = memoryStorage();
    const store = new ArtemisIvSessionStore(storage);
    const good = session();
    expect(store.write(good)).toBe(true);
    const serializedGood = storage.values.get(ARTEMIS_IV_SESSION_STORAGE_KEY);

    const invalid = { ...good, currentChapter: 99 } as unknown as ArtemisIvSessionDocument;
    expect(store.write(invalid)).toBe(false);
    expect(storage.values.get(ARTEMIS_IV_SESSION_STORAGE_KEY)).toBe(serializedGood);
  });

  it('separates corrupt data from incompatible mission and save versions', () => {
    const storage = memoryStorage();
    const store = new ArtemisIvSessionStore(storage);

    storage.setItem(ARTEMIS_IV_SESSION_STORAGE_KEY, '{not-json');
    expect(store.read()).toEqual({ status: 'corrupt' });

    storage.setItem(ARTEMIS_IV_SESSION_STORAGE_KEY, JSON.stringify({
      ...session(),
      missionVersion: ARTEMIS_IV_MISSION_VERSION + 1,
    }));
    expect(store.read()).toEqual({ status: 'incompatible', reason: 'mission-version' });

    storage.setItem(ARTEMIS_IV_SESSION_STORAGE_KEY, JSON.stringify({
      ...session(),
      chapterStartSave: { ...checkpoint(), saveVersion: SAVE_VERSION - 1 },
    }));
    expect(store.read()).toEqual({ status: 'incompatible', reason: 'save-version' });
  });

  it('degrades safely when local storage is unavailable', () => {
    const unavailable = new ArtemisIvSessionStore(null);
    expect(unavailable.read()).toEqual({ status: 'unavailable' });
    expect(unavailable.write(session())).toBe(false);
    expect(unavailable.clear()).toBe(false);

    const throwing = new ArtemisIvSessionStore({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(throwing.read()).toEqual({ status: 'unavailable' });
    expect(throwing.write(session())).toBe(false);
    expect(throwing.clear()).toBe(false);
  });
});
