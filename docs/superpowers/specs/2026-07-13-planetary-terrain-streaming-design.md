# Shared Planetary Terrain Streaming Design

**Date:** 2026-07-13

**Status:** Approved design; implementation planning not started

## Goal

Replace the current monolithic cube-sphere traversal with a reusable planetary terrain streaming engine that preserves complete surface coverage, selects detail by projected screen-space error, and makes parent/child LOD changes visually continuous. Veyra is the first certification target, but no traversal, scheduling, residency, transition, or failure rule may depend on Veyra's identity, radius, textures, atmosphere, or terrain recipe.

The engine must fix the two terrain defects established by the Veyra diagnostic runs:

- the detailed terrain loses coverage after cache eviction and causes the compact orbital sphere to reappear; and
- visible square regions pop or shift during immediate parent/child LOD replacement.

The governing invariant is:

> Resource pressure may reduce or delay terrain detail, but it may never remove the best complete surface coverage already available.

## Decision

Perilune will retain its custom Three.js/WebGL2 renderer and procedural surface authority. It will not embed CesiumJS or replace the current terrain with geometry clipmaps in this phase.

The existing six-face cube-sphere, worker-built regular-grid chunks, body-fixed material coordinates, camera-relative rendering, and shared terrain evaluator remain valid foundations. The engine around those chunks will be redesigned around the mature virtual-globe separation of concerns: traversal, renderability, request priority, residency, continuity, and transition state.

This is not a port of Cesium internals. Cesium's private quadtree is coupled to its own scene, frame state, tile provider, imagery system, and replacement cache. Perilune will implement the smaller game-specific contracts needed by its existing renderer and simulation.

## Existing Baseline and Failure

`PlanetRenderer` currently combines all of these responsibilities in one update traversal:

- distance-based LOD selection;
- missing-chunk requests;
- worker completion installation;
- fallback selection;
- mesh visibility;
- prediction;
- cache eviction; and
- diagnostic observation.

LOD is selected from `distance < node.worldSize * splitFactor`. Viewport height and camera FOV do not reach the terrain renderer, despite the earlier planet graphics design requiring screen-space error. The cache removes the least recently used chunk that is not visible in the current frame. A root or intermediate ancestor may therefore be evicted even though it is the only safe fallback for future movement.

The Veyra Medium and High diagnostic flights captured this exact chain: a root fallback was evicted at a full cache, the next traversal reported a coverage gap, `CoverageTransition` returned to prewarming, terrain coverage became zero, and the compact sphere became fully visible. Separate evidence showed complete child sets replacing their parent immediately, exposing square LOD regions even when no coverage hole existed.

The existing global compact-to-terrain transition is not an LOD transition system. It controls the presentation of the whole planet and must no longer be used to recover from ordinary terrain streaming churn after detailed terrain has become active.

## Scope

### Included

- a body-agnostic planetary surface provider contract;
- screen-space-error terrain selection from geometric error, viewport, and FOV;
- explicit tile lifecycle and renderability state;
- previous-frame-aware traversal and coverage resolution;
- prioritized asynchronous generation and installation;
- byte-accounted soft and hard terrain residency budgets;
- protected current, previous, fallback, and transition coverage;
- six always-available root fallbacks after initial terrain readiness;
- split and merge hysteresis;
- complementary dither transitions for parent/four-child replacement;
- reversible transitions when the desired LOD changes mid-transition;
- 2:1 neighbor balancing across each cube face and across cube-face seams;
- predictive requests from body-fixed camera velocity;
- bounded failure retry while retaining valid ancestors;
- integration with the existing rendering diagnostics;
- generic tests using multiple radii and terrain providers; and
- Veyra Medium and High launch, orbit, and deorbit certification.

### Excluded

- embedding CesiumJS or maintaining a Cesium source fork;
- geometry clipmaps, mesh shaders, WebGPU, or GPU-driven traversal;
- tiled or virtual texture streaming;
- changes to authoritative terrain height or flight physics;
- physical scatter, obstacle broadphase, or collision proxies;
- cloud-shell geometry, UV, transparency, or line-defect changes;
- atmosphere or ocean redesign;
- MapView changes;
- changes to orbital rails or the physics bubble; and
- activation of the terrestrial renderer for another production planet.

## Engine Boundaries

### `PlanetSurfaceProvider`

