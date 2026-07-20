# Near-Ground Sol Visual Completion — Corrected Implementation Plan

**Status:** Implemented and verified on 2026-07-20. Tasks 0–6, 8, and 9 are complete. Conditional Task 7 was not run because Task 6 did not approve a depth-correct local-cloud method; the existing production cloud path remains in place. Completion evidence is recorded in `docs/performance/reference/sol-near-ground-completion-2026-07.md`.

**Goal:** Improve the visible fidelity of Earth and the Moon from low altitude to the surface without changing gameplay, persistence, orbital physics, collision height, or the physical scale of the Sun–Earth–Moon system.

**Visual direction:** NASA-style scientific visualization: recognizable sourced planetary identity, restrained physically motivated lighting, stable scale transitions, and detail that reads as belonging to the surface. “More objects” is not sufficient if they look decorative, float, pop, or contradict the sourced surface.

**Branch:** `feature/sol-earth-moon-visuals` in the `fable-test` worktree.

## Decisions locked by this revision

- Do **not** implement runtime promoted macro-height authority in this visual session. The previous design changed collision/contact terrain after `recipeForBody`, `launchPadTerrainEnvelope`, worker pools, and candidate renderers could already be cached. It was not visual-only and could not participate atomically in `BodyRendererManager.transact`.
- Do **not** add hand-authored texture work. Reuse the checked Earth/Moon asset packs and existing deterministic terrain authority.
- Start with bounded, visual-only surface scatter, first on the Moon and then as neutral geological detail on Earth. Do not add globally green Earth vegetation without a sourced surface-classification authority.
- Apply aerial perspective to the ocean through the existing terrestrial environment seam before attempting vessel materials.
- Represent near-ocean waves through filtered fragment normals. The current 144–192 segment ocean cap cannot geometrically sample 7.5–46 m displacement.
- Treat ground-cloud replacement as a gated feasibility task. Do not ship an inverted camera dome until its depth/compositing behavior is proven against opaque terrain.
- Keep Artemis IV mission playback, mission UI, saves, campaign changes, and new gameplay out of scope.

## Current code-path facts the implementation must preserve

1. `BodyRendererManager.transact` constructs a renderer before it loads/stages assets and before `prepareCandidate`; preparation is not a pre-construction hook.
2. `TerrestrialBodyRenderer.stageAssets` and `AirlessBodyRenderer.stageAssets` release and rebuild their render stacks. Any scatter owned by a stack must be rebuilt and disposed there, while each renderer’s worker pool remains renderer-owned.
3. `PlanetRenderer` obtains its immutable surface provider during stack construction. This plan does not replace that provider or its simulation recipe.
4. `BodyRenderFrame.allowFlightTerrain`, `terrainPresentationBand`, and `CoverageTransition` decide when streamed terrain owns the visible surface. Near-ground additions must follow that authority rather than altitude alone.
5. `TerrestrialBodyRenderer` already updates aerial state for compact and streamed land through `updateTerrestrialEnvironment`; `TerrestrialOcean` currently does not consume or update that state.
6. Vessel model instances borrow shared geometry, materials, and textures from `PartModelLibrary`. Flight-only shader injection must never mutate those shared materials in place.
7. The ocean cap is camera-anchored and horizon-covering, but its vertex spacing is hundreds of metres or more at the relevant stations. Short waves must remain a shading representation unless a separately proven dense inner patch is added later.

## Scope guard

Allowed:

- renderer-only profiles, instanced meshes, materials, uniforms, diagnostics, reference captures, and performance accounting;
- use of existing authored albedo, normal, material, cloud, macro-height, and local-detail products;
- small test/prototype hooks that exist only in `?proto=sol-visual-reference` or another explicit prototype.

Not allowed:

- changes to `contactSurface`, `naturalContactSurface`, `solidHeight`, `recipeForBody`, save recipe hashes, vessel placement, orbital constants, body radii, or Earth–Moon separation;
- new persistence migrations or save compatibility work;
- a production post-processing pipeline added solely to force the cloud design through;
- geometric ocean waves on the existing coarse cap;
- Earth vegetation placement based only on “height > 0.”

