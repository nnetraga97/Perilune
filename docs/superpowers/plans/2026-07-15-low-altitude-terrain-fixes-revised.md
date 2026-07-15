# Low-Altitude Terrain Fixes — Revised Implementation Plan

**Date:** 2026-07-15

**Status:** Implemented and verified in the isolated worktree

**Supersedes:** The attached `Low-Altitude Terrain Fixes Implementation Plan`

## Implementation Result

- Final Veyra Low/Medium/High balanced covers respect their tier caps in no more than two selection passes.
- The optimized balancer exactly matches a fixed-point reference over 200 seeded randomized covers.
- Stationary production frames reuse selection while installs, scheduling, coverage, transitions, and residency continue.
- Per-chunk color/depth/distance materials carry independent complementary LOD dither state.
- Horizon and exact frustum culling use the finalized smoothed camera and safely unwind culled branches.
- The production ocean is an exact camera-anchored cap with authoritative depth, body-relative shore masking, and logarithmic-depth support.
- Deep-LOD normals use cell-relative sampling and match a finer deterministic reference.
- Verification: 621 unit tests, content validation, typecheck, production build, terrain descent Playwright journey, and the 30-second stationary High-quality Veyra journey all pass.

## Goal

Restore smooth High-quality low-altitude flight and remove visible terrain-layer artifacts without weakening coverage guarantees. The reference target is Veyra at Cape Skyward, but selection, balancing, culling, and transition changes must remain body-agnostic except for the existing launch-site presentation policy.

The work is complete only when all three outcomes are independently demonstrated:

1. low-altitude terrain selection and balancing no longer dominate the main thread;
2. LOD transitions do not draw opaque parent and child surfaces on top of each other;
3. the production-game shoreline has neither a water/terrain gap nor an unintended second surface.

## Worktree and Change-Control Rules

- Keep all work in an isolated worktree. Do not edit `fable-test` or `fable-test-terrain-review`; both are separate worktrees with other work in progress.
- The current isolated worktree is `fable-test-navball-icons` on `codex/navball-icon-refresh`. It already contains uncommitted navball work and terrain prototypes. Before implementation resumes, compare every terrain prototype hunk with this plan and either keep it with tests or remove it. Do not silently treat prototypes as finished work.
- Do not commit or push unless the user asks. The original plan's per-task commit instructions are removed.
- Do not depend on unavailable `superpowers:*` skills or require subagents.
- Preserve unrelated UI changes and the local `node_modules` symlink.

## What Was Wrong in the Original Plan

The original plan has useful root-cause observations, but it is not safe to execute unchanged.

| Original decision | Evaluation | Revised decision |
| --- | --- | --- |
| Stop the four retry rounds first | This removes repeated work but leaves the oversized launch-site selection and one expensive balance pass. | Fix the launch-site/budget contract first, then add a bounded progress guard. |
| Test sizes `1161 -> 1150` as “no progress” | The proposed helper treats any smaller result as progress, so the test and implementation contradict each other. | Define progress explicitly and test the real Veyra case plus exact invocation counts. |
| Force maximum depth within 150 km | 150 km is arbitrary and keeps the expensive island active far outside the pad area. Maximum depth also ignores quality-tier grid resolution. | Start with a measured near-site range (20 km prototype), select a resolution-derived pad target, and make the hard leaf budget authoritative. |
| Use `leaves.length + 3` as the budget | During depth-first traversal this omits unvisited branches. The current prototype selects 675 High leaves against a 640 cap and balancing expands that to 876. | Track planned final leaves, reserve balance headroom, and assert the final balanced cover respects the tier cap. |
| Make balancing “allocation-free” | The proposal still creates string keys during parent-chain probes. | Call it allocation-reduced; cache/pack identities and prove equivalence to the reference algorithm. |
| Skip the entire engine only after all streaming is idle | It misses the expensive backlog period and couples selection reuse to unrelated scheduler state. | Cache selection/balance independently while coverage, installs, scheduling, residency, and transitions continue every frame. |
| Compute frustum planes in the existing body loop | `camera.lookAt(...)` currently occurs after renderer updates, so those planes would describe the previous camera pose. | Finalize the camera pose before body renderer updates, then compute and snapshot body-fixed side planes. |
| Apply one `distance * slackRatio` to all frustum planes | This also expands near/far planes and is not a stable angular margin. | Expand only side-plane coverage using a documented angular pan margin; keep coarse coverage unculled. |
| Replace the ocean immediately | “Two layers” may be transition overlap, compact presentation, ocean depth behavior, or sphere sag. The proposed cap was not proven against the production stack. | Fix dither first, isolate each production layer, then implement a cap only if ocean sag remains visible. |
| Use a placeholder normal test | It does not name a deterministic fixture and may pass or fail depending on sampled terrain. | Add a concrete fixture and compare computed normals to a smaller-epsilon reference. |
| Expect two known staging failures | The stated baseline is stale. The current full run has 598 passing tests and one failure caused by the in-progress dither material-identity change. | Record a fresh clean-HEAD baseline and classify every later failure from that baseline. |

