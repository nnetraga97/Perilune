import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  isCheckedPartModelManifest,
  type CheckedPartModel,
  type CheckedPartModelManifest,
  type PartEffectAnchor,
} from './partModelManifest';

export interface InstantiatedPartModel {
  /** A fresh clone that borrows the cached geometry/material/texture resources. */
  readonly object: THREE.Object3D;
  readonly plumeAnchors: readonly PartEffectAnchor[];
}

export interface PartModelLibrary {
  preload(): Promise<void>;
  instantiate(assetId: string): InstantiatedPartModel | null;
  instantiateForPart(partId: string): InstantiatedPartModel | null;
  dispose(): void;
}

/** Fetch + parse boundary so the runtime and tests share one lifecycle. */
export interface PartModelBackend {
  fetchBytes(url: string): Promise<Uint8Array>;
  parse(bytes: Uint8Array): Promise<THREE.Object3D>;
  dispose(): void;
}

export interface PartModelLibraryOptions {
  readonly manifest: CheckedPartModelManifest;
  readonly backend: PartModelBackend;
  readonly resolveAssetUrl: (outputPath: string, sha256: string) => string;
}

interface CachedModel {
  readonly scene: THREE.Object3D;
  readonly plumeAnchors: readonly PartEffectAnchor[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Owns the parsed model scenes and their shared render resources. Instances handed
 * out by `instantiate()` are clones that borrow — never copy — those resources, so
 * a single `dispose()` releases every geometry, material, and texture exactly once.
 */
class SharedPartModelLibrary implements PartModelLibrary {
  private readonly cache = new Map<string, CachedModel>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private disposed = false;

  constructor(private readonly options: PartModelLibraryOptions) {
    if (!isCheckedPartModelManifest(options.manifest as object)) {
      throw new Error('PartModelLibrary requires the opaque checked part manifest boundary');
    }
  }

  async preload(): Promise<void> {
    if (this.disposed) throw new Error('PartModelLibrary is disposed');
    const results = await Promise.allSettled(
      this.options.manifest.models.map((model) => this.load(model)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const model = this.options.manifest.models[index];
        console.error(`Part model ${model.assetId} failed to preload:`, result.reason);
      }
    });
  }

  private async load(model: CheckedPartModel): Promise<void> {
    const url = this.options.resolveAssetUrl(model.outputPath, model.sha256);
    const bytes = await this.options.backend.fetchBytes(url);
    const actual = await sha256Hex(bytes);
    if (actual !== model.sha256) {
      throw new Error(`Part model ${model.assetId} checksum mismatch: expected ${model.sha256}, got ${actual}`);
    }
    const scene = await this.options.backend.parse(bytes);
    // A disposal may have raced the parse; drop the freshly parsed scene rather than leak it.
    if (this.disposed) {
      this.releaseSceneResources(scene);
      return;
    }
    this.collectResources(scene);
    this.cache.set(model.assetId, { scene, plumeAnchors: model.plumeAnchors });
  }

  private collectResources(scene: THREE.Object3D): void {
    scene.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh>;
      if (mesh.geometry instanceof THREE.BufferGeometry) this.geometries.add(mesh.geometry);
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => this.collectMaterial(entry));
      } else if (material) {
        this.collectMaterial(material);
      }
    });
  }

  private collectMaterial(material: THREE.Material): void {
    this.materials.add(material);
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) this.textures.add(value);
    }
  }

  /** Dispose resources unique to one scene when it is discarded before being cached. */
  private releaseSceneResources(scene: THREE.Object3D): void {
    scene.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh>;
      if (mesh.geometry instanceof THREE.BufferGeometry) mesh.geometry.dispose();
      const material = mesh.material;
      const entries = Array.isArray(material) ? material : material ? [material] : [];
      for (const entry of entries) {
        for (const value of Object.values(entry)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        entry.dispose();
      }
    });
  }

  instantiate(assetId: string): InstantiatedPartModel | null {
    if (this.disposed) return null;
    const cached = this.cache.get(assetId);
    if (!cached) return null;
    return { object: cached.scene.clone(true), plumeAnchors: cached.plumeAnchors };
  }

  instantiateForPart(partId: string): InstantiatedPartModel | null {
    if (this.disposed) return null;
    const model = this.options.manifest.modelForPart(partId);
    return model ? this.instantiate(model.assetId) : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.cache.clear();
    this.options.backend.dispose();
  }
}

export interface BrowserPartModelLibraryOptions {
  readonly transcoderPath: string;
  readonly resolveAssetUrl: (outputPath: string, sha256: string) => string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer;
}

/** Wire GLTFLoader with the KTX2 transcoder and Meshopt decoder for the runtime. */
export function createBrowserPartModelLibrary(
  renderer: THREE.WebGLRenderer,
  manifest: CheckedPartModelManifest,
  options: BrowserPartModelLibraryOptions,
): PartModelLibrary {
  if (!options.transcoderPath.endsWith('/')) {
    throw new Error('KTX2 transcoder path must end with /');
  }
  const ktx2 = new KTX2Loader().setTranscoderPath(options.transcoderPath).detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const backend: PartModelBackend = {
    async fetchBytes(url: string): Promise<Uint8Array> {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Part model request failed (${response.status}) for ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async parse(bytes: Uint8Array): Promise<THREE.Object3D> {
      const gltf = await loader.parseAsync(toArrayBuffer(bytes), '');
      return gltf.scene;
    },
    dispose(): void {
      ktx2.dispose();
    },
  };
  return new SharedPartModelLibrary({ manifest, backend, resolveAssetUrl: options.resolveAssetUrl });
}

/** Test/headless entrypoint that accepts an explicit backend. */
export function createPartModelLibrary(options: PartModelLibraryOptions): PartModelLibrary {
  return new SharedPartModelLibrary(options);
}
