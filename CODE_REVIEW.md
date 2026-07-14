# Perilune Code Review — 2026-07-12

> Historical review snapshot. Verification counts and current-state claims
> below describe the repository on 2026-07-12 and are not live project status.

**Scope:** The docs refreshed this cycle (`RENDERING.md`, `PERFORMANCE.md`, `STATUS.md`, the
2026-07-10 planet-graphics spec, the 2026-07-11 Veyra surface-stack plan) plus a deep read of the
rendering and architecture-critical modules: `src/render/planet.ts`, `worldScene.ts`,
`terrestrialBodyRenderer.ts`, `bodyRendererManager.ts`, `coverageTransition.ts`, `gpuTimer.ts`,
`src/render/terrain/*` (chunk geometry, worker, pool), `src/render/terrestrial/*` (global/surface
materials, ocean, clouds, scatter, effects, dither), and `src/sim/scatterRecipe.ts`, with spot
checks of `src/save/persistence.ts` and the UI layer.

**Verification state:** `npm test` → 367/368 pass. The single failure
(`tests/profiler-process.test.ts` — "kills a stubborn descendant") is an environment artifact:
process-group SIGKILL semantics inside this container, not a product bug. `npm run build`
(tsc strict + vite + content validation of 24 planet pack files) passes cleanly.

**Overall impression:** The architecture is unusually disciplined — transactional renderer
swaps, a single terrain authority, deterministic seeding, explicit resource ledgers, honest
telemetry. Most problems below are in the newest code (the Veyra surface stack landed in the
last three commits), which shipped visually plausible but carries real geometry/orientation
bugs, an unfinished spec obligation (physical obstacles), and several per-frame hot-path costs
that directly explain the one budget miss already recorded in `PERFORMANCE.md`.

---

## 1. Correctness bugs

### 1.1 Two of four terrain skirt walls are wound backwards — `src/render/terrain/chunkGeometry.ts:226-237`

`addEdge` emits the same triangle pattern `(g0, s0, g1), (g1, s0, s0+1)` for all four chunk
edges, traversing +u on both the `v0` and `v1` edges and +v on both the `u0` and `u1` edges.
With the face bases in `FACES` (all satisfy `u×v = n`), the skirt-wall normal for that pattern
is `(s0−g0)×(g1−g0) ∝ −(n×u) = −v` on the u-traversed edges and `+u` on the v-traversed edges.
That is *outward* for the `v = v0` and `u = u1` edges but *inward* for the `v = v1` and
`u = u0` edges. The chunk material (`MeshStandardMaterial`, default `FrontSide`) backface-culls
those two walls, so the skirt curtain that exists to hide LOD cracks is invisible on two of the
four edges of every chunk. Result: pinholes/flicker at LOD seams in exactly the situation
skirts were added to prevent — intermittently, view-dependent, and hard to reproduce in tests
that only validate index validity.

**Fix:** flip the winding for the two affected edges (e.g. pass a `flip` flag into `addEdge`
and emit `(g0, g1, s0), (g1, s0+1, s0)` when set). Add a test asserting the signed volume /
normal orientation of every skirt triangle points away from the body center.

### 1.2 Dust particles rise along body-fixed +Y, not "up" — `src/render/terrestrial/surfaceEffects.ts:279-287`

`updateDust` writes particle positions in body-fixed axes relative to a surface-local origin,
with buoyancy and lift applied to the Y component (`by = … + 0.5 + phase * 2`) and box wrap on
X/Z only. Body-fixed +Y is only "up" at one specific point of the sphere. Anywhere else the
kicked-up dust drifts sideways; near the −Y pole it sinks into the terrain. The decals in the
same file get this right by aligning to the surface normal — dust should use the same
radial-up tangent frame that `updateDecals` already computes (`localOrigin` is even passed in
and then explicitly ignored with `void localOrigin;`, which is the smoking gun that the
body-frame conversion was never finished).