## Measured Evidence to Preserve

The performance audit on High quality found:

- roughly 30 FPS in the user's real browser;
- selection/balancing dominated the sampled main thread, especially `coarserLeafForNeighbor`, `balanceTerrainLeaves`, tile-key construction, and edge-neighbor traversal;
- temporarily disabling launch-site forced detail reduced same-page frame time by about 39%, reduced desired leaves from roughly 765 to 522, and allowed the pending queue to drain;
- disabling the navball made no meaningful frame-time difference;
- the GPU timer was low relative to CPU terrain work, so triangle count is not the primary bottleneck.

These are directional measurements, not portable absolute benchmarks. All before/after acceptance measurements must use the same browser, viewport, quality tier, location, and instrumentation.

## Phase 0 — Establish a Reproducible Baseline

**Files:**

- Modify: terrain diagnostics/stat types only if required for named timing fields
- Create: a reusable non-committed profiling script or a committed focused benchmark if deterministic
- Test: existing unit and Playwright suites

### Work

- [ ] Capture a clean-HEAD baseline separately from the current prototype work. Record commit, browser, viewport, DPR, quality, camera state, and whether the foreground tab was active.
- [ ] Split timing into at least `selectionMs`, `balanceMs`, `coverageMs`, `scheduleMs`, `installMs`, WebGL render time, and HUD time. Do not compare the proto's `sim` label to the full game's broader `render` section.
- [ ] Record p50 and p95 over a 30-second stationary pad sample and a repeatable low-altitude camera-pan sample.
- [ ] Record selected leaves, balanced leaves, rendered leaves, draw calls, pending/building jobs, oldest pending age, installed bytes, and 30-second heap delta.
- [ ] Run `npm test`, `npm run typecheck`, and the relevant terrain Playwright journeys. Re-run any unexpected failure against clean HEAD before labeling it pre-existing.

### Done when

- A single table contains clean-HEAD numbers and the exact reproduction procedure.
- No scratch test such as `tests/__perf-probe.test.ts` is left tracked.

## Phase 1 — Fix the Desired-Cover Contract Before Micro-Optimizing

### Task 1: Make launch-site detail proximity-, resolution-, and budget-aware

**Files:**

- Modify: `src/sim/launchSite.ts`
- Modify: `src/render/terrain/terrainSelection.ts`
- Modify: `src/render/terrain/terrainPolicy.ts` only if the pad target belongs in quality policy
- Test: `tests/terrain-selection.test.ts`

### Work

