# Changelog

## Milestone 3 — Progression and Space Program slice (2026-07-16)

- Added explicit Exploration and Space Program starts alongside First Light
  and unrestricted Sandbox.
- Added six technology branches. Recovered science now unlocks parts, while
  the Workshop visibly identifies locked hardware and blocks invalid craft.
- Added a persisted economy: 25,000 starting funds, authoritative craft cost,
  launch commitment, insufficient-funds interlock, and 35% recovery returns.
- Added four accepted contracts tied to real launch, stable-orbit,
  science-return, and Palla-landing achievements, with funds and reputation
  rewards.
- Added the Program Control instrument, save-schema v8 migration, and focused
  progression/menu/save coverage.

## Milestone 1 — Vertical Slice (2026-07-10)

The playable core loop, end to end:

- **Workshop**: 44 original parts, node/surface attachment with radial
  symmetry, staging editor with auto-stage, live per-stage Δv/TWR/burn
  readouts, CoM/CoP stability hint, advisor warnings, craft library.
- **Flight**: 6-DOF physics (thrust+gimbal, crossfeed fuel, aero with CP
  stability and stall, flow-aware heating with ablative shields, chutes,
  ground contact vs rotating terrain), SAS suite, navball HUD, staging,
  resource gauges, event feed.
- **Orbits**: patched conics with SOI transitions in active and rails
  regimes, physics + rails time warp with atmosphere auto-drop, map view
  with maneuver nodes, encounter prediction (periapsis readout), node
  execution assist, warp-to-node.
- **World**: original Auren system (12 bodies); quadtree planet terrain
  orbit→ground with floating origin; ocean; procedural clouds; plumes.
- **Persistence**: versioned saves with validation, backups, migration
  guards; quicksave/quickload; autosave; craft files.
- **Science**: situation-based experiments and recovery to science points.
- **Tutorial**: 12-step First Light checklist on the real simulation.
- **Verification**: 45 unit/property/integration tests including two full
  scripted missions (ascent→orbit→landing; Palla round trip); Playwright
  e2e driving the real UI; performance benchmarks with budgets.

## Milestone 0 — Risk prototypes (2026-07-10)

- f64 orbital core validated (property tests, precision at 1.4e11 m).
- Terrain LOD descent 3,000 km → 3 m in headless Chromium: stable memory,
  bounded draws, zero errors.
- Stack ADR: TypeScript everywhere (5–15× headroom vs budgets, no WASM).
