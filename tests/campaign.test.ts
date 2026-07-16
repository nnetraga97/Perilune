import { describe, expect, it } from 'vitest';
import { PARTS, partById } from '../src/content/parts';
import {
  acceptContract,
  CONTRACTS,
  craftCost,
  createCampaign,
  isPartUnlocked,
  purchaseUpgrade,
  REPEATABLE_UPGRADES,
  settleContracts,
  TECHNOLOGIES,
  technologyForPart,
  unlockTechnology,
  upgradeCost,
} from '../src/sim/campaign';
import { GameState } from '../src/sim/state';
import { restoreGame, serializeGame } from '../src/save/persistence';
import { buildTwoStageRocket } from './vessel.test';

describe('campaign progression', () => {
  it('opens every part in Sandbox and gates advanced parts in progression modes', () => {
    const sandbox = createCampaign('sandbox');
    const exploration = createCampaign('exploration');

    expect(PARTS.every((part) => isPartUnlocked(sandbox, part))).toBe(true);
    expect(isPartUnlocked(exploration, partById('pod-voyager'))).toBe(true);
    expect(isPartUnlocked(exploration, partById('dock-port-s'))).toBe(false);
    expect(PARTS.every((part) => TECHNOLOGIES.some((technology) => technology.id === technologyForPart(part).id))).toBe(true);
  });

  it('spends recovered science and enforces technology prerequisites', () => {
    const campaign = createCampaign('exploration');

    const blocked = unlockTechnology(campaign, 200, 'exploration-instruments');
    expect(blocked).toMatchObject({ ok: false, sciencePoints: 200 });

    const orbital = unlockTechnology(campaign, 80, 'orbital-engineering');
    expect(orbital).toEqual({ ok: true, sciencePoints: 50 });
    expect(campaign.unlockedTech).toContain('orbital-engineering');

    const instruments = unlockTechnology(campaign, orbital.sciencePoints, 'exploration-instruments');
    expect(instruments).toEqual({ ok: true, sciencePoints: 5 });
  });

  it('charges craft from authoritative part prices', () => {
    const craft = buildTwoStageRocket();
    const expected = craft.parts.reduce((total, part) => total + partById(part.defId).cost, 0);
    expect(craftCost(craft)).toBe(expected);
    expect(craftCost(craft)).toBeGreaterThan(0);
  });

  it('persists repeatable upgrade levels and charges the authored growth curve', () => {
    const game = new GameState('exploration');
    game.campaign.unlockedTech.push('orbital-engineering', 'exploration-instruments', 'precision-science');
    game.sciencePoints = 500;
    const upgrade = REPEATABLE_UPGRADES.find((candidate) => candidate.id === 'field-methods')!;
    expect(upgradeCost(upgrade, 0)).toBe(60);
    expect(upgradeCost(upgrade, 1)).toBe(93);

    const first = purchaseUpgrade(game.campaign, game.sciencePoints, upgrade.id);
    expect(first).toEqual({ ok: true, sciencePoints: 440 });
    game.sciencePoints = first.sciencePoints;
    const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(game, 'upgrade'))));
    expect(restored.campaign.upgradeLevels['field-methods']).toBe(1);
    expect(restored.sciencePoints).toBe(440);
  });
});

describe('space program contracts', () => {
  it('rewards only accepted contracts whose achievement is recorded', () => {
    const campaign = createCampaign('program');
    const startingFunds = campaign.funds;
    const contract = CONTRACTS[0];

    expect(settleContracts(campaign, { [contract.achievement]: true })).toEqual([]);
    expect(acceptContract(campaign, contract.id)).toEqual({ ok: true });
    expect(settleContracts(campaign, { [contract.achievement]: true })).toEqual([contract]);
    expect(campaign.funds).toBe(startingFunds + contract.rewardFunds);
    expect(campaign.reputation).toBe(contract.rewardReputation);
    expect(campaign.completedContracts).toEqual([contract.id]);
    expect(campaign.activeContracts).toEqual([]);
  });

  it('persists mode, technology, funds, reputation, and contract state', () => {
    const game = new GameState('program');
    game.campaign.funds = 12_345;
    game.campaign.reputation = 7;
    game.campaign.unlockedTech.push('orbital-engineering');
    game.campaign.activeContracts.push('veyra-orbit');

    const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(game, 'program'))));
    expect(restored.campaign).toEqual(game.campaign);
  });
});
