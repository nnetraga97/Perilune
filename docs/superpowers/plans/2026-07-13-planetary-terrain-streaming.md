# Shared Planetary Terrain Streaming Implementation Plan

**Date:** 2026-07-13

**Status:** Ready for user review; implementation not started

**Design source:** `docs/superpowers/specs/2026-07-13-planetary-terrain-streaming-design.md`

## Goal

Replace the current monolithic `PlanetRenderer` traversal with the approved shared planetary terrain engine. The implementation must preserve complete installed coverage under loading, failure, and resource pressure; select detail from screen-space error; transition parent/four-child sets without hard square pops; and pass the existing Veyra Medium and High production-game journeys.

Veyra is the first production certification target. Engine code must remain body-agnostic and must be proven with synthetic providers using different radii and terrain bounds.

## Implementation Boundaries

- Use the normal repository workflow. Per the user's direction, do not use Superpowers for implementation or implementation-plan execution. Superpowers may be used only for the requested final review.
- Do not change authoritative terrain height, flight physics, atmosphere, ocean, cloud geometry/materials, scatter behavior, orbital rails, MapView, or authored texture contents.
- Do not treat the cloud radial-line defect as part of this terrain implementation.
- Preserve the compact sphere as the global far-field presentation. Once detailed terrain has reached its stable `terrain` presentation, ordinary tile churn may not return presentation to compact.
- Preserve the current camera-relative transform and body-fixed f64 chunk origin model.
- Preserve the user's unrelated `.gitignore` modification and untracked `vercel.json`.
- Keep every task independently testable and commit only the files listed for that task.
- Do not add production checks for the string `veyra` under `src/render/terrain/` or the shared engine path.
- Do not delete the old traversal until all direct callers use the compatibility facade backed by the new engine and focused tests pass.

## Target Module Layout

The 907-line `src/render/planet.ts` becomes a compatibility facade and legacy-ocean owner. Terrain responsibilities move into focused modules:

```text
src/render/terrain/
  tile.ts                 integer identity, descriptors, cube-face topology
  surfaceProvider.ts      provider contract and Body-backed provider
  terrainPolicy.ts        tier SSE, timing, work, and byte policies
  terrainSelection.ts     SSE traversal and restricted-quadtree balancing
  coverageResolver.ts     renderability and previous-frame coverage
  lodTransition.ts        parent/four-child transition state
  lodDither.ts             shared color/depth/shadow discard integration
  terrainScheduler.ts     priority, reservation, cancellation, and retry
  terrainResidency.ts     protection sets and byte-based trimming
  planetTerrainEngine.ts  ordered frame orchestration and Three.js meshes
```

`chunkGeometry.ts`, `chunkWorker.ts`, and `chunkWorkerPool.ts` remain the worker boundary. Their request identity and scheduling behavior change, but the deterministic terrain evaluator and geometry buffer layout stay authoritative.

## Planned Core Contracts

### Integer tile identity

```ts
interface TerrainTileId {
  readonly face: 0 | 1 | 2 | 3 | 4 | 5;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
}

type TerrainTileKey = `${number}/${number}/${number}/${number}`;
```

All parent, child, UV, and neighbor operations derive from integer coordinates. Floating UV strings remain accepted only at the temporary compatibility boundary for old diagnostic artifacts.

### Terrain frame input

```ts
interface PlanetTerrainFrame {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly verticalFovRadians: number;
  readonly drawingBufferHeight: number;
  readonly deltaSeconds: number;
  readonly framePressure: boolean;
  readonly generation: number;
}
```

### Provider and recipe bounds

The Body-backed provider uses one immutable worker snapshot and exports no live `Body` object. `terrainRecipe.ts` supplies conservative finite bounds:

```ts
interface TerrainRecipeBounds {
  readonly minimumHeightMeters: number;
  readonly maximumHeightMeters: number;
  readonly maximumAngularSlopeMeters: number;
}
```

The bounds are derived from documented value and gradient upper bounds for the finite `noise3`, `fbm3`, and `ridged3` expressions, their frequencies and octave counts, amplitude, ocean offset, and crater metadata. They are not measured from a Veyra sample grid or tuned by body ID.

For a tile sampling cell with conservative angular diagonal `theta`, the provider's initial positional-error bound is:

```text
curvatureError = (radius + maxAbsHeight) * (1 - cos(theta))
heightError = maximumAngularSlopeMeters * theta
geometricError = curvatureError + heightError
```

