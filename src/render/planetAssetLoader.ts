import * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';
import { RenderBoundaryError } from './renderFailures';
import { canonicalJson, sha256Utf8 } from './checkedManifestDigest';
import { normalizeDiagnosticError, type RenderDiagnosticsPort } from './renderDiagnostics';
import { configureSurfaceClassTexture } from './terrestrial/surfaceClass';

export interface PlanetAssetChannel {
  readonly name: string;
  readonly packagePath: string;
  readonly fallbackPath: string;
  readonly gpuBytes: number;
  /** Conservative browser upload size for conventional PNG/WebP fallback. */
  readonly fallbackGpuBytes: number;
}

export interface PlanetAssetPack {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly width: number;
  readonly height: number;
  readonly transientBytes: number;
  readonly channels: readonly PlanetAssetChannel[];
}

function fullMipRgbaBytes(width: number, height: number): number {
  let total = 0;
  for (;;) {
    total += width * height * 4;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

export interface CheckedManifestArtifact {
  readonly schemaVersion: number;
  readonly manifestSha256: string;
  readonly manifest: unknown;
}

const checkedManifestBrand: unique symbol = Symbol('checkedPlanetManifest');
export interface CheckedPlanetManifest {
  readonly [checkedManifestBrand]: true;
  readonly digest: string;
  readonly packs: readonly PlanetAssetPack[];
  readonly budgets: {
    readonly activeBodyGpuBytes: Readonly<Record<QualityTier, number>>;
    readonly transientPeakBytes: Readonly<Record<QualityTier, number>>;
  };
  hasPack(bodyId: string, tier: QualityTier): boolean;
}

const checkedManifests = new WeakSet<object>();

function requireLocal(path: string): void {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.split(/[\\/]/).includes('..') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error(`Asset path is not a validator-approved local manifest entry: ${path}`);
  }
}

export function checkPlanetManifest(artifact: CheckedManifestArtifact): CheckedPlanetManifest {
  if (artifact?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(artifact.manifestSha256 ?? '')) {
    throw new Error('Invalid checked planet manifest artifact');
  }
  const actualDigest = sha256Utf8(canonicalJson(artifact.manifest));
  if (actualDigest !== artifact.manifestSha256) {
    throw new Error(`Checked planet manifest digest mismatch: expected ${artifact.manifestSha256}, got ${actualDigest}`);
  }
  const source = artifact.manifest as {
    readonly schemaVersion?: number;
    readonly packs?: readonly unknown[];
    readonly budgets?: {
      readonly activeBodyGpuBytes?: Readonly<Record<QualityTier, number>>;
      readonly transientPeakBytes?: Readonly<Record<QualityTier, number>>;
    };
  };
  if (!source || source.schemaVersion !== 1 || !Array.isArray(source.packs)) {
    throw new Error('Checked planet manifest does not match schema version 1');
  }
  const tiers: readonly QualityTier[] = ['low', 'medium', 'high'];
  for (const tier of tiers) {
    if (
      !Number.isInteger(source.budgets?.activeBodyGpuBytes?.[tier]) || source.budgets!.activeBodyGpuBytes![tier] < 0 ||
      !Number.isInteger(source.budgets?.transientPeakBytes?.[tier]) || source.budgets!.transientPeakBytes![tier] < 0
    ) {
      throw new Error(`Checked planet manifest has invalid ${tier} renderer budgets`);
    }
  }
  const packs = source.packs.map((raw) => {
    const pack = raw as Partial<PlanetAssetPack>;
    if (typeof pack.bodyId !== 'string' || !['low', 'medium', 'high'].includes(pack.tier ?? '')) {
      throw new Error('Checked planet manifest contains an invalid pack');
    }
    if (!Number.isInteger(pack.width) || (pack.width ?? 0) <= 0 || !Number.isInteger(pack.height) || (pack.height ?? 0) <= 0) {
      throw new Error(`Checked planet manifest contains invalid dimensions for ${pack.bodyId}/${pack.tier}`);
    }
    if (!Number.isInteger(pack.transientBytes) || (pack.transientBytes ?? -1) < 0 || !Array.isArray(pack.channels)) {
      throw new Error(`Checked planet manifest contains an invalid pack for ${pack.bodyId}/${pack.tier}`);
    }
    const channels = pack.channels.map((channel) => {
      if (
        typeof channel.name !== 'string' || !Number.isInteger(channel.gpuBytes) || channel.gpuBytes < 0 ||
        (channel.fallbackGpuBytes !== undefined &&
          (!Number.isInteger(channel.fallbackGpuBytes) || channel.fallbackGpuBytes < 0))
      ) {
        throw new Error(`Checked planet manifest contains an invalid channel for ${pack.bodyId}/${pack.tier}`);
      }
      requireLocal(channel.packagePath);
      requireLocal(channel.fallbackPath);
      return Object.freeze({
        name: channel.name,
        packagePath: channel.packagePath,
        fallbackPath: channel.fallbackPath,
        gpuBytes: channel.gpuBytes,
        fallbackGpuBytes: channel.fallbackGpuBytes ?? fullMipRgbaBytes(pack.width!, pack.height!),
      });
    });
    return Object.freeze({
      bodyId: pack.bodyId,
      tier: pack.tier as QualityTier,
      width: pack.width,
      height: pack.height,
      transientBytes: pack.transientBytes,
      channels: Object.freeze(channels),
    });
  });
  const checked: CheckedPlanetManifest = Object.freeze({
    [checkedManifestBrand]: true,
    digest: artifact.manifestSha256,
    packs: Object.freeze(packs),
    budgets: Object.freeze({
      activeBodyGpuBytes: Object.freeze({ ...source.budgets!.activeBodyGpuBytes! }),
      transientPeakBytes: Object.freeze({ ...source.budgets!.transientPeakBytes! }),
    }),
    hasPack: (bodyId: string, tier: QualityTier) => packs.some((pack) => pack.bodyId === bodyId && pack.tier === tier),
  }) as unknown as CheckedPlanetManifest;
  checkedManifests.add(checked);
  return checked;
}

interface Ktx2Boundary {
  setTranscoderPath(path: string): this;
  detectSupport(renderer: THREE.WebGLRenderer): this;
  loadAsync(path: string): Promise<THREE.Texture>;
  dispose(): void;
}

export interface PlanetAssetLoaderOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly manifest: CheckedPlanetManifest;
  readonly ktx2: Ktx2Boundary;
  /** Derived from RenderCaps; detectSupport alone may configure RGBA fallback. */
  readonly compressedSupported: boolean;
  readonly transcoderPath: string;
  readonly resolveAssetUrl: (manifestPath: string) => string;
  readonly loadConventional: (path: string) => Promise<THREE.Texture>;
  /** Exact R8 fallback decoder for categorical PNGs. */
  readonly loadSurfaceClassConventional?: (path: string) => Promise<THREE.Texture>;
  readonly diagnostics?: RenderDiagnosticsPort;
  /** Defaults to true for standalone loaders; false when the application shares the decoder. */
  readonly ownsKtx2?: boolean;
}

