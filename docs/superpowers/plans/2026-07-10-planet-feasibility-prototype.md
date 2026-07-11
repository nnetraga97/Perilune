# Planet Rendering Feasibility Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Do not begin the Phase 3 renderer platform until both named reference-machine records pass or the approved design spec is revised.

**Goal:** Build a bounded, independently switchable WebGL2 prototype that measures the combined terrain, atmosphere, ocean, cloud, transition, scatter, and physical-proxy workload required by the approved planet renderer.

**Architecture:** Keep the existing game renderer intact. A dedicated `?proto=feasibility` route composes the existing authoritative Veyra terrain with promotable prototype effects and a measurement harness. Pure metric/reduction-policy code is unit-tested; real WebGL capability, delayed GPU timer queries, scene population, camera journeys, and stability are tested in Chromium. The harness exports a machine-readable reference-run record, while `PERFORMANCE.md` distinguishes local/CI observations from the two required hardware certifications.

**Tech Stack:** TypeScript, Three.js/WebGL2, `EXT_disjoint_timer_query_webgl2`, Vitest, Playwright, Node profiling script, deterministic instancing, and the existing terrain prototype.

## Global Constraints

- The combined Medium fixture contains terrain, atmosphere, ocean, two cloud layers, a shadow receiver, transition overlap, 50,000 visible visual-scatter instances, and 128 active physical proxies.
- Each feature group is independently switchable. Automatic reductions use only this order: cloud shadows, atmosphere samples, second cloud scale, visual-scatter density, ocean glitter.
- Physical terrain and the 128 physical proxies are never removed by a quality reduction.
- GPU samples use a delayed query ring, are read only when available, and are discarded while the WebGL disjoint flag is set.
- The reference path renders to a fixed 1920×1080 drawing buffer, warms for 30 seconds, and runs three five-minute journeys.
- Playwright/SwiftShader and non-reference devices provide regression evidence only; they cannot certify Medium or Low.
- Phase 3 remains gated until the named Iris Xe and UHD 620 records exist and pass, or the design spec is explicitly revised.

---

### Task 1: Metric Aggregation and Reduction Policy

**Files:**
- Create: `src/proto/feasibilityMetrics.ts`
- Create: `tests/feasibility-metrics.test.ts`

**Interfaces:**
- Produces: `FeasibilityFeatureConfig`, `reductionStage(stage, tier)`, `percentile(values, q)`, `summarizeJourney(samples)`, and `summarizeReferenceRun(journeys)`.
- Consumes: frame, renderer-submission, terrain scheduling/install, and valid GPU sample durations.

- [ ] **Step 1: Write failing percentile, three-run aggregation, and reduction-order tests**

Assert nearest-rank p95 behavior, median-of-run-medians, worst-run p95, exclusion of invalid GPU samples, full Medium defaults, ordered reductions, and invariance of terrain/proxy counts.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/feasibility-metrics.test.ts`

Expected: module-resolution failure because the metrics module does not exist.

- [ ] **Step 3: Implement immutable metric and feature records**

Use explicit numeric samples and return new frozen records. Do not silently convert missing GPU timing into zero; report it as unavailable with valid/disjoint sample counts.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/feasibility-metrics.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit metrics and policy**

```bash
git add src/proto/feasibilityMetrics.ts tests/feasibility-metrics.test.ts
git commit -m "test: define planet feasibility metrics"
```

### Task 2: Delayed WebGL2 GPU Timing

**Files:**
- Create: `src/render/gpuTimer.ts`
- Create: `tests/gpu-timer.test.ts`

**Interfaces:**
- Produces: `GpuTimerRing.begin(label)`, `end()`, `poll()`, `snapshot()`, and `dispose()`.
- Consumes: `WebGL2RenderingContext` and `EXT_disjoint_timer_query_webgl2`.

- [ ] **Step 1: Write failing fake-context tests**

Cover unavailable extension, ring saturation without blocking, availability-before-read, disjoint discard, nanoseconds-to-milliseconds conversion, label preservation, and query deletion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/gpu-timer.test.ts`

- [ ] **Step 3: Implement a non-blocking query ring**

Never call a blocking finish. Keep at least six query slots, poll oldest-first, and count unavailable, valid, and disjoint results separately. A missing extension keeps total frame measurement active but exposes `supported: false`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/gpu-timer.test.ts`

- [ ] **Step 5: Commit GPU timing**

```bash
git add src/render/gpuTimer.ts tests/gpu-timer.test.ts
git commit -m "feat: add delayed WebGL GPU timing"
```

### Task 3: Combined Prototype Effects

**Files:**
- Create: `src/proto/feasibilityScene.ts`
- Modify: `src/render/clouds.ts`
- Modify: `src/render/planet.ts`
- Create: `tests/feasibility-scene.test.ts`

**Interfaces:**
- Produces: `FeasibilityScene` with `group`, `update`, `setFeatures`, `stats`, and `dispose`.
- Consumes: Veyra, `PlanetRenderer`, body orientation, deterministic seeds, and the feature config from Task 1.

- [ ] **Step 1: Write failing deterministic-fixture tests**

Test deterministic scatter transforms and stable IDs, exactly 50,000 Medium visual instances, exactly 128 physical proxies at every reduction stage, two independently controlled cloud scales, atmosphere sample-count reduction, transition-overlap enablement, and complete disposal accounting.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/feasibility-scene.test.ts`

- [ ] **Step 3: Make the existing terrain renderer measurable without changing authority**

