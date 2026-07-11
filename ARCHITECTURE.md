# Perilune — Architecture

Perilune is an original single-player orbital-engineering game that runs
entirely in the browser. This document records the load-bearing decisions
and the measurements behind them.

## ADR-001: Language & numerics — TypeScript, no WASM sidecar

**Context.** The master build prompt names Rust→WASM as the default candidate
for hot numerical systems, replaceable if benchmarks justify it.

**Measurements** (Node 22 V8, 2026-07-10, this repo `npm run bench`; V8 in
Chromium is the same engine the game ships on):

| Workload | Budget/frame | Measured |
|---|---|---|
| Analytic propagation, 200 background vessels | ≤ 0.5 ms | **0.11 ms** |
| Universal-variable propagation ×400 (trajectory sweep) | ≤ 2 ms | **0.18 ms** |
| Structural load pass, 500-part vessel | ≤ 2 ms | **0.34 ms** |
| Mass properties, 500-part vessel | ≤ 1 ms | **0.13 ms** |
| Full staging/Δv analysis, 150 parts (editor) | ≤ 5 ms (editor, async ok) | **0.11 ms** |

**Decision.** All simulation stays in TypeScript. JS numbers are IEEE-754
doubles, giving the f64 precision orbital mechanics needs natively; the
measured headroom is 5–15× on every budget. A WASM boundary would add
serialization cost, toolchain weight, and debugging friction for no measured
benefit. Revisit only if a future system (e.g. n-body advanced mode with
thousands of perturbed bodies) blows a budget in profiling.

**Consequences.** Hot loops must stay allocation-free (out-parameter style in
`src/core/`), and CI benchmarks (`npm run bench`) guard against regression.

## ADR-002: Renderer — Three.js on required WebGL2

WebGL2 is a hard runtime requirement because the renderer platform depends on
its shader, texture, and delayed timer-query contracts. Startup requests a
WebGL2 context directly and displays `Perilune requires WebGL2` when it is not
available; there is no WebGL1 fallback. The capability probe records fragment
precision, compressed-texture formats, texture limits, anisotropy, and sample
count, and selects an analytic, lookup, or limb-haze atmosphere path. WebGPU
is neither detected nor used by the current runtime. Any future backend would
remain isolated behind `src/render/` and require its own measured contract.

## ADR-003: Coordinates — per-SOI local frames + camera-relative rendering

- Celestial bodies are evaluated **analytically** from orbital elements at
  any absolute time (`src/sim/universe.ts`) — no accumulating integration,
  exact under arbitrary time warp.
- Vessel state is stored **relative to the SOI parent body** (f64). System
  span is ~1.4e11 m; f64 ulp at that scale is < 0.1 mm (verified by test
  `universe hierarchy > keeps double precision at full system scale`).
- Rendering subtracts the camera position in f64 *before* upload, so the GPU
  only ever sees small camera-relative f32 coordinates (floating origin).

## ADR-004: Physics — two regimes, one rigid body per active vessel

- **Active regime** (controlled vessel + neighbors): 6-DOF rigid body with
  RK4 translation, quaternion attitude integration, forces from engines,
  aerodynamics, ground contact.
- **Rails regime** (everything else): exact conic propagation from stored
  orbital elements. Transitions copy state losslessly (elements ↔ state
  vector round-trip is tested to 1e-9 relative).
- A vessel is **one welded rigid body**. Structure is enforced by an O(n)
  analytic joint-load pass (`src/sim/structure.ts`) with per-joint axial and
  bending limits — no springy joint chains, no noodle rockets, and failures
  are attributable ("joint X→Y exceeded 47 kN bending, limit 30 kN").

## ADR-005: Simulation clock — fixed timestep, render interpolation

The render loop is never the simulation clock. Simulation advances on a
fixed timestep accumulator (default 50 Hz); rendering interpolates between
the last two states. Time warp switches vessels to the rails regime above
low multipliers (atmospheric "physics warp" is capped separately).

## ADR-006: Body visuals — explicit, shared, and transactional

- Renderer assignment lives in `src/content/bodyVisuals.ts`, outside the
  simulation `BodyDef`. Auren is `star`; all eleven non-star bodies remain
  `legacy` in Phase 3 while recording an explicit later target archetype.
- `BodyMaterialDescriptor` is the common identity/palette/orientation input
  for compact flight and MapView bodies. +Z is north and longitude is
  `atan2(y, x)`. Simulation terrain remains the only collision-height source.
- `BodyRendererManager` stages candidate assets, coverage, shaders, and
  budgets while retaining the committed root. Success swaps atomically;
  failure disposes the candidate and retains the committed renderer.
- `RendererResourceLedger` admits at most one flight-scale pack. Its reported
  bytes are pack-only and are not presented as total procedural GPU memory.
- `StarBodyRenderer` owns the flight-scale Auren disk/corona, directional
  light, and exposure contribution. MapView owns only its compact map light.
- Context loss pauses draws and GPU query calls. Restoration rebuilds committed
  renderers from descriptors; partial failure settles into a renderable
  fallback instead of mutating simulation state.
- MapView is deliberately pack-free. It uses compact descriptor meshes,
  authoritative body orientation at simulation time, and a focus-to-Auren
  light vector while preserving orbital and maneuver mechanics.

## Layer map

```
src/core/      f64 math: vec3, quat, orbit (Kepler + universal variables)
src/sim/       universe (bodies/SOI), vessel graph, structure, aero,
               flight integrator, clock, game state
src/content/   data-driven definitions: star system, explicit body visuals,
               parts, experiments
src/render/    WebGL2 capabilities/lifecycle, transactional body renderers,
               checked assets, planet quadtree LOD, vessel meshes, effects
src/ui/        DOM UI: editor, flight HUD, map view, dialogs (no framework;
               HUD updates by direct node mutation, never per-frame VDOM)
src/save/      versioned save schema, IndexedDB persistence, migration
tests/         vitest unit + property tests (fast-check)
bench/         vitest benchmarks (CI-gated budgets)
e2e/           Playwright end-to-end + visual + perf harness
```

## Original identity

- **Title:** Perilune
- **Star system:** Auren (star); Ashen, Vess, **Veyra** (home), Rusk,
  Tyran (+ Brimm, Glacia, Mote), Farfall; Veyra's moons **Palla** and Wisp
- **Species:** the Vellans; **Agency:** the Skyward Cooperative
- All names, bodies, parts, current procedural presentation, and text are
  original. Authored body packs and Phase 4+ archetype art are planned rather
  than shipped. Third-party code and any future sourced assets must remain
  recorded in ATTRIBUTIONS.md / LICENSES.md.
