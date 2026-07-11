# Perilune build status

M0 ✅ / M1 ✅ (see CHANGELOG.md). M2 is in progress.

M2 slice order:
1. Multi-vessel physics bubble + switching (foundation) ✅
2. Docking merge/undock + rendezvous
3. Comms network + relays + probe control
4. New parts: wheels, gear, drills, scanners, big wings
5. ISRU chain: scan → drill → convert
6. Transfer-planning simulation + alarms + entry prediction ✅
7. Aircraft (runway spawn) + rovers
8. EVA
9. Planet graphics redesign ← current; see `docs/superpowers/specs/2026-07-10-planet-graphics-design.md`

The planet work proceeds as separately verified phases: authority/tooling,
hardware feasibility, renderer platform, Veyra global and surface stacks,
Palla, Tyran, then the remaining system bodies.

Current planet checkpoint: the authority/tooling and renderer-platform
foundations are implemented, and Veyra's global terrestrial renderer is active
with authored Low/Medium/High material packs, atmosphere, independent ocean,
two cloud layers, and coverage-safe terrain transition. Veyra surface detail,
Palla, Tyran, and the remaining body conversions are next. Full Medium/Low M3
Max certification, browser-matrix coverage, and calibrated visual baselines
remain deferred final gates rather than completed claims.

Conventions: sim modules pure & tested first; UI drives via GameState;
commit per slice; docs updated at milestone gates.