**Fix:** express particle offsets in the (east, north, radial) frame derived from the camera
direction and convert to body-fixed before writing the buffer.

### 1.3 Scatter suppression is dead in production — `src/render/terrestrialBodyRenderer.ts:219-223`

`TerrestrialScatter.update` accepts `suppression?: readonly SuppressionSphere[]` and correctly
culls overlapped instances (`scatter.ts:393-401`), but `updateSurfaceDetail` never passes it.
The spec's restore/spawn overlap-suppression contract ("that obstacle's **visual and physical**
instance is suppressed") therefore has no runtime path for the visual layer. Only the
feasibility prototype exercises it. Either wire vessel-derived suppression spheres through
`BodyRenderFrame` or explicitly document that suppression waits for the physical-obstacle task
(see §3.1) — right now it reads as implemented but isn't reachable.

### 1.4 The scatter "failed cell" path can never trigger — `src/render/terrestrial/scatter.ts:194, 282`

`this.failed` is checked (`if (this.failed.has(key)) continue;`) and cleared, but **nothing ever
adds to it**. The spec's failure-handling rule ("a failed scatter cell is discarded and
deterministically regenerated on a later update") has no implementation: if
`generateScatterCell` throws (it calls the terrain evaluator, which can throw on a bad recipe),
the exception propagates out of `update()` into the renderer frame. Either populate `failed`
from a try/catch around generation with a retry counter, or delete the dead set.

### 1.5 Overflowed scatter cells thrash every frame — `src/render/terrestrial/scatter.ts:341-346`

When a cell's instances don't fit in pool capacity, the cell is deleted "and retried later from
its stable seed". But the retry is *next frame*: the streaming loop immediately regenerates the
deleted cell (calling the terrain evaluator for up to 24 instances), it overflows again, and is
deleted again — an every-frame generate/discard loop for as long as the camera stays put while
pools are full. With current tier numbers (~130 cells × ~17 instances ≪ 12 288 capacity)
this shouldn't fire in practice, which is exactly why it will go unnoticed until a tier or
density change makes it fire everywhere. Track overflowed keys with a cool-down (or reuse the
`failed` set from §1.4 with a retry-at-frame number) instead of deleting the cached cell.

### 1.6 "Triplanar" surface detail isn't triplanar — `src/render/terrestrial/surfaceMaterial.ts:297-304`

