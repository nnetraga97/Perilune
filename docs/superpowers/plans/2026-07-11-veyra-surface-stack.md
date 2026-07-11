# Veyra Surface Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 5 by moving Veyra terrain generation off the main thread, adding convincing regional and local surface rendering, streaming deterministic visual effects, and integrating a quality-invariant predictive physical-obstacle system with the existing vessel contact and save contracts.

**Architecture:** A pure terrain-data builder and bounded worker pool feed `PlanetRenderer` transferable geometry while its existing parent/child fallback coverage remains authoritative. A versioned `PhysicalScatterRecipe` produces stable cube-face cells shared by rendering, save validation, broadphase, and collision; visual density is a quality-scaled view of those cells, while physical IDs and proxies never vary by quality. The terrestrial renderer owns regional/triplanar shading and surface effects, while `GameState` owns predictive obstacle coverage and delegates narrowphase impulses to the existing flight contact path.

**Tech Stack:** TypeScript, Three.js/WebGL2, GLSL, Web Workers, Vitest, Playwright, the existing body-renderer transaction platform, terrain authority, asset compiler, checked manifest, save migration, and performance profiler.

## Global Constraints

- `solidHeight` remains the only terrain/collision-height authority; local material detail, decals, dust, and visual scatter never change collision height.
- Terrain vertices are generated in a bounded worker pool and returned through transferable buffers; the main thread only selects cells, submits jobs, and installs completed buffers.
- Local detail coordinates are anchored in body-fixed meters and repeat over exactly 8192 meters; floating-origin shifts, worker rebuilds, and quality changes may not move the pattern.
- Scatter cells are deterministic from body seed, cell coordinates, biome, slope, and altitude.
- Visual scatter never creates simulation objects and may vary by quality.
- Physical obstacle IDs, positions, proxy shapes, and collision behavior are identical on Low, Medium, and High.
- Physical obstacle activation radius is `max(300 meters, vesselSpeed * (generationP99Seconds + 2 seconds) + vesselBoundingRadius)` with 20% deactivation hysteresis.
- No unsuppressed obstacle may first appear inside a vessel's current or two-second swept bounding volume.
- Initial overlap suppression is allowed only for spawn, save restoration, and recipe migration, and ends after clearance exceeds `max(25 meters, 2 * vesselBoundingRadius)`.
- If predictive physical coverage cannot be maintained, visual density is reduced first, rails transition is blocked, and local simulation pauses before uncovered space with a recoverable loading fault; canonical collisions are never silently dropped.
- Saves store the physical-scatter recipe hash, not transient proxies; old version-4 saves whose scatter hash aliases the terrain hash remain loadable through an explicit version-5 migration.
- The compact/parent renderer stays visible until worker terrain coverage is ready; no change may weaken the existing coverage rule or 0.35/0.2/1.5-second transition bounds.
- Active-body GPU ceilings remain 64/128/256 MiB and total-renderer ceilings remain 256/384/768 MiB for Low/Medium/High.
- Each task follows RED-GREEN-REFACTOR, runs its focused tests plus typecheck and production build, receives an independent spec/code-quality review, and leaves the branch green before the next task begins.

## Implementation-First Validation Policy

Per the user's sequencing decision, Phase 5 focuses first on implementing and reviewing the complete surface feature set. Every task still leaves its focused tests, full unit suite, content validation, typecheck, and production build green, and short profiling runs may diagnose regressions. Full Medium and Low M3 Max hardware certification is not a blocker between implementation tasks; it is the final step after surface materials, canonical scatter, visual effects, physical obstacles, collision integration, production telemetry, browser journeys, visual calibration, documentation, and final code review are complete. No release or Phase 5 completion claim is made until that final certification passes.

---

### Task 1: Transferable Terrain Geometry and Bounded Worker Pool

**Files:**
- Create: `src/render/terrain/chunkGeometry.ts`
- Create: `src/render/terrain/chunkWorker.ts`
- Create: `src/render/terrain/chunkWorkerPool.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/terrain-worker.test.ts`
- Modify test: `tests/veyra-global-material.test.ts`
- Modify test: `tests/terrestrial-body-renderer.test.ts`

