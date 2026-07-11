# Perilune Planet Graphics Redesign

**Date:** 2026-07-10

**Status:** Approved design

**Scope:** Restore the interrupted M2 baseline, then build a scalable hybrid planet-rendering pipeline centered on orbit-to-ground flight and detailed surface operations.

## Objective

Perilune already has the difficult simulation foundation: deterministic terrain shared by rendering and physics, a cube-sphere quadtree, floating-origin coordinates, and continuous flight from orbit to the ground. The redesign preserves those systems while replacing the thin visual layer that currently makes planets look flat, generic, and dated.

The visual target is **grounded cinematic realism**. Planets should remain physically credible and readable, but atmosphere, exposure, clouds, materials, and color grading may be art-directed for depth and drama. The first milestone must improve both the orbit-to-ground journey and surface flight or landing; it is not a planet-viewer-only upgrade.

## Approved Product Decisions

- Use a hybrid planetary pipeline: licensed source assets and build-time generation feed data-driven runtime renderers.
- Keep deterministic procedural terrain as the authority for ground contact and vessel physics.
- Use dense non-colliding visual scatter plus sparse, nearby collision for large obstacles and landmarks.
- Fully develop three archetypes first:
  - **Veyra:** terrestrial, atmospheric, oceanic.
  - **Palla:** airless, cratered, regolith-covered.
  - **Tyran:** gas giant with bands, storms, and haze.
- Default to fiction-first texture remixes, but allow direct reuse of exceptional licensed assets when they already fit a body.
- Target 1080p at 60 FPS on Medium quality on approximately 2020-era integrated or entry-level GPUs. Higher tiers add quality rather than changing gameplay.

## Non-Goals

- Replacing the existing orbital, vessel, or terrain physics.
- Copying NASA Eyes or reproducing the real Solar System.
- Making all decorative scatter participate in physics.
- Requiring WebGPU. WebGL2 remains the baseline.
- Upgrading every celestial body before the three representative archetypes pass their acceptance gates.
- Adding volumetric terrain caves, destructible ground, weather simulation, or fully volumetric clouds in this milestone.

## Current-State Findings

The present renderer uses one generic rocky-body path. Terrain chunks use altitude-based vertex colors with `MeshLambertMaterial`; oceans are an opaque `MeshPhongMaterial` sphere; clouds are one 512-pixel procedural texture on a translucent shell; distant bodies are solid-color Lambert spheres. Atmosphere is represented primarily by changing the scene background and ambient light while the camera is inside it. Gas giants do not have a dedicated renderer.

This creates several visible problems:

- Harsh terminators and nearly black night sides without atmospheric limb scattering.
- Faceted terrain and noisy coastlines becoming prominent during approach.
- A hard visual identity change between distant spheres and near terrain.
- Uniform, low-frequency surface color with little material response at ground level.
- Similar-looking planets because seed, amplitude, frequency, and three palette colors carry most differentiation.
- No body-specific rendering model for gas giants, ice worlds, lava worlds, or cratered moons.

The repository is also not green at the approved design baseline. Commit `b5f5c76` added transfer-planning tests that depend on an absent atmospheric-entry predictor and unimplemented alarm state and persistence. Existing unrelated tests pass, but production type-checking and the full test command fail.

## Architecture

### 1. Simulation Authority

`terrainHeight(body, direction)` remains the single source of truth for solid ground. Large terrain features that affect landing or traversal—such as Palla's major craters and Veyra's large-scale relief—must be part of this authoritative function or a deterministic body-height provider called by it.

Visual-only normal maps, micro-displacement, decals, grass, pebbles, and dust must not change collision height. This boundary prevents a vessel from appearing to rest above or sink into terrain.

### 2. Planet Asset Compiler

A build-time compiler converts curated sources and body recipes into runtime-ready asset packs. It performs:

- Source blending, warping, recoloring, and seam correction.
- Equirectangular or cube-map projection normalization.
- Generation of albedo, normal, roughness, biome, cloud, and scatter maps.
- Packing compatible grayscale channels to reduce texture bindings and memory.
- Resolution-tier generation.
- GPU texture compression with conventional WebP, PNG, or JPEG fallbacks.
- Validation of source licenses, checksums, map dimensions, seams, and output budgets.