`triplanarSurfaceDetail` samples the sinusoid field **once** (no per-axis projections) and then
"weights" the gradient with `gradient *= (w.x + w.y + w.z)` — the blend weights sum to exactly
1.0, so this is a multiply by one. The comment ("Triplanar weighting keeps detail anchored to
geometric axes on steep faces") describes behavior the code does not have; the CPU twin
(`sampleSurfaceDetail`) has no triplanar term either, so at least CPU/GPU agree. Since the
wavevector field is 3-D and periodic, it genuinely doesn't stretch on slopes, so the *visuals*
may be acceptable — but then the function, its comment, and the `docs/RENDERING.md` claim of
"local triplanar detail" should be renamed/reworded, or real triplanar projection implemented.
Dead math in a fragment shader also costs the `pow(abs(n), vec3(4.0))` per fragment for
nothing.

### 1.7 GPU timer can report a disjoint-spanning sample as valid — `src/render/gpuTimer.ts:107-117`

`poll()` reads `GPU_DISJOINT_EXT` (which *clears* the flag) and marks only **pending** slots for
discard. A query that is currently active (begun, not yet ended) while the disjoint event
occurs is not pending yet; by the next `poll()` the flag has been cleared, so that sample is
later counted valid. The spec's certification gate ("samples … discarded whenever the WebGL
disjoint flag is set") leaks this one case. Fix: when a disjoint read returns true, also set a
"taint next end" flag so the active slot is marked `discardAsDisjoint` when `end()` runs.

### 1.8 Broken worker slots stay in the rotation — `src/render/terrain/chunkWorkerPool.ts:160-168`

`fail()` rejects the dispatched job but keeps the worker in `slots` and immediately re-dispatches
to it. A worker whose module failed to load (or that crashed) will eat every job routed to it,
serially rejecting them; `PlanetRenderer.requestChunk` swallows the rejection and re-requests
next frame, so a single dead worker converts into a permanent stream of failed chunk builds on
that slot with no log, no replacement, no backoff. Terminate-and-respawn the worker on error
(bounded retries), and surface repeated failures through the render-failure tracker so the F3
overlay shows it.

### 1.9 Minor correctness nits

- `src/render/terrestrial/coverageDither.ts:15` — `role === 'compact' ? 0 : 0` is a dead
  ternary; both roles initialize to 0 (which happens to be correct for both). Write `0` with a
  comment, or initialize compact to 0 / terrain to 0 explicitly per predicate.
- `src/render/terrestrial/scatter.ts:329` — `pools.find(...)` result asserted with `!` before
  the capacity check that would make it safe; reorder or use a `Record<ScatterClass, ScatterPool>`.
- `src/sim/scatterRecipe.ts:201` — cell `seed` is validated as a non-negative integer but not
  `≤ 0xffffffff` despite the "must be a uint32" comment; `qRadius`/`qHeight` have no upper
  bound. Tighten before the artifact format is frozen by save-compat.
- `src/render/worldScene.ts:431-437` — when there is no active vessel the method returns after
  clearing state, leaving previously-updated body renderers visible with stale camera-relative
  positions for however many frames that state lasts.

---

## 2. Performance

The local smoke run in `PERFORMANCE.md` already shows the symptom: **terrain schedule/install
p95 = 3.69 ms against a 2 ms allocation** while everything else is inside budget. The items
below are the main-thread costs in exactly that path, plus per-frame allocation churn that will
show up as GC spikes on the reference journeys.

### 2.1 Decal cells are regenerated from the terrain evaluator every frame — `src/render/terrestrial/surfaceEffects.ts:204-252`

Unlike `TerrestrialScatter`, which caches generated cells, `updateDecals` walks the full grid
(~81 cells at Medium: `ceil(70/22)` → 9×9) and calls `generateDecalCell` for **every cell,
every frame**. Each generated decal calls the `SurfaceSampler`, which is three
`evaluateRecipeHeight` evaluations (height + two gradient probes,
`terrestrialBodyRenderer.ts:56-58`). That is on the order of 250+ full terrain-recipe
evaluations per frame near the ground, before the camera even moves. On top of that the inner
loop allocates `new THREE.Quaternion()` (line 237) and `new THREE.Color()` (line 242) per decal
per frame, and a fresh `Set<string>` of stringified keys.

**Fix:** cache decal cells exactly like scatter cells (they are deterministic by construction),
only generate on first sight, and hoist the quaternion/color temporaries. This is the single
biggest per-frame win in the new code.

### 2.2 Full recipe deep-clone + freeze per chunk request — `src/render/planet.ts:531-560`

`chunkRequest` rebuilds a frozen snapshot of the entire `BodyFeatureRecipe` — including mapping
and freezing **every crater record** — for every requested chunk, up to `buildBudget` times per
frame, and then `postMessage` structured-clones it again. The recipe is immutable per
generation by design; snapshot it once per `(body, generation)` and reuse. For a crater-heavy
Palla recipe this loop is O(craters) × builds × frames of pure garbage.

### 2.3 Stat-only string churn in the LOD hot path — `src/render/planet.ts:150-168, 395`

`countLodOverlaps` runs every frame over every wanted chunk, doing `key.split(':')`,
`Number(...)` parses, and up-to-16-deep ancestor key reconstruction with `toFixed(6)` template
strings — purely to feed an overlay statistic. Compute it only when the perf overlay is open,
or restructure keys as packed integers. Similarly `selectNode` allocates a `Vec3` per child
node (line 472) and a `Set` per recursion level (line 494), and `faceToDir` does a linear
`FACES.indexOf(face)` per call (line 71). None of these matters alone; together they are the
scheduling cost the smoke run flagged.

### 2.4 Per-frame allocation churn in `WorldScene.update` — `src/render/worldScene.ts:445-461, 516-524, 579, 603`

Each frame allocates: `east`/`north`/`camOffset` Vec3s, a `stableFrame` clone of seven objects
**per considered body** (~6 bodies → ~2 500 small objects/sec at 60 FPS), a `THREE.Vector3` per
vessel for the CoM offset, two `THREE.Vector3`s for the launch-site quaternion, and a
`THREE.Color` per frame inside the atmosphere tint. The file already demonstrates the right
pattern with its module-level `_camAbs`/`_rel` scratch vectors — extend it. For `stableFrame`,
keep one mutable frame object per body id in `lastBodyFrames` and copy into it instead of
spreading a new one.

### 2.5 Double startup of the entire terrestrial stack — `src/render/terrestrialBodyRenderer.ts:106, 111-123`

The constructor calls `buildStack(null)` (fallback textures, a full `PlanetRenderer`, and a
`TerrainChunkWorkerPool` spawning up to 4 module workers), and the manager transaction then
calls `stageAssets(pack)` which does `releaseStack()` (terminating those workers) and
`buildStack(pack)` (spawning 4 more). Every renderer creation/quality change pays worker
spawn + terminate twice. Either defer pool creation until first terrain update, or make
`stageAssets` swap materials/textures in place instead of rebuilding the world.

### 2.6 Smaller items

- `src/render/planet.ts:607-619` — `evictStale` copies and sorts the whole chunk map every
  frame the cache is over cap; a partial selection (or a "dirty since last evict" guard) avoids
  the O(n log n) steady-state.
- `src/render/terrestrial/scatter.ts:295-301` — retire scan does `key.split(',').map(Number)`
  per cached cell per frame; store the parsed coords on the cell record.
- Scatter, decals, and dust all set `frustumCulled = false`, so all pools are submitted every
  frame even when the camera looks straight up. The instances are camera-centered so culling
  rarely helps — fine — but the decision deserves a comment so nobody "fixes" it into
  per-frame bounding-sphere recomputes.
- `src/render/worldScene.ts:90-98` — `rendererGeometryBytes` traverses the renderer graph and
  is called during renderer adoption only; fine now, but don't let it creep into `renderStats()`.

---

## 3. Architecture

### 3.1 The physical-obstacle subsystem does not exist yet — spec §"Surface Scatter and Collision", plan Tasks 3-5

This is the largest "repo not finished" item. What exists: the versioned
`PhysicalScatterRecipe` (`src/sim/scatterRecipe.ts`) with a compiled, hash-validated Veyra
artifact, and save persistence of the scatter hash. What does not exist anywhere in `src/sim`:
the cube-face broadphase query, the activation radius
(`max(300 m, speed × (p99 + 2 s) + boundingRadius)`), hysteresis, contact resolution through the
impulse/damage path, rails-transition blocking, or the pool-pressure fault. Grep confirms no
consumer of `scatterRecipeForBody` in the flight step, and
`TerrestrialBodyRenderer.stats()` hardcodes `physicalProxies: 0, collisions: 0`
(`terrestrialBodyRenderer.ts:259-260`). Meanwhile the visual layer (grass/rocks) ships. The
danger is drift: the renderer's visual rocks are placed by a mechanism (see §3.2) that is
*not* the canonical recipe, so when obstacles do land, visual rocks and physical boulders will
disagree about where things are. Recommend implementing obstacles **before** further visual
tuning, or at minimum keeping the renderer's rock class visually distinct from future
collidable boulders.

### 3.2 Visual scatter ignores the canonical cell system it was specified to share

Spec: "Visual scatter may be culled by quality but **starts from the same canonical cells**"
(§Surface Scatter and Collision); `scatterRecipe.ts` even carries a per-cell `seed` documented
as "for deterministic visual-scatter regeneration at runtime" (`scatterRecipe.ts:50-52`).
The shipped `TerrestrialScatter` instead invents its own 16 m Euclidean 3-D grid keyed by
`hashCellSeed(bodySeed, cx, cy, cz)` and never touches the recipe, its cube-face cells, or its
seeds. Consequences: (a) two independent deterministic-placement systems to test and maintain,
(b) the recipe's visual `seed`/`visual` fields are dead weight in a hash-frozen artifact,
(c) §3.1's future obstacle placement cannot be made to coincide with today's visual rocks.
Either migrate visual scatter onto the recipe's cube-face cells now (cheaper before obstacles
land than after) or amend the spec deliberately and delete the unused recipe fields at the next
format version.

