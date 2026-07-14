# UI M3 Workshop and Settings Implementation Plan

**Goal:** Finish the approved redesign with a usable workshop, persistent settings/bindings, science/archive visibility, and save management.

**Architecture:** Keep editor mutations inside `Editor` and wrap them in bounded craft snapshots for undo/redo. Palette/staging/context UI remains direct DOM over the craft graph. Profile-backed settings are applied as CSS variables and camera/input options in the game shell; gameplay saves remain untouched.

## 1. Workshop information architecture

- Add search, category cycling, sort controls, thumbnail-style part silhouettes, richer stat cards, and hover detail.
- Replace the preformatted engineering block with structured totals and per-stage rows.
- Replace `+sel` staging with draggable stage rows and draggable part chips, including reorder and live stage analysis.
- Expand saved-craft rows with summary, rename/duplicate/delete actions.

## 2. Editor mutations and shortcuts

- Add bounded snapshot history around place, move, delete, stage edits, new/load, rotation, re-root, and duplicate.
- Add surface-part rotation, snap increments, vertical alignment, camera fit/frame, held-part cancel, palette search/category keys, and documented symmetry controls.
- Add selected-part context/actions and action-group assignment for groups 1–0.

## 3. Settings and management windows

- Add profile-backed UI scale, palette, reduced motion, camera sensitivity/inversion/FOV/smoothing, and terminology settings.
- Extend `InputService` with persisted per-action key overrides and a remap surface that still drives the cheat sheet.
- Add science archive, notification log, and save/load browser windows using the existing campaign/save APIs.

## 4. Verification

- Update the focused workshop browser journey for search, staging, history, and action-group assignment.
- Run all unit tests, production build, and the core browser journeys.
- Preserve existing deployment changes; do not commit or push without explicit approval.
