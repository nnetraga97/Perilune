# Perilune Planet Graphics Redesign

**Date:** 2026-07-10

**Status:** Revision 4 historical — fictional-system delivery sequence superseded on 2026-07-19

> The reusable rendering architecture in this document remains background context.
> Active planet-visual delivery is governed by
> `docs/superpowers/plans/2026-07-19-sol-earth-moon-visuals-and-scale.md`, which changes
> the target system to physically scaled Sun, Earth, and Moon and defers gameplay work.

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

- Replacing orbital mechanics, vessel construction, or the existing radial terrain-contact model wholesale. Targeted extensions required by this design—versioned terrain recipes, water-contact separation, gas-giant terminal behavior, and sparse obstacle contacts—are in scope.
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

The repository is also not green at the approved design baseline. Commit `b5f5c76` added transfer-planning tests that depend on an absent atmospheric-entry predictor and unimplemented alarm state and persistence. Existing unrelated tests pass, but production type-checking and the full test command fail. Independently, `npm run validate:content` references a missing `scripts/validate-content.mjs`, and the production build does not currently invoke content validation.

## Architecture

### 1. Simulation Authority

One pure, shared module exports `solidHeight(bodyId, recipeVersion, bodyFixedDirection)`. Browser physics, browser rendering, Node asset compilation, tests, and resource/scatter generation import this same evaluator; the compiler may not reimplement crater or relief profiles. Large terrain features that affect landing or traversal—such as Palla's major craters and Veyra's large-scale relief—must be part of this evaluator. Calling it for `surfaceKind: 'gas'` returns a typed no-solid-surface result rather than radius-zero terrain.

Visual-only normal maps, micro-displacement, decals, grass, pebbles, and dust must not change collision height. This boundary prevents a vessel from appearing to rest above or sink into terrain.

Oceanic bodies expose three different queries:

- `solidHeight`: raw land or seafloor height.
- `waterSurfaceHeight`: datum where an ocean exists.
- `contactSurface`: solid ground or water surface according to contact type.

Rendering uses raw seafloor geometry below an independent water surface. Vessel ground contact uses `contactSurface`; shoreline, foam, wetness, and ocean masks derive from the sign and slope of `solidHeight`. Terrain geometry may never be clamped to datum before the ocean pass.

### 2. Shared Body-Feature Recipes

Features that must agree between collision and imagery are defined once in a versioned, content-addressed `BodyFeatureRecipe`. A recipe contains deterministic feature records such as crater center direction, radius, depth, rim profile, ejecta seed, landmark bounds, and biome influence. Recipe versions are immutable after release. Both the runtime height provider and the asset compiler consume this recipe.

The compiler derives canonical height, ocean, normal, biome, and scatter masks by sampling the shared evaluator. It may not independently invent collision-scale features. Tests sample at least 10,000 seeded directions per representative body, including cube seams and poles, and assert:

- Canonical height reconstructed from the highest-resolution map agrees with the shared evaluator within map quantization error.
- Ocean/land sign agrees for every non-boundary sample; boundary samples use a one-texel shoreline tolerance.
- Height-derived normals agree within two degrees outside deliberately visual-only microdetail.
- Runtime height at each crater center matches recipe depth within 1%.
- Sampled rim radius agrees within `max(25 meters, 0.5% of crater radius)`.

Canonical-map resolution is always 8192×4096 for Veyra and Palla regardless of runtime tier, so these tolerances do not depend on optional Ultra assets. Lower runtime tiers are downsampled from that canonical source.

Recipe evaluation must remain bounded as feature counts grow. Craters and other bounded features are indexed into deterministic cube-face cells at compile time. A height query evaluates only the global base field plus records intersecting the queried cell and its seam neighbors; it may not scan every crater. Terrain chunk vertices are generated in a worker pool, with transferables used for completed buffers. The main thread only schedules work and installs completed chunks.

