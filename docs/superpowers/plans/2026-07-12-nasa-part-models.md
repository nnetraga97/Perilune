# NASA-Style Part Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight NASA-style part models through a checked offline pipeline while preserving synchronous vessel construction, procedural fallbacks, save compatibility, and simulation authority.

**Architecture:** Explicit authoring commands fetch checksum-pinned sources and compile reviewed intermediate GLBs into checked Meshopt/KTX2 runtime assets. A preloaded `PartModelLibrary` clones shared render resources into the existing vessel holder hierarchy; `PartShape` remains the sole authority for physics and attachments.

**Tech Stack:** TypeScript 5.7, Three.js 0.170, Vite 6, Vitest 4, Playwright 1.49, Node 22, glTF Transform CLI 4.3.0, Meshopt, KTX-Software 4.4.2, Blender 4.2+ for reviewed authoring intermediates.

## Global Constraints

- Active scope is exactly eight parts: `pod-voyager`, `leg-lander`, `eng-colt`, `ant-dish`, `wheel-mesa`, `eng-mule`, `tank-s4`, and `chute-main`.
- NASA/JPL logos, flags, mission patches, vehicle names, and identifying text must not appear in runtime assets.
- Branding and usage review is manual before production; missing review metadata must not fail development validation.
- `PartShape`, attachment nodes, collision, mass, resources, thrust, and staging remain unchanged.
- The Homecoming Chute remains stowed; no canopy or deployment animation is added.
- Completed craft templates are out of scope.
- Procedural geometry remains the guaranteed runtime fallback.
- One copy of all eight assets must stay at or below 30,000 triangles, 6 MiB compressed transfer, and 32 MiB shared GPU allocation.
- The reference craft with six wheels and four legs must stay at or below 60,000 part triangles.
- Maximum texture dimensions are 1024x1024 for the pod and tank and 512x512 for the other six models.
- Preserve the user's unrelated working-tree changes in `src/render/terrain/chunkGeometry.ts`, `src/sim/vessel.ts`, `src/core/cubeSphere.ts`, and `src/sim/physicalObstacles.ts`.

---

## File Structure

### Authoring and build data

- `assets/parts/sources.json` — pinned upstream source records only.
- `assets/parts/recipes.json` — normalized-input paths, output limits, bounds, attachment anchors, and plume anchors.
- `assets/parts/authoring/*.glb` — reviewed canonical intermediates committed for deterministic compilation.
- `assets/parts/generated/*.glb` — compiled runtime assets committed and copied to `public/parts/`.
- `src/generated/checked-part-manifest.json` — opaque runtime boundary generated from validated output.
- `tools/part-assets/compiler-lock.json` — exact compiler and encoder versions.

### Focused tooling

- `scripts/lib/part-asset-schema.mjs` — parse and validate source, recipe, and checked-manifest records.
- `scripts/lib/part-source-fetch.mjs` — atomic checksum-pinned downloads.
- `scripts/fetch-part-sources.mjs` — explicit authoring entrypoint.
- `scripts/lib/glb-stats.mjs` — GLB bounds, triangle, buffer, texture, and extension inspection.
- `scripts/compile-part-assets.mjs` — invoke pinned glTF Transform, enforce recipes, and write checked output.
- `scripts/compile-part-assets-container.mjs` — authoritative Linux/amd64 write path using the existing KTX container.
- `scripts/sync-renderer-assets.mjs` — copy only checked part GLBs to `public/parts/`.

### Runtime

- `src/render/partModelManifest.ts` — validate and brand the generated manifest.
- `src/render/partModelLibrary.ts` — preload, checksum, parse, cache, instantiate, and dispose model resources.
- `src/render/vesselMesh.ts` — choose imported/fallback bodies and support multi-anchor plume groups.
- `src/content/parts.ts` — assign optional `modelAssetId` values to the eight parts.
- `src/game.ts`, `src/render/worldScene.ts`, `src/ui/editor.ts` — construct and inject one shared model library.

### Tests and documentation

- `tests/part-asset-schema.test.ts`
- `tests/part-source-fetch.test.ts`
- `tests/part-asset-compiler.test.ts`
- `tests/part-model-manifest.test.ts`
- `tests/part-model-library.test.ts`
- `tests/vessel-mesh.test.ts`
- `e2e/part-models.spec.ts`
- `CONTENT_PIPELINE.md`, `ATTRIBUTIONS.md`, `QA.md`

---

### Task 1: Define the part-asset contracts and technical validator

