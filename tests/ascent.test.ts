/**
 * Integration test: a reference rocket flies a scripted gravity turn from
 * the Veyra launch pad to a stable orbit, then executes a deorbit burn and
 * descends under parachute. Exercises the full physics stack — pad spawn,
 * thrust, fuel flow, staging with debris split, aerodynamic drag, SAS,
 * SOI-safe integration, rails warp, and situation detection.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';
import { stateToElements, periapsisOf, apoapsisOf } from '../src/core/orbit';
import { ascentGuidance } from '../src/sim/guidance';

function buildOrbiter(): Craft {
  const craft = createCraft('Ascent Reference');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 11.4, z: 0 });
  addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 12.1, z: 0 });
  const shield = addPart(craft, 'shield-s', pod.key, 'stack-bottom', { x: 0, y: 10.9, z: 0 });
  const decPod = addPart(craft, 'dec-s', shield.key, 'stack-bottom', { x: 0, y: 10.55, z: 0 });
  const tankU = addPart(craft, 'tank-s4', decPod.key, 'stack-bottom', { x: 0, y: 9.0, z: 0 });
  const engU = addPart(craft, 'eng-aspen', tankU.key, 'stack-bottom', { x: 0, y: 6.9, z: 0 });
  const dec = addPart(craft, 'dec-s', engU.key, 'stack-bottom', { x: 0, y: 6.3, z: 0 });
  const tankL = addPart(craft, 'tank-m8', dec.key, 'stack-bottom', { x: 0, y: 4.2, z: 0 });
  const engL = addPart(craft, 'eng-mule', tankL.key, 'stack-bottom', { x: 0, y: 1.4, z: 0 });
  // Fins for ascent stability, rotated so their normals point tangentially.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    addPart(
      craft,
      'fin-swift',
      tankL.key,
      'surface',
      { x: Math.cos(a) * 1.3, y: 2.6, z: Math.sin(a) * 1.3 },
      { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }, // rotate about Y
    );
  }
  craft.stages = [
    { partKeys: [engL.key] },
    { partKeys: [dec.key, engU.key] },
    { partKeys: [decPod.key] }, // jettison service stage before entry
    { partKeys: [craft.parts.find((p) => p.defId === 'chute-main')!.key] },
  ];
  return craft;
}

function elementsOf(game: GameState) {
  const gv = game.active!;
  const body = game.bodyOf(gv);
  return stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, game.time);
}

describe('full ascent to orbit', () => {
  it('flies a gravity turn to a stable orbit, deorbits, and lands', () => {
    const game = new GameState();
    const gv = game.spawnOnPad(buildOrbiter(), 'Ascent Reference');
    const v = gv.runtime;
    const veyra = game.bodyOf(gv);

    // --- pad stability: 5 seconds untouched, must not sink or drift.
    for (let i = 0; i < 250; i++) game.update(PHYSICS_DT);
    expect(['prelaunch', 'landed']).toContain(v.situation);
    const padAlt = v.pos.length() - veyra.radius;
    expect(padAlt).toBeGreaterThan(0);
    expect(Number.isFinite(padAlt)).toBe(true);

    // --- launch!
    v.controls.throttle = 1;
    game.fireStage(gv); // ignite main engine
    v.sas = 'stability';

    const step = () => game.update(PHYSICS_DT);
    let t = 0;
    const maxT = 900; // s
    let stagedUpper = false;
    let cutoff = false;

    // Stage when the current stage flames out under open throttle.
    const maybeStage = () => {
      if (
        !stagedUpper &&
        v.controls.throttle > 0 &&
        v.properAccel < 0.5 &&
        v.pos.length() - veyra.radius > 10_000
      ) {
        game.fireStage(gv); // separation + upper ignition
        stagedUpper = true;
      }
    };

    const up = new Vec3();
    while (t < maxT) {
      step();
      t += PHYSICS_DT;
      const r = v.pos.length();
      const alt = r - veyra.radius;
      expect(v.pos.isFinite(), `NaN position at t=${t.toFixed(1)}`).toBe(true);
      expect(game.vessels.includes(gv), `vessel destroyed at t=${t.toFixed(1)} alt=${alt.toFixed(0)}`).toBe(true);

      // Gravity-turn guidance (the real game module).
      const cmd = ascentGuidance(v, veyra);
      v.sas = 'custom';
      v.sasCustomDir.copy(cmd.dir);

      // Throttle management: cap proper acceleration at ~2.2g so we don't
      // scream through the lower atmosphere at plasma speeds.
      if (v.properAccel > 26) {
        v.controls.throttle = Math.max(0.35, v.controls.throttle - 0.02);
      } else if (v.controls.throttle < 1) {
        v.controls.throttle = Math.min(1, v.controls.throttle + 0.01);
      }

      maybeStage();

      // Cutoff when apoapsis reaches 95 km.
      const el = elementsOf(game);
      if (!cutoff && el.e < 1 && apoapsisOf(el) > veyra.radius + 105_000) {
        v.controls.throttle = 0;
        cutoff = true;
        break;
      }
    }
    expect(cutoff, 'never reached target apoapsis').toBe(true);

    // --- coast to apoapsis (physics warp is enough here: ~ minutes).
    // Use rails warp: switch when out of atmosphere.
    while (v.pos.length() - veyra.radius < 95_000) {
      step();
      t += PHYSICS_DT;
      expect(t).toBeLessThan(maxT);
    }

    // Circularize: burn prograde near apoapsis until periapsis > 85 km.
    let burned = false;
    let lastRadial = v.vel.dot(up.copy(v.pos).normalize());
    while (t < maxT) {
      step();
      t += PHYSICS_DT;
      up.copy(v.pos).normalize();
      const vRad = v.vel.dot(up);
      const nearApo = vRad < 8 && lastRadial >= vRad - 1e9; // approaching apo
      lastRadial = vRad;
      const el = elementsOf(game);
      const pe = periapsisOf(el);
      if (pe > veyra.radius + 85_000) {
        v.controls.throttle = 0;
        burned = true;
        break;
      }
      // Light well before apoapsis (long low-thrust circularization) and
      // keep thrusting prograde through it.
      if (vRad < 150) {
        v.sas = 'prograde';
        v.controls.throttle = 1;
      }
      maybeStage();
      expect(game.vessels.includes(gv), `destroyed during circularization at t=${t.toFixed(0)}`).toBe(true);
    }
    expect(burned, 'circularization did not complete').toBe(true);
    expect(stagedUpper, 'never needed the upper stage?').toBe(true);

    // --- verify stable orbit
    for (let i = 0; i < 500; i++) step();
    const el = elementsOf(game);
    expect(el.e).toBeLessThan(0.12);
    expect(periapsisOf(el) - veyra.radius).toBeGreaterThan(85_000);
    expect(v.situation).toBe('orbit');

    // --- rails warp around the planet: a third of an orbit in one call set
    game.setWarp(3, true);
    expect(game.railsWarp).toBe(true);
    const warpStart = game.time;
    for (let i = 0; i < 120; i++) game.update(0.1); // 100Hz UI frames
    expect(game.time - warpStart).toBeGreaterThan(600); // warped far ahead
    game.setWarp(0, false);
    expect(gv.regime).toBe('active');
    expect(v.pos.isFinite()).toBe(true);
    // Orbit preserved across regime switches.
    const el2 = elementsOf(game);
    expect(Math.abs(el2.a - el.a) / el.a).toBeLessThan(0.01);

    // --- deorbit: retrograde burn until periapsis dips deep into atmosphere.
    v.sas = 'retrograde';
    for (let i = 0; i < 150; i++) step(); // settle attitude
    v.controls.throttle = 1;
    let deorbited = false;
    let tb = 0;
    while (tb < 300) {
      step();
      tb += PHYSICS_DT;
      const el3 = elementsOf(game);
      if (periapsisOf(el3) < veyra.radius + 30_000) {
        v.controls.throttle = 0;
        deorbited = true;
        break;
      }
    }
    expect(deorbited, 'deorbit burn failed (out of fuel?)').toBe(true);

    // --- jettison the spent service stage, then arm the chute.
    game.fireStage(gv); // drop tank + engine
    game.fireStage(gv); // arm chute
    v.sas = 'retrograde';
    let td = 0;
    const maxDescent = 4000;
    while (td < maxDescent) {
      step();
      td += PHYSICS_DT;
      if (!game.vessels.includes(gv)) {
        const log = v.events.slice(-8).map((e) => `[${e.time.toFixed(1)}] ${e.text}`).join('; ');
        throw new Error(`vessel destroyed during re-entry/landing at td=${td.toFixed(1)}: ${log}`);
      }
      if (v.situation === 'landed' || v.situation === 'splashed') break;
    }
    expect(['landed', 'splashed']).toContain(v.situation);
    // Pod survived; crew home.
    expect(v.craft.parts.some((p) => p.defId === 'pod-voyager')).toBe(true);
  }, 120_000);
});

function flyReferenceEntry(withShield: boolean): { alive: boolean; situation: string } {
  const craft = createCraft(withShield ? 'Shielded Capsule' : 'Bare Capsule');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 0.7, z: 0 });
  if (withShield) addPart(craft, 'shield-s', pod.key, 'stack-bottom', { x: 0, y: -0.55, z: 0 });
  craft.stages = [{ partKeys: [chute.key] }];

  const game = new GameState();
  const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
  const vessel = gv.runtime;
  vessel.sas = 'retrograde';
  for (let i = 0; i < 300; i++) game.update(PHYSICS_DT);
  vessel.pos.set(1_082_000, 0, 0);
  vessel.vel.set(-250, 2_700, 0);
  game.fireStage(gv);

  for (
    let i = 0;
    i < 150_000 && game.vessels.includes(gv) && vessel.situation !== 'landed' && vessel.situation !== 'splashed';
    i++
  ) {
    game.update(PHYSICS_DT);
  }
  return { alive: game.vessels.includes(gv), situation: vessel.situation };
}

describe('foundations-tier orbital return', () => {
  it('requires an Emberguard for the reference Veyra entry', () => {
    expect(flyReferenceEntry(false)).toMatchObject({ alive: false, situation: 'destroyed' });
    expect(flyReferenceEntry(true)).toMatchObject({ alive: true });
  });
});
