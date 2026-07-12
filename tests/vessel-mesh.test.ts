import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addPart, createCraft } from '../src/sim/vessel';
import { PARTS, partById } from '../src/content/parts';
import { buildVesselVisual } from '../src/render/vesselMesh';
import type { PartModelLibrary, InstantiatedPartModel } from '../src/render/partModelLibrary';
import type { PartEffectAnchor } from '../src/render/partModelManifest';

const EXPECTED_MODEL_IDS: Record<string, string> = {
  'pod-voyager': 'orion-voyager-pod',
  'leg-lander': 'viking-stilt-leg',
  'eng-colt': 'apollo-colt-engine',
  'ant-dish': 'tdrs-longtalk-dish',
  'wheel-mesa': 'mars-mesa-wheel',
  'eng-mule': 'shuttle-mule-engine',
  'tank-s4': 'shuttle-pl400-tank',
  'chute-main': 'orion-homecoming-housing',
};

const ANCHOR_COUNTS: Record<string, number> = {
  'shuttle-mule-engine': 3,
  'apollo-colt-engine': 1,
};

function anchor(): PartEffectAnchor {
  return { position: [0, -0.2, 0], rotation: [0, 0, 0, 1], scale: 1 };
}

/** A fake library that hands out a tagged imported object, minus any `missing` assets. */
function fakeLibrary(missing: Set<string> = new Set()): PartModelLibrary {
  return {
    preload: async () => {},
    dispose() {},
    instantiateForPart: () => null,
    instantiate(assetId: string): InstantiatedPartModel | null {
      if (missing.has(assetId)) return null;
      const object = new THREE.Group();
      object.userData.importedTag = assetId;
      object.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
      const count = ANCHOR_COUNTS[assetId] ?? 0;
      return { object, plumeAnchors: Array.from({ length: count }, anchor) };
    },
  };
}

function meshCount(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) count++;
  });
  return count;
}

describe('part definitions', () => {
  it('carry the exact model IDs and only on the eight scoped parts', () => {
    for (const [partId, assetId] of Object.entries(EXPECTED_MODEL_IDS)) {
      expect(partById(partId)?.modelAssetId).toBe(assetId);
    }
    for (const def of PARTS) {
      if (!(def.id in EXPECTED_MODEL_IDS)) expect(def.modelAssetId).toBeUndefined();
    }
  });

  it('keep their gameplay fields intact alongside the model id', () => {
    // Spot-check that adding modelAssetId did not disturb shape/mass/engine data.
    expect(partById('pod-voyager')?.massDry).toBe(840);
    expect(partById('eng-mule')?.engine).toBeDefined();
    expect(partById('eng-colt')?.engine?.plumeScale).toBeGreaterThan(0);
    expect(partById('tank-s4')?.shape.kind).toBe('cylinder');
  });
});

describe('buildVesselVisual', () => {
  it('selects the imported body and suppresses the procedural accent when a model exists', () => {
    const craft = createCraft('t');
    const tank = addPart(craft, 'tank-s4', null, 'root', { x: 0, y: 0, z: 0 });
    const visual = buildVesselVisual(craft, fakeLibrary());
    const holder = visual.partMeshes.get(tank.key)!;
    expect(holder.userData.visualSource).toBe('model');
    // Imported object present; no procedural body + accent-band pair.
    expect(holder.children.some((c) => c.userData.importedTag === 'shuttle-pl400-tank')).toBe(true);
    expect(meshCount(holder)).toBe(1);
  });

  it('falls back to procedural geometry (body + accent) when the model is missing', () => {
    const craft = createCraft('t');
    const tank = addPart(craft, 'tank-s4', null, 'root', { x: 0, y: 0, z: 0 });
    const visual = buildVesselVisual(craft, fakeLibrary(new Set(['shuttle-pl400-tank'])));
    const holder = visual.partMeshes.get(tank.key)!;
    expect(holder.userData.visualSource).toBe('procedural');
    expect(meshCount(holder)).toBe(2); // body + accent band
  });

  it('builds one plume holder per authored nozzle anchor, parented to the part holder', () => {
    const craft = createCraft('t');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 2, z: 0 });
    const mule = addPart(craft, 'eng-mule', pod.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    const colt = addPart(craft, 'eng-colt', pod.key, 'surface', { x: 1, y: 0, z: 0 });
    const visual = buildVesselVisual(craft, fakeLibrary());
    const mulePlumes = visual.plumes.get(mule.key)!;
    const coltPlumes = visual.plumes.get(colt.key)!;
    expect(mulePlumes.children).toHaveLength(3);
    expect(coltPlumes.children).toHaveLength(1);
    // Plume groups parent under their part holders, not the craft root.
    expect(mulePlumes.parent).toBe(visual.partMeshes.get(mule.key));
    expect(coltPlumes.parent).toBe(visual.partMeshes.get(colt.key));
  });

  it('gives an engine one default plume when its model has no authored anchors', () => {
    const craft = createCraft('t');
    // No library at all → procedural engine → default single anchor.
    const eng = addPart(craft, 'eng-mule', null, 'root', { x: 0, y: 0, z: 0 });
    const visual = buildVesselVisual(craft);
    expect(visual.partMeshes.get(eng.key)!.userData.visualSource).toBe('procedural');
    expect(visual.plumes.get(eng.key)!.children).toHaveLength(1);
  });
});
