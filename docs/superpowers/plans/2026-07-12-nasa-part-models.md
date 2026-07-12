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
- Implement and integrate Tasks 1-9 before expanding automated coverage. During those tasks, use typechecking, content validation, asset inspection, and focused manual smoke checks only; Task 10 owns the consolidated unit, integration, browser, and issue-fix round.

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

- `tests/part-asset-schema.test.ts`, `tests/part-source-fetch.test.ts`, `tests/part-asset-compiler.test.ts` — pipeline regression coverage added together in Task 10.
- `tests/part-model-manifest.test.ts`, `tests/part-model-library.test.ts`, `tests/vessel-mesh.test.ts` — runtime regression coverage added together in Task 10.
- `e2e/part-models.spec.ts` — full eight-part acceptance and fallback coverage added in Task 10.
- `CONTENT_PIPELINE.md`, `ATTRIBUTIONS.md`, `QA.md`

---

### Task 1: Define the part-asset contracts and technical validator

**Files:**
- Create: `assets/parts/sources.json`
- Create: `assets/parts/recipes.json`
- Create: `src/generated/checked-part-manifest.json` as the empty bootstrap artifact
- Create: `tools/part-assets/compiler-lock.json`
- Create: `scripts/lib/part-asset-schema.mjs`
- Modify: `scripts/validate-content.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `loadPartAssetInputs(root): { sources, recipes }`
- Produces: `validatePartAssetInputs(root): string[]`
- Produces: `validateCheckedPartManifest(root): string[]`
- Consumes later: recipe records keyed by `assetId` and source records keyed by `sourceId`.

- [ ] **Step 1: Add exact pinned dependencies and scripts**

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

- [ ] **Step 2: Add source records and an initially empty recipe set**

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

- [ ] **Step 3: Implement technical-only schema validation**

`validatePartAssetDocuments()` must enforce schema versions, unique IDs, HTTPS source URLs, 64-character lowercase SHA-256 values, safe relative paths, numeric bounds, positive limits, unique `partId` assignments, and the approved total budget ceilings. It must not require a license classification or branding-review object.

At the end of `scripts/validate-content.mjs`, append errors from both part validation functions before the existing final error/report branch. `validateCheckedPartManifest()` may accept a missing checked artifact only while `recipes.models` is empty; after the first recipe is added, absence is an error. Write the empty bootstrap artifact as canonical JSON with an empty `manifest.models` array and a matching `manifestSha256`, using the same canonical serializer that Task 3 will reuse.

- [ ] **Step 4: Run the bootstrap validation check**

Run: `npm run validate:content`

Expected: exits 0 with the empty recipe set and correctly hashed empty checked artifact.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json package-lock.json assets/parts src/generated/checked-part-manifest.json scripts/lib/part-asset-schema.mjs scripts/validate-content.mjs tools/part-assets/compiler-lock.json
git commit -m "build: define part asset contracts"
```

---

### Task 2: Add atomic source fetching

**Files:**
- Create: `scripts/lib/part-source-fetch.mjs`
- Create: `scripts/fetch-part-sources.mjs`

**Interfaces:**
- Consumes: source records from `assets/parts/sources.json`.
- Produces: `fetchPinnedSource(source, destination, fetchImpl): Promise<'downloaded' | 'verified'>`.

- [ ] **Step 1: Implement the atomic fetch helper**

Implement streaming download to `<destination>.partial`, SHA-256 verification, atomic rename, cleanup on error, and reuse only when the existing destination checksum matches.

- [ ] **Step 2: Implement the entrypoint**

`scripts/fetch-part-sources.mjs` must load the source manifest, create `assets/parts/sources/`, fetch all records sequentially for readable errors, and print one line per source:

```text
part source nasa-orion-capsule: downloaded
part source nasa-viking-leg: verified
```

- [ ] **Step 3: Run the real fetch and validation**

Run: `npm run fetch:part-sources && npm run validate:content`

