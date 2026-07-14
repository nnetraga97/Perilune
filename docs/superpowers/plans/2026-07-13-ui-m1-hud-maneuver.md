# UI M1 HUD and Maneuver Implementation Plan

**Goal:** Deliver workstreams 2 and 3 from the approved rev3 redesign on top of the workstream-1 UI foundation and the verified workstream-0 staging/target/action-group contracts.

**Architecture:** Keep flight and orbital math in existing sim/core helpers. `FlightHud` owns the always-on instrument cluster, while optional KER-style panels register with `WindowManager`. `MapView` continues to own the single maneuver node and its visual/editor state. `PeriluneGame` remains the command router for bindings, camera modes, pause/UI visibility, action groups, and burn execution telemetry.

**Implementation order:** Complete each vertical slice before moving to the next, with only typechecking and focused checks during implementation; run the full suite/build at the milestone end.

## 1. Flight instrumentation

- Upgrade the navball to the full marker set, heading tape, roll/level cue, target marker, and node burn timing.
- Add status bars for g-load, dynamic pressure, and atmosphere depth; show precision/camera state and crew.
- Add live per-stage delta-v, TWR, and burn time to the staging column.
- Pass remaining node delta-v and burn timing from the game shell into the HUD.
- Register Orbital, Surface, and Vessel instrument windows with the existing persistent window manager.

## 2. Flight commands and camera

- Register `/`, `CapsLock`, `Backspace`, `1–0`, `V`, `Home`, `F2`, and `Esc` in the declarative input table.
- Execute action groups through `GameState.executeActionGroup` and surface a short HUD acknowledgement.
- Implement pause/resume, screenshot UI hiding, precision input scaling, and immediate warp cancel.
- Add Orbit, Chase, Locked, and Free camera frames plus reset and FOV zoom hooks without changing floating-origin authority.

## 3. Precise maneuver editor

- Keep the single-node model and add direct numeric inputs with a shared 0.1/1/10/100 step selector.
- Add snap actions for next Ap/Pe and any currently computable orbital events.
- Show post-burn Ap/Pe/inclination/period and compare node delta-v with remaining vessel delta-v.
- Warp to burn start minus 30 seconds using estimated burn duration.
- Add conic click placement and node-time dragging first; add RTN drag handles without removing the fine-control panel.

## 4. Verification and polish

- Add focused pure tests only where new math/input mapping is introduced.
- Re-anchor tutorial selectors affected by the HUD changes.
- Run the complete Vitest suite, production build, and a browser smoke pass for flight/map interaction.
- Preserve the user's deployment-file edits and do not commit or push without an explicit request.
