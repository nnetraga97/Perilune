# UI M2 Mission Tools Implementation Plan

**Goal:** Surface the existing alarm, transfer-window, atmospheric-entry, targeting, and fleet systems through the workstream-1 window kit.

**Architecture:** Add only the missing authoritative contracts to sim/save: alarm vessel ownership, a consumable fired-alarm queue, and predicted entry peak-g. UI windows read `GameState` through closures and send mutations back through the game shell. Expensive entry prediction is signature-cached in `MapView`, alongside its existing conic prediction cache.

## 1. Alarm ownership and mission clock

- Add `vesselId` to alarms and migrate save v6 to v7.
- Preserve fired alarms long enough for the UI to present jump/snooze/dismiss actions.
- Add UT, MET, and next-alarm time to the HUD clock cluster.
- Register an alarm window with typed rows, custom creation, edit/delete, and vessel switching.
- Add node/Ap/Pe/SOI quick alarm actions.

## 2. Transfer planner

- Register a sortable transfer window driven by `allTransferPlans`.
- Show current/required phase dial, window ETA, departure/capture delta-v, and coast time.
- Default/highlight the active vessel target.
- Add create-alarm and sketch-node row actions.

## 3. Entry overlay

- Extend `EntryPrediction` with predicted peak-g.
- Cache prediction by orbit/node/thrust signature and render its atmospheric sample path and landing marker in map view.
- Add a compact entry card to the flight HUD with interface/landing ETA, landing coordinates, heat flux, impact speed, peak-g, and corridor state.
- Support a pinned landing site and show great-circle miss distance.

## 4. Targeting and fleet

- Add body rows and map-body click actions for focus and target selection.
- Draw Ap/Pe/AN/DN/SOI annotations with hover labels and warp actions where time is known.
- Register a fleet window for switching, renaming, debris cleanup, and home recovery.
- Run M2 unit/build/browser verification at the end; do not commit or push without explicit approval.
