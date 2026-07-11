import * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';
import { RenderBoundaryError } from './renderFailures';
import { canonicalJson, sha256Utf8 } from './checkedManifestDigest';

export interface PlanetAssetChannel {
  readonly name: string;
  readonly packagePath: string;
  readonly fallbackPath: string;
  readonly gpuBytes: number;
}

export interface PlanetAssetPack {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly width: number;
  readonly height: number;
  readonly transientBytes: number;
  readonly channels: readonly PlanetAssetChannel[];
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
      if (typeof channel.name !== 'string' || !Number.isInteger(channel.gpuBytes) || channel.gpuBytes < 0) {
        throw new Error(`Checked planet manifest contains an invalid channel for ${pack.bodyId}/${pack.tier}`);
      }
      requireLocal(channel.packagePath);
      requireLocal(channel.fallbackPath);
      return Object.freeze({
        name: channel.name,
        packagePath: channel.packagePath,
        fallbackPath: channel.fallbackPath,
        gpuBytes: channel.gpuBytes,
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
    let compressed = this.options.compressedSupported;
    try {
      this.options.ktx2.detectSupport(this.options.renderer);
    } catch {
      compressed = false;
    }
    const textures = new Map<string, THREE.Texture>();
    try {
      for (const channel of pack.channels) {
        try {
          const texture = compressed
            ? await this.options.ktx2.loadAsync(this.options.resolveAssetUrl(channel.packagePath))
            : await this.options.loadConventional(this.options.resolveAssetUrl(channel.fallbackPath));
          textures.set(channel.name, texture);
        } catch (error) {
          throw new RenderBoundaryError(
            { body: bodyId, tier, channel: channel.name, phase: 'load' },
            `${bodyId}/${tier}/${channel.name} asset load failed`,
            { cause: error },
          );
        }
      }
    } catch (error) {
      for (const texture of textures.values()) texture.dispose();
      throw error;
    }
    return {
      pack,
      gpuBytes: pack.channels.reduce((total, channel) => total + channel.gpuBytes, 0),
      textures,
      dispose: () => { for (const texture of textures.values()) texture.dispose(); },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.ktx2.dispose();
  }
}