**Interfaces:**
- Consumes: a serializable `BodyFeatureRecipe`, body radius, cube face, node UV bounds, grid resolution, skirt depth, and palette.
- Produces: `buildTerrainChunkGeometry(request): TerrainChunkGeometryResult`, `TerrainChunkWorkerPool.submit(request)`, `cancelGeneration(generation)`, `drainCompleted()`, `timings()`, `dispose()`, and body-fixed camera velocity on `BodyRenderFrame`.
- `TerrainChunkGeometryResult` contains `Float32Array` position, normal, color, body-direction, and body-fixed-detail-anchor buffers; a `Uint16Array | Uint32Array` index buffer; an f64 origin tuple; bounds; and build timing.

- [ ] **Step 1: Write failing pure-builder tests**

Create requests for two adjacent face nodes and assert deterministic buffers, shared-edge height/normal agreement, raw seafloor preservation, 8192-meter detail anchors, valid skirt indices, and evaluator parity at every grid vertex. Assert that rebuilding after a floating-origin change produces byte-identical geometry data.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/terrain-worker.test.ts`

Expected: imports for `chunkGeometry` and `chunkWorkerPool` fail because the worker pipeline does not exist.

- [ ] **Step 3: Extract the pure geometry builder**

Move `faceToDir`, normal sampling, palette generation, skirts, and indices out of `PlanetRenderer.buildChunk`. The worker request carries a plain frozen recipe snapshot and calls `evaluateRecipeHeight` directly; it never constructs `Body`, reads Three.js objects, or duplicates the terrain evaluator. Detail anchors are computed from absolute body-fixed meters with an 8192-meter periodic offset relative to the chunk origin.

- [ ] **Step 4: Add the worker protocol and pool**

Use `new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' })`. Size the production pool to `max(1, min(4, hardwareConcurrency - 1))`, permit an injected `WorkerLike` factory for tests, transfer every completed `ArrayBuffer`, record rolling build p99, reject duplicate job keys, and tag requests/results with renderer generation. Disposal terminates all workers and rejects queued jobs; stale results are discarded without installation.

- [ ] **Step 5: Convert Veyra `PlanetRenderer` to schedule/install only**

Add an optional worker-pool mode used by `TerrestrialBodyRenderer`. `selectNode` submits missing nodes within `buildBudget`; `update` drains completed results before selection and installs only current-generation results. Use camera body-fixed velocity to pre-request the next cells. Keep the nearest available parent selected until all four children are installed. Cancellation on quality replacement/dispose must not remove committed coverage.

- [ ] **Step 6: Run GREEN, build, and commit**

Run: `npx vitest run tests/terrain-worker.test.ts tests/veyra-global-material.test.ts tests/terrestrial-body-renderer.test.ts tests/coverage-transition.test.ts && npm run typecheck && npm run build`

Commit: `feat: generate Veyra terrain in workers`

### Task 2: Make Production Content Validation Unskippable

**Files:**
- Modify: `package.json`
- Test: `tests/content-validator.test.ts`
- Test: `tests/feasibility-certification.test.ts`

**Interfaces:**
- Produces: an unskippable production-build validation chain while retaining the already-tested reference-certification contract for the final task.
- Consumes: `validate:content`, `sync:renderer-assets`, the production build entry, and the existing feasibility-certification validator.

- [ ] **Step 1: Write a failing build-entry test**