## Verification discipline

Before the first implementation task, preserve the current reference outputs and record the current branch SHA. Never run or modify the unrelated untracked `tests/zz-scratch-sketch-accuracy.test.ts`.

Every task:

```bash
npm run typecheck
npx vitest run <task-specific tests>
```

Every completed phase:

```bash
npm run validate:content
npm test -- --exclude tests/zz-scratch-sketch-accuracy.test.ts
npm run build
npx playwright test e2e/sol-visual-reference.spec.ts
```

Visual acceptance uses the fixed stations in `src/proto/solVisualReferenceStations.ts`. The minimum targeted set is:

- `moon-surface`, `moon-low-orbit`;
- `earth-ground`, `earth-1km`, `earth-ocean-horizon`, `earth-10km`;
- `earth-day-full`, `earth-moon-true-scale`, and `sun-from-earth` as regression guards.

For each changed station, retain a before/after image and the JSON sidecar. A task is not complete merely because a uniform exists or a screenshot was produced. The intended visual difference, instance/resource counts, runtime errors, and frame-time effect must all be recorded.

Performance stop rule: compare with `docs/performance/reference/sol-visual-final-2026-07-19.md`. A regression greater than 1 ms in Medium steady-state frame p50, an unexplained p95 increase, a new runtime error, or an active-body budget overrun stops the phase for review.

---

## Phase 0 — Establish the comparison envelope

### Task 0: Capture the unchanged baseline

**Files:**

- Read: `docs/performance/reference/sol-visual-final-2026-07-19.md`
- Read: `src/proto/solVisualReferenceStations.ts`
- Generated only: `test-results/sol-visual-reference/`
- Create after capture: `docs/performance/reference/sol-near-ground-baseline-2026-07-20.md`

- [x] Confirm `git status --short` contains only the plan and the unrelated scratch test before implementation.
- [x] Run typecheck and the focused renderer/scatter/ocean/cloud suites.
- [x] Capture the targeted reference stations on Medium and High; run the full matrix before merging the first phase.
- [x] Record branch SHA, browser, quality, screenshot paths, `frameTimeMs`, draw/triangle counts, shadow allocation, and current `visualScatter`/`scatterBytes` values.
- [x] Do not change thresholds to make later results pass. If the baseline itself fails, document it before attributing a failure to new work.

**Commit:** documentation only, together with the first implementation phase if preferred.

---

## Phase 1 — Reusable visual scatter and lunar geological detail

This is the first implementation slice. It is visual-only, uses the existing deterministic instance streamer, and directly improves the current `moon-surface` gap without inventing biome data.

### Task 1: Replace hard-coded vegetation choices with explicit scatter profiles

**Files:**

- Modify: `src/render/terrestrial/scatter.ts`
- Modify: `src/content/bodyVisuals.ts`
- Create: `tests/scatter-profile.test.ts`
- Modify: `tests/veyra-surface-effects.test.ts`

**Design:**

- Keep `TerrestrialScatter` for this pass to avoid a broad rename, but make its generated pools profile-driven.
- Add `scatterProfile?: 'veyra' | 'earth-geology' | 'moon-regolith'` to `BodyVisualDef`. Define profiles in `scatter.ts`, selected by a checked lookup rather than free-form renderer conditionals.
- A profile class definition must include a stable class ID, one of the existing low-cost geometry archetypes, roll weight, color, scale range, and roughness. Pools are built from the selected profile, not from the global `SCATTER_CLASSES` constant.
- Add an explicit placement policy to each profile:
  - `veyra`: preserve the current dry-land behavior exactly;
  - `moon-regolith`: allow finite solid terrain above **or below** the reference datum;
  - `earth-geology`: dry land only, neutral rock/clast classes only. No grass or shrub colors in this phase.