Expected: all eight files exist under the ignored source directory with the exact checksums in Task 1; validation passes without branding metadata.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/part-source-fetch.mjs scripts/fetch-part-sources.mjs
git commit -m "build: fetch pinned part sources"
```

---

### Task 3: Build deterministic GLB compilation and checked output

**Files:**
- Create: `scripts/lib/glb-stats.mjs`
- Create: `scripts/compile-part-assets.mjs`
- Create: `scripts/compile-part-assets-container.mjs`
- Modify: `tools/planet-assets/Dockerfile`
- Modify: `scripts/sync-renderer-assets.mjs`

**Interfaces:**
- Consumes: normalized authoring GLBs and recipe records.
- Produces: `compilePartAssets({ root, write, optimize }): Promise<CheckedPartArtifact>`.
- Produces: `inspectGlb(bytes): { triangles, geometryBytes, textureBytes, boundsMin, boundsMax, extensionsUsed, animationClips }`.

- [ ] **Step 1: Implement GLB inspection**

`inspectGlb()` must validate the GLB magic/version/length, parse the JSON chunk, sum indexed triangle counts, sum referenced geometry buffer views, read accessor bounds, report embedded image buffer bytes and animation count, and reject non-finite accessor bounds.

- [ ] **Step 2: Implement compilation through the pinned CLI**

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

- [ ] **Step 3: Add the authoritative container path**

Extend the existing pinned KTX container so it also runs the pinned glTF Transform CLI. `compile-part-assets-container.mjs` must bind-mount `assets/parts` and `src/generated`, then execute:

```bash
npm run compile:part-assets -- --write && npm run validate:content
```

The normal compiler must default to dry-run verification; only `--write` replaces generated files.

- [ ] **Step 4: Copy only checked part assets to public output**

Extend `sync-renderer-assets.mjs` to read the checked part artifact, verify its digest and every GLB checksum, clear `public/parts/`, and copy only declared output paths. Preserve the existing Basis and planet behavior.

- [ ] **Step 5: Run the empty-manifest pipeline smoke check**

Run: `npm run compile:part-assets -- --write && npm run sync:renderer-assets && npm run validate:content`

Expected: PASS; the checked artifact contains zero models until Tasks 4 and 5, and `public/parts/` is empty.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/glb-stats.mjs scripts/compile-part-assets.mjs scripts/compile-part-assets-container.mjs scripts/sync-renderer-assets.mjs tools/planet-assets/Dockerfile src/generated/checked-part-manifest.json
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

**Interfaces:**
- Produces: `checkPartModelManifest(artifact): CheckedPartModelManifest`.
- Produces: `PartEffectAnchor { position, rotation, scale }`.
- Produces: `PartModelLibrary.preload(): Promise<void>`.
- Produces: `PartModelLibrary.instantiate(assetId): { object, plumeAnchors } | null`.

- [ ] **Step 1: Implement manifest checking**

Mirror the checked-planet-manifest pattern: canonicalize and hash the embedded manifest, validate safe paths/checksums/bounds/anchors/budgets, freeze records, and brand accepted objects through a `WeakSet`. Expose `model(assetId)` and `modelForPart(partId)` lookups.

- [ ] **Step 2: Implement the browser backend and synchronous instantiation**

Create a backend around `GLTFLoader`, `KTX2Loader`, and `MeshoptDecoder`. Fetch each GLB as bytes, verify SHA-256 with `crypto.subtle.digest`, parse it through `GLTFLoader.parseAsync`, and cache the root scene. `preload()` uses `Promise.allSettled` and logs one error per rejected record. `instantiate()` returns `scene.clone(true)` plus frozen anchors only after preload.

- [ ] **Step 3: Implement explicit shared-resource ownership**

When caching a parsed scene, collect geometry, material, and texture identities into `Set`s. Clones borrow those resources. `dispose()` traverses the sets once, disposes each identity once, clears the cache, and makes later `instantiate()` calls return `null`.

- [ ] **Step 4: Run the runtime compile check**

Run: `npm run typecheck`

Expected: exits 0 with the new opaque manifest boundary and browser backend.

- [ ] **Step 5: Commit**

```bash
git add src/render/partModelManifest.ts src/render/partModelLibrary.ts
git commit -m "feat: preload checked part models"
```

---

### Task 7: Integrate model bodies and multi-nozzle plume groups

**Files:**
- Modify: `src/content/parts.ts:47-109,117-134,194-231,304-353,742-772,927-957`
- Modify: `src/render/vesselMesh.ts:1-227`

**Interfaces:**
- Consumes: `PartModelLibrary.instantiate(assetId)` and `PartEffectAnchor`.
- Produces: `buildVesselVisual(craft, models?: PartModelLibrary): VesselVisual`.
- Changes: `VesselVisual.plumes` from `Map<number, THREE.Mesh>` to `Map<number, THREE.Group>`.

- [ ] **Step 1: Add model IDs without changing gameplay fields**

Add `modelAssetId?: string` to `PartDef` and assign the eight exact asset IDs from Tasks 4 and 5. Do not alter any mass, cost, shape, attachment, resource, engine, parachute, or staging field.

- [ ] **Step 2: Select imported bodies with fallback**

Change `buildPartMesh()` to ask the optional library for `def.modelAssetId`. Add the imported object when available and set `holder.userData.visualSource = 'model'`; otherwise build the current body and accent band and set `visualSource = 'procedural'`.

- [ ] **Step 3: Build plume groups from anchors**

For each engine, use authored anchors from the instantiated model or this default:

```ts
[{ position: [0, -def.shape.height / 2, 0], rotation: [0, 0, 0, 1], scale: 1 }]
```

Create one holder per anchor, position/quaternion it from metadata, multiply plume dimensions by `def.engine.plumeScale * anchor.scale`, and parent the complete group to the part holder. Store power on the group and apply throttle/vacuum scaling to each plume holder without overwriting anchor placement.

- [ ] **Step 4: Preserve shared resources during removal**

Keep imported geometry/materials out of `ownedGeometries`. Ensure `disposeVesselVisual()` and destroyed-part pruning dispose only plume/helper geometry created for that vessel.

- [ ] **Step 5: Run a compile and manual construction smoke check**

Run: `npm run typecheck && npm run build`

Expected: exits 0. In the workshop, place the pod, Mule, and Colt; confirm visible model bodies and three/one plume holders without assessing final polish yet.

- [ ] **Step 7: Commit**

```bash
git add src/content/parts.ts src/render/vesselMesh.ts
git commit -m "feat: render model-backed vessel parts"
```

---

### Task 8: Inject one shared library into game, world, and editor

**Files:**
- Modify: `src/game.ts:30-140,699-703`
- Modify: `src/render/worldScene.ts:115-150,390-430,630-650`
- Modify: `src/ui/editor.ts:60-135,320-345,650-665`

**Interfaces:**
- Consumes: one initialized `PartModelLibrary`.
- Changes constructors: `new WorldScene(context, partModels)` and `new Editor(uiRoot, callbacks, partModels)`.

- [ ] **Step 1: Initialize before the workshop becomes interactive**

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

- [ ] **Step 2: Use the library in every vessel build path**

Pass it to world vessel creation, editor rebuilds, and temporary ghost construction. When creating a translucent ghost, assign temporary materials only to the clone and dispose those temporary materials when the ghost is dropped.

- [ ] **Step 3: Handle context restoration and shutdown**

Keep the parsed scenes, geometry, material, and texture objects in the library across WebGL context restoration; Three.js will upload those CPU-side objects again. Rebuild editor/world vessel clones without a second network preload. On `pagehide`, remove vessel visuals first and then dispose the library exactly once.

- [ ] **Step 4: Run the integrated workshop smoke check**

Run: `npm run typecheck && npm run build && npm run dev`

Expected: compile/build exits 0. In the browser, place, select, move, save, launch, stage, and return to the editor with a model-backed craft; procedural fallback still appears if a model URL is temporarily made invalid.

- [ ] **Step 6: Commit**

```bash
git add src/game.ts src/render/worldScene.ts src/ui/editor.ts
git commit -m "feat: share part models across editor and flight"
```

---

### Task 9: Add acceptance probes and finish pipeline documentation

**Files:**
- Modify: `src/game.ts` test probe only
- Modify: `src/ui/editor.ts` read-only visual lookup
- Modify: `src/render/worldScene.ts` read-only plume lookup
- Modify: `CONTENT_PIPELINE.md`
- Modify: `ATTRIBUTIONS.md`
- Modify: `QA.md`
- Modify: `README.md` only if it currently describes all parts as procedural

**Interfaces:**
- Produces: browser-visible read-only probes for visual source and plume child count; no probe performs an action.
- Documents: fetch, author, compile, validate, sync, fallback, and manual visual-review behavior.

- [ ] **Step 1: Add read-only acceptance probes**

Expose through `window.__TEST__`:

```ts
partVisualSource: (key: number) => this.editor.visualSourceForPart(key),
plumeCount: (key: number) => this.world.plumeCountForPart(key),
```

Add `Editor.visualSourceForPart(key): 'model' | 'procedural' | null`, which reads the holder's `userData.visualSource`, and `WorldScene.plumeCountForPart(key): number`, which finds the active vessel's plume group and returns its child count. Neither method may mutate game state. Placement, launch, throttle, staging, saving, and selection continue through real UI events.

- [ ] **Step 2: Document the authoring pipeline**

Add this sequence to `CONTENT_PIPELINE.md`:

```bash
npm run fetch:part-sources
blender --version
npm run compile:part-assets:container
npm run validate:content
npm run build
```

Explain that source downloads are ignored, reviewed authoring GLBs and generated runtime GLBs are committed, development validation is technical, and branding/usage review is manual before production.

- [ ] **Step 3: Remove stale procedural-only claims and finish attribution**

Update `src/content/parts.ts`'s file header and any README statement that says external art assets are unnecessary for all parts. Preserve the statement that procedural geometry is the fallback. Ensure `ATTRIBUTIONS.md` contains all eight pinned NASA source-page links and identifies the stowed housing as custom work derived only from Orion visual language.

- [ ] **Step 4: Document the manual visual matrix**

Add a `NASA-style part models` QA section covering front/back/top/bottom reference comparison, attachment gaps, normals, clipping, material color space, logo/text inspection, six-wheel/four-leg reference-craft triangle count, three/one engine plume alignment, and stowed chute state.

- [ ] **Step 5: Commit the probes and documentation**

```bash
git add src/game.ts src/ui/editor.ts src/render/worldScene.ts src/content/parts.ts CONTENT_PIPELINE.md ATTRIBUTIONS.md QA.md README.md
git commit -m "docs: finish NASA part model handoff"
```

---

### Task 10: Run the consolidated test, fix, and acceptance round

**Files:**
- Create: `tests/part-asset-schema.test.ts`
- Create: `tests/part-source-fetch.test.ts`
- Create: `tests/part-asset-compiler.test.ts`
- Create: `tests/part-model-manifest.test.ts`
- Create: `tests/part-model-library.test.ts`
- Create: `tests/vessel-mesh.test.ts`
- Create: `e2e/part-models.spec.ts`
- Modify: `tests/vessel.test.ts`
- Modify: `tests/renderer-transaction.test.ts`
- Modify: `e2e/editor-interactions.spec.ts`
- Modify if a failure identifies a defect: `scripts/lib/part-asset-schema.mjs`, `scripts/lib/part-source-fetch.mjs`, `scripts/lib/glb-stats.mjs`, `scripts/compile-part-assets.mjs`, `src/render/partModelManifest.ts`, `src/render/partModelLibrary.ts`, `src/render/vesselMesh.ts`, `src/render/worldScene.ts`, `src/ui/editor.ts`, `src/game.ts`

**Interfaces:**
- Consumes: the complete eight-part implementation from Tasks 1-9.
- Produces: regression coverage and fixes for pipeline determinism, runtime fallback, resource lifecycle, editor interaction, flight staging, and scope exclusions.

- [ ] **Step 1: Add the pipeline regression suite**

Cover these exact cases:

- schema accepts the valid eight-source/eight-recipe documents without branding-review metadata;
- schema rejects duplicate IDs, unsafe paths, malformed SHA-256 values, duplicate `partId` assignments, invalid bounds, and every global-budget overrun;
- source fetch writes through `.partial`, renames only after checksum verification, reuses a verified destination, and removes partial bytes after a mismatch;
- compiler emits byte-identical canonical checked manifests across two runs, rejects triangle/texture/bounds/animation-policy overruns, and the sync step copies only declared checksummed GLBs.

Run: `npm test -- tests/part-asset-schema.test.ts tests/part-source-fetch.test.ts tests/part-asset-compiler.test.ts`

Expected: PASS after correcting any pipeline defects exposed by the cases above.

- [ ] **Step 2: Add the runtime and vessel regression suite**

Cover these exact cases:

- changed manifest digest is rejected before lookup;
- preload settles individual failures and `instantiate()` returns `null` only for failed/unavailable assets;
- two instances have different `Object3D` identities, shared geometry/material identities, and independent transforms;
- library disposal releases each cached geometry/material/texture once;
- each of the eight `PartDef` records has the exact model ID while all gameplay fields remain unchanged;
- imported body selection suppresses the procedural accent, a missing model selects procedural fallback, Mule creates three plumes, Colt creates one, and plume groups remain parented to their part holders;
- existing ascent, staging, parachute, save, mission, destruction, and renderer-restoration behavior remains unchanged, including no extra model fetch after context restoration.

Run:

```bash
npm test -- tests/part-model-manifest.test.ts tests/part-model-library.test.ts tests/vessel-mesh.test.ts
npm test -- tests/vessel.test.ts tests/ascent.test.ts tests/palla-mission.test.ts tests/renderer-transaction.test.ts
```

Expected: PASS after fixing implementation defects rather than weakening assertions or changing gameplay data.

- [ ] **Step 3: Add the full browser acceptance journey**

In `e2e/part-models.spec.ts`, drive real UI events to:

- place all eight enhanced definitions and assert every holder reports `model`;
- select and drag a nested imported mesh, save, reload, and confirm the eight part IDs and visual sources survive;
- launch a staged Mule/Colt craft, confirm three/one plume children, and verify visibility follows actual staging and throttle controls;
- return HTTP 500 for one part GLB, reload, and confirm only that part reports `procedural` while the other seven report `model` and launch remains available;
- arm/deploy `chute-main` and confirm its rendered object remains the static stowed housing with no animation clips.

Run: `npm run test:e2e -- e2e/part-models.spec.ts e2e/editor-interactions.spec.ts e2e/game-loop.spec.ts`

Expected: PASS after correcting nested-mesh selection, lifecycle, staging, or fallback defects found by the journey.

- [ ] **Step 4: Run the complete stabilization matrix and fix failures**

Run this sequence after the focused failures are resolved:

```bash
npm run validate:content
npm run typecheck
npm test
npm run test:e2e -- e2e/part-models.spec.ts e2e/editor-interactions.spec.ts e2e/game-loop.spec.ts
npm run build
git diff --check
```

Expected: every command exits 0; the checked manifest contains exactly eight models; compile and sync commands produce no generated drift.

- [ ] **Step 5: Confirm the deferred scope stayed deferred**

Run:

```bash
rg -n "Saturn V|Ares 1|completed craft|deploy(ed|ment).*canopy" src assets/parts e2e
```

Expected: no completed-craft implementation and no deployed-canopy implementation; references may appear only in documentation that explicitly marks them deferred.

- [ ] **Step 6: Commit the consolidated stabilization round**

```bash
git add tests e2e scripts src assets/parts src/generated
git commit -m "test: stabilize NASA part model slice"
```
