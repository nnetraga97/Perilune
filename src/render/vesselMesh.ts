/**
 * Vessel rendering: builds a THREE.Group from a craft's part shapes.
 * Parts render with checked NASA-style models when the shared library has them
 * loaded, and otherwise fall back to procedural geometry (original industrial
 * look: matte hulls with accent bands), cached per part definition. Engine
 * plumes use layered animated shaders scaled by throttle and ambient pressure,
 * positioned from authored nozzle anchors so multi-nozzle engines get one
 * plume per bell.
 */
import * as THREE from 'three';
import type { Craft, PartInstance } from '../sim/vessel';
import { defOf } from '../sim/vessel';
import type { PartDef } from '../content/parts';
import { engineHasFuel } from '../sim/flight';
import type { PartModelLibrary } from './partModelLibrary';
import type { PartEffectAnchor } from './partModelManifest';
import { buildEnginePlumeLayers, updateEngineEffectMaterials } from './engineEffects';
import { deriveInterstageShroud, sanitizeInterstageShroudSpec } from '../sim/interstage';
import { buildInterstageShroud } from './interstageShroud';
import {
  createFlightAerialMaterialVariant,
  type FlightAerialPerspectiveController,
} from './flightAerialPerspective';

export type VesselVisualSource = 'model' | 'procedural';

const geoCache = new Map<string, THREE.BufferGeometry>();

function geometryFor(def: PartDef): THREE.BufferGeometry {
  let geo = geoCache.get(def.id);
  if (geo) return geo;
  const s = def.shape;
  switch (s.kind) {
    case 'cylinder':
      geo = new THREE.CylinderGeometry(s.radiusTop ?? 0.5, s.radiusBottom ?? 0.5, s.height, 20);
      break;
    case 'cone':
      geo = new THREE.CylinderGeometry(
        Math.max(0.01, s.radiusTop ?? 0.01),
        Math.max(0.01, s.radiusBottom ?? 0.5),
        s.height,
        20,
      );
      break;
    case 'capsule': {
      const r = s.radiusTop ?? 0.3;
      geo = new THREE.CapsuleGeometry(r, Math.max(0.01, s.height - r * 2), 6, 14);
      break;
    }
    case 'dome': {
      const r = Math.max(s.radiusBottom ?? 0.5, 0.05);
      geo = new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      geo.scale(1, s.height / r, 1);
      break;
    }
    case 'box':
      geo = new THREE.BoxGeometry(s.width ?? 0.2, s.height, s.depth ?? 0.2);
      break;
    case 'panel':
      geo = new THREE.BoxGeometry(s.width ?? 0.5, s.height, s.depth ?? 0.05);
      break;
  }
  geoCache.set(def.id, geo);
  return geo;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();

function materialFor(color: string, metalness = 0.35, roughness = 0.55): THREE.MeshStandardMaterial {
  const key = `${color}:${metalness}:${roughness}`;
  let mat = matCache.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    matCache.set(key, mat);
  }
  return mat;
}

export interface VesselVisual {
  group: THREE.Group;
  /** Per-part meshes keyed by part key (for removal on destruction). */
  partMeshes: Map<number, THREE.Object3D>;
  /** Plume groups keyed by engine part key; one child holder per authored nozzle anchor. */
  plumes: Map<number, THREE.Group>;
  /** Animated canopy rigs keyed by parachute part key. */
  parachutes: Map<number, THREE.Group>;
  /** Geometries created for this visual rather than borrowed from shared caches. */
  ownedGeometries: Set<THREE.BufferGeometry>;
  /** Flight-only material variants; their geometry and textures remain borrowed. */
  ownedMaterials: Set<THREE.Material>;
  craftVersionSeen: number;
}

/** Default nozzle anchor for procedural engines: a single bell at the shape base. */
function defaultPlumeAnchors(def: PartDef): readonly PartEffectAnchor[] {
  return [{ position: [0, -def.shape.height / 2, 0], rotation: [0, 0, 0, 1], scale: 1 }];
}

interface BuiltPartMesh {
  holder: THREE.Group;
  /** Authored nozzle anchors from the imported model, or null to use the default. */
  plumeAnchors: readonly PartEffectAnchor[] | null;
}

