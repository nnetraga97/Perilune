import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
  ARTEMIS_IV_PREFLIGHT_ACTIONS,
  ARTEMIS_IV_PROVIDER_LABEL,
  ARTEMIS_IV_STARSHIP_BYTE_LENGTH,
  ARTEMIS_IV_STARSHIP_LABEL,
  ARTEMIS_IV_STARSHIP_PUBLIC_URL,
  ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES,
  ARTEMIS_IV_VOYAGER_VISUAL_BINDING,
  ArtemisIvAssetLoadError,
  CHECKED_ARTEMIS_IV_ASSET_MANIFEST,
  checkArtemisIvAssetManifest,
  createArtemisIvAssetLoader,
  preflightArtemisIvAssets,
  type ArtemisIvAssetResourceAccounting,
  type ArtemisIvRendererResourceLedger,
} from '../src/missions/artemisIv/assets';

const root = new URL('../', import.meta.url);
const rawManifest = JSON.parse(readFileSync(new URL('assets/missions/artemis-iv/manifest.json', root), 'utf8'));
const exactStarshipBytes = new Uint8Array(readFileSync(
  new URL('assets/missions/artemis-iv/models/martiandays-spacex-starship-2019.glb', root),
));

class TestLedger implements ArtemisIvRendererResourceLedger {
  readonly charges: ArtemisIvAssetResourceAccounting[] = [];
  readonly releases: string[] = [];

  constructor(private total: number) {}

  totalRendererBytes(): number { return this.total; }

  charge(entry: Readonly<ArtemisIvAssetResourceAccounting>): void {
    this.charges.push(entry);
    this.total += entry.gpuBytes;
  }

  release(assetId: 'martiandays-starship-2019-concept'): void {
    this.releases.push(assetId);
    const entry = [...this.charges].reverse().find((candidate) => candidate.assetId === assetId);
    if (entry) this.total -= entry.gpuBytes;
  }
}

function caps(maxTextureSize = 8192) {
  return { backend: 'webgl2' as const, maxTextureSize };
}

interface SceneFixture {
  readonly scene: THREE.Group;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
  readonly textures: readonly THREE.Texture[];
}

function sceneFixture(textureEdge = 4096): SceneFixture {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const textures = Array.from({ length: 4 }, (_, index) => {
    const texture = new THREE.Texture({ width: textureEdge, height: textureEdge } as TexImageSource);
    texture.name = `fixture-${index}`;
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.generateMipmaps = true;
    return texture;
  });
  const material = new THREE.MeshStandardMaterial({
    map: textures[0],
    normalMap: textures[1],
    roughnessMap: textures[2],
    emissiveMap: textures[3],
  });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  return { scene, geometry, material, textures };
}