**Files:**
- Create: `assets/parts/sources.json`
- Create: `assets/parts/recipes.json`
- Create: `src/generated/checked-part-manifest.json` as the empty bootstrap artifact
- Create: `tools/part-assets/compiler-lock.json`
- Create: `scripts/lib/part-asset-schema.mjs`
- Create: `tests/part-asset-schema.test.ts`
- Modify: `scripts/validate-content.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `loadPartAssetInputs(root): { sources, recipes }`
- Produces: `validatePartAssetInputs(root): string[]`
- Produces: `validateCheckedPartManifest(root): string[]`
- Consumes later: recipe records keyed by `assetId` and source records keyed by `sourceId`.

- [ ] **Step 1: Add the failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { validatePartAssetDocuments } from '../scripts/lib/part-asset-schema.mjs';

describe('part asset schema', () => {
  it('accepts an empty technical manifest while the pipeline is bootstrapped', () => {
    expect(validatePartAssetDocuments(
      { schemaVersion: 1, sources: [] },
      { schemaVersion: 1, budgets: { transferBytes: 6291456, gpuBytes: 33554432, combinedTriangles: 30000 }, models: [] },
    )).toEqual([]);
  });

  it('rejects duplicate IDs, unsafe paths, invalid checksums, and excessive totals', () => {
    const errors = validatePartAssetDocuments(
      { schemaVersion: 1, sources: [
        { sourceId: 'same', url: 'https://example.test/a', checksumSha256: 'x', localPath: '../a.glb' },
        { sourceId: 'same', url: 'https://example.test/b', checksumSha256: 'x', localPath: 'sources/b.glb' },
      ] },
      { schemaVersion: 1, budgets: { transferBytes: 1, gpuBytes: 1, combinedTriangles: 1 }, models: [] },
    );
    expect(errors.join('\n')).toMatch(/Duplicate sourceId|safe relative path|SHA-256/);
  });

  it('does not require branding-review metadata', () => {
    const errors = validatePartAssetDocuments(
      { schemaVersion: 1, sources: [{
        sourceId: 'nasa-test', url: 'https://science.nasa.gov/3d-resources/',
        checksumSha256: 'a'.repeat(64), localPath: 'sources/test.glb',
        author: 'NASA', usageUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      }] },
      { schemaVersion: 1, budgets: { transferBytes: 6291456, gpuBytes: 33554432, combinedTriangles: 30000 }, models: [] },
    );
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npm test -- tests/part-asset-schema.test.ts`

Expected: FAIL because `scripts/lib/part-asset-schema.mjs` does not exist.

- [ ] **Step 3: Add exact pinned dependencies and scripts**

Add these exact dev dependencies:

```json
"@gltf-transform/cli": "4.3.0",
"@gltf-transform/core": "4.3.0",
"@gltf-transform/extensions": "4.3.0",
"draco3dgltf": "1.5.7",
"meshoptimizer": "1.0.1"
```

Add scripts:

```json
"fetch:part-sources": "node scripts/fetch-part-sources.mjs",
"compile:part-assets": "node scripts/compile-part-assets.mjs",
"compile:part-assets:container": "node scripts/compile-part-assets-container.mjs"
```

Run: `npm install`

Expected: `package-lock.json` records the exact direct versions above.

- [ ] **Step 4: Add source records and an initially empty recipe set**

Use these exact source records in `assets/parts/sources.json`:

| sourceId | upstream path | SHA-256 |
| --- | --- | --- |
| `nasa-orion-capsule` | `3D Printing/Orion Capsule/Orion Capsule (no fbc).stl` | `abc4c69c27afa55c4a06bc9972b8872979f1473fb26e15224fb0f77f1cd81dc7` |
| `nasa-viking-leg` | `3D Printing/Viking Lander/Leg x 3.stl` | `16a25c37736604edbbb1b090bdfb01b536478647cc6f88b9acee858586dfe470` |
| `nasa-viking-foot` | `3D Printing/Viking Lander/3D Foot x 3.stl` | `e221d4c5aedd7933a0cecfac0489cd0e8f25d43e7e40c007c5212023018198ef` |
| `nasa-apollo-lm` | `3D Models/Apollo Lunar Module/Apollo Lunar Module.glb` | `379101dfcee399267addf771709107c35e826b0b9e5233272f123e4c8a585c4e` |
| `nasa-tdrs-left-antenna` | `3D Models/Tracking and Data Relay Satellites (TDRS) (C)/Tracking and Data Relay Satellites (TDRS) (C) (left antenna).glb` | `bf2a8cc618dce8c549ec726d8a530f67e17f116b6311dcea6ae06b7b47c12985` |
| `nasa-mars-2020-wheel` | `3D Printing/Mars 2020 5 inch wheel/Mars 2020 5 inch wheel.stl` | `6318740c1ce44b5d4deb85866dd2a2cef9195197019553c78f0c439ab737c4ad` |
| `nasa-shuttle-engines` | `3D Models/Space Shuttle (D)/Space Shuttle (D) eng.glb` | `e31cfb57e3365f036d40cee79ac9e2f8b5f4c48849f6aa9e19aee4075846a0bc` |
| `nasa-shuttle-external-tank` | `3D Models/Space Shuttle Parts/External tank.glb` | `ee2d727e23d796dd94a29dcbce03d645faea485b006edbb7319abdbf445d5ee7` |

Every URL must use commit `11ebb4ee043715aefbba6aeec8a61746fad67fa7` under `raw.githubusercontent.com/nasa/NASA-3D-Resources`. Set `localPath` to `sources/<sourceId>.<stl|glb>`, `author` to the organization shown on the NASA asset page, and `usageUrl` to the NASA media-guidelines page.

Initialize `assets/parts/recipes.json` with schema version 1, the three approved global budgets, and an empty `models` array. Add `assets/parts/sources/**` and `public/parts/` to `.gitignore`; keep `assets/parts/authoring/` and `assets/parts/generated/` tracked.

