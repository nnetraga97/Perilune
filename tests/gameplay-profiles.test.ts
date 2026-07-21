import { describe, expect, it } from 'vitest';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { createOdysseyOrbiter } from '../src/content/crafts';
import { GameState } from '../src/sim/state';
import { analyzeCraft } from '../src/sim/vessel';

describe('gameplay profiles', () => {
  it('constructs physically scaled Sol and session-only Legacy as separate sessions', () => {
    const sol = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const legacy = new GameState('sandbox', GAMEPLAY_PROFILES.legacy);

    expect(sol.systemId).toBe('sol');
    expect(sol.universe.homeBodyId).toBe('earth');
    expect(sol.persistence).toBe('enabled');
    expect(sol.universe.get('earth').radius).toBeGreaterThan(6_000_000);

    expect(legacy.systemId).toBe('legacy');
    expect(legacy.universe.homeBodyId).toBe('veyra');
    expect(legacy.persistence).toBe('session-only');
    expect(() => legacy.universe.get('earth')).toThrow();
  });

  it('makes Sol spacecraft substantially stronger without changing Legacy part data', () => {
    const craft = createOdysseyOrbiter();
    const legacy = analyzeCraft(craft, 9.80665, 0, GAMEPLAY_PROFILES.legacy.flightTuning);
    const sol = analyzeCraft(craft, 9.80665, 0, GAMEPLAY_PROFILES.sol.flightTuning);

    expect(sol.totalDeltaV).toBeCloseTo(legacy.totalDeltaV * 1.9, 6);
    expect(sol.stages[0].thrust).toBeCloseTo(legacy.stages[0].thrust * 1.6, 6);
    expect(sol.mass).toBe(legacy.mass);
    expect(GAMEPLAY_PROFILES.sol.flightTuning.nominalMaxQPa).toBe(150_000);
    expect(GAMEPLAY_PROFILES.sol.flightTuning.structuralStrengthMultiplier).toBe(6);
    expect(GAMEPLAY_PROFILES.sol.flightTuning.thermalLoadMultiplier).toBe(0.1);
    expect(GAMEPLAY_PROFILES.sol.flightTuning.attitudeControlMultiplier).toBe(40);
    expect(GAMEPLAY_PROFILES.sol.flightTuning.rcsThrustMultiplier).toBe(4);
    expect(GAMEPLAY_PROFILES.legacy.flightTuning.nominalMaxQPa).toBe(40_000);
  });
});