`theta` uses the cube-face angular span, tile depth, and tier grid resolution. The provider validates that the resulting depth table is finite, nonnegative, and monotonically non-increasing before the renderer candidate becomes ready.

### Resource allocation

The checked manifest's active-body GPU budget is the outer limit. For a staged terrestrial renderer:

```text
terrainAllocation = activeBodyGpuBudget
  - committedTextureBytes
  - compact/ocean/atmosphere/cloud fixed geometry bytes
  - scatter/effect resident buffer bytes
```

The terrain engine receives the nonnegative result. It evicts toward 75% of that allocation and refuses new reservations beyond 100%. Fixed charges are calculated from actual buffers through `resourceAccounting.ts`; they are not duplicated in the terrain ledger.

---

### Task 1: Integer Tile Identity and Cross-Face Topology

**Files:**

- Create: `src/render/terrain/tile.ts`
- Create: `tests/terrain-tile.test.ts`

**Deliverables:**

- [ ] Define validated `TerrainTileId`, stable key encoding/decoding, root IDs, parent IDs, four ordered children, and UV bounds.
- [ ] Reject non-integer, negative, out-of-range, or depth-inconsistent coordinates at public construction boundaries.
- [ ] Define the six cube faces and one explicit edge-orientation table used by both geometry and neighbor lookup.
- [ ] Implement same-face and cross-face edge-neighbor transforms without floating-point key reconstruction.
- [ ] Test every face, every edge, depths 0 through at least 6, reciprocal neighbor lookup, orientation reversal, corner adjacency, and parent/child round trips.
- [ ] Add a property-style loop proving every valid edge neighbor maps back to the original tile and preserves depth.
- [ ] Run `npx vitest run tests/terrain-tile.test.ts && npm run typecheck`.
- [ ] Commit Task 1 files with `feat: add integer terrain tile topology`.

### Task 2: Body-Agnostic Surface Provider and Conservative Error Metadata

**Files:**

- Create: `src/render/terrain/surfaceProvider.ts`
- Modify: `src/core/noise.ts`
- Modify: `src/sim/terrainRecipe.ts`
- Modify: `src/render/terrain/chunkGeometry.ts`
- Modify: `src/render/terrain/chunkWorker.ts`
- Create: `tests/terrain-surface-provider.test.ts`
- Modify: `tests/terrain-authority.test.ts`
- Modify: `tests/terrain-worker.test.ts`

**Deliverables:**

- [ ] Export documented conservative `noise3` value/gradient bounds and compose them for finite fBm/ridged octave sets.
- [ ] Implement `terrainRecipeBounds` including terrain amplitude, frequency, finite octave contributions, ocean offset, and crater depth/rim bounds.
- [ ] Define `PlanetSurfaceProvider`, `TerrainTileDescriptor`, immutable `TerrainBuildSnapshot`, and provider validation.
- [ ] Implement a Body-backed provider using `recipeForBody` and `buildTerrainChunkGeometry`; the shared engine sees only provider contracts.
- [ ] Move face projection authority to `tile.ts`/the provider so geometry generation and topology cannot drift.
- [ ] Change worker request identity to integer tile key plus derived UV bounds. Keep the resulting buffer layout and terrain samples deterministic.
- [ ] Generate and validate the per-depth geometric-error table from recipe bounds, radius, grid resolution, and maximum depth.
- [ ] Test flat terrain, nonzero procedural terrain, craters, small and large radii, invalid metadata, monotonicity, structured-clone safety, shared-edge equality, and exact agreement with `evaluateRecipeHeight`.
- [ ] Prove the provider contains no body-specific branch and a synthetic provider can use the same contract.
- [ ] Run `npx vitest run tests/terrain-surface-provider.test.ts tests/terrain-authority.test.ts tests/terrain-worker.test.ts && npm run typecheck`.
- [ ] Commit Task 2 files with `feat: add planetary surface provider`.

### Task 3: Frame Projection and Screen-Space-Error Policy

**Files:**

- Create: `src/render/terrain/terrainPolicy.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/legacyBodyRenderer.ts`
- Modify: `src/proto/feasibilityScene.ts`
- Modify: `src/proto/terrainProto.ts`
- Create: `tests/terrain-selection.test.ts`
- Modify: `tests/body-renderer.test.ts`
- Modify: `tests/terrestrial-body-renderer.test.ts`
- Modify: `tests/release-blockers.test.ts`

**Deliverables:**

