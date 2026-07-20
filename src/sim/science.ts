import { Vec3 } from '../core/vec3';
import {
  EXPERIMENT_INDEX,
  experimentCap,
  scienceSituation,
  type ExperimentDef,
  type ScienceSituation,
} from '../content/science';
import { evaluateComms, type CommsStatus } from './comms';
import { inertialToBodyFixed } from './bodyOrientation';
import { isOcean, solidHeight, surfaceSlopeDegrees } from './terrain';
import type { Body, ScienceBiomeDef, Universe } from './universe';
import { defOf } from './vessel';
import type { GameState, GameVessel } from './state';

export type ScienceKeyId = string;

export interface ScienceKey {
  experimentId: string;
  bodyId: string;
  biomeId: string;
  situation: ScienceSituation;
}

export interface LedgerEntry {
  cap: number;
  deliveredByTransmit: number;
  deliveredByRecovery: number;
}

export interface BufferedResult {
  siteCapAtCollection: number;
  heldValue: number;
  transmittedFromThis: number;
  transmitTarget: number;
}

export interface ScienceSite {
  body: Body;
  biome: ScienceBiomeDef;
  situation: ScienceSituation;
  bodyFixedDirection: Vec3;
}

export interface SciencePreviewResult {
  key: ScienceKey;
  keyId: ScienceKeyId;
  experiment: ExperimentDef;
  cap: number;
  delivered: number;
  remaining: number;
  collectValue: number;
  transmitValue: number;
}

export interface SciencePreview {
  site: ScienceSite | null;
  results: SciencePreviewResult[];
  totalCollectValue: number;
}

export interface CollectOutcome {
  site: ScienceSite | null;
  collected: SciencePreviewResult[];
  totalHeld: number;
}

export interface DeliveryResult {
  keyId: ScienceKeyId;
  key: ScienceKey;
  delivered: number;
  remainingCap: number;
}

export interface TransmitOutcome {
  accepted: boolean;
  rejected?: 'no-link';
  link: CommsStatus;
  delivered: number;
  results: DeliveryResult[];
}

export interface RecoverOutcome {
  accepted: boolean;
  rejected?: 'not-recoverable';
  deliveredByRecovery: number;
  results: DeliveryResult[];
}

export const COLLECT_FRACTION = 0.6;

const SCIENCE_SITUATIONS = new Set<ScienceSituation>([
  'surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high',
]);

const _bodyFixed = new Vec3();

export function encodeScienceKey(key: Readonly<ScienceKey>): ScienceKeyId {
  return JSON.stringify([key.experimentId, key.bodyId, key.biomeId, key.situation]);
}

export function decodeScienceKey(id: ScienceKeyId): ScienceKey | null {
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((value) => typeof value !== 'string')) return null;
    const [experimentId, bodyId, biomeId, situation] = parsed as string[];
    if (!SCIENCE_SITUATIONS.has(situation as ScienceSituation)) return null;
    return { experimentId, bodyId, biomeId, situation: situation as ScienceSituation };
  } catch {
    return null;
  }
}

export function deliveredScience(entry: Readonly<LedgerEntry> | undefined): number {
  return entry ? entry.deliveredByTransmit + entry.deliveredByRecovery : 0;
}

export function collectFraction(level: number): number {
  return 1 - (1 - COLLECT_FRACTION) * 0.9 ** Math.max(0, level);
}

export function sampleTransmitFraction(base: number, level: number): number {
  if (base <= 0) return 0;
  return Math.min(1, 1 - (1 - base) * 0.92 ** Math.max(0, level));
}

export function globalBiome(body: Body): ScienceBiomeDef {
  return body.def.biomes?.find((biome) => biome.id === 'global') ?? {
    id: 'global',
    name: 'Global',
    scienceMultiplier: 1,
  };
}

function authoredBiome(body: Body, id: string): ScienceBiomeDef | null {
  return body.def.biomes?.find((biome) => biome.id === id) ?? null;
}

