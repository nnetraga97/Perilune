import { sanitizeInterstageShroudSpec } from '../core/interstageShroud.js';
import type { SaveGame, SavedBufferedResult, SavedLedgerEntry } from './schema';

export const SAVE_VERSION = 9;

const ALARM_KINDS = new Set<unknown>(['custom', 'transfer', 'maneuver', 'entry']);
const PART_ACTIONS = new Set<unknown>(['toggle', 'activate', 'deactivate']);
const ATTACH_KINDS = new Set<unknown>(['root', 'stack-top', 'stack-bottom', 'surface']);
const REGIMES = new Set<unknown>(['active', 'rails']);
const SITUATIONS = new Set<unknown>(['prelaunch', 'landed', 'splashed', 'flying', 'suborbital', 'orbit', 'escaping', 'destroyed']);
const SAS_MODES = new Set<unknown>(['off', 'stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radial-out', 'radial-in', 'ascent', 'node', 'custom']);
const MAX_VESSELS = 1_024;
const MAX_PARTS = 4_096;
const MAX_COLLECTION = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function text(value: unknown, maximum = 256, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function vector(value: unknown): boolean {
  return record(value) && finite(value.x) && finite(value.y) && finite(value.z);
}

function quaternion(value: unknown): boolean {
  return record(value) && vector(value) && finite(value.w);
}

function stringArray(value: unknown, maximum = MAX_COLLECTION): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => text(item));
}

function booleanRecord(value: unknown): boolean {
  return record(value) && Object.keys(value).length <= MAX_COLLECTION
    && Object.entries(value).every(([key, item]) => text(key) && typeof item === 'boolean');
}

export function validateSave(raw: unknown): raw is SaveGame {
  if (!record(raw)) return false;
  const s = raw as unknown as SaveGame;
  if (!integer(s.saveVersion, 1) || s.saveVersion > SAVE_VERSION) return false;
  if (!finite(s.createdAt) || s.createdAt < 0 || !text(s.label, 120)) return false;
  if (!finite(s.time) || s.time < 0) return false;
  if (s.activeVesselId !== null && !text(s.activeVesselId, 128)) return false;
  if (!Array.isArray(s.vessels) || s.vessels.length > MAX_VESSELS) return false;
  if (!booleanRecord(s.flags)) return false;
  if (!record(s.science) || !finite(s.science.points) || s.science.points < 0) return false;
  if (s.saveVersion >= 9) {
    if (!record(s.science.ledger) || Object.keys(s.science.ledger).length > MAX_COLLECTION) return false;
    if (!Object.entries(s.science.ledger).every(([key, entry]) => text(key) && validLedgerEntry(entry))) return false;
  } else if (s.science.completed !== undefined && !stringArray(s.science.completed)) return false;
  if (s.saveVersion >= 2) {
    if (!record(s.isru) || !stringArray(s.isru.scanned)) return false;
  }
  if (s.saveVersion >= 3) {
    if (!Array.isArray(s.alarms) || s.alarms.length > MAX_COLLECTION) return false;
    const alarmIds = new Set<string>();
    for (const alarm of s.alarms) {
      if (!record(alarm) || !text(alarm.id, 128) || alarmIds.has(alarm.id)) return false;
      alarmIds.add(alarm.id);
      if (!finite(alarm.time) || !text(alarm.label, 256) || !ALARM_KINDS.has(alarm.kind)) return false;
      if (s.saveVersion >= 7 && alarm.vesselId !== null && !text(alarm.vesselId, 128)) return false;
    }
  }
  if (s.saveVersion >= 8 && !validCampaign(s.campaign, s.saveVersion)) return false;

  const vesselIds = new Set<string>();
  for (const vessel of s.vessels) {
    if (!record(vessel) || !text(vessel.id, 128) || vesselIds.has(vessel.id)) return false;
    vesselIds.add(vessel.id);
    if (!text(vessel.name, 256) || !text(vessel.bodyId, 128)) return false;
    if (!REGIMES.has(vessel.regime) || !SITUATIONS.has(vessel.situation) || !SAS_MODES.has(vessel.sas)) return false;
    if (!vector(vessel.pos) || !vector(vessel.vel) || !quaternion(vessel.att) || !vector(vessel.angVel)) return false;
    if (!finite(vessel.throttle) || vessel.throttle < 0 || vessel.throttle > 1) return false;
    if (!integer(vessel.currentStage) || typeof vessel.isDebris !== 'boolean') return false;
    if (!stringArray(vessel.crew, 64) || !finite(vessel.charge) || vessel.charge < 0) return false;
    if (!validCraft(vessel.craft, s.saveVersion, vessel.currentStage)) return false;
    if (!validRailsElements(vessel.railsElements)) return false;
    if (vessel.railsLandedPos !== null && !vector(vessel.railsLandedPos)) return false;
    if (vessel.railsLandedAtt !== null && !quaternion(vessel.railsLandedAtt)) return false;
    if (s.saveVersion >= 4 && !validSurfacePose(vessel.surfacePose, vessel.bodyId)) return false;
    if (s.saveVersion >= 6 && vessel.target !== null && !text(vessel.target, 128)) return false;
    if (s.saveVersion >= 9) {
      if (!record(vessel.scienceBuffer) || Object.keys(vessel.scienceBuffer).length > MAX_COLLECTION) return false;
      if (!Object.entries(vessel.scienceBuffer).every(([key, entry]) => text(key) && validBufferedResult(entry))) return false;
    }
  }
  if (s.activeVesselId !== null && !vesselIds.has(s.activeVesselId)) return false;
  if (s.saveVersion >= 7 && s.alarms.some((alarm) => alarm.vesselId !== null && !vesselIds.has(alarm.vesselId))) return false;
  return true;
}

