# Focused Map View and Maneuver Planner Plan

**Goal:** Make maneuver planning discoverable and precise, make orbital paths readable as a time sequence, and fix the defect where an in-progress burn changes or double-applies the planned orbit.

**Scope rule:** This is a focused pass on the single-node planner and orbit presentation. It does not add multi-node planning, new orbital solvers, or a full map-screen redesign.

## What exists today

The current code has more capability than the UI suggests:

- `src/ui/mapView.ts` already raycasts the active conic to create a node, draws a post-node conic, exposes numeric RTN fields, snaps time to orbital events, and predicts one encounter or escape.
- `src/sim/maneuver.ts` already models a node as signed prograde, normal, and radial delta-v and can derive the post-burn orbit.
- `src/game.ts` already estimates burn duration, warps to burn start, points SAS at the node, and counts down delivered delta-v.

The usability and correctness problems come from how those pieces are connected:

1. Clicking the orbit has no hover or add-node affordance, and pointer-down immediately becomes a time drag.
2. The on-node gizmo shows only three positive-axis letter markers. It has no separate retrograde, anti-normal, or radial-in handles.
3. Every delta-v handle responds to vertical mouse movement, even when its projected axis is horizontal or diagonal.
4. Moving the node uses horizontal pixels converted to seconds instead of following the orbit under the pointer.
5. The always-open 300 px panel mixes primary actions, precise editing, alarms, and a landing target, even when no node exists.
6. Current and planned orbits are full, overlapping one-pixel conics. They do not communicate which arc is live, which begins at the maneuver, or where an SOI patch stops being valid.
7. The prediction cache signature omits orientation and phase fields, so some real orbit changes do not invalidate the cached prediction.
8. Orbit selection raycasts the one-pixel `THREE.Line` with a world-space threshold derived from camera distance. The apparent hit band therefore changes with zoom and viewing angle, making the same visible line easy to click in one view and frustrating in another.

## Confirmed burn bug

The planned line is derived from the live vessel state on every map frame:

1. `MapView.update` converts the vessel's current position and velocity into new orbital elements.
2. It calls `orbitAfterNode` with those live elements and the node's full original delta-v.
3. At the same time, `PeriluneGame.updateNodeAssist` independently subtracts delivered acceleration from `nodeRemainingDv`.
4. The map never uses that remaining value, so an in-progress burn changes the base orbit and then reapplies delta-v that has already been delivered.
5. Once node time passes, `MapView.update` also changes `node.time` to `game.time + 1` every frame.

Rendering must never rewrite maneuver state. The planner needs a stable target orbit and an explicit execution state.

## Research takeaways

