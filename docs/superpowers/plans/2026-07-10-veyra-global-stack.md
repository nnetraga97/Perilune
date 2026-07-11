# Veyra Global Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Veyra's authored, terrestrial orbit-to-ground renderer with consistent global geography, atmosphere, ocean, two cloud scales, and a coverage-safe compact-to-terrain transition.

**Architecture:** `TerrestrialBodyRenderer` composes small owned passes around the existing authoritative cube-sphere terrain. Validated `RuntimeBodyAssetPack` data is handed to candidates through the renderer contract before preparation and compilation; the renderer manager retains the legacy renderer until the complete terrestrial candidate is ready. Compact, terrain, ocean, clouds, atmosphere, and MapView share body-fixed coordinates with +Z north and `atan2(y,x)` longitude.

**Tech Stack:** TypeScript, Three.js/WebGL2, GLSL 300 ES, Sharp, KTX-Software 4.4.2, Natural Earth II 3.2.0 public-domain raster source, Vitest, the existing checked-manifest/transaction platform.

## Global Constraints

- Simulation height remains owned by `solidHeight`; visual maps and shaders may not redefine contact height.
- Veyra terrain remains raw seafloor below a separate water surface.
- Low/Medium/High runtime global maps are exactly 1024x512, 2048x1024, and 4096x2048; the canonical source is 8192x4096.
- Active-body GPU ceilings remain 64/128/256 MiB and transient ceilings remain 96/192/384 MiB for Low/Medium/High.
- The compact or legacy renderer stays visible until assets, shader compilation, and replacement coverage are ready.
- Normal compact-to-terrain fade is 0.35 seconds, pressure-shortened fade is 0.2 seconds, and the hard maximum is 1.5 seconds.
- `RenderCaps.atmospherePath` alone selects analytic, lookup, or limb-haze atmosphere materials.
- Auren's star adapter remains the sole directional-light owner.
- Natural Earth II is accepted only through its original public-domain source and a pinned local checksum; the reference GitHub repository is not an asset provenance source.
- Per user direction, use focused per-task tests and typecheck. Defer broad unit/e2e runs and Medium/Low hardware certification to final validation.

---

### Task 1: Typed Runtime Asset Handoff

**Files:**
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/render/planetAssetLoader.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/legacyBodyRenderer.ts`
- Modify: `src/render/starBodyRenderer.ts`
- Test: `tests/renderer-transaction.test.ts`

**Interfaces:**
- Produces: `RuntimeBodyAssetPack` and `BodyRenderer.stageAssets(pack)`.
- Consumes: `LoadedPlanetPack`, checked manifest digest, quality tier, dimensions, textures, and manager transaction order.

- [ ] **Step 1: Write focused failing transaction tests**

Assert that typed assets are staged before `prepareCandidate` and compile; staging failure disposes loaded textures and the candidate while retaining committed coverage; `null` is a valid procedural fallback; quality/context rebuilds install only the newly loaded pack.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/renderer-transaction.test.ts`

Expected: missing `RuntimeBodyAssetPack` and `stageAssets` contract failures.

- [ ] **Step 3: Add the typed handoff**

```ts
export interface RuntimeBodyAssetPack {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly width: number;
  readonly height: number;
  readonly manifestDigest: string;
  readonly gpuBytes: number;
  readonly textures: ReadonlyMap<string, THREE.Texture>;
}

export interface BodyRenderer {
  // existing fields and methods
  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void;
}
```

Add dimensions to checked pack parsing. Stage the pack after load and before preparation/compilation. Legacy and star adapters accept only `null`; remove the `root.userData.planetAssetPack` transport.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npx vitest run tests/renderer-transaction.test.ts tests/body-renderer.test.ts tests/context-lifecycle.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/render/bodyRenderer.ts src/render/bodyRendererManager.ts src/render/planetAssetLoader.ts src/render/worldScene.ts src/render/legacyBodyRenderer.ts src/render/starBodyRenderer.ts tests/renderer-transaction.test.ts
git commit -m "feat: type renderer asset handoff"
```

### Task 2: Veyra Canonical Maps, Runtime Packs, and Provenance

**Files:**
- Create: `scripts/lib/veyra-global-maps.ts`
- Create: `scripts/fetch-planet-source.mjs`
- Create: `assets/planets/sources/natural-earth-ii-3.2.0/TERMS.md`
- Create: generated Veyra channel files under `assets/planets/generated/veyra/{low,medium,high}/`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `scripts/validate-content.mjs`
- Modify: `assets/planets/manifest.json`
- Modify: `assets/planets/compiler-output.json`
- Modify: `tools/planet-assets/Dockerfile`
- Modify: `tools/planet-assets/compiler-lock.json`
- Modify: `ATTRIBUTIONS.md`
- Modify: `LICENSES.md`
- Modify: `CONTENT_PIPELINE.md`
- Test: `tests/content-validator.test.ts`
- Test: `tests/terrain-authority.test.ts`

**Interfaces:**
- Produces: validated Veyra albedo, oct-normal, RGBA material, and RG cloud channels for three tiers plus canonical raw hashes.
- Consumes: Natural Earth II 3.2.0 land-cover source, `solidHeight`, body recipe hash, Sharp 0.35.3, and pinned single-threaded KTX-Software 4.4.2.

- [ ] **Step 1: Pin and fetch the original source**

Use `https://naturalearth.s3.amazonaws.com/10m_raster/NE2_LR_LC.zip` (Natural Earth II 3.2.0, 16200x8100). The fetch script requires SHA-256 `3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919` before extraction, never downloads during `prebuild`, and records the Natural Earth terms URL and transformation list in the manifest.