- [ ] **Step 5: Implement technical-only schema validation**

`validatePartAssetDocuments()` must enforce schema versions, unique IDs, HTTPS source URLs, 64-character lowercase SHA-256 values, safe relative paths, numeric bounds, positive limits, unique `partId` assignments, and the approved total budget ceilings. It must not require a license classification or branding-review object.

At the end of `scripts/validate-content.mjs`, append errors from both part validation functions before the existing final error/report branch. `validateCheckedPartManifest()` may accept a missing checked artifact only while `recipes.models` is empty; after the first recipe is added, absence is an error. Write the empty bootstrap artifact as canonical JSON with an empty `manifest.models` array and a matching `manifestSha256`, using the same canonical serializer that Task 3 will reuse.

- [ ] **Step 6: Run focused and existing validator tests**

Run: `npm test -- tests/part-asset-schema.test.ts tests/content-validator.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json package-lock.json assets/parts src/generated/checked-part-manifest.json scripts/lib/part-asset-schema.mjs scripts/validate-content.mjs tests/part-asset-schema.test.ts tools/part-assets/compiler-lock.json
git commit -m "build: define part asset contracts"
```

---

### Task 2: Add atomic source fetching

**Files:**
- Create: `scripts/lib/part-source-fetch.mjs`
- Create: `scripts/fetch-part-sources.mjs`
- Create: `tests/part-source-fetch.test.ts`

**Interfaces:**
- Consumes: source records from `assets/parts/sources.json`.
- Produces: `fetchPinnedSource(source, destination, fetchImpl): Promise<'downloaded' | 'verified'>`.

- [ ] **Step 1: Write failing atomic-download tests**

```ts
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchPinnedSource } from '../scripts/lib/part-source-fetch.mjs';

describe('part source fetch', () => {
  it('writes verified bytes atomically and reuses a valid destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perilune-parts-'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = { sourceId: 'asset', url: 'https://example.test/asset.glb', checksumSha256: createHash('sha256').update(bytes).digest('hex') };
    const destination = join(dir, 'asset.glb');
    const fetchImpl = async () => new Response(bytes, { status: 200 });
    await expect(fetchPinnedSource(source, destination, fetchImpl)).resolves.toBe('downloaded');
    await expect(readFile(destination)).resolves.toEqual(Buffer.from(bytes));
    await expect(fetchPinnedSource(source, destination, async () => { throw new Error('must not fetch'); })).resolves.toBe('verified');
  });

  it('removes partial bytes after a checksum mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perilune-parts-'));
    const destination = join(dir, 'asset.glb');
    const source = { sourceId: 'asset', url: 'https://example.test/asset.glb', checksumSha256: 'a'.repeat(64) };
    await expect(fetchPinnedSource(source, destination, async () => new Response(new Uint8Array([9])))).rejects.toThrow(/checksum mismatch/i);
    await expect(readFile(`${destination}.partial`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Verify the tests fail, then implement the helper**

Run: `npm test -- tests/part-source-fetch.test.ts`

Expected before implementation: FAIL due to missing module.

Implement streaming download to `<destination>.partial`, SHA-256 verification, atomic rename, cleanup on error, and reuse only when the existing destination checksum matches.

- [ ] **Step 3: Implement the entrypoint**

`scripts/fetch-part-sources.mjs` must load the source manifest, create `assets/parts/sources/`, fetch all records sequentially for readable errors, and print one line per source:

```text
part source nasa-orion-capsule: downloaded
part source nasa-viking-leg: verified
```

- [ ] **Step 4: Run the real fetch and validation**

Run: `npm run fetch:part-sources && npm run validate:content`

Expected: all eight files exist under the ignored source directory with the exact checksums in Task 1; validation passes without branding metadata.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/part-source-fetch.mjs scripts/fetch-part-sources.mjs tests/part-source-fetch.test.ts
git commit -m "build: fetch pinned part sources"
```

---

### Task 3: Build deterministic GLB compilation and checked output

**Files:**
- Create: `scripts/lib/glb-stats.mjs`
- Create: `scripts/compile-part-assets.mjs`
- Create: `scripts/compile-part-assets-container.mjs`
- Create: `tests/part-asset-compiler.test.ts`
- Modify: `tools/planet-assets/Dockerfile`
- Modify: `scripts/sync-renderer-assets.mjs`

**Interfaces:**
- Consumes: normalized authoring GLBs and recipe records.
- Produces: `compilePartAssets({ root, write, optimize }): Promise<CheckedPartArtifact>`.
- Produces: `inspectGlb(bytes): { triangles, geometryBytes, textureBytes, boundsMin, boundsMax, extensionsUsed, animationClips }`.

- [ ] **Step 1: Add failing compiler tests with a generated triangle fixture**

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePartAssets } from '../scripts/compile-part-assets.mjs';

