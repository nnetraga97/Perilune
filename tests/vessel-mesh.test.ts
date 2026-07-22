import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { addPart, createCraft } from '../src/sim/vessel';
import { createFirstLightRocket } from '../src/content/crafts';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { GameState } from '../src/sim/state';
import { PARTS, partById } from '../src/content/parts';
import { buildVesselVisual, disposeVesselVisual, syncVesselVisual } from '../src/render/vesselMesh';
import type { PartModelLibrary, InstantiatedPartModel } from '../src/render/partModelLibrary';
import type { PartEffectAnchor } from '../src/render/partModelManifest';
import {
  FLIGHT_AERIAL_USER_DATA_KEY,
  FlightAerialPerspectiveController,
} from '../src/render/flightAerialPerspective';

const EXPECTED_MODEL_IDS: Record<string, string> = {
  'pod-voyager': 'orion-voyager-pod',
  'pod-tandem': 'perilune-tandem-cab',
  'core-pilot': 'perilune-pilot-chip',
  'tank-s1': 'perilune-pl100-tank',
  'leg-lander': 'viking-stilt-leg',
  'eng-pike': 'perilune-pike-engine',
  'eng-ember': 'perilune-ember-engine',
  'eng-colt': 'apollo-colt-engine',
  'eng-aspen': 'perilune-aspen-engine',
  'rcs-quad': 'perilune-quadjet-rcs',
  'batt-s': 'perilune-cell-pack-s',
  'batt-m': 'perilune-cell-bank-m',
  'solar-fold': 'perilune-petal-array',
  'solar-flat': 'perilune-shingle-panel',
  'sci-thermo': 'perilune-thermoscope',
  'sci-baro': 'perilune-pressograph',
  'sci-spore': 'perilune-spore-vault',
  'sci-survey': 'perilune-starfield-camera',
  'sci-fieldkit': 'perilune-field-sample-kit',
  'scan-prospector': 'perilune-prospector-eye',
  'ant-dish': 'tdrs-longtalk-dish',
  'wheel-mesa': 'mars-mesa-wheel',
  'eng-mule': 'shuttle-mule-engine',
  'tank-s4': 'shuttle-pl400-tank',
  'tank-m8': 'perilune-hv1600-tank',
  'chute-main': 'orion-homecoming-housing',
  'tank-m4': 'procedural-tank-mule',
  'tank-s2': 'procedural-tank-pod',
  'dec-m': 'procedural-separator',
  'dec-interstage-ms': 'procedural-separator',
  'fin-rudder': 'procedural-fin-mule',
  'fin-swift': 'procedural-fin-pod',
  'dec-radial': 'procedural-radial-decoupler',
  'srb-torch': 'procedural-srb-torch',
  'nose-s': 'procedural-srb-nose-cone',
};

