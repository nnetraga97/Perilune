/**
 * Vessel rendering: builds a THREE.Group from a craft's part shapes.
 * All geometry is procedural (original industrial look: matte hulls with
 * accent bands), cached per part definition. Engine plumes are additive
 * cones scaled by throttle and ambient pressure.
 */
import * as THREE from 'three';
import type { Craft, PartInstance } from '../sim/vessel';
import { defOf } from '../sim/vessel';
import type { PartDef } from '../content/parts';
import { engineHasFuel } from '../sim/flight';

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
  /** Plume meshes keyed by engine part key. */
  plumes: Map<number, THREE.Mesh>;
  craftVersionSeen: number;
}

const plumeMaterial = new THREE.MeshBasicMaterial({
  color: '#ffb36b',
  transparent: true,
  opacity: 0.75,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const plumeCoreMaterial = new THREE.MeshBasicMaterial({
  color: '#fff3d6',
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

function buildPartMesh(part: PartInstance): THREE.Object3D {
  const def = defOf(part);
  const holder = new THREE.Group();
  const body = new THREE.Mesh(geometryFor(def), materialFor(def.color ?? '#c8cdd2'));
  body.castShadow = false;
  holder.add(body);
  // Accent band for visual identity (cheap, no textures).
  const isStraightStack =
    def.shape.kind === 'cylinder' ||
    (def.shape.kind === 'cone' && Math.abs((def.shape.radiusTop ?? 0) - (def.shape.radiusBottom ?? 0)) < 1e-6);
  if (def.accent && isStraightStack && !def.pod && !def.probe) {
    const r = Math.max(def.shape.radiusTop ?? 0.1, def.shape.radiusBottom ?? 0.1);
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.012, r * 1.012, def.shape.height * 0.12, 20),
      materialFor(def.accent, 0.2, 0.6),
    );
    band.position.y = def.shape.height * 0.28;
    holder.add(band);
  }
  holder.position.set(part.position.x, part.position.y, part.position.z);
  holder.quaternion.set(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w);
  return holder;
}

export function buildVesselVisual(craft: Craft): VesselVisual {
  const group = new THREE.Group();
  const partMeshes = new Map<number, THREE.Object3D>();
  const plumes = new Map<number, THREE.Mesh>();
  for (const part of craft.parts) {
    const mesh = buildPartMesh(part);
    partMeshes.set(part.key, mesh);
    group.add(mesh);
    const def = defOf(part);
    if (def.engine) {
      const scale = def.engine.plumeScale;
      const plume = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08 * scale, 0.5 * scale, 4 * scale, 12, 1, true),
        plumeMaterial,
      );
      const core = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04 * scale, 0.22 * scale, 2.4 * scale, 10, 1, true),
        plumeCoreMaterial,
      );
      core.position.y = 0.6 * scale;
      plume.add(core);
      plume.position.set(
        part.position.x,
        part.position.y - def.shape.height / 2 - 2 * scale,
        part.position.z,
      );
      plume.visible = false;
      plume.userData.power = 0;
      group.add(plume);
      plumes.set(part.key, plume);
    }
  }
  return { group, partMeshes, plumes, craftVersionSeen: craft.parts.length };
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
): void {
  // Remove meshes for missing parts.
  if (visual.craftVersionSeen !== craft.parts.length) {
    const alive = new Set(craft.parts.map((p) => p.key));
    for (const [key, mesh] of visual.partMeshes) {
      if (!alive.has(key)) {
        visual.group.remove(mesh);
        visual.partMeshes.delete(key);
        const plume = visual.plumes.get(key);
        if (plume) {
          visual.group.remove(plume);
          visual.plumes.delete(key);
        }
      }
    }
    visual.craftVersionSeen = craft.parts.length;
  }
  // Plumes follow throttle; vacuum expands them.
  for (const part of craft.parts) {
    const plume = visual.plumes.get(part.key);
    if (!plume) continue;
    const def = defOf(part);
    const solid = def.engine!.propellant === 'solidFuel';
    const targetPower = part.activated && engineHasFuel(craft, part) ? (solid ? 1 : throttle) : 0;
    const previousPower = Number(plume.userData.power ?? 0);
    const response = targetPower > previousPower ? 18 : 7;
    let power = previousPower + (targetPower - previousPower) * (1 - Math.exp(-response * Math.max(0, dt)));
    if (Math.abs(power - targetPower) < 0.001) power = targetPower;
    plume.userData.power = power;
    plume.visible = power > 0.015;
    if (plume.visible) {
      const vacuumFlare = 1 + (1 - pressureFrac) * 1.3;
      plume.scale.set(power * vacuumFlare, 0.6 + power * 0.7, power * vacuumFlare);
    } else {
      plume.scale.set(0, 0, 0);
    }
  }
}

/** Craft preview for the editor: same builder, plus per-part pickability. */
export function partMeshOf(visual: VesselVisual, key: number): THREE.Object3D | undefined {
  return visual.partMeshes.get(key);
}
