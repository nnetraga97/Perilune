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

## ADR-002: Renderer — Three.js on WebGL2, WebGPU as progressive upgrade

WebGL2 is the baseline because it is what every target browser (and our
headless CI Chromium) actually runs. The scene layer is isolated behind
`src/render/`; Three.js's WebGPURenderer can be adopted per-machine later
without touching simulation or UI. Custom shaders (atmosphere, plumes,
terrain) are written for the WebGL2 pipeline first.

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

## Layer map

```
src/core/      f64 math: vec3, quat, orbit (Kepler + universal variables)
src/sim/       universe (bodies/SOI), vessel graph, structure, aero,
               flight integrator, clock, game state
src/content/   data-driven definitions: star system, parts, experiments
src/render/    Three.js scene, planet quadtree LOD, vessel meshes, effects
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
- All names, bodies, parts, art (procedural), and text are original.
  See ATTRIBUTIONS.md / LICENSES.md for third-party code (Three.js et al.).
