/**
 * M1 acceptance mission: Veyra orbit → maneuver-node transfer to Palla →
 * SOI transition → powered landing on the moon → ascent and escape →
 * return to Veyra → aerobraking entry behind a heat shield → chute landing.
 *
 * Everything runs through the real simulation: physical burns, rails warp
 * for coasts, SOI transitions in both regimes, terrain-relative landing.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT, RAILS_WARP_RATES } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';
import { specificEnergy, stateToElements, periapsisOf } from '../src/core/orbit';
import { ManeuverNode, nodeBurnDirection, nodeDeltaV, orbitAfterNode, predictTrajectory } from '../src/sim/maneuver';
import { groundRadiusInertial } from '../src/sim/terrain';
import { surfaceVelocity } from '../src/sim/bodyOrientation';

function buildMoonship(): Craft {
  const craft = createCraft('Palla Pathfinder');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 8.6, z: 0 });
  const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 9.3, z: 0 });
  const shield = addPart(craft, 'shield-s', pod.key, 'stack-bottom', { x: 0, y: 8.0, z: 0 });
  const dec = addPart(craft, 'dec-s', shield.key, 'stack-bottom', { x: 0, y: 7.7, z: 0 });
  const tankU = addPart(craft, 'tank-s4', dec.key, 'stack-bottom', { x: 0, y: 5.7, z: 0 });
  const tankL = addPart(craft, 'tank-s2', tankU.key, 'stack-bottom', { x: 0, y: 3.0, z: 0 });
  const eng = addPart(craft, 'eng-ember', tankL.key, 'stack-bottom', { x: 0, y: 1.8, z: 0 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    addPart(
      craft,
      'leg-lander',
      tankL.key,
      'surface',
      { x: Math.cos(a) * 0.75, y: 2.6, z: Math.sin(a) * 0.75 },
      { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) },
    );
  }
  craft.stages = [
    { partKeys: [eng.key] },
    { partKeys: [dec.key] }, // jettison service stage before entry
    { partKeys: [chute.key] },
  ];
  return craft;
}

describe('Palla round trip', () => {
  it('transfers, lands on the moon, returns, and aerobrakes home', () => {
    const game = new GameState();
    const gv = game.spawnInOrbit(buildMoonship(), 'Palla Pathfinder', 'veyra', 110_000);
    const v = gv.runtime;
    const veyra = game.universe.get('veyra');
    const palla = game.universe.get('palla');
    game.fireStage(gv); // activate engine

    const step = () => game.update(PHYSICS_DT);
    const up = new Vec3();
    const fuel = () => v.craft.parts.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);

    // ------------------------------------------------ plan the transfer node
    const els0 = stateToElements(veyra.mu, v.pos, v.vel, game.time);
    const r0 = v.pos.length();
    const vCirc = Math.sqrt(veyra.mu / r0);
    const dvHohmann = vCirc * (Math.sqrt((2 * palla.orbit!.a) / (r0 + palla.orbit!.a)) - 1);
    let node: ManeuverNode | null = null;
    outer: for (let k = 0; k < 40; k++) {
      const nodeTime = game.time + 120 + (k / 40) * 2400;
      for (const dv of [dvHohmann, dvHohmann + 12, dvHohmann + 25, dvHohmann + 40]) {
        const candidate: ManeuverNode = { time: nodeTime, prograde: dv, normal: 0, radial: 0 };
        const after = orbitAfterNode(els0, candidate);
        const pred = predictTrajectory(game.universe, veyra, after, nodeTime);
        if (
          pred.encounter?.bodyId === 'palla' &&
          pred.encounter.periapsisAltitude > 8_000 &&
          pred.encounter.periapsisAltitude < 45_000
        ) {
          node = candidate;
          break outer;
        }
      }
    }
    expect(node, 'no viable Palla transfer found').not.toBeNull();

    // ------------------------------------------------ warp to node, burn it
    // Finite burn: start half the burn duration before the node (standard
    // practice) so the impulse approximation holds.
    const executeBurn = (n: ManeuverNode) => {
      const mass = v.massProps.mass;
      const burnEstimate = (nodeDeltaV(n) * mass) / 58_000; // a = F/m
      game.setWarp(3, true);
      while (game.time < n.time - burnEstimate / 2 - 20) {
        game.update(0.1);
        if (game.warpRate === 1 && game.time < n.time - burnEstimate / 2 - 60) {
          game.setWarp(3, true);
        }
      }
      game.setWarp(0, false);
      const dir = nodeBurnDirection(stateToElements(veyra.mu, v.pos, v.vel, game.time), n, new Vec3());
      v.sas = 'custom';
      v.sasCustomDir.copy(dir);
      for (let i = 0; i < 400; i++) step();
      v.controls.throttle = 1;
      let applied = 0;
      const target = nodeDeltaV(n);
      while (applied < target) {
        step();
        applied += v.properAccel * PHYSICS_DT;
        expect(game.time).toBeLessThan(n.time + 1200);
      }
      v.controls.throttle = 0;
    };

    const findTrim = (): ManeuverNode | null => {
      const elsNow = stateToElements(veyra.mu, v.pos, v.vel, game.time);
      for (let k = 0; k < 24; k++) {
        const tNode = game.time + 200 + (k / 24) * 8000;
        for (const dv of [-45, -30, -20, -12, -6, 6, 12, 20, 30, 45]) {
          const cand: ManeuverNode = { time: tNode, prograde: dv, normal: 0, radial: 0 };
          const after = orbitAfterNode(elsNow, cand);
          const pred = predictTrajectory(game.universe, veyra, after, tNode);
          if (
            pred.encounter?.bodyId === 'palla' &&
            pred.encounter.periapsisAltitude > 8_000 &&
            pred.encounter.periapsisAltitude < 45_000
          ) {
            return cand;
          }
        }
      }
      return null;
    };

    executeBurn(node!);

    // Re-predict from live state; if the finite burn smeared the encounter
    // away, fly a correction trim (what a pilot would do).
    let predLive = predictTrajectory(
      game.universe,
      veyra,
      stateToElements(veyra.mu, v.pos, v.vel, game.time),
      game.time,
    );
    for (let attempt = 0; attempt < 3 && predLive.encounter?.bodyId !== 'palla'; attempt++) {
      const trim = findTrim();
      expect(trim, `no correction trim found (attempt ${attempt})`).not.toBeNull();
      executeBurn(trim!);
      predLive = predictTrajectory(
        game.universe,
        veyra,
        stateToElements(veyra.mu, v.pos, v.vel, game.time),
        game.time,
      );
    }
    expect(predLive.encounter?.bodyId, 'no Palla encounter after corrections').toBe('palla');

    // ------------------------------------------------ coast to Palla SOI
    game.setWarp(4, true);
    let guard = 0;
    while (v.bodyId !== 'palla' && guard++ < 20_000) {
      game.update(0.1);
    }
    expect(v.bodyId, 'never reached Palla SOI').toBe('palla');
    game.setWarp(0, false);
    expect(v.pos.isFinite()).toBe(true);

    // ------------------------------------------------ coast to periapsis
    // Warp until radial velocity flips positive (periapsis passage).
    game.setWarp(2, true);
    guard = 0;
    while (Vec3.dot(v.pos, v.vel) < 0 && v.bodyId === 'palla' && guard++ < 40_000) {
      game.update(0.1);
    }
    game.setWarp(0, false);
    expect(v.bodyId, 'flew through the SOI without reaching periapsis').toBe('palla');
    expect(v.pos.length() - palla.radius).toBeLessThan(80_000);

    // ------------------------------------------------ kill velocity + land
    // Phase 1: cancel orbital speed.
    v.sas = 'retrograde';
    for (let i = 0; i < 300; i++) step();
    let t0 = game.time;
    while (v.vel.length() > 40) {
      v.controls.throttle = 1;
      step();
      expect(game.time - t0, 'braking burn ran away').toBeLessThan(600);
    }
    v.controls.throttle = 0;

    // Phase 2: controlled vertical descent to terrain.
    t0 = game.time;
    let landed = false;
    while (game.time - t0 < 1500) {
      step();
      if (!game.vessels.includes(gv)) {
        throw new Error(`destroyed during Palla landing: ${v.events.slice(-3).map((e) => e.text).join('; ')}`);
      }
      if (v.situation === 'landed') {
        landed = true;
        break;
      }
      up.copy(v.pos).normalize();
      const agl = v.pos.length() - groundRadiusInertial(palla, up, game.time);
      const vRad = v.vel.dot(up);
      // Descend at a speed that scales with height; brake retrograde.
      // Suicide-burn-flavored speed limit: 55% of what max braking could
      // arrest from this height (net accel ≈ thrust/m − g ≈ 8 m/s²).
      const targetVs = -Math.max(2.5, 0.55 * Math.sqrt(2 * 8 * Math.max(1, agl)));
      v.sas = v.vel.length() > 25 ? 'retrograde' : 'custom';
      if (v.sas === 'custom') v.sasCustomDir.copy(up);
      v.controls.throttle = vRad < targetVs ? 1 : 0;
    }
    expect(landed, 'did not land on Palla in time').toBe(true);
    expect(v.situation).toBe('landed');
    expect(v.bodyId).toBe('palla');
    expect(v.craft.parts.some((p) => p.defId === 'pod-voyager')).toBe(true);
    const fuelAfterLanding = fuel();
    expect(fuelAfterLanding, 'no fuel left for the return').toBeGreaterThan(120);

    // Sit on the moon a moment (stability check — no bouncing to orbit).
    const altLanded = v.pos.length();
    for (let i = 0; i < 250; i++) step();
    expect(Math.abs(v.pos.length() - altLanded)).toBeLessThan(5);
    expect(v.situation).toBe('landed');

    // ------------------------------------------------ ascend + escape Palla
    // Burn opposite Palla's orbital velocity to fall back toward Veyra
    // (retrograde in the Veyra frame = efficient return).
    const pallaVel = new Vec3();
    game.universe.localPosition(palla, game.time, new Vec3(), pallaVel);
    v.sas = 'custom';
    v.sasCustomDir.copy(up.copy(v.pos).normalize());
    v.controls.throttle = 1;
    t0 = game.time;
    // Vertical climb first.
    while (v.pos.length() - palla.radius < 14_000) {
      step();
      expect(game.time - t0).toBeLessThan(400);
    }
    // Then push toward Palla-retrograde (w.r.t. Veyra) until we escape.
    game.universe.localPosition(palla, game.time, new Vec3(), pallaVel);
    const escapeDir = new Vec3().copy(pallaVel).normalize().negate();
    v.sasCustomDir.copy(escapeDir);
    while (specificEnergy(palla.mu, v.pos, v.vel) < 2000) {
      step();
      expect(game.time - t0, 'escape burn ran away').toBeLessThan(900);
      expect(fuel(), 'ran dry during escape').toBeGreaterThan(0);
    }
    v.controls.throttle = 0;

    // Coast out of the SOI on rails.
    game.setWarp(3, true);
    guard = 0;
    while (v.bodyId !== 'veyra' && guard++ < 20_000) game.update(0.1);
    game.setWarp(0, false);
    expect(v.bodyId, 'never left Palla SOI').toBe('veyra');

    // ------------------------------------------------ lower periapsis to entry
    v.sas = 'retrograde';
    for (let i = 0; i < 300; i++) step();
    t0 = game.time;
    let entrySet = false;
    while (game.time - t0 < 900) {
      const els = stateToElements(veyra.mu, v.pos, v.vel, game.time);
      if (periapsisOf(els) < veyra.radius + 26_000) {
        entrySet = true;
        break;
      }
      v.controls.throttle = 1;
      step();
      if (fuel() <= 0) break;
    }
    v.controls.throttle = 0;
    expect(entrySet, 'could not lower periapsis for entry (fuel?)').toBe(true);

    // ------------------------------------------------ coast to atmosphere
    game.setWarp(3, true);
    guard = 0;
    while (v.pos.length() - veyra.radius > 82_000 && guard++ < 30_000) {
      game.update(0.1);
    }
    game.setWarp(0, false);

    // Jettison service stage; ride the shield down, then the chute.
    game.fireStage(gv); // decoupler: drop tanks + engine
    game.fireStage(gv); // arm chute
    v.sas = 'retrograde';
    t0 = game.time;
    let home = false;
    while (game.time - t0 < 3000) {
      step();
      if (!game.vessels.includes(gv)) {
        const localUp = v.pos.clone().normalize();
        const relative = v.vel.clone().sub(surfaceVelocity(veyra, v.pos, new Vec3()));
        const radial = relative.dot(localUp);
        const horizontal = relative.clone().addScaled(localUp, -radial).length();
        throw new Error(
          `destroyed during re-entry: radial=${radial.toFixed(3)} horizontal=${horizontal.toFixed(3)} ` +
          v.events.slice(-4).map((e) => e.text).join('; '),
        );
      }
      if (v.situation === 'landed' || v.situation === 'splashed') {
        home = true;
        break;
      }
    }
    expect(home, 'did not reach the ground in time').toBe(true);
    expect(v.craft.parts.some((p) => p.defId === 'pod-voyager')).toBe(true);
    expect(v.bodyId).toBe('veyra');
  }, 300_000);
});
