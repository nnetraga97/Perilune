# Perilune UI & Interaction Redesign

**Date:** 2026-07-13

**Status:** Revision 3 approved — UI-first sequencing: workstream 1 leads; workstream 0 items land just-in-time before the workstream that consumes them

**Scope:** Replace the bare-bones flight/map/editor interface with a cohesive, mission-control-grade UI, borrowing the proven interaction patterns of Kerbal Space Program and its most popular UI mods (Kerbal Engineer Redux, MechJeb's node editor, Kerbal Alarm Clock, Precise Maneuver, Trajectories, Transfer Window Planner, Docking Port Alignment Indicator).

## Objective

Perilune's simulation is well ahead of its interface. The sim layer already computes transfer windows (`src/sim/transfer.ts`), mission alarms with warp interlock and save persistence (`GameAlarm` in `src/sim/state.ts`), atmospheric-entry prediction (`src/sim/entry.ts`), and burn-time estimation (`estimateBurnTime` in `src/sim/maneuver.ts`) — **and none of it is reachable from the UI**. Nothing in `src/game.ts` or `src/ui/` references any of these modules.

The redesign has two goals:

1. **Surface the buried sim capabilities** through the interaction patterns KSP players already proved out via mods: an alarm clock, a transfer planner, a precise node editor, and an entry-trajectory overlay.
2. **Raise the interaction quality** of what exists: replace increment-button-only editing with direct manipulation, add hover/tooltip information density, and give the whole game one visual system instead of per-file ad-hoc CSS.

The aesthetic target is a **readable instrument panel**: dark glass panels, one accent palette, monospace numerics, glanceable at 4× warp. Not a sci-fi art piece; every pixel earns its place by carrying flight information.

## Current-State Findings

- **Flight HUD** (`src/ui/flightHud.ts`): functional but minimal. A 220 px canvas navball with prograde/retrograde/node markers only (no target, no radial/normal markers on the ball itself), three readout chips, Ap/Pe rows, four resource bars, a staging list without per-stage Δv, and a toast event feed. No burn timer, no time-to-node countdown on the HUD beyond a two-line text blob, no g-force/atmosphere indication. Nothing shows the crew aboard.
- **Map view** (`src/ui/mapView.ts`): a solid conic renderer undermined by its input model. Nodes are created only "+ Node in 2 min" and edited exclusively through ±/‹/› buttons. There is no node gizmo on the orbit line, no Ap/Pe/AN/DN markers, no click-to-focus other bodies, no target selection, and no closest-approach display.
- **Editor** (`src/ui/editor.ts`): text-only part cards (`name + mass + blurb`), engineering stats as one preformatted monospace block, staging assignment via a "+sel" button rather than drag, no part search, no thumbnails, no tooltip with full part stats.
- **No shared UI kit.** Each file injects its own `<style>` string; panels, buttons, and rows are re-implemented three times. Only the color variables in `index.html` are shared.
- **No settings surface at all** — bindings, UI scale, and accessibility options (committed in `ACCESSIBILITY.md` for M3–M5) have nowhere to live.
- **Keyboard coverage is near zero.** The editor binds exactly two keys (Delete/Backspace to remove, X to cycle symmetry — `game.ts` `handleKeyPress`). Flight binds ~11 (stage, map, SAS/RCS toggles, full/cut throttle, quicksave/load, warp step, vessel cycle). There is no undo, no part rotation, no angle snap, no precision-control mode, no pause, no way to discover any of the bindings in-game beyond button tooltips.
- **Science is invisible.** Experiment results are announced only in the 6-second toast feed (`logEvent` in `runScience`); accumulated points and `completedExperiments` have no display, and there is no way to see which experiments/situations remain.
- The plain-DOM, no-framework, direct-mutation approach (per the UI-layer ADR) performs fine and is worth keeping; the problem is what is drawn, not how.

### Sim-contract notes (verified against the code, 2026-07-14)

Claims in this spec were checked against the actual sim types; the deltas matter for scoping:

- `GameAlarm` is `{ id, time, label, kind }` — **no vessel association**. Alarm↔vessel linking ("jump to vessel when it fires") requires an optional `vesselId` field plus save-schema migration → workstream 0.
- `GameVessel` has **no `target` field**; body targeting is a sim + schema addition → workstream 0.
- `EntryPrediction` provides `peakHeatFlux`, `impactSpeed`, `landingDirBF`, `landingTime`, and a `samples` polyline — but **no peak-g estimate**. Either extend `predictEntry` (workstream 0) or the entry card ships without peak g.
- The alarm warp interlock is real (`GameState` consumes due alarms and drops warp) and alarms persist through saves; workstream 4 is genuinely presentation + CRUD only.
- Action groups do not exist anywhere in the sim: craft schema, runtime, and save all need them → workstream 0.

## Known Defect: Staging Lost After Decoupling

**Bug (confirmed by play, root cause identified in code):** after a decoupler fires, the craft can lose its entire staging sequence — the HUD staging list empties and Space does nothing.

Mechanism, in `GameState.detachSubtree` (`src/sim/state.ts:291-365`):

- The debris craft is always constructed with `stages: []` (`src/sim/state.ts:311`). When the detached side is the one holding the control pod, control transfers to it (`src/sim/state.ts:361-363`) — and the vessel the player now flies has **no stages at all**. Upper-stage separations where the decoupler's child side carries the pod hit this directly.
- The retained side filters detached part keys out of its stages (`src/sim/state.ts:302-304`) but, unlike `removeSubtree` in `src/sim/vessel.ts:106-109`, keeps now-empty stage entries, so `currentStage` can point at hollow stages that fire nothing.

**Fix direction (test-first, sim-layer, before workstream 2 builds UI on top of staging):** partition the original stage list across the split — each surviving vessel keeps the stages whose parts it retained, in order, with empty stages dropped and `currentStage` re-pointed at the first unfired stage. Deterministic Vitest cases: pod-above-decoupler, pod-below-decoupler, multi-stage serial stack, and save/load round-trip mid-separation. The workstream-2 staging list (per-stage Δv chips) and workstream-8 staging editor both assume this invariant holds.

## What the Mods Teach

| Mod | Pattern to adopt |
| --- | --- |
| Kerbal Engineer Redux | Pilots want dense, *selectable* readout groups (orbital / surface / vessel / rendezvous) in collapsible HUD panels, plus per-stage Δv/TWR everywhere staging is shown. |
| Kerbal Alarm Clock | Multi-mission play collapses without alarms: typed alarms (maneuver, transfer, Ap/Pe, custom), a listed queue, and automatic warp-kill before the event. |
| Precise Maneuver / Precise Node | Node editing needs exact numeric control: increment steppers with adjustable step size, snap-to Ap/Pe/AN/DN, and live "orbit after burn" readouts. |
| MechJeb (node execution) | Show burn duration and the half-burn-early start time; a "warp to burn minus margin" button is the single most used automation. |
| Trajectories | Draw the atmospheric entry path and predicted surface impact point on the map so aerobraking and landing become plannable, not guessed. |
| Transfer Window Planner | Present windows as a browsable list/plot with departure Δv, travel time, and one-click "alarm me" / "plan node". |
| Haystack / Tracking Station | Multi-mission play also needs a fleet list: every vessel with situation and body, switch/rename/terminate, debris filtered out by default. |
| Docking Port Alignment Indicator / NavHud | When rendezvous arrives (M3+), alignment belongs on a dedicated instrument, not mental math. Design the navball module so a docking mode can slot in. |

## Design Principles

- **Sim stays authoritative and DOM-free.** UI reads sim outputs; all new logic that computes anything (alarm scheduling, node snapping targets, formatting-independent math) lives in `src/sim/` or `src/core/` with Vitest coverage first.
- **Keep plain DOM + direct mutation.** No framework. Add structure, not React.
- **Direct manipulation first, buttons second.** Drag the node handles on the orbit; drag stages to reorder; scrub numeric fields; keep the precise steppers as the fallback.
- **Progressive disclosure.** Default HUD stays as clean as today; KER-style panels, alarm lists, and planners are opt-in windows the player opens and pins.
- **One visual system.** A single stylesheet/token set; component helpers reused by every screen.
- **Two persistence tiers, deliberately split.** Gameplay state (alarms, targets, action-group assignments) lives in the versioned game save with schema migration. UI preferences (window positions, open panels, keybindings, settings) live in a save-independent local profile store — switching or deleting a save never resets the player's layout, and UI iteration never forces a save-schema bump.

## Workstreams

Numbered for delivery order; each lands independently behind the existing screens.

### 0. Sim Precursors (small, test-first, unblocks everything)

All S-sized sim/schema changes the UI work consumes, done before or alongside workstream 1:

- **Staging partition fix** for the decoupling defect above (the one bug fix in this stream).
- **`target` on `GameVessel`** (body id, persisted) — consumed by the navball target marker (ws2), transfer planner defaults (ws5), AN/DN readouts (ws7).
- **`vesselId?` on `GameAlarm`** + migration — consumed by the alarm window's vessel column and jump-to-vessel (ws4).
- **Peak-g estimate in `EntryPrediction`** (max deceleration over the sampled path) — consumed by the entry card (ws6).
- **Action groups**: craft-schema field (group → part keys + action), runtime execution, save migration — assignment UI in ws8, execution keys in ws2.

### 1. UI Foundation (prerequisite)

- Extract a `src/ui/kit.ts` + one shared stylesheet: design tokens (spacing, type scale, panel/border/glow styles built on the existing `--ui-*` variables), and components — panel, window (draggable, pinnable, collapsible), button, toggle, numeric stepper with scrubbing, slider, gauge/bar, tooltip, tab strip, toast.
- Windowing layer: registry of openable instrument windows with a top-bar launcher (KSP "AppLauncher" equivalent). Open/closed state and positions persist in the **local profile store** (not the game save).
- **Input service:** one declarative binding table (key → action → screen/context) replacing the hardcoded `switch` in `game.ts`. Both flight (ws2) and editor (ws8) bindings register here; the table drives the `?` cheat-sheet overlay and the remap UI (ws9). Shifted keys are distinct entries (`?` ≠ `/`), and context rules are explicit (e.g. `Home` = recenter map when the map is open, reset flight camera otherwise).
- **Tutorial spotlight service:** the kit exposes "highlight this element/window" so tutorial steps can point at controls. Every tutorial step that names a UI location ("PODS category on the left", "AUTO-STAGE on the right") must be re-anchored as its screen is redesigned — treat the tutorial as a consumer of each workstream, not an afterthought.
- Migrate existing HUD/map/editor styles onto the kit with zero behavior change (mechanical refactor, verified by existing e2e).

### 2. Flight HUD Overhaul

- **Navball upgrade:** larger, with full marker set (prograde/retrograde, normal/anti-normal, radial in/out, maneuver, and target once ws0's target field exists), heading tape, roll/level cue, and a burn arc: time-to-node, burn duration from `estimateBurnTime`, and a "start burn" indicator at T minus half-duration.
- **KER-style readout panels:** three optional windows — Orbital (Ap/Pe/period/inclination/ecc/time-to-AN-DN), Surface (altitude AGL vs ASL, slope, horizontal/vertical speed, latitude/longitude), Vessel (per-stage Δv/TWR live, mass, part count, g-force, dynamic pressure with peak-Q marker).
- **Staging list with numbers:** each stage row shows Δv / TWR / burn time (editor parity), current stage emphasized, next-stage preview on hover. Depends on the ws0 staging fix.
- **Status strip:** g-force and dynamic-pressure bars near the throttle; atmosphere-depth indicator during ascent/entry; comms indicator kept.
- **Crew chip:** compact crew display (names, count) on the HUD — the sim tracks crew per vessel and splits them across separations, but nothing shows who is aboard today.
- **Part interaction:** click a part on the vessel (or in a vessel systems window) for a KSP-style part action popup — replaces the bespoke ISRU panel and generalizes to future part actions (lights, science re-run, fuel priority).
- **Flight camera modes** (today there is exactly one: an orbit rig in the local horizon frame, `WorldScene.camYaw/camPitch/camDist`):
  - `V` cycles modes with a HUD badge: **Orbit** (current behavior, horizon-referenced — the default), **Chase** (camera frame follows the vessel's orientation; the right mode for atmospheric flight and, later, docking), **Locked** (rigidly rotates with the craft), **Free** (inertial frame, no auto-leveling — for spectating rotations).
  - `Home` (or double-tap `V`) resets the camera behind the vessel at default distance; with the map open, `Home` recenters the map instead (context rule in the binding table).
  - **Terrain avoidance:** clamp the camera above the deterministic terrain height under it (the sim exposes this authority already) so low-orbit and landed shots stop clipping through the ground.
  - Drag smoothing/inertia and zoom-toward-vessel easing, honoring the reduced-motion setting.
  - Optional `Shift+wheel` FOV zoom (telephoto looks for landings/screenshots); plain wheel keeps meaning distance.
- **Map camera:** pan (middle-drag or right-drag) in the orbital plane in addition to the existing yaw/pitch/zoom; zoom toward cursor; eased transition when re-focusing bodies (workstream 7) instead of an instant jump.
- **Flight keyboard shortcuts** (registered in the ws1 binding table; extends the current Space/M/T/R/Z/X/F5/F9/,/./[/] set):
  - `Esc` — pause menu (resume / settings / save & load browser / exit to editor). There is currently no pause surface at all.
  - `/` — cancel warp to 1× instantly; `?` (Shift+`/`) — keybinding cheat-sheet, distinct entry in the table.
  - `Alt+.` — force physics warp even inside rails range, matching KSP's split.
  - `CapsLock` — precision-control mode: attitude inputs scaled down, indicator on the HUD. Track via `getModifierState` (browser CapsLock is a latching OS key); remappable for players who want a momentary key instead.
  - `Backspace` — abort action group placeholder (reserved; wired when an abort system exists).
  - `1–0` — action groups (ws0 sim support): execution + HUD indicator here, assignment UI in ws8.
  - `F2` — hide UI for screenshots; `F3` already serves the perf overlay.

### 3. Maneuver Planning (Precise-Maneuver-grade)

- **On-orbit node gizmo:** click the conic to place a node; drag prograde/normal/radial handles rendered at the node; drag the node along the orbit to change time. The button panel remains for fine control.
- **Precise editor window:** steppers with cyclable step magnitude (0.1/1/10/100 m/s), direct numeric entry, snap node time to next Ap/Pe/AN/DN/SOI-entry, "orbit after" readout (Ap/Pe/inc/period), total Δv vs remaining stage Δv warning.
- **Execution aids:** warp-to-node keeps the existing callback but adds "warp to burn start minus 30 s" using burn-time; HUD shows remaining-Δv countdown during the burn (already tracked as `nodeRemainingDv` in `game.ts`, currently invisible).
- Multiple sequential nodes are explicitly **out of scope** for this milestone (single-node model is baked into `predictTrajectory` consumers today).

### 4. Mission Clock & Alarms (Kerbal Alarm Clock)

- Alarm window listing pending `GameAlarm`s: kind icon, label, T-minus, vessel (via ws0's `vesselId`); add/edit/delete.
- Quick-create actions where the data lives: "alarm at this node" in the node editor, "alarm at window" in the transfer planner, "alarm at Ap/Pe/SOI" in map view, custom UT/T-plus entry.
- Warp interlock surfaced: banner + sound-free flash when an alarm fires and kills warp; snooze/dismiss; **jump to the alarm's vessel** in one click. (Warp-kill itself already exists in the sim; this is presentation and CRUD.)
- Top-bar clock cluster: UT + MET + next-alarm countdown always visible.

### 5. Transfer Window Planner

- Planner window fed by `allTransferPlans`: destination list with phase angle now vs needed, time to window, departure Δv, transfer time, arrival/capture Δv; sortable. Defaults to the current target (ws0) when one is set; works without a target.
- Row actions: **Create alarm** (workstream 4) and **Sketch node** — drop a maneuver node at the window time with the departure Δv prograde as a starting guess for the player to refine.
- Phase-angle dial visualization per row (current vs required angle) — cheap, readable, no porkchop plot needed at this fidelity (the sim is circular-coplanar anyway).

### 6. Entry & Trajectory Overlay (Trajectories)

- Map view: when the trajectory intersects an atmosphere, call `predictEntry` and draw the sampled atmospheric path and predicted surface point; corridor warnings (skip-out vs impact) from `willEnter`/`lands`.
- Flight HUD during entry: compact entry card — time to interface, predicted landing coordinates relative to a chosen target site, peak heat flux (`peakHeatFlux`), impact speed, and peak g once ws0 adds it.
- **Recompute policy:** `predictEntry` integrates up to 6 h / 100 k iterations — not a per-frame call. Refresh on the same signature-change pattern the map's `predictTrajectory` already uses (orbit elements + node changed), throttled while under thrust.
- Landing-site targeting: pin a surface marker (e.g. the launch site) and read cross-range/downrange error, KSC-landing style.

### 7. Map View, Targeting & Fleet

- Body focus: click any body (or a body list) to re-focus the map; breadcrumb for SOI hierarchy; smooth focus transition.
- Orbit annotations: Ap/Pe markers with altitude labels, AN/DN relative to target, SOI entry/exit markers with hover detail (existing encounter text becomes hover cards).
- **Warp-to on markers:** every time-anchored marker (Ap, Pe, SOI entry, encounter, node) offers "warp here minus margin" on click/hover — generalizes the existing warp-to-node.
- **Target selection UI:** click a body to "Set as target" (sim field from ws0) — feeds transfer planner defaults, AN/DN readouts, and (later) closest-approach markers for vessel targets.
- **Fleet window** (Haystack/tracking-station pattern): every vessel with name, type, situation, and SOI body; debris filtered out by default; click to switch (complements `[`/`]`), rename vessel, terminate debris, recover landed-at-home vessels. Alarms (ws4) and the map body list share this window's row components.
- Hover tooltips on every marker; time readout under the cursor along the conic.

### 8. Editor (Workshop) Quality Pass

- Part palette: generated thumbnails (offscreen render of part meshes at build/load), search box, sort by mass/thrust/category, richer cards; full-stat tooltip on hover.
- Staging column, KSP-style: vertical stage stack with per-stage Δv/TWR/burn chips, drag parts between stages, drag to reorder stages, icons per part type. Replaces "+sel". Depends on the ws0 staging fix.
- Engineering panel: structured rows instead of preformatted text; environment selector kept; TWR/Δv per stage aligned with the staging column.
- **Action-group assignment** (ws0 sim support): per-part action list with group binding, mirrored by the flight-side `1–0` execution.
- Part context: click part → action popup (remove, move, symmetry count, crossfeed later); advisor warnings link to the offending part (click to highlight).
- Craft management: rename/duplicate/delete saved craft, part-count/mass/Δv summary per saved entry.
- **Workshop interaction tweaks & shortcuts** (stock KSP VAB + Editor Extensions Redux patterns; today the editor binds only Delete and X):
  - **Undo/redo** — `Ctrl+Z` / `Ctrl+Y` over a bounded craft-snapshot history. The single biggest absent editor feature; every destructive action (place, move, delete subtree, stage edit) pushes a snapshot.
  - **Part rotation vs camera pan — one rule:** `W/A/S/D/Q/E` **rotate** the held or selected part (pitch/roll/yaw by the snap increment, `Shift` for fine steps, `Space` resets orientation) **when a part is held or selected**; with nothing held or selected they **pan/elevate the camera** (Better VAB Camera pattern). Middle-drag always pans regardless of selection, so the mouse path never depends on mode. **Approved scope: surface-attached parts only** — rotation extends the existing surface-attach yaw to full orientation on those parts; stack-attached parts stay axis-aligned (no new orientation math for the stack tree, aero, or mass properties).
  - **Angle snap** — `C` cycles snap increments (off/5°/15°/45°/90°) with an on-screen indicator next to the symmetry badge.
  - **Symmetry** — keep `X` to cycle count, add `Shift+X` to step back and `R` to toggle radial vs mirror mode (mirror matters once wings/planes are viable).
  - **Vertical snap** — `V` aligns a surface-attached part to the parent's vertical centerline (Editor Extensions Redux's most-loved toggle).
  - **Duplicate** — `Alt+click` a placed part to pick up a copy of it and its subtree.
  - **Re-root** — a root tool (`4` in KSP's 1/2/3/4 tool row) to change which part is the craft root; affects staging tree and docking later.
  - **Held-part handling** — `Esc` drops the held part (today only Delete does double duty).
  - **Editor camera** — wheel zoom kept, `Home` refits the whole craft in view, `F` frames the selected part; pan via the W/A/S/D/Q/E rule above.
  - **Palette navigation** — `Ctrl+F` (or `/`) focuses part search; `[` / `]` cycle category tabs (Tab stays reserved for keyboard-focus accessibility).
  - All editor keys register in the ws1 binding table and appear in the `?` cheat-sheet.

### 9. Notifications, Settings, Science & Save Management

- Unified toast/notification service in the kit (flight events, alarm fires, quicksave confirmations, science results) with severity styling and a scrollback log window.
- **Science archive window:** collected experiments with situation/body and points, plus remaining situations per experiment ("what's left to do here") — today science exists only as vanishing toasts and a recovery-dialog sentence. Includes a richer inline result card when an experiment runs.
- **Save & load browser** (reached from the Esc pause menu and main menu): named save slots with timestamps and vessel/UT summary, autosave surfaced, delete/overwrite confirmations — today the only surface is quicksave/quickload on F5/F9.
- Settings window: keybinding remap (fulfills ACCESSIBILITY.md commitment), UI scale slider, colorblind-safe accent palette audit + alternates, reduced-motion toggle, camera options (drag sensitivity, invert X/Y, FOV, smoothing on/off), simplified-terminology toggle (e.g. "highest/lowest point" alongside Ap/Pe).
- Settings, bindings, and window layout persist in the local profile store; gameplay data (alarms, targets, action groups) stays in the versioned game save.

## Sequencing & Sizing

| Order | Workstream | Size | Depends on |
| --- | --- | --- | --- |
| 0 | Sim precursors (staging fix, target, alarm vesselId, entry peak-g, action groups) | S–M | — |
| 1 | UI foundation (kit, windows, input service, spotlight) | M | — |
| 2 | Flight HUD overhaul | L | 0 (staging, target, action groups), 1 |
| 3 | Maneuver planning | L | 1 |
| 4 | Alarms | M | 0 (vesselId), 1 |
| 5 | Transfer planner | M | 4 (alarm hooks), 3 (sketch node); target optional |
| 6 | Entry overlay | M | 0 (peak-g), 3 (map gizmo infra) |
| 7 | Map, targeting & fleet | M | 0 (target), 1 |
| 8 | Editor pass | L | 0 (staging, action groups), 1 |
| 9 | Notifications, settings, science, saves | M | 1 |

Suggested first milestone (**"UI M1"**): workstreams 0 + 1 + 2 + 3 — precursors, foundation, HUD, and node editing are what a player touches every single flight. Second milestone (**"UI M2"**): 4 + 5 + 6 + 7, which together turn the buried M2 sim baseline into visible gameplay. Editor and settings (8 + 9) can proceed in parallel with UI M2 if desired.

## Testing Strategy

- All computable logic (alarm CRUD/scheduling, node snap targets, phase-angle math, staging partition, action-group execution, formatting utilities, thumbnail manifest) is test-first in Vitest under `tests/`, DOM-free.
- Playwright e2e per workstream: open each instrument window, create/edit/delete a node via gizmo and steppers, set an alarm and observe warp kill, plan a transfer and verify the sketched node, entry overlay appears on a decaying orbit, editor staging drag.
- Existing e2e journeys must stay green through the workstream-1 refactor before any visual change lands.
- The tutorial is a first-class regression surface: an e2e journey walks all steps after each workstream that moves the controls a step references.

## Non-Goals

- No UI framework (React/Vue/etc.); the plain-DOM ADR stands.
- No autopilot/ascent guidance (MechJeb's automation half) — instruments only, flying stays manual.
- No docking/rendezvous instruments yet (no multi-vessel targeting in the sim); the navball and target model are designed so DPAI-style tooling can slot in at M3+.
- No porkchop-plot solver beyond the existing circular-coplanar planner.
- No multiple chained maneuver nodes in this pass.
- No cinematic camera tooling (dolly paths, free-floating spectator rigs — Camera Tools territory); the four flight camera modes in workstream 2 are the scope.
- No IVA, no audio work, no localization framework (strings stay inline English for now).

## Open Questions

1. **Art direction:** keep the current slate-blue palette and evolve it, or commission a distinct visual identity for Perilune before workstream 1 locks the tokens?
2. **Vessel targeting scope:** workstream 7 adds body targets only. Is vessel-to-vessel targeting (rendezvous prep) wanted in this redesign, or deferred with docking?
3. **Editor thumbnails:** offline-generated (deterministic, adds a content-pipeline step) vs runtime offscreen renders (simpler, small load cost)?
4. **Gamepad/touch:** ignore for this milestone, or should the kit's hit targets be sized for touch from day one?

### Resolved

- **Editor part rotation depth** (2026-07-14): surface-attached parts only. Full stack-part rotation is out of scope for this redesign.