export interface LoadedPlanetPack {
  readonly pack: PlanetAssetPack;
  readonly gpuBytes: number;
  readonly textures: ReadonlyMap<string, THREE.Texture>;
  dispose(): void;
}

export class PlanetAssetLoader {
  private readonly options: PlanetAssetLoaderOptions;
  private disposed = false;

  constructor(options: PlanetAssetLoaderOptions) {
    if (!checkedManifests.has(options.manifest as object)) {
      throw new Error('PlanetAssetLoader requires the opaque checked manifest boundary');
    }
    this.options = options;
    if (!options.transcoderPath.endsWith('/')) throw new Error('KTX2 transcoder path must end with /');
    this.options.ktx2.setTranscoderPath(options.transcoderPath);
  }

  async load(bodyId: string, tier: QualityTier): Promise<LoadedPlanetPack> {
    if (this.disposed) throw new Error('PlanetAssetLoader is disposed');
    const pack = this.options.manifest.packs.find((entry) => entry.bodyId === bodyId && entry.tier === tier);
    if (!pack) throw new Error(`No validator-approved planet pack for ${bodyId}/${tier}`);
    this.options.diagnostics?.record({
      subsystem: 'assets', event: 'asset-pack-load-start', severity: 'state',
      data: { body: bodyId, tier, manifestDigest: this.options.manifest.digest, width: pack.width, height: pack.height },
    }, { bodyId });
    let compressed = this.options.compressedSupported;
    try {
      this.options.ktx2.detectSupport(this.options.renderer);
    } catch {
      compressed = false;
      this.options.diagnostics?.record({
        subsystem: 'assets', event: 'compressed-capability-fallback', severity: 'state',
        data: { body: bodyId, tier, reason: 'detect-support-failed' },
      }, { bodyId });
    }
    const textures = new Map<string, THREE.Texture>();
    let selectedGpuBytes = 0;
    try {
      const outcomes = await Promise.allSettled(pack.channels.map(async (channel) => {
        try {
          const selectedPath = compressed ? channel.packagePath : channel.fallbackPath;
          this.options.diagnostics?.record({
            subsystem: 'assets', event: 'asset-channel-selected', severity: 'state',
            data: {
              body: bodyId, tier, channel: channel.name, selectedPath,
              selectedType: compressed ? 'ktx2' : 'conventional',
              fallback: !compressed, width: pack.width, height: pack.height,
              selectedGpuBytes: compressed ? channel.gpuBytes : channel.fallbackGpuBytes,
            },
          }, { bodyId });
          const classChannel = channel.name === 'surfaceClass' || channel.name === 'surfaceClassRegional';
          const texture = compressed
            ? await this.options.ktx2.loadAsync(this.options.resolveAssetUrl(channel.packagePath))
            : classChannel && this.options.loadSurfaceClassConventional
              ? await this.options.loadSurfaceClassConventional(this.options.resolveAssetUrl(channel.fallbackPath))
              : await this.options.loadConventional(this.options.resolveAssetUrl(channel.fallbackPath));
          // Every generated pack declares a top-left texture origin and the
          // body-fixed sampler maps north to v=0. TextureLoader defaults to a
          // bottom-left WebGL convention, so conventional fallbacks must opt
          // out of its vertical upload flip. KTX2 carries this orientation in
          // container metadata and is normalized by KTX2Loader.
          if (!compressed) texture.flipY = false;
          texture.colorSpace = channel.name === 'albedo' || channel.name === 'emissive'
            ? THREE.SRGBColorSpace
            : THREE.NoColorSpace;
          if (channel.name === 'surfaceClass' || channel.name === 'surfaceClassRegional') {
            configureSurfaceClassTexture(texture);
          }
          const gpuBytes = compressed ? channel.gpuBytes : channel.fallbackGpuBytes;
          this.options.diagnostics?.record({
            subsystem: 'assets', event: 'asset-channel-loaded', severity: 'state',
            data: {
              body: bodyId, tier, channel: channel.name, selectedPath,
              selectedType: compressed ? 'ktx2' : 'conventional',
              textureIdentity: texture.uuid, colorSpace: texture.colorSpace,
              width: pack.width, height: pack.height,
              selectedGpuBytes: compressed ? channel.gpuBytes : channel.fallbackGpuBytes,
            },
          }, { bodyId });
          return { name: channel.name, texture, gpuBytes };
        } catch (error) {
          const normalized = normalizeDiagnosticError(error);
          this.options.diagnostics?.record({
            subsystem: 'assets', event: 'asset-channel-failed', severity: 'failure',
            data: { body: bodyId, tier, channel: channel.name, errorName: normalized.name, errorMessage: normalized.message },
          }, { bodyId });
          throw new RenderBoundaryError(
            { body: bodyId, tier, channel: channel.name, phase: 'load' },
            `${bodyId}/${tier}/${channel.name} asset load failed`,
            { cause: error },
          );
        }
      }));
      for (const outcome of outcomes) {
        if (outcome.status !== 'fulfilled') continue;
        textures.set(outcome.value.name, outcome.value.texture);
        selectedGpuBytes += outcome.value.gpuBytes;
      }
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) {
      for (const texture of textures.values()) texture.dispose();
      throw error;
    }
    this.options.diagnostics?.record({
      subsystem: 'assets', event: 'asset-pack-loaded', severity: 'state',
      data: { body: bodyId, tier, manifestDigest: this.options.manifest.digest, gpuBytes: selectedGpuBytes },
    }, { bodyId });
    let packDisposed = false;
    return {
      pack,
      gpuBytes: selectedGpuBytes,
      textures,
      dispose: () => {
        if (packDisposed) return;
        packDisposed = true;
        this.options.diagnostics?.record({
          subsystem: 'assets', event: 'asset-pack-disposed', severity: 'state',
          data: { body: bodyId, tier, manifestDigest: this.options.manifest.digest, gpuBytes: selectedGpuBytes },
        }, { bodyId });
        for (const texture of textures.values()) texture.dispose();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.options.ownsKtx2 ?? true) this.options.ktx2.dispose();
  }
}
