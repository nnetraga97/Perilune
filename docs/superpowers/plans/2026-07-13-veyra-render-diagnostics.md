# Veyra Render Diagnostics Implementation Plan

**Date:** 2026-07-13

**Status:** Ready for user review; implementation not started

**Design source:** `docs/superpowers/specs/2026-07-13-veyra-render-diagnostics-design.md`

## Goal

Implement the approved evidence-only Veyra render-diagnostics slice. Medium and High must be selectable from the URL before renderer construction, the renderer must produce bounded structured evidence for the visible terrain/compact/cloud defects, and production-game ascent/descent journeys must save screenshots and JSON traces. This plan stops after the evidence is captured and reviewed; it does not authorize a rendering fix.

## Implementation Boundaries

- Use the normal repository workflow for implementation. Per the user's direction, Superpowers is reserved for the final review, not for executing this plan.
- Do not change terrain LOD selection thresholds, parent/child visibility rules, geometry, skirts, materials, shaders, cloud geometry, cloud blending, compact/terrain transition timing, or asset contents.
- Do not add a visible diagnostics widget or decorative status indicator. The browser API and test artifacts are the interface.
- Diagnostic code may observe renderer state and retain plain primitive history only. It must not retain Three.js objects, simulation owners, DOM elements, errors, textures, or geometries.
- The recorder is game-owned so a `WorldScene` rebuild during quick-load does not discard the session trace. `WorldScene` and renderer subsystems receive a borrowed diagnostics port.
- Lightweight anomaly/lifecycle recording remains active for the session. Detailed samples and chunk lifecycle entries are enabled only by `?renderDebug=1`.
- The detailed sampling limit is enforced in the recorder by producer key, so terrain, transitions, and both cloud shells can each report without any producer exceeding 10 Hz.
- Every task runs focused tests and typecheck. The complete validation matrix runs only after all instrumentation is connected.
- Preserve the user's unrelated `.gitignore` and `vercel.json` changes. `src/render/worldScene.ts` currently contains the user's temporary hard-coded High selection; Task 2 replaces only that temporary selection with the approved query-driven startup option.

## Planned Data Contracts

Create `src/render/renderDiagnostics.ts` as a Three.js-independent diagnostics boundary. The concrete recorder owns the ring buffer and anomaly history; renderer modules consume a narrow `RenderDiagnosticsPort`.

```ts
export type RenderDiagnosticSubsystem =
  | 'renderer' | 'assets' | 'transition' | 'terrain' | 'clouds';

export type RenderDiagnosticSeverity = 'sample' | 'state' | 'anomaly' | 'failure';

export interface RenderDiagnosticContext {
  readonly simulationTime?: number | null;
  readonly bodyId?: string | null;
  readonly altitudeMeters?: number | null;
}

export interface RenderDiagnosticInput {
  readonly subsystem: RenderDiagnosticSubsystem;
  readonly event: string;
  readonly severity: RenderDiagnosticSeverity;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RenderDiagnosticsPort {
  readonly detailed: boolean;
  record(input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  recordDetailed(input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  sample(key: string, input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  anomaly(code: string, subsystem: RenderDiagnosticSubsystem,
    data?: Readonly<Record<string, string | number | boolean | null>>,
    context?: Readonly<RenderDiagnosticContext>): void;
}
```

Domain observation methods use primitive-only inputs and live on the concrete service:

- `observeTransition(...)` records the transition state and detects rollback/coverage anomalies.
- `observeTerrainEvent(...)` records detailed chunk lifecycle events while retaining enough lightweight state to detect anomalies.
- `observeTerrainSample(...)` applies the 10 Hz cap and detects coverage/factor-of-two/pending-age anomalies.
- `observeCloudShell(...)` records static/dynamic shell state and detects side, opacity, texture, and material-version anomalies.
- `noteRendererBoundary(...)` resets only the anomaly baselines that are allowed to change at an explicit renderer or asset transaction.

The recorder assigns sequence and wall-clock time. Producers supply body, simulation time, altitude, and primitive subsystem data. Error normalization stores only bounded error name/message strings.

---

### Task 1: Bounded Recorder, Browser API, and Pure Anomaly State

**Files:**

- Create: `src/render/renderDiagnostics.ts`
- Create: `tests/render-diagnostics.test.ts`