function buildPartMesh(
  craft: Craft,
  part: PartInstance,
  ownedGeometries: Set<THREE.BufferGeometry>,
  models?: PartModelLibrary,
  aerialController?: FlightAerialPerspectiveController,
  materialVariants?: Map<THREE.Material, THREE.Material>,
  ownedMaterials?: Set<THREE.Material>,
): BuiltPartMesh {
  const def = defOf(part);
  const holder = new THREE.Group();
  const imported = def.modelAssetId && models ? models.instantiate(def.modelAssetId) : null;
  if (imported) {
    // Imported geometry/materials are shared library resources; never own them here.
    holder.add(imported.object);
    imported.object.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    holder.userData.visualSource = 'model' satisfies VesselVisualSource;
  } else {
    const body = new THREE.Mesh(geometryFor(def), materialFor(def.color ?? '#c8cdd2'));
    body.castShadow = true;
    body.receiveShadow = true;
    holder.add(body);
    // Accent band for visual identity (cheap, no textures). Procedural bodies only.
    const isStraightStack =
      def.shape.kind === 'cylinder' ||
      (def.shape.kind === 'cone' && Math.abs((def.shape.radiusTop ?? 0) - (def.shape.radiusBottom ?? 0)) < 1e-6);
    if (def.accent && isStraightStack && !def.pod && !def.probe) {
      const r = Math.max(def.shape.radiusTop ?? 0.1, def.shape.radiusBottom ?? 0.1);
      const bandGeometry = new THREE.CylinderGeometry(r * 1.012, r * 1.012, def.shape.height * 0.12, 20);
      ownedGeometries.add(bandGeometry);
      const band = new THREE.Mesh(
        bandGeometry,
        materialFor(def.accent, 0.2, 0.6),
      );
      band.castShadow = true;
      band.receiveShadow = true;
      band.position.y = def.shape.height * 0.28;
      holder.add(band);
    }
    holder.userData.visualSource = 'procedural' satisfies VesselVisualSource;
  }
  const latchedShroud = sanitizeInterstageShroudSpec(part.interstageShroud);
  const liveShroud = part.activated ? null : deriveInterstageShroud(craft, part);
  const shroud = liveShroud ?? latchedShroud;
  if (shroud) holder.add(buildInterstageShroud(shroud));
  if (aerialController && materialVariants && ownedMaterials) {
    holder.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const replace = (base: THREE.Material): THREE.Material => {
        if (!(base instanceof THREE.MeshStandardMaterial)) return base;
        let variant = materialVariants.get(base);
        if (!variant) {
          variant = createFlightAerialMaterialVariant(base, aerialController);
          materialVariants.set(base, variant);
          ownedMaterials.add(variant);
        }
        return variant;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(replace)
        : replace(object.material);
    });
  }
  holder.position.set(part.position.x, part.position.y, part.position.z);
  holder.quaternion.set(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w);
  holder.userData.partKey = part.key;
  return { holder, plumeAnchors: imported?.plumeAnchors ?? null };
}

/**
 * One nozzle plume. The holder stays fixed on its authored nozzle exit while a
 * child flame group changes length and width at runtime.
 */
function buildPlumeHolder(baseScale: number, solid: boolean): THREE.Group {
  const holder = new THREE.Group();
  const layers = buildEnginePlumeLayers(baseScale, solid);
  holder.add(layers.group);
  holder.userData.flameGroup = layers.group;
  holder.userData.baseScale = layers.baseScale;
  return holder;
}

/**
 * A lightweight flight-only parachute rig. The checked model remains the
 * packed housing; this canopy grows from its top once physics starts opening
 * the chute, so editor portraits and stowed vessels keep their authored look.
 */
