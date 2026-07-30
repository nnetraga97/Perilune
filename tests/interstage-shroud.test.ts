import { createLegacyGameState, restoreLegacyGame } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createFirstLightRocket,
  createOdysseyOrbiter,
  createWayfarerDemonstrator,
} from '../src/content/crafts';
import { buildInterstageShroud, interstageShroudGeometry } from '../src/render/interstageShroud';
import { buildVesselVisual, disposeVesselVisual } from '../src/render/vesselMesh';
import { restoreGame, serializeGame, validateCraftFile } from '../src/save/persistence';
import { GameState } from '../src/sim/state';
import { deriveInterstageShroud, sanitizeInterstageShroudSpec } from '../src/sim/interstage';

describe('detachable interstage shroud', () => {
  it('builds a bounded, UV-mapped 1,152-triangle closed shell', () => {
    const craft = createWayfarerDemonstrator();
    const separator = craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    const spec = deriveInterstageShroud(craft, separator)!;
    const geometry = interstageShroudGeometry(spec);
    expect(geometry.index!.count / 3).toBe(1152);
    expect(geometry.getAttribute('uv')).toBeDefined();
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.boundingBox?.min.y).toBeCloseTo(spec.lowerY);
    expect(geometry.boundingBox?.max.y).toBeCloseTo(spec.upperY);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(spec.lowerRadius);
    expect(buildInterstageShroud(spec)).toBeInstanceOf(THREE.Mesh);
  });

  it('renders the shell under the separator holder without creating a synthetic part', () => {
    const craft = createWayfarerDemonstrator();
    const separator = craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    const visual = buildVesselVisual(craft);
    const holder = visual.partMeshes.get(separator.key)!;
    const shrouds: THREE.Object3D[] = [];
    holder.traverse((object) => {
      if (object.userData.interstageShroud) shrouds.push(object);
    });
    expect(shrouds).toHaveLength(1);
    expect(visual.partMeshes.size).toBe(craft.parts.length);
    disposeVesselVisual(visual);
  });

  it('automatically fits a cylindrical shroud to the Wayfarer Separator M', () => {
    const craft = createOdysseyOrbiter();
    const separator = craft.parts.find((part) => part.defId === 'dec-m')!;
    const spec = deriveInterstageShroud(craft, separator);

    expect(spec).toEqual({
      lowerRadius: 1.25,
      upperRadius: 1.25,
      lowerY: expect.closeTo(-0.1, 8),
      upperY: expect.closeTo(1.6, 8),
    });
    const visual = buildVesselVisual(craft);
    expect(visual.partMeshes.get(separator.key)!.getObjectByName('SM_Runtime_InterstageShroud')).toBeDefined();
    disposeVesselVisual(visual);
  });

  it('fits the Ring Separator S around an attached engine without shrouding the capsule ring', () => {
    const craft = createFirstLightRocket();
    const separators = craft.parts.filter((part) => part.defId === 'dec-s');
    const engineSeparator = separators.find((separator) => (
      craft.parts.find((part) => part.key === separator.parentKey)?.defId === 'eng-ember'
    ))!;
    const capsuleSeparator = separators.find((separator) => separator !== engineSeparator)!;
    const spec = deriveInterstageShroud(craft, engineSeparator);

    expect(spec).toEqual({
      lowerRadius: 0.6,
      upperRadius: 0.6,
      lowerY: expect.closeTo(-0.08, 8),
      upperY: expect.closeTo(0.98, 8),
    });
    expect(deriveInterstageShroud(craft, capsuleSeparator)).toBeNull();

    const visual = buildVesselVisual(craft);
    expect(visual.partMeshes.get(engineSeparator.key)!
      .getObjectByName('SM_Runtime_InterstageShroud')).toBeDefined();
    expect(visual.partMeshes.get(capsuleSeparator.key)!
      .getObjectByName('SM_Runtime_InterstageShroud')).toBeUndefined();
    disposeVesselVisual(visual);
  });

  it('keeps the Ring Separator S shroud attached after staging and a save round-trip', () => {
    const game = createLegacyGameState();
    const craft = createFirstLightRocket();
    const launched = game.spawnOnPad(craft, craft.name);
    for (let stage = 0; stage < 5; stage++) expect(game.fireStage(launched)).toBe(true);

    const shroudedRingVessel = game.vessels.find((vessel) => (
      vessel.runtime.craft.parts.some((part) => (
        part.defId === 'dec-s'
        && sanitizeInterstageShroudSpec(part.interstageShroud) !== null
      ))
    ))!;
    const shroudedRing = shroudedRingVessel.runtime.craft.parts.find((part) => (
      part.defId === 'dec-s'
      && sanitizeInterstageShroudSpec(part.interstageShroud) !== null
    ))!;
    expect(shroudedRing.activated).toBe(true);

    const restored = restoreLegacyGame(serializeGame(game, 'ring separator shroud round trip'));
    const restoredRing = restored.vessels
      .flatMap((vessel) => vessel.runtime.craft.parts)
      .find((part) => part.key === shroudedRing.key)!;
    expect(restoredRing.interstageShroud).toEqual(shroudedRing.interstageShroud);
  });

  it('keeps the Separator M shroud attached after staging and a save round-trip', () => {
    const game = createLegacyGameState();
    const craft = createOdysseyOrbiter();
    const launched = game.spawnOnPad(craft, craft.name);
    expect(game.fireStage(launched)).toBe(true);
    expect(game.fireStage(launched)).toBe(true);
    expect(game.fireStage(launched)).toBe(true);

    const ringVessel = game.vessels.find((vessel) =>
      vessel.runtime.craft.parts.some((part) => part.defId === 'dec-m'))!;
    const ring = ringVessel.runtime.craft.parts.find((part) => part.defId === 'dec-m')!;
    expect(ring.activated).toBe(true);
    expect(sanitizeInterstageShroudSpec(ring.interstageShroud)).toEqual({
      lowerRadius: 1.25,
      upperRadius: 1.25,
      lowerY: expect.closeTo(-0.1, 8),
      upperY: expect.closeTo(1.6, 8),
    });

    const ringVisual = buildVesselVisual(ringVessel.runtime.craft);
    expect(ringVisual.partMeshes.get(ring.key)!.getObjectByName('SM_Runtime_InterstageShroud')).toBeDefined();
    disposeVesselVisual(ringVisual);

    const restored = restoreLegacyGame(serializeGame(game, 'separator M shroud round trip'));
    const restoredRing = restored.vessels
      .flatMap((vessel) => vessel.runtime.craft.parts)
      .find((part) => part.defId === 'dec-m')!;
    expect(restoredRing.interstageShroud).toEqual(ring.interstageShroud);
  });

  it('latches the shroud before separation and preserves it on one debris component and save round-trip', () => {
    const game = createLegacyGameState();
    const craft = createWayfarerDemonstrator();
    const launched = game.spawnOnPad(craft, craft.name);
    expect(game.fireStage(launched)).toBe(true);
    expect(game.fireStage(launched)).toBe(true);
    expect(game.fireStage(launched)).toBe(true);

    const ringVessel = game.vessels.find((vessel) =>
      vessel.runtime.craft.parts.some((part) => part.defId === 'dec-interstage-ms'))!;
    const ring = ringVessel.runtime.craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    expect(ring.activated).toBe(true);
    expect(sanitizeInterstageShroudSpec(ring.interstageShroud)).not.toBeNull();

    const ringVisual = buildVesselVisual(ringVessel.runtime.craft);
    expect(ringVisual.partMeshes.get(ring.key)!.getObjectByName('SM_Runtime_InterstageShroud')).toBeDefined();
    disposeVesselVisual(ringVisual);

    const restored = restoreLegacyGame(serializeGame(game, 'interstage round trip'));
    const restoredRing = restored.vessels
      .flatMap((vessel) => vessel.runtime.craft.parts)
      .find((part) => part.defId === 'dec-interstage-ms')!;
    expect(restoredRing.interstageShroud).toEqual(ring.interstageShroud);
  });

  it('rejects malformed shared-craft shroud dimensions', () => {
    const craft = createWayfarerDemonstrator();
    const separator = craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    separator.interstageShroud = {
      lowerRadius: 1.25,
      upperRadius: 0.6,
      lowerY: 0,
      upperY: Number.POSITIVE_INFINITY,
    };
    expect(validateCraftFile(JSON.parse(JSON.stringify(craft)))).toBeNull();
  });
});