- The [KSP manual](https://static-files.kerbalspaceprogram.com/pd/KSPedia-XB1.pdf) documents the proven baseline: place a maneuver anywhere on the current or future path, edit it with six directional handles, and move it forward or backward along the orbit.
- [Precise Maneuver](https://zer0kerbal.github.io/PreciseManeuver/BasicInstructions.html) demonstrates why the spatial gizmo and a precise panel should coexist: signed +/- controls, selectable increments, event snaps, planned-orbit metrics, encounter details, and optional keyboard input each solve a different precision problem.
- [Juno: New Origins' planned-burn design](https://www.simplerockets.com/Blog/View/1919/Planned-Burns) combines orbit-click placement, direct gizmo manipulation, immediate predicted-orbit feedback, burn duration, encounters, and warp-to-burn.
- Juno's later [planned-burn UX update](https://www.simplerockets.com/Releases/View/223674) added typed/stepped delta-v, future-orbit passes, per-node sensitivity, and target-relative AN/DN. Its [map interaction update](https://www.simplerockets.com/Releases/View/220866) uses an orbit-click context menu so overlapping actions such as warp and plan-burn remain discoverable.
- Juno's [1.0.9 fixes](https://www.simplerockets.com/Releases/View/221916) are especially relevant here: resolution-independent drag distance, node interaction priority, manual-burn progress, and deliberate expiry of obsolete nodes.

Perilune should borrow those interaction contracts, not their exact art.

## Target interaction

### 1. Discoverable orbit click

- Do not use the rendered line as the active-orbit input target. Project its sampled vertices into screen space and choose the nearest polyline segment by point-to-segment pixel distance.
- Use a 12 px mouse/trackpad hit radius and a 24 px coarse-pointer/touch radius, independent of camera distance, device-pixel ratio, orbit scale, or line rendering width.
- Cache projected segment endpoints and refresh them only when the camera, viewport, or orbit geometry changes; pointer movement performs only the cheap 2D distance scan.
- When multiple segments fall inside the band, prefer the smallest screen distance, then the nearest visible depth, then the earliest future time. Other celestial-body orbits never steal the active-vessel orbit click.
- Entering the hit band brightens/thickens the active arc and snaps the ghost marker to the chosen point before the player clicks. The visible line can stay visually narrow because its input target is intentionally larger.
- Hovering or moving a pointer near the active vessel path shows a ghost `+` node marker at the nearest valid future point plus `Add maneuver · T−…`.
- Clicking the ghost creates and selects the node. A click without pointer movement must not accidentally drag node time.
- If a node already exists, clicking another point offers `Move maneuver here`; the single-node limit stays explicit.
- Primary click/tap is reserved for add-or-move. Secondary click, Control-click on macOS, or touch long-press opens a small orbit context card containing `Warp here` and the same add/move action. The two outcomes never compete on one primary click.
- Touch shows the ghost affordance after the first tap and confirms add/move on the second tap; nothing essential is hover-only.

### 2. Six-direction node gizmo

Render six signed controls around a selected node:

| Pair | Node field | Meaning | Color family |
| --- | --- | --- | --- |
| Prograde / Retrograde | `prograde` | add / remove tangential speed | green |
| Normal / Anti-normal | `normal` | tilt the orbital plane | violet |
| Radial out / Radial in | `radial` | rotate the orbit within its plane | blue |

- Use arrow or chevron silhouettes shared with the navball vocabulary, not `P`, `N`, and `R` letter dots.
- Give the visible icon a larger invisible pick target. Minimum interaction size is 36 px with a mouse and 44 px for coarse pointers.
- Drag response follows the handle's projected screen-space axis. Shift temporarily applies 0.1x sensitivity.
- A click applies one selected step; a drag is continuous. Both update the same signed node value.
- Gizmo handles and the node marker win hit-testing over orbit lines, labels, and bodies.

### 3. Move time along the actual path

- Drag the node center and re-raycast the pointer against the current path on every move.
- Select the nearest future conic sample and convert that sample to absolute node time.
- Do not derive time from horizontal pixels; this remains usable when the orbit is vertical, edge-on, or the camera is rotated.
- Provide small previous/next-orbit buttons in the precise panel for closed orbits. Hyperbolic paths do not show orbit-pass controls.
- A node still in `planned` state after its burn window becomes `OVERDUE`; an `executing` node may continue past node time normally. An overdue node is not silently moved. Offer `Move to next pass` and `Delete`.

### 4. Compact precise editor

- Hide the detailed editor until a node is selected. Keep a small `Add maneuver` hint when there is no node.
- Group primary actions together: warp to burn start, alarm, delete.
- Keep the existing 0.1/1/10/100 m/s step selector and direct numeric input.
- Label both signs in the rows so the panel teaches the gizmo: Retrograde ↔ Prograde, Anti-normal ↔ Normal, Radial in ↔ Radial out.
- Keep Ap/Pe/AN/DN/SOI snaps, but disable unavailable snaps instead of allowing a no-op click.
- Compare current and target Ap, Pe, inclination, period, total delta-v, burn time, and vessel margin in aligned rows.
- Move the landing-target and general alarm shortcuts out of the maneuver editor; they remain available from their existing map/mission surfaces.
- On narrow/coarse-pointer layouts, the editor becomes a collapsible bottom sheet capped near 45dvh rather than covering the orbit.

## Maneuver state and burn correctness

### One owner

Move the transient maneuver plan out of `MapView` and give it one owner in the game layer. No save-schema change is required in this pass.

The owned state contains:

- the editable signed `ManeuverNode`;
- the reference body id and immutable reference orbital elements captured when the node is created;
- the stable target post-burn orbit derived from that reference;
- execution phase: `planned`, `executing`, `complete`, or `overdue`;
- initial delta-v and the remaining burn vector;
- the stable inertial planned burn direction used by SAS during execution.

`MapView` renders and requests edits through callbacks. `FlightHud` reads the same plan/execution state. `PeriluneGame` updates remaining delta-v and completion. No renderer directly mutates node time or delta-v.

Time and RTN edits recompute the target from the immutable reference orbit; they do not recapture the live orbit. Moving the node to another point on that same reference path also keeps the reference. Creating/replacing a node captures a new reference. Time and delta-v editing lock once execution begins; cancel/delete remains available.

At execution start, convert the node's signed RTN components at node time into one inertial burn vector and freeze its unit direction. Each physics step subtracts only acceleration delivered along that direction: `max(0, properAccel × dot(thrustDirection, plannedDirection)) × dt`. Cross-track thrust changes the live orbit but does not falsely complete the planned burn. The remaining vector is the frozen unit direction times the remaining scalar magnitude.

State transitions are explicit:

- `planned → executing` when throttle is applied inside the estimated burn window, whether SAS node mode or manual steering is used;
- `planned → overdue` only after the burn window plus a short grace period passes without execution;
- `executing → complete` when remaining along-plan delta-v is at most the completion tolerance;
- `executing` never becomes overdue merely because absolute node time has passed.

### Two different future lines during execution

- **Target orbit:** captured from the reference orbit plus the full planned burn. It stays fixed while the engine burns, so the player retains a visible target.
- **Projected completion orbit:** calculated by adding the remaining inertial burn vector to the live velocity at the current execution time, then converting that state to orbital elements. It may move if the craft points poorly or the burn is late, which is useful deviation feedback.
- Before execution, the projected completion and target are the same line, so only one planned line is drawn.
- At completion, remove the node after a short acknowledgement and leave the actual current orbit as the authority.

This prevents double application while still showing whether the real burn is converging on the target.

### Invalidations

- Replace the partial string signature with a cheap conic revision plus a prediction revision and a complete live-orbit signature containing body id, `a`, `e`, `i`, RAAN, argument of periapsis, mean anomaly/epoch, and the remaining burn vector.
- Expensive encounter and entry predictions refresh on prediction revision or a throttled meaningful live-orbit change, not on every pointer pixel or render frame.
- While dragging, increment the cheap conic revision and update the local target line immediately. Commit the prediction revision on pointer-up, or after a 150 ms idle debounce for a held drag. Button and numeric edits commit immediately. Encounter/entry computation listens only to the prediction revision, so it cannot run on every pointer pixel.

## Orbit visual language

Use path color and line treatment to communicate chronology:

| Path | Treatment |
| --- | --- |
| Celestial-body orbit | thin, low-contrast slate |
| Current vessel path to node | solid cyan |
| Unburned current-orbit continuation | dim cyan, retained for node picking |
| Stable maneuver target | solid amber beginning at the node |
| Live completion estimate during burn | narrow amber dash |
| Encounter/SOI patch | violet, beginning at the transition marker |
| Atmospheric/impact segment | orange/red, ending at the entry or impact marker |

- Draw only the valid time range for each patch instead of a complete ellipse for every line.
- For a planned node, the cyan arc ends at the node and the amber arc begins there.
- Keep the unused continuation of the reference orbit dim but pickable, so the node can be moved elsewhere without restoring a misleading full-strength current path.
- For an encounter or escape, end the current-primary patch at the transition and begin the next patch at the same marker.
- Render only the first transition already supported by `TrajectoryPrediction`; recursive patched-conic chains remain out of scope.
- Add sparse direction chevrons that scale in screen space; do not cover the path with repeated arrows.
- Use screen-space-width lines (`Line2`/`LineMaterial` or an equivalent narrow ribbon), because WebGL ignores useful `LineBasicMaterial` width on common platforms.
- Keep geometry bounded: reuse buffers, update only dirty paths, and cap each visible patch at 256 samples initially. Improve sampling only where a high-eccentricity path fails the visual check.
- Keep body orbits and non-selected vessel paths visually subordinate so the active plan remains legible.

## Implementation slices

### Slice 0 — coordinate with concurrent map work

- Start implementation in a fresh worktree from the settled `main` SHA after the current map-focus changes are committed or discarded.
- Rebase the plan against that settled SHA before editing `src/game.ts` or `src/ui/mapView.ts`.
- Do not copy or overwrite the current uncommitted map-focus diff.

### Slice 1 — correctness and state ownership

Files:

- `src/sim/maneuver.ts` or a small adjacent `src/sim/maneuverPlan.ts`
- `src/game.ts`
- `src/ui/mapView.ts`
- `src/ui/flightHud.ts`
- focused maneuver tests

Work:

- Introduce the transient plan/execution state and make the game layer its owner.
- Capture reference elements only when a plan is created/replaced; recompute edited targets from that immutable reference.
- Stop rewriting elapsed node time.
- Track along-plan delivered acceleration, build the remaining inertial burn vector, and feed it into the projected-completion calculation.
- Make SAS use the stable planned burn direction and complete/delete the node through the owner.
- Add pure regression coverage for stable target orbit, remaining-delta-v projection, and overdue-node behavior.

### Slice 2 — orbit picking and six signed handles

Files:

- `src/ui/mapView.ts`
- `src/game.ts` pointer routing
- a small pure pointer/geometry helper if needed

Work:

- Replace `Raycaster.intersectObject(vesselLine)` with a pure screen-space `pickOrbitSegment` helper and cached projected path.
- Give the active path a fixed 12 px mouse/trackpad and 24 px coarse-pointer hit band, with hover highlighting before selection.
- Add nearest-path hover state and the ghost add marker.
- Separate click from drag with a small movement threshold and pointer capture.
- Expand the handle model from three axes to six signed handles.
- Project each axis into screen space for drag math.
- Drag node time by nearest conic point under the pointer.
- Add accessible labels/tooltips for every direction and action.

### Slice 3 — segmented orbit rendering and panel cleanup

Files:

- `src/ui/mapView.ts`
- `src/ui/kit.ts`

Work:

- Replace full-conic overlays with current, target, live-completion, and transition-bounded patch lines.
- Add sparse direction cues and improve visual/hit widths without raising the geometry budget materially.
- Collapse the precise editor when no node is selected and reorganize its actions/readouts.
- Add the narrow/coarse-pointer bottom-sheet layout and non-hover tap behavior.

### Slice 4 — focused verification

Add only the coverage needed for the changed contracts:

- Pure tests for plan stability, remaining-delta-v projection, event time mapping, path segment endpoints, and screen-space polyline picking at different zoom/depth values.
- One focused Playwright spec that creates a node from a click near—but not exactly on—the visible orbit, exercises opposing handle directions, moves the node along the orbit, and confirms the target line remains stable during a simulated burn.
- One manual desktop inspection and one narrow/coarse-pointer inspection for handle overlap, line hierarchy, and panel coverage.

Run once at the end:

```bash
npm run build
npx vitest run tests/save-maneuver.test.ts tests/map-maneuver.test.ts
npx playwright test e2e/map-maneuver.spec.ts
git diff --check
```

Do not run the complete Vitest or Playwright suite by default. Expand testing only if the work is forced into shared save/persistence or broad simulation code, or a focused check exposes a wider regression.

## Acceptance criteria

- A player can discover and place a node anywhere on the visible future vessel path without using the `+ Node in 2 min` fallback; a mouse/trackpad click up to 12 px from the line and a coarse-pointer tap up to 24 px away must resolve to the expected arc at every supported zoom.
- The selected node exposes six clearly signed directional handles and the precise panel remains available for exact values.
- Handle drag direction matches the handle on screen; moving node time follows the orbit under the cursor.
- The planned target orbit does not move merely because the current burn is underway.
- The live completion estimate uses remaining, not original, delta-v and visibly converges toward the target on an accurate burn.
- Passing node time does not silently move the node.
- Current, planned, encounter, and entry paths are distinguishable without a large permanent legend.
- The precise editor does not cover a large share of the map on narrow screens.
- The implementation does not materially increase per-frame map allocations or path vertex counts.

## Non-goals

- Multiple sequential maneuver nodes.
- Lambert solvers, porkchop plots, or automatic transfer optimization.
- Automatic circularize/change-inclination commands.
- Vessel-to-vessel rendezvous and closest-approach overhaul.
- Save persistence for maneuver nodes.
- A new map renderer, new planet assets, or terrain changes.
- A broad mobile-flight control redesign.
- Full-suite or broad viewport-matrix testing for this focused pass.
