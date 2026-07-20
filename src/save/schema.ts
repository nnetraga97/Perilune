/**
 * Versioned save schema. Everything in a save is plain JSON data.
 *
 * Rules:
 *  - SAVE_VERSION bumps on any breaking shape change.
 *  - migrateSave() upgrades old saves step by step; it never throws away a
 *    campaign silently — unknown versions fail loudly BEFORE overwriting.
 *  - Writes are transactional: new value is verified (round-trip parse +
 *    validate) before replacing the previous slot, and a backup rotation
 *    keeps the last 3 good saves.
 */
import type { Vec3Like } from '../core/vec3';
import type { QuatLike } from '../core/quat';
import type { ActionGroups, Craft, Stage, PartInstance, InterstageShroudSpec } from '../sim/vessel';
import type { SasMode, Situation } from '../sim/flight';
import type { AlarmKind } from '../sim/state';
import type { CampaignState } from '../sim/campaign';
import { EXPERIMENT_INDEX, experimentCap, type ScienceSituation } from '../content/science';
import { SOL_SYSTEM } from '../content/system';
import type { BodyDef } from '../sim/universe';
import { encodeScienceKey, type BufferedResult, type LedgerEntry } from '../sim/science';

export { SAVE_VERSION, validateSave } from './validation';
import { SAVE_VERSION } from './validation';

export type SavedBufferedResult = BufferedResult;
export type SavedLedgerEntry = LedgerEntry;

export interface SavedAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
  vesselId: string | null;
}

export interface SavedSurfacePose {
  bodyId: string;
  recipeHash: string;
  scatterRecipeHash: string;
  directionBF: Vec3Like;
  attitudeBF: QuatLike;
  contactOffset: number;
}

export interface SavedPart {
  key: number;
  defId: string;
  parentKey: number | null;
  attach: string;
  position: Vec3Like;
  rotation: QuatLike;
  resources: Record<string, number>;
  symmetry: number;
  activated?: boolean;
  deployed?: boolean;
  temperature?: number;
  interstageShroud?: InterstageShroudSpec;
}

export interface SavedCraft {
  name: string;
  version: number;
  parts: SavedPart[];
  stages: Stage[];
  actionGroups: ActionGroups;
  nextKey: number;
}

export interface SavedVessel {
  id: string;
  name: string;
  craft: SavedCraft;
  bodyId: string;
  regime: 'active' | 'rails';
  pos: Vec3Like;
  vel: Vec3Like;
  att: QuatLike;
  angVel: Vec3Like;
  situation: Situation;
  sas: SasMode;
  throttle: number;
  currentStage: number;
  isDebris: boolean;
  crew: string[];
  charge: number;
  /** Legacy v1-v8 aboard science. */
  science?: Record<string, number>;
  /** Canonical v9 aboard science buffers. */
  scienceBuffer: Record<string, SavedBufferedResult>;
  railsElements: {
    a: number;
    e: number;
    i: number;
    raan: number;
    argPe: number;
    meanAnomaly0: number;
    epoch: number;
    mu: number;
  } | null;
  railsLandedPos: Vec3Like | null;
  railsLandedAtt: QuatLike | null;
  /** Body-fixed landed pose and terrain compatibility contract (v4). */
  surfacePose: SavedSurfacePose | null;
  /** Optional body id selected for navigation and map readouts (v6). */
  target: string | null;
}

export interface SaveGame {
  saveVersion: number;
  createdAt: number;
  label: string;
  time: number;
  activeVesselId: string | null;
  vessels: SavedVessel[];
  /** Spendable science balance and canonical delivered-site ledger. */
  science: { points: number; ledger: Record<string, SavedLedgerEntry>; completed?: string[] };
  /** Tutorial / progress flags. */
  flags: Record<string, boolean>;
  /** Game mode, technology, economy, and contracts (added in v8). */
  campaign: CampaignState;
  /** ISRU state: bodies surveyed for resources (added in v2). */
  isru?: { scanned: string[] };
  /** Mission alarms (added in v3). */
  alarms: SavedAlarm[];
}

const LEGACY_SITUATIONS: readonly ScienceSituation[] = [
  'flying-high', 'flying-low', 'space-high', 'space-low', 'surface', 'ocean',
];

function parseLegacyScienceKey(key: string): { experimentId: string; bodyId: string; situation: ScienceSituation } | null {
  const at = key.indexOf('@');
  if (at < 1) return null;
  for (const situation of LEGACY_SITUATIONS) {
    const suffix = `-${situation}`;
    if (key.endsWith(suffix)) {
      return { experimentId: key.slice(0, at), bodyId: key.slice(at + 1, -suffix.length), situation };
    }
  }
  return null;
}