function buildParachuteRig(
  def: PartDef,
  ownedGeometries: Set<THREE.BufferGeometry>,
  ownedMaterials: Set<THREE.Material>,
): THREE.Group {
  const rig = new THREE.Group();
  const radius = THREE.MathUtils.clamp(Math.sqrt(def.parachute!.dragArea / Math.PI) * 0.3, 0.8, 2.8);
  const canopyGeometry = new THREE.SphereGeometry(radius, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: def.color ?? '#b4562e',
    emissive: '#241007',
    emissiveIntensity: 0.08,
    metalness: 0,
    roughness: 0.86,
    side: THREE.DoubleSide,
  });
  ownedGeometries.add(canopyGeometry);
  ownedMaterials.add(canopyMaterial);
  const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
  canopy.name = 'parachute-canopy';
  canopy.position.y = radius * 0.9;
  canopy.scale.y = 0.42;
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  rig.add(canopy);

  const lineHeight = canopy.position.y;
  const linePositions: number[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    linePositions.push(
      0, 0, 0,
      Math.cos(angle) * radius * 0.94, lineHeight, Math.sin(angle) * radius * 0.94,
    );
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#ddd4c6', transparent: true, opacity: 0.88 });
  ownedGeometries.add(lineGeometry);
  ownedMaterials.add(lineMaterial);
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = 'parachute-lines';
  rig.add(lines);

  rig.name = 'parachute-rig';
  rig.position.y = def.shape.height / 2;
  rig.visible = false;
  rig.userData.deployment = 0;
  return rig;
}

export function buildVesselVisual(
  craft: Craft,
  models?: PartModelLibrary,
  aerialController?: FlightAerialPerspectiveController,
): VesselVisual {
  const group = new THREE.Group();
  const partMeshes = new Map<number, THREE.Object3D>();
  const plumes = new Map<number, THREE.Group>();
  const parachutes = new Map<number, THREE.Group>();
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  const materialVariants = new Map<THREE.Material, THREE.Material>();
  for (const part of craft.parts) {
    const { holder, plumeAnchors } = buildPartMesh(
      craft,
      part,
      ownedGeometries,
      models,
      aerialController,
      materialVariants,
      ownedMaterials,
    );
    partMeshes.set(part.key, holder);
    group.add(holder);
    const def = defOf(part);
    if (def.engine) {
      const solid = def.engine.propellant === 'solidFuel';
      const anchors = plumeAnchors && plumeAnchors.length > 0 ? plumeAnchors : defaultPlumeAnchors(def);
      const plumeGroup = new THREE.Group();
      for (const anchor of anchors) {
        const plumeHolder = buildPlumeHolder(def.engine.plumeScale * anchor.scale, solid);
        plumeHolder.position.set(anchor.position[0], anchor.position[1], anchor.position[2]);
        plumeHolder.quaternion.set(anchor.rotation[0], anchor.rotation[1], anchor.rotation[2], anchor.rotation[3]);
        plumeGroup.add(plumeHolder);
      }
      plumeGroup.visible = false;
      plumeGroup.userData.power = 0;
      plumeGroup.userData.solid = solid;
      plumeGroup.userData.burning = false;
      // Parent to the part holder so plumes track the part through motion and removal.
      holder.add(plumeGroup);
      plumes.set(part.key, plumeGroup);
    }
    if (def.parachute) {
      const parachute = buildParachuteRig(def, ownedGeometries, ownedMaterials);
      holder.add(parachute);
      parachutes.set(part.key, parachute);
    }
  }
  return {
    group,
    partMeshes,
    plumes,
    parachutes,
    ownedGeometries,
    ownedMaterials,
    craftVersionSeen: craft.parts.length,
  };
}

function disposeOwnedGeometries(visual: VesselVisual, object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !visual.ownedGeometries.has(child.geometry)) return;
    child.geometry.dispose();
    visual.ownedGeometries.delete(child.geometry);
  });
}

/** Releases per-vessel geometry while intentionally preserving shared geometry/material caches. */
export function disposeVesselVisual(visual: VesselVisual): void {
  disposeOwnedGeometries(visual, visual.group);
  for (const material of visual.ownedMaterials) material.dispose();
  visual.ownedMaterials.clear();
  visual.group.clear();
  visual.partMeshes.clear();
  visual.plumes.clear();
  visual.parachutes.clear();
}

/**
 * Sync visual with craft state: remove meshes of destroyed/detached parts,
 * update plume visibility/scale from engine activity.
 */
