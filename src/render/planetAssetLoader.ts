import * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';

export interface PlanetAssetChannel {
  readonly name: string;
  readonly packagePath: string;
  readonly fallbackPath: string;
  readonly gpuBytes: number;
}

export interface PlanetAssetPack {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly transientBytes: number;
  readonly channels: readonly PlanetAssetChannel[];
}

export interface CheckedPlanetManifest {
  readonly approvedByValidator: boolean;
  readonly packs: readonly PlanetAssetPack[];
}

interface Ktx2Boundary {
  setTranscoderPath(path: string): this;
  detectSupport(renderer: THREE.WebGLRenderer): this;
  loadAsync(path: string): Promise<THREE.Texture>;
}

export interface PlanetAssetLoaderOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly manifest: CheckedPlanetManifest;
  readonly ktx2: Ktx2Boundary;
  /** Derived from RenderCaps; detectSupport alone may configure RGBA fallback. */
  readonly compressedSupported: boolean;
  readonly loadConventional: (path: string) => Promise<THREE.Texture>;
}

export interface LoadedPlanetPack {
  readonly pack: PlanetAssetPack;
  readonly gpuBytes: number;
  readonly textures: ReadonlyMap<string, THREE.Texture>;
  dispose(): void;
}

function requireLocal(path: string): void {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('..') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error(`Asset path is not a validator-approved local manifest entry: ${path}`);
  }
}

export class PlanetAssetLoader {
  private readonly options: PlanetAssetLoaderOptions;

  constructor(options: PlanetAssetLoaderOptions) {
    if (options.manifest.approvedByValidator !== true) {
      throw new Error('Planet manifest must be validator-approved');
    }
    this.options = options;
    this.options.ktx2.setTranscoderPath('./basis/');
  }

  async load(bodyId: string, tier: QualityTier): Promise<LoadedPlanetPack> {
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
        requireLocal(channel.packagePath);
        requireLocal(channel.fallbackPath);
        const texture = compressed
          ? await this.options.ktx2.loadAsync(channel.packagePath)
          : await this.options.loadConventional(channel.fallbackPath);
        textures.set(channel.name, texture);
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
}
