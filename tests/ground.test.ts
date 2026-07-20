import { createLegacyGameState } from './fixtures/legacyGameState';
/**
 * Ground vehicles: motorized wheels (drive, brake, steer), free-rolling
 * landing gear, and the air-breathing jet engine. Exercises the multi-point
 * wheel contact model on rotating terrain.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT, launchSiteDirection } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';
import { partById, PARTS, RESOURCE_DENSITY } from '../src/content/parts';
import { groundRadiusInertial } from '../src/sim/terrain';
import type { GameVessel } from '../src/sim/state';
import { surfaceVelocity } from '../src/sim/bodyOrientation';

// ---------------------------------------------------------------- helpers

/** Four-wheeled rover: probe core on a plate chassis, wheels on the belly. */
function buildRover(): Craft {
  const craft = createCraft('Test Rover');
  const plate = addPart(craft, 'plate-base', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'core-pilot', plate.key, 'stack-top', { x: 0, y: 0.2, z: 0 });
  addPart(craft, 'batt-s', plate.key, 'surface', { x: 0, y: 0, z: 0.2 });
  // Wheels on the belly (craft −Z side), at the four corners.
  for (const [x, y] of [
    [-0.8, 0.7],
    [0.8, 0.7],
    [-0.8, -0.7],
    [0.8, -0.7],
  ]) {
    addPart(craft, 'wheel-scout', plate.key, 'surface', { x, y, z: -0.55 });
  }
  return craft;
}

/**
 * Place a craft landed on Veyra near the launch site, oriented so craft +Y
 * (nose/forward) is horizontal and craft +Z points at the sky — the rover
 * pose. Returns the vessel.
 */
function spawnRoverLanded(game: GameState, craft: Craft): GameVessel {
  const gv = game.spawnOnPad(craft, craft.name);
  const v = gv.runtime;
  const veyra = game.bodyOf(gv);
  const up = launchSiteDirection(veyra, game.time, new Vec3());
  const east = new Vec3(-up.y, up.x, 0).normalize();
  // setLookRotation points +Z at `forward` and +Y at `up`:
  // rover wants +Z = sky, +Y = east (drive direction).
  v.att.setLookRotation(up, east);
  const ground = groundRadiusInertial(veyra, up, game.time);
  v.pos.copy(up).scale(ground + 1.0);
  surfaceVelocity(veyra, v.pos, v.vel);
  v.situation = 'landed';
  v.sas = 'off';
  return gv;
}

/** Ground-relative speed (m/s). */
function groundSpeed(game: GameState, gv: GameVessel): number {
  const v = gv.runtime;
  const body = game.bodyOf(gv);
  const wind = surfaceVelocity(body, v.pos, new Vec3());
  return new Vec3().copy(v.vel).sub(wind).length();
}

/** Heading of craft +Y projected on the local tangent plane (rad). */
function heading(gv: GameVessel): number {
  const v = gv.runtime;
  const up = v.pos.clone().normalize();
  const fwd = v.att.rotate(new Vec3(0, 1, 0), new Vec3());
  fwd.addScaled(up, -fwd.dot(up)).normalize();
  // Express in an arbitrary fixed tangent basis.
  const e1 = new Vec3(-up.y, up.x, 0).normalize();
  const e2 = Vec3.cross(up, e1, new Vec3());
  return Math.atan2(fwd.dot(e2), fwd.dot(e1));
}

// ------------------------------------------------------------------ tests

describe('part catalog: ground & ISRU families', () => {
  it('defines the new parts with sane fields', () => {
    const wheel = partById('wheel-scout');
    expect(wheel.wheel).toBeDefined();
    expect(wheel.wheel!.driveForce).toBeGreaterThan(0);
    expect(wheel.wheel!.radius).toBeGreaterThan(0);
    expect(wheel.wheel!.steering).toBe(true);

    const big = partById('wheel-mesa');
    expect(big.wheel!.driveForce).toBeGreaterThan(wheel.wheel!.driveForce);

    const gear = partById('gear-skid');
    expect(gear.wheel).toBeDefined();
    expect(gear.wheel!.driveForce).toBe(0); // free-rolling
    expect(gear.wheel!.brakeForce).toBeGreaterThan(0);

    expect(partById('drill-auger').drill).toBeDefined();
    expect(partById('conv-kiln').converter).toBeDefined();
    expect(partById('scan-prospector').resourceScanner).toBeDefined();
    expect(partById('bin-ore').oreCapacity).toBeGreaterThan(0);
    expect(RESOURCE_DENSITY.ore).toBeGreaterThan(0);

    const delta = partById('wing-delta');
    expect(delta.wing!.liftArea).toBeGreaterThan(partById('wing-span').wing!.liftArea);
    expect(partById('ctrl-elevon').wing!.control).toBe(true);

    const jet = partById('eng-whirl');
    expect(jet.engine).toBeDefined();
    expect(jet.engine!.airBreathing).toBe(true);

    // Every part still has a well-formed category (editor tab coverage).
    const cats = new Set([
      'pods', 'tanks', 'engines', 'coupling', 'structural',
      'aero', 'utility', 'science', 'thermal', 'ground',
    ]);
    for (const p of PARTS) expect(cats.has(p.category), `bad category on ${p.id}`).toBe(true);
  });
});

