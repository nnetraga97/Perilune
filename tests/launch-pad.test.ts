import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LaunchSiteVisual } from '../src/render/launchSiteVisual';
import { advancePadSequence, padDeployFractions } from '../src/sim/launchSequence';
import { validateLaunchDocument } from '../scripts/compile-launch-site';
import manifest from '../src/generated/launch-site-manifest.json';
import recipe from '../assets/launch-site/recipe.json';
import { createLegacyGameState, restoreLegacyGame } from './fixtures/legacyGameState';
import { createCraft, addPart } from '../src/sim/vessel';
import { serializeGame } from '../src/save/persistence';
import { validateSave } from '../src/save/schema';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { launchSiteDirection } from '../src/sim/launchSite';
import { Vec3 } from '../src/core/vec3';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

describe('launch pad safety and asset contract', () => {
  it('keeps the held rocket on the rotating Earth pad at the rendered time', () => {
    const game = new GameState('sandbox');
    const craft = createCraft('Earth pad alignment');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const vessel = game.spawnOnPad(craft, craft.name);
    const body = game.bodyOf(vessel);
    for (let i = 0; i < 300; i++) {
      game.update(PHYSICS_DT);
      const expected = launchSiteDirection(body, game.time, new Vec3()).scale(vessel.runtime.pos.length());
      expect(vessel.runtime.pos.distanceTo(expected)).toBeLessThan(.001);
    }
  });
  it('holds for clearance, handles aborts, and stays released', () => {
    const sequence = { startedAt: null, releasedAt: null };
    expect(advancePadSequence(sequence, 10, true)).toBe(false);
    expect(padDeployFractions(sequence, 11)['crew-access']).toBeCloseTo(.4);
    expect(padDeployFractions(sequence, 11)['clamp-ne']).toBe(0);
    expect(advancePadSequence(sequence, 12, false)).toBe(false);
    expect(sequence.startedAt).toBeNull();
    expect(advancePadSequence(sequence, 20, true)).toBe(false);
    expect(advancePadSequence(sequence, 23.99, true)).toBe(false);
    expect(advancePadSequence(sequence, 24, true)).toBe(true);
    expect(Object.values(padDeployFractions(sequence, 24))).toEqual(Array(7).fill(1));
    expect(advancePadSequence(sequence, 25, false)).toBe(true);
    expect(sequence.releasedAt).toBe(24);
  });
  it('resumes a saved clearance sequence and rejects invalid timestamps', () => {
    const game = createLegacyGameState();
    const craft = createCraft('Pad save');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const vessel = game.spawnOnPad(craft, craft.name);
    game.time = 12; vessel.runtime.padSequence = { startedAt: 10, releasedAt: null };
    const save = serializeGame(game, 'pad');
    expect(validateSave(save)).toBe(true);
    expect(restoreLegacyGame(save).active!.runtime.padSequence).toEqual(vessel.runtime.padSequence);
    save.vessels[0].padSequence!.releasedAt = 9;
    expect(validateSave(save)).toBe(false);
  });
  it('exports the seven rigid clips within the separate pad budget', async () => {
    const bytes = readFileSync('public/launch-site/launch-pad.glb');
    expect(bytes.length).toBe(manifest.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
    expect(bytes.length).toBeLessThanOrEqual(recipe.transferByteLimit);
    expect(manifest.gpuBytes).toBeLessThanOrEqual(recipe.gpuByteLimit);
    const doc = await new NodeIO().readBinary(bytes);
    expect(validateLaunchDocument(doc).triangles).toBe(manifest.triangles);
    doc.getRoot().listAnimations()[0].dispose();
    expect(() => validateLaunchDocument(doc)).toThrow('clip count');
  });
  it('scrubs deterministic endpoints and preserves fallback on failure', async () => {
    const scene = new THREE.Group();
    const animations = manifest.clips.map(name => {
      const joint = new THREE.Group(); joint.name = name; scene.add(joint);
      return new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack(`${name}.position[x]`, [0, 1], [0, 10])]);
    });
    const pad = new LaunchSiteVisual(undefined, async () => ({ scene, animations } as unknown as GLTF));
    await pad.ready;
    expect(pad.status).toBe('ready');
    for (const fraction of [0, .5, 1, 0, 1]) {
      pad.setDeployFraction('crew-access', fraction);
      expect(pad.root.getObjectByName('crew-access')!.position.x).toBeCloseTo(fraction * 10);
    }
    pad.dispose();
    const fallback = new LaunchSiteVisual(undefined, async () => { throw new Error('checksum mismatch'); });
    await fallback.ready;
    expect(fallback.status).toBe('fallback');
    expect(fallback.foundation.geometry.index!.count).toBeGreaterThan(0);
    expect(fallback.root.children.every(child => child.visible)).toBe(true);
    fallback.dispose();
  });
});