### 3. Body Orientation and Save Compatibility

A single `BodyOrientation` module owns body-fixed↔inertial transforms as quaternions composed from axial tilt and spin. Terrain, rendering, resources, communications, scatter, launch sites, and landed-vessel transforms use this module instead of hand-written Z-axis rotations. Visual tilt may not differ from physics tilt.

The first terrain-recipe release bumps the save schema. Each landed vessel stores body ID, recipe hash, body-fixed surface direction, body-fixed attitude, and contact offset/AGL. Loading a save with an older recipe samples old and new surfaces, preserves direction and clearance, and reprojects the vessel before physics resumes. Active and rails landed states follow the same migration rule. Saves also store the physical-scatter recipe hash.

The one-time migration from today's unversioned saves uses the saved simulation time and the legacy Z-spin transform to convert each saved body-relative inertial position and attitude into the old body-fixed frame. It computes clearance with the legacy terrain evaluator, then applies the new recipe and full tilted `BodyOrientation` transform. This preserves the location on the rotating body instead of treating the old inertial vector as a new geographic coordinate.

Recipe migration is explicit rather than best-effort. Released recipes remain available as migration evaluators for at least one save-schema generation. If a required old recipe is unavailable, loading stops before mutating the save and explains which recipe is missing. A migrated save is written only after validation succeeds, retaining the existing backup rotation.

### 4. Planet Asset Compiler

A build-time compiler converts curated sources and body recipes into runtime-ready asset packs. It performs:

- Source blending, warping, recoloring, and seam correction.
- Equirectangular or cube-map projection normalization.
- Generation of albedo, normal, roughness, biome, cloud, and scatter maps.
- Packing compatible grayscale channels to reduce texture bindings and memory.
- Resolution-tier generation.
- GPU texture compression with conventional WebP or PNG fallbacks.
- Validation of source licenses, checksums, map dimensions, seams, and output budgets.

Canonical generation runs in a pinned Linux/amd64 container identified by immutable image digest. The container pins Node, the image decoder/resampler, color-management library, and all compiler packages. Sources are converted to declared sRGB or linear working space, uncontrolled profiles are stripped after conversion, and a fixed resampling kernel is used. Raw quantized pixel buffers—not PNG or JPEG files—are hashed from input checksums, recipe version, body seed, compiler version, and container digest.

GPU compression is a packaging step. KTX-Software version, container image, settings, and transcoder bundle are pinned; encoders that vary under parallel execution run with one thread. Cross-platform bit equality of independently compressed KTX2 files is not promised. Release artifacts record canonical raw-buffer hashes and packaged-file hashes. Source downloads are never performed implicitly during a production build.

Physical scatter is compiled from integer recipe data and canonical quantized CPU masks using a specified integer PRNG. It never samples lossy, transcoded, filtered, or GPU-resident visual textures. Visual scatter may be culled by quality but starts from the same canonical cells.

### 5. Asset Provenance

Every third-party input has a manifest record containing:

- Stable source URL and original filename.
- Author or organization.
- License identifier and license URL.
- Required attribution text.
- Local checksum.
- Bodies and channels that use the source.
- Transformations applied by the compiler.

An asset being publicly accessible does not make it reusable. Missing, ambiguous, or incompatible license metadata fails validation. Repository attribution and license documents must be updated in the same change that adds an asset.

The default license policy is:

- **Allowed:** CC0-1.0, confirmed public-domain works, and CC-BY-4.0 with generated attribution and modification notices.
- **Case-by-case source review:** NASA and JPL media. The manifest records the exact source page, owner, third-party-content status, commercial-use conditions, modification permission, required credit, and a local snapshot of the applicable terms.
- **Rejected for this milestone:** CC-BY-SA, CC-NC, CC-ND, unknown licenses, source-only evaluation licenses, and assets whose author or provenance cannot be confirmed. CC-BY-SA may be reconsidered only after Perilune's distribution license is selected.