describe('part asset compiler', () => {
  it('writes a stable checked artifact and rejects a triangle overrun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perilune-compile-'));
    await mkdir(join(root, 'assets/parts/authoring'), { recursive: true });
    await mkdir(join(root, 'assets/parts/generated'), { recursive: true });
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await writeFile(join(root, 'assets/parts/recipes.json'), JSON.stringify({
      schemaVersion: 1,
      budgets: { transferBytes: 6291456, gpuBytes: 33554432, combinedTriangles: 30000 },
      models: [{ assetId: 'fixture', partId: 'pod-voyager', inputPath: 'authoring/fixture.glb', outputPath: 'generated/fixture.glb', triangleLimit: 1, textureMaxDimension: 512, visualBounds: { min: [-1, -1, -1], max: [1, 1, 1] }, plumeAnchors: [] }],
    }));
    await writeFile(join(root, 'assets/parts/authoring/fixture.glb'), minimalTriangleGlb());
    await expect(compilePartAssets({ root, write: true, optimize: async (input) => input })).resolves.toMatchObject({ schemaVersion: 1 });
    const first = await readFile(join(root, 'src/generated/checked-part-manifest.json'));
    await compilePartAssets({ root, write: true, optimize: async (input) => input });
    await expect(readFile(join(root, 'src/generated/checked-part-manifest.json'))).resolves.toEqual(first);
  });
});
```

Define the fixture in the test so it does not depend on a checked-in binary:

```ts
function minimalTriangleGlb(): Buffer {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(8);
  [0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const bin = Buffer.concat([positions, indices]);
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin]);
}
```

- [ ] **Step 2: Verify failure, then implement GLB inspection**

Run: `npm test -- tests/part-asset-compiler.test.ts`

Expected before implementation: FAIL due to missing compiler.

`inspectGlb()` must validate the GLB magic/version/length, parse the JSON chunk, sum indexed triangle counts, sum referenced geometry buffer views, read accessor bounds, report embedded image buffer bytes and animation count, and reject non-finite accessor bounds.

- [ ] **Step 3: Implement compilation through the pinned CLI**

For each recipe, calculate `simplifyRatio = Math.min(1, triangleLimit / sourceTriangles)` and invoke:

```bash
gltf-transform optimize INPUT OUTPUT.partial \
  --compress meshopt \
  --meshopt-level high \
  --flatten true \
  --join true \
  --prune true \
  --weld true \
  --simplify true \
  --simplify-ratio RATIO \
  --simplify-error 0.0005 \
  --simplify-lock-border true \
  --texture-compress ktx2 \
  --texture-size MAX_DIMENSION
```

Inspect the partial result, enforce the recipe and global budgets, rename atomically, then write canonical JSON to `src/generated/checked-part-manifest.json` with `{ schemaVersion, manifestSha256, manifest }`.

- [ ] **Step 4: Add the authoritative container path**

Extend the existing pinned KTX container so it also runs the pinned glTF Transform CLI. `compile-part-assets-container.mjs` must bind-mount `assets/parts` and `src/generated`, then execute:

```bash
npm run compile:part-assets -- --write && npm run validate:content
```

The normal compiler must default to dry-run verification; only `--write` replaces generated files.

- [ ] **Step 5: Copy only checked part assets to public output**

Extend `sync-renderer-assets.mjs` to read the checked part artifact, verify its digest and every GLB checksum, clear `public/parts/`, and copy only declared output paths. Preserve the existing Basis and planet behavior.

- [ ] **Step 6: Run focused tests and an empty-manifest compile**

Run: `npm test -- tests/part-asset-compiler.test.ts && npm run compile:part-assets -- --write && npm run sync:renderer-assets`

Expected: PASS; the checked artifact contains zero models until Tasks 4 and 5, and `public/parts/` is empty.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/glb-stats.mjs scripts/compile-part-assets.mjs scripts/compile-part-assets-container.mjs scripts/sync-renderer-assets.mjs tests/part-asset-compiler.test.ts tools/planet-assets/Dockerfile src/generated/checked-part-manifest.json
git commit -m "build: compile checked part models"
```

---

### Task 4: Author and compile the pod, leg, dish, and wheel

**Files:**
- Create: `assets/parts/authoring/orion-voyager-pod.glb`
- Create: `assets/parts/authoring/viking-stilt-leg.glb`
- Create: `assets/parts/authoring/tdrs-longtalk-dish.glb`
- Create: `assets/parts/authoring/mars-mesa-wheel.glb`
- Modify: `assets/parts/recipes.json`
- Create/Modify: `assets/parts/generated/*.glb`
- Modify: `src/generated/checked-part-manifest.json`
- Modify: `ATTRIBUTIONS.md`

**Interfaces:**
- Produces asset IDs: `orion-voyager-pod`, `viking-stilt-leg`, `tdrs-longtalk-dish`, `mars-mesa-wheel`.
- Produces authoring models centered at the origin with local `+Y` as the mounting axis.

- [ ] **Step 1: Verify the authoring tool gate**

Run: `blender --version`

Expected: Blender 4.2 or newer. If the command is absent, stop this task and install Blender 4.2 LTS before changing binary assets.

- [ ] **Step 2: Produce the four reviewed intermediates**