- [ ] Replace unconditional maximum-depth forcing with a target derived from actual cell size for the active tier. The target must be sufficient for the pad footprint; it does not need to be `provider.maximumDepth` on every tier.
- [ ] Enable the pad target only while the camera is close enough for the worker/scheduler to prewarm it. Use 20 km as the initial measured value, then validate it with a high-speed approach; do not expand it to 150 km without evidence.
- [ ] Replace `leaves.length + 3` with exact planned-leaf accounting that includes unvisited roots/branches.
- [ ] Prioritize the pad target while it is active, but make the final quality-tier cap authoritative. If the pad target and global natural SSE cannot both fit, reduce natural refinement first; if the pad target itself cannot fit, select the deepest target that does fit and emit a diagnostic.
- [ ] Reserve or compute sufficient headroom for restricted-quadtree closure so balancing does not turn a cap-compliant selection into an unbounded cover.

### Required tests

- Real Veyra provider at the pad on Low, Medium, and High.
- Camera just inside and just outside the configured stream distance.
- Camera near the pad, far around the same hemisphere, and at the antipode.
- Exact planned leaves never exceed the selection budget.
- Final balanced leaves never exceed `maximumDesiredLeaves`.
- Pad-region cell size meets the per-tier target when the budget permits.
- Selection remains deterministic for identical input.

### Done when

- High at the pad produces a final balanced cover at or below 640 leaves.
- Moving outside the stream range removes pad-only refinement without holes or a long-lived queue.
- No production selection branch bypasses the leaf budget.

### Task 2: Replace the blind tighten loop with a bounded progress guard

**Files:**

- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Optionally modify: `src/render/terrain/terrainSelection.ts` for a pure helper
- Test: `tests/terrain-selection.test.ts`
- Test: `tests/planet-terrain-engine.test.ts`

### Work

- [ ] Perform one normal select/balance pass.
- [ ] If the final cover exceeds the cap, derive one corrected natural-selection budget from the observed balance expansion and retry once.
- [ ] Adopt a retry only when it produces a strictly smaller valid cover. Stop immediately on equal/larger output or an unchanged budget.
- [ ] Keep the previous valid cover if a retry is invalid or worse.
- [ ] Emit diagnostics when the final cap is unreachable instead of repeating work silently.

### Required tests

- Within-budget selection invokes select and balance once.
- Overshoot followed by a smaller valid cover invokes them twice and adopts the smaller cover.
- Equal or larger retry invokes them twice, stops, and retains the previous valid cover.
- A real Veyra High pad frame completes in no more than two selection passes.
- The contradictory `1161 -> 1150 is no progress` test from the original plan must not be copied.

### Done when

- No frame performs the former five full selection/balance rounds.
- The retry guard is independently tested from the launch-site policy.

## Phase 2 — Remove the Dominant Balancing and Re-selection Cost

### Task 3: Implement an allocation-reduced restricted-quadtree balancer

**Files:**

- Modify: `src/render/terrain/terrainSelection.ts`
- Modify: `src/render/terrain/tile.ts` only if a packed identity is introduced
- Test: `tests/terrain-selection.test.ts`
- Add: a focused benchmark under the repository's existing benchmark convention

### Work

- [ ] Keep the current convergent balancer as a test-only reference implementation.
- [ ] Replace repeated full-map sorted passes with a deterministic work queue of leaves whose neighborhood can change.
- [ ] Avoid constructing new `TerrainTileId` objects and template-string keys on every ancestor probe. Use a packed integer identity where safe, or cache immutable neighbor-ancestor identities per tile descriptor.
- [ ] Requeue only the affected tile, its children, and adjacent leaves after a split.
- [ ] Preserve cube-face seam behavior and deterministic output ordering.
- [ ] Bound work and retain a clear non-convergence diagnostic.

### Required tests

- Existing every-face/every-edge seam tests.
- Randomized valid covers across all faces and depths, comparing the optimized result exactly with the reference result.
- Idempotence: balancing an already balanced cover returns the same keys.
- No neighbor depth difference greater than one.
- Benchmark the real Veyra pad selection and a randomized worst case.

### Done when

- The optimized and reference key sets match for all generated cases.
- High pad balance p95 is below 3 ms on the same reference machine used for baseline.
- The implementation and plan call this “allocation-reduced” unless an allocation profile proves zero allocations.

