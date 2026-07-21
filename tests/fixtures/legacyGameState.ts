import { LEGACY_AUREN_SYSTEM } from './legacyAurenSystem';
import { GameState } from '../../src/sim/state';
import type { GameMode } from '../../src/sim/campaign';
import { migrateSave, type SaveGame } from '../../src/save/schema';
import { restoreGame } from '../../src/save/persistence';
import { GAMEPLAY_PROFILES } from '../../src/content/gameplayProfiles';

export const LEGACY_GAME_STATE_OPTIONS = Object.freeze({
  ...GAMEPLAY_PROFILES.legacy,
});

/**
 * Explicit compact-system construction for pre-Sol gameplay regression coverage.
 * Production code must never import this test fixture.
 */
export function createLegacyGameState(mode: GameMode = 'sandbox'): GameState {
  return new GameState(mode, LEGACY_GAME_STATE_OPTIONS);
}

export function restoreLegacyGame(save: SaveGame): GameState {
  return restoreGame(save, LEGACY_GAME_STATE_OPTIONS);
}

export function migrateLegacySave(save: SaveGame): SaveGame {
  return migrateSave(save, LEGACY_AUREN_SYSTEM);
}