Expose scheduling/install duration, geometry/buffer byte estimates, active visible/cache counts, and a prototype-only material hook if required. Keep `terrainHeight` as the only displacement input and preserve current coverage fallback behavior.

- [ ] **Step 4: Build the representative effects**

Add a bounded analytic atmosphere shell, the current ocean plus optional glitter path, two deterministic cloud scales, one shadow-receiving terrain fixture, a dithered near/far overlap fixture, a deterministic instanced-scatter field, and 128 quality-invariant proxy records/instances. Use low-complexity geometry representative of binding, vertex, fragment, shadow, and instance costs; do not build Phase 4 art assets here.

- [ ] **Step 5: Run scene, terrain, authority, and mission tests**

Run: `npx vitest run tests/feasibility-scene.test.ts tests/terrain-authority.test.ts tests/body-orientation.test.ts tests/ground.test.ts tests/palla-mission.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit combined effects**

```bash
git add src/proto/feasibilityScene.ts src/render/clouds.ts src/render/planet.ts tests/feasibility-scene.test.ts
git commit -m "feat: compose planet feasibility scene"
```

### Task 4: Reference Journey Harness and Browser Regression

**Files:**
- Create: `src/proto/feasibilityProto.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/perfOverlay.ts`
- Create: `e2e/feasibility-proto.spec.ts`
- Create: `scripts/profile-feasibility.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `window.__FEASIBILITY__`, `window.__FEASIBILITY_DONE__`, JSON reference records, and `npm run profile:feasibility`.
- Consumes: query parameters for tier, reduction stage, smoke/reference duration, and feature overrides.

- [ ] **Step 1: Write the failing Playwright regression**

At a short smoke duration, assert WebGL2, an exact 1920×1080 drawing buffer, all required scene counts, independent feature toggles, multiple camera regimes, no shader/console errors, bounded memory, terrain coverage, and a complete metrics record. Treat unavailable GPU queries as an explicit state rather than failure in software rendering.

- [ ] **Step 2: Run the browser test and verify RED**

Run: `npx playwright test e2e/feasibility-proto.spec.ts`

- [ ] **Step 3: Implement the fixed-buffer journey harness**

The reference mode runs 30 seconds of warm-up and three 300-second journeys spanning orbit, atmospheric flight, low flight, surface motion, and transition overlap. The smoke mode uses the same state machine with shortened durations. Measure frame time, renderer submission, terrain scheduling/install, GPU work, draw calls, triangles, instance/proxy counts, memory estimates, transition time, disjoint queries, and drawing-buffer size.

- [ ] **Step 4: Implement reference-record export**

`scripts/profile-feasibility.mjs` starts or connects to the local preview, launches Chromium at the fixed viewport, requires operator-supplied machine/driver/power metadata for a certifying run, waits for all three journeys, writes a timestamped JSON record under an ignored `artifacts/performance/` directory, and exits nonzero when the selected tier gates fail. It must label unrecognized hardware as non-certifying.

- [ ] **Step 5: Run the smoke browser regression and full existing e2e suite**

Run: `npx playwright test e2e/feasibility-proto.spec.ts`

Run: `npm run test:e2e`

Expected: all browser tests pass with no console or shader errors.

- [ ] **Step 6: Commit the harness**

```bash
git add src/proto/feasibilityProto.ts src/main.ts src/ui/perfOverlay.ts e2e/feasibility-proto.spec.ts scripts/profile-feasibility.mjs package.json package-lock.json .gitignore
git commit -m "feat: add planet feasibility harness"
```

### Task 5: Protocol, Local Evidence, and Phase Gate

**Files:**
- Modify: `PERFORMANCE.md`
- Modify: `RENDERING.md`

- [ ] **Step 1: Document the exact certification protocol**

Record required CPU/GPU/RAM, laptop model, firmware, driver, OS, browser, AC power/performance mode, sustained power configuration, 1920×1080 physical drawing buffer, no zoom/supersampling, warm-up, journey count/duration, aggregation rules, timer-query validity, feature switches, reduction order, and JSON record fields.

- [ ] **Step 2: Run and record a non-certifying local smoke profile**

Run: `npm run profile:feasibility -- --mode=smoke`

Record actual local browser/capability/count/stability results and clearly label them non-certifying when the machine is not one of the named references. Do not infer Iris Xe/UHD 620 performance from Apple Silicon or SwiftShader.

- [ ] **Step 3: Run the complete repository gate**

Run: `npm run validate:content`

Run: `npm test`

Run: `npm run build`

Run: `npm run test:e2e`

Run: `npm audit --audit-level=moderate`

Expected: every command exits 0.

- [ ] **Step 4: Self-review against the feasibility fixture**

Verify the exact feature counts, switch independence, reduction order, query semantics, fixed drawing buffer, three-run statistics, absence of physical reductions, no implicit hardware certification, and no changes to simulation authority. Fix discrepancies and rerun Step 3.

- [ ] **Step 5: Commit protocol and local evidence**

```bash
git add PERFORMANCE.md RENDERING.md
git commit -m "docs: record planet feasibility protocol"
```

- [ ] **Step 6: Enforce the external Phase 2 gate**

Run the full reference command on the named Iris Xe Medium machine and UHD 620 Low machine. Commit both JSON result records or their stable summarized evidence. If Medium fails, apply only the approved reductions in order and rerun. If either tier still fails after allowed reductions, stop and revise the design spec. If the machines are unavailable, report Phase 2 as awaiting reference-hardware certification and do not begin Phase 3.
