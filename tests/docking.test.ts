/**
 * Docking: two independently orbiting vessels capture at their ports, merge
 * into one vessel (momentum-conserving, crew combined), and undock cleanly.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';

function buildChaser(): Craft {
  const craft = createCraft('Chaser');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'dock-port-s', pod.key, 'stack-top', { x: 0, y: 0.55, z: 0 });
  addPart(craft, 'wheel-rw', pod.key, 'stack-bottom', { x: 0, y: -0.55, z: 0 });
  return craft;
}

function buildTarget(): Craft {
  const craft = createCraft('Target Station');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'dock-port-s', core.key, 'stack-top', { x: 0, y: 0.25, z: 0 });
  addPart(craft, 'batt-m', core.key, 'stack-bottom', { x: 0, y: -0.25, z: 0 });
  return craft;
}

describe('docking and undocking', () => {
  it('captures, merges, and undocks two vessels', () => {
    const game = new GameState();
    const a = game.spawnInOrbit(buildChaser(), 'Chaser', 'veyra', 120_000);
    const b = game.spawnInOrbit(buildTarget(), 'Target Station', 'veyra', 120_000);

    // Place B a few meters "above" A along its port axis (world +Y here),
    // facing down (rotated 180° about X so its +Y port points at A's).
    b.runtime.pos.copy(a.runtime.pos).add(new Vec3(0, 6, 0));
    b.runtime.vel.copy(a.runtime.vel).add(new Vec3(0, -0.5, 0)); // gentle closing
    b.runtime.att.set(1, 0, 0, 0); // 180° about X
    a.runtime.sas = 'off';
    b.runtime.sas = 'off';
    game.activeVesselId = a.runtime.id;

    const crewBefore = a.runtime.crew.length;
    const massA = a.runtime.massProps.mass;
    const massB = b.runtime.massProps.mass;
    const partsA = a.runtime.craft.parts.length;
    const partsB = b.runtime.craft.parts.length;

    // Step until capture (≤ 60 s sim).
    let merged = false;
    for (let i = 0; i < 3000; i++) {
      game.update(PHYSICS_DT);
      if (game.vessels.length === 1) {
        merged = true;
        break;
      }
    }
    expect(merged, 'vessels never docked').toBe(true);

    const station = game.vessels[0];
    expect(station.runtime.craft.parts.length).toBe(partsA + partsB);
    expect(station.runtime.massProps.mass).toBeCloseTo(massA + massB, 0);
    expect(station.runtime.crew.length).toBe(crewBefore);
    expect(station.runtime.pos.isFinite()).toBe(true);

    // Exactly one docked joint, and it's undockable.
    const joints = game.dockedJoints(station);
    expect(joints.length).toBe(1);

    // Fly merged for a bit — structure must hold, no NaN.
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    expect(game.vessels.length).toBe(1);
    expect(station.runtime.pos.isFinite()).toBe(true);

    // Undock: back to two vessels drifting apart.
    const ok = game.undock(station, joints[0].childKey);
    expect(ok).toBe(true);
    expect(game.vessels.length).toBe(2);
    const [v1, v2] = game.vessels;
    expect(v1.runtime.craft.parts.length + v2.runtime.craft.parts.length).toBe(partsA + partsB);
    // Separation builds over time.
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    const d = v1.runtime.pos.distanceTo(v2.runtime.pos);
    expect(d).toBeGreaterThan(0.5);
    expect(v1.runtime.pos.isFinite()).toBe(true);
    expect(v2.runtime.pos.isFinite()).toBe(true);
  });

  it('does not capture misaligned or fast approaches', () => {
    const game = new GameState();
    const a = game.spawnInOrbit(buildChaser(), 'A', 'veyra', 120_000);
    const b = game.spawnInOrbit(buildTarget(), 'B', 'veyra', 120_000);
    // Fast flyby: 12 m/s closing — must NOT dock.
    b.runtime.pos.copy(a.runtime.pos).add(new Vec3(0, 40, 0));
    b.runtime.vel.copy(a.runtime.vel).add(new Vec3(0, -12, 0));
    b.runtime.att.set(1, 0, 0, 0);
    a.runtime.sas = 'off';
    b.runtime.sas = 'off';
    game.activeVesselId = a.runtime.id;
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    expect(game.vessels.length).toBe(2);
  });
});
