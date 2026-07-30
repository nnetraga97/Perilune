import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_CRAFTS,
  createFirstLightRocket,
  createOdysseyOrbiter,
  createSecondLightCraft,
  createStarshipConceptDisplayCraft,
  createWayfarerDemonstrator,
} from '../src/content/crafts';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { partById } from '../src/content/parts';
import { validateCraftFile } from '../src/save/persistence';
import { deriveInterstageShroud } from '../src/sim/interstage';
import { analyzeCraft, buildAutoStages, craftAxialVisualBounds } from '../src/sim/vessel';
import { evaluateStructure } from '../src/sim/structure';
import { Vec3 } from '../src/core/vec3';
import { apoapsisOf, elementsAtTime, periapsisOf, stateToElements } from '../src/core/orbit';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { ascentGuidance } from '../src/sim/guidance';
import { maxThrust } from '../src/sim/flight';
import { planMoonCourseCorrection, planTransfer } from '../src/sim/transfer';
import { estimateBurnTime, nodeBurnVector, orbitAfterNode, predictTrajectory } from '../src/sim/maneuver';

describe('built-in craft library', () => {
  it('offers the unchanged Starship concept as a display-only built-in', () => {
    const definition = BUILT_IN_CRAFTS.find((craft) => craft.id === 'spacex-starship-2019-concept');
    expect(definition).toMatchObject({
      name: 'SpaceX Starship · 2019 Concept',
      displayVisualId: 'starship-2019-concept',
    });
    expect(definition?.description).toContain('MartianDays (CC BY 4.0)');
    expect(createStarshipConceptDisplayCraft()).toMatchObject({
      name: 'SpaceX Starship · 2019 Concept',
      parts: [{ defId: 'pod-voyager' }],
      stages: [],
    });
  });

  it('reaches Earth orbit with a verified Moon intercept and capture reserve', () => {
    const craft = createFirstLightRocket();
    expect(BUILT_IN_CRAFTS.map((entry) => entry.id)).toContain('first-light-launch-vehicle');
    expect(validateCraftFile(JSON.parse(JSON.stringify(craft)))).not.toBeNull();
    expect(craft.parts).toHaveLength(35);
    expect(craft.parts.filter((part) => part.defId === 'batt-m')).toHaveLength(1);
    expect(craftAxialVisualBounds(craft).minimum).toBeCloseTo(0, 8);
    expect(craft.stages.map((stage) => stage.partKeys.map((key) => (
      craft.parts.find((part) => part.key === key)!.defId
    )))).toEqual([
      ['eng-mule', 'srb-torch', 'srb-torch', 'srb-torch', 'srb-torch'],
      ['dec-radial', 'dec-radial', 'dec-radial', 'dec-radial'],
      ['dec-m', 'eng-mule'],
      ['dec-interstage-ms', 'eng-pike'],
      ['dec-s', 'eng-ember'],
      ['dec-s'],
      ['chute-main'],
    ]);

    const analysis = analyzeCraft(
      craft,
      9.80665,
      101_325,
      GAMEPLAY_PROFILES.sol.flightTuning,
    );
    expect(analysis.totalDeltaV).toBeGreaterThan(12_000);
    expect(analysis.stages[0].twrStart).toBeGreaterThan(2.5);
    expect(analysis.stages[0].twrStart).toBeLessThan(2.8);
    expect(analysis.warnings).toEqual([]);

    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    let vessel = game.spawnOnPad(craft, craft.name);
    expect(vessel.runtime.charge.capacity).toBe(1_150);
    vessel.runtime.controls.throttle = 1;
    vessel.runtime.sas = 'ascent';
    expect(game.fireStage(vessel)).toBe(true);

    let boostersDropped = false;
    let coreStaged = false;
    let orbitalEngineStaged = false;
    let lunarEngineStaged = false;
    let orbitReached = false;

    for (let frame = 0; frame < 120_000 && !orbitReached; frame++) {
      game.update(PHYSICS_DT);
      vessel = game.active!;
      const runtime = vessel.runtime;
      const earth = game.bodyOf(vessel);
      const altitude = runtime.pos.length() - earth.radius;
      const elements = stateToElements(earth.mu, runtime.pos, runtime.vel, game.time);
      const periapsis = elements.e < 1 ? periapsisOf(elements) - earth.radius : -Infinity;
      const thrust = maxThrust(
        runtime,
        earth.pressureAt(altitude),
        game.flightTuning,
        earth.def.atmosphere?.seaLevelPressure,
      );

      if (!boostersDropped) {
        const boosters = runtime.craft.parts.filter((part) => part.defId === 'srb-torch');
        if (boosters.length > 0 && boosters.every((part) => (part.resources.solidFuel ?? 0) <= 1e-6)) {
          expect(game.fireStage(vessel)).toBe(true);
          boostersDropped = true;
        }
      } else if (!coreStaged && altitude >= 80_000) {
        expect(game.fireStage(vessel)).toBe(true);
        coreStaged = true;
      } else if (coreStaged && !orbitalEngineStaged && thrust <= 1) {
        expect(game.fireStage(vessel)).toBe(true);
        orbitalEngineStaged = true;
      } else if (orbitalEngineStaged && !lunarEngineStaged && thrust <= 1) {
        expect(game.fireStage(vessel)).toBe(true);
        lunarEngineStaged = true;
      } else if (lunarEngineStaged) {
        orbitReached = periapsis >= 100_000 && runtime.situation === 'orbit';
        if (orbitReached) runtime.controls.throttle = 0;
      }
    }

    expect(orbitReached).toBe(true);
    expect(vessel.runtime.situation).toBe('orbit');
    expect(vessel.runtime.charge.amount / vessel.runtime.charge.capacity).toBeGreaterThan(0.95);
    expect(vessel.runtime.events.some((event) => event.severity === 'danger')).toBe(false);

    const earth = game.bodyOf(vessel);
    const moon = game.universe.get('moon');
    const direction = vessel.runtime.pos.x * vessel.runtime.vel.y
      - vessel.runtime.pos.y * vessel.runtime.vel.x >= 0 ? 1 : -1;
    const transfer = planTransfer(game.universe, game.time, earth, moon, {
      parkRadius: vessel.runtime.pos.length(),
      vesselAngle: Math.atan2(vessel.runtime.pos.y, vessel.runtime.pos.x),
      parkingOrbitDirection: direction,
      vesselPosition: vessel.runtime.pos,
      vesselVelocity: vessel.runtime.vel,
    });
    const reserve = analyzeCraft(
      vessel.runtime.craft,
      earth.surfaceGravity,
      0,
      game.flightTuning,
      earth.def.atmosphere?.seaLevelPressure,
    );
    expect(transfer?.accuracy).toBe('refined-intercept');
    expect(transfer?.approachAltitude).toBeLessThan(400_000);
    const reference = stateToElements(
      earth.mu,
      vessel.runtime.pos,
      vessel.runtime.vel,
      game.time,
    );
    const prediction = predictTrajectory(
      game.universe,
      earth,
      orbitAfterNode(reference, transfer!.suggestedNode),
      transfer!.suggestedNode.time,
      transfer!.transferTime * 1.45,
    );
    expect(prediction.encounter?.bodyId).toBe('moon');
    expect(prediction.encounter?.periapsisAltitude).toBeLessThan(400_000);
    expect(reserve.totalDeltaV).toBeGreaterThan(
      transfer!.departureDv + transfer!.arrivalDv + 500,
    );

    const powered = reserve.stages.find((stage) => stage.thrust > 0)!;
    const burnDuration = estimateBurnTime(
      transfer!.departureDv,
      powered.thrust,
      vessel.runtime.massProps.mass,
      powered.isp,
    );
    const burnStart = transfer!.suggestedNode.time - burnDuration / 2;
    elementsAtTime(reference, burnStart, vessel.runtime.pos, vessel.runtime.vel);
    game.time = burnStart;
    const burnDirection = nodeBurnVector(reference, transfer!.suggestedNode, new Vec3()).normalize();
    vessel.runtime.sas = 'node';
    vessel.runtime.sasCustomDir.copy(burnDirection);
    let remainingDv = transfer!.departureDv;
    for (let frame = 0; frame < 60_000 && remainingDv > 0.5; frame++) {
      const accel = powered.thrust / vessel.runtime.massProps.mass;
      vessel.runtime.controls.throttle = Math.max(0.08, Math.min(1, remainingDv / Math.max(2, accel * 4)));
      game.update(PHYSICS_DT);
      remainingDv = Math.max(0, remainingDv - vessel.runtime.properAccel * PHYSICS_DT);
    }
    vessel.runtime.controls.throttle = 0;
    const achieved = stateToElements(earth.mu, vessel.runtime.pos, vessel.runtime.vel, game.time);
    const finiteBurnPrediction = predictTrajectory(
      game.universe,
      earth,
      achieved,
      game.time,
      transfer!.transferTime * 1.45,
    );
    const correction = planMoonCourseCorrection(
      game.universe,
      game.time,
      earth,
      moon,
      vessel.runtime.pos,
      vessel.runtime.vel,
    );
    const correctedPrediction = correction ? predictTrajectory(
      game.universe,
      earth,
      orbitAfterNode(achieved, correction.node),
      correction.node.time,
      moon.orbitalPeriod * 0.15,
    ) : null;
    expect(finiteBurnPrediction.encounter?.bodyId).toBe('moon');
    expect(finiteBurnPrediction.encounter?.periapsisAltitude).toBeGreaterThan(500_000);
    expect(correction).not.toBeNull();
    expect(Math.hypot(
      correction!.node.prograde,
      correction!.node.normal,
      correction!.node.radial,
    )).toBeLessThan(100);
    expect(correctedPrediction?.encounter?.bodyId).toBe('moon');
    expect(correctedPrediction?.encounter?.periapsisAltitude).toBeGreaterThan(30_000);
    expect(correctedPrediction?.encounter?.periapsisAltitude).toBeLessThan(500_000);
  });

  it('joins the First Light heat shield directly to its separator', () => {
    const craft = createFirstLightRocket();
    const shield = craft.parts.find((part) => part.defId === 'shield-s')!;
    const separator = craft.parts.find((part) => part.defId === 'dec-s')!;
    const shieldBottom = shield.position.y - partById(shield.defId).shape.height / 2;
    const separatorTop = separator.position.y + partById(separator.defId).shape.height / 2;

    expect(separator.parentKey).toBe(shield.key);
    expect(shieldBottom).toBeCloseTo(separatorTop, 6);
  });

  it('starts Second Light in a transfer-ready Earth parking orbit', () => {
    const craft = createSecondLightCraft();
    expect(validateCraftFile(JSON.parse(JSON.stringify(craft)))).not.toBeNull();
    expect(craft.parts).toHaveLength(8);
    expect(craft.parts.map((part) => part.defId)).toEqual(expect.arrayContaining([
      'pod-voyager',
      'chute-main',
      'shield-s',
      'batt-m',
      'tank-s4',
      'eng-ember',
    ]));
    expect(craft.parts.filter((part) => part.defId === 'tank-s4')).toHaveLength(2);
    expect(craft.parts.find((part) => part.defId === 'eng-ember')?.activated).toBe(true);
    expect(craft.stages.map((stage) => stage.partKeys.map((key) => (
      craft.parts.find((part) => part.key === key)!.defId
    )))).toEqual([['eng-ember'], ['dec-s'], ['chute-main']]);

    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(craft, craft.name, 'earth', 200_000);
    vessel.runtime.currentStage = 1;
    expect(vessel.runtime.currentStage).toBe(1);
    expect(vessel.runtime.charge.amount).toBe(1_150);
    expect(vessel.runtime.controls.throttle).toBe(0);
    const earth = game.bodyOf(vessel);
    const moon = game.universe.get('moon');
    const orbit = stateToElements(earth.mu, vessel.runtime.pos, vessel.runtime.vel, game.time);
    expect(apoapsisOf(orbit) - earth.radius).toBeCloseTo(200_000, 3);
    expect(periapsisOf(orbit) - earth.radius).toBeCloseTo(200_000, 3);
    const transfer = planTransfer(game.universe, game.time, earth, moon, {
      parkRadius: vessel.runtime.pos.length(),
      vesselAngle: 0,
      parkingOrbitDirection: 1,
      vesselPosition: vessel.runtime.pos,
      vesselVelocity: vessel.runtime.vel,
    });
    expect(transfer?.accuracy).toBe('refined-intercept');
    expect(transfer?.approachAltitude).toBeGreaterThan(30_000);
    expect(transfer?.approachAltitude).toBeLessThan(500_000);
    const reserve = analyzeCraft(craft, earth.surfaceGravity, 0, game.flightTuning);
    expect(reserve.totalDeltaV).toBeGreaterThan(
      transfer!.departureDv + transfer!.arrivalDv + 500,
    );
  });

  it('offers Odyssey as a complete launch-to-orbit vehicle with an orbital reserve stage', () => {
    expect(BUILT_IN_CRAFTS.map((craft) => craft.id)).toContain('odyssey-orbital-vehicle');
    const craft = createOdysseyOrbiter();
    expect(validateCraftFile(JSON.parse(JSON.stringify(craft)))).not.toBeNull();

    const definitions = craft.parts.map((part) => partById(part.defId));
    const engines = definitions.filter((part) => part.engine).map((part) => part.engine!);
    expect(engines.every((engine) => engine.gimbalDeg > 0 || engine.propellant === 'solidFuel')).toBe(true);
    expect(definitions.filter((part) => part.solar)).toHaveLength(4);
    expect(definitions.some((part) => part.battery && part.battery.capacity >= 1_000)).toBe(true);
    expect(definitions.filter((part) => part.rcs)).toHaveLength(4);
    expect(definitions.some((part) => part.id === 'dock-port-s')).toBe(true);
    expect(definitions.filter((part) => part.decoupler && !part.decoupler.radial)).toHaveLength(2);
    expect(craft.stages.map((stage) => stage.partKeys.map((key) => (
      craft.parts.find((part) => part.key === key)!.defId
    )))).toEqual([
      ['eng-mule', 'srb-torch', 'srb-torch', 'srb-torch', 'srb-torch'],
      ['dec-radial', 'dec-radial', 'dec-radial', 'dec-radial'],
      ['dec-m', 'eng-aspen'],
      ['dec-interstage-ms', 'eng-colt'],
    ]);

    const launchLoad = evaluateStructure(craft, new Vec3(0, 25, 0), 45_000, 0.05);
    expect(launchLoad.failures).toEqual([]);
    expect(launchLoad.maxUtilization).toBeLessThan(0.3);

    const launchAnalysis = analyzeCraft(craft, 9.80665, 101_325);
    const vacuumAnalysis = analyzeCraft(craft, 9.80665, 0);
    const propulsionStages = vacuumAnalysis.stages.filter((stage) => stage.deltaV > 0);
    expect(propulsionStages).toHaveLength(4);
    expect(vacuumAnalysis.stages[1].twrStart).toBeGreaterThan(0);
    expect(launchAnalysis.stages[0].twrStart).toBeGreaterThan(1.8);
    expect(vacuumAnalysis.totalDeltaV).toBeGreaterThan(9_500);
    expect(propulsionStages.at(-1)!.deltaV).toBeGreaterThan(3_500);
    expect(vacuumAnalysis.warnings).toEqual([]);
  });

  it('exposes the Wayfarer as a fresh, structurally valid 21-part craft', () => {
    expect(BUILT_IN_CRAFTS.map((craft) => craft.id)).toContain('wayfarer-heavy-demonstrator');
    const first = createWayfarerDemonstrator();
    const second = createWayfarerDemonstrator();
    expect(first).not.toBe(second);
    expect(first.parts).not.toBe(second.parts);
    expect(first.parts).toHaveLength(21);
    expect(validateCraftFile(JSON.parse(JSON.stringify(first)))).not.toBeNull();

    first.parts[0].position.y = -999;
    expect(second.parts[0].position.y).not.toBe(-999);
  });

  it('uses every integrated authored part with the intended counts', () => {
    const craft = createWayfarerDemonstrator();
    const counts = new Map<string, number>();
    for (const part of craft.parts) counts.set(part.defId, (counts.get(part.defId) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toMatchObject({
      'pod-voyager': 1,
      'tank-s2': 1,
      'eng-colt': 1,
      'dec-interstage-ms': 1,
      'tank-m4': 2,
      'eng-mule': 1,
      'fin-rudder': 4,
      'fin-swift': 4,
      'dec-radial': 2,
      'srb-torch': 2,
      'nose-s': 2,
    });
    expect(counts.get('srb-flare') ?? 0).toBe(0);
    for (const part of craft.parts) expect(partById(part.defId)).toBeDefined();
  });

  it('has an acyclic attachment graph and an explicit, non-duplicated stage plan', () => {
    const craft = createWayfarerDemonstrator();
    const byKey = new Map(craft.parts.map((part) => [part.key, part]));
    expect(craft.parts.filter((part) => part.parentKey === null)).toHaveLength(1);
    for (const part of craft.parts) {
      const visited = new Set<number>();
      let current = part;
      while (current.parentKey !== null) {
        expect(visited.has(current.key)).toBe(false);
        visited.add(current.key);
        current = byKey.get(current.parentKey)!;
        expect(current).toBeDefined();
      }
    }
    const staged = craft.stages.flatMap((stage) => stage.partKeys);
    expect(new Set(staged).size).toBe(staged.length);
    expect(staged.every((key) => byKey.has(key))).toBe(true);
    expect(craft.stages.map((stage) => stage.partKeys.length)).toEqual([3, 2, 2]);
  });

  it('auto-stages propulsion and releases from the bottom assembly upward', () => {
    const craft = createWayfarerDemonstrator();
    const defIds = buildAutoStages(craft).map((stage) => stage.partKeys.map((key) => (
      craft.parts.find((part) => part.key === key)!.defId
    )));
    expect(defIds).toEqual([
      ['eng-mule', 'srb-torch', 'srb-torch'],
      ['dec-radial', 'dec-radial'],
      ['dec-interstage-ms', 'eng-colt'],
    ]);
  });

  it('keeps both Torch boosters latched through launch loads and releases them on command', () => {
    const craft = createWayfarerDemonstrator();
    const launchLoad = evaluateStructure(craft, new Vec3(0, 40, 0), 0, 0);
    expect(launchLoad.failures).toEqual([]);
    expect(launchLoad.maxUtilization).toBeLessThan(0.8);

    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(craft, craft.name);
    vessel.runtime.controls.throttle = 1;
    expect(game.fireStage(vessel)).toBe(true);
    for (let frame = 0; frame < 60; frame++) game.update(PHYSICS_DT);

    expect(vessel.runtime.craft.parts.filter((part) => part.defId === 'srb-torch')).toHaveLength(2);
    expect(vessel.runtime.events.some((event) => event.text.includes('Structural failure'))).toBe(false);

    expect(game.fireStage(vessel)).toBe(true);
    expect(vessel.runtime.craft.parts.some((part) => part.defId === 'srb-torch')).toBe(false);
    expect(game.vessels.filter((candidate) => (
      candidate.runtime.craft.parts.some((part) => part.defId === 'srb-torch')
    ))).toHaveLength(2);
  });

  it('keeps fins and radial couplings attached through the normal max-Q envelope', () => {
    const craft = createWayfarerDemonstrator();
    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(craft, craft.name);
    const runtime = vessel.runtime;
    const body = game.bodyOf(vessel);

    // Let the vehicle settle before following the same full-throttle guidance
    // path that previously shed its fins and boosters at about 45 kPa.
    for (let frame = 0; frame < 250; frame++) game.update(PHYSICS_DT);
    runtime.controls.throttle = 1;
    expect(game.fireStage(vessel)).toBe(true);

    let peakDynamicPressure = 0;
    for (let frame = 0; frame < 1_000 && peakDynamicPressure < 45_000; frame++) {
      game.update(PHYSICS_DT);
      const command = ascentGuidance(runtime, body);
      runtime.sas = 'custom';
      runtime.sasCustomDir.copy(command.dir);
      peakDynamicPressure = Math.max(peakDynamicPressure, runtime.aero.dynamicPressure);
    }

    expect(peakDynamicPressure).toBeGreaterThanOrEqual(45_000);
    expect(runtime.craft.parts.filter((part) => part.defId === 'fin-rudder')).toHaveLength(4);
    expect(runtime.craft.parts.filter((part) => part.defId === 'fin-swift')).toHaveLength(4);
    expect(runtime.craft.parts.filter((part) => part.defId === 'dec-radial')).toHaveLength(2);
    expect(runtime.events.some((event) => event.text.includes('Structural failure'))).toBe(false);

    const normalTurn = evaluateStructure(
      runtime.craft,
      new Vec3(0, runtime.properAccel, 0),
      runtime.aero.dynamicPressure,
      Math.sin(runtime.aero.aoa),
    );
    expect(normalTurn.failures).toEqual([]);
    expect(normalTurn.maxUtilization).toBeLessThan(0.46);

    const aggressiveTurn = evaluateStructure(
      runtime.craft,
      new Vec3(0, 45, 0),
      60_000,
      Math.sin(Math.PI / 6),
    );
    expect(aggressiveTurn.failures.length).toBeGreaterThan(0);
  });

  it('derives the fitted M-to-S envelope through the upper-stage Colt engine', () => {
    const craft = createWayfarerDemonstrator();
    const separator = craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    expect(partById(separator.defId)?.shape).toMatchObject({ radiusTop: 1.25, radiusBottom: 1.25 });
    expect(deriveInterstageShroud(craft, separator)).toEqual({
      lowerRadius: 1.25,
      upperRadius: 0.6,
      lowerY: expect.closeTo(-0.08, 8),
      upperY: expect.closeTo(0.53, 8),
    });
  });

  it('derives the fitted M-to-M envelope through the core-stage Aspen engine', () => {
    const craft = createOdysseyOrbiter();
    const separator = craft.parts.find((part) => part.defId === 'dec-m')!;
    expect(deriveInterstageShroud(craft, separator)).toEqual({
      lowerRadius: 1.25,
      upperRadius: 1.25,
      lowerY: expect.closeTo(-0.1, 8),
      upperY: expect.closeTo(1.6, 8),
    });
  });
});