/** Deterministic geometric science-biome classifier with fixed branch precedence. */
export function biomeAt(body: Body, direction: Readonly<Vec3>): ScienceBiomeDef {
  const global = globalBiome(body);
  if (!body.def.biomes?.length) return global;
  if (body.def.surfaceKind === 'gas') return authoredBiome(body, 'upper-atmosphere') ?? global;
  if (body.def.surfaceKind !== 'solid') return global;

  const dir = new Vec3(direction.x, direction.y, direction.z).normalize();
  if (isOcean(body, dir)) return authoredBiome(body, 'ocean') ?? global;
  const thresholds = body.def.scienceBiomeThresholds;
  if (thresholds?.iceLatitudeMin !== undefined && Math.abs(dir.z) >= thresholds.iceLatitudeMin) {
    return authoredBiome(body, 'ice-cap') ?? global;
  }
  if (
    thresholds?.mountainSlopeMinDeg !== undefined
    && surfaceSlopeDegrees(body, dir) >= thresholds.mountainSlopeMinDeg
  ) {
    return authoredBiome(body, 'mountains') ?? global;
  }
  const surface = solidHeight(body, dir);
  if (
    thresholds?.highlandAltitudeMin !== undefined
    && surface.kind === 'solid'
    && surface.height >= thresholds.highlandAltitudeMin
  ) {
    return authoredBiome(body, 'highland') ?? global;
  }
  return authoredBiome(body, 'lowland') ?? global;
}

export function resolveScienceSite(game: GameState, vessel: GameVessel): ScienceSite | null {
  const runtime = vessel.runtime;
  const body = game.bodyOf(vessel);
  const altitude = runtime.pos.length() - body.radius;
  const situation = scienceSituation(
    runtime.situation,
    altitude,
    body.radius,
    body.def.atmosphere?.height ?? 0,
  );
  if (!situation) return null;
  const direction = runtime.landedBodyFixed
    ? _bodyFixed.copy(runtime.landedBodyFixed).normalize()
    : inertialToBodyFixed(body, game.time, runtime.pos, _bodyFixed).normalize();
  const biome = situation === 'surface' || situation === 'ocean' || situation === 'flying-low'
    ? biomeAt(body, direction)
    : globalBiome(body);
  return { body, biome, situation, bodyFixedDirection: direction.clone() };
}

function siteCap(game: GameState, keyId: ScienceKeyId, experiment: ExperimentDef, site: ScienceSite): number {
  return game.scienceLedger.get(keyId)?.cap
    ?? experimentCap(experiment, site.body.def.scienceValue, site.biome.scienceMultiplier);
}

function uniqueExperiments(vessel: GameVessel): ExperimentDef[] {
  const ids = new Set<string>();
  const experiments: ExperimentDef[] = [];
  for (const part of vessel.runtime.craft.parts) {
    const science = defOf(part).science;
    if (!science || ids.has(science.experimentId)) continue;
    ids.add(science.experimentId);
    const experiment = EXPERIMENT_INDEX.get(science.experimentId);
    if (experiment) experiments.push(experiment);
  }
  return experiments;
}

export function availableHere(game: GameState, vessel: GameVessel): SciencePreview {
  const site = resolveScienceSite(game, vessel);
  if (!site) return { site: null, results: [], totalCollectValue: 0 };
  const fieldLevel = game.campaign.upgradeLevels['field-methods'] ?? 0;
  const downlinkLevel = game.campaign.upgradeLevels['downlink-coding'] ?? 0;
  const results: SciencePreviewResult[] = [];

  for (const experiment of uniqueExperiments(vessel)) {
    if (!experiment.validSituations.includes(site.situation)) continue;
    if (experiment.needsAtmosphere && !site.body.hasAtmosphere()) continue;
    const key: ScienceKey = {
      experimentId: experiment.id,
      bodyId: site.body.id,
      biomeId: site.biome.id,
      situation: site.situation,
    };
    const keyId = encodeScienceKey(key);
    if (vessel.runtime.scienceBuffer.has(keyId)) continue;
    const cap = siteCap(game, keyId, experiment, site);
    const delivered = deliveredScience(game.scienceLedger.get(keyId));
    const remaining = Math.max(0, cap - delivered);
    if (remaining === 0) continue;
    const collectValue = Math.min(remaining, Math.max(1, Math.round(remaining * collectFraction(fieldLevel))));
    const transmitValue = Math.round(
      collectValue * sampleTransmitFraction(experiment.transmitFraction, downlinkLevel),
    );
    results.push({ key, keyId, experiment, cap, delivered, remaining, collectValue, transmitValue });
  }
  return {
    site,
    results,
    totalCollectValue: results.reduce((total, result) => total + result.collectValue, 0),
  };
}

export function collectScience(game: GameState, vessel: GameVessel): CollectOutcome {
  const preview = availableHere(game, vessel);
  for (const result of preview.results) {
    vessel.runtime.scienceBuffer.set(result.keyId, {
      siteCapAtCollection: result.cap,
      heldValue: result.collectValue,
      transmittedFromThis: 0,
      transmitTarget: result.transmitValue,
    });
  }
  return { site: preview.site, collected: preview.results, totalHeld: preview.totalCollectValue };
}