- Preserve the PRNG draw order—offsets, class roll, scale roll, yaw roll—before density rejection. The same seed/cell/profile/quality must remain deterministic and lower tiers must remain a stable subset.
- Normalize every finite-difference direction before `evaluateRecipeHeight`. The sampler returns height plus a unit normal; tests assert both finiteness and normalization at ordinary and polar directions.
- Do not infer “water” from a generic negative-height rule inside `generateScatterCell`; placement is a profile decision.
- `TerrestrialScatter.stats()` continues to count live instances and complete fixed-capacity buffer bytes.

**Tests:**

- [x] Veyra produces pinned pre-refactor golden classes/transforms for fixed cells.
- [x] Moon profiles emit no vegetation archetypes and still populate a constant negative-height basin.
- [x] Earth geology rejects negative-height terrain and emits neutral geology only.
- [x] Profile generation is deterministic and tier density is a strict subset.
- [x] Sampled normals are finite and unit length at the equator and near both poles.
- [x] Pool disposal releases owned geometries/materials exactly once.

**Verification:**

```bash
npx vitest run tests/scatter-profile.test.ts tests/veyra-surface-effects.test.ts
```

**Commit:** `feat: parameterize deterministic surface scatter profiles`

### Task 2: Integrate lunar scatter with terrain coverage and resource budgets

**Files:**

- Modify: `src/render/airlessBodyRenderer.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/resourceAccounting.ts` or create a small shared body-budget module
- Modify: `tests/airless-body-renderer.test.ts`
- Modify: `tests/resource-accounting.test.ts`
- Modify: `src/content/bodyVisuals.ts` (`moon` selects `moon-regolith`)

**Lifecycle and budget rules:**

- Keep planet-pack admission in `RendererResourceLedger`. Preserve the proven 128 MiB streamed-terrain geometry reservation and charge scatter's fixed instance buffers against that reservation through `terrainGeometryAllocation`; the remaining bytes are passed to `PlanetRenderer` as `terrainAllocationBytes`. Do not subtract the separately ledger-charged conventional texture fallback a second time—the browser baseline proves that doing so makes lunar prewarm refinement thrash.
- Add `scatter.group` to the renderer root. `releaseStack` disposes it exactly once, so the null-pack constructor stack and the authored `stageAssets` replacement cannot leak or double-own resources.
- Set scatter mesh `castShadow` and `receiveShadow` on Medium/High; both remain false on Low. This follows the existing real-time shadow quality policy.
- After terrain and `CoverageTransition` update, show/update scatter only when all are true:
  - `frame.allowFlightTerrain`;
  - `terrainActive`;
  - `coverageProgress === 1` (no scatter over the compact/terrain crossfade);
  - altitude is below a named, profile/tier-tested stream ceiling.
- Outside that gate, set the group invisible and report zero visible instances. Cached cells may remain until normal streamer hysteresis retires them; fixed buffer bytes remain charged.
- Populate `visualScatter` and `scatterBytes` in `BodyRendererStats`.

**Tests:**

- [x] No scatter at compact coverage 0 or transition coverage 0.5.
- [x] Lunar boulders appear after terrain coverage reaches 1 near the surface.
- [x] `allowFlightTerrain: false` and orbit altitude both hide scatter and report zero visible instances.
- [x] Medium/High shadow flags are true; Low flags are false.
- [x] `scatterBytes` equals the owned pool allocation and reduces terrain allocation by the same amount.
- [x] `stageAssets` rebuild and double `dispose()` do not leak or dispose borrowed textures.

**Verification:**

```bash
npx vitest run tests/scatter-profile.test.ts tests/airless-body-renderer.test.ts tests/resource-accounting.test.ts tests/context-lifecycle.test.ts
npx playwright test e2e/sol-visual-reference.spec.ts --grep "moon-surface|moon-low-orbit"
```

**Visual acceptance:** At `moon-surface`, rocks/clasts must have visible contact shadows, remain sparse enough to read as scale cues, and use lunar-neutral colors. They must not appear during `moon-low-orbit`, along the compact/terrain transition, or as a circular stream boundary.

**Commit:** `feat: ground lunar regolith scatter in streamed terrain`

---

## Phase 2 — Neutral Earth geological scatter

Earth receives restrained geology only. Vegetation is explicitly deferred until a sourced land-cover authority can be sampled consistently by CPU placement and GPU shading.