**Deliverables:**

- A 4,096-entry fixed-capacity ring buffer in chronological snapshot order.
- Monotonically increasing sequence numbers even after overwrites.
- `overwrittenEntries` and internal `recordingFailures` counters.
- Lightweight `record`, debug-only `recordDetailed`, and producer-keyed 10 Hz `sample` entry points.
- Frozen, isolated snapshots containing configuration, entries, sequence, overwrite/failure counts, and unique anomaly codes.
- `snapshot()`, `exportJson()`, and local `download()` browser API methods with no network activity.
- One console warning per anomaly code per recorder instance.
- Failure isolation around recording, normalization, freezing, JSON serialization, Blob creation, and download cleanup.

- [ ] Write unit tests for Medium/High configuration, lightweight versus detailed recording, exact per-key 10 Hz behavior with an injected clock, ring overwrite order at 4,097+ entries, sequence monotonicity, and anomaly-code uniqueness.
- [ ] Add tests proving a returned snapshot cannot mutate recorder data, nested entry data is frozen, JSON output matches the snapshot, download creates/revokes one object URL, and no fetch/XHR path is used.
- [ ] Add malicious/cast-only inputs with throwing getters or non-serializable values and assert the recorder increments its failure counter without throwing into the caller.
- [ ] Implement primitive normalization and bounded error-message formatting. Reject or stringify unsupported values without retaining their owners.
- [ ] Implement transition, terrain, and cloud observation history as small maps/sets of primitive snapshots. Keep the anomaly thresholds from the approved spec exact: two-second pending jobs, complementary coverage tolerance, and factor-of-two sample deltas.
- [ ] Run `npx vitest run tests/render-diagnostics.test.ts && npm run typecheck`.
- [ ] Commit only the recorder and its tests with `feat: add bounded render diagnostics`.

### Task 2: Immutable Startup Options and Game-Owned Lifecycle

**Files:**

- Create: `src/render/renderStartupOptions.ts`
- Create: `tests/render-startup-options.test.ts`
- Modify: `src/main.ts`
- Modify: `src/game.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `tests/body-renderer.test.ts`

**Interfaces:**

```ts
export interface RenderStartupOptions {
  readonly quality: 'medium' | 'high';
  readonly renderDebug: boolean;
}