describe('rover wheel physics', () => {
  it('rests stably on wheels without drifting or exploding', () => {
    const game = createLegacyGameState();
    const gv = spawnRoverLanded(game, buildRover());
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT); // 10 s
    expect(game.vessels.includes(gv)).toBe(true);
    expect(gv.runtime.pos.isFinite()).toBe(true);
    expect(groundSpeed(game, gv)).toBeLessThan(0.5);
    expect(['landed', 'prelaunch']).toContain(gv.runtime.situation);
  });

  it('drives forward under wheel power and brakes to a stop', () => {
    const game = createLegacyGameState();
    const gv = spawnRoverLanded(game, buildRover());
    const v = gv.runtime;
    for (let i = 0; i < 100; i++) game.update(PHYSICS_DT); // settle

    v.controls.wheelDrive = 1;
    for (let i = 0; i < 1500; i++) game.update(PHYSICS_DT); // 30 s
    expect(game.vessels.includes(gv), 'rover crashed while driving').toBe(true);
    const cruise = groundSpeed(game, gv);
    expect(cruise).toBeGreaterThan(4);
    // Still roughly upright: craft +Z near local up.
    const up = v.pos.clone().normalize();
    const zAxis = v.att.rotate(new Vec3(0, 0, 1), new Vec3());
    expect(zAxis.dot(up)).toBeGreaterThan(0.7);

    // Brake.
    v.controls.wheelDrive = 0;
    v.controls.brake = true;
    for (let i = 0; i < 1000; i++) game.update(PHYSICS_DT); // 20 s
    expect(groundSpeed(game, gv)).toBeLessThan(0.6);
    expect(gv.runtime.pos.isFinite()).toBe(true);
  });

  it('steers: opposite steer inputs turn the heading opposite ways', () => {
    const run = (steer: number): number => {
      const game = createLegacyGameState();
      const gv = spawnRoverLanded(game, buildRover());
      const v = gv.runtime;
      for (let i = 0; i < 100; i++) game.update(PHYSICS_DT);
      v.controls.wheelDrive = 1;
      for (let i = 0; i < 500; i++) game.update(PHYSICS_DT); // get rolling
      const h0 = heading(gv);
      v.controls.wheelSteer = steer;
      for (let i = 0; i < 125; i++) game.update(PHYSICS_DT); // 2.5 s of turning
      expect(game.vessels.includes(gv), 'rover crashed while steering').toBe(true);
      // Still upright: steering must not roll the rover in this window.
      const up = v.pos.clone().normalize();
      const zAxis = v.att.rotate(new Vec3(0, 0, 1), new Vec3());
      expect(zAxis.dot(up)).toBeGreaterThan(0.6);
      let dh = heading(gv) - h0;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      return dh;
    };
    const left = run(1);
    const right = run(-1);
    expect(Math.abs(left)).toBeGreaterThan(0.12);
    expect(Math.abs(left)).toBeLessThan(2.5);
    expect(Math.abs(right)).toBeGreaterThan(0.12);
    expect(Math.abs(right)).toBeLessThan(2.5);
    expect(Math.sign(left)).not.toBe(Math.sign(right));
  });
});

describe('air-breathing engine', () => {
  it('produces thrust in the atmosphere but not in vacuum', () => {
    const buildJetSled = (): Craft => {
      const craft = createCraft('Jet Sled');
      const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 1.2, z: 0 });
      const tank = addPart(craft, 'tank-s1', core.key, 'stack-bottom', { x: 0, y: 0.5, z: 0 });
      const eng = addPart(craft, 'eng-whirl', tank.key, 'stack-bottom', { x: 0, y: -0.6, z: 0 });
      craft.stages = [{ partKeys: [eng.key] }];
      return craft;
    };

    // On the pad: jet at full throttle must push (properAccel from thrust).
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(buildJetSled(), 'Jet Sled');
    const v = gv.runtime;
    v.controls.throttle = 1;
    game.fireStage(gv);
    let peakAccel = 0;
    for (let i = 0; i < 250; i++) {
      game.update(PHYSICS_DT);
      peakAccel = Math.max(peakAccel, v.properAccel);
    }
    expect(peakAccel).toBeGreaterThan(1);

    // In orbit (vacuum): same craft, throttle up — no thrust.
    const game2 = createLegacyGameState();
    const gv2 = game2.spawnInOrbit(buildJetSled(), 'Vacuum Sled', 'veyra', 120_000);
    const v2 = gv2.runtime;
    v2.controls.throttle = 1;
    game2.fireStage(gv2);
    let peakVac = 0;
    for (let i = 0; i < 250; i++) {
      game2.update(PHYSICS_DT);
      peakVac = Math.max(peakVac, v2.properAccel);
    }
    expect(peakVac).toBeLessThan(0.05);
    // And it must not have consumed propellant in vacuum.
    const tank = v2.craft.parts.find((p) => p.defId === 'tank-s1')!;
    expect(tank.resources.propellant).toBeCloseTo(180, 0);
  });
});