### Task 3: Integrate Earth geology without contaminating oceans or the pad

**Files:**

- Modify: `src/content/bodyVisuals.ts` (`earth` selects `earth-geology`)
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrestrial/scatter.ts` if a reusable static suppression helper is needed
- Modify: `tests/terrestrial-body-renderer.test.ts`
- Modify: `tests/scatter-profile.test.ts`

**Rules:**

- Use the same construction, budget, lifecycle, coverage, altitude, statistics, and shadow contracts proven on the Moon.
- The Earth profile contains only small neutral rock/clast forms. It must not introduce globally green grass, shrubs, or biome claims.
- The dry-land placement predicate rejects raw surface height below the ocean datum.
- Build a static suppression sphere around an authored launch site using the body-fixed launch direction and the existing launch-pad footprint constants. Pass it through `TerrestrialScatterFrame.suppression`; do not hard-code Cape coordinates in the renderer.
- Scatter never changes `fixedPassBytes`, `surfaceEffects`, collision, or contact height beyond its renderer-owned allocation.
- Keep Veyra unmodified; this Sol plan does not silently wire old Veyra content.

**Tests:**

- [x] No Earth instances are emitted from a negative-height sampler.
- [x] Instances inside the launch-site suppression radius are omitted.
- [x] Scatter remains hidden until terrestrial coverage is complete and when Earth is not the flight-terrain body.
- [x] Ocean-horizon frames contain zero scatter over water.
- [x] Stage rebuild, stats, budget charge, and disposal match the lunar contract.

**Verification:**

```bash
npx vitest run tests/scatter-profile.test.ts tests/terrestrial-body-renderer.test.ts tests/resource-accounting.test.ts tests/renderer-transaction.test.ts tests/context-lifecycle.test.ts
npx playwright test e2e/sol-visual-reference.spec.ts --grep "earth-ground|earth-1km|earth-ocean-horizon"
```

**Visual acceptance:** `earth-ground` gains restrained scale/contact cues without resembling a procedural rock field. `earth-ocean-horizon`, full-disk Earth, and the launch-pad footprint remain clean.

**Commit:** `feat: add restrained Earth geological surface scatter`

---

## Phase 3 — Ocean aerial perspective, end to end

### Task 4: Extract one shared aerial state and apply it to land and ocean

**Files:**

- Create: `src/render/terrestrial/aerialPerspective.ts`
- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Modify: `src/render/terrestrial/ocean.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Create: `tests/aerial-perspective-shared.test.ts`
- Modify: `tests/ocean-cap.test.ts`
- Modify: `tests/terrestrial-body-renderer.test.ts`

**Design:**

- Move the existing terrestrial aerial uniform values, binding, update logic, fallback optical-depth calculation, and LUT sampling into `aerialPerspective.ts`. This is a move/refactor first; compact and streamed land must remain visually unchanged.
- Give the shared state one stable `material.userData` key and one GLSL function that accepts an explicit body-fixed shaded point and base color. Do not make consumers reconstruct coordinates through undocumented varying conventions.
- Compact/terrain consumers pass `normalize(vBodyDirection) * (bodyRadius + surfaceAltitude)`.
- Ocean passes `normalize(vBodyDirection) * bodyRadius`; wave shading in Phase 4 does not change its depth datum.
- Bind an independent aerial state per material. Do not use a module-global state.
- Update compact, streamed land, and ocean on every terrestrial renderer frame with the same camera-body-fixed position, atmosphere parameters, solar visibility, and `TerrestrialAtmosphere.aerialPerspectiveTexture`.
- When no LUT is present, retain the current analytic fallback. When atmosphere height is zero, the function is a strict no-op.
- Add a program-cache version suffix to every changed shader material.

**Tests and behavioral proof:**

- [x] Existing compact and surface aerial tests remain equivalent after extraction.
- [x] Ocean state changes when `TerrestrialOcean.update` receives a new frame/LUT; do not stop at asserting uniform existence.
- [x] Zero-atmosphere/zero-height state returns the base color unchanged.
- [x] A fixed long ocean path has lower contrast and more in-scatter than a fixed near path in the shader/CPU mirror test.
- [x] Production build compiles all three shader consumers.
- [x] Extend reference metadata with the active aerial-consumer names so the browser capture proves ocean was updated.

