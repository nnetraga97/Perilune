import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { addPart, createCraft, type Craft } from '../src/sim/vessel';
import { GameState } from '../src/sim/state';
import {
  aboardScienceValue,
  availableHere,
  collectScience,
  deliveredScience,
  encodeScienceKey,
  isRecoverable,
  recoverScience,
  transmitScience,
} from '../src/sim/science';

function scienceCraft(withAntenna = true): Craft {
  const craft = createCraft('Science craft');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'sci-thermo', pod.key, 'surface', { x: 0.3, y: 0, z: 0 });
  addPart(craft, 'sci-spore', pod.key, 'surface', { x: -0.3, y: 0, z: 0 });
  addPart(craft, 'sci-fieldkit', pod.key, 'surface', { x: 0, y: 0, z: 0.3 });
  if (withAntenna) addPart(craft, 'ant-whip', pod.key, 'surface', { x: 0, y: 0, z: -0.3 });
  return craft;
}

describe('science collection and delivery', () => {
  it('collects once, transmits through comms, and recovers only the undelivered remainder', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(scienceCraft(), 'Field mission');
    const preview = availableHere(game, vessel);
    expect(preview.results.length).toBeGreaterThanOrEqual(2);
    expect(preview.results.every((result) => Number.isInteger(result.collectValue))).toBe(true);

    const collected = collectScience(game, vessel);
    expect(collected.totalHeld).toBe(preview.totalCollectValue);
    expect(collectScience(game, vessel).collected).toEqual([]);

    vessel.runtime.situation = 'orbit';
    vessel.runtime.pos.set(game.universe.get('veyra').radius + 200_000, 0, 0);
    const expectedTransmit = [...vessel.runtime.scienceBuffer.values()]
      .reduce((total, result) => total + result.transmitTarget, 0);
    const transmitted = transmitScience(game, vessel);
    expect(transmitted.accepted).toBe(true);
    expect(transmitted.delivered).toBe(expectedTransmit);
    expect(game.sciencePoints).toBe(transmitted.delivered);
    expect(transmitScience(game, vessel)).toMatchObject({ accepted: true, delivered: 0 });

    vessel.runtime.situation = 'landed';
    const recovered = recoverScience(game, vessel);
    expect(recovered.accepted).toBe(true);
    expect(vessel.runtime.scienceBuffer.size).toBe(0);
    expect(game.sciencePoints).toBe(transmitted.delivered + recovered.deliveredByRecovery);
    for (const entry of game.scienceLedger.values()) {
      expect(deliveredScience(entry)).toBeLessThanOrEqual(entry.cap);
    }

    expect(recoverScience(game, vessel)).toMatchObject({ accepted: true, deliveredByRecovery: 0 });
  });

  it('rejects recovery away from home without mutating any science state', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnInOrbit(scienceCraft(), 'Away mission', 'palla', 30_000);
    const key = encodeScienceKey({
      experimentId: 'surface-sample', bodyId: 'palla', biomeId: 'lowland', situation: 'surface',
    });
    vessel.runtime.scienceBuffer.set(key, {
      siteCapAtCollection: 20, heldValue: 12, transmittedFromThis: 0, transmitTarget: 0,
    });
    game.sciencePoints = 4;
    const before = JSON.stringify({
      points: game.sciencePoints,
      ledger: [...game.scienceLedger],
      buffer: [...vessel.runtime.scienceBuffer],
      vessels: game.vessels.length,
    });

    expect(recoverScience(game, vessel)).toMatchObject({ accepted: false, rejected: 'not-recoverable' });
    expect(JSON.stringify({
      points: game.sciencePoints,
      ledger: [...game.scienceLedger],
      buffer: [...vessel.runtime.scienceBuffer],
      vessels: game.vessels.length,
    })).toBe(before);
  });

  it('clamps competing vessel deliveries to one site cap', () => {
    const game = createLegacyGameState();
    const first = game.spawnInOrbit(scienceCraft(), 'First', 'veyra', 200_000);
    const second = game.spawnInOrbit(scienceCraft(), 'Second', 'veyra', 200_000);
    const key = encodeScienceKey({
      experimentId: 'thermal-scan', bodyId: 'veyra', biomeId: 'global', situation: 'space-low',
    });
    const buffered = { siteCapAtCollection: 10, heldValue: 6, transmittedFromThis: 0, transmitTarget: 6 };
    first.runtime.scienceBuffer.set(key, { ...buffered });
    second.runtime.scienceBuffer.set(key, { ...buffered });

    expect(transmitScience(game, first).delivered).toBe(6);
    expect(transmitScience(game, second).delivered).toBe(4);
    expect(game.sciencePoints).toBe(10);
    expect(deliveredScience(game.scienceLedger.get(key))).toBe(10);
  });

  it('requires the existing comms authority and leaves buffers untouched without a link', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnInOrbit(scienceCraft(false), 'Mute lab', 'veyra', 200_000);
    const key = encodeScienceKey({
      experimentId: 'thermal-scan', bodyId: 'veyra', biomeId: 'global', situation: 'space-low',
    });
    vessel.runtime.scienceBuffer.set(key, {
      siteCapAtCollection: 8, heldValue: 5, transmittedFromThis: 0, transmitTarget: 5,
    });

    expect(transmitScience(game, vessel)).toMatchObject({ accepted: false, rejected: 'no-link', delivered: 0 });
    expect(game.sciencePoints).toBe(0);
    expect(game.scienceLedger.size).toBe(0);
    expect(vessel.runtime.scienceBuffer.get(key)?.heldValue).toBe(5);
  });

  it('applies upgrade levels only to future collection snapshots', () => {
    const game = createLegacyGameState('exploration');
    const first = game.spawnOnPad(scienceCraft(), 'Before upgrades');
    collectScience(game, first);
    const firstSpore = [...first.runtime.scienceBuffer].find(([keyId]) => keyId.includes('spore-exposure'));
    expect(firstSpore).toBeDefined();
    const frozen = { ...firstSpore![1] };

    game.campaign.upgradeLevels['field-methods'] = 5;
    game.campaign.upgradeLevels['downlink-coding'] = 5;
    expect(first.runtime.scienceBuffer.get(firstSpore![0])).toEqual(frozen);

    const second = game.spawnOnPad(scienceCraft(), 'After upgrades');
    collectScience(game, second);
    const secondSpore = [...second.runtime.scienceBuffer].find(([keyId]) => keyId.includes('spore-exposure'))![1];
    expect(secondSpore.heldValue).toBeGreaterThanOrEqual(frozen.heldValue);
    expect(secondSpore.transmitTarget).toBeGreaterThan(frozen.transmitTarget);
  });

  it('loses only the destroyed vessel buffer and leaves the global ledger untouched', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(scienceCraft(), 'Disposable lab');
    collectScience(game, vessel);
    expect(aboardScienceValue(game)).toBeGreaterThan(0);
    expect(game.scienceLedger.size).toBe(0);

    game.vessels = game.vessels.filter((candidate) => candidate !== vessel);
    expect(aboardScienceValue(game)).toBe(0);
    expect(game.scienceLedger.size).toBe(0);
  });
});

describe('recovery authority', () => {
  it('covers home, situation, and debris combinations from one predicate', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(scienceCraft(), 'Recovery truth table');
    for (const situation of ['landed', 'splashed', 'prelaunch'] as const) {
      vessel.runtime.situation = situation;
      vessel.runtime.bodyId = game.universe.homeBodyId;
      vessel.runtime.isDebris = false;
      expect(isRecoverable(vessel, game.universe)).toBe(true);
      vessel.runtime.isDebris = true;
      expect(isRecoverable(vessel, game.universe)).toBe(false);
    }
    vessel.runtime.isDebris = false;
    vessel.runtime.situation = 'flying';
    expect(isRecoverable(vessel, game.universe)).toBe(false);
    vessel.runtime.situation = 'landed';
    vessel.runtime.bodyId = 'palla';
    expect(isRecoverable(vessel, game.universe)).toBe(false);
  });
});
