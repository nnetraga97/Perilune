# Planet Rendering Fidelity — Full System Pass Implementation Plan

**Date:** 2026-07-19

**Status:** Ready for review; implementation has not started

**Branch:** `main`

**Design source:** `docs/superpowers/specs/2026-07-10-planet-graphics-design.md`

**Supersedes:** The attached draft titled `Planet Rendering Fidelity — Full System Pass`

## Goal

Replace the fake, flat, blurry low-altitude presentation and remove reproducible
planet-transition artifacts, then complete the renderer families in the approved
order: Veyra, Palla, Tyran, and the remaining system bodies.

This is a rendering pass, not a simulation rewrite. `solidHeight` and the versioned
terrain recipe remain the only collision-height authority. Shader detail, visual
scatter, decals, dust, atmosphere, clouds, shadows, and compact-body displacement
may improve presentation but may not create a second contact surface.

## Current-HEAD Facts This Plan Is Built Around

- Veyra is the only production `terrestrial` assignment. Auren is `star`; the other
  ten bodies remain `legacy`.
- `surfaceMaterial.ts` has regional classification, but its local detail is a
  kilometer-scale sine field and its apparent “triplanar” function samples only one
  three-dimensional field.
- Near terrain always blends 68 percent toward the global normal map, regardless of
  footprint or altitude.
- The atmosphere owns transmittance and heuristic multiple-scattering LUTs. It does
  not own a sky-view LUT or aerial-perspective volume. `uAerialPerspective` is
  uploaded but unused.
- `renderer.shadowMap` is disabled in production. The feasibility fixture uses a
  3.2 km-wide shadow camera and a 5 km far plane, not a 200 m camera.
- `TerrestrialBodyRenderer` requires an atmosphere, always creates an ocean, always
  creates two clouds, and requires all four Veyra channels when a pack is staged.
  Vess and Rusk therefore cannot be assigned to it unchanged.
- `TerrestrialScatter` creates a separate Cartesian cell field. It does not consume
  the canonical cube-face scatter recipe, even though the canonical recipe exposes
  stable cell seeds and records.
- Parent/child chunk transitions are controlled by `TerrainLodTransitionManager` and
  `lodDither.ts`. Compact/terrain presentation is a separate `CoverageTransition`.
  Terrain results currently contain no coarse-parent position or normal attributes.
- Palla and Wisp have Medium global packs only. Palla's runtime terrain recipe has no
  craters, and the Palla normal/material pack is derived from an authoring raster that
  is not the runtime collision terrain.
- `BodyRendererManager` preserves a committed renderer during failed replacement,
  but initial factory construction still needs an explicit legacy fallback path for
  newly activated renderer families.
- High Veyra already uses a bounded weather-cloud volume; Low/Medium weather and the
  wisps layer use parallax shells. Any radial-line fix must be based on fresh evidence,
  not assumed to be a parallax defect.

Historical checkboxes are not treated as proof of current integration. Current code
and tests are authoritative: the visual-effect classes exist, while
`TerrestrialBodyRenderer` and its tests explicitly keep them disabled.

## End-to-End Code Paths That Must Remain Coherent

### Startup, quality, and context

`parseRenderStartupOptions` → `Game.initialize` → `createRenderContext` →
`WorldScene` → `BodyRendererManager` → `createBodyRendererCandidate`.

Quality changes and context restoration must take the same transactional route as
initial authored-pack promotion. Shadow settings, atmosphere quality, material
defines, renderer kind, and resource accounting must all reflect the committed tier.

### Body assets and candidate commitment

Checked manifest → `PlanetAssetLoader.load` → borrowed `RuntimeBodyAssetPack` →
`stageAssets` → candidate update/preparation → shader compile → coverage readiness →
budget admission → atomic root swap.

Every new renderer must support a usable `stageAssets(null)` path. Borrowed pack
textures remain asset-owner resources and are never disposed by a renderer.

### Flight frame and environment

`WorldScene.update` finalizes the camera → builds one `BodyRenderFrame` per relevant
body → marks the active sphere-of-influence body → updates body renderers → updates
the active atmosphere/lighting state → places launchpad and vessels → renders.

The existing `allowFlightTerrain` flag is not sufficient for gas bodies. Add an
explicit `isFlightFocus` field so atmosphere, environment, and gas-volume behavior
can follow the active body without implying solid terrain.

### Terrain geometry and transitions

`PlanetRenderer` → `PlanetTerrainEngine` → selection/balance/coverage → scheduler →
`TerrainChunkWorkerPool` → `buildTerrainChunkGeometry` → transferable buffers →
chunk installation → parent/child transition → per-chunk color/depth/distance passes.

Any geomorph data must travel through this complete path and participate in color,
depth, distance, shadow, bounds, residency, disposal, and worker-transfer accounting.

### Material and environment consumers

The active atmospheric state affects:

- terrestrial compact and streamed terrain materials;
- the ocean shader;
- launchpad solid materials;
- procedural and imported vessel solid materials, including accent bands and
  interstage shrouds;
- visual scatter and opaque decals;
- sky/background and hemisphere lighting.

Atmosphere shells and clouds retain their own transparent composition. Starfield,
engine plumes, smoke, reentry additive effects, UI, and MapView must not be fogged by
the flight atmosphere.

### Simulation and content authority

`BodyDef` → `recipeForBody` → `evaluateRecipeHeight` → terrain worker and all solid
contact APIs. Renderer content may consume this recipe but never replace it. Gas-body
terminal pressure/depth behavior remains in `flight.ts` and `entry.ts`.

### Secondary views and teardown

MapView consumes the same body descriptor, committed compact pack, body orientation,
and visual-variant data, without creating terrain or flight-scale effects. Quick load,
quality replacement, context restoration, body SOI changes, and `WorldScene.dispose`
must release every renderer-owned geometry, material clone, LUT, shadow resource,
instance buffer, and worker exactly once.