**Verification:**

```bash
npx vitest run tests/aerial-perspective-shared.test.ts tests/ocean-cap.test.ts tests/terrestrial-body-renderer.test.ts
npx playwright test e2e/sol-visual-reference.spec.ts --grep "earth-ocean-horizon|earth-10km|earth-day-full"
```

**Visual acceptance:** At `earth-ocean-horizon`, distant water converges toward atmospheric haze while nearby water remains dark and crisp. The shoreline has no halo and the full-disk ocean color does not change.

**Commit:** `feat: apply terrestrial aerial perspective to the ocean`

---

## Phase 4 — Represented ocean waves without geometric aliasing

### Task 5: Replace decorative glitter noise with filtered body-fixed wave normals

**Files:**

- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Create: `tests/ocean-waves.test.ts`
- Modify: `tests/ocean-cap.test.ts`
- Modify: `src/proto/solVisualReferenceProto.ts` only if a prototype-only time override is required

**Design:**

- Keep every cap vertex at the exact datum radius. Do not modify `oceanCapDirection`, cap tessellation, CPU contact, or depth authority.
- Define two or three restrained, body-fixed wave components using 3D body-space directions, wavelength, phase speed, and slope amplitude. A body-fixed formulation avoids longitude seams and polar singularities.
- Compute the analytic tangent gradient in the fragment shader, project it off `vBodyDirection`, transform it into view space, and perturb `vViewNormal` before Fresnel/glitter evaluation.
- Use shader derivatives (`fwidth` of each phase) to attenuate a component before it becomes undersampled. Do not use the previous fixed “2.5 km” guess as an anti-aliasing proof.
- Quality policy:
  - Low: long component only, reduced slope;
  - Medium: long and medium components;
  - High: all components, still derivative-filtered.
- Bound total normal slope. The effect should read as water scale and light breakup, not animated terrain.
- Provide a CPU mirror for deterministic phase/slope bounds only. Screen-space filtering remains shader-owned and is proven in browser captures.

**Tests:**

- [x] CPU wave phase/slope is deterministic and remains within the declared bound.
- [x] Body-fixed sampling is continuous across the longitude seam and finite at poles.
- [x] Ocean cap direction, vertex positions, datum depth, and horizon coverage are unchanged.
- [x] Shader source contains derivative filtering for every enabled component.
- [x] Prototype captures at two controlled wave times show change in a near-water ROI but no material change in a horizon-row ROI.

**Verification:**

```bash
npx vitest run tests/ocean-waves.test.ts tests/ocean-cap.test.ts
npx playwright test e2e/sol-visual-reference.spec.ts --grep "earth-ocean-horizon"
```

**Visual acceptance:** Near water has restrained moving normal relief; the horizon remains stable for a five-second capture; no vertex crawling, silhouette wobble, or shoreline depth separation appears.

**Commit:** `feat: add footprint-filtered ocean wave shading`

---

## Phase 5 — Ground-cloud feasibility gate, then optional High integration

The previous inverted-dome proposal is not approved. With ordinary depth testing, a dome boundary behind terrain is rejected; disabling depth testing overlays foreground solids. The ray marcher also needs a coherent density definition and a correct optical-depth crossfade.

### Task 6: Prove one depth-correct local-cloud composition method

**Files:**

- Create: `src/proto/localCloudCompositeProto.ts`
- Create: `tests/local-cloud-composite.test.ts`
- Reuse read-only: `src/render/terrestrial/cloudLayer.ts`
- Reuse read-only: `src/render/terrestrial/cloudMaterial.ts`

**Prototype candidates:**

1. A bounded local ray march clipped by a sampled opaque depth texture and composited at half resolution; or
2. an improved production-shell approach that avoids the radial slicing which caused `groundVolumeFade`.

