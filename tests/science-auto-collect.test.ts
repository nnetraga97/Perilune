import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';
import { autoCollectScience, transmitScience } from '../src/sim/science';
import { createLegacyGameState } from './fixtures/legacyGameState';

/** Veyra's radius is 1e6 m and space-low ends at half a radius. */
const SPACE_LOW_ALTITUDE = 120_000;
const SPACE_HIGH_ALTITUDE = 800_000;

function surveyProbe() {
  const craft = createCraft('survey probe');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'sci-survey', pod.key, 'surface', { x: 0.4, y: 0, z: 0 });
  craft.stages = [];
  return craft;
}

function spawn(game: GameState, altitude = SPACE_LOW_ALTITUDE) {
  return game.spawnInOrbit(surveyProbe(), 'survey probe', 'veyra', altitude);
}

function moveTo(gv: ReturnType<GameState['spawnInOrbit']>, altitude: number): void {
  const radius = 1_000_000 + altitude;
  gv.runtime.pos.set(radius, 0, 0);
}

describe('automatic science collection', () => {
  it('collects on arriving at a new site without a manual press', () => {
    const game = createLegacyGameState();
    const gv = spawn(game);

    const outcome = autoCollectScience(game, gv);

    expect(outcome).not.toBeNull();
    expect(outcome!.collected.length).toBeGreaterThan(0);
    expect(gv.runtime.scienceBuffer.size).toBeGreaterThan(0);
  });

  it('reports the site so the caller can still show a popup', () => {
    const game = createLegacyGameState();
    const gv = spawn(game);

    const outcome = autoCollectScience(game, gv);

    expect(outcome!.site).not.toBeNull();
    expect(outcome!.site!.situation).toBe('space-low');
    expect(outcome!.totalHeld).toBeGreaterThan(0);
  });

  it('does not fire again while parked at the same site', () => {
    const game = createLegacyGameState();
    const gv = spawn(game);
    expect(autoCollectScience(game, gv)).not.toBeNull();

    expect(autoCollectScience(game, gv)).toBeNull();
    expect(autoCollectScience(game, gv)).toBeNull();
  });

  it('fires again when the situation genuinely changes', () => {
    const game = createLegacyGameState();
    const gv = spawn(game);
    expect(autoCollectScience(game, gv)).not.toBeNull();

    moveTo(gv, SPACE_HIGH_ALTITUDE);
    const higher = autoCollectScience(game, gv);

    expect(higher).not.toBeNull();
    expect(higher!.site!.situation).toBe('space-high');
    expect(gv.runtime.scienceBuffer.size).toBe(2);
  });

  it('does not re-collect at the same site after transmitting', () => {
    const game = createLegacyGameState();
    const gv = spawn(game);
    autoCollectScience(game, gv);
    transmitScience(game, gv);

    expect(autoCollectScience(game, gv)).toBeNull();
  });

  it('tracks sites per vessel rather than globally', () => {
    const game = createLegacyGameState();
    const first = spawn(game);
    const second = spawn(game);

    expect(autoCollectScience(game, first)).not.toBeNull();
    expect(autoCollectScience(game, second)).not.toBeNull();
  });

  it('returns null when the craft carries no valid experiment here', () => {
    const game = createLegacyGameState();
    const craft = createCraft('bare pod');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    craft.stages = [];
    const gv = game.spawnInOrbit(craft, 'bare pod', 'veyra', SPACE_LOW_ALTITUDE);

    expect(autoCollectScience(game, gv)).toBeNull();
  });
});
