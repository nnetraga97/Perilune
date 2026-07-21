import * as THREE from 'three';
import type { PartModelLibrary } from '../../render/partModelLibrary';
import {
  ARTEMIS_IV_PROVIDER_LABEL,
  ARTEMIS_IV_STARSHIP_LABEL,
  ARTEMIS_IV_VOYAGER_VISUAL_BINDING,
} from './assets';

export type ArtemisIvOrionTopology = 'cm-esm' | 'cm-only' | 'recovery';
export type ArtemisIvVisualRole = 'orion' | 'hls';

export const ARTEMIS_IV_VISUAL_LABELS = Object.freeze({
  orion: ARTEMIS_IV_VOYAGER_VISUAL_BINDING.displayLabel,
  hls: `${ARTEMIS_IV_STARSHIP_LABEL} · ${ARTEMIS_IV_PROVIDER_LABEL}`,
  recovery: 'Orion Crew Module · three-main-canopy recovery view',
});

/** Published full-scale dimensions represented by the lightweight geometry. */
export const ARTEMIS_IV_ORION_VISUAL_DIMENSIONS = Object.freeze({
  crewModuleDiameterMeters: 5,
  crewModuleHeightMeters: 3.54,
  esmDiameterMeters: 4,
  esmHeightMeters: 4,
  unfoldedSolarArraySpanMeters: 19,
  solarWingCount: 4,
  panelsPerWing: 3,
  mainCanopyDiameterMeters: 35.36,
});

/**
 * Mission-only mapping between the hidden graybox docking faces and the
 * exterior models. The Starship scene stays byte-for-byte unchanged; its
 * checked +Y bound is used as the representative nose docking plane.
 */
export const ARTEMIS_IV_VISUAL_DOCKING = Object.freeze({
  physicsFaceY: 0.12,
  orionFaceY: ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.dockingPort.position[1],
  hlsFaceY: 26.58930634,
  orionRootFromPhysicsRootY:
    0.12 - ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.dockingPort.position[1],
  hlsRootFromPhysicsRootY: 0.12 - 26.58930634,
  dockedHlsRootFromOrionRootY:
    ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.dockingPort.position[1] + 26.58930634,
});

/** Conservative radii about the physics origin for opt-in flight framing. */
export const ARTEMIS_IV_CAMERA_FRAMING_RADII = Object.freeze({
  orionCmEsm: 12,
  hls: 55,
  docked: 56,
  recovery: 48,
});

const PROCEDURAL_OWNER = 'artemis-iv-visual-composite';
const _roleRootOffset = new THREE.Vector3();
const _dockedRootOffset = new THREE.Vector3();
const _dockingFlip = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI,
);

interface OwnedResources {
  readonly geometries: Set<THREE.BufferGeometry>;
  readonly materials: Set<THREE.Material>;
}

function material(
  resources: OwnedResources,
  options: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
  const result = new THREE.MeshStandardMaterial(options);
  resources.materials.add(result);
  return result;
}

function mesh(
  resources: OwnedResources,
  name: string,
  geometry: THREE.BufferGeometry,
  meshMaterial: THREE.Material,
): THREE.Mesh {
  resources.geometries.add(geometry);
  resources.materials.add(meshMaterial);
  const result = new THREE.Mesh(geometry, meshMaterial);
  result.name = name;
  result.castShadow = true;
  result.receiveShadow = true;
  result.userData.resourceOwner = PROCEDURAL_OWNER;
  return result;
}

function buildServiceModule(resources: OwnedResources): THREE.Group {
  const root = new THREE.Group();
  root.name = 'artemis-iv:orion-esm';

  // ESA publishes the ESM as roughly 4 m in diameter and height, with a 19 m
  // tip-to-tip solar span. The simple geometry keeps those silhouette anchors.
  const bodyMaterial = material(resources, {
    color: '#d3d0c6', metalness: 0.62, roughness: 0.4,
  });
  const body = mesh(
    resources,
    'artemis-iv:orion-esm-body',
    new THREE.CylinderGeometry(2, 2, ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.esmHeightMeters, 32),
    bodyMaterial,
  );
  body.position.fromArray(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.esmBodyCenter.position);
  root.add(body);

  const panelMaterial = material(resources, {
    color: '#173f68', emissive: '#06111c', emissiveIntensity: 0.12,
    metalness: 0.12, roughness: 0.62,
  });
  const wingGap = 0.12;
  const radialLength = (
    ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.unfoldedSolarArraySpanMeters / 2
    - ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.esmDiameterMeters / 2
    - wingGap * 3
  ) / ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.panelsPerWing;
  const panelGeometry = new THREE.BoxGeometry(radialLength, 0.06, 1.75);
  resources.geometries.add(panelGeometry);

  for (let wingIndex = 0; wingIndex < ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.solarWingCount; wingIndex++) {
    const wing = new THREE.Group();
    wing.name = `artemis-iv:orion-solar-wing-${wingIndex + 1}`;
    wing.userData.kind = 'orion-solar-wing';
    wing.position.y = ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.esmSolarWingRoots[0].position[1];
    wing.rotation.y = wingIndex * Math.PI / 2;
    for (let panelIndex = 0; panelIndex < ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.panelsPerWing; panelIndex++) {
      const panel = mesh(
        resources,
        `artemis-iv:orion-solar-panel-${wingIndex + 1}-${panelIndex + 1}`,
        panelGeometry,
        panelMaterial,
      );
      panel.userData.kind = 'orion-solar-panel';
      panel.position.x = ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.esmDiameterMeters / 2
        + wingGap + radialLength / 2 + panelIndex * (radialLength + wingGap);
      wing.add(panel);
    }
    root.add(wing);
  }
  return root;
}

