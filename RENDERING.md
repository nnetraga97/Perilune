# Perilune — Rendering

Three.js on required WebGL2 (ADR-002), logarithmic depth buffer for planetary
range, and ACES tone mapping. Startup requests WebGL2 directly; WebGL1 has no
fallback and receives the clear `Perilune requires WebGL2` capability screen.
Fragment `highp`, compressed-texture extensions, maximum texture size,
anisotropy, and drawing-buffer samples are recorded in `RenderCaps`. The
atmosphere path degrades from analytic to lookup to limb haze according to
measured fragment precision. WebGPU is not detected or used by the current
runtime.

## Coordinate handling (ADR-003)

The camera sits at the scene origin. All world positions are computed in
f64 relative to the camera each frame before being written to f32 scene
graph positions (floating origin). Planet chunks additionally keep their
origin in f64 body-fixed coordinates and are placed camera-relative per
frame, so precision holds from interplanetary distance to 1 m altitude
(validated by the M0 descent e2e).

## Body renderer platform

`src/content/bodyVisuals.ts` is the sole visual-assignment registry. Selection
is explicit and never inferred from terrain amplitude or atmosphere data.
Auren is assigned `star`; Ashen, Vess, Veyra, Palla, Wisp, Rusk, Tyran, Brimm,
Glacia, Mote, and Farfall are assigned `legacy` in Phase 3. Each non-star also
records its future terrestrial, airless, or gas-giant target archetype without
activating that later art.

`BodyRendererManager` keeps one committed renderer visible while a candidate
loads assets, prepares coverage, compiles shaders, and passes resource budgets.
Only then does it swap roots atomically. A failed candidate and every partial
asset are disposed while the committed renderer remains visible. Quality
replacement uses the same transaction. `RendererResourceLedger` permits at
most one flight-scale pack and reports checked pack residency separately from
procedural renderer resources.

Planet-pack metadata comes from the build-generated, digest-checked manifest.
Runtime paths and byte counts therefore cannot bypass content validation.
KTX2/Basis transcoders are synced from the pinned Three.js dependency during
development/build preparation. The checked manifest is currently empty, so
the shipped Phase 3 bodies use their procedural legacy/star renderers; authored
body packs and later archetype art are planned for Phase 4 and beyond, not
claimed as shipped.

`BodyMaterialDescriptor` is shared by compact flight and MapView presentation.
It carries solid/gas/star identity, the body palette, and the stable body-fixed
orientation contract: +Z is north and longitude is `atan2(y, x)`. Collision
and contact heights remain exclusively owned by the simulation terrain
evaluator.

`StarBodyRenderer` exclusively owns Auren's disk/corona, directional light,
light color/intensity, and exposure contribution. No scene creates a second
flight-scale star presentation.

## Legacy planet detail (`src/render/planet.ts`)

- Cube-sphere with tan-warped faces (even angular chunk density).
- Quadtree LOD split by camera distance; max depth scales with body radius
  (finest vertex spacing ≈ 1.5 m on Veyra).
- Chunk meshes: positions/normals/vertex-colors built from the shared
  terrain height function; normals by central differences; altitude+slope
  palette per body.
- Skirts hide LOD cracks; conservative horizon culling + frustum culling;
  per-frame chunk build budget prevents hitches; LRU cache with disposal.
- Oceans: tessellated sphere at datum with specular water material.
- Clouds: procedural fBm canvas texture on a translucent shell, drifting
  relative to the ground, fading out when the camera nears the layer.

## Atmosphere

Sky color and ambient light blend with altitude and sun elevation; the
background returns to starfield black above the atmosphere. (Full
scattering shader is scheduled for the visual-quality milestone.)

## Phase 2 feasibility fixture

`?proto=feasibility` is a bounded profiling scene, not the production planet
renderer. It composes authoritative Veyra terrain with a representative
analytic atmosphere, ocean highlight path, two cloud scales, one shadow
receiver, complementary near/far transition meshes, 50,000 instanced visual
scatter items, and 128 quality-invariant physical-proxy instances. The
terrain still samples the shared simulation evaluator; the fixture does not
introduce a second height authority.

The combined profile intentionally forces transition overlap for the entire
measurement window so its GPU cost participates in p95. Exported telemetry
labels that mode explicitly and records overlap time, draw calls, and
triangles; overlap time counts measured journey phases only and does not
represent the production transition clock.

Terrain, atmosphere, ocean, clouds, visual scatter, and transition overlap
can each be disabled independently for profiling. Physical proxies remain
active under every quality reduction. The renderer records terrain
scheduling/installation time and estimated active/total GPU allocation. A
delayed WebGL2 timer-query ring reports GPU work without blocking and discards
disjoint results. `npm run profile:feasibility` exports the three-journey
record described in `PERFORMANCE.md`.

## Vessels (`src/render/vesselMesh.ts`)

Parts render from cached primitive geometries (cylinder/cone/capsule/dome/
box/panel) with a consistent industrial palette and accent bands — the
original Skyward Cooperative design language. Engine plumes are additive
cones scaled by throttle and flared by vacuum; destroyed/detached parts
drop out of the visual on sync.

## Scenes

- `WorldScene`: flight — lazy legacy terrain only for the active solid SOI,
  descriptor compact relatives, vessels, starfield, and Auren presentation
  owned by `StarBodyRenderer`.
- `MapView`: 1:100,000 orbital display — conic lines (elliptic + hyperbolic
  sampling), SOI shells, encounter markers, node widgets.
- `Editor`: workshop scene with grid, pad, key/rim lighting, ghost-part
  placement preview.

## UI

Direct DOM with per-frame node mutation (no framework re-render). The
navball is a 2D canvas instrument: pitch ladder, roll, heading, and
prograde/retrograde/node markers projected from world vectors.

## Context and ownership

`RenderContextLifecycle` prevents default context disposal, pauses all draws
and GPU query calls while lost/restoring, and serially rebuilds committed body
renderers from their descriptors after restoration. A partial rebuild failure
settles all owners and enters a renderable fallback state retaining the last
usable visuals. `WorldScene`, `MapView`, renderer managers, asset loaders, and
the production GPU profiler each have idempotent cleanup; the game releases
them on page teardown.

MapView never loads terrain, scatter, or flight packs. Its compact meshes use
the shared descriptors and update every displayed quaternion from
`bodyOrientation(game.time)`. Its directional light is recomputed each frame
from the focus-body center toward Auren in map coordinates. Existing orbital
scale, SOI shells, deposit markers, encounter prediction, and maneuver editing
remain independent of the visual material path.

## Production GPU telemetry

The game-lifetime `GpuSubmissionProfiler` wraps only actual flight and map
`renderer.render` submissions in the non-blocking `GpuTimerRing`. Unsupported
or saturated rings never delay a frame; begin/end are balanced even when a
render throws. Delayed valid/disjoint/invalid results plus pending,
unavailable, and saturation counts feed typed F3 overlay fields alongside
draws, triangles, renderer managers, checked-pack residency, transaction
duration, failures, and context fallback. A restored context always receives
a fresh query ring, so pre-loss queries are never reused. No decorative status
dots are used.