## Global Constraints and Change Control

- Work directly on `main`, as requested. Do not create or switch to the branch named
  in the superseded draft.
- Do not commit or push unless the user asks.
- Preserve unrelated working-tree files, including local scratch tests.
- Start with current-HEAD evidence before changing visuals. Do not compare a modified
  renderer with an undocumented recollection of the baseline.
- Medium and High enable production shadows by default. `?shadows=0` is a diagnostic
  kill switch, not the normal user configuration. Low retains shadows off.
- The visual surface pass does not implement physical-obstacle coverage or collision.
  It must not claim that the complete original Phase 5 is delivered.
- Full-duration M3 Max certification remains the approved final release gate. Short
  same-machine before/after measurements are required during this plan, but are not
  certification.
- Every task runs its focused verification. The broad suite runs at milestone gates,
  not after every small edit.
- Do not refresh generated assets casually. Compiler writes are reviewed separately
  from runtime code, and the checked manifest, compiler output, provenance, recipes,
  runtime copies, and checksums move together.

## Phase 0 — Freeze Evidence and Rendering Decisions

### Task 1: Capture the current `main` visual and performance baseline

**Files:**

- Use: `e2e/veyra-render-diagnostics.spec.ts`
- Use: `e2e/helpers/renderDiagnostics.ts`
- Use: `e2e/veyra-pad-stationary.spec.ts`
- Create: `docs/performance/reference/planet-fidelity-baseline-2026-07-19.md`
- Create: `docs/performance/reference/planet-fidelity-baseline-2026-07-19.json`

**Work:**

- [ ] Record commit, browser/version, viewport, drawing-buffer dimensions, DPR,
  quality, manifest digest, machine/power state, and whether the tab was foreground.
- [ ] Run the existing Medium and High Veyra ascent/descent diagnostics without
  changing shaders, geometry, thresholds, or assets.
- [ ] Capture fixed daylight and night-side stations at pad, 100 m, 500 m, 5 km,
  50 km, atmosphere boundary, and stable orbit.
- [ ] Record draw calls, triangles, texture and geometry bytes, GPU submission p50/p95,
  terrain selection/balance/schedule/install p95, transition anomalies, and console,
  shader, and asset errors.
- [ ] Classify each reported visual defect from frames and diagnostics: texture/detail,
  geometric LOD, compact/terrain coverage, cloud geometry/UV/transparency, atmosphere,
  or lighting. Record “not reproduced” rather than guessing.
- [ ] Keep raw screenshots and traces in ignored `test-results`; commit only the
  reproduction procedure, summary JSON, and selected evidence approved for docs.

**Commands:**

```bash
npx playwright test e2e/veyra-render-diagnostics.spec.ts --project=chromium
npx playwright test e2e/veyra-pad-stationary.spec.ts --project=chromium
```

**Done when:** the baseline can be repeated and every later visual comparison names
the exact baseline station it replaces.

### Task 2: Write the implementation research/decision note

**Files:**

- Create: `docs/superpowers/specs/2026-07-19-planet-fidelity-research.md`

**Work:**

- [ ] Record the adopted technique and shipped simplification for surface texture
  stochasticity, triplanar projection, tangent-space normal composition, aerial
  perspective, shadow stabilization, and conditional geomorphing.
- [ ] State accurately that the current LUT pair is a foundation, not a complete
  Hillaire sky/aerial-perspective pipeline.
- [ ] Adopt bounded camera-to-fragment integration for opaque flight materials. It
  reuses the same scattering coefficients and sunlight LUT inputs as the shell, with
  tier-bounded samples; it does not claim to be a froxel volume or full Hillaire
  implementation.
- [ ] Define the normal coordinate convention: radial body-fixed tangent basis,
  geometric/global/detail normals transformed into that basis, weighted RNM
  composition, then transformed to view space.
- [ ] Define the texture-fetch ceiling before implementing stochastic triplanar
  sampling. The first version uses one universal generated detail albedo/normal pair,
  at most two triplanar projections, and three stochastic samples per channel.
- [ ] Record why geometry morphing remains evidence-gated and how it differs from the
  compact/terrain coverage transition.

**Done when:** the note removes every “fetch the paper while coding” ambiguity from
the superseded draft.

## Phase A — Veyra Surface Fidelity

### Task 3: Add generated local-detail assets and validation

**Files:**

- Modify: `scripts/compile-planet-assets.ts`
- Create: `scripts/lib/planet-detail-textures.ts`
- Modify: `scripts/validate-content.mjs`
- Modify generated: `assets/planets/manifest.json`
- Modify generated: `assets/planets/compiler-output.json`
- Modify generated: `src/generated/checked-planet-manifest.json`
- Create generated: Veyra tier detail albedo/normal KTX2 and fallback files
- Modify: `CONTENT_PIPELINE.md`
- Test: `tests/planet-detail-textures.test.ts`
- Modify test: `tests/content-validator.test.ts`
- Modify test: `tests/veyra-assets.test.ts`

**Contract:**

- One deterministic, tileable, histogram-bounded detail albedo and oct/tangent-normal
  pair is generated in-project; it has no external license dependency.
- Medium and High packs declare the two detail channels. Low may use the procedural
  fallback only, but its manifest contract must be explicit.
- Mip count, color space, wrap behavior, checksums, compressed/fallback byte counts,
  and compiler identity are validated like existing channels.

**Work:**

- [ ] Write deterministic generation, seam, normal-length, histogram, mip, and
  checked-manifest tests before changing the compiler.
- [ ] Generate a 2D tile with no baked lighting. Albedo contains small-scale value and
  chroma breakup; the normal tile contains zero-mean relief and no preferred world
  direction.
- [ ] Add `detailAlbedo` and `detailNormal` channel semantics without weakening the
  exact Veyra global channel checks.