- [ ] **Step 2: Write failing compiler and validator tests**

Assert deterministic raw hashes, exact dimensions/formats, package/fallback checksum pairs, accepted public-domain provenance, seam/pole continuity, shoreline sign outside one texel, terrain normal agreement, and active/transient/transfer budgets.

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/content-validator.test.ts tests/terrain-authority.test.ts`

- [ ] **Step 4: Generate canonical buffers from one evaluator**

For each canonical pixel, compute body-fixed direction with +Z north; sample `solidHeight` for ocean, shore, slope, and normals; warp/recolor the public-domain source with a deterministic seed; emit raw canonical hashes before encoding. Derive every runtime tier from those canonical buffers with Lanczos3.

- [ ] **Step 5: Package and validate**

Install pinned KTX-Software in the compiler container with a verified archive checksum. Encode ETC1S albedo and UASTC data channels with one thread, produce WebP/PNG fallbacks, update checked manifest data, and generate attribution/modification notices.

- [ ] **Step 6: Run focused checks and commit**

Run: `npm run compile:planet-assets -- --write && npm run validate:content && npx vitest run tests/content-validator.test.ts tests/terrain-authority.test.ts && npm run typecheck`

Commit: `feat: compile Veyra global asset packs`

### Task 3: Global Terrain Material and Compact Identity

**Files:**
- Create: `src/render/terrestrial/globalCoordinates.ts`
- Create: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `src/ui/mapView.ts`
- Test: `tests/veyra-global-material.test.ts`
- Test: `tests/body-material.test.ts`
- Test: `tests/map-material.test.ts`

**Interfaces:**
- Produces: `createTerrestrialGlobalMaterial(pack, fallback)` and a body-fixed direction geometry attribute.
- Consumes: typed albedo/normal/material textures, `bodyFixedUv`, and descriptor palette fallback.

- [ ] **Step 1: Write failing coordinate/material tests**

Cover +X, +Y, both poles, wrap adjacency, cube edges, body-fixed terrain attributes, correct texture color spaces, and a non-black palette fallback.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/veyra-global-material.test.ts tests/body-material.test.ts tests/map-material.test.ts`

- [ ] **Step 3: Refactor terrain material ownership**

Allow `PlanetRenderer` to receive an owned terrain material and disable its internal ocean while preserving existing defaults. Supply normalized body-fixed directions per vertex; reconstruct equirectangular coordinates in the shader instead of interpolating seam-crossing scalar UVs.

- [ ] **Step 4: Implement global sampling and compact parity**

Sample sRGB albedo, octahedral normal, and packed roughness/AO/biome/ocean data. Use the same material identity for the compact flight sphere and MapView, with descriptor fallback until its validated compact texture is resident.

- [ ] **Step 5: Run focused checks and commit**

Run: `npx vitest run tests/veyra-global-material.test.ts tests/body-material.test.ts tests/map-material.test.ts tests/body-renderer.test.ts && npm run typecheck`

Commit: `feat: render Veyra global materials`

### Task 4: Veyra Atmosphere Pass

**Files:**
- Create: `src/render/terrestrial/atmosphere.ts`
- Create: `src/render/terrestrial/atmosphereMaterial.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/veyra-atmosphere.test.ts`

**Interfaces:**
- Produces: `TerrestrialAtmosphere` with analytic, lookup, and limb-haze paths.
- Consumes: physical atmosphere height/pressure/density/scale height, visual wavelength tint/strength, camera position, sun direction, and `RenderCaps.atmospherePath`.

- [ ] **Step 1: Write RED tests** for exact shell height, unchanged physical uniforms, precision-path selection, inside/outside updates, no-atmosphere rejection, legacy-tint suppression, and idempotent disposal.
- [ ] **Step 2: Implement** an orbital limb shell plus inside-atmosphere aerial-perspective uniforms. The visual top must equal `body.radius + body.def.atmosphere.height`.
- [ ] **Step 3: Run focused checks and commit**

Run: `npx vitest run tests/veyra-atmosphere.test.ts tests/render-capabilities.test.ts tests/body-renderer.test.ts && npm run typecheck`

Commit: `feat: add Veyra atmospheric depth`

### Task 5: Separate Veyra Ocean Pass