The shared engine consumes a provider instead of a Veyra-specific body implementation.

```ts
interface PlanetSurfaceProvider {
  readonly bodyId: string;
  readonly radiusMeters: number;
  readonly maximumDepth: number;
  readonly generation: number;

  rootTile(face: CubeFace): TerrainTileDescriptor;
  children(tile: TerrainTileDescriptor): readonly [
    TerrainTileDescriptor,
    TerrainTileDescriptor,
    TerrainTileDescriptor,
    TerrainTileDescriptor,
  ];
  geometricErrorMeters(tile: TerrainTileDescriptor): number;
  build(request: TerrainBuildRequest): TerrainChunkGeometryResult;
}
```

The provider owns spherical projection, terrain recipe access, conservative geometric-error metadata, and worker-safe geometry generation. It exposes an immutable, serializable build snapshot to workers rather than sending live simulation objects. It may sample the authoritative terrain evaluator, but the streaming engine never reads Veyra content, textures, biome rules, or simulation objects.

`geometricErrorMeters` is the conservative maximum positional deviation represented by rendering that tile instead of further descendants. It must be finite, nonnegative, and monotonically non-increasing with depth. The Veyra provider derives its bound from the recipe's finite octave counts, explicit base/detail/rough frequencies, amplitude, crater metadata, and the sampling resolution at each depth. Future providers must supply equivalent finite metadata. A provider that cannot produce a valid bound is rejected during renderer preparation rather than silently falling back to distance-only LOD.

### `PlanetTerrainEngine`

`PlanetTerrainEngine` owns one active body's tile graph, traversal, scheduler, residency manager, LOD transitions, meshes, and terrain diagnostics. `TerrestrialBodyRenderer` owns the engine and supplies the material and frame data. The engine does not own the compact sphere, ocean, atmosphere, clouds, scatter, renderer transaction, or simulation state.

### Frame input

Terrain selection receives an immutable frame containing:

- body-fixed camera position and velocity;
- camera-relative body origin;
- body orientation;
- vertical FOV radians;
- drawing-buffer height in physical pixels;
- wall-clock delta;
- frame-pressure state;
- quality policy; and
- current renderer generation.

CSS viewport height is not used for LOD. Drawing-buffer height makes selection respond correctly to device pixel ratio and resolution scaling.

## Tile Identity and Lifecycle

A tile ID contains cube face, depth, integer X, and integer Y. Floating-point UV strings are not authoritative identity. UV bounds are derived from the integer ID, eliminating rounding-dependent parent and neighbor reconstruction.

Each tile has one explicit lifecycle:

```ts
type TerrainTileState =
  | 'unloaded'
  | 'queued'
  | 'building'
  | 'ready'
  | 'installed'
  | 'failed';
```

Selection roles are separate flags rather than lifecycle states:

- desired this frame;
- rendered this frame;
- rendered last frame;
- coverage fallback;
- transition source;
- transition destination;
- prediction-only; and
- eligible for eviction.

A tile is renderable only when its current-generation geometry is installed, its material dependencies belong to the committed renderer transaction, and its GPU resources are valid. Worker completion alone does not make a tile renderable.

Stale-generation results are discarded without changing current coverage. A failed tile retains its nearest renderable ancestor and enters bounded retry state.

## Frame Pipeline

Every terrain update executes these phases in order:

1. Drain completed worker results into an installation queue.
2. Install within the frame's installation time and reserved-byte budget.
3. Traverse the tile graph and produce a desired detail plan.
4. Balance neighboring leaves to a maximum depth difference of one.
5. Resolve the desired plan against renderability and previous-frame coverage.
6. Advance or reverse active LOD transitions using wall-clock time.
7. Produce the complete render set and request set.
8. Submit missing work through prioritized scheduler queues.
9. Apply visibility and camera-relative transforms.
10. Mark all coverage obligations in the residency manager.
11. Trim unprotected resources toward the soft byte target.
12. Publish diagnostics and immutable frame statistics.

Eviction never runs before the current frame has a complete render set and explicit protection set.

## Screen-Space Error Traversal

For a renderable tile, projected error is:

```text
screenSpaceErrorPixels =
  geometricErrorMeters * drawingBufferHeight
  / (2 * distanceToBoundingVolumeMeters * tan(verticalFovRadians / 2))
```