- [ ] Account for both compressed and conventional fallback upload sizes.
- [ ] Dry-run first; only use the authoritative container write after reviewing the
  expected generated-file set.

**Focused verification:**

```bash
npx vitest run tests/planet-detail-textures.test.ts tests/content-validator.test.ts tests/veyra-assets.test.ts
npm run validate:content
npm run typecheck
```

### Task 4: Replace kilometer-scale sine detail with a bounded real detail path

**Files:**

- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrain/chunkGeometry.ts` only if an additional stable material
  attribute is proven necessary
- Modify test: `tests/veyra-surface-material.test.ts`
- Modify test: `tests/veyra-global-material.test.ts`
- Modify test: `tests/terrain-worker.test.ts`

**Frequency contract:**

| Tier | Procedural fallback wavelengths | Texture projection budget |
|---|---|---|
| Low | 512, 256, 128, 64, 32 m | procedural only |
| Medium | 512 through 8 m | one dominant projection plus a second only in the blend band |
| High | 512 through 4 m | two highest-weight projections |

Frequencies are explicit integer multiples of the 8192 m period. Do not infer them
from octave count. Shader derivatives fade frequencies whose projected wavelength is
below the pixel footprint.

**Work:**

- [ ] Replace `maxOctave` with explicit per-tier wavelength/frequency tables shared by
  the CPU fallback sampler and GLSL constants.
- [ ] Keep exact 8192 m repetition and body-fixed anchoring across worker rebuilds,
  chunk seams, and floating-origin changes.
- [ ] Implement triangular-grid stochastic tiling with three samples per channel and
  histogram-preserving blending for the generated detail pair.
- [ ] Rank triplanar weights and evaluate no more than the declared projection budget.
  Renormalize retained weights; do not evaluate three projections unconditionally.
- [ ] Use regional soil/rock/sand/vegetation weights for tint, amplitude, and roughness
  response rather than multiplying separate texture families.
- [ ] Fade detail from derivatives and camera distance. Verify no orbit shimmer,
  moiré, texture swimming, longitude seam, pole pinching, or cube-edge discontinuity.
- [ ] Raise global/detail anisotropy only after the real texture path exists: Low 4,
  Medium 8, High 16, capped by `RenderCaps.maxAnisotropy`.

**Required tests:** exact finest wavelengths, tier subset ordering, periodicity,
floating-origin invariance, finite derivatives, stochastic seed stability, projection
weight normalization, pack/no-pack shader keys, and borrowed-texture disposal.

**Done when:** at the 100 m and 500 m stations the ground contains stable detail much
smaller than one global-map texel, while the orbit station is visually unchanged.

### Task 5: Correct macro/detail normal composition

**Files:**

- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Modify test: `tests/veyra-surface-material.test.ts`

**Work:**

- [ ] Add CPU-testable helpers for a stable radial tangent basis, tangent/body
  transforms, weighted RNM, and footprint-based global/detail weights.
- [ ] Express geometric, authored macro, and triplanar detail normals in one radial
  body-fixed tangent frame before composition.
- [ ] Weight the authored global normal strongly when its texel footprint is useful,
  then reduce it near the ground so worker geometry and detail relief own shading.
  Do not use a fixed altitude-only `mix` and do not RNM-combine unrelated coordinate
  spaces.
- [ ] Fade detail normals before they alias. Preserve finite unit normals at poles,
  cube seams, missing packs, and degenerate derivatives.
- [ ] Keep vertex positions and collision heights untouched.

**Required tests:** RNM identity, normalized output, pole bases, global-weight monotonic
falloff, near-ground geometric influence, pack fallback, and shader/CPU convention
agreement.

## Phase B — Atmosphere, Environment Lighting, and Shadows

### Task 6: Create one shared atmosphere runtime state

**Files:**

- Create: `src/render/terrestrial/atmosphereRuntime.ts`
- Modify: `src/render/terrestrial/atmosphereLuts.ts`
- Modify: `src/render/terrestrial/atmosphereMaterial.ts`
- Modify: `src/render/terrestrial/atmosphere.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/worldScene.ts`
- Modify test: `tests/veyra-atmosphere.test.ts`
- Modify test: `tests/body-renderer.test.ts`

**Contract:** one renderer-owned LUT set and one mutable uniform state feed the shell,
opaque aerial perspective, and CPU environment-light sample. No duplicate LUT set is
created per material.

**Work:**

- [ ] Add `BodyRenderFrame.isFlightFocus` independently of
  `allowFlightTerrain`; update frame reuse and pruning tests.
- [ ] Separate LUT ownership from shell material construction. The atmosphere owner
  creates/disposes the LUTs once and lends them to shell and opaque-material state.
- [ ] Rename metadata and documentation so the heuristic multiple-scattering texture
  is not represented as the complete Hillaire pipeline.
- [ ] Delete the dead `uAerialPerspective` uniform or replace it with a value that is
  actually consumed; no dead compatibility uniform remains.
- [ ] Expose a pure CPU environment sample containing horizon/zenith color,
  transmittance, sky irradiance approximation, and active/inactive state.
- [ ] Only the flight-focus renderer may activate shared world atmosphere state;
  compact relatives must not overwrite it during the body loop.

### Task 7: Apply bounded aerial perspective to all opaque flight solids

**Files:**

- Create: `src/render/terrestrial/aerialPerspective.ts`
- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/vesselMesh.ts`
- Modify: `src/render/partModelLibrary.ts` only if material-clone ownership must be
  exposed there
- Modify: `src/render/interstageShroud.ts`
- Modify: `src/render/terrestrial/scatter.ts`
- Modify: `src/render/terrestrial/surfaceEffects.ts`
- Modify tests: `tests/veyra-atmosphere.test.ts`, `tests/vessel-mesh.test.ts`,
  `tests/part-model-library.test.ts`, `tests/terrestrial-body-renderer.test.ts`

