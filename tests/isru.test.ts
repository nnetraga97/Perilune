import { describe, expect, it } from 'vitest';
import { addPart, createCraft } from '../src/sim/vessel';
import { createLegacyGameState } from './fixtures/legacyGameState';
import { GameState } from '../src/sim/state';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';

function scannerCraft() {
  const craft = createCraft('Surveyor');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'scan-prospector', core.key, 'stack-bottom', { x: 0, y: -0.35, z: 0 });
  return craft;
}

describe('resource gameplay is unavailable', () => {
  it('refuses surveying in Sol even when scanner hardware is present', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(scannerCraft(), 'Surveyor', 'earth', 200_000);
    expect(game.performScan(vessel)).toEqual({
      ok: false,
      reason: 'Resource surveying and ISRU are not available.',
    });
    expect(game.scannedBodies.size).toBe(0);
  });

  it('refuses surveying in Legacy too', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnInOrbit(scannerCraft(), 'Surveyor', 'veyra', 120_000);
    expect(game.performScan(vessel).ok).toBe(false);
    expect(game.scannedBodies.size).toBe(0);
  });
});