Distance is the conservative distance from the camera to the tile's displacement-aware bounding volume, clamped to a small positive value. Bounds include the provider's maximum inward and outward terrain displacement.

Initial tier limits are:

| Tier | Maximum SSE | Merge threshold |
| --- | ---: | ---: |
| Low | 4.0 px | 2.8 px |
| Medium | 2.5 px | 1.75 px |
| High | 1.5 px | 1.05 px |

A branch requests a split when its error exceeds the tier maximum. A previously split branch requests a merge only when its error falls below the merge threshold. The 30% hysteresis band prevents camera jitter or small FOV changes from repeatedly reversing LOD.

Traversal is near-to-far and applies frustum and spherical-horizon culling before refinement. Culled high-detail descendants may remain resident but do not retain render protection unless they are required by prediction, a transition, or previous-frame continuity.

The predicted traversal uses the body-fixed camera position projected 0.5 wall-clock seconds forward. Prediction submits work but never changes the current render set.

## Coverage Resolution

Coverage is resolved recursively from the six roots.

For each visible branch:

- render the selected descendants when the complete visible replacement is renderable;
- otherwise render the nearest renderable ancestor;
- if last frame rendered finer visible descendants and replacing them with a coarse ancestor would cause an abrupt detail loss, retain those still-visible descendants while the required intermediate fallback is loaded; and
- never return a partially covered branch.

All four immediate children must be installed before a parent-to-child transition starts, even when one child is currently horizon-culled. This maintains stable branch ownership as the camera moves during the transition. Deeper visible descendants may stand in for an immediate child only when their subtree completely covers that child's quadrant.

After initial terrain readiness, all six root tiles remain installed for the lifetime of the engine generation. They count against the terrain budget and are universal fallbacks, not quality-tier exceptions.

Once global compact-to-terrain presentation has reached `terrain`, ordinary tile loading, cache pressure, or retry may not request compact presentation. Compact presentation may return only because:

- the camera explicitly leaves the terrain presentation band;
- a renderer or quality transaction replaces the entire terrain engine; or
- context loss invalidates all detailed GPU resources and the committed fallback transaction takes ownership.

## Neighbor Balance and Cracks

The selected render set is a restricted quadtree: edge-adjacent tiles may differ by at most one depth level. Balancing may request a coarser selection or an additional split, but it may not create an uncovered edge.

Neighbor lookup must cross cube-face boundaries with a tested face/edge orientation table. Integer tile coordinates are transformed across the boundary before the neighbor depth is evaluated.

Skirts remain a secondary crack guard. They are not the LOD transition mechanism and may not be enlarged enough to form visible terrain walls. The existing bounded skirt-depth rule remains unless certification demonstrates a seam that requires a separately reviewed edge-stitching design.

## LOD Transitions

Each transition represents one parent and its complete four-child replacement set. The same mechanism handles splits and merges.

Transition requirements:

- start only after source and destination sets are fully renderable and residency-protected;
- use one stable transition ID and one progress value for the parent and all four child quadrants;
- use complementary stochastic discard predicates, so every screen sample belongs to exactly one side of the transition;
- use a stable screen-space noise function that does not change from frame to frame;
- take 0.35 wall-clock seconds normally and 0.2 seconds under sustained frame pressure;
- never count loading time as transition time;
- reverse from the current progress when the desired LOD changes before completion;
- serialize nested transitions on the same branch; and
- release the old set only after completion has been submitted for one full frame.

For a split at progress `p`, children retain samples where `noise < p`; the parent retains samples where `noise >= p`. Merge uses the same masks with decreasing progress. Transparent alpha blending is not used, avoiding coplanar overdraw and depth-sorting artifacts.

The terrain material receives per-draw transition role and progress without cloning authored textures per chunk. Shadow and depth passes use the same discard predicate as the color pass so a transition cannot create detached shadows or depth silhouettes.

## Scheduling

Generation work is placed into ordered queues:

1. **Coverage blocker:** missing root, fallback, or transition-destination tile required to maintain a complete render set.
2. **Previous-frame continuity:** an intermediate tile needed to avoid a severe detail rollback.
3. **Visible refinement:** current-view children requested by SSE.
4. **Predicted refinement:** work from the 0.5-second camera projection.
5. **Background:** ancestors or siblings retained to improve future movement.