### 3.3 Docs contradict the shipped code — `RENDERING.md:76-78`, `STATUS.md:22-24`

`RENDERING.md` states "Regional triplanar materials, decals, dust, production scatter,
worker-built chunks … belong to the deferred Veyra surface phase and **are not claimed** by
this global stack", and `STATUS.md` says Veyra surface detail "is next" — yet the last three
commits (`feat: add Veyra regional surface materials`, `feat: compile canonical Veyra scatter
cells`, `feat: stream Veyra surface effects`) ship exactly those systems. The spec is explicit
that docs are "updated in the phase that invalidates their current claims" (§Delivery
Sequence). Update both files to describe the actual state: surface materials/scatter/effects
landed; physical obstacles, collision integration, and certification outstanding.

### 3.4 Duplicated geometry/orientation logic with no shared source of truth

- The detail period is defined twice: `DETAIL_PERIOD_METERS = 8192`
  (`chunkGeometry.ts:72`) and `SURFACE_DETAIL_PERIOD_METERS = 8192`
  (`surfaceMaterial.ts:16`). The anchor attribute produced by the first is consumed by GLSL
  generated from the second. If either changes alone, detail silently swims across chunk
  rebuilds — precisely the failure the anchors exist to prevent. Import one constant.
- The east/north tangent-basis construction is copy-pasted three times
  (`scatter.ts:257-265`, `surfaceEffects.ts:209-215`, `terrestrialBodyRenderer.ts:47-55`) with
  the same singularity handling. Extract one helper; a future fix to the degenerate-pole branch
  must not need three edits.
