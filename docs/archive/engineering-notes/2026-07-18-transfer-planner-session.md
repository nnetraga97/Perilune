# Perilune map and transfer planner — Codex session

**Date:** July 18, 2026  
**Agent:** OpenAI Codex  
**Project:** [Perilune](https://github.com/nnetraga97/Perilune)  
**Result:** [`6a9b421 feat: overhaul map and transfer planning`](https://github.com/nnetraga97/Perilune/commit/6a9b421)

This is a sanitized transcript of a local Codex development session. Local filesystem paths, internal tool traces, generated reasoning summaries, and unrelated environment metadata have been omitted. The user and agent messages below are otherwise preserved in sequence.

---

## User

> work on a worktree. The transfer planner window and map view do not work that well. When I click sketch node and follow the burn i dont end up close. The map view does not allow for zoom or decent production camera controls. The node lines are too thin. I also don't like the UI of the node maneuvor planner. It takes too much space and is all based on test. Managing multiple nodes is difficult. Also check the map view for location of the planets are they in the expected place.

## Codex

I’ll move this into a dedicated worktree, then inspect the transfer-planning math, map camera/input, node rendering, and current planet ephemeris together. I’ll first reproduce the code paths so any UI redesign stays aligned with how maneuvers are actually simulated.

## Codex

The shared checkout has unrelated in-progress changes, so I’m leaving it untouched. I found the prior map planner implementation and am branching from the current committed `main` into a new `feature/map-transfer-planner` worktree; this also lets me compare today’s behavior against the original maneuver-planning assumptions without mixing in another agent’s edits.

## Codex

I’ve already found one concrete transfer-planning defect: “Sketch node” always creates a prograde burn, including inward interplanetary transfers that require retrograde ejection. I’m tracing the remaining miss distance through the window timing and coordinate frames now, and I’m treating planet placement as a physics audit—not just a visual check.

## Codex

The map’s planet positions are generated from the same analytic orbital elements used by simulation, and the parent-relative offset logic is structurally correct. The visual camera is the weak link: it caps zoom-out before the outer system fits, constrains pitch to only the upper hemisphere, and only exposes orbit/pan through mouse-button conventions. I’m going to add explicit production-style camera controls and then verify body markers against their orbital paths in screen space.

## Codex

The transfer miss is now reproduced numerically: the current Palla sketch intersects almost the moon’s center (predicted periapsis about −215 km), so “close” is actually an impact trajectory rather than a usable capture approach. I’m changing the sketch to produce a refined low-periapsis intercept from the vessel’s real orbit, and I’m adding a node queue so later maneuvers can be selected and edited instead of replacing the first one.

## Codex

The first end-to-end visual pass now shows a verified Palla approach at roughly 33–35 km instead of an impact, materially thicker conics, a compact numbered node queue, and dedicated zoom/recenter/local-fit/system-fit/top-view controls. I’m in the verification pass now, including mobile behavior and the existing browser journeys.

## Codex

The verification pass is clean: all 727 unit/integration tests pass, the production build passes, and both focused browser journeys pass—including multi-node selection, camera zoom/system fit, refined transfer sketching, and mobile planner sizing. I’m doing the final worktree diff audit now to make sure only this feature slice changed.

## Codex

One unrelated renderer timing test flaked once after the rebase (terrain prewarm coverage stayed at 0 for that run); the same full suite had passed immediately before rebasing, and none of this branch touches that renderer. I’m rerunning that test in isolation, then the final build/browser checks, so I can distinguish a real regression from timing noise.

## Codex

One physics limitation is still explicit in the UI: eccentric/inclined interplanetary routes remain labeled phase estimates, while moon routes are numerically verified. I’m doing one last quantitative check of those planet sketches now; if the corrected inward/outward burn still misses outside the target SOI, I’ll keep the limitation visible rather than calling it an intercept.

## Codex

Implemented in a dedicated, clean worktree on `feature/map-transfer-planner` as commit `6a9b421`.

Key improvements:

- Numerically refined moon transfers; Palla now targets a usable ~35 km periapsis instead of impact.
- Stable-orbit requirement prevents invalid surface/prelaunch transfer nodes.
- Honest distinction between verified intercepts and interplanetary phase estimates.
- Multiple maneuver nodes with a numbered, selectable, chained queue.
- Compact planner with collapsed trajectory details and icon-based actions.
- Thick, reliable WebGL orbit lines.
- Explicit zoom, recenter, local/system fit, top-view, underside orbiting, and touch pinch/pan controls.
- Verified every planet/moon center against its analytic parent-relative orbit at three simulation epochs; no placement error found. Bodies are visually enlarged at distance, but their centers are correct.
- Transfer window closes automatically after creating a node.

Verification passed:

- 729 tests across 97 files
- Production build and content validation
- Both focused Playwright map/transfer journeys

The branch is rebased onto current `main`, committed, and ready to merge. I did not merge or push it.

## User

> push and merge

## Codex

I’ll fast-forward this feature into `main` and push `origin/main`, while preserving the unrelated scratch file in the shared checkout. I’m checking the remote once more first so the branch is rebased if `main` moved again.

## Codex

Merged and pushed successfully.

- `main` fast-forwarded to `6a9b421` — `feat: overhaul map and transfer planning`
- `origin/main` matches local `main`
- Unrelated `tests/zz-scratch-sketch-accuracy.test.ts` remains untracked and was not included
- Verification passed: 729 unit tests, production build, and focused Playwright tests