**Implementation contract:**

- The shared GLSL integrates extinction and in-scatter along the finite camera-to-
  fragment segment with tier-bounded samples. Existing LUTs supply sunlight and
  multiple-scatter estimates at sample points; they are not treated as a segment LUT.
- Sample count is capability/tier bounded and part of the program cache key. The
  limb-haze capability path uses a cheaper exponential approximation.
- The function accepts camera-relative fragment position, body-center position,
  physical atmosphere coefficients, sun direction, and active flag. Above the
  atmosphere or on an airless focus body it is an exact no-op.

**Material ownership work:**

- [ ] Install the shared output transform in terrestrial compact, terrain, and ocean
  materials.
- [ ] Decorate launchpad materials owned by `WorldScene`.
- [ ] Extend `VesselVisual` with owned material clones for atmospheric solid passes.
  Imported geometry/textures remain borrowed, but imported materials are cloned per
  vessel visual, decorated, and disposed with that visual. Do the same for procedural
  bodies, accent bands, and shrouds. Never decorate additive plumes, smoke, reentry
  passes, points, lines, or sprites.
- [ ] Give scatter and opaque decals the same borrowed atmosphere state. Dust remains
  transparent and uses its existing bounded visibility.
- [ ] Preserve prior `onBeforeCompile`, defines, program cache keys, maps, skinning,
  morph targets, and material arrays when cloning/decorating.
- [ ] Exercise color, depth, distance, and log-depth compilation. Aerial perspective
  changes color only; depth ownership remains unchanged.

**Required tests:** zero-length segment, vacuum/no-op, monotonic transmittance with
distance, finite in-scatter at tangent views, night-side bounds, analytic/lookup/limb
fallback selection, shader cache separation, material-array cloning, borrowed texture
ownership, quick-load disposal, and shader compile smoke.

**Visual gate:** distant terrain, pad, and vessel converge toward the same horizon
haze without fogging stars or producing a halo at object silhouettes.

### Task 8: Replace flat terrestrial ambient with active sky lighting

**Files:**

- Modify: `src/render/worldScene.ts`
- Modify: `src/render/terrestrial/atmosphereRuntime.ts`
- Modify test: `tests/veyra-atmosphere.test.ts`
- Modify test: `tests/body-renderer.test.ts`

**Work:**

- [ ] Retain a small global ambient floor and add one scene-owned hemisphere light.
  For an active terrestrial atmosphere, drive sky color, ground bounce, and intensity
  from the CPU environment sample after body renderer updates.
- [ ] Drive the scene background from the same zenith/horizon/dayness state so the
  ground, vessel, and sky do not use unrelated palettes.
- [ ] Keep the legacy atmosphere-tint branch only for committed legacy renderers.
  Airless focus bodies receive low neutral ambient; gas renderer environment is added
  with Tyran.
- [ ] Reset every light/background field on focus changes and renderer failure so
  Veyra state cannot leak to Palla or MapView.

**Required tests:** day/night monotonicity, altitude transition, focus-body reset,
legacy parity, airless darkness, finite colors, and no duplicate light creation after
quick load or context restoration.

### Task 9: Enable stabilized production shadows on Medium and High

**Files:**

- Modify: `src/render/renderStartupOptions.ts`
- Modify: `src/render/context.ts` or `src/render/worldScene.ts` for renderer settings
- Modify: `src/render/starBodyRenderer.ts`
- Modify: `src/render/vesselMesh.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/resourceAccounting.ts`
- Modify: `src/ui/perfOverlay.ts`
- Test: `tests/shadow-config.test.ts`
- Modify tests: `tests/render-startup-options.test.ts`, `tests/vessel-mesh.test.ts`,
  `tests/terrestrial-body-renderer.test.ts`, `tests/resource-accounting.test.ts`

**Shadow policy:**

| Tier | Enabled | Map | Primary casters | Receivers |
|---|---:|---:|---|---|
| Low | no | 0 | none | none |
| Medium | yes | 1024² | vessel solids, launchpad | terrain, launchpad, vessel |
| High | yes | 2048² | Medium plus nearby rock/shrub scatter after profiling | same |

**Work:**

- [ ] Parse `?shadows=0`; default to enabled for Medium/High. Apply settings before
  candidate compilation and reapply on quality replacement/context restoration.
- [ ] Keep directional-light ownership inside `StarBodyRenderer`, but expose a narrow
  shadow-focus update used by `WorldScene` after the active vessel is placed.
- [ ] Compute the craft visual bounding sphere from the completed vessel group. Fit a
  single orthographic camera around camera, active vessel, and receiver margin. Clamp
  half extent to a documented 160–1600 m range rather than a fixed 200 m box.
- [ ] Snap the shadow focus in light space to whole texels. Define and visually tune
  `bias`, `normalBias`, near/far, and maximum caster distance; record them in stats.
- [ ] Traverse solid vessel descendants so procedural bodies, imported meshes, accent
  bands, and shrouds cast. Exclude transparent/additive effects, smoke, reentry,
  points, lines, sprites, and hidden plume geometry.
- [ ] Mark launchpad cast/receive explicitly. Terrain already receives through
  `PlanetRenderer.setShadowReceiver`; keep it off on Low.
- [ ] Account for shadow-map bytes before calculating the active body's terrain
  allocation and expose them in the F3 overlay.

**Visual gate:** pad/vessel contact shadows are stable during camera motion, do not
acne or detach, and do not disappear during ordinary pad and low-flight framing.

## Phase C — Veyra Visual Surface Stack

### Task 10: Make visual scatter consume the canonical cube-face field

**Files:**