Do not select a method on elegance alone. The prototype must use the production Earth cloud map and atmosphere dimensions and must demonstrate:

- opaque terrain and a foreground solid correctly occlude cloud density;
- no cloud contribution behind the first opaque depth;
- no visible circular/radial boundary as the camera moves or turns;
- a stable body-fixed density field (global cloud coverage extruded through height plus procedural 3D breakup is acceptable; a vertically repeated 2D sheet is not);
- radial feathering and temporal continuity;
- optical-depth crossfade with the weather shell, not merely `alphaA + alphaB === 1`;
- High-tier-only cost within the existing envelope and no Low/Medium production change.

**Gate:** Save ground, 1 km, 3 km, and 6 km captures plus a foreground-occluder capture and a five-second motion capture. Record GPU/frame cost. If neither method meets every condition, stop this phase and keep the current cloud system. Do not add production code.

**Result (2026-07-20):** Gate failed before a render candidate could be approved. The forward path has no readable opaque-depth input or half-resolution composite boundary, its depth reconstruction has not been validated, and the shell cannot clip integrated density at the first opaque surface. Executable occlusion, body-fixed 3D density, Beer–Lambert integration, and optical-depth crossfade contracts were added to the isolated prototype, but no production method or GPU targets were installed. Required captures and GPU timing are therefore not applicable; attempting them would first require the explicitly out-of-scope production compositing architecture.

**Commit:** prototype evidence only: `proto: prove depth-correct local cloud composition`

### Task 7: Integrate the proven method on High only

This task exists only if Task 6 passes.

**Result:** Not run. Task 6 did not pass, so all production integration checkboxes intentionally remain open.

**Likely files (update to match the selected proof):**

- Modify: `src/render/terrestrial/cloudLayer.ts`
- Modify/create: one local-cloud renderer module
- Modify: `src/render/terrestrialBodyRenderer.ts` only if the selected method requires an explicit render boundary
- Modify: `src/render/renderDiagnostics.ts`
- Extend: existing cloud tests and `e2e/sol-visual-reference.spec.ts`

- [ ] Reuse production cloud lighting helpers rather than copying GLSL.
- [ ] Construct only on High; Low/Medium object graphs and screenshots remain unchanged.
- [ ] Own and dispose geometry/targets/materials exactly once; borrow the checked cloud texture.
- [ ] Report local-cloud target bytes, opacity/optical-depth crossfade, and frame cost in diagnostics.
- [ ] Repeat every Task 6 capture in the production path before committing.

**Commit:** `feat: integrate proven High ground-cloud rendering`

---

## Phase 6 — Aerial perspective for flight-owned solids

This closes the nearby opaque-object gap after the planet materials are stable. It must not mutate shared workshop/model-library materials.

### Task 8: Add a per-WorldScene aerial controller and flight-owned material variants

**Files:**