- Orion: import the capsule STL, remove interior/print-support geometry that is invisible externally, retain the heat-shield silhouette, create flat interfaces at `y = ±0.425`, scale to a 1.2 m diameter and 0.85 m height, and assign black heat-shield, off-white thermal cover, and bare-metal detail materials.
- Viking: import one leg and one foot, delete duplicate printable copies if present, join them, align the mount at `y = +0.575` and foot bottom at `y = -0.575`, and keep the foot within `x = ±0.45`, `z = ±0.30`.
- TDRS: retain the standalone reflector/feed mesh, remove unrelated mounting remnants, place the mounting base at `y = -0.175`, and fit the reflector inside `x/z = ±0.561`.
- Mars wheel: import the wheel STL, orient the axle on local `+Y`, fit radius 0.5 m and width 0.34 m, preserve the tread silhouette, and remove any geometric text or identifier.

Export each file as GLB with transforms applied, no cameras/lights, and names matching the asset ID.

- [ ] **Step 3: Add exact recipe limits**

Use these records:

| assetId | partId | triangleLimit | texture max | visual bounds min/max |
| --- | --- | ---: | ---: | --- |
| `orion-voyager-pod` | `pod-voyager` | 6000 | 1024 | `[-0.612,-0.434,-0.612]` / `[0.612,0.434,0.612]` |
| `viking-stilt-leg` | `leg-lander` | 2500 | 512 | `[-0.45,-0.575,-0.30]` / `[0.45,0.575,0.30]` |
| `tdrs-longtalk-dish` | `ant-dish` | 3500 | 512 | `[-0.561,-0.179,-0.561]` / `[0.561,0.179,0.561]` |
| `mars-mesa-wheel` | `wheel-mesa` | 3500 | 512 | `[-0.51,-0.173,-0.51]` / `[0.51,0.173,0.51]` |

All four have `plumeAnchors: []`.

- [ ] **Step 4: Compile, inspect, and visually review**

Run:

```bash
npm run compile:part-assets:container
npx gltf-transform inspect assets/parts/generated/orion-voyager-pod.glb
npx gltf-transform inspect assets/parts/generated/viking-stilt-leg.glb
npx gltf-transform inspect assets/parts/generated/tdrs-longtalk-dish.glb
npx gltf-transform inspect assets/parts/generated/mars-mesa-wheel.glb
```

Expected: each output stays within its table limit, uses Meshopt, has no Draco requirement, respects bounds, and contains no visible identifier in Blender material preview.

- [ ] **Step 5: Record lightweight attribution and commit**

Add one line per source to `ATTRIBUTIONS.md` with the NASA asset-page URL and `modified by Perilune`; do not add a legal-review gate.

```bash
git add assets/parts/authoring assets/parts/recipes.json assets/parts/generated src/generated/checked-part-manifest.json ATTRIBUTIONS.md
git commit -m "art: add first NASA part model batch"
```

---

### Task 5: Author and compile both engines, the tank, and stowed chute

**Files:**
- Create: `assets/parts/authoring/apollo-colt-engine.glb`
- Create: `assets/parts/authoring/shuttle-mule-engine.glb`
- Create: `assets/parts/authoring/shuttle-pl400-tank.glb`
- Create: `assets/parts/authoring/orion-homecoming-housing.glb`
- Modify: `assets/parts/recipes.json`
- Create/Modify: `assets/parts/generated/*.glb`
- Modify: `src/generated/checked-part-manifest.json`
- Modify: `ATTRIBUTIONS.md`

**Interfaces:**
- Produces asset IDs: `apollo-colt-engine`, `shuttle-mule-engine`, `shuttle-pl400-tank`, `orion-homecoming-housing`.
- Produces three Mule plume anchors and one Colt plume anchor in recipe/model space.

- [ ] **Step 1: Author the Apollo Colt and verify the extraction gate**

Open the pinned Apollo LM GLB and isolate `group13 pC`. Confirm in solid and material preview that it is the central descent-engine bell. If it is not the engine bell, select the actual central descent-engine geometry from the same source and name the retained object `apollo-colt-engine`; do not change source files.

Fit the mount to `y = +0.225`, nozzle exit to `y = -0.225`, and bounds to `x/z = ±0.398`. Export one applied-transform GLB.

- [ ] **Step 2: Author the Mule, tank, and housing**

- Mule: retain the Shuttle main-engine assembly, remove orbiter attachment remnants, orient all nozzles toward `-Y`, fit the cluster within `x/z = ±1.275`, and place nozzle exits around `y = -0.80`.
- Tank: crop the straight External Tank barrel, preserve orange foam, feedline, seams, and brackets, delete tapered ends, cap both cuts, add flat rings at `y = ±1.80`, and fit diameter 1.2 m.
- Housing: create a closed Orion-style forward-bay cover with radial seams, fasteners, and a dark base ring; fit diameter 0.6 m and height 0.35 m. Do not create canopy, cords, or an animation track.

Export applied-transform GLBs with no visible logos, flags, patches, names, or identifying text.

- [ ] **Step 3: Add exact recipe records and plume anchors**

| assetId | partId | triangleLimit | texture max | visual bounds min/max |
| --- | --- | ---: | ---: | --- |
| `apollo-colt-engine` | `eng-colt` | 2000 | 512 | `[-0.398,-0.230,-0.398]` / `[0.398,0.230,0.398]` |
| `shuttle-mule-engine` | `eng-mule` | 6000 | 512 | `[-1.275,-0.816,-1.275]` / `[1.275,0.816,1.275]` |
| `shuttle-pl400-tank` | `tank-s4` | 4500 | 1024 | `[-0.612,-1.836,-0.612]` / `[0.612,1.836,0.612]` |
| `orion-homecoming-housing` | `chute-main` | 1500 | 512 | `[-0.306,-0.179,-0.306]` / `[0.306,0.179,0.306]` |