export function parseRenderStartupOptions(search: string): RenderStartupOptions;
```

- [ ] Write parser tests for absent parameters, `quality=medium`, `quality=high`, invalid/Low/mixed-case values falling back to Medium, exact `renderDebug=1`, and every other debug value staying false.
- [ ] Change `main.ts` to parse one immutable option object before importing/starting the production game. Prototype routing remains unchanged and does not receive production diagnostics.
- [ ] Change `startGame`/`PeriluneGame` to accept the immutable startup options, construct one `RenderDiagnostics`, expose its browser API, and tear down the API on non-persisted `pagehide`.
- [ ] Pass `{ quality, diagnostics }` into every `WorldScene` construction, including quick-load reconstruction. The diagnostics instance survives the scene replacement.
- [ ] Remove the `WorldScene` field initializer for quality and initialize it directly from constructor options. This replaces the user's temporary `medium` to `high` source edit with query selection; it must not call `setQuality()` after construction.
- [ ] Record startup quality/debug mode, checked manifest digest, viewport size, drawing-buffer size, renderer capability summary, and scene create/dispose state as primitive lifecycle entries.
- [ ] Keep the existing `setQuality` transaction path functional for renderer tests, but never use it to apply the startup query.
- [ ] Extend existing WorldScene construction tests to prove High is used for the first candidate and no synthetic Medium candidate/asset transaction occurs first.
- [ ] Run `npx vitest run tests/render-startup-options.test.ts tests/body-renderer.test.ts tests/renderer-transaction.test.ts && npm run typecheck`.
- [ ] Commit Task 2 files only with `feat: select diagnostic render startup options`.

### Task 3: Renderer Transactions and Authored Asset Lifecycle

**Files:**

- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/render/planetAssetLoader.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `tests/renderer-transaction.test.ts`
- Modify: `tests/veyra-assets.test.ts`

**Required event order:**

`candidate-created -> asset-load-start -> channel-selected/load -> assets-staged -> candidate-prepared -> compile-start/success -> coverage-ready -> budget-accepted -> renderer-committed -> previous-disposed`

- [ ] Extend manager test harnesses with an optional fake diagnostics port and assert exact success, failure, replacement, and disposal event ordering.
- [ ] Give each candidate/committed renderer a plain identity string derived from its root UUID and each manager a stable session-local numeric identity. Store the strings/numbers only.
- [ ] Record candidate creation, preparation, compile, coverage wait, budget result, commit, replacement, failure, and disposal. Include body, tier, candidate identity, committed identity, active renderer-root count, generation, and transaction duration.
- [ ] Record asset-pack start/commit/replacement/disposal and manifest digest. For every channel record declared channel name, selected package or fallback path, KTX2 versus conventional choice, dimensions, selected GPU byte estimate, texture UUID, color space, and load outcome.
- [ ] Explicitly record a fallback decision when capability probing or compressed loading selects the declared conventional asset. Do not record image bytes or retain textures.
- [ ] Normalize failures from `RenderBoundaryError` into primitive body/tier/channel/phase/name/message fields and record them before the existing rejection path continues.
- [ ] Call `noteRendererBoundary` only after a successful atomic commit so cloud/terrain baselines cannot treat a failed candidate as an authorized identity change.
- [ ] Preserve all existing transaction semantics and resource ownership. Diagnostics calls are side effects contained by the recorder and may not determine success/failure branches.
- [ ] Run `npx vitest run tests/renderer-transaction.test.ts tests/veyra-assets.test.ts tests/context-lifecycle.test.ts && npm run typecheck`.
- [ ] Commit Task 3 files only with `feat: trace renderer asset transactions`.

### Task 4: Compact/Terrain Presentation and Coverage Evidence

**Files:**

- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `tests/terrestrial-body-renderer.test.ts`
- Modify: `tests/coverage-transition.test.ts`
- Modify: `tests/render-diagnostics.test.ts`

- [ ] Inject the borrowed diagnostics port through `createBodyRendererCandidate` into `TerrestrialBodyRenderer` without adding diagnostics to simulation types.
- [ ] In each renderer update, compute the existing `prewarm`, `visibleBand`, `coverageReady`, and requested presentation once, then pass those already-used values plus the returned `CoverageTransitionSnapshot` to `observeTransition`.
- [ ] Record state changes in lightweight mode. In detailed mode sample requested presentation, state, progress, compact/terrain coverage, terrain coverage readiness, gap count, prewarm/visible-band decisions, frame pressure, compact visibility, terrain group visibility, and terrain visible-chunk count.
- [ ] Detect and record: progress regression while terrain stays requested; `fading`/`terrain` rollback to `prewarming` without a request change; combined coverage below one outside tolerance; coverage-ready true-to-false while terrain remains requested; and an active committed body with neither compact nor terrain visible coverage.
- [ ] Ensure anomaly detection observes values after the existing transition update but never modifies progress, dither uniforms, visibility, or transition state.
- [ ] Add integration tests that deliberately feed primitive transition observations causing each anomaly and assert one warning per code, while existing coverage transition tests prove the render path remains unchanged.
- [ ] Run `npx vitest run tests/render-diagnostics.test.ts tests/coverage-transition.test.ts tests/terrestrial-body-renderer.test.ts && npm run typecheck`.
- [ ] Commit Task 4 files only with `feat: trace terrain presentation coverage`.

### Task 5: Terrain Chunk, Worker, and LOD Replacement Evidence

**Files:**

- Modify: `src/render/planet.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`
- Modify: `tests/terrain-worker.test.ts`
- Modify: `tests/render-diagnostics.test.ts`

**Instrumentation model:**

- Add an optional diagnostics port to `PlanetRendererOptions`.
- Extend `PlanetRenderer.update` with an optional primitive diagnostic context containing simulation time and altitude. Existing callers/tests remain valid.
- Maintain diagnostic-only `lastWantedKeys`, request-start timestamps, and installed-generation markers. These structures never participate in chunk selection, installation, visibility, or eviction decisions.

- [ ] Add pure chunk-key helpers that return face, depth, parent key, and four immediate child keys. Test cube-face/root and deeper keys without altering the existing key format.
- [ ] Observe request, queue, completion, installation, visibility-on/off, eviction, replacement-root staging/commit, cancellation, stale completion, and failure events. Store chunk key, face, depth, generation, parent key, and worker counts as primitives.
- [ ] At the end of selection, diff the previous and current wanted-key sets. When one parent disappears and its four immediate children appear, emit one grouped `parent-children-replacement` event containing the parent and four child keys as flat fields.
- [ ] If a parent disappears without all four children installed, emit the approved coverage anomaly. Do not alter which keys remain visible.
- [ ] Record a detailed 10 Hz terrain sample containing visible totals by depth (flat `visibleDepthN` fields), pending count, oldest pending age, coverage gaps/readiness, replacement-root count, worker/active/queue counts, schedule/install/build timings, chunk count, triangles, and geometry bytes.
- [ ] Detect a same-generation request after successful installation, a current-generation job pending longer than two seconds, coverage readiness loss while terrain remains requested, and factor-of-two chunk/geometry deltas without a renderer/quality boundary.
- [ ] Ensure quality replacement and disposal clear diagnostic metadata alongside the existing pending generation, and record cancellation before clearing it.
- [ ] Use controlled workers to test grouped replacement completeness, stale-generation handling, pending-age anomalies with an injected clock, repeated request detection, and lifecycle cleanup.
- [ ] Re-run existing atomic root replacement, coverage gap, and scheduling/install timing tests to prove instrumentation does not affect renderer decisions.
- [ ] Run `npx vitest run tests/terrain-worker.test.ts tests/coverage-transition.test.ts tests/terrestrial-body-renderer.test.ts tests/render-diagnostics.test.ts && npm run typecheck`.
- [ ] Commit Task 5 files only with `feat: trace terrain lod lifecycle`.

### Task 6: Cloud Shell Crossing and Material Evidence

**Files:**

- Modify: `src/render/terrestrial/cloudLayer.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `tests/veyra-clouds.test.ts`
- Modify: `tests/render-diagnostics.test.ts`