- [ ] Define immutable Low/Medium/High policies with the approved 4.0/2.5/1.5 px split limits and 2.8/1.75/1.05 px merge limits.
- [ ] Include grid resolution, maximum depth, submission/install time limits, worker count inputs, transition durations, and terrain byte-policy ratios in the same tier policy.
- [ ] Extend `BodyRenderFrame` with vertical FOV radians and physical drawing-buffer height.
- [ ] Populate these values once per `WorldScene` frame from the actual `PerspectiveCamera` and `WebGLRenderer.getDrawingBufferSize`, not CSS dimensions.
- [ ] Update legacy/prototype direct callers to pass their real camera projection values at the compatibility boundary.
- [ ] Implement the approved SSE formula against displacement-aware bounding volumes and validate every numeric input.
- [ ] Preserve split state in a small hysteresis map: split above maximum, merge below merge threshold, retain state inside the band.
- [ ] Test proportional changes for FOV, drawing-buffer height, geometric error, distance, device pixel ratio, all tiers, boundary equality, and hysteresis oscillation.
- [ ] Run `npx vitest run tests/terrain-selection.test.ts tests/body-renderer.test.ts tests/terrestrial-body-renderer.test.ts tests/release-blockers.test.ts && npm run typecheck`.
- [ ] Commit Task 3 files with `feat: select terrain detail by screen error`.

### Task 4: Prioritized Scheduler, Item Cancellation, and Retry

**Files:**

- Create: `src/render/terrain/terrainScheduler.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`
- Create: `tests/terrain-scheduler.test.ts`
- Modify: `tests/terrain-worker.test.ts`

**Deliverables:**

- [ ] Introduce the ordered queue classes `coverage`, `continuity`, `visible`, `predicted`, and `background`.
- [ ] Keep priority inputs primitive: visibility, SSE, view-center distance, depth, request age, and stable tile key tie-breaker.
- [ ] Make the scheduler own queued work; submit to the pool only when an executor slot is available so the pool does not hide an unprioritized backlog.
- [ ] Add item cancellation for queued predicted/background work and generation cancellation for renderer replacement/disposal.
- [ ] Track `queued`, `building`, `completed`, `failed`, and retry timestamps without resolving the same logical request twice.
- [ ] Reserve estimated geometry bytes before dispatch and release the reservation on cancellation, failure, discard, or installation ownership transfer.
- [ ] Implement retry delays of 0.25, 0.5, 1, and 2 wall-clock seconds while a tile remains requested; reset retry state on generation change or successful install.
- [ ] Keep bounded worker respawn behavior and stale completion rejection.
- [ ] Test strict queue order, deterministic tie-breaking, within-queue age promotion, no cross-class starvation promotion, item/generation cancellation, retry timing, worker crash/respawn, and byte-reservation release.
- [ ] Run `npx vitest run tests/terrain-scheduler.test.ts tests/terrain-worker.test.ts && npm run typecheck`.
- [ ] Commit Task 4 files with `feat: prioritize terrain generation work`.

### Task 5: Byte-Based Residency and Protected Coverage

**Files:**

- Create: `src/render/terrain/terrainResidency.ts`
- Modify: `src/render/resourceAccounting.ts`
- Modify: `src/render/bodyRendererManager.ts`
- Create: `tests/terrain-residency.test.ts`
- Modify: `tests/resource-accounting.test.ts`
- Modify: `tests/renderer-transaction.test.ts`

**Deliverables:**

- [ ] Expose the tier active-body budget from `RendererResourceLedger` without allowing the terrain engine to mutate transaction ownership.
- [ ] Add pure accounting for committed textures, fixed terrestrial passes, scatter/effects, installed terrain bytes, and reserved terrain bytes.
- [ ] Implement a terrain allocation with a 75% soft target and 100% hard reservation limit.
- [ ] Track actual installed geometry bytes from all attributes and indices; remove chunk-count eviction as a policy input.
- [ ] Protect roots, current render set, previous-frame continuity, fallbacks, active transition source/destination, and submitted coverage reservations.
- [ ] Trim unprotected least-recently-used entries only after the frame's coverage and protection sets are finalized.
- [ ] Refuse new refinement reservations above the allocation; permit only an underestimated completed coverage blocker to cross it temporarily, then pause refinement and shed unprotected bytes.
- [ ] Discard an underestimated prediction/background result that would overflow.
- [ ] Test exact-boundary reservations, cancellation release, soft overflow from protected coverage, hard refusal, underestimated blocker recovery, prediction discard, roots larger than the soft target, and zero/negative remaining allocations.
- [ ] Run `npx vitest run tests/terrain-residency.test.ts tests/resource-accounting.test.ts tests/renderer-transaction.test.ts && npm run typecheck`.
- [ ] Commit Task 5 files with `feat: protect terrain residency by byte budget`.