export function syncVesselVisual(
  visual: VesselVisual,
  craft: Craft,
  throttle: number,
  pressureFrac: number,
  dt = 1 / 60,
  crossfeedIndex?: ReadonlyMap<number, readonly PartInstance[]>,
  effectTime = 0,
): void {
  // Remove meshes for missing parts. Plume groups parent under the part holder,
  // so disposing/removing the holder also releases their owned geometry.
  if (visual.craftVersionSeen !== craft.parts.length) {
    const alive = new Set(craft.parts.map((p) => p.key));
    for (const [key, mesh] of visual.partMeshes) {
      if (!alive.has(key)) {
        disposeOwnedGeometries(visual, mesh);
        visual.group.remove(mesh);
        visual.partMeshes.delete(key);
        visual.plumes.delete(key);
        visual.parachutes.delete(key);
      }
    }
    visual.craftVersionSeen = craft.parts.length;
  }
  updateEngineEffectMaterials(effectTime, pressureFrac);
  // Plumes follow throttle; vacuum broadens them. Each nozzle's child flame is
  // scaled in place so its authored anchor placement remains exact.
  for (const part of craft.parts) {
    const parachute = visual.parachutes.get(part.key);
    if (parachute) {
      const target = THREE.MathUtils.clamp(part.parachuteDeployFraction ?? (part.deployed ? 1 : 0), 0, 1);
      const previous = Number(parachute.userData.deployment ?? 0);
      const response = target > previous ? 4.8 : 8;
      let deployment = previous + (target - previous) * (1 - Math.exp(-response * Math.max(0, dt)));
      if (Math.abs(deployment - target) < 0.001) deployment = target;
      parachute.userData.deployment = deployment;
      parachute.visible = deployment > 0.004;
      const opened = THREE.MathUtils.smootherstep(deployment, 0, 1);
      const radialScale = THREE.MathUtils.lerp(0.08, 1, opened);
      const verticalScale = THREE.MathUtils.lerp(0.16, 1, opened);
      const breathe = 1 + Math.sin(effectTime * 2.6 + part.key) * 0.012 * opened;
      parachute.scale.set(radialScale * breathe, verticalScale, radialScale * breathe);
      parachute.rotation.x = Math.sin(effectTime * 1.7 + part.key * 0.7) * 0.018 * opened;
      parachute.rotation.z = Math.cos(effectTime * 1.5 + part.key) * 0.022 * opened;
    }
    const plumeGroup = visual.plumes.get(part.key);
    if (!plumeGroup) continue;
    const def = defOf(part);
    const solid = def.engine!.propellant === 'solidFuel';
    const airFactor = def.engine!.airBreathing
      ? THREE.MathUtils.smoothstep(pressureFrac, 0.003, 0.04)
      : 1;
    const targetPower = part.activated && engineHasFuel(craft, part, crossfeedIndex)
      ? (solid ? 1 : throttle) * airFactor
      : 0;
    const previousPower = Number(plumeGroup.userData.power ?? 0);
    const response = targetPower > previousPower ? 18 : 7;
    let power = previousPower + (targetPower - previousPower) * (1 - Math.exp(-response * Math.max(0, dt)));
    if (Math.abs(power - targetPower) < 0.001) power = targetPower;
    plumeGroup.userData.power = power;
    plumeGroup.userData.burning = targetPower > 0.001;
    plumeGroup.visible = power > 0.015;
    const pressure = THREE.MathUtils.clamp(pressureFrac, 0, 1);
    const intensity = Math.sqrt(Math.max(0, power));
    const radialPressure = THREE.MathUtils.lerp(1.72, 0.76, pressure);
    const axialPressure = THREE.MathUtils.lerp(1.14, 0.84, pressure);
    for (const nozzle of plumeGroup.children) {
      const flame = nozzle.userData.flameGroup as THREE.Group | undefined;
      if (!flame) continue;
      // Retain the historical holder-collapse contract used by diagnostics and
      // tests while keeping all authored anchor transforms untouched.
      nozzle.scale.setScalar(plumeGroup.visible ? 1 : 0.001);
      const baseScale = Number(nozzle.userData.baseScale ?? 1);
      flame.visible = plumeGroup.visible;
      const radialScale = baseScale * radialPressure * (0.14 + intensity * 0.86);
      const axialScale = baseScale * axialPressure * (0.22 + power * 0.78);
      flame.scale.set(radialScale, axialScale, radialScale);
    }
  }
}

/** Craft preview for the editor: same builder, plus per-part pickability. */
export function partMeshOf(visual: VesselVisual, key: number): THREE.Object3D | undefined {
  return visual.partMeshes.get(key);
}
