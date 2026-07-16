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
import { sanitizeInterstageShroudSpec } from '../sim/interstage';
import type { SasMode, Situation } from '../sim/flight';
import type { AlarmKind } from '../sim/state';
import type { CampaignState } from '../sim/campaign';
import { EXPERIMENT_INDEX, experimentCap, type ScienceSituation } from '../content/science';
import { AUREN_SYSTEM } from '../content/system';
import { encodeScienceKey, type BufferedResult, type LedgerEntry } from '../sim/science';

export const SAVE_VERSION = 9;

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

const ALARM_KINDS: ReadonlySet<AlarmKind> = new Set(['custom', 'transfer', 'maneuver', 'entry']);
const PART_ACTIONS = new Set(['toggle', 'activate', 'deactivate']);

export function validateSave(raw: unknown): raw is SaveGame {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Partial<SaveGame>;
  if (typeof s.saveVersion !== 'number') return false;
  if (typeof s.time !== 'number' || !Number.isFinite(s.time)) return false;
  if (!Array.isArray(s.vessels)) return false;
  if ((s.saveVersion ?? 0) >= 8) {
    const campaign = s.campaign;
    if (!campaign || !['sandbox', 'exploration', 'program'].includes(campaign.mode)) return false;
    if (!Number.isFinite(campaign.funds) || campaign.funds < 0) return false;
    if (!Number.isFinite(campaign.reputation) || campaign.reputation < 0) return false;
    if (!Array.isArray(campaign.unlockedTech)) return false;
    if (!Array.isArray(campaign.activeContracts)) return false;
    if (!Array.isArray(campaign.completedContracts)) return false;
    if ((s.saveVersion ?? 0) >= 9) {
      if (typeof campaign.upgradeLevels !== 'object' || campaign.upgradeLevels === null) return false;
      for (const level of Object.values(campaign.upgradeLevels)) {
        if (!Number.isInteger(level) || level < 0) return false;
      }
    }
  }
  if ((s.saveVersion ?? 0) >= 9) {
    if (!s.science || typeof s.science.ledger !== 'object' || s.science.ledger === null) return false;
    for (const entry of Object.values(s.science.ledger)) {
      if (!validLedgerEntry(entry)) return false;
    }
  }
  if ((s.saveVersion ?? 0) >= 3) {
    if (!Array.isArray(s.alarms)) return false;
    for (const alarm of s.alarms) {
      if (typeof alarm.id !== 'string' || !alarm.id) return false;
      if (!Number.isFinite(alarm.time)) return false;
      if (typeof alarm.label !== 'string' || !alarm.label.trim()) return false;
      if (!ALARM_KINDS.has(alarm.kind)) return false;
      if (
        (s.saveVersion ?? 0) >= 7
        && alarm.vesselId !== null
        && (typeof alarm.vesselId !== 'string' || !alarm.vesselId)
      ) return false;
    }
  }
  for (const v of s.vessels) {
    if (typeof v.id !== 'string' || typeof v.bodyId !== 'string') return false;
    if (!v.craft || !Array.isArray(v.craft.parts)) return false;
    for (const p of v.craft.parts) {
      if (typeof p.defId !== 'string' || typeof p.key !== 'number') return false;
      if (!p.position || !Number.isFinite(p.position.x)) return false;
      if (p.interstageShroud !== undefined && !sanitizeInterstageShroudSpec(p.interstageShroud)) return false;
    }
    if (!v.pos || !Number.isFinite(v.pos.x) || !Number.isFinite(v.vel?.x ?? NaN)) return false;
    if ((s.saveVersion ?? 0) >= 4) {
      if (v.surfacePose !== null && typeof v.surfacePose !== 'object') return false;
      if (v.surfacePose) {
        const pose = v.surfacePose;
        if (pose.bodyId !== v.bodyId) return false;
        if (!/^[a-f0-9]{32}$/.test(pose.recipeHash)) return false;
        if (!/^[a-f0-9]{32}$/.test(pose.scatterRecipeHash)) return false;
        if (!pose.directionBF || !Number.isFinite(pose.directionBF.x)) return false;
        if (!pose.attitudeBF || !Number.isFinite(pose.attitudeBF.w)) return false;
        if (!Number.isFinite(pose.contactOffset)) return false;
      }
    }
    if ((s.saveVersion ?? 0) >= 6) {
      if (v.target !== null && (typeof v.target !== 'string' || !v.target)) return false;
      if (
        typeof v.craft.actionGroups !== 'object'
        || v.craft.actionGroups === null
        || Array.isArray(v.craft.actionGroups)
      ) return false;
      for (const [rawGroup, assignments] of Object.entries(v.craft.actionGroups)) {
        const group = Number(rawGroup);
        if (!Number.isInteger(group) || group < 1 || group > 10 || !Array.isArray(assignments)) {
          return false;
        }
        for (const assignment of assignments) {
          if (typeof assignment !== 'object' || assignment === null) return false;
          if (!Number.isInteger(assignment.partKey)) return false;
          if (!PART_ACTIONS.has(assignment.action)) return false;
        }
      }
    }
    if ((s.saveVersion ?? 0) >= 9) {
      if (typeof v.scienceBuffer !== 'object' || v.scienceBuffer === null) return false;
      for (const entry of Object.values(v.scienceBuffer)) {
        if (!validBufferedResult(entry)) return false;
      }
    }
  }
  return true;
}

function validLedgerEntry(entry: unknown): entry is SavedLedgerEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const value = entry as Partial<SavedLedgerEntry>;
  return Number.isInteger(value.cap) && value.cap! >= 1
    && Number.isInteger(value.deliveredByTransmit) && value.deliveredByTransmit! >= 0
    && Number.isInteger(value.deliveredByRecovery) && value.deliveredByRecovery! >= 0
    && value.deliveredByTransmit! + value.deliveredByRecovery! <= value.cap!;
}

function validBufferedResult(entry: unknown): entry is SavedBufferedResult {
  if (typeof entry !== 'object' || entry === null) return false;
  const value = entry as Partial<SavedBufferedResult>;
  return Number.isInteger(value.siteCapAtCollection) && value.siteCapAtCollection! >= 1
    && Number.isInteger(value.heldValue) && value.heldValue! >= 1
    && Number.isInteger(value.transmittedFromThis) && value.transmittedFromThis! >= 0
    && Number.isInteger(value.transmitTarget) && value.transmitTarget! >= 0
    && value.transmittedFromThis! <= value.transmitTarget!
    && value.transmitTarget! <= value.heldValue!;
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

function legacyCap(experimentId: string, bodyId: string): number {
  const experiment = EXPERIMENT_INDEX.get(experimentId);
  const body = AUREN_SYSTEM.find((candidate) => candidate.id === bodyId);
  if (!experiment || !body) return 1;
  const globalMultiplier = body.biomes?.find((biome) => biome.id === 'global')?.scienceMultiplier ?? 1;
  return experimentCap(experiment, body.scienceValue, globalMultiplier);
}

/** Upgrade an older save to the current version. Throws on unknown versions. */
export function migrateSave(raw: SaveGame): SaveGame {
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
      const cap = legacyCap(parsed.experimentId, parsed.bodyId);
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
            siteCapAtCollection: legacyCap(parsed.experimentId, parsed.bodyId),
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