function buildDockingCollar(resources: OwnedResources): THREE.Group {
  const root = new THREE.Group();
  root.name = 'artemis-iv:orion-docking-collar';
  const collar = mesh(
    resources,
    'artemis-iv:orion-docking-collar-body',
    new THREE.CylinderGeometry(0.58, 0.72, 0.3, 28, 1, true),
    material(resources, { color: '#777b7d', metalness: 0.72, roughness: 0.35 }),
  );
  collar.position.fromArray(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.dockingPort.position);
  root.add(collar);
  return root;
}

function buildHlsDockingCollar(resources: OwnedResources): THREE.Group {
  const root = new THREE.Group();
  root.name = 'artemis-iv:hls-representative-docking-collar';
  root.userData.kind = 'hls-representative-docking-collar';
  root.userData.accuracy = 'representative';
  const collar = mesh(
    resources,
    'artemis-iv:hls-representative-docking-collar-body',
    new THREE.CylinderGeometry(0.72, 0.72, 0.12, 28, 1, true),
    material(resources, { color: '#777b7d', metalness: 0.72, roughness: 0.35 }),
  );
  collar.position.y = ARTEMIS_IV_VISUAL_DOCKING.hlsFaceY;
  root.add(collar);
  return root;
}

function buildRecovery(
  resources: OwnedResources,
  housing: THREE.Object3D,
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'artemis-iv:orion-recovery';
  root.userData.displayLabel = ARTEMIS_IV_VISUAL_LABELS.recovery;

  housing.name = 'artemis-iv:orion-recovery-housing';
  housing.scale.setScalar(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.uniformScale);
  housing.position.fromArray(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.recoveryHousing.position);
  housing.userData.resourceOwner = 'part-model-library';
  root.add(housing);

  // Three low-segment domes preserve Orion's real 116 ft main-canopy scale.
  const canopyRadius = ARTEMIS_IV_ORION_VISUAL_DIMENSIONS.mainCanopyDiameterMeters / 2;
  const canopyGeometry = new THREE.SphereGeometry(
    canopyRadius, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2,
  );
  const canopyMaterial = material(resources, {
    color: '#df7745', emissive: '#2b0d04', emissiveIntensity: 0.06,
    metalness: 0, roughness: 0.9, side: THREE.DoubleSide,
  });
  const centers = [
    new THREE.Vector3(-15, 24, 0),
    new THREE.Vector3(7.5, 24, 12.99),
    new THREE.Vector3(7.5, 24, -12.99),
  ];
  const linePositions: number[] = [];
  centers.forEach((center, canopyIndex) => {
    const canopy = mesh(
      resources,
      `artemis-iv:orion-main-canopy-${canopyIndex + 1}`,
      canopyGeometry,
      canopyMaterial,
    );
    canopy.userData.kind = 'orion-main-canopy';
    canopy.position.copy(center);
    canopy.scale.y = 0.25;
    root.add(canopy);

    const anchor = ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.recoveryMainCanopies[canopyIndex].position;
    for (let lineIndex = 0; lineIndex < 8; lineIndex++) {
      const angle = lineIndex * Math.PI / 4;
      linePositions.push(
        anchor[0], anchor[1], anchor[2],
        center.x + Math.cos(angle) * canopyRadius,
        center.y,
        center.z + Math.sin(angle) * canopyRadius,
      );
    }
  });
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#e3ddd2', transparent: true, opacity: 0.82 });
  resources.geometries.add(lineGeometry);
  resources.materials.add(lineMaterial);
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = 'artemis-iv:orion-main-canopy-lines';
  lines.userData.resourceOwner = PROCEDURAL_OWNER;
  root.add(lines);
  return root;
}

export class ArtemisIvVisualComposite {
  readonly root = new THREE.Group();
  readonly orionRoot = new THREE.Group();
  readonly crewModuleRoot = new THREE.Group();
  readonly serviceModuleRoot: THREE.Group;
  readonly dockingCollarRoot: THREE.Group;
  readonly recoveryRoot: THREE.Group;
  readonly hlsRoot = new THREE.Group();
  readonly hlsDockingCollarRoot: THREE.Group;
  readonly voyagerModel: THREE.Object3D;
  readonly recoveryHousing: THREE.Object3D;
  readonly starship: THREE.Object3D;

  private readonly resources: OwnedResources = {
    geometries: new Set(), materials: new Set(),
  };
  private disposed = false;
  private currentTopology: ArtemisIvOrionTopology = 'cm-esm';