A repository-level software license does not automatically cover bundled textures. Each asset from the reference Three.js repository or another public repository must trace back to its own source and license.

### 6. Body Renderer Contract

`WorldScene` should depend on a body-renderer interface rather than constructing every body through `PlanetRenderer`. Each implementation owns its meshes, materials, texture state, and effects while exposing a shared lifecycle:

- Initialize from body definition, asset pack, renderer capabilities, and quality tier.
- Update from camera-relative body position, body-fixed camera position, sun direction, simulation time, and altitude.
- Report draw, triangle, texture-memory, scatter, and collision statistics.
- Change quality without recreating simulation state.
- Dispose of geometry, materials, textures, workers, and pooled objects.

Body renderer loading is transactional. A candidate renderer loads textures, calls `KTX2Loader.detectSupport`, compiles materials with `compileAsync`, and captures shader errors before it can replace the visible renderer. Failure disposes partial resources and retains the legacy renderer. A renderer also handles WebGL context loss and rebuilds from its manifest after context restoration.

The renderer factory selects an archetype from explicit body visual data. It must not infer major behavior from terrain amplitude or atmosphere presence alone.

The existing `PlanetRenderer` remains available through a `LegacyBodyRenderer` adapter during migration. Each body explicitly selects `legacy`, `terrestrial`, `airless`, `gas-giant`, or `star` in content data. Auren's `star` adapter owns its emissive surface and light-source presentation without pretending it is rocky terrain. New renderers can therefore ship body by body, and a capability or asset failure can select the legacy adapter without changing save data. The legacy path is removed only after all twelve current bodies have an assigned new renderer and fallback coverage.

Quality changes are transactional and keyed by tier. Replacement root meshes and asset packs become visible only after coverage is ready; then the previous tier's geometry, textures, and buffers are disposed. Physical terrain, crater records, obstacle cells, and collision behavior are identical across all quality tiers.

Compact-system rendering and flight rendering share a lightweight `BodyMaterialDescriptor` derived from the same asset manifest. `MapView` uses that descriptor for phase-correct albedo, orientation, and gas/star identity instead of constructing solid-color Lambert spheres. It does not load flight-scale terrain or scatter.

The `star` adapter owns Auren's visible disk, corona/sprite, directional-light color and intensity, and exposure contribution. `WorldScene` supplies camera and star direction but does not create a second sun sprite or light. This prevents duplicate star ownership during migration.

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

Veyra is the reference implementation for the separate solid, water, and contact surfaces. Its atmosphere renderer consumes the same pressure, density, scale-height, and atmosphere-top parameters as flight physics, plus explicitly visual coefficients such as wavelength tint and art-direction strength. Visual haze may be stylized, but atmosphere thickness and boundary altitude may not contradict the physical model.

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

Tyran's content declares `surfaceKind: 'gas'`; zero terrain amplitude is never used to infer this behavior. A gas body has no `solidHeight`, ground contact, wheel contact, splashed state, prelaunch state, or landed rails state. Atmospheric pressure and density use the existing exponential model above the reference radius and continue it below the radius as `P0 × exp(-altitude / scaleHeight)` and `ρ0 × exp(-altitude / scaleHeight)`. Tyran sets `terminalPressurePa: 5_000_000` and `terminalDepthMeters: 60_000`; crossing either boundary destroys the vessel through the normal damage/event path and prevents it from being put on rails. Tests cover descent at the atmosphere top, reference radius, 5 MPa pressure crossing, and 60 km depth. A save that incorrectly contains a landed vessel on a gas body fails validation with a recoverable load error.

### Remaining Body Variants

The eight non-archetype planets and moons are assignments of established systems, not eight new renderer architectures. Their recipes cover five bounded variants: dense-cloud terrestrial, arid/desert terrestrial, ice/regolith airless, lava/emissive airless, and irregular low-gravity moon. Each variant may add data, material parameters, and visual-only masks; a requirement for new simulation authority or a new renderer lifecycle becomes a separate design change. Auren uses the dedicated star adapter, bringing the current total to twelve explicitly assigned bodies.