function legacyCap(experimentId: string, bodyId: string, bodies: readonly BodyDef[]): number {
  const experiment = EXPERIMENT_INDEX.get(experimentId);
  const body = bodies.find((candidate) => candidate.id === bodyId);
  if (!experiment || !body) return 1;
  const globalMultiplier = body.biomes?.find((biome) => biome.id === 'global')?.scienceMultiplier ?? 1;
  return experimentCap(experiment, body.scienceValue, globalMultiplier);
}

/** Upgrade an older save to the current version. Throws on unknown versions. */
export function migrateSave(raw: SaveGame, bodies: readonly BodyDef[] = SOL_SYSTEM): SaveGame {
  let save = raw;
  if (save.saveVersion > SAVE_VERSION) {
    throw new Error(
      `Save is from a newer version (${save.saveVersion} > ${SAVE_VERSION}); refusing to load.`,
    );
  }
  // Migrations chain version by version.
  if (save.saveVersion === 1) {
    save = { ...save, saveVersion: 2, isru: { scanned: [] } };
  }
  if (save.saveVersion === 2) {
    save = { ...save, saveVersion: 3, alarms: [] };
  }
  if (save.saveVersion === 3) {
    save = {
      ...save,
      saveVersion: 4,
      vessels: save.vessels.map((vessel) => ({ ...vessel, surfacePose: null })),
    };
  }
  if (save.saveVersion === 4) {
    // Structural bump to version 5. Version-4 surface poses stored the physical
    // scatter hash as an alias of the terrain hash; restoreGame rewrites those
    // aliases to each body's declared scatter recipe once the universe is known.
    save = { ...save, saveVersion: 5 };
  }
  if (save.saveVersion === 5) {
    save = {
      ...save,
      saveVersion: 6,
      vessels: save.vessels.map((vessel) => ({
        ...vessel,
        target: null,
        craft: { ...vessel.craft, actionGroups: {} },
      })),
    };
  }
  if (save.saveVersion === 6) {
    save = {
      ...save,
      saveVersion: 7,
      alarms: save.alarms.map((alarm) => ({ ...alarm, vesselId: null })),
    };
  }
  if (save.saveVersion === 7) {
    save = {
      ...save,
      saveVersion: 8,
      campaign: {
        mode: 'sandbox',
        funds: 0,
        reputation: 0,
        unlockedTech: [],
        activeContracts: [],
        completedContracts: [],
        upgradeLevels: { 'field-methods': 0, 'downlink-coding': 0 },
      },
    };
  }
  if (save.saveVersion === 8) {
    const completed = save.science?.completed ?? [];
    const ledger: Record<string, SavedLedgerEntry> = {};
    for (const legacyId of completed) {
      const parsed = parseLegacyScienceKey(legacyId);
      if (!parsed) continue;
        const cap = legacyCap(parsed.experimentId, parsed.bodyId, bodies);
      const keyId = encodeScienceKey({ ...parsed, biomeId: 'global' });
      ledger[keyId] = { cap, deliveredByTransmit: 0, deliveredByRecovery: cap };
    }
    save = {
      ...save,
      saveVersion: 9,
      science: { points: save.science?.points ?? 0, ledger },
      campaign: {
        ...save.campaign,
        upgradeLevels: { 'field-methods': 0, 'downlink-coding': 0 },
      },
      vessels: save.vessels.map((vessel) => {
        const scienceBuffer: Record<string, SavedBufferedResult> = {};
        for (const [legacyId, storedValue] of Object.entries(vessel.science ?? {})) {
          const parsed = parseLegacyScienceKey(legacyId);
          if (!parsed) continue;
          const heldValue = Math.max(1, Math.round(storedValue));
          const experiment = EXPERIMENT_INDEX.get(parsed.experimentId);
          const keyId = encodeScienceKey({ ...parsed, biomeId: 'global' });
          scienceBuffer[keyId] = {
            siteCapAtCollection: legacyCap(parsed.experimentId, parsed.bodyId, bodies),
            heldValue,
            transmittedFromThis: 0,
            transmitTarget: Math.round(heldValue * (experiment?.transmitFraction ?? 0)),
          };
        }
        const { science: _legacyScience, ...current } = vessel;
        return { ...current, scienceBuffer };
      }),
    };
  }
  if (save.saveVersion !== SAVE_VERSION) {
    throw new Error(`No migration path from save version ${save.saveVersion}.`);
  }
  return save;
}
