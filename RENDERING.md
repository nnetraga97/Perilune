# Perilune — Rendering

Three.js on WebGL2 (ADR-002), logarithmic depth buffer for planetary range,
ACES tone mapping. WebGPU is detected and reported but not yet the active
backend. Every visual asset is procedural — no external art files.

## Coordinate handling (ADR-003)

The camera sits at the scene origin. All world positions are computed in
f64 relative to the camera each frame before being written to f32 scene
graph positions (floating origin). Planet chunks additionally keep their
origin in f64 body-fixed coordinates and are placed camera-relative per
frame, so precision holds from interplanetary distance to 1 m altitude
(validated by the M0 descent e2e).

## Planets (`src/render/planet.ts`)

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
triangles; it does not represent the production transition clock.

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

- `WorldScene`: flight — SOI body + family with full LOD near / simple
  spheres far, vessels, sun light + sprite, starfield.
- `MapView`: 1:100,000 orbital display — conic lines (elliptic + hyperbolic
  sampling), SOI shells, encounter markers, node widgets.
- `Editor`: workshop scene with grid, pad, key/rim lighting, ghost-part
  placement preview.

## UI

Direct DOM with per-frame node mutation (no framework re-render). The
navball is a 2D canvas instrument: pitch ladder, roll, heading, and
prograde/retrograde/node markers projected from world vectors.
