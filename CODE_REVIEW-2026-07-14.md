# Perilune Staff-Level Production Readiness Review — 2026-07-14

**Reviewer stance:** adversarial pre-production audit, per request. Nothing was assumed good;
math, logic, architecture, security, memory, and documentation were all checked against the
actual code and against a live run of the game.

**Scope:** full codebase (`src/sim`, `src/core`, `src/render`, `src/ui`, `src/save`,
`src/cloud`, `server/`, `api/`, `supabase/`, docs), plus an empirical session against the dev
server (launch to the Veyra pad with render diagnostics enabled).

**Verification state at review time:**

- `npm run typecheck` — passes.
- `npm test` — **574/576. Two unit tests FAIL** (`tests/stage-partition.test.ts`
  "remaps both cursors through a three-stage serial split",
  `tests/action-groups.test.ts` split remapping). These are *not* the two
  environment-flaky Playwright specs; they are deterministic unit failures in core staging
  logic. The prior review (2026-07-12, `CODE_REVIEW.md`) recorded a green suite, so these are
  regressions introduced by the recent M2 multi-vessel/docking/split work.
- Live run: game boots, craft spawns on the pad, physics holds it stationary. Terrain
  streaming produced **zero chunks after 20+ seconds** in this environment (see §3.3) and the
  session began with `RenderBoundaryError: veyra/high/albedo asset load failed` until
  `sync:renderer-assets` was re-run (see §3.4).

**Verdict: not production-ready.** The simulation core is genuinely better than typical
AI-generated code — the math that exists is mostly right, and several hard problems
(deterministic terrain authority, transactional saves, RLS) are done properly. But the release
is blocked by: a red unit suite in core staging, vessels that can fly through planets on
rails, a launchpad that renders under the terrain by design (not by accident), a terrain
streamer that can stall forever with no watchdog and no user-visible failure, an auth endpoint
that mints unlimited auto-confirmed accounts when Redis is absent, and a documentation suite
that materially misdescribes the product.

---

## 1. Blockers (fix before any production tag)

### 1.1 Core staging regression — the unit suite is red

`GameState.fireStage` → `separatePartComponents` → `projectStages` /
`partitionActionGroups` ([state.ts:471](src/sim/state.ts:471), [vessel.ts:69](src/sim/vessel.ts:69))
no longer preserves stage plans and action groups across a vessel split:

- `stage-partition.test.ts:117` — after a three-stage serial split, the jettisoned lower stack
  comes back with **an empty stage list** (expected `[[lowerEngine]]`). A player who stages a
  serial rocket produces debris that cannot be staged/controlled as designed; if control ever
  transfers to a split-off segment, its remaining stages are gone.
- `action-groups.test.ts:53` — action-group assignments end up on the wrong side of a split.

This is the heart of the gameplay loop ("stage, separate, keep flying"). Do not ship with
these red. Bisect against the 2026-07-12 green state; the regression window is small.

### 1.2 Rails vessels never hit planets or atmospheres unless they are the active vessel

[state.ts:1171-1175](src/sim/state.ts:1171): during rails warp the
atmosphere/ground proximity check is gated on
`gv.runtime.id === this.activeVesselId`. Non-active rails vessels get **no impact, no
atmosphere entry, no destruction — ever**. Consequences:

- Debris and parked vessels with sub-surface periapses orbit *through* the planet analytically,
  visible in map view.
- Even for the active vessel the check samples only frame endpoints: at 10,000× warp a frame
  advances ~166 s of sim time, so a fast low pass over an airless moon (threshold
  `max(atmoTop, 2000 m)`) can be stepped over entirely.
- Same endpoint-sampling issue for rails SOI transitions
  ([state.ts:1132-1159](src/sim/state.ts:1132)): a moon encounter shorter than one warp frame
  is silently skipped, which players will read as "my flyby disappeared".

Fix: evaluate periapsis/atmosphere crossing analytically per rails orbit (you have the conic —
this is a closed-form check, not a sampling problem), and destroy or land vessels that
intersect terrain during warp.

### 1.3 The launchpad renders below the surface because there are three ground authorities