Assert `package.json.scripts.prebuild` includes `npm run validate:content` before `sync:renderer-assets`, and that a deliberately invalid manifest makes the production build entry fail before Vite runs.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/content-validator.test.ts`

Expected: the prebuild assertion fails because the current prebuild only synchronizes renderer assets.

- [ ] **Step 3: Wire validation and run focused certification tests**

Set `prebuild` to `npm run validate:content && npm run sync:renderer-assets`. Run `npm run validate:content`, the content-validator test, feasibility-certification test, typecheck, and build.

- [ ] **Step 4: Run complete build-entry verification and commit**

Run: `npm run validate:content && npx vitest run tests/content-validator.test.ts tests/feasibility-certification.test.ts && npm run typecheck && npm run build && npm run test -- --run`

Commit: `build: validate planet content before production`

### Task 3: Regional and Body-Fixed Triplanar Surface Material

**Files:**
- Create: `src/render/terrestrial/surfaceMaterial.ts`
- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Test: `tests/veyra-surface-material.test.ts`
- Modify test: `tests/veyra-global-material.test.ts`

**Interfaces:**
- Produces: `createTerrestrialSurfaceMaterial(pack, descriptor, tier)` and `classifyTerrestrialSurface(sample)`.
- Consumes: global albedo/normal/material maps, body direction, body-fixed detail anchor, terrain normal, altitude, slope, latitude, ocean proximity, and deterministic moisture noise.

- [x] **Step 1: Write failing material tests**

Cover soil, rock, sand, and vegetation dominance; snow/highland fallback; slope-driven rock exposure; shore sand/wetness; latitude and deterministic moisture influence; Low/Medium/High frequency differences without identity changes; tri-planar weights summing to one; 8192-meter periodicity; and identical samples across floating-origin shifts and worker rebuilds.

- [x] **Step 2: Run RED**

Run: `npx vitest run tests/veyra-surface-material.test.ts tests/veyra-global-material.test.ts`

Expected: the surface-material API and `detailAnchor` shader attribute are missing.

- [x] **Step 3: Implement deterministic regional classification**

Decode biome class from material B and shore/ocean from A. Blend it with evaluator altitude, geometric slope, absolute latitude, and a body-fixed periodic moisture function. Return normalized weights for soil, rock, sand, and vegetation so CPU tests and shader constants share the same thresholds.

- [x] **Step 4: Implement analytic triplanar detail**

Inject a periodic multi-octave procedural detail function into `MeshStandardMaterial` rather than adding unlicensed texture assets. Blend along geometric-normal axes, perturb only shading normals/albedo/roughness, and leave vertex positions unchanged. Set declared repeat and material scales per tier while preserving the same regional classification.

- [x] **Step 5: Integrate, verify, and commit**

Run: `npx vitest run tests/veyra-surface-material.test.ts tests/veyra-global-material.test.ts tests/terrain-worker.test.ts tests/ground.test.ts && npm run typecheck && npm run build`

Commit: `feat: add Veyra regional surface materials`

### Task 4: Versioned Canonical Scatter Recipe and Compiler Artifact

**Files:**
- Create: `src/sim/scatterRecipe.ts`
- Create: `scripts/lib/veyra-scatter.ts`
- Create generated: `assets/planets/generated/veyra/canonical/scatter.json`
- Create generated: `src/generated/veyra-scatter.json`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `scripts/validate-content.mjs`
- Modify: `assets/planets/manifest.json`
- Modify: `assets/planets/compiler-output.json`
- Modify: `src/generated/checked-planet-manifest.json`
- Modify: `src/save/schema.ts`
- Modify: `src/save/persistence.ts`
- Test: `tests/scatter-recipe.test.ts`
- Modify test: `tests/content-validator.test.ts`
- Modify test: `tests/save-terrain-migration.test.ts`

**Interfaces:**
- Produces: `PhysicalScatterRecipe`, `scatterRecipeForBody(body)`, cube-face `ScatterCellId`, stable visual/physical records, identical canonical/runtime JSON artifacts, and a distinct 32-hex recipe hash.
- Consumes: integer recipe data, canonical signed-16 height, canonical material bytes, a specified integer PRNG, and terrain recipe hash.

- [x] **Step 1: Write failing recipe, seam, and migration tests**

Assert stable IDs/records across runs, distinct neighboring cells, agreement across every cube seam, biome/slope/altitude filtering, no ocean obstacles, proxy shape validation, physical equality across all quality tiers, a distinct scatter hash, rejection of unknown hashes before save mutation, and successful migration of version-4 terrain-hash aliases to version 5.

- [x] **Step 2: Run RED**

Run: `npx vitest run tests/scatter-recipe.test.ts tests/save-terrain-migration.test.ts tests/content-validator.test.ts`

Expected: the scatter recipe/artifact is absent and saves still alias terrain and scatter hashes.

- [x] **Step 3: Define the canonical integer format and generator**

Use canonical JSON containing format version, body ID, terrain recipe hash, scatter recipe hash, cube-cell resolution, record counts, and sorted cells. Records use integer face/cell coordinates, quantized in-cell coordinates, quantized radius/height, proxy kind (`sphere`, `capsule`, or `compound-sphere`), biome class, visual class, and a stable 64-bit ID encoded as lowercase hex. Generate from canonical CPU height/material buffers with an integer PRNG; never sample compressed/fallback/GPU textures. Write byte-identical copies under `assets/` for provenance/validation and `src/generated/` for synchronous simulation/rendering imports.

- [x] **Step 4: Validate and expose checked metadata**

Validate bounds, sorted unique IDs, cell ownership, checksums, recipe linkage, byte equality of the asset/runtime copies, ocean exclusion, and deterministic recompile fingerprints. Add the artifact to canonical manifest accounting without loading it as a GPU texture channel.

- [x] **Step 5: Migrate saves explicitly**

Bump `SAVE_VERSION` to 5. Version-4 migration rewrites only a surface pose whose scatter hash equals its terrain hash to the current body's declared legacy alias; restoration then validates `scatterRecipeForBody(body).hash`. Serialization always writes the real scatter hash.

- [x] **Step 6: Generate, verify, and commit**

Run: `npm run compile:planet-assets:container && npm run validate:content && npx vitest run tests/scatter-recipe.test.ts tests/save-terrain-migration.test.ts tests/content-validator.test.ts && npm run typecheck && npm run build`

Commit: `feat: compile canonical Veyra scatter cells`

### Task 5: Streamed Visual Scatter, Decals, and Dust

**Files:**
- Create: `src/render/terrestrial/scatter.ts`
- Create: `src/render/terrestrial/surfaceEffects.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/resourceAccounting.ts`
- Test: `tests/veyra-surface-effects.test.ts`
- Modify test: `tests/terrestrial-body-renderer.test.ts`
- Modify test: `tests/resource-accounting.test.ts`

**Interfaces:**
- Produces: `TerrestrialScatter`, `TerrestrialSurfaceEffects`, deterministic per-cell retry, instance counts, buffer bytes, and idempotent disposal.
- Consumes: canonical scatter cells, camera body-fixed position/velocity, terrain height and normal, quality tier, time, sun direction, and physical suppression IDs.

- [ ] **Step 1: Write failing stream/effect tests**

Cover deterministic grass/shrub/rock transforms, quality density ordering, unchanged physical records, camera-centered cell activation, 20% visual hysteresis, failed-cell discard and deterministic retry, no underwater instances, terrain-conforming decals, body-fixed dust motion, zero simulation objects, bounded pools, resource accounting, quality replacement, context rebuild, and one-time disposal.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/veyra-surface-effects.test.ts tests/terrestrial-body-renderer.test.ts tests/resource-accounting.test.ts`