- The cell-walk + `Math.floor`-key streaming loop is duplicated between scatter and decals; a
  shared `forEachSurfaceCell(origin, radius, cellSize, cb)` would leave one tested
  implementation.

### 3.5 Dead abstractions and vestigial parameters

`renderedTerrainHeight(height, hasOcean)` (`planet.ts:114-117`) ignores its second parameter
via `void hasOcean` and returns its first — callers should just use the height.
`updateDust(..., localOrigin)` ends with `void localOrigin;` (see §1.2 — the parameter is
actually *needed* for the fix). `worldScene.ts:328-341` uses optional chaining on definite
readonly fields (`this.flightPromotionFailed?.delete`, `this.bodyRendererManagers?.get`),
which reads as author uncertainty and defeats TypeScript's null tracking. `setQuality`
(`worldScene.ts:191-194`) reverse-engineers a tier from `gridRes` thresholds — accept only
`QualityTier` and convert at the single legacy call site.

### 3.6 `transactionChannels` closure smuggling — `src/render/worldScene.ts:249-294`

`loadAssets` writes a captured `let transactionChannels` that `compileCandidate` later reads.
It works only because `BodyRendererManager` serializes transactions through its queue, but the
coupling is invisible at the manager's interface and will break silently if anyone adds a
parallel path. Return the channels as part of `LoadedRendererAssets` (the natural place — the
manager already threads that object through the transaction) instead of a shared mutable.

### 3.7 What's good (keep it this way)

