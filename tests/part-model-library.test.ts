import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { checkPartModelManifest, type PartEffectAnchor } from '../src/render/partModelManifest';
import { canonicalJson, sha256Utf8 } from '../src/render/checkedManifestDigest';
import {
  createPartModelLibrary,
  type PartModelBackend,
  type PartModelLibrary,
} from '../src/render/partModelLibrary';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const anchor = (): PartEffectAnchor => ({ position: [0, -0.2, 0], rotation: [0, 0, 0, 1], scale: 1 });

const bytesA = new Uint8Array([1, 2, 3, 4]);
const bytesB = new Uint8Array([5, 6, 7, 8, 9]);

function manifestFor() {
  const models = [
    {
      assetId: 'model-a', partId: 'eng-colt', outputPath: 'generated/model-a.glb',
      sha256: sha(bytesA), triangles: 100, transferBytes: bytesA.length, gpuBytes: 256,
      boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1], plumeAnchors: [anchor()],
    },
    {
      assetId: 'model-b', partId: 'eng-mule', outputPath: 'generated/model-b.glb',
      sha256: sha(bytesB), triangles: 200, transferBytes: bytesB.length, gpuBytes: 512,
      boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1], plumeAnchors: [anchor(), anchor(), anchor()],
    },
  ];
  const manifest = { schemaVersion: 1, models };
  return checkPartModelManifest({ schemaVersion: 1, manifestSha256: sha256Utf8(canonicalJson(manifest)), manifest });
}

interface SceneResources {
  group: THREE.Group;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  texture: THREE.Texture;
}

function makeScene(): SceneResources {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  return { group, geometry, material, texture };
}

interface Harness {
  library: PartModelLibrary;
  scenes: Map<string, SceneResources>;
  backendDisposed: () => boolean;
}

function harness(options: {
  bytes?: Record<string, Uint8Array>;
  failFetch?: Set<string>;
} = {}): Harness {
  const manifest = manifestFor();
  const bytes: Record<string, Uint8Array> = options.bytes ?? {
    'generated/model-a.glb': bytesA,
    'generated/model-b.glb': bytesB,
  };
  const scenes = new Map<string, SceneResources>();
  let disposed = false;
  const backend: PartModelBackend = {
    async fetchBytes(url) {
      if (options.failFetch?.has(url)) throw new Error(`network down for ${url}`);
      const data = bytes[url];
      if (!data) throw new Error(`no bytes for ${url}`);
      return data;
    },
    async parse(input) {
      const key = input === bytesA ? 'model-a' : 'model-b';
      const scene = makeScene();
      scenes.set(key, scene);
      return scene.group;
    },
    dispose() {
      disposed = true;
    },
  };
  return {
    library: createPartModelLibrary({ manifest, backend, resolveAssetUrl: (path) => path }),
    scenes,
    backendDisposed: () => disposed,
  };
}

function firstMesh(object: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  object.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) found = child as THREE.Mesh;
  });
  if (!found) throw new Error('no mesh in instantiated object');
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PartModelLibrary', () => {
  it('instantiates cached models as clones that share their resources', async () => {
    const { library } = harness();
    await library.preload();
    const one = library.instantiate('model-a');
    const two = library.instantiate('model-a');
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    // Distinct Object3D identities...
    expect(one!.object).not.toBe(two!.object);
    // ...but shared geometry and material identities.
    const meshOne = firstMesh(one!.object);
    const meshTwo = firstMesh(two!.object);
    expect(meshOne.geometry).toBe(meshTwo.geometry);
    expect(meshOne.material).toBe(meshTwo.material);
    // Independent transforms.
    one!.object.position.set(5, 0, 0);
    expect(two!.object.position.x).toBe(0);
    expect(one!.plumeAnchors).toHaveLength(1);
    expect(library.instantiateForPart('eng-mule')?.plumeAnchors).toHaveLength(3);
  });

  it('settles individual load failures and returns null only for failed or unknown assets', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { library } = harness({ failFetch: new Set(['generated/model-b.glb']) });
    await expect(library.preload()).resolves.toBeUndefined();
    expect(library.instantiate('model-a')).not.toBeNull();
    expect(library.instantiate('model-b')).toBeNull();
    expect(library.instantiate('unknown-asset')).toBeNull();
  });

  it('rejects a checksum mismatch and leaves that asset unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { library } = harness({
      bytes: { 'generated/model-a.glb': new Uint8Array([9, 9, 9]), 'generated/model-b.glb': bytesB },
    });
    await library.preload();
    expect(library.instantiate('model-a')).toBeNull();
    expect(library.instantiate('model-b')).not.toBeNull();
  });

  it('releases each cached geometry, material, and texture exactly once on dispose', async () => {
    const { library, scenes, backendDisposed } = harness();
    await library.preload();
    // Hand out clones first; they must borrow, not own, the cached resources.
    library.instantiate('model-a');
    library.instantiate('model-b');
    const spies = [...scenes.values()].flatMap((scene) => [
      vi.spyOn(scene.geometry, 'dispose'),
      vi.spyOn(scene.material, 'dispose'),
      vi.spyOn(scene.texture, 'dispose'),
    ]);
    library.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(backendDisposed()).toBe(true);
    expect(library.instantiate('model-a')).toBeNull();
  });

  it('requires the opaque checked-manifest boundary', () => {
    const fake = { models: [], model: () => null, modelForPart: () => null } as never;
    expect(() =>
      createPartModelLibrary({
        manifest: fake,
        backend: { fetchBytes: async () => new Uint8Array(), parse: async () => new THREE.Group(), dispose() {} },
        resolveAssetUrl: (path) => path,
      }),
    ).toThrow(/opaque checked/);
  });
});
