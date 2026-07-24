import { createLegacyGameState, restoreLegacyGame } from './fixtures/legacyGameState';
/**
 * Mission planning: transfer windows (moon + interplanetary), the alarm
 * system's warp interlock, and atmospheric entry prediction.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';
import { planTransfer } from '../src/sim/transfer';
import { predictEntry } from '../src/sim/entry';
import { orbitAfterNode, predictTrajectory } from '../src/sim/maneuver';
import { elementsAtTime, stateToElements } from '../src/core/orbit';
import { buildAeroModel } from '../src/sim/aero';
import { computeMassProperties } from '../src/sim/vessel';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { createOdysseyOrbiter } from '../src/content/crafts';

function buildProbe(): Craft {
  const craft = createCraft('Probe');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'batt-s', core.key, 'surface', { x: 0.3, y: 0, z: 0 });
  return craft;
}

describe('transfer planner', () => {
  it('solves an inclined Earth-Moon transfer into a verified lunar approach', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const gv = game.spawnInOrbit(createOdysseyOrbiter(), 'Odyssey', 'earth', 200_000);
    const earth = game.universe.get('earth');
    const moon = game.universe.get('moon');
    const plan = planTransfer(game.universe, game.time, earth, moon, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection: 1,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });

    expect(plan?.accuracy).toBe('refined-intercept');
    expect(plan?.suggestedNode.normal).not.toBe(0);
    expect(plan?.departureDv).toBeGreaterThan(3_000);
    expect(plan?.departureDv).toBeLessThan(4_500);
    expect(plan?.approachAltitude).toBeGreaterThan(50_000);
    expect(plan?.approachAltitude).toBeLessThan(500_000);

    const reference = stateToElements(earth.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    const prediction = predictTrajectory(
      game.universe,
      earth,
      orbitAfterNode(reference, plan!.suggestedNode),
      plan!.suggestedNode.time,
      plan!.transferTime * 1.65,
    );
    expect(prediction.encounter?.bodyId).toBe('moon');
    expect(prediction.encounter?.periapsisAltitude).toBeCloseTo(plan!.approachAltitude!, 3);
  }, 15_000);

  it('plans a transfer to the moon Palla with a verifiable phase window', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 100_000);
    const veyra = game.universe.get('veyra');
    const palla = game.universe.get('palla');
    const r1 = veyra.radius + 100_000;

    const plan = planTransfer(game.universe, game.time, veyra, palla, {
      parkRadius: r1,
      vesselAngle: 0,
    });
    expect(plan).not.toBeNull();
    const p = plan!;
    expect(p.transferTime).toBeGreaterThan(0);
    expect(Number.isFinite(p.transferTime)).toBe(true);
    expect(p.timeToWindow).toBeGreaterThanOrEqual(0);
    expect(p.departureDv).toBeGreaterThan(100); // real burn, sane magnitude
    expect(p.departureDv).toBeLessThan(5000);

    // Hohmann transfer time from the textbook formula.
    const r2 = palla.orbit!.a;
    const aT = (r1 + r2) / 2;
    const tH = Math.PI * Math.sqrt((aT * aT * aT) / veyra.mu);
    expect(p.transferTime).toBeCloseTo(tH, -1);

    // INDEPENDENT verification of the window: at windowTime the moon must
    // lead the vessel (circular ring at r1, angle 0 at t0, rate n1) by the
    // needed phase angle.
    const n1 = Math.sqrt(veyra.mu / (r1 * r1 * r1));
    const vesselAngle = 0 + n1 * (p.windowTime - game.time);
    const pallaAngle = bodyAngle(game, 'palla', p.windowTime);
    let phase = pallaAngle - vesselAngle;
    phase = ((phase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let d = phase - p.phaseNeeded;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    expect(Math.abs(d)).toBeLessThan(0.05);
  });

  it('refines a live-orbit Palla sketch into a usable non-impact approach', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 105_000);
    const veyra = game.universe.get('veyra');
    const palla = game.universe.get('palla');
    const plan = planTransfer(game.universe, game.time, veyra, palla, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection: 1,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });

    expect(plan?.accuracy).toBe('refined-intercept');
    expect(plan?.approachAltitude).toBeGreaterThan(10_000);
    expect(plan?.approachAltitude).toBeLessThan(100_000);
    const reference = stateToElements(veyra.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    const prediction = predictTrajectory(
      game.universe,
      veyra,
      orbitAfterNode(reference, plan!.suggestedNode),
      plan!.suggestedNode.time,
      plan!.transferTime * 1.45,
    );
    expect(prediction.encounter?.bodyId).toBe('palla');
    expect(prediction.encounter?.periapsisAltitude).toBeCloseTo(plan!.approachAltitude!, 3);
  });

  it('plans an interplanetary transfer to Rusk', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 100_000);
    const veyra = game.universe.get('veyra');
    const rusk = game.universe.get('rusk');

    const plan = planTransfer(game.universe, game.time, veyra, rusk, {
      parkRadius: veyra.radius + 100_000,
      vesselAngle: 0.7,
      parkingOrbitDirection: 1,
    });
    expect(plan).not.toBeNull();
    const p = plan!;
    expect(p.timeToWindow).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.windowTime)).toBe(true);
    expect(p.transferTime).toBeGreaterThan(0);
    expect(p.departureDv).toBeGreaterThan(200);
    expect(p.departureDv).toBeLessThan(20_000);

    // The burn is placed on the nearest parking-orbit pass through the
    // required ejection angle, instead of blindly using the phase window.
    const parkRate = Math.sqrt(veyra.mu / ((veyra.radius + 100_000) ** 3));
    const angleAtBurn = 0.7 + parkRate * (p.burnTime - game.time);
    let ejectionError = angleAtBurn - p.ejectionAngle!;
    while (ejectionError > Math.PI) ejectionError -= Math.PI * 2;
    while (ejectionError < -Math.PI) ejectionError += Math.PI * 2;
    expect(Math.abs(ejectionError)).toBeLessThan(1e-9);
    expect(Math.abs(p.burnTime - p.windowTime)).toBeLessThanOrEqual(Math.PI / parkRate);

    // At the window, the planets' relative phase matches the needed phase.
    const vAngle = bodyAngle(game, 'veyra', p.windowTime);
    const rAngle = bodyAngle(game, 'rusk', p.windowTime);
    let phase = rAngle - vAngle;
    while (phase < 0) phase += Math.PI * 2;
    while (phase >= Math.PI * 2) phase -= Math.PI * 2;
    let d = phase - p.phaseNeeded;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    expect(Math.abs(d)).toBeLessThan(0.15);
  });

  it('hands an Earth escape into the same continuous heliocentric transfer used by rails execution', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const gv = game.spawnInOrbit(createOdysseyOrbiter(), 'Odyssey', 'earth', 200_000);
    const earth = game.universe.get('earth');
    const mercury = game.universe.get('mercury');
    const sun = game.universe.get('sun');
    const plan = planTransfer(game.universe, game.time, earth, mercury, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection: 1,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });
    expect(plan).not.toBeNull();
    expect(plan!.accuracy).toBe('refined-intercept');
    expect(plan!.approachAltitude).toBeGreaterThan(0);

    const reference = stateToElements(earth.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    const postBurn = orbitAfterNode(reference, plan!.suggestedNode);
    const prediction = predictTrajectory(
      game.universe,
      earth,
      postBurn,
      plan!.suggestedNode.time,
    );
    expect(prediction.escape).not.toBeNull();
    expect(prediction.escape!.elements.mu).toBeCloseTo(sun.mu, 3);
    expect(prediction.escape!.elements.e).toBeLessThan(1);
    const parentPrediction = predictTrajectory(
      game.universe,
      sun,
      prediction.escape!.elements,
      prediction.escape!.exitTime,
      plan!.transferTime * 1.5,
    );
    expect(parentPrediction.encounter?.bodyId).toBe(mercury.id);
    expect(parentPrediction.encounter?.periapsisAltitude).toBeCloseTo(plan!.approachAltitude!, 3);

    const exitTime = prediction.escape!.exitTime;
    const localPosition = new Vec3();
    const localVelocity = new Vec3();
    const earthPosition = new Vec3();
    const earthVelocity = new Vec3();
    const predictedParentPosition = new Vec3();
    const predictedParentVelocity = new Vec3();
    elementsAtTime(postBurn, exitTime, localPosition, localVelocity);
    game.universe.localPosition(earth, exitTime, earthPosition, earthVelocity);
    elementsAtTime(
      prediction.escape!.elements,
      exitTime,
      predictedParentPosition,
      predictedParentVelocity,
    );
    // Classical-element round-tripping at ~1 AU loses a few metres of absolute
    // precision while preserving the patched state to far below gameplay scale.
    expect(predictedParentPosition.distanceTo(localPosition.clone().add(earthPosition))).toBeLessThan(10);
    expect(predictedParentVelocity.distanceTo(localVelocity.clone().add(earthVelocity))).toBeLessThan(1e-5);

    // Put the vessel on the planned post-burn conic and let the authoritative
    // rails event processor execute the same SOI transition.
    game.time = plan!.suggestedNode.time;
    elementsAtTime(postBurn, game.time, gv.runtime.pos, gv.runtime.vel);
    gv.runtime.bodyId = earth.id;
    gv.runtime.situation = 'orbit';
    game.toRails(gv);
    game.setWarp(5, true);
    game.update((exitTime - game.time + 10) / game.warpRate);

    expect(gv.runtime.bodyId).toBe(sun.id);
    expect(game.time).toBeCloseTo(exitTime, 5);
    expect(gv.rails.elements).not.toBeNull();
    const executedPosition = new Vec3();
    const executedVelocity = new Vec3();
    elementsAtTime(gv.rails.elements!, game.time, executedPosition, executedVelocity);
    expect(executedPosition.distanceTo(predictedParentPosition)).toBeLessThan(10);
    expect(executedVelocity.distanceTo(predictedParentVelocity)).toBeLessThan(1e-5);
  });

  it.each(['venus', 'mars'] as const)(
    'refines an Earth departure into a verified %s SOI intercept',
    (targetId) => {
      const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
      const gv = game.spawnInOrbit(createOdysseyOrbiter(), 'Odyssey', 'earth', 200_000);
      const earth = game.universe.get('earth');
      const sun = game.universe.get('sun');
      const target = game.universe.get(targetId);
      const plan = planTransfer(game.universe, game.time, earth, target, {
        parkRadius: gv.runtime.pos.length(),
        vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
        parkingOrbitDirection: 1,
        vesselPosition: gv.runtime.pos,
        vesselVelocity: gv.runtime.vel,
      });
      expect(plan?.accuracy).toBe('refined-intercept');
      expect(plan?.departureDv).toBeGreaterThan(0);
      expect(plan?.departureDv).toBeLessThan(12_000);
      expect(plan?.approachAltitude).toBeGreaterThan(0);
      expect(plan?.approachAltitude).toBeLessThan(4_000_000);

      const reference = stateToElements(earth.mu, gv.runtime.pos, gv.runtime.vel, game.time);
      const local = predictTrajectory(
        game.universe,
        earth,
        orbitAfterNode(reference, plan!.suggestedNode),
        plan!.burnTime,
      );
      expect(local.escape).not.toBeNull();
      const parent = predictTrajectory(
        game.universe,
        sun,
        local.escape!.elements,
        local.escape!.exitTime,
        plan!.transferTime * 1.5,
      );
      expect(parent.encounter?.bodyId).toBe(targetId);
      expect(parent.encounter?.periapsisAltitude).toBeCloseTo(plan!.approachAltitude!, 3);
    },
    20_000,
  );

  it('uses an energy-raising local escape burn for inward planet transfers', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 105_000);
    const veyra = game.universe.get('veyra');
    const ashen = game.universe.get('ashen');
    const plan = planTransfer(game.universe, game.time, veyra, ashen, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection: 1,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });

    expect(plan?.suggestedNode.prograde).toBeGreaterThan(0);
    const reference = stateToElements(veyra.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    expect(orbitAfterNode(reference, plan!.suggestedNode).e).toBeGreaterThan(1);
  });

  it('returns null for unsupported pairs', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const auren = game.universe.get('auren');
    expect(
      planTransfer(game.universe, 0, veyra, auren, { parkRadius: veyra.radius + 100_000 }),
    ).toBeNull();
  });

  it('rejects moon-window estimates for retrograde parking orbits', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const palla = game.universe.get('palla');
    expect(planTransfer(game.universe, 0, veyra, palla, {
      parkRadius: veyra.radius + 100_000,
      vesselAngle: 0,
      parkingOrbitDirection: -1,
    })).toBeNull();
  });
});

function bodyAngle(game: GameState, id: string, t: number): number {
  const r = new Vec3();
  game.universe.localPosition(game.universe.get(id), t, r);
  return Math.atan2(r.y, r.x);
}

describe('alarms', () => {
  it('preserves physics warp when rails warp is unavailable', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 50_000);
    game.setWarp(2, false); // 4x physics warp
    game.setWarp(1, true); // 5x rails is unavailable inside Veyra's atmosphere
    expect(game.railsWarp).toBe(false);
    expect(game.warpIndex).toBe(2);
    expect(game.warpRate).toBe(4);
  });

  it('stops rails warp at the alarm time, not after it', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
    const alarmTime = game.time + 5000;
    game.addAlarm(alarmTime, 'Test alarm', 'custom');
    game.setWarp(4, true); // 1000×
    expect(game.railsWarp).toBe(true);
    for (let i = 0; i < 200; i++) {
      game.update(0.1);
      if (!game.railsWarp) break;
    }
    expect(game.railsWarp).toBe(false);
    expect(game.warpIndex).toBe(0);
    // Stopped at the alarm (small physics-tick slack allowed).
    expect(Math.abs(game.time - alarmTime)).toBeLessThan(2);
    // Alarm consumed.
    expect(game.alarms.length).toBe(0);
  });

  it('drops physics warp when an alarm fires', () => {
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
    game.addAlarm(game.time + 3, 'Soon', 'custom');
    game.setWarp(2, false); // 4× physics warp
    for (let i = 0; i < 400; i++) {
      game.update(PHYSICS_DT);
      if (game.warpIndex === 0) break;
    }
    expect(game.warpIndex).toBe(0);
    expect(game.alarms.length).toBe(0);
  });

  it('persists alarms through save/load', async () => {
    const { serializeGame, restoreGame } = await import('../src/save/persistence');
    const game = createLegacyGameState();
    game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
    game.addAlarm(game.time + 1234, 'Window: Rusk', 'transfer');
    const restored = restoreLegacyGame(JSON.parse(JSON.stringify(serializeGame(game, 'x'))));
    expect(restored.alarms.length).toBe(1);
    expect(restored.alarms[0].label).toBe('Window: Rusk');
    expect(restored.alarms[0].time).toBeCloseTo(game.time + 1234, 5);
  });
});

describe('entry prediction', () => {
  it('predicts a landing for a decaying trajectory', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 100_000);
    const v = gv.runtime;
    const veyra = game.bodyOf(gv);
    // Deorbit: cut speed so periapsis is deep in the atmosphere.
    v.vel.scale(0.88);

    const model = buildAeroModel(v.craft);
    const mass = computeMassProperties(v.craft).mass;
    const positionBefore = v.pos.clone();
    const velocityBefore = v.vel.clone();
    const pred = predictEntry(veyra, model, mass, v.pos, v.vel, game.time);
    expect(v.pos).toEqual(positionBefore);
    expect(v.vel).toEqual(velocityBefore);
    expect(pred.willEnter).toBe(true);
    expect(pred.lands).toBe(true);
    expect(pred.landingDirBF).not.toBeNull();
    expect(Math.abs(pred.landingDirBF!.length() - 1)).toBeLessThan(1e-6);
    expect(pred.landingTime).toBeGreaterThan(game.time);
    expect(pred.impactSpeed).toBeGreaterThan(0);
    expect(pred.impactSpeed).toBeLessThan(4000);
    expect(pred.peakHeatFlux).toBeGreaterThan(0);
    expect(pred.samples.length).toBeGreaterThan(5);
    for (const s of pred.samples) expect(s.isFinite()).toBe(true);
  });

  it('reports no entry for a stable high orbit', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 300_000);
    const v = gv.runtime;
    const veyra = game.bodyOf(gv);
    const model = buildAeroModel(v.craft);
    const mass = computeMassProperties(v.craft).mass;
    const pred = predictEntry(veyra, model, mass, v.pos, v.vel, game.time);
    expect(pred.willEnter).toBe(false);
    expect(pred.lands).toBe(false);
  });

  it('predicts direct terrain impact on an airless body without heating', () => {
    const game = createLegacyGameState();
    const palla = game.universe.get('palla');
    const craft = buildProbe();
    const model = buildAeroModel(craft);
    const mass = computeMassProperties(craft).mass;
    const pred = predictEntry(
      palla,
      model,
      mass,
      new Vec3(palla.radius + 10_000, 0, 0),
      new Vec3(-100, 0, 0),
      game.time,
    );

    expect(pred.willEnter).toBe(true);
    expect(pred.lands).toBe(true);
    expect(pred.peakHeatFlux).toBe(0);
    expect(pred.landingDirBF).not.toBeNull();
  });

  it('reports no entry for a stable airless orbit', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'palla', 100_000);
    const palla = game.bodyOf(gv);
    const model = buildAeroModel(gv.runtime.craft);
    const mass = computeMassProperties(gv.runtime.craft).mass;
    const pred = predictEntry(
      palla,
      model,
      mass,
      gv.runtime.pos,
      gv.runtime.vel,
      game.time,
    );

    expect(pred.willEnter).toBe(false);
    expect(pred.lands).toBe(false);
    expect(pred.samples.every((sample) => sample.isFinite())).toBe(true);
  });

  it('reports atmospheric heating independently of the drag-area approximation', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const craft = buildProbe();
    const model = { ...buildAeroModel(craft), areaAxial: 0 };
    const mass = computeMassProperties(craft).mass;
    const pred = predictEntry(
      veyra,
      model,
      mass,
      new Vec3(veyra.radius + 40_000, 0, 0),
      new Vec3(-500, 0, 0),
      game.time,
    );

    expect(pred.willEnter).toBe(true);
    expect(pred.peakHeatFlux).toBeGreaterThan(0);
  });
});