function backendFor(fixture: SceneFixture) {
  return {
    fetchBytes: vi.fn(async (_url: string): Promise<Uint8Array> => exactStarshipBytes),
    parse: vi.fn(async (_bytes: Uint8Array): Promise<THREE.Object3D> => fixture.scene),
    dispose: vi.fn((): void => undefined),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Artemis IV mission asset contract', () => {
  it('accepts only the exact content-addressed, unaltered, truth-labeled runtime contract', () => {
    expect(CHECKED_ARTEMIS_IV_ASSET_MANIFEST.model).toMatchObject({
      publicUrl: ARTEMIS_IV_STARSHIP_PUBLIC_URL,
      byteLength: ARTEMIS_IV_STARSHIP_BYTE_LENGTH,
      contentPolicy: 'unaltered',
      requiresLazyLoading: true,
      displayLabel: ARTEMIS_IV_STARSHIP_LABEL,
      providerStatusLabel: ARTEMIS_IV_PROVIDER_LABEL,
      isAccurateHlsModel: false,
    });
    expect(CHECKED_ARTEMIS_IV_ASSET_MANIFEST.releaseBudgets).toEqual({
      requiredQualityTier: 'high',
      missionCraftTransferBytes: 25_165_824,
      combinedSceneGpuBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
    });
  });

  it('rejects a corrupt URL, resource ceiling, truth label, or external transform', () => {
    const corruptions: Array<[string, () => unknown]> = [
      ['URL', () => {
        const manifest = structuredClone(rawManifest);
        manifest.models[0].publicUrl = '/missions/artemis-iv/models/unversioned.glb';
        return manifest;
      }],
      ['GPU cap', () => {
        const manifest = structuredClone(rawManifest);
        manifest.releaseBudgets.combinedSceneGpuBytes++;
        return manifest;
      }],
      ['truth label', () => {
        const manifest = structuredClone(rawManifest);
        manifest.models[0].displayLabel = 'Starship HLS';
        return manifest;
      }],
      ['external transform', () => {
        const manifest = structuredClone(rawManifest);
        manifest.models[0].runtimeTransform.scale = [0.02, 0.02, 0.02];
        return manifest;
      }],
    ];
    for (const [name, make] of corruptions) {
      expect(() => checkArtemisIvAssetManifest(make()), name).toThrow(/Invalid Artemis IV asset manifest/);
    }
  });

  it('passes supported hardware, requires High, and preserves the exact prior tier for exit', () => {
    const ledger = new TestLedger(100_000_000);
    const medium = preflightArtemisIvAssets({
      currentTier: 'medium', supportsHighTier: true, caps: caps(), ledger,
    });
    expect(medium).toEqual({
      ok: true,
      requiredTier: 'high',
      switchToTier: 'high',
      switchRequired: true,
      restoreTierOnExit: 'medium',
      combinedSceneGpuCapBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
      currentRendererBytes: 100_000_000,
      estimatedStarshipBytes: ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES,
      estimatedCombinedRendererBytes: 457_913_936,
    });
    const high = preflightArtemisIvAssets({
      currentTier: 'high', supportsHighTier: true, caps: caps(), ledger,
    });
    expect(high).toMatchObject({ ok: true, switchRequired: false, restoreTierOnExit: 'high' });
  });

  it('returns clear First Light, Retry, and Exit choices for every hardware/resource rejection', () => {
    const cases = [
      preflightArtemisIvAssets({
        currentTier: 'low', supportsHighTier: false, caps: caps(), ledger: new TestLedger(0),
      }),
      preflightArtemisIvAssets({
        currentTier: 'medium', supportsHighTier: true, caps: caps(2048), ledger: new TestLedger(0),
      }),
      preflightArtemisIvAssets({
        currentTier: 'medium', supportsHighTier: true, caps: caps(),
        ledger: new TestLedger(ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES - ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES + 1),
      }),
    ];
    expect(cases.map((decision) => decision.ok ? 'pass' : decision.code)).toEqual([
      'high-tier-unavailable',
      'texture-size-unsupported',
      'combined-scene-budget',
    ]);
    for (const decision of cases) {
      expect(decision.ok).toBe(false);
      if (decision.ok) continue;
      expect(decision.reason).toMatch(/unchanged 2019 Starship concept|original 4096 px textures/i);
      expect(decision.actions).toBe(ARTEMIS_IV_PREFLIGHT_ACTIONS);
      expect(decision.actions.map((action) => action.label)).toEqual(['OPEN FIRST LIGHT', 'RETRY', 'EXIT']);
    }
  });
});