Set `animationPolicy: "none"` on the chute recipe. Compilation must reject that output if `inspectGlb()` reports any animation clips.

Colt plume anchor:

```json
[{ "position": [0, -0.225, 0], "rotation": [0, 0, 0, 1], "scale": 1 }]
```

Mule plume anchors:

```json
[
  { "position": [-0.55, -0.80, 0.32], "rotation": [0, 0, 0, 1], "scale": 0.58 },
  { "position": [0.55, -0.80, 0.32], "rotation": [0, 0, 0, 1], "scale": 0.58 },
  { "position": [0, -0.80, -0.55], "rotation": [0, 0, 0, 1], "scale": 0.58 }
]
```

- [ ] **Step 4: Compile and run the complete technical gate**

Run: `npm run compile:part-assets:container && npm run validate:content`

Expected: eight checked models, combined triangles at or below 30,000, transfer at or below 6 MiB, GPU allocation at or below 32 MiB, and no model exceeding its individual limit.

- [ ] **Step 5: Commit the second batch**

```bash
git add assets/parts/authoring assets/parts/recipes.json assets/parts/generated src/generated/checked-part-manifest.json ATTRIBUTIONS.md
git commit -m "art: complete NASA part model slice"
```

---

### Task 6: Add the checked runtime manifest and model library

**Files:**
- Create: `src/render/partModelManifest.ts`
- Create: `src/render/partModelLibrary.ts`
- Create: `tests/part-model-manifest.test.ts`
- Create: `tests/part-model-library.test.ts`

**Interfaces:**
- Produces: `checkPartModelManifest(artifact): CheckedPartModelManifest`.
- Produces: `PartEffectAnchor { position, rotation, scale }`.
- Produces: `PartModelLibrary.preload(): Promise<void>`.
- Produces: `PartModelLibrary.instantiate(assetId): { object, plumeAnchors } | null`.

- [ ] **Step 1: Write failing opaque-boundary and fallback tests**

```ts
it('rejects a changed checked manifest digest', () => {
  const artifact = fixtureArtifact();
  artifact.manifest.models[0].triangleCount++;
  expect(() => checkPartModelManifest(artifact)).toThrow(/digest mismatch/i);
});

it('settles failed models and clones successful shared resources', async () => {
  const backend = { load: vi.fn()
    .mockResolvedValueOnce(new THREE.Group())
    .mockRejectedValueOnce(new Error('broken')), dispose: vi.fn() };
  const library = new PartModelLibrary(fixtureManifestTwoModels(), backend);
  await expect(library.preload()).resolves.toBeUndefined();
  expect(library.instantiate('good')).not.toBeNull();
  expect(library.instantiate('broken')).toBeNull();
});
```

Implement `fixtureArtifact()` by building a one-model manifest with a valid 64-character asset checksum and computing its canonical SHA-256 before the assertion mutates it. Implement `fixtureManifestTwoModels()` through `checkPartModelManifest()` with `good` and `broken` records, valid finite bounds, empty anchors, and totals below all three budgets; do not cast an unchecked object to the opaque type.

- [ ] **Step 2: Implement manifest checking**

Mirror the checked-planet-manifest pattern: canonicalize and hash the embedded manifest, validate safe paths/checksums/bounds/anchors/budgets, freeze records, and brand accepted objects through a `WeakSet`. Expose `model(assetId)` and `modelForPart(partId)` lookups.

- [ ] **Step 3: Implement the browser backend and synchronous instantiation**

Create a backend around `GLTFLoader`, `KTX2Loader`, and `MeshoptDecoder`. Fetch each GLB as bytes, verify SHA-256 with `crypto.subtle.digest`, parse it through `GLTFLoader.parseAsync`, and cache the root scene. `preload()` uses `Promise.allSettled` and logs one error per rejected record. `instantiate()` returns `scene.clone(true)` plus frozen anchors only after preload.

- [ ] **Step 4: Verify resource ownership**

Add tests proving two instances have different `Object3D` identities, shared geometry/material identities, independent transforms, one logged error per failed asset, and a single disposal of cached geometry/materials/textures when the library is disposed.

Run: `npm test -- tests/part-model-manifest.test.ts tests/part-model-library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/partModelManifest.ts src/render/partModelLibrary.ts tests/part-model-manifest.test.ts tests/part-model-library.test.ts
git commit -m "feat: preload checked part models"
```

---

### Task 7: Integrate model bodies and multi-nozzle plume groups

**Files:**
- Modify: `src/content/parts.ts:47-109,117-134,194-231,304-353,742-772,927-957`
- Modify: `src/render/vesselMesh.ts:1-227`
- Create: `tests/vessel-mesh.test.ts`
- Modify: `tests/vessel.test.ts`