Within a queue, priority is determined by visibility, projected error, distance to view center, depth, and request age. Starvation prevention raises an old request within its queue but never promotes background work above a coverage blocker.

The scheduler reserves estimated geometry bytes before submitting a job. Worker count, submissions per frame, scheduling time, and installation time remain quality-policy inputs. Cancellation is generation-based for renderer replacement and item-based for queued prediction work that is no longer relevant. An already-building current-generation job may finish, but it cannot displace protected coverage.

## Residency and Resource Pressure

Residency is measured in actual geometry bytes, including attributes and indices. Chunk count remains diagnostic information but is not the eviction budget.

The renderer ledger gives the terrain engine a tier-specific geometry allocation after committed textures and fixed renderer passes are charged. The engine uses:

- a soft target equal to 75% of its terrain allocation; and
- a hard reservation limit equal to 100% of its terrain allocation.

The soft target is an eviction goal, not a visual-quality control. Current render tiles, last-frame continuity tiles, roots, active transition sets, coverage fallbacks, and submitted-job reservations are protected. The protected set may keep residency above the soft target.

No refinement job is submitted when its reservation would exceed the hard reservation limit. The engine first cancels irrelevant prediction/background reservations, evicts unprotected least-recently-used tiles, and keeps or merges to coarser valid coverage. Actual installed bytes may cross the allocation only when a completed coverage-blocking result was underestimated. That result is installed to preserve coverage, an overflow anomaly is recorded, unprotected resources are shed, and all new refinement is paused until installed plus reserved bytes return within the allocation. Prediction and background results that would overflow are discarded instead of installed.

Resource pressure therefore changes detail demand, never coverage. There is no path that evicts a currently rendered tile merely to make the cache statistic equal its target.

## Precision and Authority

Simulation and terrain evaluation continue using JavaScript number precision in body-relative and body-fixed coordinates. The renderer subtracts the camera in double precision before writing Three.js float transforms. Chunk vertices remain local to an f64 body-fixed origin.

The current logarithmic depth buffer remains the required baseline for this phase. Reverse depth may be evaluated separately when `EXT_clip_control` support and browser behavior are certified, but it is not required by this terrain redesign.

The surface provider uses the same authoritative terrain evaluator as ground contact. LOD, textures, normal maps, biome maps, and dither affect only presentation. A lower-detail visual tile may approximate the authoritative surface, but it never changes vessel altitude, collision height, landed state, or save data.

## Failure Handling

- A build failure leaves the nearest valid ancestor visible.
- Failed current-generation tiles retry with bounded exponential delays of 0.25, 0.5, 1, and 2 seconds, capped at 2 seconds while still requested.
- A tile that is no longer requested stops retrying and remains failed until requested again or the generation changes.
- A stale result is disposed without installation.
- Invalid geometric-error metadata prevents candidate preparation and retains the previously committed renderer.
- An impossible complete root set prevents the global compact-to-terrain fade from starting.
- Context loss delegates to the existing renderer lifecycle; detailed terrain is rebuilt transactionally while committed fallback coverage remains owned by the renderer manager.
- Diagnostics may observe every decision but may not alter selection, priority, transition, or eviction.

No ordinary tile failure throws from the render loop or produces an uncovered planet.

## Diagnostics

The existing bounded diagnostics are extended rather than replaced. Detailed mode records:

- desired, resolved, rendered, and previous render sets by depth;
- per-tile SSE and the tier threshold for state-changing selections;
- renderability and lifecycle transitions;
- scheduler queue, priority, reservation, start, completion, cancellation, and retry;
- protected and evictable bytes;
- soft target, hard limit, reserved bytes, installed bytes, and overflow;
- coverage fallback choice and reason;
- neighbor-balance changes;
- transition start, direction, reversal, progress, completion, and release; and
- compact/terrain presentation state.

New anomaly conditions include:

- incomplete root coverage after initial readiness;
- a rendered branch with no complete coverage;
- eviction of a protected tile;
- submission beyond the hard reservation limit;
- adjacent rendered tiles differing by more than one depth;
- immediate parent/child replacement outside a completed transition;
- non-complementary LOD masks;
- nested active transitions on one branch;
- an SSE-selected refinement missing viewport or FOV data; and
- compact presentation returning during a continuous terrain request.