/**
 * Collect everything valid here the first time a vessel reaches a given site.
 *
 * Returns null when there is nothing to do, so the caller only announces a real
 * collection. Gating on the site rather than on buffer contents keeps a vessel
 * from immediately re-collecting the recoverable remainder after a transmit.
 */
export function autoCollectScience(game: GameState, vessel: GameVessel): CollectOutcome | null {
  const preview = availableHere(game, vessel);
  if (!preview.site) return null;
  const signature = `${preview.site.body.id}:${preview.site.situation}:${preview.site.biome.id}`;
  if (game.autoScienceSites.get(vessel.runtime.id) === signature) return null;
  game.autoScienceSites.set(vessel.runtime.id, signature);
  if (preview.results.length === 0) return null;
  return collectScience(game, vessel);
}

function ledgerForDelivery(game: GameState, keyId: ScienceKeyId, buffered: BufferedResult): LedgerEntry {
  const existing = game.scienceLedger.get(keyId);
  if (existing) return existing;
  const created: LedgerEntry = {
    cap: Math.max(1, Math.round(buffered.siteCapAtCollection)),
    deliveredByTransmit: 0,
    deliveredByRecovery: 0,
  };
  game.scienceLedger.set(keyId, created);
  return created;
}

export function transmitScience(game: GameState, vessel: GameVessel): TransmitOutcome {
  const link = evaluateComms(game, vessel);
  if (!link.connected) return { accepted: false, rejected: 'no-link', link, delivered: 0, results: [] };
  const results: DeliveryResult[] = [];
  let total = 0;
  for (const [keyId, buffered] of [...vessel.runtime.scienceBuffer]) {
    const key = decodeScienceKey(keyId);
    if (!key) continue;
    const ledger = ledgerForDelivery(game, keyId, buffered);
    const remaining = Math.max(0, ledger.cap - deliveredScience(ledger));
    const entitlement = Math.max(0, buffered.transmitTarget - buffered.transmittedFromThis);
    const actual = Math.min(entitlement, remaining);
    if (actual > 0) {
      ledger.deliveredByTransmit += actual;
      buffered.transmittedFromThis += actual;
      total += actual;
    }
    const remainingCap = Math.max(0, ledger.cap - deliveredScience(ledger));
    if (buffered.transmittedFromThis >= buffered.heldValue || remainingCap === 0) {
      vessel.runtime.scienceBuffer.delete(keyId);
    }
    results.push({ keyId, key, delivered: actual, remainingCap });
  }
  game.sciencePoints += total;
  return { accepted: true, link, delivered: total, results };
}

export function isRecoverable(vessel: GameVessel, universe: Universe): boolean {
  return !vessel.runtime.isDebris
    && vessel.runtime.bodyId === universe.homeBodyId
    && ['landed', 'splashed', 'prelaunch'].includes(vessel.runtime.situation);
}

export function recoverScience(game: GameState, vessel: GameVessel): RecoverOutcome {
  if (!isRecoverable(vessel, game.universe)) {
    return { accepted: false, rejected: 'not-recoverable', deliveredByRecovery: 0, results: [] };
  }
  const results: DeliveryResult[] = [];
  let total = 0;
  for (const [keyId, buffered] of vessel.runtime.scienceBuffer) {
    const key = decodeScienceKey(keyId);
    if (!key) continue;
    const ledger = ledgerForDelivery(game, keyId, buffered);
    const remaining = Math.max(0, ledger.cap - deliveredScience(ledger));
    const deliverable = Math.max(0, buffered.heldValue - buffered.transmittedFromThis);
    const actual = Math.min(deliverable, remaining);
    if (actual > 0) {
      ledger.deliveredByRecovery += actual;
      total += actual;
    }
    results.push({
      keyId,
      key,
      delivered: actual,
      remainingCap: Math.max(0, ledger.cap - deliveredScience(ledger)),
    });
  }
  vessel.runtime.scienceBuffer.clear();
  game.sciencePoints += total;
  return { accepted: true, deliveredByRecovery: total, results };
}

export function aboardScienceValue(game: GameState): number {
  let total = 0;
  for (const vessel of game.vessels) {
    for (const [keyId, buffered] of vessel.runtime.scienceBuffer) {
      const ledger = game.scienceLedger.get(keyId);
      const remainingCap = ledger ? Math.max(0, ledger.cap - deliveredScience(ledger)) : buffered.siteCapAtCollection;
      total += Math.min(Math.max(0, buffered.heldValue - buffered.transmittedFromThis), remainingCap);
    }
  }
  return total;
}