### Task 6: Desired Traversal and Restricted-Quadtree Balancing

**Files:**

- Create: `src/render/terrain/terrainSelection.ts`
- Modify: `tests/terrain-selection.test.ts`
- Modify: `tests/terrain-tile.test.ts`

**Deliverables:**

- [ ] Implement a pure desired-detail traversal using provider descriptors, SSE hysteresis, maximum depth, frustum culling, and conservative spherical-horizon culling.
- [ ] Traverse current view near-to-far and return selection reasons plus requests; do not inspect Three.js meshes or mutate residency.
- [ ] Run a separate predicted traversal at 0.5 wall-clock seconds using body-fixed velocity. Prediction creates requests only.
- [ ] Balance selected leaves until every edge-adjacent pair differs by no more than one level, including all cross-face edges.
- [ ] When balancing cannot refine because geometry or budget is unavailable, coarsen to a complete valid selection rather than emitting an illegal edge.
- [ ] Keep the operation deterministic for identical frame/provider/previous-state inputs.
- [ ] Test flat and procedural providers, all cube faces, mixed depths, horizon crossings, frustum boundaries, maximum depth, prediction-only requests, balancing convergence, and cross-face 2:1 invariants.
- [ ] Run `npx vitest run tests/terrain-selection.test.ts tests/terrain-tile.test.ts && npm run typecheck`.
- [ ] Commit Task 6 files with `feat: balance planetary terrain selection`.

### Task 7: Renderability Graph and Coverage Resolver

**Files:**

- Create: `src/render/terrain/coverageResolver.ts`
- Create: `tests/terrain-coverage-resolver.test.ts`

**Deliverables:**

- [ ] Define the explicit tile lifecycle `unloaded`, `queued`, `building`, `ready`, `installed`, and `failed` independently from frame roles.
- [ ] Require current generation, committed material ownership, and valid GPU geometry before a tile is renderable.
- [ ] Resolve desired leaves recursively from all six roots against installed state.
- [ ] Render a complete desired descendant set only when every visible quadrant is covered; otherwise use the nearest renderable ancestor.
- [ ] Preserve still-visible previous-frame descendants when collapsing directly to an ancestor would cause avoidable severe detail loss and request the missing intermediate fallback.
- [ ] Require all four immediate children before starting a split, even when one is horizon-culled; allow deeper stand-ins only for a completely covered quadrant.
- [ ] Produce explicit render, request, fallback, continuity, and protection sets plus machine-readable reasons.
- [ ] Make the six roots lifetime-protected after initial root readiness and prove no resolver path returns partial coverage.
- [ ] Test every mixed lifecycle state, missing child quadrant, failed child, stale generation, deeper stand-in, previous-frame continuity, root readiness, and complete-coverage invariant.
- [ ] Run `npx vitest run tests/terrain-coverage-resolver.test.ts && npm run typecheck`.
- [ ] Commit Task 7 files with `feat: resolve complete terrain coverage`.

### Task 8: Reversible LOD Transitions and Complementary Dither

**Files:**

- Create: `src/render/terrain/lodTransition.ts`
- Create: `src/render/terrain/lodDither.ts`
- Create: `tests/terrain-lod-transition.test.ts`
- Create: `tests/terrain-lod-dither.test.ts`
- Modify: `src/render/terrestrial/surfaceMaterial.ts`

**Deliverables:**

- [ ] Model one transition as one parent plus its complete four-child destination, a stable ID, direction, progress, start time, and release-frame marker.
- [ ] Start only when both source and destination are renderable and protected.
- [ ] Advance by wall-clock delta over 0.35 seconds normally or 0.2 seconds under sustained frame pressure; loading time contributes zero.
- [ ] Reverse from current progress when desired direction changes and serialize nested transitions on the same branch.
- [ ] Retain the completed source for one submitted frame before releasing its protection.
- [ ] Install one shared-material per-draw binding so each mesh supplies transition role/progress without cloning authored textures.
- [ ] Use the same stable `gl_FragCoord` stochastic predicate and exact complement for parent and children.
- [ ] Apply the predicate to color, custom depth, and custom distance/shadow passes; verify program cache keys include the transition feature.
- [ ] Test split, merge, reversal, pressure duration, no loading-time advance, nested serialization, one-frame release, shared material behavior, exact predicate complement, and stable screen-space noise source.
- [ ] Run `npx vitest run tests/terrain-lod-transition.test.ts tests/terrain-lod-dither.test.ts tests/veyra-global-material.test.ts && npm run typecheck`.
- [ ] Commit Task 8 files with `feat: transition terrain lod continuously`.