const ANCHOR_COUNTS: Record<string, number> = {
  'shuttle-mule-engine': 3,
  'perilune-pike-engine': 1,
  'perilune-ember-engine': 1,
  'apollo-colt-engine': 1,
  'perilune-aspen-engine': 1,
  'procedural-srb-torch': 1,
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
  it('carry the exact model IDs and only on checked-model parts', () => {
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
  it('keeps the checked Ember model and an active plume after First Light stages to it', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    let vessel = game.spawnOnPad(createFirstLightRocket(), 'First Light');
    for (let stage = 0; stage < 5; stage++) {
      expect(game.fireStage(vessel)).toBe(true);
      vessel = game.active!;
    }
    const ember = vessel.runtime.craft.parts.find((part) => part.defId === 'eng-ember');
    expect(ember?.activated).toBe(true);

    const visual = buildVesselVisual(vessel.runtime.craft, fakeLibrary());
    vessel.runtime.controls.throttle = 1;
    syncVesselVisual(visual, vessel.runtime.craft, 1, 0, 1 / 30);

    expect(visual.partMeshes.get(ember!.key)?.userData.visualSource).toBe('model');
    expect(visual.partMeshes.get(ember!.key)?.children.some(
      (child) => child.userData.importedTag === 'perilune-ember-engine',
    )).toBe(true);
    expect(visual.plumes.get(ember!.key)).toMatchObject({ visible: true });
    expect(visual.plumes.get(ember!.key)?.userData.burning).toBe(true);
    disposeVesselVisual(visual);
  });

  it('owns flight-only material variants without mutating imported library resources', () => {
    const baseGeometry = new THREE.BoxGeometry();
    const borrowedTexture = new THREE.Texture();
    const baseMaterial = new THREE.MeshStandardMaterial({ map: borrowedTexture });
    const library: PartModelLibrary = {
      preload: async () => {},
      dispose() {},
      instantiateForPart: () => null,
      instantiate: () => ({
        object: new THREE.Mesh(baseGeometry, baseMaterial),
        plumeAnchors: [],
      }),
    };
    const craft = createCraft('aerial');
    addPart(craft, 'tank-s4', null, 'root', { x: 0, y: 0, z: 0 });
    const controller = new FlightAerialPerspectiveController();
    const visual = buildVesselVisual(craft, library, controller);
    const mesh = visual.group.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const variant = mesh.material as THREE.MeshStandardMaterial;
    expect(variant).not.toBe(baseMaterial);
    expect(variant.map).toBe(borrowedTexture);
    expect(variant.userData[FLIGHT_AERIAL_USER_DATA_KEY]).toBe(controller);
    expect(baseMaterial.userData[FLIGHT_AERIAL_USER_DATA_KEY]).toBeUndefined();
    expect(visual.ownedMaterials.has(variant)).toBe(true);
    const variantDispose = vi.spyOn(variant, 'dispose');
    const geometryDispose = vi.spyOn(baseGeometry, 'dispose');
    const textureDispose = vi.spyOn(borrowedTexture, 'dispose');
    disposeVesselVisual(visual);
    disposeVesselVisual(visual);
    expect(variantDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    baseGeometry.dispose();
    baseMaterial.dispose();
    borrowedTexture.dispose();
    controller.dispose();
  });

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

  it('animates the Homecoming canopy from hidden through reefed to fully open', () => {
    const craft = createCraft('recovery');
    const chute = addPart(craft, 'chute-main', null, 'root', { x: 0, y: 0, z: 0 });
    const visual = buildVesselVisual(craft, fakeLibrary());
    const rig = visual.parachutes.get(chute.key)!;

    expect(rig.visible).toBe(false);
    expect(rig.getObjectByName('parachute-canopy')).toBeDefined();
    expect(rig.getObjectByName('parachute-lines')).toBeDefined();

    chute.parachuteDeployFraction = 0.15;
    syncVesselVisual(visual, craft, 0, 1, 0.5, undefined, 1);
    expect(rig.visible).toBe(true);
    expect(rig.scale.x).toBeGreaterThan(0.08);
    expect(rig.scale.x).toBeLessThan(1);

    chute.parachuteDeployFraction = 1;
    for (let i = 0; i < 20; i++) syncVesselVisual(visual, craft, 0, 1, 0.1, undefined, 2 + i * 0.1);
    expect(rig.userData.deployment).toBeGreaterThan(0.99);
    expect(rig.scale.x).toBeGreaterThan(0.98);
    disposeVesselVisual(visual);
  });

  it('renders a layered SRB flame at full power even when vessel throttle is zero', () => {
    const craft = createCraft('solid');
    const booster = addPart(craft, 'srb-flare', null, 'root', { x: 0, y: 0, z: 0 });
    booster.activated = true;
    const visual = buildVesselVisual(craft);

    syncVesselVisual(visual, craft, 0, 1, 1 / 30);

    const plume = visual.plumes.get(booster.key)!;
    const nozzle = plume.children[0];
    const flame = nozzle.userData.flameGroup as THREE.Group;
    expect(plume.visible).toBe(true);
    expect(plume.userData.burning).toBe(true);
    expect(flame.children).toHaveLength(3);
    expect(flame.children.every((child) => child instanceof THREE.Mesh)).toBe(true);
    for (const child of flame.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
      expect(mesh.renderOrder).toBeGreaterThan(40);
      expect(mesh.material.vertexShader).toContain('#include <logdepthbuf_vertex>');
      expect(mesh.material.fragmentShader).toContain('#include <logdepthbuf_fragment>');
    }
    disposeVesselVisual(visual);
  });
});
