import { createLegacyGameState, restoreLegacyGame } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWayfarerDemonstrator } from '../src/content/crafts';
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
