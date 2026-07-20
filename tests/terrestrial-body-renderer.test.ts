import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
import { createBodyRendererCandidate } from '../src/render/bodyRendererFactory';
import { LegacyBodyRenderer } from '../src/render/legacyBodyRenderer';
import {
  launchPadScatterSuppressionSphere,
  TerrestrialBodyRenderer,
} from '../src/render/terrestrialBodyRenderer';
import { RenderDiagnostics } from '../src/render/renderDiagnostics';
import { Vec3 } from '../src/core/vec3';
import {
  LAUNCH_PAD_FOOTPRINT_RADIUS,
  launchSiteBodyFixedDirection,
} from '../src/sim/launchSite';
import { solidHeight } from '../src/sim/terrain';
import { globalSphereSegments } from '../src/render/terrestrial/globalGeometry';
import {
  FLIGHT_AERIAL_USER_DATA_KEY,
  FlightAerialPerspectiveController,
} from '../src/render/flightAerialPerspective';

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
  const definition = [...SOL_SYSTEM, ...AUREN_SYSTEM].find((candidate) => candidate.id === id);
  return new Body(structuredClone(definition!), null);
}

function texture(bytes = [128, 128, 128, 255]): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

function pack(tier: 'low' | 'medium' | 'high' = 'medium'): RuntimeBodyAssetPack {
  return {
    bodyId: 'veyra', tier, width: 2048, height: 1024, manifestDigest: 'a'.repeat(64), gpuBytes: 100,
    textures: new Map([
      ['albedo', texture([120, 150, 110, 255])],
      ['normal', texture([128, 128, 0, 255])],
      ['material', texture([190, 240, 80, 128])],
      ['clouds', texture([180, 210, 0, 255])],
    ]),
  };
}

function frame(radius: number, overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 10, y: 20, z: 30 },
    cameraBodyFixed: { x: radius * 2, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: radius * 2,
      angularRadius: Math.asin(0.5),
      projectedPixelRadius: 540,
      proxyDepth: 3e8,
      proxyRadius: 173205080.75688773,
      visibility: 'physical',
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 10,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: radius,
    allowFlightTerrain: true,
    ...overrides,
  };
}