function validCampaign(value: unknown, version: number): boolean {
  if (!record(value) || !['sandbox', 'exploration', 'program'].includes(String(value.mode))) return false;
  if (!finite(value.funds) || value.funds < 0 || !finite(value.reputation) || value.reputation < 0) return false;
  if (!stringArray(value.unlockedTech) || !stringArray(value.activeContracts) || !stringArray(value.completedContracts)) return false;
  if (version >= 9) {
    if (!record(value.upgradeLevels) || Object.keys(value.upgradeLevels).length > 64) return false;
    if (!Object.values(value.upgradeLevels).every((level) => integer(level))) return false;
  }
  return true;
}

function validCraft(value: unknown, version: number, currentStage: number): boolean {
  if (!record(value) || !text(value.name, 256) || !integer(value.version, 1)) return false;
  if (!Array.isArray(value.parts) || value.parts.length > MAX_PARTS) return false;
  if (!Array.isArray(value.stages) || value.stages.length > MAX_PARTS || currentStage > value.stages.length) return false;
  const keys = new Set<number>();
  for (const part of value.parts) {
    if (!record(part) || !integer(part.key, 1) || keys.has(part.key) || !text(part.defId, 128)) return false;
    keys.add(part.key);
    if (part.parentKey !== null && !integer(part.parentKey, 1)) return false;
    if (!ATTACH_KINDS.has(part.attach) || !vector(part.position) || !quaternion(part.rotation)) return false;
    if (!record(part.resources) || Object.keys(part.resources).length > 64) return false;
    if (!Object.values(part.resources).every((amount) => finite(amount) && amount >= 0)) return false;
    if (!integer(part.symmetry)) return false;
    if (part.activated !== undefined && typeof part.activated !== 'boolean') return false;
    if (part.deployed !== undefined && typeof part.deployed !== 'boolean') return false;
    if (part.temperature !== undefined && !finite(part.temperature)) return false;
    if (part.interstageShroud !== undefined && !sanitizeInterstageShroudSpec(part.interstageShroud)) return false;
  }
  for (const part of value.parts) {
    if (part.parentKey !== null && (!keys.has(part.parentKey) || part.parentKey === part.key)) return false;
  }
  const staged = new Set<number>();
  for (const stage of value.stages) {
    if (!record(stage) || !Array.isArray(stage.partKeys) || stage.partKeys.length > MAX_PARTS) return false;
    for (const key of stage.partKeys) {
      if (!integer(key, 1) || !keys.has(key) || staged.has(key)) return false;
      staged.add(key);
    }
  }
  const nextKey = value.nextKey;
  if (!integer(nextKey, 1) || [...keys].some((key) => key >= nextKey)) return false;
  if (version >= 6) {
    if (!record(value.actionGroups) || Object.keys(value.actionGroups).length > 10) return false;
    for (const [rawGroup, assignments] of Object.entries(value.actionGroups)) {
      const group = Number(rawGroup);
      if (!integer(group, 1) || group > 10 || !Array.isArray(assignments) || assignments.length > MAX_PARTS) return false;
      for (const assignment of assignments) {
        if (!record(assignment) || !integer(assignment.partKey, 1) || !keys.has(assignment.partKey)) return false;
        if (!PART_ACTIONS.has(assignment.action)) return false;
      }
    }
  }
  return true;
}

function validRailsElements(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  return ['a', 'e', 'i', 'raan', 'argPe', 'meanAnomaly0', 'epoch', 'mu']
    .every((key) => finite(value[key]));
}

function validSurfacePose(value: unknown, bodyId: string): boolean {
  if (value === null) return true;
  if (!record(value) || value.bodyId !== bodyId) return false;
  return typeof value.recipeHash === 'string' && /^[a-f0-9]{32}$/.test(value.recipeHash)
    && typeof value.scatterRecipeHash === 'string' && /^[a-f0-9]{32}$/.test(value.scatterRecipeHash)
    && vector(value.directionBF) && quaternion(value.attitudeBF) && finite(value.contactOffset);
}

function validLedgerEntry(entry: unknown): entry is SavedLedgerEntry {
  if (!record(entry)) return false;
  return integer(entry.cap, 1)
    && integer(entry.deliveredByTransmit)
    && integer(entry.deliveredByRecovery)
    && entry.deliveredByTransmit + entry.deliveredByRecovery <= entry.cap;
}

function validBufferedResult(entry: unknown): entry is SavedBufferedResult {
  if (!record(entry)) return false;
  return integer(entry.siteCapAtCollection, 1)
    && integer(entry.heldValue, 1)
    && integer(entry.transmittedFromThis)
    && integer(entry.transmitTarget)
    && entry.transmittedFromThis <= entry.transmitTarget
    && entry.transmitTarget <= entry.heldValue;
}
