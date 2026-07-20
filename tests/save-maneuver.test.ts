import { createLegacyGameState, restoreLegacyGame, migrateLegacySave } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { serializeGame, restoreGame } from '../src/save/persistence';
import { validateSave, migrateSave, SAVE_VERSION } from '../src/save/schema';
import { Vec3 } from '../src/core/vec3';
import { stateToElements, apoapsisOf, elementsAtTime } from '../src/core/orbit';
import {
  ManeuverNode,
  nodeBurnVector,
  nodeDeltaV,
  orbitAfterNode,
  predictTrajectory,
  estimateBurnTime,
} from '../src/sim/maneuver';
import { buildTwoStageRocket } from './vessel.test';
import { createCampaign } from '../src/sim/campaign';
import { encodeScienceKey } from '../src/sim/science';

describe('save system', () => {
  it('round-trips a full game state losslessly', () => {
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(buildTwoStageRocket(), 'Roundtrip One');
    // Fly a little so state is non-trivial.
    gv.runtime.controls.throttle = 0.8;
    game.fireStage(gv);
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    game.sciencePoints = 42;
    const scienceKey = encodeScienceKey({
      experimentId: 'thermal-scan', bodyId: 'veyra', biomeId: 'global', situation: 'surface',
    });
    game.scienceLedger.set(scienceKey, { cap: 8, deliveredByTransmit: 3, deliveredByRecovery: 5 });
    gv.runtime.scienceBuffer.set(encodeScienceKey({
      experimentId: 'surface-sample', bodyId: 'veyra', biomeId: 'lowland', situation: 'surface',
    }), { siteCapAtCollection: 20, heldValue: 12, transmittedFromThis: 0, transmitTarget: 0 });
    game.flags.tutorialDone = true;
    game.campaign = createCampaign('program');
    game.campaign.funds = 17_250;
    game.campaign.reputation = 4;
    game.campaign.unlockedTech.push('orbital-engineering');
    game.campaign.activeContracts.push('veyra-orbit');
    game.active!.target = 'palla';
    const actionPartKey = game.active!.runtime.craft.parts[0].key;
    game.active!.runtime.craft.actionGroups = {
      1: [{ partKey: actionPartKey, action: 'toggle' }],
    };

    const save = serializeGame(game, 'test');
    const json = JSON.stringify(save);
    const restored = restoreLegacyGame(JSON.parse(json));

    expect(restored.time).toBeCloseTo(game.time, 9);
    expect(restored.sciencePoints).toBe(42);
    expect(restored.scienceLedger.get(scienceKey)).toEqual({ cap: 8, deliveredByTransmit: 3, deliveredByRecovery: 5 });
    expect(restored.active!.runtime.scienceBuffer).toEqual(gv.runtime.scienceBuffer);
    expect(restored.flags.tutorialDone).toBe(true);
    expect(restored.campaign).toEqual(game.campaign);
    expect(restored.vessels.length).toBe(game.vessels.length);
    expect(restored.active!.target).toBe('palla');
    expect(restored.active!.runtime.craft.actionGroups).toEqual({
      1: [{ partKey: actionPartKey, action: 'toggle' }],
    });

    const a = game.active!.runtime;
    const b = restored.active!.runtime;
    expect(b.pos.distanceTo(a.pos)).toBeLessThan(1e-9);
    expect(b.vel.distanceTo(a.vel)).toBeLessThan(1e-9);
    expect(b.craft.parts.length).toBe(a.craft.parts.length);
    expect(b.currentStage).toBe(a.currentStage);
    // Fuel state preserved exactly.
    const fuelA = a.craft.parts.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);
    const fuelB = b.craft.parts.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);
    expect(fuelB).toBeCloseTo(fuelA, 9);

    // Restored game continues simulating without exploding.
    for (let i = 0; i < 250; i++) restored.update(PHYSICS_DT);
    expect(restored.active!.runtime.pos.isFinite()).toBe(true);
  });

  it('rejects corrupted saves and refuses newer versions', () => {
    expect(validateSave(null)).toBe(false);
    expect(validateSave({})).toBe(false);
    expect(validateSave({ saveVersion: 1, time: NaN, vessels: [] })).toBe(false);
    const game = createLegacyGameState();
    game.spawnOnPad(buildTwoStageRocket(), 'V');
    const good = serializeGame(game, 't');
    expect(validateSave(JSON.parse(JSON.stringify(good)))).toBe(true);
    expect(() => migrateLegacySave({ ...good, saveVersion: SAVE_VERSION + 1 })).toThrow(/newer/);
    good.vessels[0].target = 'not-a-body';
    expect(() => restoreLegacyGame(good)).toThrow(/not-a-body/);
  });

  it('round-trips alarms and migrates version 2 saves with an empty queue', () => {
    const game = createLegacyGameState();
    game.addAlarm(1234, 'Window: Rusk', 'transfer');

    const saved = serializeGame(game, 'alarm');
    expect(saved.saveVersion).toBe(SAVE_VERSION);
    expect(restoreLegacyGame(saved).alarms[0]).toMatchObject({
      time: 1234,
      label: 'Window: Rusk',
      kind: 'transfer',
    });

    const v2 = JSON.parse(JSON.stringify(saved));
    v2.saveVersion = 2;
    delete v2.alarms;
    expect(migrateLegacySave(v2).alarms).toEqual([]);

    const legacyGame = createLegacyGameState();
    legacyGame.spawnOnPad(buildTwoStageRocket(), 'Legacy craft');
    const v5 = JSON.parse(JSON.stringify(serializeGame(legacyGame, 'v5')));
    v5.saveVersion = 5;
    for (const vessel of v5.vessels) {
      delete vessel.target;
      delete vessel.craft.actionGroups;
    }
    const migrated = migrateLegacySave(v5);
    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.vessels[0].target).toBeNull();
    expect(migrated.vessels[0].craft.actionGroups).toEqual({});

    const v6 = JSON.parse(JSON.stringify(saved));
    v6.saveVersion = 6;
    for (const alarm of v6.alarms) delete alarm.vesselId;
    expect(migrateLegacySave(v6).alarms[0].vesselId).toBeNull();
  });

  it('migrates banked history and aboard science through distinct v8 rules', () => {
    const game = createLegacyGameState('exploration');
    game.spawnOnPad(buildTwoStageRocket(), 'Legacy science craft');
    const legacy = JSON.parse(JSON.stringify(serializeGame(game, 'legacy-v8')));
    legacy.saveVersion = 8;
    legacy.science = { points: 17, completed: ['thermal-scan@veyra-surface'] };
    delete legacy.campaign.upgradeLevels;
    legacy.vessels[0].science = { 'spore-exposure@veyra-surface': 7 };
    delete legacy.vessels[0].scienceBuffer;

    const migrated = migrateLegacySave(legacy);
    const historyKey = encodeScienceKey({
      experimentId: 'thermal-scan', bodyId: 'veyra', biomeId: 'global', situation: 'surface',
    });
    const aboardKey = encodeScienceKey({
      experimentId: 'spore-exposure', bodyId: 'veyra', biomeId: 'global', situation: 'surface',
    });

    expect(migrated.science.points).toBe(17);
    expect(migrated.science.ledger[historyKey]).toMatchObject({
      deliveredByTransmit: 0,
      deliveredByRecovery: migrated.science.ledger[historyKey].cap,
    });
    expect(migrated.vessels[0].scienceBuffer[aboardKey]).toMatchObject({
      heldValue: 7,
      transmittedFromThis: 0,
      transmitTarget: 2,
    });
    expect(migrated.science.ledger[aboardKey]).toBeUndefined();

    const restored = restoreLegacyGame(migrated);
    const resaved = serializeGame(restored, 'round-trip');
    expect(resaved.science.points).toBe(17);
    expect(resaved.science.ledger).toEqual(migrated.science.ledger);
    expect(resaved.vessels[0].scienceBuffer).toEqual(migrated.vessels[0].scienceBuffer);
  });
});

