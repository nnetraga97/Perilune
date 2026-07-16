# Perilune — QA Strategy

## Test pyramid

1. **Unit + property tests** (vitest + fast-check): orbital math round-trips,
   Kepler solvers, conservation laws, craft graph invariants, structural
   solver, save schema validation/corruption/migration guards, maneuver
   planning. Property tests randomize orbits and assert invariants
   (energy conservation, back-propagation returns to start, no NaN). Campaign
   tests cover technology prerequisites, part gating, costs, contracts, and
   save round-trips.
2. **Integration mission tests** (vitest, real sim loop): full ascent →
   orbit → deorbit → chute landing; full Palla round trip (transfer,
   finite burns with corrections, SOI transitions, moon landing, return,
   aerobrake). These are the strongest regression net in the project: any
   physics/staging/warp regression breaks a mission.
3. **Browser e2e** (Playwright, real Chromium): terrain descent orbit→3 m
   (perf + memory gates); full playable loop through the real UI (build by
   mouse clicks on attachment nodes, launch, throttle, stage, climb,
   quicksave/quickload, map view) with a zero-console-error gate.
4. **Benchmarks** (vitest bench): numeric hot paths with CI budgets
   (PERFORMANCE.md).

## Gates for every milestone

- `npm test` green, `npm run typecheck` clean, `npm run build` succeeds.
- Both e2e suites green with zero console errors.
- Benchmarks within budget.
- Manual play of the milestone loop (recorded in CHANGELOG).

## NASA-style part models — manual visual matrix

The checked part models pass technical validation and the `part-models` e2e
journey, but final acceptance is a manual visual review of the eight enhanced
parts (`pod-voyager`, `leg-lander`, `eng-colt`, `ant-dish`, `wheel-mesa`,
`eng-mule`, `tank-s4`, `chute-main`):

- **Silhouette & orientation:** each model matches its NASA reference from the
  front, back, top, and bottom, with local `+Y` as the mounting axis.
- **Attachment fit:** no gaps or interpenetration at stack/surface attachment
  nodes against neighboring parts; the model sits within its recipe visual
  bounds.
- **Surface quality:** normals face outward (no inverted shells), no z-fighting
  or clipping, albedo in sRGB and normal/material data in linear color space.
- **Branding:** no NASA/JPL logos, flags, mission patches, vehicle names, or
  identifying text anywhere on any model, from any angle.
- **Budget on a real craft:** the reference craft with six `wheel-mesa` and four
  `leg-lander` stays at or below 60,000 part triangles.
- **Engine plumes:** the Mule shows three nozzle plumes and the Colt one, each
  aligned to its authored nozzle exit, tracking throttle and vacuum flare and
  following actual staging.
- **Stowed chute:** `chute-main` renders only the static Orion-style housing —
  no canopy, cords, or deployment animation — even after arm/deploy.
- **Fallback:** if a model asset is unavailable, the part renders its procedural
  geometry and the craft still builds, launches, and stages.

## Defect policy

Release blockers (crash, save corruption, NaN physics, spontaneous vessel
destruction, broken controls, missing acceptance scenario) stop feature
work until fixed. Bugs found by tests get a regression test with the fix.

## Notable defects caught by this net (kept as regression tests)

- Gimbal torque axis cross-wiring (vacuum attitude divergence).
- Ground contact using inertial instead of surface-relative velocity
  (pad destruction, phantom friction).
- Heating exposure ignoring flight direction (retro entry cooked the nose).
- `#ui-root > *` CSS specificity swallowing canvas clicks.
- Property-test find: near-parabolic elements ill-conditioning at apoapsis.