### Task 4: Cache selection and balance independently of streaming state

**Files:**

- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Modify: `src/render/planet.ts`
- Modify: terrain frame/stats types as needed
- Test: `tests/planet-terrain-engine.test.ts`

### Work

- [ ] Cache the current selection, balanced cover, prediction, and balance diagnostics.
- [ ] Invalidate on provider/material generation, quality, projection size/FOV, meaningful camera translation, meaningful camera rotation/frustum change, or hysteresis state that changes the desired cover.
- [ ] Use a stable view/frustum signature. Do not key reuse on a newly allocated visibility-predicate function reference.
- [ ] Reuse the current selection during stationary/backlogged frames while still draining completed builds, resolving coverage, scheduling requests, advancing transitions, trimming residency, and updating mesh transforms.
- [ ] Recompute predicted detail only when velocity/prediction inputs materially change.
- [ ] Expose whether selection was reused and the selection/balance timings in diagnostics.

### Required tests

- Identical view across several frames runs selection/balance once even while jobs remain queued.
- Completed jobs still install and coverage progresses while selection is reused.
- Translation, rotation, FOV, viewport, quality, generation, and hysteresis changes invalidate the cache.
- Transition progress and residency trimming continue on reused frames.

### Done when

- A stationary pad view reports near-zero selection/balance time after the first valid selection, including while the queue is draining.

## Phase 3 — Fix Transition Correctness

### Task 5: Give each chunk real per-draw dither state

**Files:**

- Modify: `src/render/terrain/lodDither.ts`
- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Modify: `tests/terrain-lod-dither.test.ts`
- Modify: `tests/veyra-global-material.test.ts`
- Modify: `tests/planet-terrain-engine.test.ts` if it asserts shared material identity

### Work

- [ ] Give each chunk distinct color, depth, and distance material instances so Three.js uploads per-chunk transition uniforms.
- [ ] Preserve the base material's `onBeforeCompile`, program cache key, defines, maps, and closure-captured global lighting uniforms.
- [ ] Ensure all chunk clones share the same program cache key per render pass.
- [ ] Dispose chunk-owned materials exactly once when a chunk is removed; keep the injected base material owned/disposed by `PlanetRenderer` according to the existing contract.
- [ ] Update material-ownership tests to assert semantic ownership and shader behavior, not `mesh.material === baseMaterial` identity.

### Required tests

- Parent and child uniforms are independent.
- Parent and child use complementary discard predicates at the same progress.
- Color, depth, and distance passes all receive matching transition state.
- Base shader hooks run on cloned color materials.
- Global lighting uniform updates remain visible to compiled chunk shaders.
- Releasing a chunk disposes only its clones; renderer disposal still disposes the injected base material once.

### Visual gate

- Capture a forced split and merge in a foreground browser. There must be a fine dissolve with no opaque parent/child z-fighting, no whole-planet dissolve, and no shadow double-image.

## Phase 4 — Cull Conservatively Without Breaking Coverage

### Task 6: Add low-altitude horizon culling

**Files:**

- Modify: `src/render/terrain/terrainSelection.ts`
- Test: `tests/terrain-selection.test.ts`

### Work

- [ ] Use the minimum terrain radius as the occluder and maximum terrain radius plus tile bounds as the conservative visible content.
- [ ] Keep coarse roots/base coverage unculled.
- [ ] Handle cameras inside the occluder and bounds containing the camera conservatively.
- [ ] Export the pure predicate for deterministic tests.

### Required tests

- Far-side deep tile culls at 1 m, 1 km, and orbital altitude.
- A peak/tile bound that can cross the horizon remains visible.
- Coarse tiles and a camera below the occluder remain visible.
- No false cull across cube-face seams in a sampled horizon ring.

### Task 7: Finalize the camera before exact frustum selection

**Files:**

