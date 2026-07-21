import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type {
  InstantiatedPartModel,
  PartModelLibrary,
} from '../src/render/partModelLibrary';
import { ARTEMIS_IV_VOYAGER_VISUAL_BINDING } from '../src/missions/artemisIv/assets';
import {
  ARTEMIS_IV_CAMERA_FRAMING_RADII,
  ARTEMIS_IV_ORION_VISUAL_DIMENSIONS,
  ARTEMIS_IV_VISUAL_DOCKING,
  ARTEMIS_IV_VISUAL_LABELS,
  createArtemisIvVisualComposite,
} from '../src/missions/artemisIv/visuals';

interface Fixture {
  library: PartModelLibrary;
  instantiate: ReturnType<typeof vi.fn>;
  disposeLibrary: ReturnType<typeof vi.fn>;
  voyagerGeometry: THREE.BufferGeometry;
  voyagerMaterial: THREE.Material;
  housingGeometry: THREE.BufferGeometry;
  housingMaterial: THREE.Material;
  starship: THREE.Group;
  starshipGeometry: THREE.BufferGeometry;
  starshipMaterial: THREE.Material;
}

function fixture(): Fixture {
  const voyagerGeometry = new THREE.ConeGeometry(0.6, 0.85, 12);
  const voyagerMaterial = new THREE.MeshStandardMaterial();
  const voyager = new THREE.Group();
  voyager.add(new THREE.Mesh(voyagerGeometry, voyagerMaterial));

  const housingGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.35, 12);
  const housingMaterial = new THREE.MeshStandardMaterial();
  const housing = new THREE.Group();
  housing.add(new THREE.Mesh(housingGeometry, housingMaterial));

  const instantiate = vi.fn((assetId: string): InstantiatedPartModel | null => {
    if (assetId === 'orion-voyager-pod') return { object: voyager, plumeAnchors: [] };
    if (assetId === 'orion-homecoming-housing') return { object: housing, plumeAnchors: [] };
    return null;
  });
  const disposeLibrary = vi.fn();
  const library: PartModelLibrary = {
    preload: async () => {},
    instantiate,
    instantiateForPart: () => null,
    dispose: disposeLibrary,
  };

  const starshipGeometry = new THREE.BoxGeometry(2, 8, 2);
  const starshipMaterial = new THREE.MeshStandardMaterial();
  const starship = new THREE.Group();
  starship.position.set(-0.01, 26.47, 0.2);
  starship.quaternion.setFromEuler(new THREE.Euler(0.1, -0.2, 0.3));
  starship.scale.setScalar(0.01);
  const starshipMesh = new THREE.Mesh(starshipGeometry, starshipMaterial);
  starshipMesh.position.set(2, 3, 4);
  starship.add(starshipMesh);

  return {
    library, instantiate, disposeLibrary,
    voyagerGeometry, voyagerMaterial, housingGeometry, housingMaterial,
    starship, starshipGeometry, starshipMaterial,
  };
}

function objectsWithKind(root: THREE.Object3D, kind: string): THREE.Object3D[] {
  const matches: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object.userData.kind === kind) matches.push(object);
  });
  return matches;
}

function worldPoint(root: THREE.Object3D, localY: number): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return new THREE.Vector3(0, localY, 0).applyMatrix4(root.matrixWorld);
}

