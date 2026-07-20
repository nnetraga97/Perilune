import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HOME_BODY_ID, SOL_SYSTEM } from '../src/content/system';
import { GameState } from '../src/sim/state';
import { createLegacyGameState } from './fixtures/legacyGameState';

describe('production and legacy system selection', () => {
  it('boots production GameState into exactly Sun, Earth, and Moon', () => {
    const game = new GameState();
    expect(game.universe.homeBodyId).toBe(HOME_BODY_ID);
    expect([...game.universe.bodies.keys()].sort()).toEqual(['earth', 'moon', 'sun']);
    expect(SOL_SYSTEM).toHaveLength(3);
  });

  it('requires explicit fixture construction for the compact system', () => {
    const game = createLegacyGameState();
    expect(game.universe.homeBodyId).toBe('veyra');
    expect(game.universe.bodies.size).toBe(12);
  });

  it('keeps production modules independent of the test fixture', async () => {
    const productionFiles = [
      '../src/content/system.ts',
      '../src/sim/state.ts',
      '../src/game.ts',
      '../src/save/schema.ts',
      '../src/save/persistence.ts',
    ];
    for (const file of productionFiles) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toContain('tests/fixtures');
      expect(source).not.toContain('legacyAurenSystem');
    }
  });
});
