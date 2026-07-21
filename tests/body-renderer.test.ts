import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';
import { Body } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import { createBodyRendererCandidate } from '../src/render/bodyRendererFactory';
import { LegacyBodyRenderer } from '../src/render/legacyBodyRenderer';
import { StarBodyRenderer } from '../src/render/starBodyRenderer';
import { TerrestrialBodyRenderer } from '../src/render/terrestrialBodyRenderer';
import type { RenderCaps } from '../src/render/context';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import { disposeVesselVisual, type VesselVisual } from '../src/render/vesselMesh';
import { bodyFixedCameraVelocity, pruneBodyFrameSamples, WorldScene } from '../src/render/worldScene';
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
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: 37.416573867739416,
      angularRadius: 0.1,
      projectedPixelRadius: 93.84,
      proxyDepth: 3e8,
      proxyRadius: 30_100_401,
      visibility: 'physical',
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: -1, y: 0, z: 0 },
    bodySunDirection: { x: -1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 0,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: 1000,
    allowFlightTerrain: true,
    ...overrides,
  };
}

describe('body renderer adapters', () => {
  test('legacy rejects authored packs while star accepts only its own activity pack', () => {
    const solid = body('veyra');
    const star = body('auren');
    const legacyRenderer = new LegacyBodyRenderer(solid, bodyMaterialDescriptor(solid), caps, 'medium');
    const starRenderer = new StarBodyRenderer(star, bodyMaterialDescriptor(star), caps, 'medium');
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'veyra', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: '0'.repeat(64), gpuBytes: 0, textures: new Map(),
    };

    expect(() => legacyRenderer.stageAssets(null)).not.toThrow();
    expect(() => starRenderer.stageAssets(null)).not.toThrow();
    expect(() => legacyRenderer.stageAssets(pack)).toThrow(/procedural assets only/i);
    expect(() => starRenderer.stageAssets(pack)).toThrow(/cannot stage veyra assets on auren/i);
    const activity = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat);
    const starPack: RuntimeBodyAssetPack = {
      ...pack,
      bodyId: 'auren',
      gpuBytes: 1,
      textures: new Map([['photosphereActivity', activity]]),
    };
    expect(() => starRenderer.stageAssets(starPack)).not.toThrow();
    expect(starRenderer.stats()).toMatchObject({ assetTier: 'medium', assetBytes: 1 });
    legacyRenderer.dispose();
    starRenderer.dispose();
  });

  test('airless legacy bodies stage authored albedo, oct normals, and material maps', () => {
    const palla = body('palla');
    const renderer = new LegacyBodyRenderer(palla, bodyMaterialDescriptor(palla), caps, 'medium');
    const texture = () => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'palla', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: '0'.repeat(64), gpuBytes: 12,
      textures: new Map([['albedo', texture()], ['normal', texture()], ['material', texture()]]),
    };

    expect(() => renderer.stageAssets(pack)).not.toThrow();
    const compact = renderer.root.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
    expect(compact.material.userData).toMatchObject({ airlessGlobal: true, bodyId: 'palla' });
    expect(compact.geometry.parameters).toMatchObject({ widthSegments: 96, heightSegments: 64 });
    expect(pack.textures.get('albedo')!.anisotropy).toBe(8);
    renderer.dispose();
  });

  test('factory selection is controlled by BODY_VISUALS, not surface or terrain data', () => {
    const star = body('auren');
    star.def.surfaceKind = 'solid';
    star.def.terrain.amplitude = 1234;
    const gas = body('tyran');
    gas.def.surfaceKind = 'gas';
    gas.def.terrain.amplitude = 999_999;

    expect(createBodyRendererCandidate({ body: star, caps, quality: 'medium' })).toBeInstanceOf(StarBodyRenderer);
    expect(createBodyRendererCandidate({ body: gas, caps, quality: 'medium' })).toBeInstanceOf(LegacyBodyRenderer);
    expect(createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' })).toBeInstanceOf(TerrestrialBodyRenderer);
  });

  test('legacy solid renderer owns compact, terrain, and cloud visuals during landing approach', () => {
    const solid = body('veyra');
    solid.def.terrain.amplitude = 0;
    const terrain = { group: new THREE.Group(), stats: { chunks: 2, visible: 1 }, update: vi.fn(), dispose: vi.fn() };
    const cloud = { mesh: new THREE.Mesh(), update: vi.fn(), dispose: vi.fn() };
    const renderer = new LegacyBodyRenderer(solid, bodyMaterialDescriptor(solid), caps, 'medium', {
      createTerrain: () => terrain,
      createCloud: () => cloud,
    });

    renderer.update(frame({ cameraBodyFixed: { x: solid.radius + 1_000, y: 0, z: 0 }, altitude: 1_000 }));
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
    expect((lights[0] as THREE.DirectionalLight).castShadow).toBe(true);

    const corona = visibleSources[0].children.find((child): child is THREE.Mesh => (
      child instanceof THREE.Mesh && child.material.userData.solarCorona === true
    ))!;
    const disk = visibleSources[0].children.find((child): child is THREE.Mesh => (
      child instanceof THREE.Mesh && child.material.userData.solarPhotosphere === true
    ))!;
    expect(corona).toBeDefined();
    expect(disk).toBeDefined();

    renderer.update(frame({
      cameraRelativeOrigin: { x: 1e10, y: 0, z: 0 },
      cameraSunDirection: { x: 1, y: 0, z: 0 },
      projection: {
        trueObserverDistance: 1e10,
        angularRadius: Math.asin(star.radius / 1e10),
        projectedPixelRadius: 50,
        proxyDepth: 3e8,
        proxyRadius: 3e8 * Math.tan(Math.asin(star.radius / 1e10)),
        visibility: 'far-field',
      },
    }));
    const presentation = visibleSources[0];
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(presentation.quaternion);
    expect(Math.abs(normal.dot(new THREE.Vector3(-1, 0, 0)))).toBeCloseTo(1, 5);
    expect(renderer.stats()).toMatchObject({ visible: 1, presentationMode: 'proxy' });

    renderer.update(frame({
      cameraSunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 0.5,
      solarOccluder: { direction: { x: 1, y: 0.01, z: 0 }, angularRadius: 0.04 },
      projection: {
        trueObserverDistance: 1e10,
        angularRadius: 0.1,
        projectedPixelRadius: 80,
        proxyDepth: 3e8,
        proxyRadius: 3e8 * Math.tan(0.1),
        visibility: 'far-field',
      },
    }));
    const diskUniforms = (disk.material as THREE.ShaderMaterial).uniforms;
    const coronaUniforms = (corona.material as THREE.ShaderMaterial).uniforms;
    expect(diskUniforms.uUseOccluder.value).toBe(1);
    expect(coronaUniforms.uUseOccluder.value).toBe(1);
    expect(coronaUniforms.uOccluderRadius.value).toBe(diskUniforms.uOccluderRadius.value);
    expect(coronaUniforms.uOccluderCenter.value).toEqual(diskUniforms.uOccluderCenter.value);
    renderer.root.visible = false;
    expect(renderer.stats().visible).toBe(0);
  });

  test('adapter disposal is idempotent and releases only owned resources', () => {
    const star = body('auren');
    const renderer = new StarBodyRenderer(star, bodyMaterialDescriptor(star), caps, 'low');
    const source = renderer.root.children.find((child) => child.userData.starPresentation === true)!;
    const disk = source.children.find((child): child is THREE.Mesh => (
      child instanceof THREE.Mesh && child.material.userData.solarPhotosphere === true
    ))!;
    const corona = source.children.find((child): child is THREE.Mesh => (
      child instanceof THREE.Mesh && child.material.userData.solarCorona === true
    ))!;
    const geometryDispose = vi.spyOn(disk.geometry, 'dispose');
    const materialDispose = vi.spyOn(corona.material as THREE.Material, 'dispose');

    renderer.dispose();
    renderer.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
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
      parachutes: new Map(),
      ownedGeometries: new Set([ownedGeometry]),
      ownedMaterials: new Set(),
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

  test('losing the active vessel preserves the previous renderer for rapid state recovery', () => {
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

    expect(dispose).not.toHaveBeenCalled();
    expect(scene.children).toContain(root);
  });

  test('setQuality retries only managers whose committed tier is still stale', async () => {
    const stale = { current: vi.fn(() => ({ quality: 'medium' })), replaceQuality: vi.fn()
      .mockRejectedValueOnce(new Error('compile failed')).mockResolvedValueOnce(undefined) };
    const current = { current: vi.fn(() => ({ quality: 'high' })), replaceQuality: vi.fn() };
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      quality: 'medium',
      bodyRendererManagers: new Map([['veyra', stale], ['auren', current]]),
      bodyRenderers: new Map(),
    });

    world.setQuality('high');
    await Promise.resolve();
    await Promise.resolve();
    world.setQuality('high');
    await Promise.resolve();

    expect(stale.replaceQuality).toHaveBeenCalledTimes(2);
    expect(current.replaceQuality).not.toHaveBeenCalled();
  });

  test('a body returning after absence starts with zero body-fixed camera velocity', () => {
    const samples = new Map<string, BodyRenderFrame>([['veyra', frame({
      cameraBodyFixed: { x: 100, y: 200, z: 300 },
    })]]);
    pruneBodyFrameSamples(samples, new Set());
    expect(samples.has('veyra')).toBe(false);
    expect(bodyFixedCameraVelocity(
      { x: 1_000_000, y: -2_000_000, z: 3_000_000 },
      samples.get('veyra'),
      1 / 60,
    )).toEqual({ x: 0, y: 0, z: 0 });
  });
});
