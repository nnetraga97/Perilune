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
import type { Craft, Stage, PartInstance } from '../sim/vessel';
import type { SasMode, Situation } from '../sim/flight';
import type { AlarmKind } from '../sim/state';

export const SAVE_VERSION = 4;

export interface SavedAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
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
}

export interface SavedCraft {
  name: string;
  version: number;
  parts: SavedPart[];
  stages: Stage[];
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
  science: Record<string, number>;
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
}

export interface SaveGame {
  saveVersion: number;
  createdAt: number;
  label: string;
  time: number;
  activeVesselId: string | null;
  vessels: SavedVessel[];
  /** Recovered science points and completed experiment keys. */
  science: { points: number; completed: string[] };
  /** Tutorial / progress flags. */
  flags: Record<string, boolean>;
  /** ISRU state: bodies surveyed for resources (added in v2). */
  isru?: { scanned: string[] };
  /** Mission alarms (added in v3). */
  alarms: SavedAlarm[];
}

const ALARM_KINDS: ReadonlySet<AlarmKind> = new Set(['custom', 'transfer', 'maneuver', 'entry']);

export function validateSave(raw: unknown): raw is SaveGame {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Partial<SaveGame>;
  if (typeof s.saveVersion !== 'number') return false;
  if (typeof s.time !== 'number' || !Number.isFinite(s.time)) return false;
  if (!Array.isArray(s.vessels)) return false;
  if ((s.saveVersion ?? 0) >= 3) {
    if (!Array.isArray(s.alarms)) return false;
    for (const alarm of s.alarms) {
      if (typeof alarm.id !== 'string' || !alarm.id) return false;
      if (!Number.isFinite(alarm.time)) return false;
      if (typeof alarm.label !== 'string' || !alarm.label.trim()) return false;
      if (!ALARM_KINDS.has(alarm.kind)) return false;
    }
  }
  for (const v of s.vessels) {
    if (typeof v.id !== 'string' || typeof v.bodyId !== 'string') return false;
    if (!v.craft || !Array.isArray(v.craft.parts)) return false;
    for (const p of v.craft.parts) {
      if (typeof p.defId !== 'string' || typeof p.key !== 'number') return false;
      if (!p.position || !Number.isFinite(p.position.x)) return false;
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
  }
  return true;
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
  if (save.saveVersion !== SAVE_VERSION) {
    throw new Error(`No migration path from save version ${save.saveVersion}.`);
  }
  return save;
}
