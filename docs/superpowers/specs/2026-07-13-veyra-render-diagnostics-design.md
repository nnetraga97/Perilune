# Veyra Render Diagnostics Design

**Date:** 2026-07-13

**Status:** Approved design; implementation not started

## Goal

Add bounded, structured diagnostics that can explain Veyra rendering defects which produce no console error. The first diagnostic target is the visible terrain LOD shifting, square chunk boundaries, compact/terrain flashing, and radial cloud-shell lines seen during Medium and High ascent. The same tooling must capture the reverse orbit-to-surface path.

This slice produces evidence only. It does not change terrain selection, transition behavior, cloud geometry, materials, shader behavior, or visual quality. After a trace reproduces the defects, implementation stops for a user review of the evidence and the proposed rendering fixes.

## Recorded Evidence

The supplied 77.57-second High-quality localhost recording shows:

- abrupt square terrain-region changes during ascent;
- hard boundaries that follow terrain chunk shapes;
- repeated coarse-to-fine surface movement before the view settles at altitude;
- a radial striped band in the cloud layer near the horizon; and
- no corresponding console error or application failure.

The current default development tier is Medium. The user has observed the same defect family on Medium and High.

## Scope

### Included

- deterministic `?quality=medium|high` startup selection;
- lightweight rendering anomaly recording in normal sessions;
- detailed rendering sampling behind `?renderDebug=1`;
- a typed, bounded in-memory diagnostics recorder;
- terrain LOD, terrain coverage, compact/terrain transition, cloud-shell, renderer-manager, and planet-asset events;
- a browser-readable snapshot and manual JSON export path;
- production-game Medium and High ascent/descent diagnostic journeys;
- screenshots and structured logs at fixed rendering checkpoints; and
- focused unit, integration, and Playwright coverage for the diagnostics themselves.

### Excluded

- terrain geomorphing, LOD crossfades, or replacement-policy changes;
- compact/terrain transition changes;
- cloud mesh, transparency, sorting, UV, material, or shader changes;
- MapView authored-albedo integration;
- new close-range texture assets;
- physical scatter or obstacle work;
- Low-tier visual acceptance; and
- final Phase 5 performance or hardware certification.

## Runtime Selection

Startup reads the query string before constructing `WorldScene`:

- `?quality=medium` selects Medium;
- `?quality=high` selects High;
- missing or invalid `quality` selects Medium;
- `?renderDebug=1` enables detailed sampling; and
- every other `renderDebug` value leaves detailed sampling disabled.

The selected tier is injected into initial renderer construction. The application must not construct a Medium renderer and immediately replace it with High, because that would add an artificial asset transaction and contaminate the trace.

## Diagnostics Architecture

`RenderDiagnostics` is a renderer-owned service with no dependency on simulation state mutation. The game may supply read-only context such as simulation time, active body, and altitude when recording an event.

The service has two recording levels:

1. **Lightweight:** lifecycle changes, failures, and anomaly events only. This is always active.
2. **Detailed:** state samples capped at 10 Hz plus all lightweight events. This is enabled only by `?renderDebug=1`.

The recorder stores at most 4,096 entries in a fixed-size ring buffer. When full, new entries overwrite the oldest entries and increment an `overwrittenEntries` counter. Recording must not allocate an unbounded queue or retain renderer objects, textures, geometries, DOM nodes, errors, or other mutable owners.

Every record is plain serializable data with these common fields:

```ts
interface RenderDiagnosticEntry {
  sequence: number;
  wallTimeMs: number;
  simulationTime: number | null;
  bodyId: string | null;
  altitudeMeters: number | null;
  quality: 'medium' | 'high';
  subsystem: 'renderer' | 'assets' | 'transition' | 'terrain' | 'clouds';
  event: string;
  severity: 'sample' | 'state' | 'anomaly' | 'failure';
  data: Readonly<Record<string, string | number | boolean | null>>;
}
```

The public browser API is read-only except for explicit local export:

```ts
window.__RENDER_DIAGNOSTICS__.snapshot()
window.__RENDER_DIAGNOSTICS__.exportJson()
window.__RENDER_DIAGNOSTICS__.download()
```

`snapshot()` returns a frozen copy containing configuration, entries, current sequence, overwritten-entry count, and unique anomaly codes. `exportJson()` returns the same snapshot as formatted JSON. `download()` creates a user-initiated local JSON download and performs no network operation.

Diagnostics must never affect rendering behavior. A recording or serialization failure is caught internally, increments a failure counter, and does not escape into the render loop. The console receives at most one warning per anomaly code per session; detailed records remain in the ring buffer.

## Event Producers

### Renderer and asset lifecycle

Record:

- selected startup tier and debug mode;
- renderer candidate creation, preparation, compilation, commit, replacement, failure, and disposal;
- active renderer root count and committed renderer identity;
- asset-pack load start, channel selection, successful load, failure, fallback choice, commit, replacement, and disposal;
- selected texture path/type for albedo, normal, material, and clouds; and
- checked manifest digest and pack tier without storing texture bytes.

### Compact/terrain transition

Record state changes and detailed samples containing:

- requested presentation;
- `compact`, `prewarming`, `fading`, or `terrain` state;
- progress, compact coverage, and terrain coverage;
- coverage readiness and gap count;
- prewarm/visible-band decisions; and
- frame-pressure shortening.