- Create: `src/render/flightAerialPerspective.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify: `src/render/terrestrial/scatter.ts`
- Modify: `src/render/vesselMesh.ts`
- Modify: `src/render/partModelLibrary.ts` only if an explicit material-clone boundary is required; never change library ownership of base resources
- Modify: `tests/vessel-mesh.test.ts`
- Create: `tests/flight-aerial-perspective.test.ts`

**Ownership and coordinate rules:**

- One controller belongs to each `WorldScene`; no module-global uniforms.
- Pass that controller through `createBodyRendererCandidate` so every replacement renderer created by `BodyRendererManager` binds the current scene-owned state. Do not traverse the scene once and assume later quality/body renderer transactions inherit the injection.
- State includes active/disabled flag, camera body-fixed position, body radius, atmosphere data, solar visibility, LUT, and the inverse body-orientation matrix.
- A camera-relative world fragment becomes body-fixed through:

  `cameraBodyFixed + worldToBody * cameraRelativeWorldPosition`

  Do not reconstruct it by addition alone.
- Create flight-owned material variants that borrow textures but clone material state. Imported model instances continue borrowing geometry/textures, while the flight visual owns and disposes only its cloned materials. Workshop portraits and cached `PartModelLibrary` scenes retain untouched base materials.
- Chain any existing `onBeforeCompile` and `customProgramCacheKey`; inject once at stable Three.js include anchors.
- Launch-site materials are already created by `WorldScene` and may be registered directly with the same controller.
- Earth scatter pool materials bind the controller during terrestrial stack construction and naturally release their owned variants in `releaseStack`. Disable the controller on the Moon/deep space. This makes scatter an actual aerial consumer without leaking state into the airless renderer.

**Tests:**

- [x] Coordinate reconstruction matches a CPU quaternion/matrix transform for multiple body orientations.
- [x] Two controllers do not share mutable uniforms.
- [x] Flight material variants leave base part-library/workshop materials unchanged.
- [x] Existing shader hooks are preserved and injection occurs exactly once.
- [x] Owned material variants dispose once; borrowed textures/geometries remain library-owned.
- [x] Earth enables haze for vessel, launch solids, and scatter; Moon disables it.

**Browser proof:** At a fixed Earth 10 km station, a vessel and distant pad solid converge with adjacent terrain haze while near structure remains crisp. Repeat on the Moon and prove no blue/terrestrial haze is introduced.

**Commit:** `feat: haze flight-owned solids through per-scene aerial state`

---

## Final verification and completion record

### Task 9: Run the complete visual and regression matrix

```bash
npm run validate:content
npm run typecheck
npm test -- --exclude tests/zz-scratch-sketch-accuracy.test.ts
npm run build
npx playwright test e2e/sol-visual-reference.spec.ts
```

- [x] Compare all 20 Sol stations across Low/Medium/High with the Phase 0 baseline.
- [x] Confirm no runtime errors, missing assets, KTX2 loader duplication, renderer transaction failures, or map-scale regressions.
- [x] Confirm Earth–Moon true-scale framing and Sun appearance remain unchanged except for intentional atmosphere/ocean pixels.
- [x] Tabulate visible scatter counts and bytes, terrain allocation after scatter charge, aerial consumers, cloud resource bytes if integrated, draw/triangle deltas, and p50/p95 frame time.
- [x] Record deferred work and any failed feasibility gate honestly.
- [x] Create `docs/performance/reference/sol-near-ground-completion-2026-07.md` with before/after plates and measurements.

**Final commit:** `docs: record Sol near-ground visual completion evidence`

---

## Deferred architecture: higher-resolution collision-authoritative height

This is not part of the implementation above. Reopen it only with explicit approval to change physical terrain/contact behavior.

A future design must, before coding:

1. choose a startup boundary that completes before `GameState`, physics queries, renderer construction, and recipe caching;
2. decode RG height to scalar samples **before** resampling;
3. define checked asset delivery so production cannot fall back nondeterministically after simulation starts;
4. version and invalidate `recipeForBody`, launch-site envelopes, terrain bounds, worker state, and any surface-pose data together;
5. account main-thread and every worker copy in the active-body memory budget;
6. define quality changes without a forbidden second “once-per-session” install;
7. prove rollback/failure behavior before the authority becomes observable;
8. explicitly accept that collision, landed placement, and terrain recipe identity change.

## Deferred tooling

- Linear HDR readback may be added later as diagnostic infrastructure. It is not a visual phase. A correct design must preserve the previous render target/viewport/scissor state, use driver-correct half-float readback and decoding, and use a solar ROI/max statistic rather than assuming the Sun occupies the p99 percentile.
- Sourced Earth vegetation/land-cover placement requires a checked CPU-readable classification authority derived from an existing scientific source. It must be reviewed separately; do not infer it from elevation or albedo color.
- True geometric short ocean waves require a proven dense inner patch or another topology whose vertex spacing is measured against wavelength. Fragment-normal waves in Phase 4 intentionally leave geometry/contact at the datum.

## Explicitly out of scope

- Artemis IV mission playback, phase UI, telemetry, camera direction, and time controls;
- save migrations and existing-save compatibility;
- orbital/physics retuning, new bodies, or changes to real Sun/Earth/Moon scale;
- Veyra completion, remaining legacy bodies, live weather, HDR display output, and gameplay surface obstacles.