Expected: no production scatter/effects owners or renderer statistics exist.

- [ ] **Step 3: Build production instancing**

Use shared low-poly geometries and `InstancedMesh` pools for grass, shrubs, and rocks. Stream visible cells around the body-fixed camera; derive each transform from canonical records and terrain normals. Quality changes alter only visual selection and mesh complexity. A failed cell is removed completely and retried from its stable seed on a later update.

- [ ] **Step 4: Add decals and dust**

Create pooled terrain-hugging decal instances for bare soil, rock breakup, wet shore, and landing scuffs. Create a bounded `Points` dust system driven by body-fixed velocity, altitude, biome dryness, and deterministic time; it must not move with floating-origin shifts or add collision state.

- [ ] **Step 5: Integrate stats, verify, and commit**

Extend `BodyRendererStats` with visual scatter, decal, dust, physical proxy, collision, worker timing, and resource-byte fields. Include them in renderer disposal and transaction rebuilds.

Run: `npx vitest run tests/veyra-surface-effects.test.ts tests/terrestrial-body-renderer.test.ts tests/resource-accounting.test.ts tests/context-lifecycle.test.ts && npm run typecheck && npm run build`

Commit: `feat: stream Veyra surface effects`

### Task 6: Predictive Quality-Invariant Physical Obstacle Coverage

**Files:**
- Create: `src/sim/physicalObstacles.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/save/persistence.ts`
- Modify: `src/ui/flightHud.ts`
- Test: `tests/physical-obstacles.test.ts`
- Modify test: `tests/save-terrain-migration.test.ts`

**Interfaces:**
- Produces: `PhysicalObstacleSystem.update(vessels, time)`, `query(vessel)`, `canEnterRails(vessel)`, suppression state, generation p99, coverage status, and recoverable loading fault.
- Consumes: canonical physical cells, every active vessel, body-fixed transforms, speed, craft bounding radius, spawn/restore markers, fixed pool caps, and current quality only for visuals.

- [ ] **Step 1: Write failing predictive-coverage tests**

