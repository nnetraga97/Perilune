# Perilune release blockers — Codex session

**Date:** July 10, 2026  
**Agent:** OpenAI Codex  
**Project:** [Perilune](https://github.com/nnetraga97/Perilune)  
**Results:** [`eaa2db4`](https://github.com/nnetraga97/Perilune/commit/eaa2db4), [`70d229d`](https://github.com/nnetraga97/Perilune/commit/70d229d), [`91509d7`](https://github.com/nnetraga97/Perilune/commit/91509d7)

This is a sanitized transcript of a local Codex development session. Local filesystem paths, internal tool traces, generated reasoning summaries, and unrelated environment metadata have been omitted. The user and agent messages below are otherwise preserved in sequence.

---

## User

> look at this repo and plan and git status and commits. i want to get claude/new-session-nacw75

## Codex

I’m using the git planning workflow to inspect the repo, recover the existing plan, and determine the safest way to get `claude/new-session-nacw75` without disturbing local work. I’ll start read-only.

## Codex

The workspace root itself is not a Git repository, so I’m checking for a nested checkout before touching anything. That matters here because switching from the wrong directory could hide or overwrite the state you want preserved.

## Codex

I found the issue: the current local branch is misspelled as `claude/new-seesion-nacw75` and still points at the initial commit, while the requested remote branch `origin/claude/new-session-nacw75` is 13 commits ahead. The worktree is clean. I’m refreshing the remote, then I’ll inspect the branch’s plan/handoff files and switch to an exact-name local tracking branch.

## Codex

Checked out the requested branch successfully in the project checkout.

- Current branch: `claude/new-session-nacw75`
- Tracking: `origin/claude/new-session-nacw75`
- HEAD: `7636136` — M2 multi-vessel physics, docking, and comms
- Git status: clean
- Local/remote divergence: `0 / 0`
- Branch contains 13 commits beyond `main`

The `STATUS.md` plan says M0 and M1 are complete. The latest commit appears to complete M2 slices 1–3, though the status file has not been updated yet. Remaining M2 work:

1. New wheels, gear, drills, scanners, and wings
2. ISRU resource chain
3. Transfer planner, alarms, and entry prediction
4. Aircraft and rovers
5. EVA
6. Visual upgrades

I preserved the old misspelled local branch, `claude/new-seesion-nacw75`; it still points to the initial commit.

## User

> Next M2 slice: expanded parts (wheels, landing gear, jet engine, ISRU chain, big wings, aircraft cockpit) plus the resource simulation. resource simiulation model was rewritted. Lets try to run the app

## Codex

I’ll refresh the checked-out branch first—your note suggests a newer M2 commit may be available—then install dependencies if needed and start the development server. If startup fails, I’ll switch into the systematic debugging workflow and trace the concrete cause.

## Codex

Dependencies are installed. The branch itself has no newer remote commit yet—the latest remains `7636136`, so the expanded-parts/resource rewrite is not present on this remote branch at the moment. I’m starting the current app now and will confirm the page actually responds.

## Codex

The app is running successfully at `http://127.0.0.1:5173/`.

- Vite started normally and returns HTTP 200.
- Git remains clean.
- Dependencies installed successfully.
- The expanded-parts/resource rewrite is not yet on `origin/claude/new-session-nacw75`; its latest commit remains `7636136`.
- `npm install` reported five dependency vulnerabilities, but they do not prevent the app from running.

## User

> bugs that i found - When a rocket is staged. The control point is not automatically updated to the relevant part(pod detached, camers still pointed at booster). The UI buttons for setting vectors do not work. The nav ball is completely wrong. During building, you can only place the part in certain places and drag and drop does not work. Auto-stage is buggy. The launch site is not rendering properly and also not cleared between launches. The world planet is not rendering properly(Its got these blank sqaures/rectabgles where you can see through and all you see if like a blue). The command pods and some other part like the adapter have like an additonal ring to them. Delta-v calculations dont work. Some of this might be latter milestones but I want it fixed for this version

## Codex

I’m treating these as release-blocking defects for this version, regardless of the original milestone split. I’ll use systematic debugging first to reproduce and trace each failure, then test-driven fixes so staging, controls, editor placement, rendering, and delta-v behavior stay fixed as the project evolves. I’ll preserve the current clean branch and work through the defects in small, verifiable groups.

## Codex

Baseline unit tests and TypeScript checks pass, which confirms the current suite does not cover the defects you found. I’m now tracing the live data flow: stage split → active vessel/camera, HUD click handling → SAS state, editor pointer events → attachment candidates, and terrain/part mesh generation. The first useful signal is that several of these behaviors are either untested or only checked superficially in the existing browser test.

## Codex

The existing browser test cannot launch because this machine’s Playwright configuration points to a missing configured Chromium path; that is an environment gap, not an application failure. I’m continuing the code-level trace while I correct the browser harness locally so we can reproduce the visual and interaction defects rather than guessing from source alone.

## Codex

The first root causes are now concrete:

- Terrain holes are real LOD coverage gaps: child chunks become “wanted” before their meshes exist, while the parent is hidden, exposing the blue ocean underneath.
- Relaunch only removes the currently active vessel; detached boosters/debris from the previous attempt remain.
- The editor is explicitly implemented as click-palette, click-node placement; there is no drag/drop path, and snapping uses a fixed world-space threshold.
- Auto-stage groups parts by height instead of by the attachment/decoupler graph, so ordinary multi-stage stacks can be ordered incorrectly.
- The extra rings are the generic accent-band mesh being applied indiscriminately to pods and tapered adapters.
- Current tests do not validate control ownership after separation, SAS button behavior, navball projection, or terrain coverage.

The frontend workflow now requires a dedicated branch and scratchpad before implementation, so I’m creating those with the evidence and test plan, then I’ll begin the first red/green cycle.

## Codex

The first repair group is green: control now transfers to a detached pod when appropriate, separation preserves each piece’s world-space center, auto-stage follows the attachment tree, terrain keeps coarse fallback meshes while detail streams in, relaunch clears all prior flight vessels, and pod/adapter accent rings are suppressed. I also isolated and corrected the navball marker projection sign.

Next I’m addressing the editor interaction itself. I’ll add a real-browser regression for palette-to-canvas drag/drop, watch it fail against the current click-only implementation, then wire drag/drop and replace the zoom-sensitive world-space snap threshold with a screen-space target.

## Codex

The unit and integration suite is fully green at 58 tests. The real-browser editor drag/drop regression also passes. I’m running the complete playable-loop browser test now; this is the higher-risk verification because it exercises building, auto-stage, launch, ascent, save/load, and map controls together.

## Codex

The browser screenshot caught an important remaining rendering defect: coverage no longer disappears outright, but low-detail fallback chunks are using skirts tens of kilometers deep, producing the same rectangular “cutout” appearance from the player’s perspective. The launch coordinates also need checking against the procedural coastline; I’m correcting those two rendering causes before calling this fixed.

## Codex

The visual check found one more concrete rendering interaction: the corrected daylight exposed coarse parent terrain being drawn simultaneously with partially built child terrain. Those overlapping LOD levels create the large overhangs and bands. I’m tightening the fallback rule so a branch renders either its parent or its complete child set—never both.

## Codex

I found the underlying geometry bug: the terrain grid triangles are wound inward. From outside the planet, the main terrain surface is back-face culled, leaving only the LOD skirts visible—the long rectangular strips in the screenshots. That explains why tuning fallback and ocean behavior improved symptoms but never restored the ground. I’m fixing the index winding at the source and locking it with a geometry regression.

## Codex

The terrain root cause is now fixed: outward triangle winding restores the actual ground surface instead of rendering only skirts. I also corrected the reversed sunlight direction and made the launch facility use the same deterministic site transform as spawning. The remaining verification now includes real clicks on SAS and maneuver-vector controls, not just checking that the panels open.

## Codex

The final ascent screenshot now shows a continuous terrain surface with no rectangular holes or skirt-only strips. One navball detail was still visibly wrong in that screenshot: vertical ascent displayed heading `270°` even though the launch orientation is east. I traced that to deriving heading from an almost-zero horizontal nose projection; I’m correcting the vertical-flight fallback before the final commit.

## Codex

I’m using the verification-before-completion checklist now because these fixes span simulation state, interaction, and rendering. I’ll rerun the final suite from the current tree, inspect the diff for accidental changes, then commit and push the dedicated fix branch as required by the frontend workflow.

## Codex

Implemented, committed, and pushed the fixes on `fix/m2-release-blockers`.

Key fixes:

- Control transfers to the relevant command pod after staging.
- Navball marker direction and vertical-flight heading corrected.
- SAS and maneuver-vector buttons verified through Chromium.
- Real palette-to-canvas drag/drop added.
- Attachment snapping now uses screen-space targeting.
- Auto-stage now follows the attachment graph, fixing delta-v stage calculations.
- Relaunch/revert clears all previous vessels and debris.
- Cape Skyward launch facility added with shared spawn positioning.
- Planet terrain winding, LOD overlap, skirts, ocean coverage, and lighting corrected.
- Decorative rings removed from command pods and adapters.

Verification:

- 65 unit/integration tests passed.
- Production build passed.
- 2 Chromium interaction/playable-loop tests passed.
- Git worktree is clean.

Commit: [`eaa2db4`](https://github.com/nnetraga97/Perilune/commit/eaa2db4)

## User

> the server is running now on http://localhost:5174/. bug that I see - when a engine runs out of fuel, the plume of smoke does not fade away. Clicking on a part in vehicle assembly does not higlight the part. In vehicle assembly, when you click a part it loads into the building view but if you click on it again, the expectation is that it you can drag and drop it anywhere in the assembly view(after part is spawned) currently you can also move it so it goes on top of a node, you cant move it wherever

## Codex

I’m using the same systematic-debugging and test-first workflow for these three regressions. I’ll reproduce them against the server on port 5174, trace plume lifecycle and editor selection/movement separately, then add browser regressions before changing behavior. For assembly movement, I’m interpreting your expectation as: click a placed part to select/highlight it, then drag that placed part to a new free position or attachment target—not only snap it onto stack nodes.

## Codex

The root causes are clear:

- Liquid-engine plumes explicitly assume fuel is always available, so activated engines keep rendering a plume after their reachable tanks are empty.
- Editor selection only stores a key; it never creates any visual highlight.
- Canvas dragging is globally reserved for orbiting the camera. Placed parts have no drag state or movement plane, so they cannot be repositioned freely after placement.

I’m adding failing coverage for fuel exhaustion, visible selection, and free repositioning before implementing them.

## Codex

All three new regression tests are green now: the plume fades to zero after reachable fuel is exhausted, selected parts expose an active highlight, and a second drag moves the placed subtree freely on a camera-facing plane instead of orbiting the camera or forcing node snapping. I’m visually checking those interactions against your live server on port 5174 before running the full suite.

## Codex

Fresh verification is clean: 66 unit/integration tests, production build, and both Chromium flows pass, including selection highlighting, free part movement, SAS/vector controls, launch, ascent, and save/load. I’m committing and pushing this follow-up to the same fix branch now.

## Codex

Fixed and verified against `http://localhost:5174/`.

- Engine plumes now fade out when reachable fuel is exhausted.
- Clicking an assembled part shows a visible selection box.
- Dragging the selected part moves it freely; attached descendants follow.
- Dragging empty assembly space still orbits the camera.
- Workshop instructions updated accordingly.

Verification:

- 66 unit/integration tests passed.
- Production build passed.
- 2 Chromium flows passed.
- Commit [`70d229d`](https://github.com/nnetraga97/Perilune/commit/70d229d) pushed to `fix/m2-release-blockers`.
- Git status is clean.

## User

> When a new craft is spawned on the pad, it is floating. It immediately falls and then causes the craft to break. Can we fix this so it starts stationary on the pad with no momentum so it doesnt keep falling over

## Codex

I’m treating this as a launch hold-down bug. The craft must be stationary relative to the rotating pad—not literally zero inertial velocity—and remain anchored in position and attitude until an activated engine is producing thrust. I’ll add a regression that waits on the pad for several simulated seconds, then verifies a normal release when throttle and ignition are present.

## Codex

The hold-down regression now passes: an unpowered craft remains `prelaunch`, maintains zero surface-relative velocity and zero angular velocity while the planet rotates, then releases and burns fuel once an activated engine produces thrust. I’m checking that behavior on your live port 5174 and then running the full launch/ascent suite.

## Codex

Fresh verification passes: 67 unit/integration tests, the production build, and both Chromium flows. The live server also held a pod at exactly the same altitude for five seconds with `prelaunch` unchanged and no browser errors. I’m committing and pushing the hold-down fix now.

## Codex

Fixed and pushed as commit [`91509d7`](https://github.com/nnetraga97/Perilune/commit/91509d7).

New crafts are now anchored to the rotating launch pad while in `prelaunch`:

- Position and attitude remain fixed relative to the pad.
- Surface-relative velocity and angular velocity remain zero.
- Hold-down releases only when an activated engine has fuel and produces thrust.
- Solid boosters release immediately when staged.

Verified on `localhost:5174`: altitude remained exactly unchanged for five seconds. All 67 tests, the production build, and both Chromium flows pass.
