import { describe, expect, it } from 'vitest';
import { AUREN_SYSTEM, HOME_BODY_ID } from '../src/content/system';
import {
  SCIENCE_BUDGET_TARGETS,
  scienceBudgetForBody,
  validateGameContent,
} from '../src/content/validate';
import { TECHNOLOGIES } from '../src/sim/campaign';

describe('gameplay content validation', () => {
  it('accepts the authored tech, biome, transmission, and economy contracts', () => {
    expect(validateGameContent()).toEqual([]);
  });

  it('keeps the home world below the fixed tree and inside its target system share', () => {
    const worlds = AUREN_SYSTEM.filter((body) => !body.isStar);
    const budgets = worlds.map((body) => scienceBudgetForBody(body));
    const homeBudget = scienceBudgetForBody(AUREN_SYSTEM.find((body) => body.id === HOME_BODY_ID)!);
    const systemBudget = budgets.reduce((total, value) => total + value, 0);
    const fixedTreeCost = TECHNOLOGIES.reduce((total, technology) => total + technology.scienceCost, 0);

    expect(homeBudget).toBeLessThan(fixedTreeCost);
    expect(homeBudget / systemBudget).toBeGreaterThanOrEqual(SCIENCE_BUDGET_TARGETS.homeShareMin);
    expect(homeBudget / systemBudget).toBeLessThanOrEqual(SCIENCE_BUDGET_TARGETS.homeShareMax);
  });
});