Cover the exact activation formula, 20% deactivation hysteresis, high-speed two-second lookahead, two simultaneous active vessels, cube seams, stable IDs across tiers, no first appearance inside current/swept bounds, hard-pool pressure, visual-density reduction before fault, rails blocking, pause-before-uncovered-space, deterministic retry, and quality replacement with unchanged physical state.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/physical-obstacles.test.ts`

Expected: the predictive obstacle system and loading-fault state are missing.

- [ ] **Step 3: Implement multi-vessel predictive coverage**

Convert each active vessel position and velocity to body-fixed coordinates, compute its craft bounding radius from part extents, and union required cube-face cells over its swept activation capsule. Maintain per-vessel requested/active sets and a shared ref-counted canonical cell cache. Measure load/generation samples and use their rolling p99 in the next activation calculation.

- [ ] **Step 4: Implement suppression and pressure policy**

At spawn/restore/migration only, suppress overlaps per vessel and expose suppressed IDs to the renderer. Remove suppression after the required clearance and never recreate it. When the physical pool cannot cover all predictive cells, first request minimum visual density, then prevent rails, then set a recoverable fault and prevent the affected vessel from advancing into uncovered space.

- [ ] **Step 5: Integrate save restore, HUD fault, verify, and commit**

Do not serialize transient cells or suppression. Restoration reconstructs canonical records from the saved recipe hash and applies the one-time overlap rule before physics resumes. The HUD displays a recoverable terrain-loading message without decorative status dots.

Run: `npx vitest run tests/physical-obstacles.test.ts tests/save-terrain-migration.test.ts tests/planning.test.ts && npm run typecheck && npm run build`

Commit: `feat: predict Veyra obstacle coverage`

### Task 7: Obstacle Narrowphase, Vessel Contacts, Damage, and Rails Safety

**Files:**
- Create: `src/sim/obstacleContact.ts`
- Modify: `src/sim/flight.ts`
- Modify: `src/sim/state.ts`
- Test: `tests/obstacle-contact.test.ts`
- Modify test: `tests/ground.test.ts`
- Modify test: `tests/vessel.test.ts`
- Modify test: `tests/planning.test.ts`

**Interfaces:**
- Produces: sphere, capsule, and compound-sphere narrowphase contacts; hull/leg/wheel impulses; crash/damage results; and predictive rails exclusion.
- Consumes: candidate obstacles from `PhysicalObstacleSystem`, vessel part proxies, world/body-fixed transforms, contact velocity, existing spring/friction/impact tolerance, and the normal destruction/event path.

- [ ] **Step 1: Write failing contact tests**

Cover each proxy kind, hull/leg/wheel contacts, grazing and high-speed swept impacts, stable resolution independent of candidate order, no response for suppressed obstacles, crash tolerance/damage events, two vessels contacting one obstacle independently, obstacle-free parity with the existing ground solver, and refusal to put a vessel on rails while predictive coverage is active.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/obstacle-contact.test.ts tests/ground.test.ts tests/planning.test.ts`

Expected: obstacle candidates are not accepted by `stepVessel` and rails ignores physical cells.

- [ ] **Step 3: Implement deterministic narrowphase and impulses**

Represent vessel hull parts by conservative spheres, landing legs by capsules, and wheels by their existing spheres. Test against obstacle sphere/capsule/compound children, sort contacts by stable obstacle ID and part key, and apply normal impulse, friction, torque, impact tolerance, and damage through the existing `StepResult`/`destroyVessel` event path. Preserve terrain contact behavior when no obstacle candidates exist.

- [ ] **Step 4: Integrate GameState and rails rules**

Update obstacle coverage before each fixed physics step, pass candidates into every active vessel's `StepContext`, pause only an affected unsafe local step, and surface the loading fault. `canRailsWarp`, automatic bubble rails transitions, and landed rails transitions all reject predictive-zone vessels until coverage is no longer required.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/obstacle-contact.test.ts tests/physical-obstacles.test.ts tests/ground.test.ts tests/vessel.test.ts tests/planning.test.ts tests/ascent.test.ts && npm run typecheck && npm run build`

Commit: `feat: collide vessels with Veyra obstacles`

### Task 8: Production Integration, Documentation, Visual Journeys, and Phase Audit