**Interfaces:**
- Consumes: `PartModelLibrary.instantiate(assetId)` and `PartEffectAnchor`.
- Produces: `buildVesselVisual(craft, models?: PartModelLibrary): VesselVisual`.
- Changes: `VesselVisual.plumes` from `Map<number, THREE.Mesh>` to `Map<number, THREE.Group>`.

- [ ] **Step 1: Write failing body-selection and plume-count tests**

```ts
it('uses a model clone and suppresses the procedural accent body', () => {
  const craft = createCraft('model');
  addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  const library = fakeLibrary('orion-voyager-pod', new THREE.Group());
  const visual = buildVesselVisual(craft, library);
  expect(visual.partMeshes.get(1)?.userData.visualSource).toBe('model');
});

it('creates three Mule plumes and one Colt plume under their part holders', () => {
  const craft = createCraft('engines');
  const mule = addPart(craft, 'eng-mule', null, 'root', { x: -2, y: 0, z: 0 });
  const colt = addPart(craft, 'eng-colt', null, 'root', { x: 2, y: 0, z: 0 });
  const visual = buildVesselVisual(craft, fakeEngineLibrary());
  expect(visual.plumes.get(mule.key)?.children).toHaveLength(3);
  expect(visual.plumes.get(colt.key)?.children).toHaveLength(1);
  expect(visual.plumes.get(mule.key)?.parent).toBe(visual.partMeshes.get(mule.key));
});
```

Define `fakeLibrary(assetId, object, plumeAnchors = [])` as an object whose `instantiate(requestedId)` returns `{ object: object.clone(true), plumeAnchors }` only for the matching ID and otherwise returns `null`. Define `fakeEngineLibrary()` with the exact Colt and Mule anchor arrays from Task 5. This keeps the tests on the public `PartModelLibrary` surface without fetching GLBs.

- [ ] **Step 2: Add model IDs without changing gameplay fields**

Add `modelAssetId?: string` to `PartDef` and assign the eight exact asset IDs from Tasks 4 and 5. Add a catalog test asserting all eight IDs are unique and every non-model gameplay property is unchanged from the pre-task fixture.

- [ ] **Step 3: Select imported bodies with fallback**

Change `buildPartMesh()` to ask the optional library for `def.modelAssetId`. Add the imported object when available and set `holder.userData.visualSource = 'model'`; otherwise build the current body and accent band and set `visualSource = 'procedural'`.

- [ ] **Step 4: Build plume groups from anchors**

For each engine, use authored anchors from the instantiated model or this default:

```ts
[{ position: [0, -def.shape.height / 2, 0], rotation: [0, 0, 0, 1], scale: 1 }]
```

Create one holder per anchor, position/quaternion it from metadata, multiply plume dimensions by `def.engine.plumeScale * anchor.scale`, and parent the complete group to the part holder. Store power on the group and apply throttle/vacuum scaling to each plume holder without overwriting anchor placement.

- [ ] **Step 5: Preserve shared resources during removal**

Keep imported geometry/materials out of `ownedGeometries`. Ensure `disposeVesselVisual()` and destroyed-part pruning dispose only plume/helper geometry created for that vessel.

- [ ] **Step 6: Run focused and simulation regression tests**

Run: `npm test -- tests/vessel-mesh.test.ts tests/vessel.test.ts tests/ascent.test.ts tests/palla-mission.test.ts`

