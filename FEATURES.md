# Perilune — Feature Traceability Matrix

Columns: **Feature** · **Player value** · **Inspiration category** (genre
convention it answers) · **Original implementation** (how ours differs) ·
**Status** · **Tests** · **Perf impact** · **Difficulty setting** ·
**Known limitations**.

Status legend: ✅ shipped · 🔶 partial · 🕐 scheduled (milestone).

## Simulation core

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Patched-conic orbits + SOI | Predictable, learnable spaceflight | Genre standard | Guarded classical elements + analytic ephemerides, f64 TS (no WASM), continuous warp event detection | ✅ | orbit.test, palla-mission | <0.2 ms/frame | — | n-body advanced mode 🕐 M5 |
| Two-regime sim (active/rails) | Whole system alive without CPU cost | Genre standard | Lossless regime swap incl. landed body-fixed poses | ✅ | ascent, palla-mission | negligible | — | — |
| Welded-rigid vessel + analytic structure | No noodle rockets; failures explainable | Community pain-point fix | O(n) joint-load pass w/ axial+bending limits, attributable failure text | ✅ | vessel.test | 0.3 ms @500 parts | — | No per-joint flex visual |
| Shape-aware aero (cached) | Design shape matters | Adv. aero mods | Cached projected-area model + CP + stall + co-rotating wind | ✅ | ascent.test | O(wings)/tick | — | No voxel occlusion yet (M2) |
| Flow-aware heating + ablators | Re-entry is a real event | Genre standard | Exposure by actual flow direction (tail-first entry heats tail) | ✅ | ascent, palla-mission | negligible | planned toggles M3 | No part-to-part conduction yet |
| Ground contact + terrain | Landings are earned | Genre standard | Physics + rendering share one deterministic height fn | ✅ | ascent, palla-mission | negligible | — | Wheels/legs suspension basic |
| Time warp (physics + rails) | Missions in minutes not days | Genre standard | Auto-drop at hazards; warp-to-node; alarm interlock | ✅ | ascent, palla-mission | — | — | Background atmosphere entries are resolved as vessel loss |

## Construction

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Part catalog (57 original parts) | Expressive building | Genre standard | Original names/roles/balance; procedural fallback plus checked optional models | ✅ | vessel.test | — | — | More parts continue by milestone |
| Stack + surface attach, symmetry | Fast, precise assembly | Genre standard | Node occupancy model; ×1–8 radial and mirror symmetry | ✅ | game-loop e2e | — | — | — |
| Staging editor + auto-stage | Approachable staging | Genre standard | Heuristic cluster auto-stage plus drag-reorder | ✅ | game-loop e2e | — | — | — |
| Live Δv/TWR per stage + env select | Engineering before launch | Info-mod standard | Crossfeed-aware stage simulation | ✅ | vessel.test | async-safe | — | Assumes each stage burns reachable propellant before the next staging command |
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
| Docking + undocking | Assemble and separate orbital vehicles | Genre standard | Port-face capture, momentum-preserving merge, stage/action-group remap | ✅ | docking.test | pairwise nearby only | — | No flexible joints |
| Fleet switching + comms | Operate more than one mission | Genre standard | Per-vessel rails state, signal graph, controllability gate | ✅ | comms/action groups | periodic graph | — | No relay planning overlay |
| Alarms + transfer planner | Plan long missions safely | Planning mods | Persistent vessel alarms, warp interlock, ranked transfer windows | ✅ | alarms/transfer | recompute on change | — | No porkchop heatmap |
| Entry prediction | See atmospheric outcome before committing | Guidance mods | Sampled entry corridor and landing estimate in map/HUD | ✅ | entry.test | throttled | — | Simplified lift guidance |
| Rovers + ISRU | Surface exploration loop | Genre standard | Wheel contact, survey map, drills and conversion | ✅ | wheels/resources | active physics + slow background | — | Basic suspension and resource economy |

## Rendering

| Feature | Player value | Inspiration | Original implementation | Status | Tests | Perf | Difficulty | Limitations |
|---|---|---|---|---|---|---|---|---|
| Quadtree planet LOD, orbit→ground | Seamless scale | Genre standard | Tan-warped cube-sphere, floating origin, skirts, budgets | ✅ | terrain e2e | ~8 ms worst (builds) | quality tiers 🔶 | Scatter/collide details M2 |
| Clouds | Living skies | Visual mods | Procedural fBm shell w/ proximity fade | 🔶 | (visual) | 1 draw | tiers 🕐 | Volumetric 🕐 M5 |
| Ocean | Coastlines from orbit | Visual mods | Specular datum sphere | 🔶 | terrain e2e | 1 draw | — | Waves/foam 🕐 M5 |
| Engine plumes | Feedback + spectacle | Genre standard | Additive cones, vacuum flare | 🔶 | (visual) | negligible | — | Volumetric/shock diamonds M5 |
| Performance overlay (F3) | Trust the numbers | Dev standard | p95/p99, sim/render split, machine-readable | ✅ | both e2e | — | — | GPU mem estimate partial |

## Scheduled (M3–M5)

EVA, expanded aircraft/runway gameplay, progression modes, tech tree,
contracts, crew traits, reliability and life-support options, colonies,
logistics routes, programmable flight computer, and a second star system.