## Orbit-to-Ground Continuity

The same compiled global maps feed both compact distant rendering and near terrain chunks. The renderer changes geometry and detail frequency with altitude, not planet identity.

Global material coordinates are defined from the normalized body-fixed direction using one documented longitude origin and pole convention. Compact spheres, cube-sphere chunks, clouds, ocean masks, decals, and `MapView` all use this transform. Local triplanar detail is anchored in body-fixed meters and wraps over a declared period, so floating-origin shifts and chunk rebuilds cannot make the material swim. Seam tests cover the equirectangular wrap, all cube edges, and both poles.

1. **System view:** compact body geometry, correct phase and limb, low-resolution global maps.
2. **Orbital view:** global albedo, biome, ocean, clouds, and atmosphere; terrain LOD begins before the compact body disappears.
3. **Atmospheric flight:** regional material detail, aerial perspective, and cloud shadows blend in.
4. **Surface operations:** local triplanar detail, decals, dust, and instanced scatter dominate.

Near/far changes use screen-space error plus a bounded dithered cross-fade. Terrain prewarms before entering the visible transition band, using camera velocity to request the next cells. The fade clock starts only when replacement coverage is ready; loading time is not counted as overlap. Complementary stochastic masks give parent and child a combined opacity of one without transparent coplanar blending. The normal fade is 0.35 seconds and the maximum is 1.5 wall-clock seconds, independent of frame rate. Under sustained frame pressure it may shorten to 0.2 seconds, but it may not hide valid fallback coverage. The compact or parent renderer remains fully visible until the replacement is ready, preserving the coverage rule established by the M2 terrain-hole fix.

## Surface Scatter and Collision

Scatter cells are deterministic from body seed, cell coordinates, biome, slope, and altitude. They stream around the active camera or vessel and use GPU instancing.

Two layers are deliberately separate:

- **Visual layer:** dense grass, pebbles, small rocks, dust, and distant vegetation. These instances never create simulation objects.
- **Physical layer:** sparse large boulders, trees, cliffs, and landmarks. It uses a quality-independent canonical obstacle set; quality may simplify visual meshes but may not add, remove, or move gameplay collisions.

Physical obstacles are a targeted extension to the current radial contact model. Deterministic cube-face cells provide the broadphase. Each obstacle has a sphere, capsule, or small compound-sphere proxy and a stable ID. The active-regime physics step queries candidate cells for every active vessel and resolves hull, landing-leg, and wheel contacts through the existing impulse/damage path. Rails propagation does not simulate obstacle contacts, so a vessel inside the predictive activation zone may not transition to rails.

The activation radius is `max(300 meters, vesselSpeed × (generationP99Seconds + 2 seconds) + vesselBoundingRadius)`, evaluated per vessel and measured from reference-hardware worker timings. Deactivation uses 20% distance hysteresis. Cells are requested before they enter this radius, and normal flight may never defer an obstacle because it intersects the vessel's swept path. Spawn, save-restore, and recipe-migration are the only exclusion cases: if a vessel initially overlaps an obstacle, that obstacle's visual and physical instance is suppressed for that vessel until the vessel clears `max(25 meters, 2 × vesselBoundingRadius)`, after which the canonical obstacle returns. Hard pool caps are permitted only if the activation radius remains fully covered. If coverage cannot be maintained, the game reduces visual density first, blocks rails transition, and pauses local simulation before the vessel enters uncovered space while showing a recoverable loading fault; it never silently drops physical obstacles.

Saves store the physical-scatter recipe hash rather than transient proxies. Deterministic regeneration recreates stable obstacle IDs. Tests cover high-speed approach, two simultaneous active vessels, cell seams, pool pressure, restore overlap, quality switching, and the invariant that no unsuppressed obstacle first appears inside a vessel's current or two-second swept bounding volume.

