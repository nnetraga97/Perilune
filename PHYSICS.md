# Perilune — Physics Model

All simulation is TypeScript (f64 throughout, ADR-001). Fixed timestep
50 Hz (ADR-005). Everything below is exercised by automated tests
(`tests/ascent.test.ts`, `tests/palla-mission.test.ts`).

## Two regimes (ADR-004)

- **Active**: the controlled vessel and neighbors within 20 km — full 6-DOF.
- **Rails**: everyone else — exact conic propagation from orbital elements;
  landed vessels store a body-fixed pose. Transitions are lossless
  (elements ↔ state round-trip tested to 1e-9 relative).

## Orbital mechanics

- Classical elements with Kepler solvers (Newton) for elliptic and
  hyperbolic regimes; universal-variable propagation (Stumpff functions)
  for arbitrary states, verified against analytic propagation.
- Patched conics with spheres of influence `r = a·(m/M)^(2/5)`; SOI
  transitions handled in both regimes with exact frame re-expression.
- Maneuver nodes are impulsive Δv in the RTN frame; trajectory prediction
  chains conics and finds moon encounters by analytic scan + bisection
  (`src/sim/maneuver.ts`).

## Vessel dynamics

- One welded rigid body per vessel (no joint springs). Mass, CoM, and a
  diagonal inertia tensor recomputed as fuel drains.
- **Structure**: O(n) analytic joint-load pass; per-joint axial and bending
  limits from contact area; failures split the craft with an attributable
  message ("X joint broke, bending 47 kN over limit").
- **Engines**: thrust from Isp interpolated sea-level↔vacuum by ambient
  pressure; gimbal deflection produces physical torque (axis mapping tested
  in vacuum); solid boosters are unthrottleable and self-contained.
- **Fuel**: crossfeed flood-fill across parent/child links, blocked by
  decouplers; engines drain their reachable pool proportionally.
- **Attitude**: reaction wheels + pod torque + gimbal + RCS; SAS is a PD
  controller with modes (stability/prograde/retrograde/normal/radial/
  node/custom). Prograde-family modes are surface-relative in atmosphere
  and near airless ground, orbital above.

## Aerodynamics (`src/sim/aero.ts`)

Cached shape model rebuilt only on geometry change:
projected axial/lateral areas, nose streamlining factor, center of
pressure (fins weighted), lift surfaces with stall break, per-part axial
position for heating. Per-tick evaluation blends by angle of attack with a
transonic drag rise. The atmosphere co-rotates with the planet (wind =
ω×r), which the contact, SAS, and guidance code all respect.

## Thermodynamics

Heating rate ∝ ½ρv³ scaled per part by **flow-direction-aware** exposure
(nose-first ascent heats the nose; engine-first entry heats the tail).
Ablative heat shields soak heat into ablator mass; radiative + convective
cooling; parts exceeding max temperature are destroyed (and can cascade to
vessel loss). Tuned so subsonic flight is safe and LEO-speed entry without
a shield is lethal (verified by tests).

## Ground interaction

Terrain height is a deterministic function shared with rendering
(`src/sim/terrain.ts`) — physics and visuals cannot disagree. Contact uses
a spring-damper at the vessel's lowest extent with friction against the
**rotating** surface; crash tolerance is judged on ground-relative impact
speed; landed vessels damp to rest and rails-freeze in the body frame.

## Parachutes & guidance

Chutes arm via staging, semi-deploy on pressure+altitude, full-deploy low,
with force capped to protect the integrator. `src/sim/guidance.ts` provides
the gravity-turn ascent director (shallow-AoA prograde-following) used by
tests and (later) the optional ascent assist.