### Task 9: Ordered `PlanetTerrainEngine` Orchestration

**Files:**

- Create: `src/render/terrain/planetTerrainEngine.ts`
- Create: `tests/planet-terrain-engine.test.ts`
- Modify: `src/render/terrain/chunkGeometry.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`

**Deliverables:**

- [ ] Implement the approved twelve-phase frame pipeline in the documented order.
- [ ] Own the tile graph, scheduler, installation queue, residency manager, transition manager, meshes, generation, and immutable frame stats.
- [ ] Separate worker completion (`ready`) from GPU installation (`installed`) and enforce an installation-time budget.
- [ ] Build Three.js geometry from worker buffers, attach displacement-aware bounds, local f64 origin, shared material/dither bindings, and camera-relative transforms.
- [ ] Establish all six roots before exposing detailed-terrain readiness, then keep them installed for the engine generation.
- [ ] Apply visibility only after the resolver and transition manager produce one complete render set.
- [ ] Compute protection before trimming residency; assert in tests that eviction is unreachable earlier in the frame.
- [ ] Contain ordinary build/install failures, retain ancestors, and never throw an uncovered frame from `update`.
- [ ] Test initial roots, mixed asynchronous completion order, fast camera reversal, install-budget deferral, stale results, failure retry, context generation replacement, resource pressure, and dispose ownership.
- [ ] Add a long deterministic synthetic flight loop that repeatedly moves from surface to orbit and back under a deliberately small terrain allocation with zero coverage gaps.
- [ ] Run `npx vitest run tests/planet-terrain-engine.test.ts tests/terrain-worker.test.ts && npm run typecheck`.
- [ ] Commit Task 9 files with `feat: orchestrate planetary terrain streaming`.

### Task 10: Renderer Integration and Compatibility-Facade Cutover

**Files:**

- Modify: `src/render/planet.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/legacyBodyRenderer.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/proto/feasibilityScene.ts`
- Modify: `src/proto/terrainProto.ts`
- Modify: `tests/terrain-worker.test.ts`
- Modify: `tests/terrestrial-body-renderer.test.ts`
- Modify: `tests/coverage-transition.test.ts`
- Modify: `tests/veyra-global-material.test.ts`
- Modify: `tests/release-blockers.test.ts`

**Deliverables:**

- [ ] Replace `PlanetRenderer` internals with a thin Body-provider/legacy-ocean facade over `PlanetTerrainEngine`; retain public names only where direct callers still require them.
- [ ] Remove distance `splitFactor`, chunk-count `cacheSize`, floating UV identity, traversal-time requests, and pre-protection LRU eviction.
- [ ] Pass the actual terrain frame projection, generation, material ownership, and calculated terrain allocation from `TerrestrialBodyRenderer`.
- [ ] Keep compact, atmosphere, ocean, clouds, scatter, and effects ownership unchanged.
- [ ] Change global `CoverageTransition` so a continuous terrain request cannot roll back after stable `terrain` presentation because of ordinary streaming state. Leaving the terrain band, renderer replacement, or context loss remains allowed.
- [ ] Preserve atomic quality/renderer transactions and existing procedural fallback behavior.
- [ ] Update legacy renderer and both prototypes to the facade; do not retain a second monolithic terrain implementation.
- [ ] Delete obsolete private traversal/cache code only after all direct imports compile and focused tests pass.
- [ ] Add a source assertion that shared terrain modules contain no `veyra` identity branch.
- [ ] Run `npx vitest run tests/planet-terrain-engine.test.ts tests/terrain-worker.test.ts tests/terrestrial-body-renderer.test.ts tests/coverage-transition.test.ts tests/veyra-global-material.test.ts tests/release-blockers.test.ts && npm run typecheck`.
- [ ] Commit Task 10 files with `refactor: adopt shared planetary terrain engine`.

### Task 11: Diagnostics and Acceptance Assertions

**Files:**