- Modify: `src/sim/scatterRecipe.ts`
- Modify: `src/render/terrestrial/scatter.ts`
- Modify: `src/render/terrestrial/surfaceEffects.ts` only for shared cell helpers
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/resourceAccounting.ts`
- Modify tests: `tests/scatter-recipe.test.ts`, `tests/veyra-surface-effects.test.ts`,
  `tests/terrestrial-body-renderer.test.ts`, `tests/resource-accounting.test.ts`

**Work:**

- [ ] Add pure direction ↔ cube-face/cell/in-cell-coordinate helpers and tests for all
  face edges and corners.
- [ ] Use the canonical recipe's resolution and `scatterCellSeed` for every visual
  cell, including cells with no physical record. Subdivide locally for dense grass
  and pebbles; do not revert to Cartesian `floor(world/cellSize)` identity.
- [ ] Decode canonical records into visual boulders/trees/landmarks at their exact
  stable positions. Quality may cull or simplify their meshes but may not move them.
- [ ] Continue generating dense non-physical grass/pebbles deterministically from the
  cell seed. They remain renderer-only and quality-scaled.
- [ ] Build one terrain sampler from `recipeForBody` and finite-difference normals;
  cache repeated cell results and retain bounded retry/overflow behavior.
- [ ] Construct scatter and effects during `TerrestrialBodyRenderer.buildStack`, add
  their groups after terrain and before transparent atmosphere/cloud passes, update
  them only while near-surface terrain presentation is active, and hide/clear active
  counts outside the band.
- [ ] Reserve instance/effect bytes before terrain allocation, report real stats, and
  dispose exactly once during stage replacement, quality replacement, context
  restoration, and renderer disposal.
- [ ] Remove the test that asserts effects stay disabled; replace it with integration,
  lifecycle, and zero-simulation-object assertions.

**Explicit boundary:** physical obstacle activation, contact, damage, and rails safety
remain deferred. This task delivers the visual portion of the old Phase 5 only.

**Visual gate:** no underwater vegetation, no floating rocks, no cell-grid boundary,
no pop inside the declared hysteresis band, and no visible regeneration while the
camera is stationary.

## Phase D — Evidence-Gated Artifact Removal

### Task 11: Re-run diagnostics after the Veyra fidelity stack

**Files:**

- Use/modify only if additional evidence fields are necessary:
  `src/render/renderDiagnostics.ts`, `e2e/helpers/renderDiagnostics.ts`,
  `e2e/veyra-render-diagnostics.spec.ts`
- Create: `docs/performance/reference/planet-fidelity-post-veyra-2026-07-19.md`

**Work:**

- [ ] Repeat the exact Phase 0 stations and journeys on Medium and High.
- [ ] Compare frames and counters against the frozen baseline.
- [ ] For cloud lines, isolate map sampling, tessellation, pole/longitude seams,
  side changes, shell ordering, transparency, parallax, and the High volume path.
- [ ] For terrain movement, correlate visible pixels with transition IDs and actual
  parent/child geometry. Distinguish material/detail changes from silhouette motion.
- [ ] For compact/terrain flashing, inspect coverage readiness, silhouettes, depth
  ownership, transparent compact opacity, ocean visibility, and aerial-perspective
  composition. Coverage values summing to one is not sufficient proof.

**Gate:** Tasks 12 and 13 are performed only for defects reproduced and classified by
this task. A “not reproduced” result closes that fix path without speculative shader
changes.

### Task 12: Fix the reproduced cloud defect at its proven source

**Possible files, selected by evidence:**

- `src/render/terrestrial/cloudMaterial.ts`
- `src/render/terrestrial/cloudLayer.ts`
- `tests/veyra-clouds.test.ts`
- `e2e/veyra-render-diagnostics.spec.ts`

**Decision table:**

- Parallax-only defect: bound angular offset with derivative/limb fade and test the
  exact grazing range.
- Tessellation/interpolation defect: increase or change shell geometry only after a
  no-parallax control proves geometry dependence.
- Longitude/pole defect: correct wrapping/basis and add seam fixtures.
- Transparency/order defect: fix side/order/opacity ownership without adding another
  shell.
- High bounded-volume defect: fix ray interval or sampling; do not apply a shell
  parallax change to the volume path.

**Done when:** the classified defect is absent at ascent and descent crossings and
cloud identity remains continuous. Volumetric clouds beyond the existing High weather
layer remain outside this pass.

### Task 13: Add parent/child vertex geomorphing only if geometry pop remains

**Files:**

- Modify: `src/render/terrain/chunkGeometry.ts`
- Modify: `src/render/terrain/chunkWorker.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`
- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Modify: `src/render/terrain/lodDither.ts`
- Modify: `src/render/terrain/lodTransition.ts` only if the transition snapshot needs
  an explicit morph value
- Modify: `src/render/resourceAccounting.ts`
- Modify tests: `tests/terrain-worker.test.ts`, `tests/planet-terrain-engine.test.ts`,
  `tests/terrain-lod-dither.test.ts`, `tests/terrain-lod-transition.test.ts`,
  `tests/resource-accounting.test.ts`

**Geometry contract:**

- [ ] Extend worker results with child-local `coarsePosition` and `coarseNormal`
  attributes. Roots use their fine values.
- [ ] For each child interior vertex, reconstruct the exact parent grid and barycentric
  parent-triangle surface using the same tan-warp, evaluator, normal sampling, and
  launchpad-clearance correction. Do not merely resample height at a snapped UV.
- [ ] Define skirt behavior separately. Child interior edges morph to the parent;
  skirts remain conservative crack covers and are never raised above either valid
  surface.
- [ ] Transfer and install the new attributes, include both fine and coarse extents in
  bounds, and update estimated/actual geometry byte accounting and residency tests.
- [ ] Inject morphing after the base color material's vertex hook and into custom depth
  and distance materials. Children use transition progress; parents remain at their
  true geometry. Split goes coarse→fine and merge reverses continuously.
- [ ] Blend normals with the same progress. Keep body-direction/global identity stable;
  the complementary dither remains during overlap to hide residual material identity
  differences.
- [ ] Preserve transition serialization, reversal, pressure duration, coverage,
  protection, and disposal behavior.

**Required tests:** child equals parent surface at progress zero, child equals fine
surface at one, midpoint continuity, split/merge reversal, all cube seams, launchpad
clearance, skirts, bounds, color/depth/distance uniform parity, context rebuild, and
no resource-budget undercount.

**Done when:** the exact reproduced geometry pop is absent without weakening SSE,
hysteresis, or coverage guarantees. Do not describe pops as “impossible by
construction”; retain the visual diagnostic gate.

### Task 14: Resolve any compact/terrain handoff defect without conflating it with LOD

**Files:**

- Possible: `src/render/coverageTransition.ts`
- Possible: `src/render/terrestrialBodyRenderer.ts`
- Possible: `src/render/terrainPresentation.ts`
- Modify tests: `tests/coverage-transition.test.ts`,
  `tests/terrestrial-body-renderer.test.ts`, `tests/ocean-cap.test.ts`

**Work:**

- [ ] Preserve compact coverage until streamed coverage is ready.
- [ ] Evaluate silhouette/depth behavior with opaque terrain, camera-anchored ocean,
  transparent compact mesh, and aerial perspective active.
- [ ] If opacity blending exposes silhouette holes, use an evidence-backed depth-first
  handoff or bounded coverage mesh; do not reuse parent/child dither terminology.
- [ ] Verify approach, retreat, rapid reversal, SOI loss, quality replacement, failed
  candidate retention, and ocean/non-ocean bodies.

## Phase E — Palla and the Airless Renderer

### Task 15: Add authoritative Palla crater and landmark content

**Files:**

- Create: `scripts/lib/palla-craters.ts`
- Create generated: `src/generated/palla-craters.json`
- Create generated: `assets/planets/generated/palla/canonical/craters.json`
- Modify: `src/sim/terrainRecipe.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `scripts/validate-content.mjs`
- Modify: `assets/planets/recipes.json`
- Modify: `assets/planets/manifest.json`
- Modify: `assets/planets/compiler-output.json`
- Modify: `src/generated/checked-planet-manifest.json`
- Modify tests: `tests/terrain-authority.test.ts`, `tests/terrain-worker.test.ts`,
  `tests/content-validator.test.ts`, `tests/palla-mission.test.ts`