  constructor(models: PartModelLibrary, starship: THREE.Object3D) {
    const voyager = models.instantiate(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.assetId);
    if (!voyager) throw new Error('Artemis IV requires the preloaded Orion Voyager visual');
    const housing = models.instantiate('orion-homecoming-housing');
    if (!housing) throw new Error('Artemis IV requires the preloaded Orion recovery housing visual');

    this.root.name = 'artemis-iv:mission-visuals';
    this.orionRoot.name = 'artemis-iv:orion-visual';
    this.orionRoot.userData.displayLabel = ARTEMIS_IV_VISUAL_LABELS.orion;
    this.crewModuleRoot.name = 'artemis-iv:orion-crew-module';
    this.hlsRoot.name = 'artemis-iv:hls-visual';
    this.hlsRoot.userData.displayLabel = ARTEMIS_IV_VISUAL_LABELS.hls;
    this.hlsRoot.userData.isAccurateHlsModel = false;

    this.voyagerModel = voyager.object;
    this.voyagerModel.name = 'artemis-iv:orion-voyager-model';
    this.voyagerModel.scale.setScalar(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.uniformScale);
    this.voyagerModel.userData.displayLabel = ARTEMIS_IV_VISUAL_LABELS.orion;
    this.voyagerModel.userData.resourceOwner = 'part-model-library';
    this.crewModuleRoot.add(this.voyagerModel);

    this.serviceModuleRoot = buildServiceModule(this.resources);
    this.dockingCollarRoot = buildDockingCollar(this.resources);
    this.recoveryHousing = housing.object;
    this.recoveryRoot = buildRecovery(this.resources, this.recoveryHousing);
    this.recoveryRoot.visible = false;
    this.orionRoot.add(
      this.crewModuleRoot,
      this.serviceModuleRoot,
      this.dockingCollarRoot,
      this.recoveryRoot,
    );

    this.starship = starship;
    this.hlsDockingCollarRoot = buildHlsDockingCollar(this.resources);
    this.hlsRoot.add(this.starship, this.hlsDockingCollarRoot);
    this.root.add(this.orionRoot, this.hlsRoot);
  }

  get topology(): ArtemisIvOrionTopology {
    return this.currentTopology;
  }

  setTopology(topology: ArtemisIvOrionTopology): void {
    this.assertActive();
    this.currentTopology = topology;
    this.serviceModuleRoot.visible = topology === 'cm-esm';
    this.dockingCollarRoot.visible = topology !== 'recovery';
    this.recoveryRoot.visible = topology === 'recovery';
  }

  setRoleVisible(role: ArtemisIvVisualRole, visible: boolean): void {
    this.assertActive();
    (role === 'orion' ? this.orionRoot : this.hlsRoot).visible = visible;
  }

  copyVesselTransform(role: ArtemisIvVisualRole, source: THREE.Object3D): void {
    this.assertActive();
    const target = role === 'orion' ? this.orionRoot : this.hlsRoot;
    target.position.copy(source.position);
    target.quaternion.copy(source.quaternion);
    target.scale.copy(source.scale);
    const rootFromPhysicsRootY = role === 'orion'
      ? ARTEMIS_IV_VISUAL_DOCKING.orionRootFromPhysicsRootY
      : ARTEMIS_IV_VISUAL_DOCKING.hlsRootFromPhysicsRootY;
    _roleRootOffset
      .set(0, rootFromPhysicsRootY, 0)
      .multiply(source.scale)
      .applyQuaternion(source.quaternion);
    target.position.add(_roleRootOffset);
    target.updateMatrix();
  }

  /** Place the two exterior roots in their ideal captured pose without a visual snap. */
  copyDockedHlsTransformFromOrion(): void {
    this.assertActive();
    _dockedRootOffset
      .set(0, ARTEMIS_IV_VISUAL_DOCKING.dockedHlsRootFromOrionRootY, 0)
      .multiply(this.orionRoot.scale)
      .applyQuaternion(this.orionRoot.quaternion);
    this.hlsRoot.position.copy(this.orionRoot.position).add(_dockedRootOffset);
    this.hlsRoot.quaternion.copy(this.orionRoot.quaternion).multiply(_dockingFlip);
    this.hlsRoot.scale.copy(this.orionRoot.scale);
    this.hlsRoot.updateMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.crewModuleRoot.remove(this.voyagerModel);
    this.recoveryRoot.remove(this.recoveryHousing);
    this.hlsRoot.remove(this.starship);
    this.crewModuleRoot.clear();
    this.serviceModuleRoot.clear();
    this.dockingCollarRoot.clear();
    this.recoveryRoot.clear();
    this.hlsDockingCollarRoot.clear();
    this.orionRoot.clear();
    this.hlsRoot.clear();
    this.root.clear();
    for (const geometry of this.resources.geometries) geometry.dispose();
    for (const ownedMaterial of this.resources.materials) ownedMaterial.dispose();
    this.resources.geometries.clear();
    this.resources.materials.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Artemis IV visual composite is disposed');
  }
}

export function createArtemisIvVisualComposite(
  models: PartModelLibrary,
  starship: THREE.Object3D,
): ArtemisIvVisualComposite {
  return new ArtemisIvVisualComposite(models, starship);
}