**Files:**
- Modify: `src/render/worldScene.ts`
- Modify: `src/ui/perfOverlay.ts`
- Modify: `playwright.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `e2e/terrain-proto.spec.ts`
- Create: `e2e/veyra-surface.spec.ts`
- Create: `e2e/veyra-visual.spec.ts`
- Create: `scripts/calibrate-visual-baselines.mjs`
- Create generated: `e2e/baselines/veyra/visual-thresholds.json`
- Modify: `RENDERING.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PERFORMANCE.md`
- Modify: `README.md`
- Modify: `STATUS.md`
- Modify if attribution changes: `LICENSES.md`

**Interfaces:**
- Produces: production overlay evidence, stable orbit-to-contact journeys, docs matching shipped behavior, and a requirement-by-requirement gate ledger.
- Consumes: worker/scatter/obstacle stats, browser console/shader failures, quality transaction/context restoration, and final M3 reference results.

- [ ] **Step 1: Write failing integration journeys**

At fixed seeds/times, fly Veyra through orbit, atmosphere, low flight, and contact on Low and Medium. Assert no black frames, missing assets, shader errors, coverage gaps, unbounded worker queue, first-appearance obstacle violation, physical-ID drift after quality switching, context-restore loss, or save/load overlap explosion. Assert regional detail, at least three visual scatter classes, decals, dust under dry low flight, and physical proxies become measurable near the surface.

- [ ] **Step 2: Add calibrated Veyra visual baselines**

Capture distant orbit, atmospheric boundary, low flight, and surface at fixed day and night simulation times in pinned Chromium/SwiftShader. For each view, capture 30 clean runs, derive whole-frame plus limb/shoreline/transition/surface-detail region thresholds, then prove seeded black-material, shifted-shoreline, broken-seam, lost-cloud, wrong-orientation, and missing-scatter defects fail while every clean calibration passes. Never mask planet pixels.

- [ ] **Step 3: Wire production telemetry**

Pass renderer stats into typed overlay fields for worker queue/build/install p95, visual scatter, decals, dust, physical cells/proxies, suppressed proxies, collisions, coverage radius, fault state, transition duration, and GPU/resource categories. Remove any stale zero-only placeholders.

- [ ] **Step 4: Expand the browser matrix**

Configure pinned Playwright Chromium, Firefox, and WebKit projects for CI smoke coverage and installed stable Chrome/Edge channels for the release matrix. Record manual current/previous Safari results on macOS because Playwright WebKit is not claimed as Safari. Each project runs the Veyra journey and rejects console asset/shader errors; exact browser versions are written into the release evidence.

- [ ] **Step 5: Update documentation truthfully**

Document worker ownership, triplanar anchoring, scatter recipe format/hash, quality behavior, obstacle activation/fault policy, save v5 migration, resource measurements, and exact remaining phases. Do not claim Palla or Tyran Phase 6/7 visuals are part of Phase 5.

- [ ] **Step 6: Self-review every Phase 5 requirement and fix gaps**

Re-read the spec sections for Veyra, orbit-to-ground continuity, surface scatter/collision, quality budgets, failure handling, tests, completion gates, delivery sequence, and documentation. For every sentence, record its proving file/test/run or fix the gap. Palla/Tyran visual identity gates remain explicitly scoped to Phases 6/7 and are not claimed complete here.

- [ ] **Step 7: Request final whole-branch review and fix every finding**

The reviewer receives the full merge-base diff and the completed gate ledger. Fix every Critical/Important finding, rerun covering tests, and re-review until approved.

- [ ] **Step 8: Run complete automated and browser verification**

Run: `npm run validate:content && npm run typecheck && npm test -- --run && npm run build && npm run test:e2e`

Required result: zero failures, playable-loop and terrain-descent green, no missing-asset/shader errors, and production build validation visibly invoked.

- [ ] **Step 9: Run final M3 Low/Medium hardware certification last**

Only after Steps 1-8 pass, repeat the approved 30-second warm-up plus three five-minute journeys for Low and Medium with Phase 5 enabled. Prove >=60 FPS median, <16.7 ms frame p95, <=4 ms submission p95, <=2 ms terrain schedule/install p95, <=8 ms valid GPU p95, >=95% valid GPU query coverage, transfer and active/total/transient ceilings, quality-invariant physical IDs, and no uncovered-obstacle violations. If Medium misses, remove cloud shadows, reduce atmosphere samples, reduce the second cloud scale, reduce visual scatter, then simplify ocean glitter, one step at a time with a full rerun after each change. Never reduce terrain authority or physical proxies. Record complete passing evidence in `PERFORMANCE.md`.

- [ ] **Step 10: Commit final certification evidence**

Commit: `feat: complete Veyra surface stack`