- Create: `tests/palla-craters.test.ts`

**Authority contract:**

- The checked crater artifact contains sorted deterministic crater records, named
  landmark IDs, center direction, angular radius, depth, rim height, ejecta radius,
  and stable seed.
- `recipeForBody(palla)` imports those records and builds a compact cube-face cell
  index represented by offsets and crater indices. `evaluateRecipeHeight` checks only
  the relevant cells and remains the single runtime/worker/contact evaluator.
- The Palla recipe version and content hash change. Save migration follows the
  existing recipe-migration contract; no save silently keeps the old height identity.

**Work:**

- [ ] Generate a bounded distribution with explicit minimum separation for named
  landmarks and deterministic overlap rules for secondary craters.
- [ ] Validate centers, finite bounds, sorted uniqueness, index coverage, and that
  every crater influences its center/rim/ejecta fixtures.
- [ ] Compile Palla global normal/material channels from the authoritative runtime
  recipe rather than the unrelated LOLA height raster. Keep the reviewed LRO albedo
  source only as art input and update provenance text accordingly.
- [ ] Generate Low, Medium, and High Palla packs. Add a checksum-pinned fetch path for
  ignored NASA airless authoring sources; a clean production build still performs no
  network access.
- [ ] Confirm landing/contact, worker vertices, compact normals, and landmark tests all
  resolve the same crater recipe.

### Task 16: Implement the reusable `AirlessBodyRenderer`

**Files:**

- Create: `src/render/airlessBodyRenderer.ts`
- Create: `src/render/airless/surfaceMaterial.ts`
- Modify: `src/render/airless/globalMaterial.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/terrestrial/globalGeometry.ts` or create a body-aware compact
  geometry helper
- Modify: `src/ui/mapView.ts`
- Test: `tests/airless-body-renderer.test.ts`
- Modify tests: `tests/airless-global-maps.test.ts`, `tests/body-material.test.ts`,
  `tests/map-material.test.ts`, `tests/renderer-transaction.test.ts`

**Renderer contract:**

- [ ] `stageAssets(null)` builds procedural compact and terrain materials from the
  descriptor palette. A valid pack atomically replaces them; missing channels throw
  during candidate staging and retain the prior committed renderer.
- [ ] Compact geometry is body-aware and displaced from the same terrain recipe enough
  to preserve large craters/irregular silhouettes. Near terrain remains
  `PlanetRenderer` worker geometry.
- [ ] Compact and terrain sample identical body-fixed authored maps when present.
  Near terrain adds regolith detail with the same alias controls as Veyra but no
  atmosphere, ocean, or clouds.
- [ ] Replace the fixed 0.28 normal blend with footprint-aware absolute/tangent-space
  composition. Preserve hard terminators and low neutral ambient.
- [ ] Visual boulders/ejecta use crater and slope masks. They remain non-colliding in
  this rendering pass.
- [ ] Stats, resource allocation, quality replacement, pack borrowing, context
  restoration, root visibility, coverage transition, and disposal mirror the
  terrestrial lifecycle.
- [ ] MapView uses the same compact material/shape identity without loading terrain.

**Palla activation gate:** assign only Palla to `renderer: 'airless'` first. Run orbit,
low-orbit, landing, surface, ascent, day, and night views before using the renderer for
another body.

**Focused verification:**

```bash
npx vitest run tests/airless-body-renderer.test.ts tests/airless-global-maps.test.ts tests/palla-craters.test.ts tests/palla-mission.test.ts tests/renderer-transaction.test.ts tests/map-material.test.ts
npm run validate:content
npm run typecheck
npm run build
```

