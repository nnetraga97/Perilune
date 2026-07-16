import { sanitizeInterstageShroudSpec } from '../core/interstageShroud';
import type { SaveGame, SavedBufferedResult, SavedLedgerEntry } from './schema';

export const SAVE_VERSION = 9;

const ALARM_KINDS = new Set(['custom', 'transfer', 'maneuver', 'entry']);
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
        if (!Number.isInteger(group) || group < 1 || group > 10 || !Array.isArray(assignments)) return false;
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