`BodyRendererManager.transact` is genuinely careful: staleness asserts between every await,
correct disposal on every failure edge, and the resident-pack ledger handles the
same-assets/replaced-assets aliasing correctly. `CoverageTransition` cleanly encodes the
"fade clock starts at coverage, not load" rule. `parseScatterRecipe` is a model artifact
validator (sorted-unique enforcement, content-hash recheck). The chunk pipeline's
transferable-buffer protocol and generation tagging are right. The perf/telemetry honesty
(`residentPackGpuBytes` labeling, non-certifying smoke-run disclaimers) is rare and valuable.

---

## 4. Security

Threat surface is small (client-only game, no network I/O beyond same-origin assets), but two
items are worth fixing:

### 4.1 HTML injection through user-controlled names — `src/game.ts:386-387`

`showDialog` interpolates `title` and `text` into `innerHTML`, and callers pass user-controlled
data: `game.ts:355-358` includes `v.name` — the craft name typed into the editor's name field —
and crew names. A craft named `<img src=x onerror=...>` executes when the recovery dialog
shows. Today that is self-XSS; the moment craft files are shared between players
(`MODDING.md` explicitly contemplates content sharing), it becomes stored XSS delivered by a
craft file. `flightHud.ts:411` interpolates part-definition names (currently static content,
same sink). **Fix:** build these dialogs with `textContent`/`createElement` like the buttons
already do, or escape interpolations. Grep shows all other `innerHTML` uses are static
literals or `= ''` clears — only these interpolating sites need changes.

### 4.2 Craft files are parsed with almost no validation — `src/save/persistence.ts:461-471`

`readCraftFile` does `JSON.parse(json) as Craft` guarded only by `Array.isArray(craft.parts)`;
the result flows straight into the editor and then flight state. Malformed or hostile craft
JSON (again: shared-file scenario) can inject NaN masses, absurd part counts, or unexpected
fields into sim state. The save path has versioned schema handling — give craft files the same
treatment (validate part keys against `PARTS`, clamp numerics, length-limit names — which also
mitigates 4.1).

### 4.3 Note, not a bug

The scatter/terrain content hashes are FNV-1a — fine for integrity against accidental drift,
but not tamper-evidence. That matches their stated purpose; just don't let future features
treat these hashes as authentication.

---

## 5. Prioritized recommendations

| # | Item | Type | Effort |
|---|------|------|--------|
| 1 | Fix skirt winding on two edges (§1.1) | Visual correctness | Small |
| 2 | Cache decal cells; hoist per-decal allocations (§2.1) | Performance (known budget miss) | Small |
| 3 | Implement or explicitly re-plan physical obstacles (§3.1) | Spec completion | Large |
| 4 | Dust up-axis in tangent frame (§1.2) | Visual correctness | Small |
| 5 | Escape/`textContent` dialog interpolations; validate craft files (§4.1, §4.2) | Security | Small |
| 6 | Snapshot recipe once per generation; trim LOD-path churn (§2.2, §2.3) | Performance | Small |
| 7 | Replace dead workers on error with bounded retry (§1.8) | Robustness | Small |
| 8 | Unify visual scatter with canonical recipe cells, or amend spec (§3.2) | Architecture | Medium |
| 9 | Update `RENDERING.md`/`STATUS.md` to match shipped code (§3.3) | Docs (spec obligation) | Small |
| 10 | Share the 8192 m period constant and tangent-basis helper (§3.4) | Maintainability | Small |
| 11 | Wire or remove scatter suppression + `failed` set; fix overflow thrash (§1.3-1.5) | Correctness/robustness | Small |
| 12 | Rename or implement real triplanar detail; taint active GPU query on disjoint (§1.6, §1.7) | Honesty/measurement | Small |
| 13 | Reduce `WorldScene.update` and stable-frame allocations (§2.4) | Performance | Medium |
| 14 | Single-build terrestrial stack in `stageAssets` (§2.5) | Performance | Medium |