Emit an anomaly when:

- progress decreases while terrain remains requested;
- state returns from `fading` or `terrain` to `prewarming` without a presentation request change;
- combined compact and terrain coverage falls below one within numeric tolerance; or
- the committed active body has zero visible coverage.

### Terrain LOD

Detailed mode records chunk request, queue, completion, installation, visibility, eviction, replacement, cancellation, and failure events. Each event includes the chunk key, face, depth, generation, parent key when applicable, and current worker queue/build/install state.

Record parent-to-four-child replacement as one explicit event containing the parent and all four child keys. Record per-sample totals for visible chunks by depth, pending chunks, coverage gaps, replacement roots, worker count, schedule time, install time, and geometry bytes.

Emit an anomaly when:

- a parent is hidden before all four immediate children are installed;
- the same chunk key is repeatedly requested in one generation after a successful installation;
- a current-generation job remains pending for more than two seconds;
- coverage readiness changes from true to false while terrain remains requested; or
- visible geometry or chunk totals change by more than a factor of two in one detailed sample without a quality or renderer replacement.

### Cloud shells

Record state changes and detailed samples for each `weather` and `wisps` shell:

- shell radius and altitude;
- camera altitude and signed distance from the shell;
- inside/outside/crossing classification;
- current opacity and base opacity;
- material side, render order, visibility, and shader-program invalidation count;
- geometry type and segment/detail counts;
- texture identity, channel, wrap modes, filters, anisotropy, and color space; and
- drift angle and texture scale.

Emit an anomaly when:

- material recompilation occurs repeatedly without a shell crossing or asset replacement;
- side selection oscillates across consecutive samples;
- opacity becomes non-finite or leaves its declared range; or
- cloud texture identity changes without a renderer transaction.

The diagnostics intentionally do not pre-classify the radial lines as a texture, mesh, sorting, pole, or transparency defect. The trace records enough state to distinguish those causes before a rendering fix is chosen.

## Data Flow

1. Startup parses immutable rendering options.
2. The game creates one `RenderDiagnostics` instance and injects it into renderer-owned systems.
3. Producers submit plain typed records at state boundaries; detailed state is sampled at most 10 times per second.
4. The recorder normalizes common context, writes to its ring buffer, and detects cross-event anomalies that require history.
5. `window.__RENDER_DIAGNOSTICS__` exposes frozen snapshots and explicit local export.
6. Playwright retrieves the snapshot after each journey and writes it under the ignored `test-results/veyra-render-diagnostics/` directory beside screenshots and run metadata.

## Diagnostic Journeys

Add production-game Playwright journeys for Medium and High. They must exercise the real game renderer and use normal UI input for actions; test hooks remain read-only probes.

Each tier covers:

- pad through ascent and atmosphere exit;
- the region around both cloud-shell crossings;
- low atmosphere and the atmosphere boundary;
- orbit presentation;
- orbit-to-atmosphere descent;
- both cloud-shell crossings in reverse; and
- return to low altitude/surface coverage.

Capture screenshots and diagnostic checkpoints at the pad, immediately before/inside/after each cloud shell, low atmosphere, atmosphere boundary, orbit, and the corresponding descent positions. Each artifact set records quality, browser version, viewport/drawing-buffer size, checked manifest digest, console errors, shader errors, asset errors, and diagnostics JSON. Empty error lists are recorded explicitly.

The journey may use a checked-in deterministic craft fixture loaded through the normal UI. It may add read-only probes for altitude and rendering state, but it may not teleport the vessel, mutate simulation state, force renderer transitions, or install assets through a test-only action.

## Verification

Unit tests cover:

- query parsing and Medium fallback;
- exact 10 Hz sampling cap;
- 4,096-entry overwrite behavior;
- monotonically increasing sequence numbers;
- frozen snapshot isolation;
- JSON serialization and download payloads;
- warning deduplication; and
- recording/serialization failure isolation.

Integration tests cover:

- terrain event completeness and parent/child replacement grouping;
- transition rollback and coverage anomaly detection;
- cloud crossing/side/recompile event completeness;
- renderer and asset transaction event ordering;
- absence of renderer-state mutation by diagnostics; and
- diagnostics disposal on page teardown.

Repository verification runs:

```bash
npm run validate:content
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

## Acceptance Criteria

The diagnostic slice is complete only when:

- Medium and High can be selected without editing source;
- lightweight and detailed modes obey their bounded recording contracts;
- manual snapshot and export work on localhost;
- production-game Medium and High ascent/descent journeys produce diagnostics and screenshots;
- the supplied defect family is reproduced or the trace explicitly proves it did not occur in that run;
- existing validation, tests, build, and browser journeys pass; and
- no rendering behavior has changed.

## Required Stop and Review Gate

After the first successful diagnostic runs, implementation stops. The evidence review must identify which recorded state changes coincide with:

- coarse/fine terrain movement;
- visible square chunk boundaries;
- any compact/terrain flash; and
- radial cloud lines.

The next design presents two or three evidence-backed rendering fixes with trade-offs. No terrain LOD, compact/terrain transition, cloud geometry, transparency, UV, material, shader, or asset-integration behavior changes are authorized until the user approves that follow-up design.