Physics is consistent: `contactSurface` ([terrain.ts:127](src/sim/terrain.ts:127)) includes the
pad deck, `spawnOnPad` uses it, the craft sits still (verified live: V/S +0.0 m/s at 5.54 km
site altitude). The *renderer*, however, draws the ground from three different sources, two of
which disagree with the deck height:

1. **Streamed recipe tiles** ([chunkGeometry.ts:153](src/render/terrain/chunkGeometry.ts:153))
   sample the exact sim recipe — but the pad clearance envelope
   ([terrain.ts:64-106](src/sim/terrain.ts:64)) guarantees deck-above-terrain only inside a
   **9.8 m footprint sampled at 0.5 m**. Coarse LOD tiles (depth < max) have vertices 50–500 m
   apart; where surrounding terrain is higher than the pad site (it is — the site is at
   ~5.53 km on a slope, not a local maximum), the interpolated chord across the pad passes
   **above the deck**. Until the finest LOD streams in, the pad is buried. On Medium/Low
   quality the finest depth is lower, so the pad can stay buried indefinitely.
2. **The compact fallback sphere** ([terrestrialBodyRenderer.ts:249-272](src/render/terrestrialBodyRenderer.ts:249))
   is a 48×32-segment sphere scaled to `radius + height(under the vessel)`. Two problems:
   (a) at Veyra's 1.0e6 m radius, mid-face chordal sag is up to ~3 km, so the rendered ground
   under any given point is wrong by kilometres; (b) the anchor follows the **vessel**, not the
   pad — fly over ground higher than 5.53 km and the pad (a fixed world object at deck height,
   [worldScene.ts:682-704](src/render/worldScene.ts:682)) renders below the emergency sphere.
   Given §1.4 (terrain frequently never arrives), this sphere is the de facto ground, so "pad
   below the surface" is the *expected* steady-state visual.
3. **The authored global material** on the compact sphere is color-only (no displacement
   channel is loaded — [terrestrialBodyRenderer.ts:95](src/render/terrestrialBodyRenderer.ts:95)),
   so its lit landforms don't correspond to the geometry of either other authority.

Recommended fix, in order of preference: bake the pad clearance **into the recipe itself**
(flatten a radius around Cape Skyward inside `evaluateRecipeHeight` — then every consumer,
every LOD, every fallback agrees by construction); prioritize a guaranteed max-LOD ring around
the launch site before showing terrain; anchor the compact sphere to
`max(vesselGroundHeight, padDeckHeight)` when the launch site is in view. The current
0.25 m clearance margin ([launchSite.ts:15](src/sim/launchSite.ts:15)) is also far too tight
for a mesh whose vertices don't sample the envelope's grid.

### 1.4 Terrain streaming can stall forever, silently

Observed live at `?quality=high`: `desiredLeaves: 1038, chunks: 0, coverageReady: false,
activeWorkers: 4, buildP99Ms: 0, framePressure: true` — for the entire session, with
**zero anomaly codes raised**. Contributing design defects, independent of this machine:

- **No job watchdog.** `TerrainChunkWorkerPool` ([chunkWorkerPool.ts:74-88](src/render/terrain/chunkWorkerPool.ts:74))
  has no timeout on dispatched jobs. A worker that hangs (or a module worker that fails to
  boot in a way that doesn't fire `onerror`) parks all four slots busy forever; the engine
  keeps reporting "pending" and the diagnostics system, which is otherwise obsessive, never
  raises an anomaly for "no build has completed in N seconds".
- **Admission/cancellation churn.** New requests are capped per frame
  ([planetTerrainEngine.ts:384-385](src/render/terrain/planetTerrainEngine.ts:384)), requests
  not re-touched within 5 frames are cancelled
  ([planetTerrainEngine.ts:525-552](src/render/terrain/planetTerrainEngine.ts:525)), and the
  re-queue loops are cut by a per-frame time budget
  ([planetTerrainEngine.ts:276-293](src/render/terrain/planetTerrainEngine.ts:276)). With
  ~1000 desired leaves the re-queue loop itself (per-tile `buildRequest` + bounding sphere +
  SSE math, every frame) is a significant frame cost, which raises `framePressure`, which
  shortens transition/budget windows — a feedback loop where being slow makes it slower.
- **framePressure is self-defeating.** `framePressure: dt > 1/45`
  ([worldScene.ts:654](src/render/worldScene.ts:654)) was true on an Apple-Silicon dev machine
  for the whole session. Anything gated on it (transition pacing) is effectively always in
  degraded mode, and nothing surfaces this to the player or telemetry as a problem.

At minimum: watchdog + anomaly on "N seconds with pending>0 and zero completions",
worker health check at pool construction, and a hard cap on desired leaf count at high
quality (1038 leaves × ~33² vertices is an absurd initial target for a first paint).

### 1.5 Auth: unlimited auto-confirmed account creation; rate limiting fails open

- [authHandlers.ts:39-48](server/authHandlers.ts:39): signup uses the **service-role admin API
  with `email_confirm: true`** — every signup is instantly confirmed with no email
  verification. Anyone can register `victim@example.com` and own that identity in your system;
  spam account creation is unbounded.
- [redis.ts:57-69](server/redis.ts:57) + [rateLimit.ts:24](server/rateLimit.ts:24): if
  `REDIS_URL` is unset, unreachable, or errors, `increment` returns `count: 0` and the limiter
  **allows everything**. Rate limiting is a silent no-op exactly when misconfigured — and
  nothing in startup verifies Redis is actually reachable.
- [authHandlers.ts:28-33](server/authHandlers.ts:28): the limit key is
  `hash(email + ip)` — rotating either identity resets the budget. There is no global per-IP
  or per-route cap, so credential-stuffing across many emails from one IP is effectively
  unlimited even *with* Redis healthy.

Fix: require email verification (or at least drop `email_confirm: true`), fail-closed (or
fail-with-alarm) when the limiter backend is down, add a per-IP envelope limit, and add a
startup config assertion that logs loudly when Redis is absent in production.

---

## 2. High severity

### 2.1 Near-parabolic orbits produce NaN/garbage — and the code that would handle them is dead

- [orbit.ts:89-90](src/core/orbit.ts:89): `|e−1| < 1e-10` sets `a = Infinity`. Then
  [orbit.ts:210](src/core/orbit.ts:210) computes `p = a·(1−e²)` = `±Infinity` (or
  `Infinity` at `e === 1`), so `elementsToState` emits Inf/NaN positions. A player burning to
  ~exact escape velocity hits this; downstream, NaN propagates into map view and prediction.
- `meanToTrue` at `e = 1` calls `solveKeplerHyperbolic` whose Newton derivative
  `e·cosh(H) − 1 → 0` near H=0 — division blow-up.
- `solveKeplerElliptic` ([orbit.ts:172-184](src/core/orbit.ts:172)) has no convergence
  failure signal; for e → 1 with E near 0 the Newton step `f/fp` degenerates and the function
  silently returns whatever the 32nd iterate was.
- `timeToTrueAnomaly` ([orbit.ts:250](src/core/orbit.ts:250)) wraps mean anomaly with
  `% TWO_PI` even for hyperbolic orbits, where mean anomaly is not periodic — the hyperbolic
  branch returns nonsense whenever `|M| > 2π`.
- The mitigation that PHYSICS.md and FEATURES.md advertise — *"universal-variable propagation
  (Stumpff functions) for arbitrary states"* — exists at
  [orbit.ts:285](src/core/orbit.ts:285) but has **zero callers in the product**
  (only the bench/tests). All runtime propagation goes through the singular classical-elements
  path. Either wire `propagateUniversal` into rails/prediction for `e ≈ 1`, or clamp
  eccentricity away from 1 and stop documenting the UV propagator as the mechanism.

### 2.2 Docking merge teleports the combined stack and discards angular momentum

`mergeVessels` ([state.ts:960-1032](src/sim/state.ts:960)) rebases B's parts into A's craft
frame and conserves linear momentum, but never moves `va.pos` to the merged center of mass.
Since flight code treats `v.pos` as the world position of the craft-local CoM point, the
entire merged stack shifts by `R·(comOld − comNew)` on the dock frame — metres of teleport for
a station-sized target. The stage-separation path does this recentering correctly
([state.ts:568-589](src/sim/state.ts:568)); the merge path simply lacks it. Angular velocity
of the target is also discarded wholesale (no angular-momentum bookkeeping).

### 2.3 Missing planet packs degrade to a broken world with no signal

Observed live: with `public/planets/` absent (it's a gitignored build artifact), the checked
manifest still says the pack exists, `PlanetAssetLoader.load` throws `RenderBoundaryError` at
runtime, the manager keeps the unlit procedural fallback, and the player gets a black planet
with no message, no retry UI (the `retryActiveBodyRenderer` hook exists but nothing calls it
from the UI), and no telemetry escalation. The "checked manifest" validates digests at build
time but nothing validates **file existence/reachability** at startup. For a static-host
deploy, one bad sync means every player silently gets the degraded world.

### 2.4 O(parts²) crossfeed graph rebuilt per engine per physics tick

`engineHasFuel` ([flight.ts:225-233](src/sim/flight.ts:225)) calls `crossfeedComponent`
([vessel.ts:309-336](src/sim/vessel.ts:309)), which rebuilds the full adjacency map and runs a
flood fill — then does `craft.parts.find(...)` (linear) per reached key. This runs per engine,
twice (has-fuel check + drain), 50 times per second, plus `maxThrust` from the HUD each frame.
For the advertised 500-part vessels this is O(n²)-ish work in the hottest loop in the game,
while PERFORMANCE.md's benchmark table measures everything *except* this path. Cache the
crossfeed component per engine and invalidate on geometry/decoupler change — the
`massDirtyCounter` pattern already exists for exactly this kind of thing.

### 2.5 Renderer lifecycle churn on SOI transition and quality change

- `setFlightTerrainOwner` ([worldScene.ts:410-430](src/render/worldScene.ts:410)) disposes the
  previous body's manager on SOI change — and the very same frame, the consider-loop calls
  `rendererFor(previousBody)` (it's still the parent/sibling) and rebuilds it from scratch,
  including async pack reload. Crossing Veyra→Palla tears down and reconstructs the Veyra
  renderer for no reason.
- Every `TerrestrialBodyRenderer.buildStack` spawns a **fresh 4-worker pool**
  ([terrestrialBodyRenderer.ts:151](src/render/terrestrialBodyRenderer.ts:151)) — and
  `stageAssets` (pack promotion, quality change, context restore) does a full
  `releaseStack`/`buildStack`, so workers and all fixed-pass GPU resources are recreated each
  time. Worker startup is tens of ms each plus module re-parse.
- `loadSlot` ([game.ts:510-521](src/game.ts:510)) throws away the entire `WorldScene`
  (KTX2 loader, starfield, every body renderer) on every quickload. F9 is supposed to be the
  fast iteration loop; this makes it the slowest path in the game.

---

## 3. Medium severity

### 3.1 Physics/math quality gaps (playable, but not the "credible physics" the docs sell)

- **No gyroscopic term**: rotation integration ([flight.ts:564-577](src/sim/flight.ts:564))
  omits ω×(Iω); spin-stabilized behavior and intermediate-axis effects don't exist.
- **Δv analysis over-credits drop-tank designs**: each stage burns its entire crossfeed pool
  ([vessel.ts:586-608](src/sim/vessel.ts:586)); tanks jettisoned by a later stage are counted
  as fully burnable now. "Crossfeed-aware stage simulation ✅" (FEATURES.md) is a half-truth.
- **Inertia tensor ignores part rotation** ([vessel.ts:281-295](src/sim/vessel.ts:281)) — a
  radially-mounted or rotated part contributes as if axis-aligned; also `radiusBottom ?? width`
  conflates diameter-ish fields.
- **Final-tick free thrust**: `drainPropellant` under-drains when the pool can't cover the
  request but the engine still applies full thrust that tick
  ([flight.ts:371-376](src/sim/flight.ts:371)).
- **Encounter scan can miss small SOIs**: 800 fixed samples over up to 3e6 s
  ([maneuver.ts:122](src/sim/maneuver.ts:122)) → 3750 s steps; Wisp-class SOI crossings
  shorter than a step are invisible to the planner. Also `prevInside` is declared and never
  assigned ([maneuver.ts:125](src/sim/maneuver.ts:125)) — dead logic.
- **Aero has no roll authority** ([aero.ts:238](src/sim/aero.ts:238)): control surfaces
  respond to pitch/yaw only; the "aircraft" milestone cannot bank with ailerons.
- **Accumulator cap = silent time dilation**: `min(accumulator, 0.5)`
  ([state.ts:744](src/sim/state.ts:744)) makes sim time quietly run slower than
  `realtime × warp` whenever frames are slow — combined with §1.4's persistent slow frames,
  warp ×4 may effectively be ×2 with no indication.
- `crashToleranceOfLowestPart` has an `x ? a : a` conditional
  ([flight.ts:835](src/sim/flight.ts:835)) — both branches identical; leg tolerance logic was
  evidently intended and never written.
- Module-singleton `stepResult` ([flight.ts:217](src/sim/flight.ts:217)) is shared across all
  vessels stepped in a frame; safe today only because callers consume it synchronously — a
  refactoring landmine, and new vessels pushed mid-iteration get stepped in the same loop pass
  over a mutated `this.vessels` array ([state.ts:828](src/sim/state.ts:828)).

### 3.2 Server hardening

- `readJsonBody` ([http.ts:40-58](server/http.ts:40)) buffers the entire body before checking
  the real size — `content-length` is trusted first and absent for chunked requests.
  Platform limits mitigate on Vercel; self-hosting (`vite preview`) has no such backstop.
- `clientIp` ([http.ts:73-76](server/http.ts:73)) trusts the first `x-forwarded-for` entry —
  client-forgeable off-Vercel, feeding the rate-limit identity.
- `requestId` echoes `x-vercel-id` into logs/responses unvalidated
  ([http.ts:19-21](server/http.ts:19)) — log-injection nuisance.
- Credit where due: the RLS policies are correct and complete, saves go through a
  user-token-scoped client (the service key is never used for saves), slot validation is
  strict, optimistic concurrency via revisions is right, and save payloads are re-validated
  server-side. This layer is in better shape than the auth layer.

### 3.3 Per-frame allocation and main-thread costs

For a codebase whose ADR-001 explicitly mandates allocation-free hot loops, the render loop
ignores the rule: `WorldScene.update` allocates ~10 `Vec3`s, a `THREE.Color`, quaternion
clones, and a deep-spread `stableFrame` object **per body per frame**
([worldScene.ts:543-585, 658-669, 734, 763](src/render/worldScene.ts:543)). Autosave
serializes the whole game on the main thread every 2 minutes ([game.ts:1022-1026](src/game.ts:1022)).
Comms re-evaluates a graph every 500 ms (fine). The editor "Parts 0 / LAUNCH does nothing"
silent no-op observed live is a papercut worth a toast.

### 3.4 Asset pipeline trust chain has a hole at the ends

The middle of the pipeline (digest-checked manifest, atomic publish, container-pinned
compiler) is genuinely good. But: dev/prod runtime never verifies the packs are *present*
(§2.3), and the authored global albedo (Natural Earth II-derived) is only loosely coupled to
the procedural recipe the geometry uses — the compiler does consume `heightAt`
([veyra-global-maps.ts](scripts/lib/veyra-global-maps.ts)), but nothing asserts coastline
agreement between the baked ocean mask and `oceanLevel`-derived recipe coastlines, so
orbit-vs-surface continent mismatch is unvalidated.

---

## 4. Documentation vs. reality (the .md rot, itemized)

| Doc claim | Reality |
|---|---|
| PHYSICS.md: active bubble = "neighbors within 20 km" | 2.5 km to wake, 4 km to sleep ([state.ts:817-820](src/sim/state.ts:817)) |
| PHYSICS.md / FEATURES.md: "universal-variable propagation … for arbitrary states" as the propagation mechanism | `propagateUniversal` has no production callers; all propagation is classical Kepler (§2.1) |
| FEATURES.md: "Part catalog (44 orig. parts)" | ~57 part definitions in `src/content/parts.ts` |
| FEATURES.md: transfer planner, alarms, entry prediction listed under "Scheduled (M2–M5)"; time-warp row says "No warp-stop alarms yet" | All three are implemented and tested (`src/sim/transfer.ts`, `src/sim/entry.ts`, alarms with warp interlock in `state.ts`) — FEATURES.md was never updated for M2 slice 6 |
| FEATURES.md: no rows at all for docking, comms, ISRU, wheels/rovers | All implemented (M2 slices 1–5) with tests |
| PERFORMANCE.md M0 conclusions: "Workers: not required at current scale" | The shipped terrain engine spawns a 4-worker pool per renderer build |
| PERFORMANCE.md: "CI target: `npm run bench` must stay within budgets; regressions fail review" | CI runs bench, but nothing enforces the frame-budget table; the hot path §2.4 is unmeasured |
| [state.ts:210](src/sim/state.ts:210) comment: "launch pad of Veyra (Cape Skyward, lon 0)" | `LAUNCH_SITE_LON = 2.4584…` |
| CODE_REVIEW.md (2026-07-12): "npm test → 367/368 pass" | Suite is now 576 tests with 2 deterministic failures — the doc is a stale snapshot presented as current state |
| README.md: presents M1 as the current scope | Half of M2 has shipped; README's own feature list and controls table omit docking/rover/ISRU keys |
| ACCESSIBILITY.md / MODDING.md | Honest about being aspirational — fine as-is, but 16 and 14 lines respectively; don't count them as documentation coverage |

The good news: the ADRs in ARCHITECTURE.md match the code (log-depth buffer, WebGL2-only,
floating origin, f64 SOI-relative state all verified), and RENDERING.md's terrestrial-stack
description is accurate. The rot is concentrated in FEATURES.md, PHYSICS.md's bubble/propagation
claims, and PERFORMANCE.md's conclusions.

---

## 5. What is actually good (keep it)

- **Single terrain authority** shared by physics and the tile builder is real
  (`evaluateRecipeHeight` is the only height source for both) — the launchpad bug is a
  *sampling/LOD* mismatch, not a dual-authority mistake, and the fix is tractable.
- Quaternion/vector math primitives are correct (Hamilton products, exact exponential-map
  attitude integration, frame transforms verified by hand).
- Save system does what it claims: round-trip validation before write, backup rotation,
  corrupt-primary fallback ([persistence.ts:400-450](src/save/persistence.ts:400)).
- Supabase RLS + user-scoped tokens + revision-based concurrency on saves.
- The 2026-07-12 review's fixes actually landed (skirt winding now has the `flip` parameter) —
  review feedback is being absorbed.
- Honest diagnostics culture (anomaly codes, terrain lifecycle events, GPU timer ring) —
  ironically what made this audit's live findings easy to confirm.

## 6. Recommended gate order

1. Fix the two failing unit tests (staging/action-group splits). **Gate: green suite.**
2. Rails impact/atmosphere handling for all vessels + analytic periapsis check under warp.
3. Launchpad: recipe-level pad flattening + LOD priority ring + compact-sphere pad clamp.
   **Gate: an e2e that asserts deck-above-rendered-terrain across all quality tiers.**
4. Terrain watchdog + anomaly on zero-completion stalls; cap desired leaves; profile and cut
   the per-frame scheduler overhead. **Gate: time-to-coverage < 5 s on Medium hardware tier.**
5. Auth: remove auto-confirm, fail-closed limiter, per-IP cap, startup config assertions.
6. Near-parabolic handling in `core/orbit` (clamp or wire in `propagateUniversal`) + docking
   CoM recentering.
7. Crossfeed caching in the 50 Hz loop.
8. One pass over FEATURES.md / PHYSICS.md / PERFORMANCE.md to match shipped reality; delete or
   date-stamp CODE_REVIEW.md.

Items 1–5 are the production blockers; 6–8 should follow within the same milestone.