- [ ] Inject the borrowed diagnostics port into `TerrestrialCloudDeck` and record shell creation/disposal as lightweight state events.
- [ ] Record static shell facts: name, radius, altitude, geometry type/segments, material side, render order, base opacity, texture UUID, wrap modes, filters, anisotropy, color space, texture scale, shadow material presence, and quality.
- [ ] On update, pass the existing altitude/opacity/side/drift values to `observeCloudShell`. Record camera altitude, signed shell distance, inside/outside/crossing classification, opacity, base opacity, material version, visibility, side, drift angle, and simulation time.
- [ ] Define `crossing` from the existing 5,200 m crossing-fade band. This is classification only; do not change the current fade formula or side threshold.
- [ ] Count shader-program invalidation using the material's monotonically increasing `version` after existing `needsUpdate` writes. Do not force compilation or add new `needsUpdate` writes.
- [ ] Detect non-finite/out-of-range opacity, side oscillation on consecutive non-crossing samples, repeated material-version changes without crossing/asset replacement, and texture UUID changes without a committed renderer/asset boundary.
- [ ] Extend cloud tests to assert complete static/dynamic records across both shell crossings, legitimate one-time side changes, anomaly cases through primitive observation inputs, borrowed texture ownership, and unchanged shell visibility/fade behavior.
- [ ] Run `npx vitest run tests/veyra-clouds.test.ts tests/render-diagnostics.test.ts tests/terrestrial-body-renderer.test.ts && npm run typecheck`.
- [ ] Commit Task 6 files only with `feat: trace Veyra cloud crossings`.

### Task 7: Production-Game Medium/High Diagnostic Journeys

**Files:**

- Create: `e2e/fixtures/veyra-diagnostic-craft.json`
- Create: `e2e/helpers/renderDiagnostics.ts`
- Create: `e2e/veyra-render-diagnostics.spec.ts`
- Modify: `src/game.ts`
- Modify: `tests/craft-file-validation.test.ts`

**Journey constraints:**

- The fixture is a checked-in, validated craft file derived from the existing `tests/ascent.test.ts` reference vehicle.
- Test setup seeds the craft into the existing `perilune`/`saves` IndexedDB store, then the test clicks the saved-craft button and Launch in the normal editor UI.
- Every flight action uses keyboard or visible HUD controls: throttle, staging, SAS, steering, and warp. No test method changes position, velocity, time, renderer state, coverage, assets, or transitions.
- `window.__TEST__` gains read-only flight/orbit/render checkpoint probes only. It may expose altitude, vertical speed, situation, apoapsis/periapsis, current stage, active body, canvas/drawing-buffer size, and renderer stats.