The compiler must be deterministic from input checksums, recipe version, and body seed. Generated outputs are reproducible artifacts; source downloads are not performed implicitly during a production build.

### 3. Asset Provenance

Every third-party input has a manifest record containing:

- Stable source URL and original filename.
- Author or organization.
- License identifier and license URL.
- Required attribution text.
- Local checksum.
- Bodies and channels that use the source.
- Transformations applied by the compiler.

An asset being publicly accessible does not make it reusable. Missing, ambiguous, or incompatible license metadata fails validation. Repository attribution and license documents must be updated in the same change that adds an asset.

### 4. Body Renderer Contract

`WorldScene` should depend on a body-renderer interface rather than constructing every body through `PlanetRenderer`. Each implementation owns its meshes, materials, texture state, and effects while exposing a shared lifecycle:

- Initialize from body definition, asset pack, renderer capabilities, and quality tier.
- Update from camera-relative body position, body-fixed camera position, sun direction, simulation time, and altitude.
- Report draw, triangle, texture-memory, scatter, and collision statistics.
- Change quality without recreating simulation state.
- Dispose of geometry, materials, textures, workers, and pooled objects.

The renderer factory selects an archetype from explicit body visual data. It must not infer major behavior from terrain amplitude or atmosphere presence alone.

## Body Archetypes

### Veyra: Terrestrial Renderer

Veyra establishes the complete orbit-to-ground stack:

- Original global geography produced from licensed sources and procedural masks.
- Global albedo and biome maps projected consistently onto distant and quadtree terrain geometry.
- Regional material blending driven by biome, altitude, slope, latitude, and moisture-like masks.
- Local triplanar detail for soil, rock, sand, and vegetation to avoid stretching on steep terrain.
- Fresnel ocean reflection, sun glitter, depth tint, and shoreline foam or wetness.
- Atmospheric limb, aerial perspective, and altitude-dependent haze.
- Two cloud scales with independent motion and optional Medium-or-higher cloud shadows.
- Deterministic biome scatter for grass, shrubs, rocks, and dust.

### Palla: Airless Renderer

Palla demonstrates that an airless body is more than recolored noise:

- Major craters and basin silhouettes modify authoritative terrain height.
- Fine crater, ejecta, and regolith maps supply visual detail below collision scale.
- Lighting preserves harsh sunlight and deep shadow without fake atmospheric haze.
- Material response uses high roughness, subtle albedo variation, and slope-aware dust.
- Boulder and ejecta placement follows crater and slope masks.
- Named or seeded landing landmarks remain recognizable from orbit and the surface.

### Tyran: Gas-Giant Renderer

Tyran does not use rocky terrain LOD:

- A dedicated sphere renderer displays layered atmospheric bands.
- Belt layers may rotate at different rates to create differential motion.
- Persistent storm masks provide stable, identifiable features rather than random per-frame noise.
- Limb haze and depth falloff communicate a deep atmosphere.
- Limited parallax may suggest cloud depth without implying landable terrain.
- The shared body contract leaves room for a later ring component.

## Orbit-to-Ground Continuity

The same compiled global maps feed both compact distant rendering and near terrain chunks. The renderer changes geometry and detail frequency with altitude, not planet identity.

1. **System view:** compact body geometry, correct phase and limb, low-resolution global maps.
2. **Orbital view:** global albedo, biome, ocean, clouds, and atmosphere; terrain LOD begins before the compact body disappears.
3. **Atmospheric flight:** regional material detail, aerial perspective, and cloud shadows blend in.
4. **Surface operations:** local triplanar detail, decals, dust, and instanced scatter dominate.

Near/far changes use screen-space error plus a bounded dithered cross-fade. A renderer may not hide a valid parent or compact fallback until its replacement is ready, preserving the coverage rule established by the M2 terrain-hole fix.

## Surface Scatter and Collision

Scatter cells are deterministic from body seed, cell coordinates, biome, slope, and altitude. They stream around the active camera or vessel and use GPU instancing.

Two layers are deliberately separate:

- **Visual layer:** dense grass, pebbles, small rocks, dust, and distant vegetation. These instances never create simulation objects.
- **Physical layer:** sparse large boulders, trees, cliffs, and landmarks. Pooled collision proxies exist only inside the active vessel's local physics radius.

Collision proxies have hard count and distance caps. Their activation must be stable enough to avoid obstacles appearing inside a stationary or slowly moving vessel. Saves store vessel state, not transient scatter instances; deterministic regeneration recreates the same environment.

## Quality Tiers and Budgets

WebGL2 remains the supported baseline. The existing Medium render budget of approximately 8 ms per frame remains the target.

- **Low:** 1K global maps, simplified atmosphere, sparse scatter, no cloud shadows.
- **Medium:** 2K global maps, full atmosphere and oceans, moderate scatter, selective cloud shadows; target 1080p/60 FPS on baseline hardware.
- **High:** 4K global maps, denser scatter, improved shadows, and higher atmosphere sampling.
- **Ultra:** optional 8K hero-body maps and maximum surface density for modern GPUs.

The performance overlay gains texture-memory estimates, scatter instances, and active collision-proxy counts alongside existing frame, draw, triangle, and chunk statistics.

## Failure Handling

- Missing body textures fall back to the body's procedural palette.
- A failed custom material falls back to a standard material rather than a black or invisible body.
- Unsupported compressed textures load conventional image alternatives.
- An invalid provenance manifest, missing required map, or over-budget generated pack fails the build.
- A failed scatter cell is discarded and deterministically regenerated on a later update.
- Collision-proxy pools refuse excess objects and retain the closest high-priority obstacles.
- Asset and shader failures log once with body and channel context to avoid per-frame console flooding.

## Testing Strategy

### Automated Tests

- Asset-manifest license and checksum validation.
- Deterministic compiler output for fixed recipes.
- Texture seam and expected-channel validation.
- Cube-face geometry and material continuity.
- LOD fallback coverage and transition readiness.
- Deterministic scatter placement and cell regeneration.
- Collision pool caps, prioritization, and cleanup.
- Quality-tier selection and procedural fallback behavior.
- Alarm, entry prediction, and save restoration tests needed to restore the M2 baseline.

### Browser and Visual Tests

Playwright captures stable reference views for Veyra, Palla, and Tyran at:

- Distant orbit.
- Low orbit or atmospheric boundary.
- Low flight.
- Surface or closest valid approach.
- Daylight and night-side lighting.

Automated camera journeys check for coverage gaps, black frames, shader errors, unbounded memory, and frame spikes. Snapshot comparison catches regressions, while manual art review remains the authority for whether a planet looks convincing.

### Completion Gates

- Production build and full unit suite pass.
- Existing playable-loop and terrain-descent tests pass.
- No missing-asset or shader errors in supported browsers.
- Medium quality stays within the agreed frame and memory budgets on baseline hardware.
- Veyra retains one recognizable identity from orbit to contact.
- Palla reads as a cratered moon rather than palette-swapped generic terrain.
- Tyran visibly behaves as a gas giant rather than a solid rocky sphere.

## Delivery Sequence

1. Restore the interrupted M2 baseline by completing alarm state and persistence plus atmospheric-entry prediction. Keep and validate the transfer planner.
2. Add asset provenance, compiler validation, body visual definitions, body-renderer interface, quality control, and fallback loading.
3. Implement Veyra's global material, atmosphere, ocean, clouds, lighting, and near/far continuity.
4. Add Veyra's regional and local surface materials, decals, scatter, dust, cloud shadows, and selective collision.
5. Implement Palla's authoritative major craters, regolith materials, ejecta, boulders, and airless lighting.
6. Implement Tyran's dedicated band, storm, and limb-haze renderer.
7. Apply the established archetypes to remaining bodies and tune each body's assets and performance.

Each step must leave the build and relevant tests green. Asset licensing and attribution changes ship with the assets they govern.

## References

- NASA Eyes on the Solar System: https://eyes.nasa.gov/apps/solar-system/#/home
- SoumyaEXE 3D Solar System ThreeJS: https://github.com/SoumyaEXE/3d-Solar-System-ThreeJS
- Existing rendering architecture: `ARCHITECTURE.md`, `RENDERING.md`, and `PERFORMANCE.md`
