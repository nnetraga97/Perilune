import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import { createBodyRendererCandidate } from '../src/render/bodyRendererFactory';
import { LegacyBodyRenderer } from '../src/render/legacyBodyRenderer';
import { StarBodyRenderer } from '../src/render/starBodyRenderer';
import type { RenderCaps } from '../src/render/context';
import type { BodyRenderFrame } from '../src/render/bodyRenderer';
import { disposeVesselVisual, type VesselVisual } from '../src/render/vesselMesh';
import { WorldScene } from '../src/render/worldScene';
import type { BodyRenderer } from '../src/render/bodyRenderer';

const caps: RenderCaps = {
  backend: 'webgl2',
  fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: { astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false },
  maxTextureSize: 8192,
  maxAnisotropy: 8,
  drawingBufferSamples: 4,
};

function body(id: string): Body {
  const def = structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === id)!);
  return new Body(def, null);
}

function frame(overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 10, y: 20, z: 30 },
    cameraBodyFixed: { x: 7_000_000, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: -1, y: 0, z: 0 },
    bodySunDirection: { x: -1, y: 0, z: 0 },
    time: 0,
    altitude: 1000,
    allowFlightTerrain: true,
    ...overrides,
  };
}

describe('body renderer adapters', () => {
  test('factory selection is controlled by BODY_VISUALS, not surface or terrain data', () => {
    const star = body('auren');
    star.def.surfaceKind = 'solid';
    star.def.terrain.amplitude = 1234;
    const gas = body('tyran');
    gas.def.surfaceKind = 'gas';
    gas.def.terrain.amplitude = 999_999;

    expect(createBodyRendererCandidate({ body: star, caps, quality: 'medium' })).toBeInstanceOf(StarBodyRenderer);
    expect(createBodyRendererCandidate({ body: gas, caps, quality: 'medium' })).toBeInstanceOf(LegacyBodyRenderer);
  });

  test('legacy solid renderer owns compact, terrain, and cloud visuals without amplitude selection', () => {
    const solid = body('veyra');
    solid.def.terrain.amplitude = 0;
    const terrain = { group: new THREE.Group(), stats: { chunks: 2, visible: 1 }, update: vi.fn(), dispose: vi.fn() };
    const cloud = { mesh: new THREE.Mesh(), update: vi.fn(), dispose: vi.fn() };
    const renderer = new LegacyBodyRenderer(solid, bodyMaterialDescriptor(solid), caps, 'medium', {
      createTerrain: () => terrain,
      createCloud: () => cloud,
    });

    renderer.update(frame({ cameraBodyFixed: { x: solid.radius * 2, y: 0, z: 0 } }));
    expect(renderer.root.children).toContain(terrain.group);
    expect(renderer.root.children).toContain(cloud.mesh);
    expect(terrain.update).toHaveBeenCalledOnce();
    expect(renderer.stats()).toMatchObject({ chunks: 2, visible: 1, terrainActive: true });
  });

  test('gas legacy renderer remains compact and never creates or calls rocky terrain', () => {
    const gas = body('tyran');
    const createTerrain = vi.fn();
    const createCloud = vi.fn();
    const renderer = new LegacyBodyRenderer(gas, bodyMaterialDescriptor(gas), caps, 'high', {
      createTerrain,
      createCloud,
    });

    renderer.update(frame({ cameraBodyFixed: { x: gas.radius * 1.1, y: 0, z: 0 } }));
    expect(createTerrain).not.toHaveBeenCalled();
    expect(createCloud).not.toHaveBeenCalled();
    expect(renderer.stats().terrainActive).toBe(false);
  });

  test('only an explicitly permitted active body enables flight-scale terrain', () => {
    const solid = body('veyra');
    const terrain = { group: new THREE.Group(), stats: { chunks: 0, visible: 0 }, update: vi.fn(), dispose: vi.fn() };
    const createTerrain = vi.fn(() => terrain);
    const renderer = new LegacyBodyRenderer(solid, bodyMaterialDescriptor(solid), caps, 'medium', {
      createTerrain,
      createCloud: () => null,
    });

    renderer.update(frame({ cameraBodyFixed: { x: solid.radius * 2, y: 0, z: 0 }, allowFlightTerrain: false }));
    expect(terrain.update).not.toHaveBeenCalled();
    expect(createTerrain).not.toHaveBeenCalled();
    expect(renderer.root.children).not.toContain(terrain.group);
    expect(renderer.stats().terrainActive).toBe(false);
  });

  test('revoking active-SOI permission releases terrain and clouds exactly once', () => {
    const solid = body('veyra');
    const terrain = { group: new THREE.Group(), stats: { chunks: 2, visible: 1 }, update: vi.fn(), dispose: vi.fn() };
    const cloud = { mesh: new THREE.Mesh(), update: vi.fn(), dispose: vi.fn() };
    const renderer = new LegacyBodyRenderer(solid, bodyMaterialDescriptor(solid), caps, 'medium', {
      createTerrain: () => terrain,
      createCloud: () => cloud,
    });
    renderer.update(frame({ cameraBodyFixed: { x: solid.radius * 2, y: 0, z: 0 } }));

    renderer.update(frame({ allowFlightTerrain: false }));
    renderer.update(frame({ allowFlightTerrain: false }));

    expect(terrain.dispose).toHaveBeenCalledOnce();
    expect(cloud.dispose).toHaveBeenCalledOnce();
    expect(renderer.root.children).not.toContain(terrain.group);
    expect(renderer.root.children).not.toContain(cloud.mesh);
    expect(renderer.stats()).toMatchObject({ chunks: 0, visible: 0, terrainActive: false });
  });

  test('star owns exactly one visible source, one directional light, and its target', () => {
    const star = body('auren');
    const renderer = new StarBodyRenderer(star, bodyMaterialDescriptor(star), caps, 'medium');
    const visibleSources = renderer.root.children.filter((child) => child.userData.starPresentation === true);
    const lights = renderer.root.children.filter((child) => child instanceof THREE.DirectionalLight);

    expect(visibleSources).toHaveLength(1);
    expect(lights).toHaveLength(1);
    expect(renderer.root.children).toContain((lights[0] as THREE.DirectionalLight).target);

    const corona = visibleSources[0].children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite)!;
    const alpha = (corona.material.map!.image as { data: Uint8Array }).data;
    expect(alpha[3]).toBe(0);
    expect(alpha[(8 * 16 + 8) * 4 + 3]).toBeGreaterThan(0);

    renderer.update(frame({ cameraRelativeOrigin: { x: 1e9, y: 0, z: 0 }, cameraSunDirection: { x: 1, y: 0, z: 0 } }));
    const presentation = visibleSources[0];
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(presentation.quaternion);
    expect(Math.abs(normal.dot(new THREE.Vector3(-1, 0, 0)))).toBeCloseTo(1, 5);
    expect(renderer.stats().visible).toBe(0);
    renderer.root.visible = false;
    expect(renderer.stats().visible).toBe(0);
  });

  test('adapter disposal is idempotent and releases only owned resources', () => {
    const star = body('auren');
    const renderer = new StarBodyRenderer(star, bodyMaterialDescriptor(star), caps, 'low');
    const source = renderer.root.children.find((child) => child.userData.starPresentation === true)!;
    const disk = source.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh)!;
    const corona = source.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite)!;
    const geometryDispose = vi.spyOn(disk.geometry, 'dispose');
    const materialDispose = vi.spyOn(corona.material, 'dispose');
    const textureDispose = vi.spyOn(corona.material.map!, 'dispose');

    renderer.dispose();
    renderer.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(renderer.root.children).toHaveLength(0);
    expect(renderer.ready).toBe(false);
    expect(renderer.stats()).toMatchObject({ visible: 0, exposure: 0 });
  });

  test('vessel cleanup releases per-visual geometry without invalidating shared caches', () => {
    const sharedGeometry = new THREE.BoxGeometry();
    const ownedGeometry = new THREE.CylinderGeometry();
    const sharedMaterial = new THREE.MeshBasicMaterial();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(sharedGeometry, sharedMaterial), new THREE.Mesh(ownedGeometry, sharedMaterial));
    const visual: VesselVisual = {
      group,
      partMeshes: new Map(),
      plumes: new Map(),
      ownedGeometries: new Set([ownedGeometry]),
      craftVersionSeen: 0,
    };
    const sharedDispose = vi.spyOn(sharedGeometry, 'dispose');
    const ownedDispose = vi.spyOn(ownedGeometry, 'dispose');
    const materialDispose = vi.spyOn(sharedMaterial, 'dispose');

    disposeVesselVisual(visual);
    disposeVesselVisual(visual);

    expect(ownedDispose).toHaveBeenCalledOnce();
    expect(sharedDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
  });

  test('losing the active vessel releases the previous flight renderer before returning', () => {
    const root = new THREE.Group();
    const dispose = vi.fn();
    const previous = { root, dispose } as unknown as BodyRenderer;
    const scene = new THREE.Scene();
    scene.add(root);
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      scene,
      bodyRenderers: new Map([['veyra', previous]]),
      flightTerrainBodyId: 'veyra',
    });

    world.update({ active: null } as never, 0);

    expect(dispose).toHaveBeenCalledOnce();
    expect(scene.children).not.toContain(root);
  });
});