describe('maneuver planning', () => {
  const game = createLegacyGameState();
  const veyra = game.universe.get('veyra');
  const palla = game.universe.get('palla');

  // A clean 110 km circular equatorial orbit.
  const r0 = veyra.radius + 110_000;
  const vCirc = Math.sqrt(veyra.mu / r0);
  const startEl = stateToElements(
    veyra.mu,
    new Vec3(r0, 0, 0),
    new Vec3(0, vCirc, 0),
    0,
  );

  it('a prograde node raises apoapsis per vis-viva', () => {
    const node: ManeuverNode = { time: 500, prograde: 300, normal: 0, radial: 0 };
    expect(nodeDeltaV(node)).toBeCloseTo(300, 9);
    const after = orbitAfterNode(startEl, node);
    expect(after.e).toBeGreaterThan(startEl.e);
    // vis-viva: new apoapsis from v+300 at r0
    const vNew = vCirc + 300;
    const aNew = 1 / (2 / r0 - (vNew * vNew) / veyra.mu);
    expect(after.a).toBeCloseTo(aNew, -2); // within hundreds of meters
    expect(apoapsisOf(after)).toBeGreaterThan(r0 * 1.5);
  });

  it('finds a Palla transfer window by scanning node times (player workflow)', () => {
    // Hohmann-ish dv to reach Palla's orbit radius.
    const r2 = palla.orbit!.a;
    const dvHohmann = vCirc * (Math.sqrt((2 * r2) / (r0 + r2)) - 1);
    let found = false;
    outer: for (let k = 0; k < 30; k++) {
      const nodeTime = (k / 30) * 2400; // scan one vessel orbit
      for (const dv of [dvHohmann, dvHohmann + 15, dvHohmann + 30]) {
        const node: ManeuverNode = { time: nodeTime, prograde: dv, normal: 0, radial: 0 };
        const after = orbitAfterNode(startEl, node);
        const pred = predictTrajectory(game.universe, veyra, after, nodeTime);
        if (pred.encounter && pred.encounter.bodyId === 'palla') {
          found = true;
          expect(pred.encounter.entryTime).toBeGreaterThan(nodeTime);
          // Hyperbolic (or at least energetic) arrival inside Palla's SOI.
          expect(pred.encounter.elements.mu).toBeCloseTo(palla.mu, 3);
          expect(Number.isFinite(pred.encounter.periapsisAltitude)).toBe(true);
          break outer;
        }
      }
    }
    expect(found, 'no Palla encounter found across a full phase scan').toBe(true);
  });

  it('detects escape from Veyra SOI for an overpowered burn', () => {
    const node: ManeuverNode = { time: 200, prograde: 1600, normal: 0, radial: 0 };
    const after = orbitAfterNode(startEl, node);
    const pred = predictTrajectory(game.universe, veyra, after, 200);
    expect(pred.escape).not.toBeNull();
    expect(pred.escape!.elements.mu).toBeCloseTo(game.universe.get('auren').mu, 3);
    const exitPosition = new Vec3();
    const exitVelocity = new Vec3();
    elementsAtTime(after, pred.escape!.exitTime, exitPosition, exitVelocity);
    expect(exitPosition.length()).toBeCloseTo(veyra.soiRadius, 3);
  });

  it('uses an orthogonal radial-transverse-normal maneuver frame', () => {
    const eccentric = stateToElements(
      veyra.mu,
      new Vec3(r0, 0, 0),
      new Vec3(450, vCirc * 0.9, 80),
      0,
    );
    const transverse = nodeBurnVector(
      eccentric,
      { time: 0, prograde: 1, normal: 0, radial: 0 },
      new Vec3(),
    );
    const radial = nodeBurnVector(
      eccentric,
      { time: 0, prograde: 0, normal: 0, radial: 1 },
      new Vec3(),
    );
    expect(transverse.dot(radial)).toBeCloseTo(0, 12);
  });

  it('uses a 60 million second encounter horizon around the system star', () => {
    const auren = game.universe.get('auren');
    const radius = 1e11;
    const circular = stateToElements(
      auren.mu,
      new Vec3(radius, 0, 0),
      new Vec3(0, 0, Math.sqrt(auren.mu / radius)),
      0,
    );
    const pred = predictTrajectory(game.universe, auren, circular, 0);
    expect(pred.endTime - pred.startTime).toBe(60_000_000);
  });

  it('estimates finite burn durations sensibly', () => {
    // 1000 m/s on a 10 t craft with 200 kN at Isp 320: ~ (m0-m1)/flow
    const t = estimateBurnTime(1000, 200_000, 10_000, 320);
    expect(t).toBeGreaterThan(30);
    expect(t).toBeLessThan(80);
    expect(estimateBurnTime(100, 0, 1000, 300)).toBe(Infinity);
  });
});
