import { describe, expect, it } from 'vitest';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { addPart, createCraft } from '../src/sim/vessel';
import { igniteManeuverEngines } from '../src/sim/flight';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { createOdysseyOrbiter } from '../src/content/crafts';

function maneuverCraft() {
  const craft = createCraft('Maneuver craft');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 1, z: 0 });
  const tank = addPart(craft, 'tank-s1', pod.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
  const engine = addPart(craft, 'eng-colt', tank.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
  for (let index = 0; index < 4; index++) {
    addPart(craft, 'rcs-quad', tank.key, 'surface', {
      x: index % 2 === 0 ? 0.6 : -0.6,
      y: 0,
      z: index < 2 ? 0.6 : -0.6,
    });
  }
  craft.stages = [{ partKeys: [engine.key] }];
  return { craft, pod, engine };
}

describe('Sol flight control authority', () => {
  it('lets the command pod and reaction wheels arrest a heavy coast spin without engine thrust', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(createOdysseyOrbiter(), 'Odyssey', 'earth', 200_000);
    vessel.runtime.angVel.set(0, 0, 0.5);
    vessel.runtime.sas = 'stability';
    vessel.runtime.controls.throttle = 0;

    for (let frame = 0; frame < 500; frame++) game.update(PHYSICS_DT);

    expect(Math.abs(vessel.runtime.angVel.z)).toBeLessThan(0.02);
  });

  it('automatically ignites an available throttleable maneuver engine without staging', () => {
    const { craft, engine } = maneuverCraft();
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(craft, craft.name, 'earth', 200_000);

    expect(engine.activated).not.toBe(true);
    expect(igniteManeuverEngines(vessel.runtime)).toEqual(['V-2 "Colt"']);
    expect(vessel.runtime.craft.parts.find((part) => part.key === engine.key)?.activated).toBe(true);
    expect(vessel.runtime.currentStage).toBe(0);
  });

  it('does not bypass a manual separation stage to reach its engine', () => {
    const { craft, engine } = maneuverCraft();
    const separator = addPart(craft, 'dec-s', null, 'root', { x: 0, y: -2, z: 0 });
    craft.stages = [{ partKeys: [separator.key, engine.key] }];
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(craft, craft.name, 'earth', 200_000);

    expect(igniteManeuverEngines(vessel.runtime)).toEqual([]);
    expect(vessel.runtime.craft.parts.find((part) => part.key === engine.key)?.activated).not.toBe(true);
  });

  it('uses monopropellant RCS for translation and all-axis attitude control even with an empty battery', () => {
    const { craft } = maneuverCraft();
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(craft, craft.name, 'earth', 200_000);
    const runtime = vessel.runtime;
    const monopropBefore = runtime.craft.parts.reduce((sum, part) => sum + (part.resources.monoprop ?? 0), 0);
    runtime.charge.amount = 0;
    runtime.controls.rcs = true;
    runtime.controls.translate.set(1, 0, 0);
    runtime.controls.roll = 1;

    for (let frame = 0; frame < 25; frame++) game.update(PHYSICS_DT);

    const monopropAfter = runtime.craft.parts.reduce((sum, part) => sum + (part.resources.monoprop ?? 0), 0);
    expect(runtime.properAccel).toBeGreaterThan(1);
    expect(Math.abs(runtime.angVel.y)).toBeGreaterThan(0.01);
    expect(monopropAfter).toBeLessThan(monopropBefore);
  });
});
