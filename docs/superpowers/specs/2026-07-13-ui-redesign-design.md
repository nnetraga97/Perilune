# Perilune UI & Interaction Redesign

**Date:** 2026-07-13

**Status:** Draft for review — no implementation yet

**Scope:** Replace the bare-bones flight/map/editor interface with a cohesive, mission-control-grade UI, borrowing the proven interaction patterns of Kerbal Space Program and its most popular UI mods (Kerbal Engineer Redux, MechJeb's node editor, Kerbal Alarm Clock, Precise Maneuver, Trajectories, Transfer Window Planner, Docking Port Alignment Indicator).

## Objective

Perilune's simulation is well ahead of its interface. The sim layer already computes transfer windows (`src/sim/transfer.ts`), mission alarms with warp interlock and save persistence (`GameAlarm` in `src/sim/state.ts`), atmospheric-entry prediction (`src/sim/entry.ts`), and burn-time estimation (`estimateBurnTime` in `src/sim/maneuver.ts`) — **and none of it is reachable from the UI**. Nothing in `src/game.ts` or `src/ui/` references any of these modules.

The redesign has two goals:

1. **Surface the buried sim capabilities** through the interaction patterns KSP players already proved out via mods: an alarm clock, a transfer planner, a precise node editor, and an entry-trajectory overlay.
2. **Raise the interaction quality** of what exists: replace increment-button-only editing with direct manipulation, add hover/tooltip information density, and give the whole game one visual system instead of per-file ad-hoc CSS.

The aesthetic target is a **readable instrument panel**: dark glass panels, one accent palette, monospace numerics, glanceable at 4× warp. Not a sci-fi art piece; every pixel earns its place by carrying flight information.

## Current-State Findings

- **Flight HUD** (`src/ui/flightHud.ts`): functional but minimal. A 220 px canvas navball with prograde/retrograde/node markers only (no target, no radial/normal markers on the ball itself), three readout chips, Ap/Pe rows, four resource bars, a staging list without per-stage Δv, and a toast event feed. No burn timer, no time-to-node countdown on the HUD beyond a two-line text blob, no g-force/atmosphere indication.
- **Map view** (`src/ui/mapView.ts`): a solid conic renderer undermined by its input model. Nodes are created only "+ Node in 2 min" and edited exclusively through ±/‹/› buttons. There is no node gizmo on the orbit line, no Ap/Pe/AN/DN markers, no click-to-focus other bodies, no target selection, and no closest-approach display.
- **Editor** (`src/ui/editor.ts`): text-only part cards (`name + mass + blurb`), engineering stats as one preformatted monospace block, staging assignment via a "+sel" button rather than drag, no part search, no thumbnails, no tooltip with full part stats.
- **No shared UI kit.** Each file injects its own `<style>` string; panels, buttons, and rows are re-implemented three times. Only the color variables in `index.html` are shared.
- **No settings surface at all** — bindings, UI scale, and accessibility options (committed in `ACCESSIBILITY.md` for M3–M5) have nowhere to live.
- The plain-DOM, no-framework, direct-mutation approach (per the UI-layer ADR) performs fine and is worth keeping; the problem is what is drawn, not how.

## What the Mods Teach

| Mod | Pattern to adopt |
| --- | --- |
| Kerbal Engineer Redux | Pilots want dense, *selectable* readout groups (orbital / surface / vessel / rendezvous) in collapsible HUD panels, plus per-stage Δv/TWR everywhere staging is shown. |
| Kerbal Alarm Clock | Multi-mission play collapses without alarms: typed alarms (maneuver, transfer, Ap/Pe, custom), a listed queue, and automatic warp-kill before the event. |
| Precise Maneuver / Precise Node | Node editing needs exact numeric control: increment steppers with adjustable step size, snap-to Ap/Pe/AN/DN, and live "orbit after burn" readouts. |
| MechJeb (node execution) | Show burn duration and the half-burn-early start time; a "warp to burn minus margin" button is the single most used automation. |
| Trajectories | Draw the atmospheric entry path and predicted surface impact point on the map so aerobraking and landing become plannable, not guessed. |
| Transfer Window Planner | Present windows as a browsable list/plot with departure Δv, travel time, and one-click "alarm me" / "plan node". |
| Docking Port Alignment Indicator / NavHud | When rendezvous arrives (M3+), alignment belongs on a dedicated instrument, not mental math. Design the navball module so a docking mode can slot in. |

## Design Principles

- **Sim stays authoritative and DOM-free.** UI reads sim outputs; all new logic that computes anything (alarm scheduling, node snapping targets, formatting-independent math) lives in `src/sim/` or `src/core/` with Vitest coverage first.
- **Keep plain DOM + direct mutation.** No framework. Add structure, not React.
- **Direct manipulation first, buttons second.** Drag the node handles on the orbit; drag stages to reorder; scrub numeric fields; keep the precise steppers as the fallback.
- **Progressive disclosure.** Default HUD stays as clean as today; KER-style panels, alarm lists, and planners are opt-in windows the player opens and pins.
- **One visual system.** A single stylesheet/token set; component helpers reused by every screen.

## Workstreams

Numbered for delivery order; each lands independently behind the existing screens.

### 1. UI Foundation (prerequisite)

- Extract a `src/ui/kit.ts` + one shared stylesheet: design tokens (spacing, type scale, panel/border/glow styles built on the existing `--ui-*` variables), and components — panel, window (draggable, pinnable, collapsible, position persisted to save), button, toggle, numeric stepper with scrubbing, slider, gauge/bar, tooltip, tab strip, toast.
- Windowing layer: registry of openable instrument windows with a top-bar launcher (KSP "AppLauncher" equivalent). Open/closed state and positions persist via `src/save/`.
- Migrate existing HUD/map/editor styles onto the kit with zero behavior change (mechanical refactor, verified by existing e2e).

### 2. Flight HUD Overhaul

- **Navball upgrade:** larger, with full marker set (prograde/retrograde, normal/anti-normal, radial in/out, maneuver, and target when targets exist), heading tape, roll/level cue, and a burn arc: time-to-node, burn duration from `estimateBurnTime`, and a "start burn" indicator at T minus half-duration.
- **KER-style readout panels:** three optional windows — Orbital (Ap/Pe/period/inclination/ecc/time-to-AN-DN), Surface (altitude AGL vs ASL, slope, horizontal/vertical speed, latitude/longitude), Vessel (per-stage Δv/TWR live, mass, part count, g-force, dynamic pressure with peak-Q marker).
- **Staging list with numbers:** each stage row shows Δv / TWR / burn time (editor parity), current stage emphasized, next-stage preview on hover.
- **Status strip:** g-force and dynamic-pressure bars near the throttle; atmosphere-depth indicator during ascent/entry; comms indicator kept.
- **Part interaction:** click a part on the vessel (or in a vessel systems window) for a KSP-style part action popup — replaces the bespoke ISRU panel and generalizes to future part actions (lights, science re-run, fuel priority).

### 3. Maneuver Planning (Precise-Maneuver-grade)

- **On-orbit node gizmo:** click the conic to place a node; drag prograde/normal/radial handles rendered at the node; drag the node along the orbit to change time. The button panel remains for fine control.
- **Precise editor window:** steppers with cyclable step magnitude (0.1/1/10/100 m/s), direct numeric entry, snap node time to next Ap/Pe/AN/DN/SOI-entry, "orbit after" readout (Ap/Pe/inc/period), total Δv vs remaining stage Δv warning.
- **Execution aids:** warp-to-node keeps the existing callback but adds "warp to burn start minus 30 s" using burn-time; HUD shows remaining-Δv countdown during the burn (already tracked as `nodeRemainingDv` in `game.ts`, currently invisible).
- Multiple sequential nodes are explicitly **out of scope** for this milestone (single-node model is baked into `predictTrajectory` consumers today).

### 4. Mission Clock & Alarms (Kerbal Alarm Clock)

- Alarm window listing pending `GameAlarm`s: kind icon, label, T-minus, vessel association; add/edit/delete.
- Quick-create actions where the data lives: "alarm at this node" in the node editor, "alarm at window" in the transfer planner, "alarm at Ap/Pe/SOI" in map view, custom UT/T-plus entry.
- Warp interlock surfaced: banner + sound-free flash when an alarm fires and kills warp; snooze/dismiss. (Sim behavior already exists; this is presentation and CRUD.)
- Top-bar clock cluster: UT + MET + next-alarm countdown always visible.

### 5. Transfer Window Planner

- Planner window fed by `allTransferPlans`: destination list with phase angle now vs needed, time to window, departure Δv, transfer time, arrival/capture Δv; sortable.
- Row actions: **Create alarm** (workstream 4) and **Sketch node** — drop a maneuver node at the window time with the departure Δv prograde as a starting guess for the player to refine.
- Phase-angle dial visualization per row (current vs required angle) — cheap, readable, no porkchop plot needed at this fidelity (the sim is circular-coplanar anyway).

### 6. Entry & Trajectory Overlay (Trajectories)

- Map view: when the trajectory intersects an atmosphere, call `predictEntry` and draw the atmospheric path and predicted surface point; show peak heating/g estimates and corridor warnings (skip-out vs impact).
- Flight HUD during entry: compact entry card — time to interface, predicted landing coordinates relative to a chosen target site, peak g.
- Landing-site targeting: pin a surface marker (e.g. the launch site) and read cross-range/downrange error, KSC-landing style.

### 7. Map View Usability

- Body focus: click any body (or a body list) to re-focus the map; breadcrumb for SOI hierarchy; smooth focus transition.
- Orbit annotations: Ap/Pe markers with altitude labels, AN/DN relative to target, SOI entry/exit markers with hover detail (existing encounter text becomes hover cards).
- **Target selection:** click a body to "Set as target" — feeds transfer planner defaults, AN/DN readouts, and (later) closest-approach markers for vessel targets. Requires a small sim addition (`target` on `GameVessel`, persisted).
- Hover tooltips on every marker; time readout under the cursor along the conic.

### 8. Editor (Workshop) Quality Pass

- Part palette: generated thumbnails (offscreen render of part meshes at build/load), search box, sort by mass/thrust/category, richer cards; full-stat tooltip on hover.
- Staging column, KSP-style: vertical stage stack with per-stage Δv/TWR/burn chips, drag parts between stages, drag to reorder stages, icons per part type. Replaces "+sel".
- Engineering panel: structured rows instead of preformatted text; environment selector kept; TWR/Δv per stage aligned with the staging column.
- Part context: click part → action popup (remove, move, symmetry count, crossfeed later); advisor warnings link to the offending part (click to highlight).
- Craft management: rename/duplicate/delete saved craft, part-count/mass/Δv summary per saved entry.

### 9. Notifications, Settings, Accessibility

- Unified toast/notification service in the kit (flight events, alarm fires, quicksave confirmations, science results) with severity styling and a scrollback log window.
- Settings window: keybinding remap (fulfills ACCESSIBILITY.md commitment), UI scale slider, colorblind-safe accent palette audit + alternates, reduced-motion toggle, simplified-terminology toggle (e.g. "highest/lowest point" alongside Ap/Pe).
- Persist settings via `src/save/` schema migration.

## Sequencing & Sizing

| Order | Workstream | Size | Depends on |
| --- | --- | --- | --- |
| 1 | UI foundation | M | — |
| 2 | Flight HUD overhaul | L | 1 |
| 3 | Maneuver planning | L | 1 |
| 4 | Alarms | M | 1 |
| 5 | Transfer planner | M | 4 (alarm hooks), 3 (sketch node) |
| 6 | Entry overlay | M | 3 (map gizmo infra) |
| 7 | Map usability | M | 1; target selection feeds 5/6 |
| 8 | Editor pass | L | 1 |
| 9 | Settings & a11y | M | 1 |

Suggested first milestone (**"UI M1"**): workstreams 1 + 2 + 3 — foundation, HUD, and node editing are what a player touches every single flight. Second milestone (**"UI M2"**): 4 + 5 + 6 + 7, which together turn the buried M2 sim baseline into visible gameplay. Editor and settings (8 + 9) can proceed in parallel with UI M2 if desired.

## Testing Strategy

- All computable logic (alarm CRUD/scheduling, node snap targets, phase-angle math, formatting utilities, thumbnail manifest) is test-first in Vitest under `tests/`, DOM-free.
- Playwright e2e per workstream: open each instrument window, create/edit/delete a node via gizmo and steppers, set an alarm and observe warp kill, plan a transfer and verify the sketched node, entry overlay appears on a decaying orbit, editor staging drag.
- Existing e2e journeys must stay green through the workstream-1 refactor before any visual change lands.

## Non-Goals

- No UI framework (React/Vue/etc.); the plain-DOM ADR stands.
- No autopilot/ascent guidance (MechJeb's automation half) — instruments only, flying stays manual.
- No docking/rendezvous instruments yet (no multi-vessel targeting in the sim); the navball and target model are designed so DPAI-style tooling can slot in at M3+.
- No porkchop-plot solver beyond the existing circular-coplanar planner.
- No multiple chained maneuver nodes in this pass.
- No IVA, no additional camera modes, no audio work.

## Open Questions

1. **Art direction:** keep the current slate-blue palette and evolve it, or commission a distinct visual identity for Perilune before workstream 1 locks the tokens?
2. **Vessel targeting scope:** workstream 7 adds body targets only. Is vessel-to-vessel targeting (rendezvous prep) wanted in this redesign, or deferred with docking?
3. **Editor thumbnails:** offline-generated (deterministic, adds a content-pipeline step) vs runtime offscreen renders (simpler, small load cost)?
4. **Gamepad/touch:** ignore for this milestone, or should the kit's hit targets be sized for touch from day one?