Normal sessions retain only state changes, failures, and deduplicated anomaly warnings. Detailed samples remain capped at 10 Hz, while lifecycle batches preserve every state change needed to reconstruct a frame.

## Verification and Acceptance

### Deterministic unit and integration coverage

Tests must prove:

- integer parent, child, and cross-face neighbor identity;
- valid monotonic geometric-error metadata for synthetic and production providers;
- SSE changes correctly with FOV, drawing-buffer height, distance, and tier;
- split/merge hysteresis prevents threshold oscillation;
- traversal produces complete coverage from mixed tile states;
- previous-frame descendants remain when a coarse replacement would lose visible detail;
- all four quadrants are ready before replacement begins;
- the restricted quadtree holds across cube-face seams;
- scheduler priority is coverage, continuity, visible, predicted, then background;
- byte reservations prevent unbounded asynchronous oversubmission;
- protected coverage survives soft-target and hard-limit pressure;
- resource pressure retains coarser complete terrain;
- split, merge, reversal, and frame-pressure transition timing are wall-clock deterministic;
- color, depth, and shadow masks are complementary;
- failures, retries, stale completions, quality changes, and disposal preserve ownership; and
- providers with small, large, and non-Veyra radii use identical engine behavior.

Production code under the shared engine may not contain `veyra` string checks. Veyra-specific content remains in its provider, descriptor, recipe, and asset pack.

### Veyra certification

The existing production-game Medium and High Playwright journeys are the initial certification harness. Each tier must complete pad launch, both cloud-shell crossings, atmosphere exit, stable orbit, deorbit, atmosphere entry, and low-altitude descent using normal UI input.

Each tier must satisfy:

- zero page, console, shader, asset, or recording errors;
- zero terrain coverage gaps after initial detailed-terrain readiness;
- zero coverage-readiness loss while terrain remains requested;
- zero compact/terrain transition rollback during a continuous request;
- zero protected-tile eviction;
- zero immediate parent/child replacement outside an LOD transition;
- zero neighbor depth violations;
- no hard-limit reservation violation;
- every LOD replacement has a start, bounded progress, completion, and release record;
- resident and reserved geometry remain within the declared resource policy;
- terrain scheduling and installation remain at or below 2 ms p95 each on the reference M3 Max run; and
- production build, typecheck, content validation, focused tests, broad tests, and the full Playwright suite pass.

Visual acceptance requires side-by-side review against the supplied recording. At normal playback speed, neither the compact orbital sphere nor hard square terrain replacements may be visible during the certified ascent or descent. Fine-grained transition dither may be visible only during close inspection or paused frames; it may not form a stable square boundary, shimmer between frames, or detach shadows.

The cloud radial-line defect is not an acceptance criterion for this terrain phase. Its isolated weather-shell fix follows after terrain certification.

## Rollout

The shared engine is integrated behind the existing terrestrial renderer contract. Veyra remains the only production body assigned to the terrestrial renderer during certification. The legacy renderer remains the transaction fallback.

After Veyra passes Medium and High certification, a synthetic second body with different radius, terrain amplitude, and texture pack validates the generic provider boundary. Activation of an actual second planet remains a separate content and visual-acceptance decision.

The existing `PlanetRenderer` API may remain as a compatibility adapter during migration, but the monolithic traversal and LRU policy are removed rather than maintained as a second terrain implementation.

## External Architecture References

- CesiumJS `QuadtreePrimitive`: screen-space error, previous-frame selection, renderability, prioritized loading, and ancestor fallback. <https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js>
- CesiumJS `TileReplacementQueue`: current-frame protection and cache trimming that may remain above its target. <https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/TileReplacementQueue.js>
- OGC 3D Tiles specification: geometric error and replacement refinement. <https://docs.ogc.org/cs/22-025r4/22-025r4.pdf>
- NVIDIA GPU Gems 2, Geometry Clipmaps: nested terrain levels, transition regions, graceful degradation, and incremental updates. <https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry>
- Filip Strugar, Continuous Distance-Dependent Level of Detail for Rendering Heightmaps. <https://doi.org/10.1080/2151237X.2009.10129287>
- Cesium high-precision rendering and GPU relative-to-eye architecture. <https://cesium.com/blog/2015/05/26/graphics-tech-in-cesium-stack/>
- Three.js `WebGLRenderer` depth options. <https://threejs.org/docs/pages/WebGLRenderer.html>