describe('Artemis IV lazy asset loading and accounting', () => {
  it('does no I/O before request, checks exact bytes, and charges measured resources', async () => {
    const fixture = sceneFixture();
    const backend = backendFor(fixture);
    const ledger = new TestLedger(100_000_000);
    const loader = createArtemisIvAssetLoader({ backend, ledger });
    expect(backend.fetchBytes).not.toHaveBeenCalled();

    const loaded = await loader.loadStarship();

    expect(backend.fetchBytes).toHaveBeenCalledWith(ARTEMIS_IV_STARSHIP_PUBLIC_URL);
    expect(backend.parse).toHaveBeenCalledOnce();
    expect(backend.parse.mock.calls[0]?.[0]).toBe(exactStarshipBytes);
    expect(createHash('sha256').update(exactStarshipBytes).digest('hex'))
      .toBe(CHECKED_ARTEMIS_IV_ASSET_MANIFEST.model.sha256);
    expect(loaded.accounting).toEqual({
      assetId: 'martiandays-starship-2019-concept',
      transferBytes: ARTEMIS_IV_STARSHIP_BYTE_LENGTH,
      geometryBytes: 42,
      materialBytes: 256,
      textureBytes: ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES,
      gpuBytes: ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES + 298,
      geometryCount: 1,
      materialCount: 1,
      textureCount: 4,
      drawCallCount: 1,
      triangleCount: 1,
    });
    expect(ledger.charges).toEqual([loaded.accounting]);
    expect(loaded.object.children).toEqual([fixture.scene]);
    expect(loaded.object.scale.toArray()).toEqual([0.01, 0.01, 0.01]);
    expect(loaded.object.position.toArray()).toEqual(
      CHECKED_ARTEMIS_IV_ASSET_MANIFEST.model.runtimeTransform.position,
    );
    expect(fixture.scene.scale.toArray()).toEqual([1, 1, 1]);
    expect(fixture.scene.position.toArray()).toEqual([0, 0, 0]);

    const geometryDispose = vi.spyOn(fixture.geometry, 'dispose');
    const materialDispose = vi.spyOn(fixture.material, 'dispose');
    const textureDisposes = fixture.textures.map((texture) => vi.spyOn(texture, 'dispose'));
    loader.dispose();
    loader.dispose();
    expect(ledger.releases).toEqual(['martiandays-starship-2019-concept']);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    for (const dispose of textureDisposes) expect(dispose).toHaveBeenCalledOnce();
    expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it('rejects changed bytes before parse and keeps Retry available', async () => {
    const fixture = sceneFixture();
    const backend = backendFor(fixture);
    const corrupt = exactStarshipBytes.slice();
    corrupt[corrupt.length - 1] ^= 1;
    backend.fetchBytes.mockResolvedValue(corrupt);
    const loader = createArtemisIvAssetLoader({ backend, ledger: new TestLedger(0) });

    await expect(loader.loadStarship()).rejects.toMatchObject({
      name: 'ArtemisIvAssetLoadError',
      code: 'checksum-mismatch',
      actions: ARTEMIS_IV_PREFLIGHT_ACTIONS,
    });
    expect(backend.parse).not.toHaveBeenCalled();
    expect(backend.fetchBytes).toHaveBeenCalledOnce();
    await expect(loader.loadStarship()).rejects.toBeInstanceOf(ArtemisIvAssetLoadError);
    expect(backend.fetchBytes).toHaveBeenCalledTimes(2);
    loader.dispose();
  });

  it('enforces the combined cap from measured textures and disposes a rejected parse', async () => {
    const fixture = sceneFixture(8192);
    const backend = backendFor(fixture);
    const ledger = new TestLedger(0);
    const loader = createArtemisIvAssetLoader({ backend, ledger });
    const geometryDispose = vi.spyOn(fixture.geometry, 'dispose');
    const materialDispose = vi.spyOn(fixture.material, 'dispose');
    const textureDisposes = fixture.textures.map((texture) => vi.spyOn(texture, 'dispose'));

    await expect(loader.loadStarship()).rejects.toMatchObject({
      name: 'ArtemisIvAssetLoadError',
      code: 'combined-scene-budget',
    });
    expect(ledger.charges).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    for (const dispose of textureDisposes) expect(dispose).toHaveBeenCalledOnce();
    loader.dispose();
  });
});

describe('Artemis IV Voyager binding', () => {
  it('exports mission-only scale and representative ESM, docking, and recovery anchors', () => {
    expect(ARTEMIS_IV_VOYAGER_VISUAL_BINDING).toMatchObject({
      assetId: 'orion-voyager-pod',
      sourcePartId: 'pod-voyager',
      displayLabel: 'Orion Crew Module · simplified exterior',
      uniformScale: 4.164,
      stockGameplayDefinitionUnchanged: true,
      gameplayAuthority: 'artemis-iv-mission',
    });
    expect(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.dockingPort.accuracy).toBe('representative');
    expect(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.esmMainEnginePlume.position[1]).toBeLessThan(-5);
    expect(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.esmSolarWingRoots).toHaveLength(4);
    expect(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors.recoveryMainCanopies).toHaveLength(3);
    expect(Object.isFrozen(ARTEMIS_IV_VOYAGER_VISUAL_BINDING.anchors)).toBe(true);
  });
});
