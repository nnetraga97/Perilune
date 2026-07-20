import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';

function buildProbe() {
  const craft = createCraft('Probe');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'batt-s', core.key, 'surface', { x: 0.3, y: 0, z: 0 });
  return craft;
}

describe('mission alarms', () => {
  it('orders alarms and clips rails warp at the first boundary', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
    game.addAlarm(8_000, 'later', 'custom');
    const first = game.addAlarm(5_000, 'first', 'custom');

    expect(game.alarms.map((alarm) => alarm.id)).toEqual([first.id, expect.any(String)]);

    game.setWarp(4, true);
    game.update(10);

    expect(game.time).toBe(5_000);
    expect(game.warpIndex).toBe(0);
    expect(game.railsWarp).toBe(false);
    expect(game.alarms.map((alarm) => alarm.label)).toEqual(['later']);
  });

  it('fires a due alarm during fixed-step physics warp', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
    game.addAlarm(3, 'soon', 'custom');
    game.setWarp(2, false);

    for (let i = 0; i < 400 && game.warpIndex !== 0; i++) game.update(PHYSICS_DT);

    expect(game.time).toBeGreaterThanOrEqual(3);
    expect(game.time).toBeLessThan(3 + PHYSICS_DT + 1e-9);
    expect(game.warpIndex).toBe(0);
    expect(game.alarms).toHaveLength(0);
  });

  it('removes alarms by stable id and rejects invalid alarm data', () => {
    const game = createLegacyGameState();
    const alarm = game.addAlarm(10, 'maneuver', 'maneuver');

    expect(game.removeAlarm(alarm.id)).toBe(true);
    expect(game.removeAlarm(alarm.id)).toBe(false);
    expect(game.alarms).toHaveLength(0);
    expect(() => game.addAlarm(0, 'past', 'custom')).toThrow('future');
    expect(() => game.addAlarm(10, '   ', 'custom')).toThrow('label');
  });
});