**Files:**
- Create: `src/render/terrestrial/ocean.ts`
- Create: `src/render/terrestrial/oceanMaterial.ts`
- Test: `tests/veyra-ocean.test.ts`

**Interfaces:**
- Produces: `TerrestrialOcean` datum surface with Fresnel, glitter, depth tint, shore foam, and wetness.
- Consumes: water datum, raw seafloor terrain, material shore mask, camera/sun direction, and quality tier.

- [ ] **Step 1: Write RED tests** for exact datum radius, negative seafloor preservation, camera/sun updates, Low glitter reduction without authority changes, mask fallback, and disposal.
- [ ] **Step 2: Implement** an independent water sphere; never clamp terrain vertices to the ocean datum.
- [ ] **Step 3: Run focused checks and commit**

Run: `npx vitest run tests/veyra-ocean.test.ts tests/terrain-authority.test.ts tests/ground.test.ts && npm run typecheck`

Commit: `feat: add Veyra ocean surface`

### Task 6: Two-Scale Clouds and Lighting

**Files:**
- Create: `src/render/terrestrial/cloudLayer.ts`
- Create: `src/render/terrestrial/cloudMaterial.ts`
- Test: `tests/veyra-clouds.test.ts`

**Interfaces:**
- Produces: `TerrestrialCloudDeck` owning two deterministic shells.
- Consumes: validated RG cloud texture, body orientation, simulation time, quality tier, and Auren-provided light direction.

- [ ] **Step 1: Write RED tests** for two distinct drift rates, orientation-before-drift composition, Low shadow disablement, Medium/High conditional shadows, quality-independent simulation, and one-time disposal.
- [ ] **Step 2: Implement** two texture scales and selective shadow ownership; do not create a second directional light.
- [ ] **Step 3: Run focused checks and commit**

Run: `npx vitest run tests/veyra-clouds.test.ts tests/body-orientation.test.ts tests/body-renderer.test.ts && npm run typecheck`

Commit: `feat: layer Veyra cloud systems`

### Task 7: Coverage-Safe Compact-to-Terrain Transition

**Files:**
- Create: `src/render/coverageTransition.ts`
- Create: `src/render/terrestrial/coverageDither.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/coverage-transition.test.ts`

**Interfaces:**
- Produces: `CoverageTransition` and complementary compact/terrain dither uniforms.
- Consumes: viewport/FOV, camera velocity, screen-space error, terrain coverage readiness, wall-clock delta, and frame pressure.

- [ ] **Step 1: Write RED tests** proving load time does not advance fade, opacity coverage sums to one, failed coverage keeps compact fully visible, 0.35/0.2/1.5-second bounds are frame-rate independent, and incomplete children never expose holes.
- [ ] **Step 2: Implement** prewarming before the visible band and start the clock only after coverage is ready. Keep renderer-manager transaction timing separate from the visual fade.
- [ ] **Step 3: Run focused checks and commit**

Run: `npx vitest run tests/coverage-transition.test.ts tests/body-renderer.test.ts tests/renderer-transaction.test.ts && npm run typecheck`

Commit: `feat: transition Veyra from orbit to terrain`

### Task 8: Terrestrial Renderer Integration and Veyra Activation

**Files:**
- Create: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/resourceAccounting.ts`
- Modify: `src/ui/perfOverlay.ts`
- Modify: `RENDERING.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PERFORMANCE.md`
- Modify: `README.md`
- Test: `tests/terrestrial-body-renderer.test.ts`

**Interfaces:**
- Produces: a transactional `TerrestrialBodyRenderer` activated only for Veyra.
- Consumes: global material, authoritative terrain, atmosphere, ocean, cloud deck, coverage transition, typed runtime pack, and renderer platform lifecycle.

- [ ] **Step 1: Write RED integration tests** for explicit Veyra factory selection, compact relatives, one active terrain/ocean/atmosphere/cloud stack, transactional quality/context rebuild, truthful stats, procedural failure fallback, and complete disposal.
- [ ] **Step 2: Compose the renderer** and change only Veyra's `renderer` assignment from `legacy` to `terrestrial` after Low/Medium/High packs and fallbacks validate.
- [ ] **Step 3: Update docs** with shipped behavior, Natural Earth attribution, resource accounting, and the still-deferred hardware certification status.
- [ ] **Step 4: Run focused phase checks and commit**

Run: `npx vitest run tests/terrestrial-body-renderer.test.ts tests/veyra-global-material.test.ts tests/veyra-atmosphere.test.ts tests/veyra-ocean.test.ts tests/veyra-clouds.test.ts tests/coverage-transition.test.ts tests/renderer-transaction.test.ts tests/context-lifecycle.test.ts && npm run typecheck`

Commit: `feat: activate Veyra terrestrial renderer`

## Deferred Final Validation

- Broad unit and Playwright suites.
- Full production build validation beyond per-task content checks.
- Medium/Low M3 Max five-minute journeys, feature deltas, query coverage reconciliation, and final visual/art review.
- Browser-matrix and seeded visual-diff certification.