## Quality Tiers and Budgets

WebGL2 is required. WebGL1 is unsupported and receives a clear capability screen instead of silently selecting a degraded renderer. At release, supported browsers are the latest two stable desktop versions of Chrome, Edge, and Firefox plus the current and previous desktop Safari. CI records exact pinned versions; the release checklist repeats smoke tests on the then-current versions rather than assuming a timeless matrix.

The user-approved reference machine is a MacBook Pro (Mac15,10) with an Apple M3 Max (14-core CPU, 30-core GPU) and 36 GiB unified memory. Both Medium and Low run on this machine; Low remains a reduced visual/resource tier, not a claim about untested Intel integrated graphics. Each record includes model, firmware, Metal/ANGLE driver identity, browser build, operating-system build, current power source and mode, and automatic power-management configuration. Runs use normal power mode (`powermode 0`), a fixed 1920×1080 physical drawing buffer, no browser zoom, and no supersampling. Battery or AC runs are accepted when the exact condition is recorded; passing on battery is treated as the conservative condition for this device.

Performance assertions are provisional until the feasibility prototype completes full Medium and Low runs on the reference Mac. Before full Veyra implementation, a representative scene must combine one terrain patch, atmosphere, ocean, two cloud layers, one shadow receiver, transition overlap, 50,000 visible instanced scatter items, and 128 active physical proxies. It runs a 30-second warm-up followed by three five-minute camera journeys. Acceptance uses the median of the three run medians and the worst run's p95. Both tiers require at least 60 FPS median, frame time below 16.7 ms p95, renderer main-thread submission at or below 4 ms p95, terrain scheduling and chunk installation at or below 2 ms p95, and measured GPU work at or below 8 ms p95.

For this feasibility measurement only, both transition meshes remain forced on throughout the three journeys so overlap cost participates in the measured percentiles. This `forced-combined-fixture` mode is an explicit exception to the production transition clock: production remains bounded to the 0.35-second normal and 1.5-second maximum windows specified above.

GPU timings use a delayed query ring through `EXT_disjoint_timer_query_webgl2`; samples are read only after availability and discarded whenever the WebGL disjoint flag is set. Certification requires timer support, no pending or saturated queries at completion, and at least 95% valid coverage with valid, unavailable, and disjoint totals reconciled to the journey sample counts. Playwright or software-renderer timings detect relative regressions only and never substitute for reference hardware.

The Medium 8 ms rendering allocation is an initial feasibility allocation, not evidence that the design fits:

| Feature group | Medium p95 budget |
|---|---:|
| Terrain/body geometry and base materials | 2.5 ms |
| Atmosphere and aerial perspective | 1.0 ms |
| Ocean and shoreline effects | 0.7 ms |
| Cloud layers and selective shadows | 1.2 ms |
| Surface decals and instanced scatter | 1.2 ms |
| Near/far transition overlap | 0.8 ms |
| Renderer headroom | 0.6 ms |
| **Total** | **8.0 ms** |

Each feature group is independently switchable in the profiling harness. Short, non-certifying smoke runs guide implementation and expose regressions while features are being built. Full Medium and Low M3 Max hardware certification is deliberately the final delivery step, after the planned rendering, scatter, collision, browser, and automated-test work is complete, so development effort remains focused on implementing the feature set first. If the final combined run misses a gate, the design is reduced in this order: remove Medium cloud shadows, reduce atmospheric samples, reduce the second cloud scale, reduce visual scatter, then simplify ocean glitter. Physical terrain and obstacle collisions are never reduced. Every reduction is followed by a complete reference rerun; if the reduced implementation still misses, the spec is revised before release.

Runtime global maps use exact 2:1 dimensions:

| Tier | Global dimensions | Drawing-buffer target | Visual differences |
|---|---:|---:|---|
| Low | 1024×512 | 1920×1080 | Simplified atmosphere, sparse visual scatter, no cloud shadows |
| Medium | 2048×1024 | 1920×1080 | Full atmosphere and ocean, moderate visual scatter, conditional cloud shadows |
| High | 4096×2048 | User display up to 1440p | Denser visual scatter, improved shadows, more atmosphere samples |
| Ultra | 8192×4096 | User display | Optional hero-body maps and maximum visual density |

The canonical compiler output is 8192×4096. Runtime channels are fixed:

| Channel | Color space / logical format | GPU package | Conventional fallback |
|---|---|---|---|
| Albedo | sRGB RGB8 | KTX2 ETC1S with mipmaps | WebP |
| Normal | Linear octahedral XY in RG8 | KTX2 UASTC with mipmaps | PNG |
| Material | Linear RGBA8: roughness, AO, biome class, ocean/shore mask | KTX2 UASTC with mipmaps | PNG |
| Clouds | Linear RG8: coverage, optical depth | KTX2 UASTC with mipmaps | PNG |

JPEG is never used for height, normal, mask, or material data. Canonical validation height is signed 16-bit with per-body meter scale and offset selected so the quantization step is at most 0.5 meters; it is a compiler/test artifact, not physics authority. The runtime queries the shared evaluator for collision and terrain vertices. A platform without a supported compressed transcode format selects Low before loading fallback PNG/WebP assets.

GPU-resource ceilings distinguish active-body assets from the whole renderer:

| Tier | Active-body GPU assets | Total renderer GPU resources | Transient decode/generation peak |
|---|---:|---:|---:|
| Low | 64 MiB | 256 MiB | 96 MiB |
| Medium | 128 MiB | 384 MiB | 192 MiB |
| High | 256 MiB | 768 MiB | 384 MiB |
| Ultra | Report only | Report only | Report only |

`Active-body GPU assets` includes that body's global and local textures, geometry, instance buffers, atmosphere lookup tables, and shadow resources. `Total renderer GPU resources` adds compact-body assets, vessel and scene resources, active transition overlap, and renderer-owned offscreen targets. Browser-owned swapchain/compositor memory is recorded separately because the application cannot account for it exactly. Estimates use actual selected GPU internal formats, dimensions, faces/layers, mip levels, sample count, and buffer byte lengths; uncompressed worst-case estimates are also reported for fallback paths.

Only one flight-scale body pack may be GPU-resident. All bodies retain compact assets, but the next sphere-of-influence candidate remains as compressed CPU/network bytes until transition is imminent. Quality replacement and context restoration stage one candidate pack at a time; old and new GPU residency may overlap only within the transient peak. Medium boot-critical transfer is capped at 12 MiB compressed, and one Medium body pack is capped at 32 MiB compressed. The manifest validator rejects a tier that exceeds its transfer, active-body, total-renderer, or transient ceiling.

The performance overlay gains actual drawing-buffer dimensions, estimated GPU bytes by category, compressed download bytes, scatter instances, active collision-proxy counts, active transition duration, disjoint-query count, and feature-group timings alongside existing frame, draw, triangle, and chunk statistics. Reference runs compare estimates with browser and OS telemetry and document the expected difference.

## Failure Handling

- Missing body textures fall back to the body's procedural palette.
- A failed custom material falls back to a standard material rather than a black or invisible body.
- Unsupported compressed textures load conventional image alternatives.
- Startup probes fragment `highp` precision and range. Full analytic atmosphere materials require the validated precision floor; otherwise the body uses a precomputed lookup or simplified limb-haze material.
- An invalid provenance manifest, missing required map, or over-budget generated pack fails the build.
- A failed scatter cell is discarded and deterministically regenerated on a later update.
- A physical-obstacle pool that cannot cover the predictive activation radius reduces visual density, prevents rails transition, and pauses local simulation before uncovered space; it does not silently remove canonical collisions.
- Asset and shader failures log once with body and channel context to avoid per-frame console flooding.
- `webglcontextlost` pauses rendering and prevents default context disposal. Restoration rebuilds the last committed renderer from its manifest; the legacy renderer remains visible if rebuilding the candidate fails.

