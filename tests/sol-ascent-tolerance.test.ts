import { describe, expect, it } from 'vitest';
import { createOdysseyOrbiter } from '../src/content/crafts';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { maxThrust } from '../src/sim/flight';
import { ascentGuidance } from '../src/sim/guidance';
import { GameState, PHYSICS_DT } from '../src/sim/state';

describe('forgiving Sol ascent envelope', () => {
  it('keeps Odyssey intact and thermally safe during a full-throttle Earth ascent', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnOnPad(createOdysseyOrbiter(), 'Odyssey Orbital Vehicle');
    const runtime = vessel.runtime;
    const earth = game.bodyOf(vessel);

    for (let frame = 0; frame < 100; frame++) game.update(PHYSICS_DT);
    runtime.controls.throttle = 1;
    expect(game.fireStage(vessel)).toBe(true);

    let peakQ = 0;
    let peakTemperature = 0;
    // The first two minutes cover the dense-atmosphere max-Q and ascent-heating corridor.
    // Stop before this intentionally unguided stress run exhausts every upper stage and falls back.
    for (let frame = 0; frame < 6_000; frame++) {
      game.update(PHYSICS_DT);
      if (!game.vessels.includes(vessel)) break;

      const command = ascentGuidance(runtime, earth);
      runtime.sas = 'custom';
      runtime.sasCustomDir.copy(command.dir);
      peakQ = Math.max(peakQ, runtime.aero.dynamicPressure);
      peakTemperature = Math.max(
        peakTemperature,
        ...runtime.craft.parts.map((part) => part.temperature ?? 280),
      );

      const altitude = runtime.pos.length() - earth.radius;
      if (runtime.currentStage === 1) {
        const boostersEmpty = runtime.craft.parts
          .filter((part) => part.defId === 'srb-torch')
          .every((part) => (part.resources.solidFuel ?? 0) <= 1e-6);
        if (boostersEmpty) game.fireStage(vessel);
      } else if (
        runtime.currentStage < runtime.craft.stages.length
        && altitude > 10_000
        && maxThrust(
          runtime,
          earth.pressureAt(altitude),
          game.flightTuning,
          earth.def.atmosphere?.seaLevelPressure,
        ) <= 1
      ) {
        game.fireStage(vessel);
      }
      if (altitude > 150_000) break;
    }

    expect(
      game.vessels.includes(vessel),
      `${game.lastDestruction?.reason ?? 'unknown loss'}; ${runtime.events.slice(-8).map((event) => event.text).join('; ')}`,
    ).toBe(true);
    expect(runtime.events.some((event) => event.text.includes('Structural failure'))).toBe(false);
    expect(runtime.events.some((event) => event.text.includes('destroyed by overheating'))).toBe(false);
    expect(peakQ).toBeGreaterThan(40_000);
    expect(peakQ).toBeLessThan(GAMEPLAY_PROFILES.sol.flightTuning.nominalMaxQPa);
    expect(peakTemperature).toBeLessThan(1_200);
  }, 30_000);
});