- Create: `src/render/terrain/terrainFrustum.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/proto/terrainProto.ts`
- Test: `tests/terrain-frustum.test.ts`
- Test: `tests/planet-terrain-engine.test.ts`

### Work

- [ ] Move/finalize the current frame's camera position, up vector, `lookAt`, smoothing result, and matrix update before body renderer updates.
- [ ] Convert exact camera frustum planes into each body's fixed frame after that finalization.
- [ ] Apply pan margin only to side-plane selection coverage. Do not inflate near/far planes with a distance ratio.
- [ ] Keep coarse coverage unculled and retain enough angular margin for a rapid camera pan.
- [ ] Snapshot frustum values wherever selection caching outlives the synchronous renderer call; do not retain the shared scratch array.
- [ ] Give view changes a stable signature for Task 4 cache invalidation.

### Required tests

- Ahead/behind, each side plane, near/far behavior, body rotation, and translated body origin.
- A sphere inside the documented angular pan margin remains selected; one beyond it culls.
- Camera smoothing produces planes matching the smoothed quaternion, not the unsmoothed target or previous frame.
- A rapid-pan browser journey shows no unrefined hole entering the viewport.

### Task 8: Unwind culled subtrees without exposing holes

**Files:**

- Modify: `src/render/terrain/planetTerrainEngine.ts`
- Test: `tests/planet-terrain-engine.test.ts`

### Work

- [ ] Treat a rendered subtree with no desired ancestor/descendant relationship as orphaned.
- [ ] Merge it quartet-by-quartet when a valid parent cover exists.
- [ ] Drop it directly only when the region is culled, no transition references it, and doing so cannot expose a visible hole.
- [ ] Cancel obsolete queued/building requests for the orphaned region.

### Required tests

- Refine a visible face, turn it out of view, drain the engine, and assert deep rendered chunks and pending work disappear.
- Repeat during an active split and merge transition.
- Coverage remains valid for every still-visible desired region throughout the unwind.

## Phase 5 — Diagnose the Second Layer Before Changing Ocean Geometry

### Task 9: Isolate production presentation layers

**Files:**

- Prefer diagnostics/test controls over production behavior changes
- Test: production renderer journey, not only `?proto=terrain`

### Work

- [ ] Reproduce at the same shoreline/camera with one-at-a-time toggles for streamed terrain, compact sphere, terrestrial ocean, skirts, and LOD transitions.
- [ ] Repeat after Task 5. If the second layer disappears with correct dither, do not rewrite the ocean for that symptom.
- [ ] Capture depth-buffer evidence or wireframe/screenshot evidence identifying which two surfaces overlap.
- [ ] Verify compact-to-terrain presentation does not leave both opaque ground surfaces visible after the transition stabilizes.
- [ ] Verify production terrestrial ocean depth behavior separately from the legacy `PlanetRenderer` ocean; the existing release-blocker test covers the legacy path only.

### Decision gate

- Proceed to Task 10 only if the production ocean sphere is still proven to cause the shoreline gap/sag.
- Otherwise document the actual layer owner and fix that smaller contract instead.

### Task 10: If proven, replace only the near-field ocean geometry

**Files:**

- Modify: `src/render/terrestrial/ocean.ts`
- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Test: `tests/veyra-ocean.test.ts`
- Create: `tests/ocean-cap.test.ts`

### Work

- [ ] Keep the existing production material/shore-mask/glitter behavior and body orientation contract.
- [ ] Use a camera-anchored spherical cap whose generated directions lie on the exact datum radius.
- [ ] Size the cap beyond the horizon with a tested margin at every altitude where terrestrial ocean is presented.
- [ ] Validate rectangular-cap corners, pole bases, body rotation, shore-mask UVs, frustum bounds, render order, and logarithmic-depth compatibility.
- [ ] Choose opacity/depth-write behavior from the occlusion requirement established in Task 9. Do not blindly copy the current transparent setting or the legacy opaque setting.
- [ ] Keep or add a far-field ocean representation if the presentation band can expose regions outside the cap.