Expected: PASS; simulation results remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/content/parts.ts src/render/vesselMesh.ts tests/vessel-mesh.test.ts tests/vessel.test.ts
git commit -m "feat: render model-backed vessel parts"
```

---

### Task 8: Inject one shared library into game, world, and editor

**Files:**
- Modify: `src/game.ts:30-140,699-703`
- Modify: `src/render/worldScene.ts:115-150,390-430,630-650`
- Modify: `src/ui/editor.ts:60-135,320-345,650-665`
- Modify: `tests/renderer-transaction.test.ts`
- Modify: `e2e/editor-interactions.spec.ts`

**Interfaces:**
- Consumes: one initialized `PartModelLibrary`.
- Changes constructors: `new WorldScene(context, partModels)` and `new Editor(uiRoot, callbacks, partModels)`.

- [ ] **Step 1: Write failing injection assertions**

Add tests that construct `WorldScene` and `Editor` with a fake library and assert model instantiation is requested during vessel/editor visual construction. Add a test that `pagehide` disposes the shared library exactly once after world/editor teardown.

- [ ] **Step 2: Initialize before the workshop becomes interactive**

In `PeriluneGame.start()`, after `createRenderContext()`:

```ts
const checkedParts = checkPartModelManifest(checkedPartArtifact);
this.partModels = createBrowserPartModelLibrary(this.ctx.renderer, checkedParts, {
  transcoderPath: `${baseUrl}basis/`,
  resolveAssetUrl: (path) => `${baseUrl}parts/${path}`,
});
await this.partModels.preload();
```

Then pass the library to `WorldScene` and `Editor`. Do not add a status dot or animated loading control.

- [ ] **Step 3: Use the library in every vessel build path**

Pass it to world vessel creation, editor rebuilds, and temporary ghost construction. When creating a translucent ghost, assign temporary materials only to the clone and dispose those temporary materials when the ghost is dropped.

- [ ] **Step 4: Handle context restoration and shutdown**

Keep the parsed scenes, geometry, material, and texture objects in the library across WebGL context restoration; Three.js will upload those CPU-side objects again. Rebuild editor/world vessel clones without a second network preload, and add a renderer-transaction assertion that model fetch counts do not increase. On `pagehide`, remove vessel visuals first and then dispose the library exactly once.

- [ ] **Step 5: Run typecheck and editor tests**

Run: `npm run typecheck && npm test -- tests/renderer-transaction.test.ts && npm run test:e2e -- e2e/editor-interactions.spec.ts`

Expected: PASS; editor placement and selection use imported nested meshes without changing attachment behavior.

- [ ] **Step 6: Commit**

```bash
git add src/game.ts src/render/worldScene.ts src/ui/editor.ts tests/renderer-transaction.test.ts e2e/editor-interactions.spec.ts
git commit -m "feat: share part models across editor and flight"
```

---

### Task 9: Add browser fallback, lifecycle, and full-slice acceptance coverage

**Files:**
- Create: `e2e/part-models.spec.ts`
- Modify: `src/game.ts` test probe only
- Modify: `src/ui/editor.ts` read-only visual lookup
- Modify: `src/render/worldScene.ts` read-only plume lookup
- Modify: `QA.md`

**Interfaces:**
- Consumes: the eight model-backed part definitions and runtime library.
- Produces: browser-visible test probes for visual source and plume child count only; no action bypasses UI.

- [ ] **Step 1: Add read-only probes**

Expose through `window.__TEST__`:

```ts
partVisualSource: (key: number) => this.editor.visualSourceForPart(key),
plumeCount: (key: number) => this.world.plumeCountForPart(key),
```

Add `Editor.visualSourceForPart(key): 'model' | 'procedural' | null`, which reads the holder's `userData.visualSource`, and `WorldScene.plumeCountForPart(key): number`, which finds the active vessel's plume group and returns its child count. Neither method may mutate game state.

Keep placement, launch, and staging actions driven by real UI events.

- [ ] **Step 2: Write the eight-part editor journey**

The test must place all eight enhanced definitions, assert each holder reports `model`, select and drag a nested imported mesh, save the craft, reload it, and verify the eight part IDs and model sources survive.

- [ ] **Step 3: Write plume and fallback journeys**

- Launch a staged craft containing the Mule and Colt; assert three and one plume children respectively and verify visibility follows real staging/throttle UI.
- Route one part GLB request to return HTTP 500; reload the workshop and assert only that part reports `procedural` while the other seven report `model` and launch remains available.
- Confirm `chute-main` has no animation clips and remains the stowed housing after arming and deployment state changes.

- [ ] **Step 4: Run targeted browser and full unit suites**

Run:

```bash
npm run test:e2e -- e2e/part-models.spec.ts e2e/editor-interactions.spec.ts e2e/game-loop.spec.ts
npm test
npm run build
```

Expected: all commands PASS.

- [ ] **Step 5: Document the manual visual matrix and commit**

Add a `NASA-style part models` QA section covering front/back/top/bottom reference comparison, attachment gaps, normals, clipping, material color space, logo/text inspection, six-wheel/four-leg reference craft triangle count, and stowed chute state.

```bash
git add src/game.ts src/ui/editor.ts src/render/worldScene.ts e2e/part-models.spec.ts QA.md
git commit -m "test: certify NASA part model slice"
```

---

### Task 10: Finalize pipeline documentation and verify a clean handoff

**Files:**
- Modify: `CONTENT_PIPELINE.md`
- Modify: `ATTRIBUTIONS.md`
- Modify: `README.md` only if it currently describes all parts as procedural

**Interfaces:**
- Documents: fetch, author, compile, validate, sync, and fallback behavior.

- [ ] **Step 1: Document exact authoring commands**

Add this sequence to `CONTENT_PIPELINE.md`:

```bash
npm run fetch:part-sources
blender --version
npm run compile:part-assets:container
npm run validate:content
npm run build
```

Explain that source downloads are ignored, reviewed authoring GLBs and generated runtime GLBs are committed, development validation is technical, and branding/usage review is manual before production.

- [ ] **Step 2: Remove stale procedural-only claims**

Update `src/content/parts.ts`'s file header and any README statement that says external art assets are unnecessary for all parts. Preserve the statement that procedural geometry is the fallback.

- [ ] **Step 3: Run the final verification matrix**

```bash
git diff --check
npm run validate:content
npm run typecheck
npm test
npm run test:e2e -- e2e/part-models.spec.ts e2e/editor-interactions.spec.ts e2e/game-loop.spec.ts
npm run build
```

Expected: every command exits 0; the checked manifest contains exactly eight models; the working tree contains no generated drift from the compile or sync commands.

- [ ] **Step 4: Confirm scope exclusions**

Run:

```bash
rg -n "Saturn V|Ares 1|completed craft|deploy(ed|ment).*canopy" src assets/parts e2e
```

Expected: no completed-craft implementation and no deployed-canopy implementation; references may appear only in documentation that explicitly marks them deferred.

- [ ] **Step 5: Commit documentation**

```bash
git add CONTENT_PIPELINE.md ATTRIBUTIONS.md README.md src/content/parts.ts
git commit -m "docs: document part model pipeline"
```
