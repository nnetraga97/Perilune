# Sol Near-Ground Visual Completion — 2026-07-20

Completion record for `docs/superpowers/plans/2026-07-20-near-ground-visual-completion.md` on `feature/sol-earth-moon-visuals`.

The subsequent source-authority correction begins from the numeric and categorical baseline in `docs/performance/reference/sol-source-authority-baseline-2026-07.md`.

## Outcome

The visual-only pass is complete for every unconditional task. Earth and Moon now use deterministic, profile-driven geological scatter close to resolved terrain; land and ocean share one aerial-perspective contract; ocean motion is represented by bounded, footprint-filtered normal waves; and flight-owned solid materials receive the same Earth haze without mutating shared part-library materials. No simulation terrain, collision height, body scale, orbit, persistence, or gameplay authority changed.

The High local-cloud integration was deliberately **not** shipped. Its required depth-correct composition gate failed before production integration: the current forward renderer exposes neither a readable opaque-depth input nor a half-resolution composite boundary, depth reconstruction is not validated, and the existing shell cannot clip an integrated ray at the first opaque surface. The executable gate remains in `src/proto/localCloudCompositeProto.ts`; production retains the existing cloud path.

## Delivered rendering changes

- Three checked scatter profiles preserve Veyra output and add neutral Earth geology plus Moon regolith. Placement follows resolved terrain ownership and coverage, not altitude alone.
- Earth scatter rejects water and an authored launch-pad exclusion volume. Moon scatter accepts valid below-datum basins.
- Scatter instance buffers are fixed-capacity, reported in renderer diagnostics, subtracted from the streamed-terrain allocation, shadowed only on Medium/High, and disposed with the staged render stack.
- Compact land, streamed land, and ocean use the same coordinate-explicit aerial-perspective implementation. Reference sidecars report all three Earth consumers.
- Ocean waves use three body-fixed bands (46 m, 19 m, and 7.5 m), a 0.1 maximum tangent slope, quality-tier band counts, and per-band `fwidth` attenuation. Ocean geometry, datum depth, and horizon coverage remain unchanged.
- A per-`WorldScene` controller supplies Earth aerial state to flight-owned material variants, launch-site solids, and geological scatter. Shared model-library materials, geometries, and textures remain borrowed and unchanged. Moon/deep-space state is explicitly disabled.

## Full-matrix verification

- Sol visual reference: 60/60 stations passed (20 each on Low, Medium, and High).
- Captured runtime errors: 0 across all 60 sidecars.
- Content validation: passed.
- TypeScript typecheck: passed.
- Unit suite excluding the unrelated scratch test: 123 files, 829 tests passed.
- Production build: passed.
- Playable browser loop: passed build, launch, powered flight, save/load, and map open/close with no captured console error.
- Controlled ocean-wave browser proof: passed; the five-second near-water ROI changed by 0.000991 mean normalized channel difference while the horizon-row ROI changed by 0.000473.

| Tier | Stations | Max p50 ms | Average p50 ms | Max p95 ms | Max draws | Max triangles | Runtime errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Low | 20 | 8.335 | 8.327 | 9.365 | 188 | 113,088 | 0 |
| Medium | 20 | 8.365 | 8.333 | 9.745 | 275 | 306,720 | 0 |
| High | 20 | 8.345 | 8.328 | 18.065 | 170 | 413,888 | 0 |

The High p95 maximum remains `moon-surface`, the same station identified in the baseline as entering the 16.67 ms pacing bucket. Its p50 changed from 8.365 ms to 8.345 ms. Medium steady-state p50 remained inside the baseline envelope and no station approached the 1 ms stop threshold.

## Targeted before/after measurements

| Tier | Station | p50 before/after ms | p95 before/after ms | Draws before/after | Triangles before/after | Visible scatter | Scatter bytes | Terrain allocation bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Medium | earth-ground | 8.320 / 8.325 | 9.280 / 9.260 | 142 / 144 | 221,600 / 225,144 | 122 | 162,560 | 52,432,096 |
| Medium | earth-ocean-horizon | 8.345 / 8.345 | 9.425 / 9.325 | 129 / 129 | 213,280 / 213,280 | 0 | 162,560 | 52,432,096 |
| Medium | moon-surface | 8.325 / 8.330 | 9.280 / 9.350 | 167 / 169 | 106,880 / 119,444 | 393 | 319,872 | 133,897,856 |
| High | earth-ground | 8.330 / 8.335 | 9.210 / 8.725 | 47 / 42 | 319,104 / 309,112 | 206 | 319,872 | 16,277,920 |
| High | earth-ocean-horizon | 8.330 / 8.335 | 9.285 / 8.510 | 32 / 37 | 284,544 / 296,064 | 0 | 319,872 | 16,277,920 |
| High | moon-surface | 8.365 / 8.345 | 17.215 / 18.065 | 178 / 170 | 410,112 / 413,888 | 848 | 634,496 | 133,583,232 |

Draw and triangle totals on streamed-terrain stations include the settled quadtree selected for that capture, so small negative or positive deltas are not interpreted as the scatter geometry alone. Fixed buffer bytes and visible instance counts are the authoritative scatter measures. Low owns 57,728 Earth scatter bytes and 110,208 Moon scatter bytes but does not enable real-time scatter shadows; the captured Low Moon surface exposed 64 instances.

All captured Earth stations report `compact-land`, `streamed-land`, and `ocean` as aerial consumers. Moon stations report no terrestrial aerial consumer. No local-cloud target bytes were allocated because the feasibility gate did not approve a production method.

## Visual plates and retained artifacts

The generated comparison set is retained under `test-results/sol-near-ground-comparison/`. In each plate, the left column is baseline commit `b4868a12a7dec9992c8d8b37319b69d1850fb4b3` and the right column is the completed implementation. Rows are Earth ground, Earth ocean horizon, and Moon surface.

- Medium plate: `test-results/sol-near-ground-comparison/plate-medium.png`
- High plate: `test-results/sol-near-ground-comparison/plate-high.png`
- Individual PNG and JSON pairs: `test-results/sol-near-ground-comparison/{before,after}/{medium,high}/`
- Controlled wave captures: `test-results/sol-ocean-wave-reference/`

The plates show the intended bounded change: sparse, terrain-attached geological scale cues at solid ground and lunar stations; no scatter over the ocean; and ocean motion that does not alter the horizon silhouette. Full-disk Earth, Earth–Moon true scale, Sun, and lunar orbit stations retained their composition and scale.

## Deferred work

- High local clouds remain deferred until the renderer has an approved opaque-depth/composite boundary or a shell method proves correct first-surface clipping without radial artifacts.
- Higher-resolution collision-authoritative height remains a separate architecture task because it affects simulation authority and startup ordering.
- Artemis IV mission playback and mission UI remain outside this visual-and-scale pass.