### Required tests

- Every generated cap vertex has unit direction and exact datum radius after scale.
- The full rectangular cap covers the view horizon, including corners, for the tested altitude range.
- Mid-cell sag is below 1 m at landing altitudes for each tier.
- Shore mask rotates with the body and matches terrain coordinates.
- Underwater terrain does not appear as a second ground layer.
- Shader compilation/render smoke test runs with logarithmic depth enabled.

### Visual gate

- Real-game shoreline, pad-adjacent water, a polar view, and a camera pan show no star gap, floating sheet, missing corner, or mask drift.

## Phase 6 — Secondary Quality and Memory Fixes

### Task 11: Correct deep-LOD normal sampling with a deterministic reference

**Files:**

- Modify: `src/render/terrain/chunkGeometry.ts`
- Test: `tests/terrain-worker.test.ts`

### Work

- [ ] Replace the fixed `1e-5` floor with an epsilon derived from tile cell size and a small numerical lower bound.
- [ ] Build a named maximum-depth Veyra tile with known non-zero relief.
- [ ] Compute a test reference normal using a materially smaller central-difference epsilon and compare angular error for interior vertices.
- [ ] Exclude skirts and seams from the reference sample unless the test explicitly targets them.
- [ ] Run content validation; regenerate assets only if the normal data is actually part of an authoritative fingerprint and inspect every generated diff.

### Done when

- Deep-LOD normals meet a documented angular-error threshold and remain deterministic.

### Task 12: Reconcile low-risk prototype cleanups

**Files:**

- `src/render/terrain/lodTransition.ts`
- `src/render/terrain/terrainSelection.ts`
- Related tests

### Work

- [ ] Keep quality-policy transition durations only if the manager is proven to use them and tests cover normal/pressure durations.
- [ ] Keep a bounded bounding-sphere cache only with a deterministic eviction test and evidence it does not cause selection churn; otherwise move it to separate follow-up work.
- [ ] Remove any dead residency/install state found while reconciling the prototype.
- [ ] Do not mix these cleanups into the performance evidence for Phases 1–4.

## Final Verification Gates

### Correctness

- [ ] `npm test` passes relative to the freshly recorded clean-HEAD baseline; no failure is waved away using the stale “two staging failures” note.
- [ ] `npm run typecheck`, `npm run build`, and `npm run validate:content` pass.
- [ ] Focused terrain selection, engine, transition, dither, ocean, material, renderer, and context-lifecycle tests pass.
- [ ] Production and proto terrain Playwright journeys pass in a foreground browser.

### Performance on the same reference setup

- [ ] Final balanced High cover at Cape Skyward is at or below 640 leaves.
- [ ] Selection + balance p95 is below 10 ms while the view changes and below 1 ms while stationary/reused.
- [ ] Balance alone p95 is below 3 ms.
- [ ] No frame runs more than two select/balance passes.
- [ ] Pending work reaches zero during a stationary 30-second sample; oldest pending age does not grow beyond 5 seconds.
- [ ] Heap delta stays within 30 MB over the stationary 30-second sample after warm-up.
- [ ] User-visible High-quality frame rate returns to at least 60 FPS on the same machine and scene used for the reported 30 FPS, or the remaining named subsystem is profiled before changing the target.

### Visual

- [ ] No opaque parent/child overlap, whole-planet dissolve, or transition shadow double-image.
- [ ] No visible hole during camera pan, horizon culling, or orphan unwind.
- [ ] No stable compact-plus-streamed double ground.
- [ ] No shoreline star gap, floating water sheet, underwater ground layer, or shore-mask drift.

## Explicitly Deferred

- Navball changes; the audit showed they are not the terrain bottleneck.
- Legacy `src/render/planet.ts` ocean changes unless a separate proto defect is reproduced.
- Broad renderer architecture changes unrelated to the measured low-altitude path.
- Quality reductions used only to hide an algorithmic regression.