## Phase F — Tyran Gas Giant

### Task 17: Implement `GasGiantBodyRenderer`

**Files:**

- Create: `src/render/gasGiantBodyRenderer.ts`
- Create: `src/render/gasGiant/material.ts`
- Create: `src/render/gasGiant/storms.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/ui/mapView.ts`
- Test: `tests/gas-giant-renderer.test.ts`
- Modify tests: `tests/gas-body.test.ts`, `tests/body-material.test.ts`,
  `tests/map-material.test.ts`, `tests/renderer-transaction.test.ts`

**Renderer design:**

- An opaque front-facing band sphere owns external body identity above the reference
  radius. A transparent back-facing atmosphere-volume shell owns limb haze and
  inside-atmosphere depth.
- When the camera descends below the band sphere, the opaque sphere is hidden and the
  volume shell continues rendering; the camera is never trapped inside an opaque
  rocky surface.
- Latitude bands are body-fixed functions with configured differential drift.
  Persistent storms come from a deterministic seeded catalog and retain identity
  across frames, quality changes, and context restoration.
- The volume ray interval terminates at the deep core or outer shell as appropriate.
  It remains finite through the reference radius and down to the existing terminal
  pressure/depth destruction boundaries.

**Work:**

- [ ] Add explicit gas variant parameters: band palette/widths, drift rates, storm
  records, limb coefficients, volume samples, reference/deep opacity, and quality
  limits.
- [ ] Use camera-relative/body-fixed transforms from `BodyRenderFrame`; do not create a
  terrain engine, ocean, contact surface, or solid coverage transition.
- [ ] Activate gas atmosphere environment state through `isFlightFocus`, including
  vessel aerial perspective and sky lighting during a probe descent.
- [ ] Support `stageAssets(null)` as the production path and reject unrelated packs
  transactionally.
- [ ] Report geometry/material/LUT bytes and dispose all resources once.
- [ ] Assign Tyran only after external orbit, atmosphere-boundary, reference-radius,
  and terminal-descent visual fixtures pass.

**Required tests:** deterministic storms, differential band motion without temporal
noise, exterior/interior visibility, finite ray intervals, terminal-boundary visual
continuity, no terrain allocation, factory fallback, quality replacement, context
restore, disposal, and unchanged gas physics/save behavior.

## Phase G — Remaining System Bodies

### Task 18: Adapt Wisp as the first remaining airless variant

**Files:**

- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Modify generated Wisp packs and checked metadata
- Modify tests: `tests/body-material.test.ts`, `tests/airless-body-renderer.test.ts`,
  `tests/map-material.test.ts`, `tests/content-validator.test.ts`

**Work:**

- [ ] Add explicit airless variant parameters for regolith tint, roughness, detail
  strength, emissive strength, boulder density, and compact displacement—not body-ID
  branches in shaders.
- [ ] Generate Low and High packs so all supported tiers have authored coverage.
- [ ] Preserve Wisp's procedurally authoritative height in global normal/material
  compilation; authored Bennu albedo remains art input only.
- [ ] Assign Wisp only after Tyran passes. Verify its irregular silhouette, very low
  altitude transition, pack/no-pack fallback, and MapView identity.

### Task 19: Generalize terrestrial configuration, then migrate Vess and Rusk

**Files:**

- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrestrial/ocean.ts`
- Modify: `src/render/terrestrial/cloudLayer.ts`
- Modify: `src/render/terrestrial/cloudMaterial.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify tests: `tests/body-material.test.ts`, `tests/terrestrial-body-renderer.test.ts`,
  `tests/veyra-clouds.test.ts`, `tests/renderer-transaction.test.ts`,
  `tests/map-material.test.ts`

**Configuration contract:** a discriminated terrestrial visual definition declares
atmosphere tint/strength, optional ocean, zero-to-two cloud layers, authored channel
requirements, procedural-cloud seed, surface palette/detail response, ambient ground
bounce, and shadow policy. The renderer contains no `body.id === 'vess'|'rusk'`
material branches.

**Work:**

- [ ] Make ocean ownership optional. A no-ocean body neither constructs nor disposes
  `TerrestrialOcean`, and its terrain classification never invents a shore mask.
- [ ] Make cloud layers data-driven. When no cloud map exists, use deterministic
  shader/procedural coverage rather than a black one-pixel texture or the legacy 512 px
  canvas.
- [ ] Make atmosphere visual data required by the terrestrial variant schema and add
  explicit definitions for Vess and Rusk.
- [ ] Define Vess as dense amber atmosphere with opaque cloud identity and no ocean.
  Define Rusk as thin arid atmosphere with dust/haze and no ocean.
- [ ] Preserve procedural pack-null coverage at every tier. Do not require authored
  maps merely to activate a renderer.
- [ ] Assign and gate Vess first, then Rusk. Verify entry, low flight, surface, night,
  MapView, quality replacement, context restoration, and legacy fallback.

### Task 20: Migrate the remaining airless variants

**Bodies:** Ashen, Brimm, Glacia, Mote, Farfall.

**Files:**

- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/bodyMaterial.ts`
- Modify: `src/render/airless/globalMaterial.ts`
- Modify: `src/render/airless/surfaceMaterial.ts`
- Modify: `src/render/airlessBodyRenderer.ts`
- Modify: `src/ui/mapView.ts`
- Modify tests: `tests/body-material.test.ts`, `tests/airless-body-renderer.test.ts`,
  `tests/map-material.test.ts`, `tests/content-validator.test.ts`

**Variants:**

- Ashen: scorched, high-roughness basins and glassy highlights.
- Glacia: ice/regolith palette with smoother exposed ice and no fake atmosphere.
- Brimm: lava/emissive cracks driven by a body-fixed procedural mask; emissive output
  is bounded and participates in tone mapping but not collision.
- Mote and Farfall: body-aware displaced compact geometry and irregular regolith
  response appropriate to their radius/terrain amplitude.

**Work:**

- [ ] Add data parameters and validation before assignments. Avoid adding one shader
  program per body when one variant define/uniform path is sufficient.
- [ ] Activate one body at a time and keep the prior body green.
- [ ] For each body verify orbit identity, closest valid approach, surface, day/night,
  pack-null fallback, MapView parity, resource budget, and no simulation change.
- [ ] Keep `LegacyBodyRenderer` as an explicit recoverable fallback after all
  assignments; do not delete it in this pass.

### Task 21: Make factory and initial-renderer fallback truthful

**Files:**

- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/renderFailures.ts`
- Modify tests: `tests/body-renderer.test.ts`, `tests/renderer-transaction.test.ts`,
  `tests/context-lifecycle.test.ts`

