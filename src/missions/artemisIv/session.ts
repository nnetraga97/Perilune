import { SAVE_VERSION, validateSave, type SaveGame } from '../../save/schema';

export const ARTEMIS_IV_SESSION_STORAGE_KEY = 'perilune.missions.artemis-iv.chapter-session';
export const ARTEMIS_IV_SESSION_DOCUMENT_VERSION = 1;
export const ARTEMIS_IV_MISSION_VERSION = 1;

export const ARTEMIS_IV_CHAPTERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type ArtemisIvChapter = (typeof ARTEMIS_IV_CHAPTERS)[number];

export const ARTEMIS_IV_ACKNOWLEDGEMENTS = [
  'provider-stand-in-understood',
  'crew-transfer-to-lander',
  'surface-expedition-complete',
  'crew-and-samples-returned-to-orion',
] as const;
export type ArtemisIvAcknowledgement = (typeof ARTEMIS_IV_ACKNOWLEDGEMENTS)[number];

/**
 * The only persisted Artemis IV state. The save is always the beginning of
 * currentChapter: resume and Retry Chapter deliberately restore the same
 * checked checkpoint rather than an arbitrary live frame.
 */
export interface ArtemisIvSessionDocument {
  documentVersion: typeof ARTEMIS_IV_SESSION_DOCUMENT_VERSION;
  missionVersion: typeof ARTEMIS_IV_MISSION_VERSION;
  currentChapter: ArtemisIvChapter;
  completedAcknowledgements: ArtemisIvAcknowledgement[];
  completed: boolean;
  chapterStartSave: SaveGame;
}

export interface ArtemisIvSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ArtemisIvSessionIncompatibility =
  | 'document-version'
  | 'mission-version'
  | 'save-version';

export type ArtemisIvSessionReadResult =
  | { status: 'empty' }
  | { status: 'ready'; document: ArtemisIvSessionDocument }
  | { status: 'corrupt' }
  | { status: 'incompatible'; reason: ArtemisIvSessionIncompatibility }
  | { status: 'unavailable' };

const chapterSet = new Set<number>(ARTEMIS_IV_CHAPTERS);
const acknowledgementSet = new Set<string>(ARTEMIS_IV_ACKNOWLEDGEMENTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectDocument(raw: unknown): ArtemisIvSessionReadResult {
  if (!isRecord(raw)) return { status: 'corrupt' };

  if (!Number.isInteger(raw.documentVersion)) return { status: 'corrupt' };
  if (raw.documentVersion !== ARTEMIS_IV_SESSION_DOCUMENT_VERSION) {
    return { status: 'incompatible', reason: 'document-version' };
  }

  if (!Number.isInteger(raw.missionVersion)) return { status: 'corrupt' };
  if (raw.missionVersion !== ARTEMIS_IV_MISSION_VERSION) {
    return { status: 'incompatible', reason: 'mission-version' };
  }

  const checkpoint = raw.chapterStartSave;
  if (!isRecord(checkpoint) || !Number.isInteger(checkpoint.saveVersion)) {
    return { status: 'corrupt' };
  }
  if (checkpoint.saveVersion !== SAVE_VERSION) {
    return { status: 'incompatible', reason: 'save-version' };
  }

  if (!Number.isInteger(raw.currentChapter) || !chapterSet.has(raw.currentChapter as number)) {
    return { status: 'corrupt' };
  }
  if (typeof raw.completed !== 'boolean') return { status: 'corrupt' };
  if (!Array.isArray(raw.completedAcknowledgements)) return { status: 'corrupt' };

  const acknowledgements = raw.completedAcknowledgements;
  if (
    acknowledgements.some((value) => typeof value !== 'string' || !acknowledgementSet.has(value))
    || new Set(acknowledgements).size !== acknowledgements.length
  ) {
    return { status: 'corrupt' };
  }

  if (!validateSave(checkpoint)) return { status: 'corrupt' };
  return { status: 'ready', document: raw as unknown as ArtemisIvSessionDocument };
}

export function validateArtemisIvSessionDocument(
  raw: unknown,
): raw is ArtemisIvSessionDocument {
  return inspectDocument(raw).status === 'ready';
}

/** Local-only Artemis persistence; this intentionally has no save-sync hooks. */
export class ArtemisIvSessionStore {
  constructor(private readonly storage: ArtemisIvSessionStorage | null) {}

  read(): ArtemisIvSessionReadResult {
    if (!this.storage) return { status: 'unavailable' };
    let serialized: string | null;
    try {
      serialized = this.storage.getItem(ARTEMIS_IV_SESSION_STORAGE_KEY);
    } catch {
      return { status: 'unavailable' };
    }
    if (serialized === null) return { status: 'empty' };
    try {
      return inspectDocument(JSON.parse(serialized) as unknown);
    } catch {
      return { status: 'corrupt' };
    }
  }

  write(document: ArtemisIvSessionDocument): boolean {
    if (!this.storage || !validateArtemisIvSessionDocument(document)) return false;
    try {
      const serialized = JSON.stringify(document);
      // Validate the exact JSON form before it replaces the last good chapter.
      if (!validateArtemisIvSessionDocument(JSON.parse(serialized) as unknown)) return false;
      this.storage.setItem(ARTEMIS_IV_SESSION_STORAGE_KEY, serialized);
      return true;
    } catch {
      return false;
    }
  }

  clear(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(ARTEMIS_IV_SESSION_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }
}

export function browserArtemisIvSessionStore(): ArtemisIvSessionStore {
  try {
    return new ArtemisIvSessionStore(window.localStorage);
  } catch {
    return new ArtemisIvSessionStore(null);
  }
}