- [ ] Validate the checked-in craft fixture through `validateCraftFile` and add a unit test proving it contains only registered parts and valid stages.
- [ ] Add an IndexedDB seeding helper used before production-game startup. After startup, load the named craft through the saved-craft UI and launch through the existing button.
- [ ] Implement a Playwright controller that reads only the allowed probes and drives existing UI controls through pad launch, gravity turn, staging, atmosphere exit, circularization, orbit, retrograde deorbit, service-stage jettison, parachute arming, and low-altitude return.
- [ ] Parameterize the same journey over `medium` and `high` URLs with `renderDebug=1`. Assert the startup snapshot reports the requested tier before launch.
- [ ] Capture screenshots and diagnostics snapshots at pad, immediately before/inside/after weather and wisps crossings, low atmosphere, atmosphere boundary, orbit, and the corresponding reverse-descent checkpoints.
- [ ] Write all artifacts beneath `test-results/veyra-render-diagnostics/<tier>/`. Include browser name/version, user agent, viewport, drawing buffer, manifest digest, quality, debug mode, checkpoint altitude/time, console errors, shader errors, asset errors, and diagnostics JSON. Store empty error arrays explicitly.
- [ ] Do not make the test pass/fail depend on a particular anomaly code or automatic image interpretation. The journey proves the path was exercised and preserves evidence; the required manual evidence review decides whether the recorded defect occurred.
- [ ] Assert both journeys reach all checkpoints, create non-empty screenshots/JSON, retain bounded entry counts, report the expected tier/manifest, and do not produce application/page errors.
- [ ] Run `npx playwright test e2e/veyra-render-diagnostics.spec.ts --project=chromium` if a named project exists; otherwise run `npx playwright test e2e/veyra-render-diagnostics.spec.ts`.
- [ ] Run the existing playable-loop E2E afterward to catch interference with ordinary startup and quick-load.
- [ ] Commit only the fixture, helper, E2E, read-only probes, and fixture validation with `test: capture Veyra render diagnostics`.

### Task 8: Full Verification, Evidence Package, and Mandatory Stop

**Files:**

- No rendering-fix source files.
- Generated/ignored evidence: `test-results/veyra-render-diagnostics/`

- [ ] Run `npm run validate:content`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e`.
- [ ] Run `git diff --check`.
- [ ] Inspect `git status --short` and verify `.gitignore`/`vercel.json` remain the user's unrelated changes, while the temporary hard-coded High edit has been replaced only by the approved startup option work.
- [ ] Audit the implementation diff and confirm no terrain thresholds, selection conditions, geometry generation, cloud shader source, opacity formula, side threshold, transition durations, dither behavior, or asset files changed.
- [ ] Open the Medium and High checkpoint screenshots and correlate their visible terrain shifts, square boundaries, compact/terrain flashes, and radial cloud lines with adjacent diagnostic sequence/time/altitude entries.
- [ ] Produce a concise evidence table for the user containing tier, checkpoint, visible symptom, relevant sequence range, renderer/asset boundary state, transition state, terrain parent/child event, coverage gaps/readiness, and cloud shell classification/material version.
- [ ] If a symptom is absent in a run, state that plainly and show the completed checkpoint path and error/anomaly state rather than claiming reproduction.
- [ ] Stop. Do not change rendering behavior or propose a single assumed fix in code.
- [ ] Run the requested Superpowers review over the completed diagnostic implementation and evidence package.
- [ ] Present two or three evidence-backed rendering-fix approaches with trade-offs for user approval in a separate follow-up design.

## Completion Criteria

This implementation plan is complete only when:

- Medium and High are selected before the first production renderer is built;
- the always-on and detailed recorder contracts are verified and bounded;
- renderer, asset, presentation, terrain, and cloud producers emit the approved primitive evidence;
- browser snapshot/export/download work locally without network activity;
- production-game Medium and High ascent/descent artifact sets exist;
- focused, full, build, and E2E verification pass;
- the diff contains no rendering fix; and
- work stops for the user's evidence review before any rendering behavior changes.
