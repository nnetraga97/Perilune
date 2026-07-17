# Reentry VFX — Design & Feasibility

**Date:** 2026-07-17
**Status:** Draft for review (planning only; no implementation yet)
**Branch:** `feature/reentry-vfx` (worktree `perilune-reentry-vfx`)

## 1. Goal

Give Perilune atmospheric-entry visual effects of the quality of the KSP mod
[Firefly](https://github.com/M1rageDev/Firefly): hull-conforming plasma glow,
streaked trails swept behind the craft, a bowshock ahead of it, and spark/ablation
particles — driven by the simulation's real aero/thermal state and configured
per planet.

This is an **original implementation** of the underlying technique from
Leah Lindner's public paper ([Atmospheric Entry](https://leah-lindner.com/blog/atmospheric-entry/)),
which Firefly itself credits as its basis. Firefly is used as an
architectural and behavioral reference only. No Firefly code (GPL-3.0), shader
text, config values, or assets (All Rights Reserved) are copied or translated.
This keeps the `LICENSES.md` "all original work" position intact.

## 2. Reference architecture (what Firefly does, in our own terms)

Understanding derived from the paper's published method plus observation of the
mod's behavior:

1. **Envelope geometry.** Each part's mesh is redrawn slightly inflated with an
   effect material; the union of inflated part meshes is the "envelope" that
   the plasma appears on.
2. **Airstream occlusion map.** A small orthographic camera looks at the vessel
   *along the airflow direction* and renders a depth map (512², depth-only).
   Effect shaders sample it like a shadow map, so surfaces shielded from the
   airflow (behind a heat shield, inside a stack) receive no plasma.
3. **Three passes over the envelope:**
   - *Glow* — plain vertex/fragment pass; intensity ≈ windward facing
     (`dot(normal, airflow)`) × occlusion × entry strength, colored along a
     white → warm-glow → hot-glow ramp (the paper frames this as extra
     directional light along the movement vector).
   - *Trails* — a geometry shader extrudes noise-lengthened, streak-colored
     fins from windward rim triangles backward along the airflow, in two
     layers (core trail + a wider "wrap" layer).
   - *Bowshock* — a geometry shader builds a detached luminous "bowl" and
     side-swept wisps slightly upstream of the craft (the paper's "air
     cushion" forward projection of front-facing polygons).
4. **Driving scalar.** One smoothed `entryStrength` value computed from the
   engine's aero state (density/velocity FX scalar plus dynamic pressure),
   with thresholds that gate each subsystem (draw at all → bowshock →
   particles).
5. **Per-planet configuration.** A default color/parameter set plus overrides
   per body: glow, hot glow, trail primary/secondary/tertiary, streak, wrap
   layer, shockwave colors; strength/length/opacity multipliers; particle
   threshold; streak probability.
6. **Particles.** Sprite-based sparks, smoke, and debris chunks spawned above
   a strength threshold.
7. **SDR fallback.** The mod pre-multiplies alpha and dithers when HDR is
   unavailable — evidence the effect reads well without a bloom pipeline.

## 3. Perilune integration inventory

What the codebase already provides (verified against source):

| Need | Where it exists |
|---|---|
| Airspeed-derived physics | `src/sim/aero.ts` — `AeroForces` carries `dynamicPressure`, `mach`, `aoa`, `heatFlux` (0.5ρv³), `flowAlign` (+1 nose-first / −1 tail-first) |
| Per-part heating model | `src/sim/flight.ts` `stepThermal` — per-part `temperature`, exposure from `flowAlign` × `axialFrac`, heat-shield ablator behavior |
| Vessel visual assembly | `src/render/vesselMesh.ts` — per-part holders under one group, `craftVersionSeen` rebuild trigger, plume attach pattern |
| Procedural-GLSL effect pattern | `src/render/engineEffects.ts` — `ShaderMaterial`, `toneMapped:false`, additive blending, hash-based noise, `logdepthbuf` includes, shared materials with global uniform update |
| Particle pool pattern | `src/render/srbSmoke.ts` — quality-tier budgets, f64 inertial sim → camera-relative f32 points, point-sprite shader |
| Quality tiers | `QualityTier` (`low`/`medium`/`high`) with per-tier budgets (see `srbSmoke.ts` `BUDGETS`) |
| Shader validation | `src/render/shaderCompiler.ts` — isolated `compileAsync` with `RenderBoundaryError` |
| GPU profiling | `src/render/gpuTimer.ts` — EXT_disjoint_timer_query wrapper |
| Per-body visual registry | `src/content/bodyVisuals.ts` — `BodyVisualDef` with art-direction-only fields, deliberately separate from sim body defs |
| Frame budget governance | `PERFORMANCE.md` — 8 ms render slice; tiers target 100–150 parts baseline |

Frame-loop integration point: `worldScene.ts` already computes `pressureFrac`
per vessel and calls `syncVesselVisual(...)`; the reentry update slots into the
same loop with access to `rv` (runtime vessel: `vel`, `att`, `aero`, `craft`).

## 4. Blockers and constraints (the deep dig)

### B1 — WebGL2 has no geometry shaders (hard blocker for a port; solved by design)

Firefly's trail and bowshock passes are geometry shaders. WebGL2 offers none,
and no extension provides them.

**Resolution: precomputed fin geometry + vertex-shader extrusion** (the
established GS replacement — same family as AMD TressFX hair and WebGL
shells-and-fins fur). At vessel build time we generate, per candidate envelope
triangle, a static fin strip (6 vertices, 4 triangles, two layers → 12
vertices) with attributes: base position, base normal, triangle centroid
normal, trail parameter (0 / 0.5 / 1 along the fin), side sign, and a
per-fin random seed. Each frame the vertex shader decides eligibility
(windward test + occlusion) and either extrudes the fin along −airflow with
noise-driven length, or collapses it to a degenerate triangle (zero area →
zero fragment cost). Firefly itself uses collapse-instead-of-cull inside its
geometry shader for driver compatibility, so the visual model is proven.

Consequence: fin buffers are **static per craft version**; all animation is
uniform-driven. No transform feedback, no per-frame buffer uploads for
geometry.

**The bowshock is covered by the same two buffers — no new topology.** Its
two visual components map onto vertex-shader-feasible draws:

- *Bowl* (the detached shock surface): a second draw of the **merged envelope
  geometry** whose vertex shader offsets every vertex upstream along the
  airflow by `offset ≈ k·strength·airflowOS` before projection. This is a pure
  per-vertex transform of existing topology (the reference effect's bowl is
  likewise a constant upstream offset of windward triangles). Eligibility
  (windward facing, occlusion) feeds per-vertex alpha; fragments below the
  alpha floor `discard`, so leeward regions cost near zero despite being
  submitted.
- *Wisps* (side-swept streamers at the rim): a second draw of the **fin
  buffer** with an alternate extrusion rule selected by material uniforms —
  extrude outward along the anchor normal and slightly upstream, eligibility
  window restricted to the rim band (near-tangent `dot(normal, airflow)` plus
  a fresnel-like view term). Every vertex of a fin carries that fin's anchor
  attributes (see above), so eligibility evaluates identically across the fin
  and ineligible fins collapse to true zero-area degenerates, exactly like
  trail fins.

Degenerate-state contract for both draws: ineligible or below-threshold
geometry must reach zero fragment cost (degenerate collapse for fins,
alpha-floor `discard` for the bowl) and the whole pass is skipped CPU-side
below the bowshock strength gate `s₂`. Budget: the bowshock adds **two draw
calls and zero bytes of new geometry** (both draws reuse the envelope and fin
buffers with different materials); its GPU cost is overdraw-bounded and
counted inside the ≤ 1 ms GPU target in B9.

### B2 — Envelope triangle count must be budgeted

Fin vertex count scales with envelope triangle count. Imported NASA-style part
models have arbitrary density and hard edges (bad trail sources). Procedural
part primitives (`def.shape` — cylinder/cone/capsule/dome/box) exist for
**every** part def as the fallback visual.

**Resolution:** the envelope always uses the procedural primitive shapes, even
when the visible part uses an imported model. Benefits: bounded, smooth-normal,
convex-ish geometry (exactly what the effect wants — Firefly ships hand-made
simplified envelope meshes for complex crafts for the same reason); shared
`geoCache` reuse; no dependency on model library residency.

**The envelope must also include runtime-derived shrouds.** Interstage shrouds
are the one piece of vessel geometry that does *not* come from
`craft.parts × def.shape`: `deriveInterstageShroud` (live, inactive
separators) and the latched `sanitizeInterstageShroudSpec` produce an
`InterstageShroudSpec` (`lowerRadius`, `upperRadius`, `lowerY`, `upperY`)
rendered as an annular shell by `buildInterstageShroud`. The envelope builder
consumes **the same spec source as the visible mesh** and merges a
low-tessellation shell proxy (lathe of the same profile, effect-grade radial
segments) into the envelope, transformed by the owning separator part. Shroud
proxies participate in **all** effect passes: they occlude in the Phase 3
depth pass (an enclosed engine reads as shielded) *and* they receive glow and
trails themselves (a fairing visibly burns during entry). Because the builder
reads the identical spec-derivation path as `buildPartMesh` and rebuilds on
the same craft-version bump, the effect envelope cannot drift from the visible
shroud state. No other non-`def.shape` geometry exists in the vessel visual
(imported models are approximated by their part primitives by design), so
this closes the occluder inventory.

Phase 1 caveat, stated openly: the CPU exposure model (`flowAlign` ×
`axialFrac`) has no shroud knowledge — but neither does the sim's own
`stepThermal`, so Phase 1 glow is exactly as right or wrong as the
authoritative thermal model. The *visual* shielding claim attaches to
Phase 3 only, where the depth pass (with shroud proxies) provides it.

With envelope tessellation capped (radial segments ≈ 12 for effect purposes):

- ~50–160 triangles per part ⇒ 150-part vessel ≈ 8–20 k envelope triangles.
- Fin buffer ≈ 12 verts/tri ⇒ ~100–240 k static vertices ≈ 4–10 MB once per
  craft version. Acceptable as a High-tier ceiling; Low/Medium tiers cap fins
  per part (largest-area triangles first) at build time.

A merged-geometry design (below) keeps draw calls flat regardless of part count.

### B3 — No render-target infrastructure exists yet (airstream depth map)

`grep` confirms zero `WebGLRenderTarget`/`DepthTexture` usage in `src/render`.
The occlusion map would be the first off-screen pass in the project — new
ground, but standard three.js: a depth-only `WebGLRenderTarget` (512²,
`DepthTexture`), an `OrthographicCamera` aimed along −airflow, fitted to the
vessel bounds (Firefly clamps ortho size and far plane to vessel bounds), and
`THREE.Layers` so only the active vessel renders into it. WebGL2 guarantees
depth textures and allows hardware PCF via `sampler2DShadow`.

**Cost:** depth-only pass over ≤ ~20 k envelope triangles at 512² — well under
0.5 ms on entry-level desktop GPUs; the render-pass switch itself is the main
cost on tiled mobile GPUs.

**De-risking:** the sim *already* provides a CPU occlusion approximation —
`flowAlign` + per-part `axialFrac` (`stepThermal`'s exposure term). Phase 1
drives glow from that alone (baked `axialFrac` as a vertex attribute,
`flowAlign` as a uniform — zero per-frame uploads), so the depth map is an
*enhancement* (adds shroud/fairing shielding and per-pixel fidelity), not a
prerequisite. If it underperforms on mobile it is a tier-gated feature.

### B4 — No HDR pipeline, no bloom, ACES tone mapping

The paper assumes HDR + bloom. Perilune renders directly to the drawing buffer
(SDR8) with ACES tone mapping; there is no `EffectComposer` anywhere, and
engine plumes deliberately opt out of tone mapping (`toneMapped:false`) with
additive blending.

**Resolution:** follow the plume pattern — additive, `toneMapped:false`,
intensity carried in hand-tuned color values, plus Firefly's own SDR tricks
(pre-scaled alpha, subtle dither to fight banding on smooth glows). Optionally
a cheap camera-facing "hot core" billboard adds apparent bloom at distance.
**Adding a bloom/composer pipeline is explicitly out of scope** — it would
re-plumb the entire render path, tax the mobile tier, and destabilize e2e
baselines for one effect.

### B5 — License hygiene (GPL-3.0 reference, ARR assets)

- No HLSL translation: implementation is written from **this document's**
  technique description and the paper, not from Firefly's shader text.
- No Firefly numeric constants or config color values; all parameters re-tuned
  for Perilune's bodies and tone mapping.
- No Firefly textures: noise is procedural (hash/value noise in-shader,
  matching the plume/smoke house style), sprites are procedural point-sprite
  shading like `srbSmoke.ts`. This also sidesteps the All-Rights-Reserved
  asset restriction entirely.
- `ATTRIBUTIONS.md` gains a credit: technique informed by Leah Lindner's
  atmospheric-entry paper; Firefly acknowledged as prior art/inspiration.
  No code provenance from either.

### B6 — Floating origin & f64/f32 (ADR-003)

All effect geometry is parented under the vessel group, i.e. vessel-local and
automatically camera-relative — no precision hazard. The only frame-sensitive
input is the airflow direction: compute **airspeed** (inertial velocity minus
local atmosphere rotation, via `surfaceVelocity` in `bodyOrientation.ts`) in
f64 sim space, rotate into vessel-local space CPU-side, pass as a uniform
(Firefly's `velocityOS` equivalent). The airstream camera is positioned
vessel-locally too.

### B7 — Logarithmic depth buffer

Every custom material must include the `logdepthbuf` shader chunks —
established pattern in `engineEffects.ts` and `srbSmoke.ts`. Trails/bowshock
render with depth *test* on, depth *write* off, so log-depth must be emitted in
the fragment stage exactly as the plumes do.

### B8 — Transparent ordering

Existing contract: atmosphere composites at `renderOrder` 40, engine plumes at
51 (`frustumCulled = false`). Reentry passes slot alongside plumes:
glow 50, trails 51, bowshock 52 (exact values tuned during implementation).
Fins extend beyond part bounds ⇒ `frustumCulled = false` on effect meshes,
like plumes. Additive blending makes intra-effect draw order mostly
irrelevant — no per-fragment sorting needed.

### B9 — Frame budget & draw calls

Budget: effect must fit inside the existing 8 ms render slice without
displacing terrain/atmosphere work; target **≤ 0.5 ms CPU + ≤ 1 ms GPU** on
the baseline desktop tier at strength 1.

Design consequence — merge, don't multiply: unlike Firefly (per-part command
buffer draws), all envelope geometry for a vessel is merged into **one**
`BufferGeometry` at build time (part transforms baked into vertices; per-part
scalars baked as attributes). Result per vessel: 1 glow draw + 1 trail-fin
draw + 2 bowshock draws (bowl reuses the envelope buffer, wisps reuse the fin
buffer — see B1) + (Phase 3) 1 depth-pass draw. Rebuild triggers reuse the
`craftVersionSeen` mechanism (parts are static between version bumps; staging
and part loss already bump it).

Overdraw is the real GPU cost (large additive fins at high strength). Controls:
fin count per tier, trail length clamp, alpha floors that `discard` early
(plume pattern), and the strength gate (nothing draws below threshold —
Firefly gates at trivially low strength; ours gates on the smoothed scalar).

Rebuild cost for a 150-part craft (merge ~20 k tris + generate fins) is a few
milliseconds — acceptable on the infrequent craft-version bump; can move to
idle/async if profiling demands (same option already noted for terrain builds).

### B10 — Driving signal & sim/render boundary

The sim must stay authoritative and unmodified (`CLAUDE.md`: rendering consumes
simulation authority). The effect is driven by a render-side **smoothed entry
strength** `s ∈ [0,1]`:

```
raw  = clamp01(heatFlux / FLUX_REF)            // FLUX_REF calibrated so s≈1 at
                                               // heat-shield-mandatory entries (~2.8 km/s at Veyra)
s   += (raw − s) · (1 − e^(−k·dt))             // adaptive k, faster when |raw−s| is large
                                               // (mirrors Firefly's adaptive lerp behavior)
```

plus a **transonic state** for white mach-cone effects at low heat (Firefly's
FxState analog; sim already provides `mach` and `aoa`). This must be a
**band-pass**, not a one-sided ramp — a `smoothstep` that saturates above the
band would keep full mach effects on during ordinary supersonic and
hypersonic flight:

```
band = smoothstep(0.75, 1.05, mach) · (1 − smoothstep(1.35, 2.5, mach))
m    = band · smoothstep(Q_LO, Q_HI, dynamicPressure) · (1 − s)
```

The exact constants are tuning values; the *shape* is normative: an explicit
falloff above the transonic range, a dynamic-pressure gate so near-vacuum
hypersonic flight (high Mach, negligible q at the atmosphere boundary) never
triggers it, and suppression by entry strength `s`. Required unit cases:
subsonic (`m = 0`), Mach ≈ 1 at meaningful q (`m` peaks), Mach 2+ (`m → 0`),
and hypersonic thin atmosphere (`m = 0` via the q gate).

Thresholds gate subsystems: glow > s₀, trails > s₁,
bowshock > s₂, particles > s₃ — all Perilune-tuned constants.

Per-part glow weighting reuses the sim's own exposure model:
`exposure(part) = 0.15 + 0.85·(w·f² + (1−w)·(1−f)²)` with `w = (1+flowAlign)/2`
and `f = axialFrac(part)` — identical shape to `stepThermal`, so what glows is
what the sim heats. Part temperature itself is *not* consumed in Phase 1
(avoids per-frame attribute uploads); revisit if glow persistence after
deceleration is wanted.

### B11 — Multiple vessels & debris

Reentring debris and non-active vessels exist in the same scene loop. Firefly
runs effects for every loaded vessel; Perilune v1 is **active-vessel-only**
(decision §8.1): one effect instance, one lifecycle, the depth pass never
multiplies. A glow-only variant for non-active vessels within physics range
(cheap: 1 draw, no depth pass) is a noted future extension, deliberately out
of v1 scope.

### B12 — Testing & determinism

- Unit (Vitest): strength/threshold mapping, the transonic band-pass matrix
  from B10 (subsonic / Mach ≈ 1 / Mach 2+ / hypersonic-thin-atmosphere),
  fin-builder geometry invariants (counts, degeneracy, attribute ranges)
  including shroud-proxy inclusion, and config validation of per-body
  palettes.
- Canonical shrouded-stack shielding test (Phase 3 gate): a stack with an
  inactive interstage shroud enclosing an engine enters nose-first; assert via
  render diagnostics that the enclosed parts' effect contribution is
  suppressed by the depth pass while the shroud itself is effect-active.
- e2e (Playwright): extend the existing render-diagnostics pattern — assert
  effect draw counts/active flags during a scripted Veyra entry rather than
  screenshots (two specs are already flaky in this sandbox; animated additive
  noise would make screenshot baselines worse). All noise is a pure function
  of `effectTime` (already threaded through `syncVesselVisual`), so a frozen
  clock yields deterministic frames if a visual baseline is ever wanted.
- Shader compile: run new materials through `shaderCompiler.ts` validation at
  startup/tier change, consistent with body renderers.
- Perf: `npm run bench` isn't renderer-scoped; add a `gpuTimer` label around
  the effect passes so `renderDiagnostics` can report cost in e2e and manual
  profiling.

### B13 — Content/config schema

Extend `BodyVisualDef` (art-direction-only, mirroring `atmosphereVisual`) with
optional `entryVisual`:

```ts
entryVisual?: {
  glow: string; glowHot: string;
  trailPrimary: string; trailSecondary: string; trailTertiary: string;
  streak: string; wrapLayer: string; shockwave: string;
  strengthMultiplier: number; lengthMultiplier: number;
  opacityMultiplier: number; glowMultiplier: number;
  streakProbability: number;   // 0 for normal entries; >0 reserved for asteroids/comets
  particleThreshold: number;   // strength gate for sparks
}
```

A shared default covers any atmosphere-bearing body without an override
(Firefly's `Default.cfg` pattern); Veyra gets the first tuned palette. Bodies
without atmospheres never activate the system (gated by `AtmosphereDef`
presence + density at altitude). Document the surface in `MODDING.md` when it
ships.

## 5. Alternatives considered

| Approach | Verdict | Reasoning |
|---|---|---|
| **A. Envelope + VS-extruded fins + depth-map occlusion** (Lindner/Firefly architecture adapted to WebGL2) | **Chosen core** | Only approach that hugs arbitrary craft shapes, reacts per-surface to airflow, and has a shipped, beloved reference for how it should look. All WebGL2 blockers have standard solutions (B1–B3). |
| B. Screen-space post-process (depth-based glow, radial streak blur) | Rejected | Perilune has no composer (B4); screen-space streaks break down at oblique/side camera angles and provide no true 3D trail parallax; would re-plumb the render path for one effect. |
| C. Pure particle system (stock-KSP style) | Rejected as primary; **adopted as complement** | Proven infra exists (`srbSmoke`), but hull-conforming plasma is exactly what particles do badly — Firefly exists because stock particles looked dated. Sparks/ablation chunks (Phase 5) reuse the smoke pool pattern. |
| D. Raymarched volumetric plasma shell (SDF around craft) | Rejected | Fill-rate-heavy for the mobile tier, cannot conform to arbitrary stacks without an SDF of the craft, trails effectively impossible; poor fit for 100–500-part vessels. |
| E. Camera-facing ribbon trail (classic space-game trail) | Deferred nice-to-have | Good for the kilometer-scale glowing streak seen from far away/map view; useless up close. Could later complement A at high zoom-out, sourced from the same strength signal. |
| F. Port Firefly shaders (GPL) | Rejected earlier with user | License conflict with `LICENSES.md`, and the two showpiece passes are geometry shaders that would need rewriting anyway — porting saves almost nothing. |

## 6. Proposed architecture

New modules (names follow existing conventions):

- `src/render/reentryEffects.ts` — envelope/fin geometry builder (from
  `craft.parts` × `def.shape` primitives **plus interstage-shroud shell
  proxies from the same `InterstageShroudSpec` source as the visible mesh**,
  see B2), the effect `ShaderMaterial`s (glow, trail fins, bowshock bowl,
  bowshock wisps — the bowshock materials reuse the envelope and fin buffers),
  the per-frame update (uniforms: airflow-OS, strength, transonic state,
  palette, time), tier budgets. Owns nothing sim-side.
- `src/render/airstreamDepth.ts` (Phase 3) — depth target + ortho camera +
  layer management; produces the occlusion texture + airstream VP matrix
  uniform consumed by `reentryEffects`.
- `src/content/bodyVisuals.ts` — gains the optional `entryVisual` field and a
  shared default palette, exactly as `atmosphereVisual` lives there today (no
  new content module).
- `worldScene.ts` — wiring in the existing vessel sync loop: compute
  airspeed vector + strength driver per vessel, own effect lifecycle keyed by
  vessel id (same lifecycle as `vesselVisuals`).
- `src/sim/` — **no changes** (read-only consumption of `AeroForces` and
  atmosphere data). If airspeed-vector derivation proves duplicative, a tiny
  pure helper may be added *with tests*, but the default is zero sim diff.

Data flow per frame (active vessel):

```
sim (authoritative)                render (art)
aero.heatFlux, mach, aoa,   ──►    strength s, transonic m   (smoothed, render-side)
flowAlign                          │
rv.vel, body rotation       ──►    airflow dir (vessel-local uniform)
                                   │
                                   ├─► [Phase 3] airstream depth pass (512², active vessel only)
                                   ├─► glow pass       (1 draw, merged envelope incl. shroud proxies)
                                   ├─► trail fin pass  (1 draw, static fins, VS extrusion)
                                   ├─► bowshock bowl   (1 draw, envelope buffer, upstream VS offset)
                                   ├─► bowshock wisps  (1 draw, fin buffer, outward extrusion rule)
                                   └─► spark pool      (shared scene-wide, srbSmoke pattern)
```

## 7. Phasing (each phase ships independently visible value)

1. **Phase 0 — signal & schema.** Strength/transonic driver + thresholds with
   unit tests; `entryVisual` schema + defaults; wiring skeleton in
   `worldScene`. No visuals yet.
2. **Phase 1 — windward glow.** Merged inflated envelope, glow shader driven
   by exposure model (B10). This alone makes reentry *read* as reentry.
   Starts with a **reference-gathering step** (decision §8.3): curate visual
   references — real capsule/shuttle entry footage, published entry-plasma
   photography, Firefly gameplay as mood reference only — before authoring
   Veyra's palette. References inform hand-tuned original values; nothing is
   sampled or copied from Firefly assets.
3. **Phase 2 — trail fins.** Fin builder + VS extrusion + procedural noise,
   two layers, streaks. The signature Firefly look.
4. **Phase 3 — airstream occlusion.** Depth target; glow/trails/bowshock gain
   per-pixel shielding (fairings protect payloads visually).
5. **Phase 4 — bowshock.** Detached bowl (envelope buffer, upstream vertex
   offset) + swept rim wisps (fin buffer, outward extrusion rule) per B1 —
   two extra draws, no new geometry.
6. **Phase 5 — particles & tiers.** Spark/ablation point sprites on the smoke
   pool pattern; finalize Low/Medium/High budgets; mobile validation.
7. **Phase 6 — polish & content.** Per-body palettes beyond Veyra, transonic
   whiteout blend, `MODDING.md`/`ATTRIBUTIONS.md` updates, perf sign-off
   against `PERFORMANCE.md` budgets.

Phases 4–6 are droppable/reorderable without stranding earlier work.

## 8. Resolved decisions (owner review, 2026-07-17)

1. **Debris/non-active vessels** — v1 is **active-vessel-only**. Glow-only for
   nearby non-active vessels is a future extension (B11 updated).
2. **Transonic effects** — **in scope for v1**: the band-pass mach state
   (B10) is built in Phase 0 and drives whiteout blending from Phase 2 on.
3. **Palette authorship** — **reference gathering first**: Phase 1 begins
   with a curated visual-reference step before Veyra's palette is authored.
4. **Map/far view** — **no reserved hook** (decided by default): the strength
   driver is a pure function of `AeroForces`, so a future distant ribbon
   trail can consume it without rework; nothing speculative is built now.