**Work:**

- [ ] Wrap initial assigned-renderer construction in a diagnostic fallback boundary.
  If terrestrial, airless, or gas construction fails before a committed renderer
  exists, construct a legacy candidate and record the assigned kind and failure phase.
- [ ] During replacement, retain the existing committed renderer on factory, staging,
  compile, coverage, or budget failure. Do not silently swap to legacy when usable
  committed coverage already exists.
- [ ] Deduplicate failure logs by body/tier/kind/phase and expose fallback state in
  renderer stats.
- [ ] Verify context restoration retries the assigned renderer while retaining the
  last committed fallback if the retry fails.

## Phase H — System Verification and Documentation

### Task 22: Add reproducible body visual fixtures and acceptance criteria

**Files:**

- Create: `e2e/body-renderer-gallery.spec.ts`
- Create: `e2e/helpers/bodyRenderFixture.ts`
- Create: `e2e/baselines/planets/visual-thresholds.json` after calibration
- Modify: `e2e/game-loop.spec.ts`
- Modify: `e2e/veyra-render-diagnostics.spec.ts`

**Stations:**

- Every body: distant orbit and MapView identity.
- Solid bodies: low orbit, low flight, surface, day, and night.
- Veyra/Vess/Rusk: atmosphere boundary and ground haze.
- Palla: named crater orbit/surface pair.
- Tyran: distant, limb, atmosphere top, reference radius, and valid deepest approach.

**Acceptance criteria:**

- Veyra 100–500 m views contain stable sub-global-texel detail without shimmer or
  texture swimming.
- Terrain geometry normals remain visible near the ground; global normals dominate
  only when their footprint is appropriate.
- Opaque ground and vessels receive coherent distance haze; stars and additive
  effects do not.
- Medium/High pad and vessel shadows are stable and quality-gated.
- No reproduced square boundary, compact flash, LOD pop, or radial cloud line remains.
- Palla's named craters agree between collision terrain, worker geometry, compact
  normals, and surface views.
- Tyran never presents a landable rocky surface.
- All twelve bodies are visually distinguishable and have explicit renderer/variant
  assignments or the Auren star renderer.

Calibrate thresholds from repeated clean captures and seeded defects as required by
the approved design. Human review remains the authority for “fake/flat/blurry”; image
thresholds guard regression after approval.

### Task 23: Run the final repository and short performance gate

**Commands:**

```bash
npm run validate:content
npm run typecheck
npm test
npm run build
npx playwright test e2e/terrain-proto.spec.ts e2e/veyra-pad-stationary.spec.ts e2e/veyra-render-diagnostics.spec.ts e2e/game-loop.spec.ts e2e/body-renderer-gallery.spec.ts --project=chromium
git diff --check
```

**Performance work:**

- [ ] Repeat the Phase 0 machine/browser conditions.
- [ ] Report before/after p50/p95 for GPU submission, draw calls, triangles, terrain
  CPU timings, texture bytes, geometry bytes, instance bytes, atmosphere cost, and
  shadow bytes.
- [ ] Treat current acceptable performance as a regression guard, not permission to
  omit measurement.
- [ ] If Medium regresses beyond the approved budget, reduce only in spec order:
  cloud shadows, atmosphere samples, second cloud scale, visual scatter, ocean
  glitter. Never reduce terrain/contact authority.

### Task 24: Update truthful project documentation

**Files:**

- Modify: `RENDERING.md`
- Modify: `STATUS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PERFORMANCE.md`
- Modify: `CONTENT_PIPELINE.md`
- Modify: `LICENSES.md` if airless source usage/provenance changes

**Work:**

- [ ] Describe the shipped aerial-perspective approximation accurately; do not call it
  a complete Hillaire pipeline.
- [ ] Distinguish visual surface integration from deferred physical obstacles.
- [ ] List actual active renderer assignments and supported pack tiers.
- [ ] Record shadow policy, atmosphere fallbacks, variant schema, asset provenance,
  visual fixture procedure, and current measured costs.
- [ ] Leave M3 Max full-duration hardware certification marked deferred until it is
  actually run and passes.

## Milestone Gates

### Veyra gate

Tasks 1–14 are complete, the exact baseline journey is cleaner on Medium and High,
surface detail/normal/aerial/shadow acceptance criteria pass, and any artifact fix is
backed by reproduced evidence.

### Palla gate

Tasks 15–16 are complete. Authoritative craters agree across simulation and rendering,
all tiers have a valid fallback, and the Palla round-trip remains green.

### Tyran gate

Task 17 is complete. Exterior and deep-atmosphere views are stable and all non-landable
gas contracts remain green.

### System gate

Tasks 18–24 are complete. Every body has an explicit active renderer and
variant, MapView parity, a supported-view fixture, resource accounting, fallback
coverage, and current documentation.

### Release gate

This implementation plan alone does not satisfy release certification. Run the
approved full-duration M3 Max Medium and Low protocol only after the system gate and
final code review. Record hardware, OS, browser, driver, power state, valid GPU-query
coverage, and all specified percentiles before changing the project status to
release-ready.