`scripts/validate-content.mjs` is created before any asset lands. `npm run validate:content` validates schemas, provenance, checksums, canonical/raw hashes, dimensions, channel semantics, compressed and fallback pairs, transfer sizes, and memory estimates. It is chained through `prebuild` and run as an explicit CI job, so `npm run build` cannot bypass asset validation. Production builds consume checked-in or release-downloaded artifacts only and never fetch authoring sources.

## Testing Strategy

### Automated Tests

- Asset-manifest license and checksum validation.
- Deterministic compiler output for fixed recipes.
- Canonical raw-buffer hash equality inside the pinned compiler container and packaged-file hash recording.
- Texture seam and expected-channel validation.
- Shared evaluator versus canonical maps, crater centers/rims, shorelines, normals, and body-orientation transforms.
- Cube-face geometry and material continuity.
- LOD fallback coverage and transition readiness.
- Deterministic scatter placement and cell regeneration.
- Predictive obstacle activation, high-speed swept contact, two-vessel coverage, restore suppression, pool faults, and quality-invariant physical IDs.
- Save migration across recipe versions and rejection of unavailable recipes or landed gas-body states.
- Gas-body pressure continuation, terminal destruction, and absence of ground/rails contact.
- Quality-tier cache invalidation, transactional replacement, procedural fallback, context loss, and context restoration.
- `MapView`, flight view, and physics agreement on body orientation and material identity.
- Asset-validator invocation through production build and CI entry points.
- Alarm, entry prediction, and save restoration tests needed to restore the M2 baseline.

### Browser and Visual Tests

Playwright captures stable reference views for Veyra, Palla, and Tyran at:

- Distant orbit.
- Low orbit or atmospheric boundary.
- Low flight.
- Surface or closest valid approach.
- Daylight and night-side lighting.

CI visual baselines use a pinned Chromium and SwiftShader image with temporal animation frozen at fixed simulation times. Thresholds are calibrated rather than guessed: each reference scene is captured 30 times on the pinned image to establish per-pixel and structural noise, then seeded defects—missing crater, shifted shoreline, broken cube seam, lost cloud layer, wrong body orientation, and black material—must fail. Each scene records a whole-frame threshold plus tighter regions of interest for the limb, shoreline, landmark, and transition boundary. A threshold is accepted only if all clean calibration runs pass and every seeded defect fails. Masked regions are limited to explicitly documented nondeterministic browser overlays; planet pixels are never masked.

Automated camera journeys check for coverage gaps, black frames, shader errors, unbounded memory, transition duration, and relative frame spikes. Shader conformance scenes exercise the full and precision-fallback atmosphere paths. CI performance results guard regressions on the pinned software renderer but do not certify target hardware. Medium and Low tier releases require the approved M3 Max reference protocol, with hardware, driver, browser, power, drawing buffer, quality, run medians, worst-run p95, memory, query validity, and feature timings recorded in `PERFORMANCE.md`. Manual art review remains the authority for whether a planet looks convincing.

### Completion Gates

- Production build and full unit suite pass.
- Existing playable-loop and terrain-descent tests pass.
- No missing-asset or shader errors in the supported browser matrix; capability fallback and context restoration pass.
- The feasibility prototype and final Medium journeys stay within the frame, main-thread, GPU, transfer, and 128/384 MiB active/total resource ceilings on the approved M3 Max reference machine.
- Low journeys pass the same 60 FPS reference protocol with the 64/256 MiB active/total ceilings and without changing physical terrain or obstacles.
- Build and CI invoke content validation, and every shipped third-party asset has accepted per-file provenance and generated attribution.
- Veyra retains one recognizable identity from orbit to contact.
- Palla reads as a cratered moon rather than palette-swapped generic terrain.
- Tyran visibly and physically behaves as a non-landable gas giant rather than a solid rocky sphere.

