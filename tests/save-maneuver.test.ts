import { describe, expect, it } from 'vitest';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { serializeGame, restoreGame } from '../src/save/persistence';
import { validateSave, migrateSave, SAVE_VERSION } from '../src/save/schema';
import { Vec3 } from '../src/core/vec3';
import { stateToElements, apoapsisOf } from '../src/core/orbit';
import {
  ManeuverNode,
  nodeDeltaV,
  orbitAfterNode,
  predictTrajectory,
  estimateBurnTime,
} from '../src/sim/maneuver';
import { buildTwoStageRocket } from './vessel.test';

describe('save system', () => {
  it('round-trips a full game state losslessly', () => {
    const game = new GameState();
    const gv = game.spawnOnPad(buildTwoStageRocket(), 'Roundtrip One');
    // Fly a little so state is non-trivial.
    gv.runtime.controls.throttle = 0.8;
    game.fireStage(gv);
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    game.sciencePoints = 42;
    game.completedExperiments.add('thermal-scan@veyra-surface');
    game.flags.tutorialDone = true;

    const save = serializeGame(game, 'test');
    const json = JSON.stringify(save);
    const restored = restoreGame(JSON.parse(json));

    expect(restored.time).toBeCloseTo(game.time, 9);
    expect(restored.sciencePoints).toBe(42);
    expect(restored.completedExperiments.has('thermal-scan@veyra-surface')).toBe(true);
    expect(restored.flags.tutorialDone).toBe(true);
    expect(restored.vessels.length).toBe(game.vessels.length);

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
    const game = new GameState();
    game.spawnOnPad(buildTwoStageRocket(), 'V');
    const good = serializeGame(game, 't');
    expect(validateSave(JSON.parse(JSON.stringify(good)))).toBe(true);
    expect(() => migrateSave({ ...good, saveVersion: SAVE_VERSION + 1 })).toThrow(/newer/);
  });
});

describe('maneuver planning', () => {
  const game = new GameState();
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
  });

  it('estimates finite burn durations sensibly', () => {
    // 1000 m/s on a 10 t craft with 200 kN at Isp 320: ~ (m0-m1)/flow
    const t = estimateBurnTime(1000, 200_000, 10_000, 320);
    expect(t).toBeGreaterThan(30);
    expect(t).toBeLessThan(80);
    expect(estimateBurnTime(100, 0, 1000, 300)).toBe(Infinity);
  });
});