describe('TerrestrialBodyRenderer integration', () => {
  it.each(['low', 'medium', 'high'] as const)('scales compact planet tessellation for %s quality', (quality) => {
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality }) as TerrestrialBodyRenderer;
    const compact = renderer.root.getObjectByName('terrestrial-compact:veyra') as THREE.Mesh<THREE.SphereGeometry>;
    const [widthSegments, heightSegments] = globalSphereSegments(quality);
    expect(compact.geometry.parameters).toMatchObject({ widthSegments, heightSegments });
    renderer.dispose();
  });

  it('reports the existing compact-to-terrain presentation without changing its result', async () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: true, now: () => now++ });
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({
      body: veyra, caps, quality: 'medium', diagnostics,
    }) as TerrestrialBodyRenderer;
    const approach = { cameraBodyFixed: { x: veyra.radius + 1_000, y: 0, z: 0 }, altitude: 1_000 };
    await vi.waitFor(() => {
      renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0 }));
      const states = diagnostics.snapshot().entries
        .filter((entry) => entry.event === 'presentation-state')
        .map((entry) => entry.data.state);
      expect(states).toContain('fading');
    }, { timeout: 2_000, interval: 10 });
    renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0.35 }));
    const states = diagnostics.snapshot().entries
      .filter((entry) => entry.event === 'presentation-state')
      .map((entry) => entry.data.state);
    expect(states).toEqual(['prewarming', 'fading', 'terrain']);
    expect(renderer.stats()).toMatchObject({ terrainActive: true, coverageProgress: 1 });
    renderer.dispose();
  });

  it('selects only Veyra explicitly while retaining legacy relatives', () => {
    const veyraRenderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' });
    const vessRenderer = createBodyRendererCandidate({ body: body('vess'), caps, quality: 'medium' });
    expect(veyraRenderer).toBeInstanceOf(TerrestrialBodyRenderer);
    expect(vessRenderer).toBeInstanceOf(LegacyBodyRenderer);
    veyraRenderer.dispose();
    vessRenderer.dispose();
  });

  it('composes Veyra without a decorative near-surface scatter layer', () => {
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    const authored = pack();
    renderer.stageAssets(authored);
    expect(renderer.root.children.map((child) => child.name)).toEqual([
      'terrestrial-compact:veyra',
      'terrestrial-terrain:veyra',
      'terrestrial-ocean:veyra',
      'terrestrial-atmosphere:veyra',
      'terrestrial-cloud-deck:veyra',
    ]);
    expect(renderer.root.getObjectByName('terrestrial-cloud:veyra:weather')).toBeDefined();
    expect(renderer.root.getObjectByName('terrestrial-cloud:veyra:wisps')).toBeDefined();
    const lights: THREE.Light[] = [];
    renderer.root.traverse((object) => { if (object instanceof THREE.Light) lights.push(object); });
    expect(lights).toHaveLength(0);
    for (const channel of ['albedo', 'normal', 'material'] as const) {
      expect(authored.textures.get(channel)?.anisotropy).toBe(4);
    }
    renderer.dispose();
  });

  it('keeps compact coverage through prewarm then completes the terrain transition', () => {
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({ body: veyra, caps, quality: 'low' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(pack('low'));
    const approach = { cameraBodyFixed: { x: veyra.radius + 1_000, y: 0, z: 0 }, altitude: 1_000 };
    renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0 }));
    expect(renderer.stats()).toMatchObject({ terrainActive: false, coverageProgress: 0 });
    for (let update = 0; update < 12; update++) {
      renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0 }));
    }
    renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0.175 }));
    const compact = renderer.root.getObjectByName('terrestrial-compact:veyra') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
    const terrain = renderer.root.getObjectByName('terrestrial-terrain:veyra')!;
    expect(renderer.stats()).toMatchObject({ terrainActive: true, coverageProgress: 0.5 });
    expect(terrain.visible).toBe(true);
    expect(compact.visible).toBe(true);
    expect(compact.material).toMatchObject({ transparent: true, depthWrite: false, opacity: 0.5 });
    renderer.update(frame(veyra.radius, { ...approach, deltaSeconds: 0.35 }));
    expect(renderer.stats()).toMatchObject({ terrainActive: true, coverageProgress: 1 });
    expect(compact.visible).toBe(false);
    renderer.update(frame(veyra.radius, { allowFlightTerrain: false }));
    expect(renderer.stats()).toMatchObject({ terrainActive: false, coverageProgress: 0 });
    expect(compact.visible).toBe(true);
    renderer.dispose();
  });

  it('anchors the near-surface compact fallback to authoritative terrain height', () => {
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({ body: veyra, caps, quality: 'low' }) as TerrestrialBodyRenderer;
    const direction = launchSiteBodyFixedDirection(new Vec3());
    const surface = solidHeight(veyra, direction);
    expect(surface.kind).toBe('solid');
    const height = surface.kind === 'solid' ? surface.height : 0;
    const anchor = new Vec3().copy(direction).scale(veyra.radius + height);
    const camera = new Vec3().copy(direction).scale(veyra.radius + height + 18);

    renderer.update(frame(veyra.radius, {
      cameraBodyFixed: camera,
      surfaceAnchorBodyFixed: anchor,
      altitude: height + 18,
    }));
    const compact = renderer.root.getObjectByName('terrestrial-compact:veyra') as THREE.Mesh;
    expect(compact.scale.x).toBeCloseTo(veyra.radius + height, 6);
    expect(compact.scale.y).toBe(compact.scale.x);
    expect(compact.scale.z).toBe(compact.scale.x);

    renderer.update(frame(veyra.radius, {
      cameraBodyFixed: { x: veyra.radius * 80, y: 0, z: 0 },
      surfaceAnchorBodyFixed: anchor,
      altitude: veyra.radius * 79,
      allowFlightTerrain: false,
    }));
    expect(compact.scale.x).toBe(veyra.radius);
    renderer.dispose();
  });

  it('keeps generated rocks, vegetation, decals, and dust disabled at every distance', () => {
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({ body: veyra, caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(pack('medium'));
    const near = { cameraBodyFixed: { x: veyra.radius + 80, y: 0, z: 0 }, altitude: 80 };
    for (let i = 0; i < 4; i++) renderer.update(frame(veyra.radius, { ...near, deltaSeconds: 0.35 }));
    const surfaceStats = renderer.stats();
    expect(surfaceStats.terrainActive).toBe(true);
    expect(surfaceStats).toMatchObject({
      visualScatter: 0,
      decals: 0,
      dust: 0,
      scatterBytes: 0,
      effectBytes: 0,
    });
    expect(renderer.root.getObjectByName('terrestrial-scatter')).toBeUndefined();
    expect(renderer.root.getObjectByName('terrestrial-surface-effects')).toBeUndefined();
    renderer.update(frame(veyra.radius, { cameraBodyFixed: { x: veyra.radius * 3, y: 0, z: 0 }, altitude: veyra.radius, allowFlightTerrain: false }));
    expect(renderer.stats().visualScatter).toBe(0);
    renderer.dispose();
  });

  it('streams neutral Earth geology only after complete terrain coverage', () => {
    const earth = body('earth');
    const flightAerial = new FlightAerialPerspectiveController();
    const renderer = createBodyRendererCandidate({
      body: earth, caps, quality: 'medium', flightAerial,
    }) as TerrestrialBodyRenderer;
    const direction = launchSiteBodyFixedDirection(new Vec3());
    const launchSurface = solidHeight(earth, direction);
    expect(launchSurface.kind).toBe('solid');
    const anchor = new Vec3().copy(direction).scale(
      earth.radius + (launchSurface.kind === 'solid' ? launchSurface.height : 0),
    );
    const camera = new Vec3().copy(direction).scale(anchor.length() + 15);
    const near = {
      cameraBodyFixed: camera,
      cameraRelativeOrigin: camera,
      surfaceAnchorBodyFixed: anchor,
      altitude: 15,
      allowFlightTerrain: true,
    };
    renderer.update(frame(earth.radius, { ...near, deltaSeconds: 0 }));
    expect(renderer.stats()).toMatchObject({ coverageProgress: 0, visualScatter: 0 });
    for (let update = 0; update < 16; update++) {
      renderer.update(frame(earth.radius, { ...near, deltaSeconds: 0 }));
    }
    renderer.update(frame(earth.radius, { ...near, deltaSeconds: 0.175 }));
    expect(renderer.stats().coverageProgress).toBeGreaterThan(0);
    expect(renderer.stats().coverageProgress).toBeLessThan(1);
    expect(renderer.stats().visualScatter).toBe(0);
    renderer.update(frame(earth.radius, { ...near, deltaSeconds: 0.35 }));
    expect(renderer.stats().coverageProgress).toBe(1);
    expect(renderer.stats().visualScatter).toBeGreaterThan(0);
    expect(renderer.stats().scatterBytes).toBeGreaterThan(0);
    const scatter = renderer.root.getObjectByName('terrestrial-scatter')!;
    expect(scatter.visible).toBe(true);
    scatter.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      expect(['terrestrial-scatter:stone', 'terrestrial-scatter:clast']).toContain(object.name);
      expect(object.castShadow).toBe(true);
      expect(object.receiveShadow).toBe(true);
      expect((object.material as THREE.Material).userData[FLIGHT_AERIAL_USER_DATA_KEY])
        .toBe(flightAerial);
    });
    expect(flightAerial.snapshot()).toMatchObject({ active: true, bodyId: 'earth' });

    renderer.update(frame(earth.radius, { ...near, allowFlightTerrain: false }));
    expect(renderer.stats().visualScatter).toBe(0);
    expect(scatter.visible).toBe(false);
    renderer.dispose();
    flightAerial.dispose();
  });

  it('derives the Earth scatter exclusion from the authored launch-pad footprint', () => {
    const earth = body('earth');
    const direction = launchSiteBodyFixedDirection(new Vec3());
    const suppression = launchPadScatterSuppressionSphere(earth);
    const centerLength = Math.hypot(suppression.x, suppression.y, suppression.z);
    expect(suppression.radius).toBe(LAUNCH_PAD_FOOTPRINT_RADIUS);
    expect(suppression.x / centerLength).toBeCloseTo(direction.x, 12);
    expect(suppression.y / centerLength).toBeCloseTo(direction.y, 12);
    expect(suppression.z / centerLength).toBeCloseTo(direction.z, 12);
  });

  it('does not emit Earth geology over the ocean reference location', () => {
    const earth = body('earth');
    const renderer = createBodyRendererCandidate({
      body: earth, caps, quality: 'low',
    }) as TerrestrialBodyRenderer;
    const latitude = 18 * Math.PI / 180;
    const longitude = -155 * Math.PI / 180;
    const direction = new Vec3(
      Math.cos(latitude) * Math.cos(longitude),
      Math.cos(latitude) * Math.sin(longitude),
      Math.sin(latitude),
    );
    const oceanSurface = solidHeight(earth, direction);
    expect(oceanSurface.kind).toBe('solid');
    expect(oceanSurface.kind === 'solid' ? oceanSurface.height : 0).toBeLessThan(0);
    const camera = new Vec3().copy(direction).scale(earth.radius + 25);
    const ocean = {
      cameraBodyFixed: camera,
      cameraRelativeOrigin: camera,
      surfaceAnchorBodyFixed: new Vec3().copy(direction).scale(earth.radius),
      altitude: 25,
      allowFlightTerrain: true,
    };
    for (let update = 0; update < 16; update++) {
      renderer.update(frame(earth.radius, { ...ocean, deltaSeconds: 0 }));
    }
    renderer.update(frame(earth.radius, { ...ocean, deltaSeconds: 0.35 }));
    expect(renderer.stats()).toMatchObject({ coverageProgress: 1, visualScatter: 0 });
    renderer.dispose();
  });

  it('has a runnable procedural fallback and validates staged pack ownership', () => {
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    expect(renderer.ready).toBe(true);
    expect(renderer.root.getObjectByName('terrestrial-compact:veyra')).toBeDefined();
    expect(() => renderer.stageAssets({ ...pack(), bodyId: 'palla' })).toThrow(/cannot stage/i);
    expect(() => renderer.stageAssets({ ...pack('high') })).toThrow(/cannot stage/i);
    renderer.stageAssets(null);
    expect(renderer.ready).toBe(true);
    renderer.dispose();
  });

  it('disposes the complete stack exactly once without releasing borrowed textures', () => {
    const borrowed = pack();
    const textureDisposals = [...borrowed.textures.values()].map((value) => vi.spyOn(value, 'dispose'));
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(borrowed);
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    renderer.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    const materialDisposals = [...materials].map((material) => vi.spyOn(material, 'dispose'));
    const geometryDisposals = [...geometries].map((geometry) => vi.spyOn(geometry, 'dispose'));
    renderer.dispose();
    renderer.dispose();
    expect(renderer.root.children).toHaveLength(0);
    for (const dispose of materialDisposals) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of geometryDisposals) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of textureDisposals) expect(dispose).not.toHaveBeenCalled();
  });
});