## Delivery Sequence

This epic is implemented as separately reviewable phase plans and mergeable changes. Implementation phases proceed in order and leave focused tests, the full unit suite, content validation, and the production build green. Reference-hardware certification is not an implementation-phase prerequisite; it is the final release gate after the feature sequence is complete.

0. **Restore M2:** complete alarm state and persistence plus atmospheric-entry prediction, keep and validate the transfer planner, and restore build/test health. No graphics code belongs in this change.
1. **Authority and tooling foundation:** add recipe/version schemas, `BodyOrientation`, save migration, separate solid/water/contact queries, `surfaceKind`, gas-body terminal behavior, the provenance manifest, the pinned asset compiler, `validate-content.mjs`, `prebuild`/CI wiring, and raw/package hashing. This phase contains no new art direction.
2. **Feasibility prototype:** implement enough disposable-or-promotable rendering to exercise the combined Medium/Low scene and establish the profiling harness, counters, resource accounting, reduction controls, and short non-certifying smoke baseline. Keep the reference protocol ready, but defer the full-duration hardware run until the final certification step.
3. **Renderer platform:** add the renderer interface, legacy adapter, transactional asset/shader loading, capability detection, context restoration, quality replacement, shared compact material descriptor, performance accounting, and star ownership. Keep all bodies on legacy visuals except prototype fixtures.
4. **Veyra global stack:** ship its compiled geography, global material, atmosphere, ocean, clouds, lighting, and orbit-to-ground transition behind the terrestrial assignment.
5. **Veyra surface stack:** ship regional/local materials, decals, worker-generated chunks, visual scatter, dust, and the quality-invariant physical-obstacle subsystem.
6. **Palla:** ship spatially indexed authoritative craters, regolith/ejecta materials, boulders, landmarks, and airless lighting.
7. **Tyran:** ship band, storm, depth, and limb-haze rendering against the already-tested non-landable gas simulation contract.
8. **System completion:** assign the five bounded variants to the eight remaining planets or moons, ship Auren's star adapter, and tune each body. Every body receives an explicit recipe, provenance record, renderer assignment, compact-map identity, supported-view snapshots, and quality-budget check.
9. **Final hardware certification:** only after implementation, automated verification, browser journeys, visual calibration, documentation, and final code review are complete, run the approved M3 Max Medium and Low protocols. Apply reductions only in the specified order, rerun the complete affected tier after each change, and do not claim release readiness until every applicable completion gate passes.

Each step must leave the build and relevant tests green. Asset licensing and attribution changes ship with the assets they govern.

`RENDERING.md`, `ARCHITECTURE.md`, `PERFORMANCE.md`, `README.md`, and `LICENSES.md` are updated in the phase that invalidates their current claims. In particular, the existing statements that all art is original and procedurally generated must be replaced when the first licensed source asset lands; generated attribution is committed with that asset.

## References

- NASA Eyes on the Solar System: https://eyes.nasa.gov/apps/solar-system/#/home
- NASA Images and Media Usage Guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/
- SoumyaEXE 3D Solar System ThreeJS: https://github.com/SoumyaEXE/3d-Solar-System-ThreeJS
- Creative Commons BY-SA 4.0 terms: https://creativecommons.org/licenses/by-sa/4.0/
- Khronos WebGL2 disjoint timer-query specification: https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
- Khronos KTX-Software releases and determinism notes: https://github.com/KhronosGroup/KTX-Software/releases
- Three.js `WebGLRenderer` compilation and shader-error API: https://threejs.org/docs/pages/WebGLRenderer.html
- Existing rendering architecture: `ARCHITECTURE.md`, `RENDERING.md`, and `PERFORMANCE.md`
