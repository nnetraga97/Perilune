# Perilune — Feature Traceability Matrix

Columns: **Feature** · **Player value** · **Inspiration category** (genre
convention it answers) · **Original implementation** (how ours differs) ·
**Status** · **Tests** · **Perf impact** · **Difficulty setting** ·
**Known limitations**.

Status legend: ✅ shipped · 🔶 partial · 🕐 scheduled (milestone).

## Simulation core

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Patched-conic orbits + SOI | Predictable, learnable spaceflight | Genre standard | Universal-variable + analytic ephemerides, f64 TS (no WASM), exact under warp | ✅ | orbit.test, palla-mission | <0.2 ms/frame | — | n-body advanced mode 🕐 M5 |
| Two-regime sim (active/rails) | Whole system alive without CPU cost | Genre standard | Lossless regime swap incl. landed body-fixed poses | ✅ | ascent, palla-mission | negligible | — | — |
| Welded-rigid vessel + analytic structure | No noodle rockets; failures explainable | Community pain-point fix | O(n) joint-load pass w/ axial+bending limits, attributable failure text | ✅ | vessel.test | 0.3 ms @500 parts | — | No per-joint flex visual |
| Shape-aware aero (cached) | Design shape matters | Adv. aero mods | Cached projected-area model + CP + stall + co-rotating wind | ✅ | ascent.test | O(wings)/tick | — | No voxel occlusion yet (M2) |
| Flow-aware heating + ablators | Re-entry is a real event | Genre standard | Exposure by actual flow direction (tail-first entry heats tail) | ✅ | ascent, palla-mission | negligible | planned toggles M3 | No part-to-part conduction yet |
| Ground contact + terrain | Landings are earned | Genre standard | Physics + rendering share one deterministic height fn | ✅ | ascent, palla-mission | negligible | — | Wheels/legs suspension basic |
| Time warp (physics + rails) | Missions in minutes not days | Genre standard | Auto-drop at atmosphere interface; warp-to-node | ✅ | ascent, palla-mission | — | — | No warp-stop alarms yet (M2) |

## Construction

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Part catalog (44 orig. parts) | Expressive building | Genre standard | Original names/roles/balance; procedural geometry, no assets | ✅ | vessel.test | — | — | More parts M2+ |
| Stack + surface attach, symmetry | Fast, precise assembly | Genre standard | Node occupancy model; ×1–8 radial symmetry | ✅ | game-loop e2e | — | — | Mirror symmetry 🕐 M2 |
| Staging editor + auto-stage | Approachable staging | Genre standard | Heuristic cluster auto-stage | ✅ | game-loop e2e | — | — | Drag-reorder 🕐 M2 |
| Live Δv/TWR per stage + env select | Engineering before launch | Info-mod standard | Crossfeed-aware stage simulation | ✅ | vessel.test | async-safe | — | — |
| Advisor warnings | Learn before failing | Engineer-advisor mods | CP/CoM stability, TWR, chute, control checks | 🔶 | game-loop e2e | — | can ignore | More rules M2/M3 |
| Craft save/load | Iterate designs | Genre standard | IndexedDB library | ✅ | game-loop e2e | — | — | Import/export file UI 🕐 M2 |

## Flight & planning

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Navball + HUD | Instrument flying | Genre standard | Canvas PFD-style ball, marker projection | ✅ | game-loop e2e | <0.5 ms | — | — |
| SAS modes | Sane control | Genre standard | PD w/ gimbal authority; surface/orbital reference auto-switch | ✅ | ascent.test | — | gated M3 | — |
| Map view + maneuver nodes | Plan like a navigator | Genre standard | Encounter prediction w/ periapsis readout, warp-to-node | ✅ | save-maneuver, e2e | recompute-on-change | — | Drag handles 🕐 M2 |
| Maneuver execution assist | Fly the plan | Mod standard | Remaining-Δv tracking, auto-cutoff | ✅ | (manual) | — | gated M3 | — |
| Quicksave/quickload | Safe experimentation | Genre standard | Transactional writes + backups + validation | ✅ | save-maneuver, e2e | — | — | — |
| Science (situation-based) | Reason to go places | Genre standard | Per-(body,situation) experiments, recovery points | 🔶 | (e2e partial) | — | — | Time-based experiments 🕐 M2 |
| Tutorial (12 steps) | Onboarding | Genre standard | Watches real sim state; non-blocking | ✅ | (manual) | — | — | More tutorials M3 |

## Rendering

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Quadtree planet LOD, orbit→ground | Seamless scale | Genre standard | Tan-warped cube-sphere, floating origin, skirts, budgets | ✅ | terrain e2e | ~8 ms worst (builds) | quality tiers 🔶 | Scatter/collide details M2 |
| Clouds | Living skies | Visual mods | Procedural fBm shell w/ proximity fade | 🔶 | (visual) | 1 draw | tiers 🕐 | Volumetric 🕐 M5 |
| Ocean | Coastlines from orbit | Visual mods | Specular datum sphere | 🔶 | terrain e2e | 1 draw | — | Waves/foam 🕐 M5 |
| Engine plumes | Feedback + spectacle | Genre standard | Additive cones, vacuum flare | 🔶 | (visual) | negligible | — | Volumetric/shock diamonds M5 |
| Performance overlay (F3) | Trust the numbers | Dev standard | p95/p99, sim/render split, machine-readable | ✅ | both e2e | — | — | GPU mem estimate partial |

## Scheduled (M2–M5)

Docking & RCS translation gameplay, EVA, comms network, aircraft parts &
runway, rovers, resource scan/extract, transfer-window planner (porkchop),
alarms, atmospheric entry prediction, progression modes, tech tree,
contracts, crew traits, reliability & life-support options, colonies,
logistics routes, programmable flight computer, second star system.