- Modify: `src/render/renderDiagnostics.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Modify: `tests/render-diagnostics.test.ts`
- Modify: `tests/planet-terrain-engine.test.ts`
- Modify: `e2e/helpers/renderDiagnostics.ts`
- Modify: `e2e/veyra-render-diagnostics.spec.ts`

**Deliverables:**

- [ ] Replace diagnostic-only floating chunk reconstruction with integer tile IDs while keeping old recorded strings readable where useful.
- [ ] Record desired/resolved/rendered/previous depths, state-changing SSE, lifecycle, queue class, priority, reservation, retry, protection, eviction, fallback, balance, transition, and compact/terrain presentation events.
- [ ] Add deduplicated anomalies for incomplete root coverage, incomplete branch coverage, protected eviction, reservation violation, 2:1 violation, transition incompleteness, and compact rollback during a continuous terrain request.
- [ ] Keep lightweight diagnostics to state changes/failures and detailed aggregates at 10 Hz; lifecycle batches must remain bounded by the existing recorder.
- [ ] Extend both E2E tiers to assert all approved machine-checkable criteria, including zero coverage gaps/readiness loss, protected eviction, immediate replacement, neighbor violation, reservation violation, and incomplete transition.
- [ ] Add p95 calculations for terrain schedule and installation time and assert each is at most 2 ms on the reference run.
- [ ] Preserve screenshots and JSON traces for every existing ascent/orbit/descent checkpoint.
- [ ] Do not add any cloud-line assertion or alter the flight controller.
- [ ] Run `npx vitest run tests/render-diagnostics.test.ts tests/planet-terrain-engine.test.ts && npm run typecheck`.
- [ ] Commit Task 11 files with `test: certify terrain streaming invariants`.

### Task 12: Full Validation and Veyra Medium/High Visual Review

**Files:**

- Modify only if a validation failure reveals an in-scope terrain defect.
- Store generated evidence under the existing Playwright artifact locations; do not commit transient screenshots/traces unless the user requests it.

**Validation order:**

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run validate:content`.
- [ ] Run all focused terrain/renderer tests from Tasks 1-11 together.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npx playwright test e2e/veyra-render-diagnostics.spec.ts --project=chromium --workers=1`.
- [ ] Run `npm run test:e2e` only after the focused Medium/High journey passes.
- [ ] Compare Medium and High ascent/descent checkpoints and video at normal playback speed against the user's supplied recording.
- [ ] Confirm no compact-sphere flash, hard square replacement, stable square boundary, frame-to-frame dither shimmer, detached transition shadow, or visible terrain seam.
- [ ] Confirm the diagnostic acceptance assertions and 2 ms p95 schedule/install limits pass for both tiers.
- [ ] Run `git diff --check`, inspect the final diff, and verify `.gitignore` and `vercel.json` were not staged.
- [ ] Invoke the user-authorized Superpowers final-review workflow only after all automated and visual gates pass.
- [ ] Commit any final in-scope correction separately with a precise message; do not create a catch-all commit when no correction is needed.

## Hands-Off Decision Policy

Implementation proceeds without intermediate approval prompts. When any of the following gates occurs, choose the safest reversible option that remains inside the approved terrain scope, record the evidence and decision, keep the repository in a testable state, and include the decision in the end-of-work report:

- the analytical terrain bound is so loose that Medium or High requests maximum depth across most of the visible hemisphere;
- the checked active-body budget leaves less space than the six measured root geometries require;
- cross-face 2:1 balance requires changing the cube projection or authoritative terrain sampling;
- shared-material per-draw dither cannot be made identical across color/depth/shadow passes without cloning authored textures;
- the existing E2E craft cannot reproduce both the ascent and descent terrain bands after deterministic test-only timing controls are exhausted; or
- an acceptance failure appears to require cloud, atmosphere, ocean, physics, asset-authoring, or content-manifest changes outside this plan.

Do not silently widen scope. If progress truly requires new authority, destructive action, external coordination, or an out-of-scope subsystem change, preserve completed commits and stop at that hard blocker. Otherwise defer questions and tradeoff review until the implementation and validation pass is complete.

## Completion Definition

This plan is complete only when:

- the old monolithic traversal and chunk-count LRU no longer execute in any production or prototype path;
- the shared provider/engine contains no Veyra identity logic;
- deterministic tests prove coverage, priority, residency, balancing, transitions, failure handling, and multiple provider scales;
- the Veyra Medium and High production journeys satisfy every machine-checkable terrain criterion;
- visual review confirms the compact flash and square LOD pops are absent; and
- typecheck, content validation, build, unit/integration tests, and full Playwright tests pass.
