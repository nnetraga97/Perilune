import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import {
  inertialAttitudeToBodyFixed,
  inertialToBodyFixed,
} from '../src/sim/bodyOrientation';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';
import { restoreGame, serializeGame } from '../src/save/persistence';
import { SAVE_VERSION } from '../src/save/schema';

function buildLander() {
  const craft = createCraft('Save lander');
  addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

function quaternionDistance(a: Readonly<Quat>, b: Readonly<Quat>): number {
  return Math.min(
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w),
    Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w),
  );
}

describe('terrain-aware save migration', () => {
  it('stores and restores a landed pose in the body-fixed frame', () => {
    const game = new GameState();
    game.time = 4_321;
    const gv = game.spawnOnPad(buildLander(), 'Lander');
    const body = game.bodyOf(gv);
    const directionBefore = inertialToBodyFixed(body, game.time, gv.runtime.pos, new Vec3()).normalize();
    const attitudeBefore = inertialAttitudeToBodyFixed(
      body,
      game.time,
      gv.runtime.att,
      new Quat(),
    );

    const save = serializeGame(game, 'surface');
    expect(save.saveVersion).toBe(SAVE_VERSION);
    expect(save.vessels[0].surfacePose).toMatchObject({
      bodyId: 'veyra',
      recipeHash: expect.stringMatching(/^[a-f0-9]{32}$/),
      scatterRecipeHash: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    // The real scatter hash is distinct from the terrain hash it no longer aliases.
    expect(save.vessels[0].surfacePose!.scatterRecipeHash)
      .not.toBe(save.vessels[0].surfacePose!.recipeHash);

    const restored = restoreGame(JSON.parse(JSON.stringify(save)));
    const restoredBody = restored.bodyOf(restored.active!);
    const directionAfter = inertialToBodyFixed(
      restoredBody,
      restored.time,
      restored.active!.runtime.pos,
      new Vec3(),
    ).normalize();
    const attitudeAfter = inertialAttitudeToBodyFixed(
      restoredBody,
      restored.time,
      restored.active!.runtime.att,
      new Quat(),
    );
    expect(directionAfter.distanceTo(directionBefore)).toBeLessThan(1e-12);
    expect(quaternionDistance(attitudeAfter, attitudeBefore)).toBeLessThan(1e-12);
  });

  it('migrates a version 3 landed pose through the legacy Z-spin frame', () => {
    const game = new GameState();
    game.time = 4_321;
    const gv = game.spawnOnPad(buildLander(), 'Legacy lander');
    const body = game.bodyOf(gv);
    const directionBF = inertialToBodyFixed(body, game.time, gv.runtime.pos, new Vec3()).normalize();
    const radius = gv.runtime.pos.length();
    const attitudeBF = inertialAttitudeToBodyFixed(body, game.time, gv.runtime.att, new Quat());
    const spin = body.rotationAngle(game.time);
    const legacySpin = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), spin);
    const legacyPos = legacySpin.rotate(directionBF.clone().scale(radius), new Vec3());
    const legacyAtt = legacySpin.clone().multiply(attitudeBF);
    const save = serializeGame(game, 'legacy') as ReturnType<typeof serializeGame> & {
      vessels: Array<ReturnType<typeof serializeGame>['vessels'][number] & { surfacePose?: unknown }>;
    };
    save.saveVersion = 3;
    save.vessels[0].pos = { ...legacyPos };
    save.vessels[0].att = { ...legacyAtt };
    delete (save.vessels[0] as unknown as { surfacePose?: unknown }).surfacePose;

    const restored = restoreGame(JSON.parse(JSON.stringify(save)));
    const restoredDirection = inertialToBodyFixed(
      body,
      restored.time,
      restored.active!.runtime.pos,
      new Vec3(),
    ).normalize();
    expect(restoredDirection.distanceTo(directionBF)).toBeLessThan(1e-9);
    expect(restored.active!.runtime.pos.isFinite()).toBe(true);
  });

  it('rejects an unavailable terrain recipe before restoring vessels', () => {
    const game = new GameState();
    game.spawnOnPad(buildLander(), 'Unknown recipe');
    const save = serializeGame(game, 'unknown');
    save.vessels[0].surfacePose!.recipeHash = '0'.repeat(32);

    expect(() => restoreGame(save)).toThrow(/terrain recipe/i);
  });

  it('rejects an unavailable physical-scatter recipe', () => {
    const game = new GameState();
    game.spawnOnPad(buildLander(), 'Unknown scatter');
    const save = serializeGame(game, 'unknown scatter');
    save.vessels[0].surfacePose!.scatterRecipeHash = 'f'.repeat(32);

    expect(() => restoreGame(save)).toThrow(/scatter recipe/i);
  });

  it('migrates a version 4 save whose scatter hash aliased the terrain hash', () => {
    const game = new GameState();
    game.time = 4_321;
    const gv = game.spawnOnPad(buildLander(), 'V4 alias lander');
    const directionBefore = inertialToBodyFixed(game.bodyOf(gv), game.time, gv.runtime.pos, new Vec3()).normalize();
    const save = serializeGame(game, 'v4 alias') as ReturnType<typeof serializeGame>;
    // Recreate the version-4 shape: version 4 with scatter hash aliased to terrain.
    save.saveVersion = 4;
    save.vessels[0].surfacePose!.scatterRecipeHash = save.vessels[0].surfacePose!.recipeHash;

    const restored = restoreGame(JSON.parse(JSON.stringify(save)));
    const directionAfter = inertialToBodyFixed(
      restored.bodyOf(restored.active!),
      restored.time,
      restored.active!.runtime.pos,
      new Vec3(),
    ).normalize();
    expect(directionAfter.distanceTo(directionBefore)).toBeLessThan(1e-9);
    expect(restored.active!.runtime.pos.isFinite()).toBe(true);
  });
});