describe('Artemis IV visual composite', () => {
  it('binds the checked Voyager exterior at mission scale with an honest label', () => {
    const f = fixture();
    const visual = createArtemisIvVisualComposite(f.library, f.starship);

    expect(f.instantiate.mock.calls.map(([assetId]) => assetId)).toEqual([
      'orion-voyager-pod',
      'orion-homecoming-housing',
    ]);
    expect(visual.voyagerModel.scale.toArray()).toEqual([4.164, 4.164, 4.164]);
    expect(visual.voyagerModel.userData.displayLabel).toBe(
      ARTEMIS_IV_VOYAGER_VISUAL_BINDING.displayLabel,
    );
    expect(visual.orionRoot.userData.displayLabel).toBe(ARTEMIS_IV_VISUAL_LABELS.orion);
    expect(visual.hlsRoot.userData.isAccurateHlsModel).toBe(false);
  });

  it('builds a 4 m ESM and four three-panel wings at the 19 m span', () => {
    const f = fixture();
    const visual = createArtemisIvVisualComposite(f.library, f.starship);
    const body = visual.serviceModuleRoot.getObjectByName(
      'artemis-iv:orion-esm-body',
    ) as THREE.Mesh<THREE.CylinderGeometry>;
    expect(body.geometry.parameters.radiusTop * 2).toBe(
      ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.esmDiameterMeters,
    );
    expect(body.geometry.parameters.height).toBe(ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.esmHeightMeters);

    const wings = objectsWithKind(visual.serviceModuleRoot, 'orion-solar-wing');
    const panels = objectsWithKind(visual.serviceModuleRoot, 'orion-solar-panel') as THREE.Mesh<THREE.BoxGeometry>[];
    expect(wings).toHaveLength(4);
    expect(panels).toHaveLength(12);
    expect(wings.map((wing) => objectsWithKind(wing, 'orion-solar-panel').length)).toEqual([3, 3, 3, 3]);

    const outerPanel = wings[0].children[2] as THREE.Mesh<THREE.BoxGeometry>;
    const outerRadius = outerPanel.position.x + outerPanel.geometry.parameters.width / 2;
    expect(outerRadius * 2).toBeCloseTo(
      ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.unfoldedSolarArraySpanMeters,
      6,
    );
  });

  it('parents the exact Starship object without rewriting it or its descendants', () => {
    const f = fixture();
    const before = {
      position: f.starship.position.toArray(),
      quaternion: f.starship.quaternion.toArray(),
      scale: f.starship.scale.toArray(),
      childPosition: f.starship.children[0].position.toArray(),
    };
    const visual = createArtemisIvVisualComposite(f.library, f.starship);

    expect(visual.starship).toBe(f.starship);
    expect(f.starship.parent).toBe(visual.hlsRoot);
    expect(f.starship.position.toArray()).toEqual(before.position);
    expect(f.starship.quaternion.toArray()).toEqual(before.quaternion);
    expect(f.starship.scale.toArray()).toEqual(before.scale);
    expect(f.starship.children[0].position.toArray()).toEqual(before.childPosition);
    expect((f.starship.children[0] as THREE.Mesh).geometry).toBe(f.starshipGeometry);
    expect((f.starship.children[0] as THREE.Mesh).material).toBe(f.starshipMaterial);
  });

  it('maps both visual collars onto the hidden docking faces without a merge teleport', () => {
    const f = fixture();
    const visual = createArtemisIvVisualComposite(f.library, f.starship);
    const orionProxy = new THREE.Group();
    const hlsProxy = new THREE.Group();
    hlsProxy.position.y = ARTEMIS_IV_VISUAL_DOCKING.physicsFaceY * 2;
    hlsProxy.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

    visual.copyVesselTransform('orion', orionProxy);
    visual.copyVesselTransform('hls', hlsProxy);
    const separatedHlsRoot = visual.hlsRoot.position.clone();

    expect(worldPoint(visual.orionRoot, ARTEMIS_IV_VISUAL_DOCKING.orionFaceY)
      .distanceTo(worldPoint(visual.hlsRoot, ARTEMIS_IV_VISUAL_DOCKING.hlsFaceY)))
      .toBeLessThan(1e-9);
    expect(visual.hlsDockingCollarRoot.userData.accuracy).toBe('representative');
    expect(objectsWithKind(visual.hlsRoot, 'hls-representative-docking-collar')).toHaveLength(1);

    visual.copyDockedHlsTransformFromOrion();

    expect(visual.hlsRoot.position.distanceTo(separatedHlsRoot)).toBeLessThan(1e-9);
    expect(worldPoint(visual.orionRoot, ARTEMIS_IV_VISUAL_DOCKING.orionFaceY)
      .distanceTo(worldPoint(visual.hlsRoot, ARTEMIS_IV_VISUAL_DOCKING.hlsFaceY)))
      .toBeLessThan(1e-9);
  });

  it('uses a conservative camera envelope around the HLS physics origin', () => {
    const farthestCheckedCornerFromPhysicsRoot = Math.hypot(
      9.99748424,
      -26.58930634 + ARTEMIS_IV_VISUAL_DOCKING.hlsRootFromPhysicsRootY,
      5.52268755,
    );
    expect(ARTEMIS_IV_CAMERA_FRAMING_RADII.hls).toBeGreaterThan(farthestCheckedCornerFromPhysicsRoot);
    expect(ARTEMIS_IV_CAMERA_FRAMING_RADII.docked).toBeGreaterThanOrEqual(
      ARTEMIS_IV_CAMERA_FRAMING_RADII.hls,
    );
  });

  it('switches Orion topology and role visibility without coupling the roots', () => {
    const f = fixture();
    const visual = createArtemisIvVisualComposite(f.library, f.starship);
    expect(visual.topology).toBe('cm-esm');
    expect(visual.serviceModuleRoot.visible).toBe(true);
    expect(visual.recoveryRoot.visible).toBe(false);

    visual.setTopology('cm-only');
    expect(visual.crewModuleRoot.visible).toBe(true);
    expect(visual.serviceModuleRoot.visible).toBe(false);
    expect(visual.dockingCollarRoot.visible).toBe(true);
    expect(visual.recoveryRoot.visible).toBe(false);

    visual.setTopology('recovery');
    expect(visual.crewModuleRoot.visible).toBe(true);
    expect(visual.serviceModuleRoot.visible).toBe(false);
    expect(visual.dockingCollarRoot.visible).toBe(false);
    expect(visual.recoveryRoot.visible).toBe(true);
    expect(objectsWithKind(visual.recoveryRoot, 'orion-main-canopy')).toHaveLength(3);

    visual.setRoleVisible('orion', false);
    expect(visual.orionRoot.visible).toBe(false);
    expect(visual.hlsRoot.visible).toBe(true);
    visual.setRoleVisible('hls', false);
    expect(visual.hlsRoot.visible).toBe(false);

    const source = new THREE.Group();
    source.position.set(11, 22, 33);
    source.quaternion.setFromEuler(new THREE.Euler(0.2, 0.4, 0.6));
    source.scale.set(2, 3, 4);
    visual.copyVesselTransform('orion', source);
    const expectedPosition = source.position.clone().add(
      new THREE.Vector3(0, ARTEMIS_IV_VISUAL_DOCKING.orionRootFromPhysicsRootY, 0)
        .multiply(source.scale)
        .applyQuaternion(source.quaternion),
    );
    expect(visual.orionRoot.position.distanceTo(expectedPosition)).toBeLessThan(1e-9);
    expect(visual.orionRoot.quaternion.toArray()).toEqual(source.quaternion.toArray());
    expect(visual.orionRoot.scale.toArray()).toEqual(source.scale.toArray());
  });

  it('disposes only its procedural resources and detaches borrowed objects', () => {
    const f = fixture();
    const visual = createArtemisIvVisualComposite(f.library, f.starship);
    const proceduralGeometries = new Set<THREE.BufferGeometry>();
    const proceduralMaterials = new Set<THREE.Material>();
    visual.root.traverse((object) => {
      if (object.userData.resourceOwner !== 'artemis-iv-visual-composite') return;
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        proceduralGeometries.add(object.geometry);
        const entries = Array.isArray(object.material) ? object.material : [object.material];
        entries.forEach((entry) => proceduralMaterials.add(entry));
      }
    });
    const proceduralGeometryDisposals = [...proceduralGeometries].map((geometry) => vi.spyOn(geometry, 'dispose'));
    const proceduralMaterialDisposals = [...proceduralMaterials].map((entry) => vi.spyOn(entry, 'dispose'));
    const borrowedDisposals = [
      vi.spyOn(f.voyagerGeometry, 'dispose'), vi.spyOn(f.voyagerMaterial, 'dispose'),
      vi.spyOn(f.housingGeometry, 'dispose'), vi.spyOn(f.housingMaterial, 'dispose'),
      vi.spyOn(f.starshipGeometry, 'dispose'), vi.spyOn(f.starshipMaterial, 'dispose'),
    ];

    visual.dispose();
    visual.dispose();

    expect(proceduralGeometries.size).toBeGreaterThan(0);
    expect(proceduralMaterials.size).toBeGreaterThan(0);
    proceduralGeometryDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    proceduralMaterialDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    borrowedDisposals.forEach((dispose) => expect(dispose).not.toHaveBeenCalled());
    expect(f.disposeLibrary).not.toHaveBeenCalled();
    expect(f.starship.parent).toBeNull();
    expect(visual.voyagerModel.parent).toBeNull();
    expect(visual.recoveryHousing.parent).toBeNull();
  });
});
