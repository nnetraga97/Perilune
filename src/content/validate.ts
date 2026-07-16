import { EXPERIMENTS, experimentCap, scienceBiomesForSituation } from './science';
import { PARTS } from './parts';
import { AUREN_SYSTEM, HOME_BODY_ID } from './system';
import { TECHNOLOGIES } from '../sim/campaign';
import type { BodyDef } from '../sim/universe';

export const SCIENCE_BUDGET_TARGETS = {
  worldMin: 400,
  worldMax: 2_000,
  systemMin: 9_000,
  systemMax: 15_000,
  homeShareMin: 0.02,
  homeShareMax: 0.08,
} as const;

export function scienceBudgetForBody(body: BodyDef): number {
  let total = 0;
  for (const experiment of EXPERIMENTS) {
    if (experiment.needsAtmosphere && !body.atmosphere) continue;
    for (const situation of experiment.validSituations) {
      for (const biome of scienceBiomesForSituation(body, situation)) {
        total += experimentCap(experiment, body.scienceValue, biome.scienceMultiplier);
      }
    }
  }
  return total;
}

export function validateGameContent(): string[] {
  const errors: string[] = [];
  const knownTech = new Set(TECHNOLOGIES.map((technology) => technology.id));
  for (const part of PARTS) {
    if (!part.tech || !knownTech.has(part.tech)) errors.push(`Part ${part.id} has unknown technology ${part.tech ?? '(missing)'}`);
  }
  for (const experiment of EXPERIMENTS) {
    if (!Number.isFinite(experiment.transmitFraction) || experiment.transmitFraction < 0 || experiment.transmitFraction > 1) {
      errors.push(`Experiment ${experiment.id} transmitFraction must be within [0, 1]`);
    }
  }

  for (const body of AUREN_SYSTEM) {
    if (!body.biomes) continue;
    const ids = new Set<string>();
    for (const biome of body.biomes) {
      if (ids.has(biome.id)) errors.push(`Body ${body.id} has duplicate science biome ${biome.id}`);
      ids.add(biome.id);
      if (!Number.isFinite(biome.scienceMultiplier) || biome.scienceMultiplier <= 0) {
        errors.push(`Body ${body.id} biome ${biome.id} must have a finite positive multiplier`);
      }
    }
    const globals = body.biomes.filter((biome) => biome.id === 'global');
    if (globals.length !== 1 || globals[0]?.scienceMultiplier !== 1) {
      errors.push(`Body ${body.id} must define exactly one global science biome with multiplier 1`);
    }
    if (body.surfaceKind === 'gas' && !ids.has('upper-atmosphere')) {
      errors.push(`Gas body ${body.id} must define upper-atmosphere`);
    }
    if (body.surfaceKind === 'solid' && !ids.has('lowland')) {
      errors.push(`Solid body ${body.id} with authored biomes must define lowland`);
    }
    if (body.terrain.oceanLevel > 0 && !ids.has('ocean')) {
      errors.push(`Ocean body ${body.id} must define ocean`);
    }
    const thresholds = body.scienceBiomeThresholds;
    if (thresholds?.iceLatitudeMin !== undefined && !ids.has('ice-cap')) errors.push(`Body ${body.id} enables ice-cap without defining it`);
    if (thresholds?.mountainSlopeMinDeg !== undefined && !ids.has('mountains')) errors.push(`Body ${body.id} enables mountains without defining it`);
    if (thresholds?.highlandAltitudeMin !== undefined && !ids.has('highland')) errors.push(`Body ${body.id} enables highland without defining it`);
  }

  const worlds = AUREN_SYSTEM.filter((body) => !body.isStar);
  const budgets = worlds.map((body) => ({ body, value: scienceBudgetForBody(body) }));
  for (const { body, value } of budgets) {
    if (value < SCIENCE_BUDGET_TARGETS.worldMin || value > SCIENCE_BUDGET_TARGETS.worldMax) {
      errors.push(`Body ${body.id} science budget ${value} is outside ${SCIENCE_BUDGET_TARGETS.worldMin}-${SCIENCE_BUDGET_TARGETS.worldMax}`);
    }
  }
  const systemBudget = budgets.reduce((total, budget) => total + budget.value, 0);
  if (systemBudget < SCIENCE_BUDGET_TARGETS.systemMin || systemBudget > SCIENCE_BUDGET_TARGETS.systemMax) {
    errors.push(`System science budget ${systemBudget} is outside ${SCIENCE_BUDGET_TARGETS.systemMin}-${SCIENCE_BUDGET_TARGETS.systemMax}`);
  }
  const homeBudget = budgets.find(({ body }) => body.id === HOME_BODY_ID)?.value ?? 0;
  const homeShare = systemBudget > 0 ? homeBudget / systemBudget : 0;
  if (homeShare < SCIENCE_BUDGET_TARGETS.homeShareMin || homeShare > SCIENCE_BUDGET_TARGETS.homeShareMax) {
    errors.push(`Home-world science share ${(homeShare * 100).toFixed(1)}% is outside ${(SCIENCE_BUDGET_TARGETS.homeShareMin * 100).toFixed(0)}-${(SCIENCE_BUDGET_TARGETS.homeShareMax * 100).toFixed(0)}%`);
  }
  const fixedTreeCost = TECHNOLOGIES.reduce((total, technology) => total + technology.scienceCost, 0);
  if (homeBudget >= fixedTreeCost) {
    errors.push(`Home-world science budget ${homeBudget} must remain below fixed-tree cost ${fixedTreeCost}`);
  }
  return errors;
}
