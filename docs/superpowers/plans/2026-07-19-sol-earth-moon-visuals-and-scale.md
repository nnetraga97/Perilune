# Sun, Earth, and Moon Visuals and Physical Scale Implementation Plan

**Date:** 2026-07-19

**Status:** Revised after current-HEAD review; implementation has not started

**Branch:** `main`

**Supersedes for visual direction:**
`docs/superpowers/plans/2026-07-19-planet-rendering-fidelity-full-system-pass.md`

## Goal

Replace the active compact fictional system with a visually recognizable, physically
scaled Sun-Earth-Moon system. Preserve the complete fictional 12-body system only as
an explicit legacy test fixture until gameplay and mission balance are migrated in a
later pass. The target is the restrained,
data-led look of NASA's planet visualizations: correct silhouettes and angular sizes,
real surface geography, readable terminators, thin atmosphere, convincing clouds and
ocean, hard lunar relief, and a Sun that looks like a luminous photosphere rather than
a game sprite.

This plan is deliberately limited to **visuals and scale**. It does not design Artemis
IV mission playback, campaign flow, vehicle balance, launch procedures, progression,
save migration, time-warp policy, or map UI.

## Decision

Use a hybrid renderer built around three principles:

1. **Authoritative public data defines identity.** NASA/NOAA imagery and elevation
   data define the continents, oceans, clouds, lunar maria, craters, and solar active
   regions. We will not hand-paint planet textures or ask the user to author them.
2. **Published real-time methods define light transport.** Atmosphere, aerial
   perspective, ocean reflection, cloud volume, and scale transitions follow proven
   methods rather than another collection of local shader patches.
3. **Physical coordinates and presentation coordinates are separate.** Simulation
   and visibility math remain in meters and f64. Nearby bodies use camera-relative
   meter-scale geometry. The Sun at interplanetary distance uses an angularly correct
   far-field representation, so WebGL never has to rasterize a sphere 1 AU away and
   never changes its apparent size by clamping its distance.
4. **Visual-scale migration does not masquerade as gameplay retuning.** Production
   boots into `SOL_SYSTEM`, while compact-scale physics, mission, campaign, and
   progression tests opt into a named legacy fixture. No test may receive the legacy
   system accidentally through the production default.

This is preferable to either extreme:

- A texture-only pass would improve orbit screenshots but remain blurry and flat near
  the surface.
- A fully procedural planet would add detail but would not look like Earth or the Moon.
- Putting every physical body directly into one float32 Three.js scene would recreate
  depth and precision problems at Sun-Earth distances.
- A live weather/ephemeris service would add operational complexity without improving
  the first visual target enough to justify it.

## Current-HEAD Review Resolutions

The 2026-07-19 code-path review changed the original draft in five material ways:

1. Production uses Sol, but the complete compact 12-body content is preserved as an
   explicit test fixture. This avoids pretending stock craft and mission tests are
   valid at physical Earth-Moon scale.
2. Campaign and save/content lookup paths are part of the system-selection change;
   tests importing `AUREN_SYSTEM` are not the full blast radius.
3. Asset budgets are measured and approved before Earth pack resolutions are fixed.
4. Runtime Earth remains spherical in this pass; datum-correct reprojection and
   body-fixed orientation remain required.
5. HMI temporal ingestion is deferred, and the existing fixed Earth-Moon camera depth
   envelope is certified instead of replaced speculatively.

## Desired Visual Language

The reference is not an exaggerated science-fiction grade. It is the look of NASA
Scientific Visualization Studio and NASA Science interactives:

- physically plausible scale and angular size;
- natural-color source imagery rather than oversaturated painted biomes;
- a dark, neutral space background and controlled exposure;
- a bright but structured solar disk, with bloom kept subordinate to the photosphere;
- a narrow blue atmospheric limb that expands into sky and aerial perspective during
  descent;
- clouds that cast and receive light as volumes, not white transparent decals;
- an ocean whose identity comes from reflection, Fresnel response, and atmospheric
  color, not an opaque blue material;
- lunar terrain whose relief is revealed by low-angle sunlight and long shadows;
- no decorative UI work in this pass.

## Scope Boundary

### Included

- Sun, Earth, and Moon names, physical dimensions, spacing, orientation metadata, and
  renderer assignments in the active production system.
- A parameterized `GameState` system input and an isolated legacy-system test fixture,
  so existing compact-scale mission coverage remains truthful until its later migration.
- Camera-relative precision and angular-size correctness from Earth surface through
  Earth-Moon views and Sun-Earth views.
- Source-backed global visual assets and their reproducible authoring pipeline.
- Earth global surface, atmosphere, aerial perspective, clouds, ocean, night lights,
  terrain transition, local material detail, lighting, and shadows.
- Moon global surface, source-backed relief, near terrain, regolith response, lighting,
  shadows, and compact/terrain transition.
- Sun photosphere, limb darkening, procedural granulation, glare, corona, and near/far
  presentation transition.
- Eclipse and occultation silhouettes as a visual scale acceptance case.
- Low, Medium, and High quality policies with measured resource ceilings.
- Reference-camera tooling and image-based acceptance captures.

### Explicitly deferred

- Artemis IV chronology, phase cards, narration, replay controls, and cinematic camera
  choreography.
- Rocket, spacecraft, launch-site, ascent, entry, landing, or orbital-balance changes.
- Save migration or compatibility. The project is in development and old saves may be
  discarded.
- Campaign, science, contracts, economy, progression, and body-unlock changes.
- MapView redesign, time warp, maneuver planning, and transfer-window UX.
- The other planets, additional moons, asteroids, comets, and heliosphere.
- Live weather, live SDO imagery, seasonal Earth updates, tides, aurora, city-light
  updates, and real-time SPICE/Horizons ephemerides.
- Globally accurate meter-resolution geographic terrain. The first pass uses sourced
  global macro relief plus canonical multiscale detail; localized survey-grade terrain
  is a later data-coverage feature.
- Runtime oblate-Earth geometry and geodetic terrain/contact queries. Source assets are
  still reprojected against their declared WGS84/ETOPO datum, but the first renderer
  uses one checked spherical reference radius.
- SDO/HMI observation ingestion, sunspot time sequences, and solar-rotation playback.
  The solar material keeps an optional active-region input contract for a later pass.
- Migration of the legacy compact-scale mission, campaign, craft, comms, science, and
  progression suite to physical Earth-Moon values.

## Current-HEAD Facts This Plan Accounts For

- `src/content/system.ts` defines 12 active fictional bodies, not merely an
  Auren/Veyra/Palla trio. Their radii, gravity, periods, and distances are not Solar
  System values.
- `GameState` constructs `new Universe(AUREN_SYSTEM, HOME_BODY_ID)` as a field
  initializer, and 37 test files currently construct `GameState`. Full ascent,
  Palla-mission, release-blocker, stock-craft, gas-body, ISRU, science, and comms tests
  therefore depend on compact-scale physics even when they do not import
  `AUREN_SYSTEM` directly.
- `src/sim/campaign.ts` publishes contracts for Veyra, Palla, and moons in the Tyran
  system. Production Sol startup must not expose contracts whose destination bodies do
  not exist, even though redesigning those contracts is deferred.
- `BodyDef`, `Universe.absolutePosition`, and `Universe.relativePosition` already use
  JavaScript numbers and f64 `Vec3` math. The simulation can represent 1 AU without a
  wholesale numeric rewrite.
- `WorldScene` already renders camera-relative: it computes absolute f64 body and
  camera positions, subtracts them, and only then passes coordinates to Three.js.
- The production camera uses a 0.3 m near plane, a 600,000 km far plane, and a
  logarithmic depth buffer. That is enough for the Earth-Moon pair, but not a physical
  Sun mesh at 1 AU.
- `StarBodyRenderer` currently clamps the star to 300,000 km while keeping a fixed
  presentation scale derived from six percent of body radius. This breaks angular size
  and must be replaced, not tuned.
- `TerrestrialBodyRenderer` is usable only for Veyra: it requires an atmosphere,
  always constructs ocean and clouds, and assumes four texture channels.
- Palla has NASA LRO/LOLA assets in the checked manifest, but only its compact legacy
  sphere uses them. Near terrain falls back to generic procedural Lambert shading.
- The asset compiler already supports pinned sources, checksums, provenance,
  deterministic resizing, KTX2 compression, fallbacks, checked manifests, quality
  tiers, and transactional runtime loading. This is the correct foundation.
- The checked manifest currently caps a Medium body pack at 32 MiB transfer and the
  active-body GPU allocation at 64/128/256 MiB for Low/Medium/High. Earth adds height,
  night-emission, and separate cloud channels, so the ceilings must be remeasured and
  explicitly approved rather than inherited silently.
- The compact Earth path uses `MeshStandardMaterial`, while near terrain injects a
  low-frequency sine detail field. The finest current color variation remains on a
  kilometer scale.
- The compact/global normal map is mixed strongly into near terrain normals, which
  suppresses the geometry's local slopes.
- Atmosphere LUTs contain a transmittance table and a heuristic multiple-scattering
  table. There is no sky-view LUT or aerial-perspective volume, and
  `uAerialPerspective` is uploaded but not consumed.
- The atmosphere shell is behind opaque terrain, so it cannot haze ground fragments.
- Medium/High cloud rendering has useful building blocks, but its macro field is a
  single equirectangular source and layer crossings still need evidence-based
  verification.
- The ocean cap is camera-local and avoids a global near-ground ocean sphere, but its
  lighting does not yet bridge geometry, normals, and BRDF across distance.
- Production shadows are disabled. Terrain can receive shadows, but no complete
  production caster/light/camera policy exists.
- Body orientation is currently `axialTilt about +X` followed by `spin about +Z`.
  That is too small a model to align IAU/NAIF body-fixed products without hand-tuned
  offsets.
- `BodyId`, `BODY_VISUALS`, launch-site assumptions, validators, content tests, asset
  manifests, and several UI/game systems name the fictional bodies directly. Even with
  save migration deferred, renaming cannot be treated as a three-line content edit.
- The Veyra diagnostic craft is shared by Playwright and unit/release-blocker tests.
  The old deterministic diagnostic stays pinned to the legacy fixture; new Sol visual
  acceptance uses a rendering-only reference harness and JSON diagnostic sidecars.

## Source and Method Selection

### Physical constants, axes, and distances

Pin a small checked data file generated from these authorities:

- JPL NAIF text PCK for body radii and pole/prime-meridian models.
- JPL DE440 GM kernel for gravitational parameters used by the existing body model.
- IAU 2015 Resolution B3 for the nominal solar radius and terrestrial reference radii.
- JPL planetary and satellite mean elements for the initial analytic visual system.
- IAU WGCCRE/NAIF conventions for body-fixed orientation and texture longitude.

The checked file, not a network call, is runtime authority. Every value records units,
source URL, source version, source checksum, and whether it is a nominal constant,
best estimate, or mean orbital element.

Expected scale landmarks, to be verified when the source file is generated:

- 1 AU: 149,597,870,700 m.
- Sun nominal radius: 695,700,000 m.
- Earth equatorial radius: 6,378,137 m; polar radius approximately 6,356,752 m.
- Moon mean radius: approximately 1,737,400 m.
- Earth-Moon mean semimajor axis: approximately 384,400,000 m.
- Earth sidereal rotation: approximately 86,164 s.
- Moon sidereal orbital/rotation period: approximately 27.322 days.

Do not copy rounded marketing-page values into simulation content when a checked kernel
value exists.

### Earth assets

Adopt the following source roles:

| Visual channel | Primary source | Runtime use |
| --- | --- | --- |
| Natural-color land | NASA Blue Marble Next Generation, pinned July composite | Compact albedo and macro color identity |
| Relief and shoreline | NOAA ETOPO 2022 ice-surface 15 arc-second model | Canonical macro elevation, ocean mask, macro normals |
| Clouds | NASA Visible Earth separate Blue Marble cloud composite | Cloud coverage/optical-density seed; not baked into albedo |
| Night emission | NASA VIIRS Black Marble, pinned cloud-free composite | Optional Medium/High emissive channel on the night side |
| Fine material | Selected Poly Haven CC0 rock, soil, sand, snow, and ice PBR sets with pinned provenance | Local normal/roughness modulation only; never continent color |

The first Earth is a stable art-directed snapshot, not a live globe. The chosen Blue
Marble month, separate cloud composite, and night-light composite stay fixed until deliberately
versioned.

### Moon assets

Use NASA SVS CGI Moon Kit as the baseline because it is explicitly prepared for 3D
rendering from LRO camera and LOLA elevation data. Reuse the current Palla source files
where their checksums match, but rebuild the manifest and runtime paths as Moon assets
with no fictional recolor or interpretation.

The Moon pack contains:

- LROC color/albedo;
- LOLA elevation transformed into the canonical macro-height representation;
- source-derived octahedral normals;
- roughness/reflectance masks derived conservatively from source albedo and slope;
- a sourced CC0 regolith normal/roughness set for sub-source-frequency shading only.

No atmosphere, clouds, ocean, fake blue ambient, or glossy specular lobe is permitted.

### Sun shading

The first milestone does not require an observation pack. At ordinary Earth-Moon
camera fields of view, the solar disk is only about half a degree wide; its silhouette,
limb function, luminance hierarchy, occultation response, and stable exposure are far
more perceptible than time-varying HMI structure.

Therefore:

- analytically render the photospheric disk/sphere;
- apply a checked visible-light limb-darkening function;
- generate band-limited granulation and sparse, low-amplitude active-region variation
  procedurally, with detail filtered by projected pixel footprint;
- retain an optional material input for a future limb-corrected observation mask, but
  do not build or ship that data pipeline in this pass;
- expose corona only outside the photospheric limb and only when angular resolution
  makes it useful;
- keep bloom/glare in post/presentation space so it cannot enlarge occultations.

The default visual Sun is near-white with a warm perceptual grade after tone mapping,
not a flat orange ball and not false-color EUV imagery.

### Atmosphere

Adopt Hillaire's production-ready LUT organization, using Bruneton's tested formulation
as the validation reference:

- transmittance LUT;
- multiple-scattering LUT;
- sky-view LUT for the current observer and light direction;
- camera-volume or bounded aerial-perspective LUT for opaque ground and objects;
- consistent sun luminance, Rayleigh, Mie, ozone/absorption, ground albedo, and planet
  shadow inputs across all four products.

This replaces the current shell-only composition and dead uniform. The same atmosphere
state must affect sky, limb, terrain, ocean, clouds, launch-site solids, and vessels.

### Ocean

Adopt the Bruneton/Neyret/Holzschuch hierarchy: represented wave geometry close to the
camera, normal detail at intermediate distance, and a filtered BRDF toward the horizon.
The current camera-local cap remains a useful geometry container, but its illumination
and frequency filtering must be replaced.

### Clouds

Keep the bounded High-quality volume and cheaper Low/Medium paths, but drive them from
the separate source cloud field and a common spherical coordinate convention. Use the
NASA GEOS-5 3.5 km sequence as a visual-motion reference, and the Schneider/Vos
volumetric-cloud principles for density shaping, lighting, empty-space skipping, and
temporal reprojection. Do not attempt a fluid/weather simulation.

### Terrain and local detail

Keep the existing cube-sphere quadtree. Replacing it with a different planet mesh would
discard working selection, balance, scheduling, residency, worker, and transition
infrastructure without solving the source-data problem.

Extend its canonical height function to:

`source macro elevation + deterministic band-limited terrain detail`

The macro term comes from ETOPO or LOLA. The detail term supplies progressively smaller
geometric scales below the source resolution and remains identical in rendering,
collision, launch-site, and sampling calls. Sourced PBR maps add only shading-scale
normal and roughness; they never change contact height.

## Scale and Precision Contract

### Coordinate rules

- One simulation unit remains one meter.
- Body positions, camera absolute position, orbit evaluation, angular calculations,
  and body-to-body vectors remain f64 until the final camera-relative conversion.
- Three.js receives only camera-relative coordinates for nearby geometry.
- No body radius, orbit distance, atmosphere height, terrain amplitude, or Moon spacing
  may be visually rescaled independently.
- Apparent size tests use analytic angular radius:
  `theta = asin(bodyRadius / observerDistance)`.
- Projected pixel radius uses the actual vertical field of view and drawing-buffer
  height; tests must not use CSS pixels.

### Sun far-field representation

At Earth and Moon distances, render the Sun as a camera-facing analytic disk at a safe
proxy depth. Its proxy radius is calculated from the physical angular radius, not from
the proxy distance chosen for depth stability.

The directional light and atmosphere sun direction continue to use the true f64
Sun-to-observer vector. Occultation tests operate on angular disks before glare. This
preserves correct eclipses even though the visible Sun is not a sphere placed 1 AU into
the float32 scene.

When the observer approaches the Sun closely enough that parallax across the solar
sphere or corona volume matters, cross-fade to a camera-relative physical sphere. The
transition threshold is expressed in solar radii and must match apparent radius on both
sides.

### Earth-Moon representation

The Earth and Moon remain physical camera-relative meshes. Their maximum nominal
separation is inside the current 600,000 km far plane, but the camera policy must add
margin for eccentricity, body radii, and view-dependent near/far precision.

Certify that the existing fixed far plane covers Moon apogee plus body and framing
margin. Keep it fixed unless the numeric test or a reference station demonstrates a
real failure. Do not use the Sun as a reason to set the physical camera far plane to
1 AU; the far-field Sun stays outside physical-depth placement.

### Reference-shape and datum policy

The first runtime renderer uses checked spherical reference radii for Earth, Moon, and
Sun. Earth source compilation must still interpret each product's declared horizontal
and vertical datum correctly before resampling it into the shared body-fixed spherical
runtime convention. This preserves geography, shoreline, elevation, and texture
alignment without threading an oblate reference surface through terrain selection,
atmosphere, ocean, contact, and physics in the visual pass.

Keep the shape contract extensible so an oblate Earth can be introduced later without
changing asset provenance or UV conventions. Runtime WGS84 ellipsoid geometry,
geodetic altitude, and ellipsoidal contact queries are explicitly deferred.

## End-to-End Code Paths That Must Stay Coherent

### Content and construction

Checked Sol constants → production `SOL_SYSTEM` → parameterized `GameState` →
`Universe` hierarchy → `BODY_VISUALS` → `BodyRendererManager` →
`createBodyRendererCandidate`.

The separate path `LEGACY_AUREN_TEST_SYSTEM` → explicit test `GameState` options must
never be selected by production startup, renderer defaults, or a silent fallback.

All validators, content-derived tests, material descriptors, launch-site lookups, and
body-name consumers must use Sun/Earth/Moon IDs. Saves are intentionally invalidated
rather than migrated.

### Asset path

Pinned source record → fetch/checksum → deterministic reprojection and channel build →
KTX2/fallback files → manifest validation → checked manifest → `PlanetAssetLoader` →
borrowed `RuntimeBodyAssetPack` → renderer staging → shader compile → resource-budget
admission → atomic renderer commitment.

Source rasters are authoring inputs. The browser never fetches multi-gigabyte NASA or
NOAA datasets and never depends on a third-party tile service at runtime.

### Frame path

`WorldScene.update` final camera → f64 Sun/Earth/Moon positions → relevant-body set →
camera-relative origins and true angular descriptors → body renderer updates → active
atmosphere/environment state → opaque scene → atmosphere/cloud composition → tone map.

The frame contract must explicitly carry true observer distance and angular radius;
renderers must not reconstruct these values from a clamped Three.js transform.

### Height path

Checked macro-height asset → active-body height cache → `TerrainSurfaceProvider` →
`evaluateRecipeHeight` augmentation → terrain worker geometry, compact displacement,
surface queries, launch-site envelope, ground avoidance, and contact sampling.

The implementation must keep a low-resolution global macro level resident. Higher
levels are promoted before descent through their altitude band. Rendering and contact
must never observe different committed height versions for the same tile.

### Orientation and UV path

Checked pole/prime-meridian model → `bodyOrientation` → inertial/body-fixed transforms →
cube-face terrain direction and spherical reference coordinates → asset sampling → compact,
terrain, cloud, and night-light channels.

One explicit seam convention is shared everywhere. No material may add an unexplained
half-turn to make a texture “look right.”

### Lighting path

True Sun direction and angular radius → solar radiance/light state → compact surface,
terrain, Moon, ocean, atmosphere LUTs, cloud lighting, vessel/launch solids, and shadow
camera. Ambient light becomes an environment product, not a body-independent constant.

### Lifecycle path

Startup, tier replacement, asset failure, context loss/restoration, active-body change,
and `WorldScene.dispose` must release every LUT, render target, texture reference,
material variant, tile cache entry, geometry, worker, and shadow resource exactly once.

## Phase 0 — Baseline, References, and Non-Negotiable Contracts

### Task 1: Capture the current visual baseline before changing content

**Files:**

- Use: `e2e/veyra-render-diagnostics.spec.ts`
- Use: `e2e/helpers/renderDiagnostics.ts`
- Create: `docs/performance/reference/sol-visual-baseline-2026-07-19.md`
- Create: `docs/performance/reference/sol-visual-baseline-2026-07-19.json`

**Work:**

- [ ] Record commit, browser, GPU, viewport, drawing buffer, DPR, quality tier, manifest
  digest, tone mapping, exposure, and shadow state.
- [ ] Capture fixed Veyra/Palla/Auren frames matching the future reference matrix as
  closely as their compact scale allows.
- [ ] Record draw calls, triangles, texture/geometry/render-target bytes, shader errors,
  transition state, and frame-time percentiles.
- [ ] Label every image with camera altitude, camera-to-body distance, field of view,
  sun direction, and simulation time.
- [ ] Preserve raw images under ignored test results and commit only the procedure,
  metadata, and approved comparison plates.

**Done when:** every later “better” claim can be compared against a named, reproducible
camera station rather than memory.

### Task 2: Add a rendering-only reference camera harness

**Files:**

- Create: `src/proto/solVisualReferenceProto.ts`
- Create: `e2e/sol-visual-reference.spec.ts`
- Create: `e2e/helpers/solReferenceStations.ts`
- Modify: `src/main.ts`
- Test: `tests/sol-reference-stations.test.ts`

**Work:**

- [ ] Add query-gated reference stations; do not add player-facing UI.
- [ ] Define stations by physical body, body-fixed latitude/longitude, altitude or
  distance, FOV, Sun direction/time, and expected presentation layer.
- [ ] Cover Sun from Earth, Earth full disk, Earth limb, low orbit, 10 km, ground,
  ocean horizon, Moon from Earth, Moon full disk, lunar low orbit, and lunar surface.
- [ ] Add eclipse/occultation alignment stations for scale verification.
- [ ] Capture deterministic PNG plus a JSON sidecar containing camera and renderer
  diagnostics.

**Done when:** one command produces the entire visual comparison matrix without flying
a craft or opening gameplay screens.

### Task 3: Freeze the visual/scale acceptance contract

**Files:**

- Create: `docs/superpowers/specs/2026-07-19-sol-visual-contract.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-10-planet-graphics-design.md`

**Work:**

- [ ] Include the scale rules and deferred-work list from this plan.
- [ ] Add NASA reference images for each station with attribution and crop metadata.
- [ ] Define numeric angular-size tolerances: maximum 0.5 percent error for bodies
  larger than 16 px; maximum 0.5 px error below that threshold.
- [ ] Define orientation landmarks: Africa/Atlantic and lunar near-side/far-side
  control points must appear at expected body-fixed coordinates.
- [ ] Define transition rules: no flash, hole, double-exposure rim, square boundary, or
  more than one-frame luminance discontinuity at a fixed station.
- [ ] Define exposure rules using unclipped linear luminance diagnostics in addition to
  screenshot appearance.
- [x] Mark this plan as the active planet-visual authority in
  `CLAUDE.md`.
- [x] Mark the Revision-4 fictional-system sequence as superseded for active visual
  delivery while retaining it as historical architecture context. This prevents
  parallel work from continuing the Veyra-first sequence.

**Done when:** implementation cannot quietly trade physical scale for a nicer framing.

## Phase 1 — Sol Content and Coordinate Authority

### Task 4: Generate checked Sun/Earth/Moon constants

**Files:**

- Create: `scripts/fetch-sol-constants.mjs`
- Create: `scripts/compile-sol-constants.mjs`
- Create generated: `assets/sol/constants-source.json`
- Create generated: `src/generated/checked-sol-constants.ts`
- Modify: `scripts/validate-content.mjs`
- Modify: `package.json`
- Test: `tests/sol-constants.test.ts`

**Work:**

- [ ] Pin NAIF PCK and GM kernel versions and checksums.
- [ ] Extract radii, GM, pole, prime meridian, and rotation expressions with units.
- [ ] Pin the exact AU and selected Earth/Moon mean elements.
- [ ] Make generation deterministic and network-free after sources are cached.
- [ ] Reject missing provenance, ambiguous units, non-finite numbers, and accidental
  kilometer/meter conversions.
- [ ] Snapshot the final interpreted values in tests.

**Done when:** physical constants are reproducible data, not copied literals scattered
through rendering code.

### Task 5: Select Sol for production and isolate the legacy system as a test fixture

**Files:**

- Modify: `src/content/system.ts`
- Create: `tests/fixtures/legacyAurenSystem.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/content/validate.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/sim/universe.ts`
- Modify: `src/sim/campaign.ts`
- Modify mechanically where a body ID is required: `src/game.ts`
- Modify mechanically where a body ID is required: `src/sim/comms.ts`
- Modify mechanically where a body ID is required: `src/sim/scatterRecipe.ts`
- Modify mechanically where a body ID is required: `src/sim/terrain.ts`
- Modify mechanically where a body ID is required: `src/sim/terrainRecipe.ts`
- Modify mechanically where a body ID is required: `src/render/worldScene.ts`
- Modify mechanically where a body ID is required: `src/render/terrestrialBodyRenderer.ts`
- Modify mechanically where a body ID is required: `src/ui/editor.ts`
- Modify: `src/save/schema.ts`
- Modify: `src/ui/utilityTools.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `src/proto/feasibilityProto.ts`
- Modify: `src/proto/terrainProto.ts`
- Modify: every unit/integration test that constructs `GameState` and every test that
  imports `AUREN_SYSTEM` or depends on any of the 12 fictional body IDs
- Keep: `e2e/fixtures/veyra-diagnostic-craft.json` for unit/release-blocker regression
  tests that explicitly use the legacy system
- Retire after Phase-0 capture: the Veyra browser diagnostic path; replace it with the
  separate Sol reference harness rather than loading test-only content in production
- Delete or rename: fictional generated runtime assets only after Sol replacements
  exist and no production manifest references them

**Work:**

- [ ] Introduce `SOL_SYSTEM` with IDs `sun`, `earth`, and `moon`; set Earth as home.
- [ ] Remove the other fictional bodies from active content for this first Sol slice.
- [ ] Change `GameState` to accept an explicit immutable system/home-body option while
  defaulting production construction to `SOL_SYSTEM` and Earth.
- [ ] Move the complete 12-body `AUREN_SYSTEM` definition into a clearly named test
  fixture. Tests that validate compact physics, stock craft, missions, campaign,
  science, comms, ISRU, gas bodies, saves, and release blockers must opt into that
  fixture explicitly.
- [ ] Add a guard proving production bundles/startup do not import or silently select
  the legacy fixture.
- [ ] Use checked values for radius, GM, rotation, axial orientation, and mean orbit.
- [ ] Set Earth atmosphere dimensions and density parameters from a versioned visual
  atmosphere descriptor rather than reusing Veyra constants.
- [ ] Remove fictional descriptions, biomes, colors, and material IDs from active data.
- [ ] Intentionally bump or replace the content/save schema; do not build save migration.
- [ ] Parameterize content validation and save body lookup by the selected system.
  Production defaults to Sol; legacy save/regression tests supply the fixture. Do not
  leave `src/save/schema.ts` importing one global system constant.
- [ ] Add `src/sim/campaign.ts` to the body-ID audit. Under production Sol, suppress
  legacy contracts whose referenced worlds are absent; do not invent Artemis or
  retune rewards in this pass. Preserve existing contract behavior under the fixture.
- [ ] Audit all hardcoded IDs in `src/content`, `src/sim`, `src/game.ts`, save schema,
  renderers, editor/utility UI, asset tools, prototypes, E2E, and tests. A grep limited
  to `AUREN_SYSTEM` imports is insufficient because 37 tests inherit the system from
  `GameState` today.
- [ ] Record physical-scale consequences for craft, ascent, reentry, transfers,
  campaign, science, comms, map, and progression as deferred migration work.

**Done when:** production startup constructs exactly Sun → Earth → Moon; no active
renderer or active contract is selected by a fictional ID; legacy compact-scale tests
pass only through explicit fixture injection; and no craft or mission has been falsely
claimed to work at physical Earth-Moon scale.

### Task 6: Establish the spherical body-fixed orientation authority

**Files:**

- Modify: `src/sim/universe.ts`
- Modify: `src/sim/bodyOrientation.ts`
- Create: `src/sim/bodyReferenceFrame.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/terrestrial/globalCoordinates.ts`
- Modify test: `tests/body-orientation.test.ts`
- Create: `tests/body-reference-frame.test.ts`

**Work:**

- [ ] Replace tilt-only orientation with a checked pole and prime-meridian model while
  keeping ergonomic transforms for runtime consumers.
- [ ] Add body-fixed spherical direction ↔ latitude/longitude transforms using the
  checked runtime reference radius.
- [ ] Define longitude handedness, UV origin, seam location, north direction, and cube
  face convention in one module.
- [ ] Add landmark vectors from source metadata and verify round trips.
- [ ] Ensure angular velocity and surface velocity follow the new rotation authority.
- [ ] Keep source-datum reprojection in the asset compiler. Do not introduce runtime
  ellipsoid altitude/normals or change contact/orbit calculations in this pass.

**Done when:** Earth and Moon products align without shader-local rotation hacks, and
the runtime remains on one documented spherical reference-surface model.

## Phase 2 — Source Asset Pipeline

### Task 7: Extend manifest semantics for scientific source data

**Files:**

- Modify: `assets/planets/manifest.json`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `scripts/fetch-planet-source.mjs`
- Modify: `scripts/validate-content.mjs`
- Modify: `src/render/planetAssetLoader.ts`
- Modify generated: `src/generated/checked-planet-manifest.json`
- Modify: `CONTENT_PIPELINE.md`
- Test: `tests/content-validator.test.ts`
- Create: `tests/planet-asset-loader.test.ts`

**Contract additions:**

- source datum and vertical datum;
- projection and axis order;
- longitude direction and seam;
- source value scale, offset, no-data value, and valid range;
- observation date/time and whether a product is measured, modeled, or composited;
- derived-channel recipe and version;
- required attribution and usage review;
- body reference-frame version;
- optional channels such as `heightMacro`, `emissive`, `cloudCoverage`, and
  `cloudOpticalDensity`.

**Done when:** a source can be reprocessed without reverse-engineering an old script or
guessing how its pixels map onto a body.

### Task 8: Measure and approve Sol asset and runtime budgets

**Files:**

- Modify: `assets/planets/manifest.json`
- Modify: `scripts/validate-content.mjs`
- Modify: `src/render/resourceAccounting.ts`
- Create: `tests/sol-resource-budget-policy.test.ts`
- Create: `docs/performance/reference/sol-resource-budget-2026-07-19.md`

**Work:**

- [ ] Inventory current Low/Medium/High compressed transfer, fallback transfer,
  texture GPU, renderer-base GPU, render-target, height-cache, terrain, worker, and
  transient replacement peaks on the reference hardware/browser.
- [ ] Estimate Earth and Moon pack sizes from representative encoded samples for every
  proposed channel before final resolutions are selected.
- [ ] Budget independently for boot-critical transfer, per-body deferred transfer,
  active-body borrowed textures, renderer-owned targets, and transactional old+new
  replacement overlap.
- [ ] Treat the current 32 MiB Medium pack and 64/128/256 MiB active-body GPU ceilings
  as inputs, not promises. Keep them if the measured packs fit; otherwise propose the
  smallest explicit revision with cold-load and runtime evidence.
- [ ] Define per-tier channel/resolution cuts in priority order. Identity albedo,
  macro height, and orientation correctness outrank night lights, extra local material
  layers, cloud depth, and higher-order ocean detail.
- [ ] Keep source rasters outside runtime/public transfer accounting.
- [ ] Make `validate:content` reject both per-pack overages and combined active renderer
  peaks using the approved ceilings.

**Done when:** Earth asset work begins against reviewed numerical ceilings rather than
discovering a transfer or GPU blocker after the pack is built.

### Task 9: Build the Earth source pack

**Files:**

- Create cached sources under: `assets/planets/sources/nasa-earth/`
- Create: `scripts/lib/earth-source-pack.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Create generated: `public/planets/generated/earth/{low,medium,high}/...`
- Modify generated manifests and compiler output
- Test: `tests/earth-assets.test.ts`

**Work:**

- [ ] Pin a Blue Marble Next Generation month and preserve natural color.
- [ ] Reproject ETOPO ice-surface elevation into the shared body coordinate convention.
- [ ] Derive ocean/land/ice masks from data rather than albedo thresholds.
- [ ] Derive macro normals from the same datum-corrected elevation resampled into the
  spherical runtime convention used by terrain.
- [ ] Extract the separate pinned Blue Marble cloud product into coverage and optical-
  density channels; keep clouds out of the surface albedo.
- [ ] Add a pinned, radiometrically bounded Black Marble emissive mask for Medium/High.
- [ ] Generate mip chains with channel-appropriate filtering: color in linear light,
  normals renormalized, masks area-filtered, and height min/max metadata preserved.
- [ ] Emit KTX2 plus tested fallback formats under the approved Task 8 tier budgets.
- [ ] Record transformations and exact credits in the manifest.

**Done when:** Earth is recognizable from its data before atmosphere, ocean, or cloud
shaders are enabled.

### Task 10: Rebuild Palla's NASA assets as the Moon pack

**Files:**

- Reuse cached NASA source files if checksums match
- Create: `scripts/lib/moon-source-pack.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Create generated: `public/planets/generated/moon/{low,medium,high}/...`
- Remove generated Palla runtime packs after Moon commitment
- Test: `tests/moon-assets.test.ts`

**Work:**

- [ ] Preserve LROC color/albedo without fictional tinting.
- [ ] Decode LOLA elevation using the source-specified scale and datum.
- [ ] Reproject both products into the new lunar body-fixed convention.
- [ ] Generate aligned macro height, normals, and conservative material channels.
- [ ] Validate near-side landmark, far-side basin, poles, seam, and elevation range.
- [ ] Ensure Low/Medium/High packs all exist; do not leave the Moon dependent on a
  Medium-only legacy pack.

**Done when:** compact and terrain inputs describe the same Moon in the same orientation.

### Task 11: Pin sourced local PBR materials

**Files:**

- Create cached sources under: `assets/planets/sources/cc0-surface-materials/`
- Create: `scripts/lib/local-material-pack.ts`
- Modify generated Earth and Moon packs
- Test: `tests/local-material-assets.test.ts`

**Work:**

- [ ] Select a minimal CC0 set: Earth rock/soil/sand/snow/ice and lunar regolith.
- [ ] Use Poly Haven as the first-choice library because its assets are photoscanned,
  seamless, real-scale PBR sets and explicitly CC0; use another source only after the
  same license/provenance review.
- [ ] Pin license snapshot, author, original URL, resolution, and checksum.
- [ ] Normalize texel density and tangent convention without recoloring them into
  global geography.
- [ ] Package albedo variation at low strength, normal, ambient occlusion if useful,
  and roughness.
- [ ] Reject height/displacement channels from the shading pack; geometric height has
  its own authority.
- [ ] Keep the total material set small enough for array textures or an atlas with
  guarded borders.

**Done when:** near-field detail comes from credited source materials and no manual
texture creation is part of the workflow.

## Phase 3 — Physical Presentation and Precision

### Task 12: Add explicit celestial projection data to each frame

**Files:**

- Modify: `src/render/bodyRenderer.ts`
- Create: `src/render/celestialProjection.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/celestial-projection.test.ts`
- Modify: `tests/body-renderer.test.ts`

**Work:**

- [ ] Carry true f64 observer distance, angular radius, projected pixel radius, proxy
  depth, and visibility classification in `BodyRenderFrame`.
- [ ] Compute apparent size before converting to Three.js coordinates.
- [ ] Add robust inside/on-surface handling and reject invalid `asin` inputs.
- [ ] Distinguish nearby physical geometry, far-field angular presentation, and culled
  subpixel bodies.
- [ ] Preserve one source of truth across color, depth, picking diagnostics, and eclipse
  tests.

**Done when:** no renderer infers apparent size from a clamped or scaled mesh.

### Task 13: Certify the fixed Earth-Moon depth envelope

**Files:**

- Modify: `src/render/worldScene.ts`
- Test: `tests/camera-depth-policy.test.ts`

**Work:**

- [ ] Keep the smallest safe near plane for the current camera/craft relationship.
- [ ] Prove numerically that Moon apogee, both body radii, camera offsets, and required
  framing margin remain inside the existing 600,000 km far plane.
- [ ] Keep Sun proxies and starfield independent of the physical far plane.
- [ ] Verify Earth and Moon can occupy the same view at apogee without clipping.
- [ ] Add a fail-fast assertion/test if later content exceeds the certified envelope.
- [ ] Preserve the current fixed near/far policy unless measurement demonstrates an
  actual clip or precision failure; do not add a dynamic policy module speculatively.

**Done when:** Earth-Moon scale works inside the existing depth range without a new
camera-policy subsystem or a physical far plane expanded to 1 AU.

### Task 14: Add an angular occultation authority

**Files:**

- Create: `src/render/celestialOcclusion.ts`
- Modify: `src/render/worldScene.ts`
- Modify Sun/atmosphere post inputs in later tasks
- Test: `tests/celestial-occlusion.test.ts`

**Work:**

- [ ] Compute angular disk overlap for Sun, Earth, and Moon from f64 vectors/radii.
- [ ] Provide visible solar fraction and limb intersection data.
- [ ] Use the result for the Sun disk, solar glare, direct-light intensity, atmosphere,
  and cloud lighting.
- [ ] Keep penumbra softness based on the Sun's finite angular radius.
- [ ] Do not implement general n-body shadow volumes in this pass.

**Done when:** eclipse silhouettes and light reduction agree geometrically.

## Phase 4 — Sun Renderer

### Task 15: Replace `StarBodyRenderer` with a physical Solar renderer

**Files:**

- Create: `src/render/solarBodyRenderer.ts`
- Create: `src/render/solar/photosphereMaterial.ts`
- Create: `src/render/solar/solarPresentation.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Retire: `src/render/starBodyRenderer.ts` after transactional fallback proves stable
- Test: `tests/solar-body-renderer.test.ts`

**Work:**

- [ ] Render a far-field analytic disk at safe proxy depth with exact projected radius.
- [ ] Apply analytic limb darkening before tone mapping.
- [ ] Add band-limited, scale-aware granulation that disappears below pixel footprint.
- [ ] Add sparse, deterministic low-amplitude active-region and facular modulation only
  where it remains visible after footprint filtering.
- [ ] Keep an optional future observation-mask input in the material contract without
  loading, animating, or requiring an HMI pack.
- [ ] Render a camera-relative physical sphere for near-Sun views.
- [ ] Cross-fade near/far presentations with identical angular size and luminance.
- [ ] Accept `stageAssets(null)` as a fallback and participate in existing candidate
  compile/commit/rollback behavior.

**Done when:** the Sun reads as a luminous photosphere at all supported distances and
never changes apparent size because of proxy placement.

### Task 16: Separate solar disk, glare, and corona

**Files:**

- Create: `src/render/solar/solarGlare.ts`
- Create: `src/render/solar/coronaMaterial.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/solar-glare.test.ts`

**Work:**

- [ ] Keep the photospheric disk photometrically stable and depth/occlusion aware.
- [ ] Add glare in a bounded screen-space pass driven by visible solar fraction.
- [ ] Prevent glare from contributing to angular-size or occultation measurements.
- [ ] Show corona primarily outside the limb and suppress it in ordinary exposed
  daylight views.
- [ ] Avoid anamorphic flares, decorative rays, and the current 16×16 radial sprite.

**Done when:** hiding half the Sun behind the Moon hides the corresponding disk and
reduces glare without altering the lunar silhouette.

## Phase 5 — Earth Global Surface and Environment

### Task 17: Parameterize the terrestrial stack instead of cloning Veyra

**Files:**

- Modify: `src/render/terrestrialBodyRenderer.ts`
- Create: `src/render/terrestrial/terrestrialVisualProfile.ts`
- Modify: `src/content/bodyVisuals.ts`
- Modify: `src/render/bodyMaterial.ts`
- Test: `tests/terrestrial-body-renderer.test.ts`

**Work:**

- [ ] Make ocean, clouds, night emission, atmosphere, and terrain independently
  declared channels.
- [ ] Remove Veyra ID/launch-site assumptions from renderer construction.
- [ ] Define Earth atmosphere coefficients, ocean optical properties, cloud layer
  heights, ground albedo response, and exposure as checked profile data.
- [ ] Preserve `stageAssets(null)` fallback and transactional replacement.
- [ ] Account separately for borrowed textures, renderer geometry, LUT/render targets,
  cloud history, and terrain allocation.

**Done when:** Earth is data-driven and the renderer can also represent a dry or
cloudless terrestrial body without hidden assumptions.

### Task 18: Correct compact Earth material sampling and source alignment

**Files:**

- Modify: `src/render/terrestrial/globalGeometry.ts`
- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/terrestrial/globalCoordinates.ts`
- Test: `tests/earth-global-material.test.ts`

**Work:**

- [ ] Generate sufficiently tessellated spherical compact geometry with stable
  body-direction attributes and the checked Earth runtime reference radius.
- [ ] Sample albedo, macro normal, material masks, ice, and night emission in one
  coordinate convention.
- [ ] Keep city lights off the day side and attenuate them under clouds and atmosphere.
- [ ] Use energy-conserving roughness/specular values; continents must not look plastic.
- [ ] Increase geometry only where silhouette error warrants it; texture resolution is
  not a reason to over-tessellate the globe.

**Done when:** an unclouded Earth compact sphere has correct angular silhouette,
geography, terminator, ocean mask, and night side.

### Task 19: Replace fixed ambient with atmosphere-derived environment light

**Files:**

- Modify: `src/render/worldScene.ts`
- Create: `src/render/planetEnvironment.ts`
- Modify: terrestrial, ocean, Moon, vessel, and launch-site material update paths
- Test: `tests/planet-environment.test.ts`

**Work:**

- [ ] Remove the constant `#2a3844 @ 0.55` assumption for Earth.
- [ ] Derive direct-sun color/intensity and low-frequency sky/ground irradiance from
  the atmosphere state and observer altitude.
- [ ] Feed the same environment to opaque planet-adjacent objects.
- [ ] Keep the Moon's environment near-black except for direct Sun and optional Earth
  bounce added only if explicitly validated later.
- [ ] Preserve neutral deep-space background and starfield exposure.

**Done when:** daylight, twilight, night, orbit, and lunar lighting change for physical
reasons rather than a hardcoded altitude tint.

## Phase 6 — Earth Atmosphere and Aerial Perspective

### Task 20: Replace the partial LUT foundation with the selected atmosphere pipeline

**Files:**

- Replace/modify: `src/render/terrestrial/atmosphereLuts.ts`
- Modify: `src/render/terrestrial/atmosphere.ts`
- Modify: `src/render/terrestrial/atmosphereMaterial.ts`
- Create: `src/render/terrestrial/skyViewLut.ts`
- Create: `src/render/terrestrial/aerialPerspectiveLut.ts`
- Create: `src/render/terrestrial/atmosphereState.ts`
- Test: `tests/earth-atmosphere-luts.test.ts`
- Modify: `tests/veyra-atmosphere.test.ts` or replace it with Earth coverage

**Work:**

- [ ] Use physically dimensioned Rayleigh, Mie, absorption, scale-height, ground, and
  solar inputs.
- [ ] Generate transmittance and multiple-scattering LUTs with float targets where
  capabilities permit and quantified encoded fallback otherwise.
- [ ] Generate sky-view and bounded aerial-perspective products per observer/light
  state with tiered update rates.
- [ ] Validate dimensional homogeneity, monotonic transmittance, horizon continuity,
  day/night behavior, and below-ground rejection.
- [ ] Cache only by immutable atmosphere parameters and release per-view render targets
  correctly.

**Done when:** the implementation accurately claims a complete runtime atmosphere path,
not merely a shell plus two low-dimensional tables.

### Task 21: Apply aerial perspective to opaque ground and objects

**Files:**

- Modify: `src/render/terrestrial/globalMaterial.ts`
- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Modify: `src/render/vesselMesh.ts`
- Modify launch-site material path in: `src/render/worldScene.ts`
- Create: `src/render/terrestrial/aerialPerspectiveMaterial.ts`
- Test: `tests/aerial-perspective-material.test.ts`

**Work:**

- [ ] Sample transmittance and in-scattered radiance from camera to opaque fragment.
- [ ] Fog by physical path length and altitude, not object distance alone.
- [ ] Apply one shared shader chunk/uniform block across all opaque consumers.
- [ ] Exclude starfield, Sun disk, additive plumes, UI, and already-integrated
  atmosphere/cloud passes.
- [ ] Remove `uAerialPerspective` once its replacement is live; do not leave a second
  dead control.

**Done when:** terrain kilometers away visibly loses contrast and shifts toward the sky
while nearby ground remains crisp.

### Task 22: Make sky, limb, and surface composition continuous

**Files:**

- Modify: `src/render/terrestrial/atmosphereMaterial.ts`
- Modify: `src/render/terrestrial/atmosphere.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/atmosphere-composition.test.ts`

**Work:**

- [ ] Eliminate a visible seam between background sky and atmosphere shell.
- [ ] Match orbital limb radiance to the same LUTs used from inside the atmosphere.
- [ ] Handle camera crossing atmosphere top without render-order flashes.
- [ ] Feed finite solar angular radius/occlusion into sunrise, sunset, and eclipse light.
- [ ] Verify horizon tangent rays and ocean horizon under all quality tiers.

**Done when:** one continuous model covers ground, ascent, limb, and space views.

## Phase 7 — Earth Clouds and Ocean

### Task 23: Drive clouds from sourced macro structure

**Files:**

- Modify: `src/render/terrestrial/cloudLayer.ts`
- Modify: `src/render/terrestrial/cloudMaterial.ts`
- Modify: `tests/veyra-clouds.test.ts` or replace with Earth-specific coverage
- Create: `tests/earth-clouds.test.ts`

**Work:**

- [ ] Decode source coverage/optical-density channels in body-fixed coordinates.
- [ ] Preserve broad weather systems instead of replacing them with noise.
- [ ] Use procedural 3D detail only to shape source-defined clouds below source
  resolution.
- [ ] Add physically consistent sun transmittance, self-shadow approximation, silver
  lining, and atmosphere attenuation.
- [ ] Keep Low as a stable shell, Medium as parallax/bounded depth, and High as bounded
  volume with temporal reprojection.
- [ ] Re-test horizon radial lines and cloud-layer crossings from fresh captures.
- [ ] Correlate compact cloud opacity and near cloud density during transitions.

**Done when:** Earth reads as a weather-bearing planet without cloud decals, radial
shell artifacts, or a discontinuity during descent.

### Task 24: Replace the ocean lighting hierarchy

**Files:**

- Modify: `src/render/terrestrial/ocean.ts`
- Modify: `src/render/terrestrial/oceanMaterial.ts`
- Modify: `tests/ocean-cap.test.ts`
- Replace/modify: `tests/veyra-ocean.test.ts`
- Create: `tests/earth-ocean.test.ts`

**Work:**

- [ ] Preserve data-derived global ocean/shoreline masks.
- [ ] First ship Fresnel sky/Sun reflection, filtered normal spectra,
  roughness-dependent glitter, depth color, atmosphere attenuation, and BRDF variance
  toward the horizon on the existing camera-local cap.
- [ ] Filter wave energy by pixel footprint to prevent horizon shimmer and moire.
- [ ] Keep the camera-local cap crack-free and below land at coastlines.
- [ ] Verify from orbit that ocean color is not a flat opaque blue overlay.
- [ ] Add represented near-camera wave geometry only on High and only after the
  BRDF/normal path passes Gate C with measured headroom. If it does not materially
  improve the ground/ocean reference stations, defer it without blocking the pass.

**Done when:** ocean appearance remains coherent from full disk to a surface horizon.

## Phase 8 — Source-Backed Terrain and Near Detail

### Task 25: Add macro-height assets to the canonical surface provider

**Files:**

- Modify: `src/sim/terrainRecipe.ts`
- Modify: `src/render/terrain/surfaceProvider.ts`
- Create: `src/sim/macroHeightField.ts`
- Create: `src/render/terrain/macroHeightTileCache.ts`
- Modify: `src/render/terrain/chunkWorker.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`
- Modify: `src/render/terrain/chunkGeometry.ts`
- Modify: `src/render/planet.ts`
- Modify: `src/render/terrain/terrainSelection.ts`
- Modify: `src/render/terrain/terrainPolicy.ts`
- Modify: `src/render/terrain/terrainResidency.ts`
- Modify: `src/render/terrain/terrainScheduler.ts`
- Modify: `src/sim/terrain.ts`
- Test: `tests/macro-height-field.test.ts`
- Modify: `tests/terrain-worker.test.ts`
- Modify: `tests/terrain-authority.test.ts`

**Work:**

- [ ] Compile ETOPO/LOLA elevation into a cube-face multiresolution height pyramid with
  per-tile min/max, datum, version, and checksum.
- [ ] Keep a coarse global level resident for every active body.
- [ ] Prefetch finer source levels by predicted camera footprint before their visual
  altitude band.
- [ ] Combine macro height with deterministic band-limited canonical detail.
- [ ] Give render workers and synchronous surface/contact queries the same immutable
  committed height version.
- [ ] Prevent a tile from changing under a loaded terrain chunk; promote atomically and
  rebuild through the existing transition path.
- [ ] Include height-cache bytes and transfers in resource accounting.

**Done when:** continents/mountains or lunar basins affect actual terrain geometry, and
the renderer never invents a second contact surface.

### Task 26: Fix near-normal composition and add sourced material detail

**Files:**

- Modify: `src/render/terrestrial/surfaceMaterial.ts`
- Create: `src/render/surface/localMaterialSampling.ts`
- Modify: `src/render/airless/globalMaterial.ts`
- Create: `src/render/airless/surfaceMaterial.ts`
- Test: `tests/surface-normal-composition.test.ts`
- Test: `tests/local-material-sampling.test.ts`

**Work:**

- [ ] Remove the fixed 68 percent blend toward the global normal.
- [ ] Compose geometric, macro, and local normals in one body-fixed tangent frame using
  a tested normal-combination method.
- [ ] Weight each frequency band by pixel footprint and source resolution.
- [ ] Sample sourced local PBR materials using seam-free triplanar/stochastic mapping.
- [ ] Keep local albedo influence low enough that it cannot recolor continents, ice,
  maria, or lunar rays.
- [ ] Set a texture-fetch ceiling per quality tier before enabling variants.
- [ ] Fade subpixel detail analytically to prevent crawling.

**Done when:** meter-scale shading is visible near ground without flattening terrain or
tiling visibly across kilometers.

### Task 27: Make compact/terrain and LOD transitions data-aware

**Files:**

- Modify: `src/render/terrainPresentation.ts`
- Modify: `src/render/coverageTransition.ts`
- Modify: `src/render/terrain/lodTransition.ts`
- Modify: `src/render/terrain/lodDither.ts`
- Modify: `src/render/terrestrialBodyRenderer.ts`
- Modify the new airless renderer from Phase 9
- Test: transition and terrain-presentation suites

**Work:**

- [ ] Base presentation bands on screen-space error, asset resolution, body radius,
  terrain relief, FOV, and drawing-buffer height rather than fictional-radius ratios.
- [ ] Ensure compact displacement and terrain macro height agree at handoff.
- [ ] Preserve parent coverage until all required children and source-height versions
  are resident.
- [ ] Reproduce and classify square boundaries, compact/terrain flashing, and LOD pops
  before choosing morphing, dither, or delayed commitment.
- [ ] If geometric popping remains after height agreement, add coarse-parent geometry
  attributes through worker transfer, bounds, depth, distance, shadow, and disposal
  paths before implementing geomorphing.

**Done when:** descent does not reveal a different planet and no transition artifact is
hidden by faster fades.

## Phase 9 — Moon Renderer

### Task 28: Implement a reusable airless-body renderer

**Files:**

- Create: `src/render/airlessBodyRenderer.ts`
- Modify: `src/render/airless/globalMaterial.ts`
- Use/create: `src/render/airless/surfaceMaterial.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/content/bodyVisuals.ts`
- Test: `tests/airless-body-renderer.test.ts`

**Work:**

- [ ] Give compact and terrain presentations the same NASA asset pack and height
  authority.
- [ ] Support source-derived displacement, macro normals, local regolith response,
  and the existing terrain quadtree.
- [ ] Omit atmosphere, clouds, ocean, and terrestrial environment state by contract.
- [ ] Preserve renderer transaction, fallback, resource accounting, context restore,
  active-body switching, and disposal behavior.
- [ ] Set Moon to `renderer: 'airless'` only after all tier packs pass preparation.

**Done when:** the Moon no longer enters a legacy Lambert near-ground path.

### Task 29: Tune lunar photometry and shadow readability

**Files:**

- Modify: airless materials
- Create: `src/render/airless/lunarPhotometry.ts`
- Test: `tests/lunar-photometry.test.ts`

**Work:**

- [ ] Use a rough diffuse response suitable for regolith; avoid plastic specular.
- [ ] Preserve dark absolute albedo while allowing exposure to reveal terrain.
- [ ] Make terminator and grazing-angle relief stable without an artificial ambient
  fill that erases long shadows.
- [ ] Apply source resolution and footprint limits to macro normals.
- [ ] Validate near-side maria, far-side highlands, poles, low orbit, and surface.

**Done when:** the Moon reads through relief and photometry, not brightness or tint.

## Phase 10 — Shadows and Unified Exposure

### Task 30: Enable production shadows for Medium and High

**Files:**

- Modify: `src/render/context.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/vesselMesh.ts`
- Modify renderer caster/receiver setup
- Create: `src/render/shadowPolicy.ts`
- Test: `tests/shadow-policy.test.ts`

**Work:**

- [ ] Enable PCFSoft shadows on Medium/High; keep Low off.
- [ ] Use a camera-relative, active-body shadow camera with texel-snapped stabilization.
- [ ] Fit near/far and coverage to the local scene, not the Earth-Moon or Sun distance.
- [ ] Include terrain, vessels, launch solids, and appropriate cloud shadowing without
  making planetary spheres cast through proxy space.
- [ ] Apply normal and slope bias by receiver scale; reject one global magic bias.
- [ ] Rebuild safely on quality change and context restoration.

**Done when:** local relief and craft contact are grounded on Earth and Moon without
swimming shadow maps or acne.

### Task 31: Establish a unified HDR/exposure policy

**Files:**

- Modify: `src/render/context.ts`
- Create: `src/render/exposurePolicy.ts`
- Modify: `src/render/worldScene.ts`
- Test: `tests/exposure-policy.test.ts`

**Work:**

- [ ] Define exposure anchors for deep space, Sun in frame, Earth daylight, Earth
  night, atmosphere, and lunar daylight.
- [ ] Keep physical light ratios internally, then use bounded adaptation for display.
- [ ] Prevent the Sun from clipping the entire scene or the Moon from becoming gray
  fill-lit.
- [ ] Keep adaptation based on wall-clock time and deterministic in reference captures.
- [ ] Record exposure, pre-tone-map luminance percentiles, and clipping in diagnostics.

**Done when:** the same light model produces readable Sun, Earth, and Moon views without
per-shot manual material changes.

## Phase 11 — Integration, Failure Handling, and Verification

### Task 32: Integrate all three renderer families transactionally

**Files:**

- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/render/bodyRendererFactory.ts`
- Modify: `src/render/planetAssetLoader.ts`
- Modify: `src/render/shaderCompiler.ts`
- Modify: `src/render/resourceAccounting.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `tests/renderer-transaction.test.ts`
- Modify: `tests/body-renderer.test.ts`

**Work:**

- [ ] Prepare Sun, Earth, and Moon candidates through the same load/stage/compile/budget
  gate.
- [ ] Preserve the currently committed renderer when a tier pack, LUT target, shader,
  or budget check fails.
- [ ] Provide explicit procedural/minimal fallback visuals for first construction.
- [ ] Re-run commitment on context restoration and tier change without double-dispose.
- [ ] Add per-family stats: proxy/physical mode, angular radius, asset tier, LUT bytes,
  cloud history bytes, height-cache bytes, and shadow bytes.

**Done when:** a failed High-quality Earth replacement cannot make all planets vanish.

### Task 33: Add scale, source, and orientation automated checks

**Files:**

- Create: `tests/sol-scale.test.ts`
- Create: `tests/sol-orientation-landmarks.test.ts`
- Create: `tests/sol-asset-provenance.test.ts`
- Create: `tests/sol-render-resource-budget.test.ts`
- Create: `tests/sol-system-selection.test.ts`
- Create: `tests/campaign-body-contracts.test.ts`

**Work:**

- [ ] Verify physical radii and distances against checked sources.
- [ ] Verify apparent Sun, Earth, and Moon pixel diameters across FOV and viewport sizes.
- [ ] Verify Earth and lunar landmark directions, seam continuity, and polar sampling.
- [ ] Verify source checksums, transformation versions, attribution, and runtime paths.
- [ ] Verify all renderer-owned and borrowed resources fit tier ceilings.
- [ ] Verify production `GameState` selects only `SOL_SYSTEM`, legacy tests opt into the
  full fictional fixture explicitly, and no production-active contract targets a
  missing body.

**Done when:** common scale, seam, upside-down-texture, and source-drift regressions fail
before visual review.

### Task 34: Run the visual reference matrix and artifact audit

**Files:**

- Modify: `e2e/sol-visual-reference.spec.ts`
- Create: `docs/performance/reference/sol-visual-final-2026-07-19.md`
- Create: `docs/performance/reference/sol-visual-final-2026-07-19.json`

**Required stations:**

- Sun from Earth distance, unobscured and partially occulted.
- Earth-Moon true-scale wide shot.
- Earth full disk at day, terminator, and night.
- Earth atmosphere limb from 2,000 km and low orbit.
- Earth descent at 100 km, 20 km, 10 km, 1 km, and ground.
- Earth ocean/coast horizon and inland terrain.
- Moon from Earth with correct phase and angular size.
- Moon full near side, far side, polar light, low orbit, and surface.
- Compact/terrain, atmosphere-top, cloud-layer, and Sun proxy/physical transitions.

**Audit:**

- [ ] Compare numeric scale before judging aesthetics.
- [ ] Treat JSON diagnostic sidecars and numeric assertions as the primary automated
  gate. Treat screenshots as required human visual review evidence, not a lone
  pixel-perfect oracle vulnerable to browser/GPU variance.
- [ ] Review still frames and slow camera motion for shimmer, pop, seams, radial lines,
  square boundaries, z-fighting, and exposure pumping.
- [ ] Compare color and silhouette to cited NASA references under comparable light.
- [ ] Record every intentional artistic departure.
- [ ] Keep unresolved issues visible; do not tune reference cameras to hide them.

**Done when:** all required stations pass both numeric and visual review.

### Task 35: Performance and lifecycle gate

**Files:**

- Modify relevant diagnostics and performance reference files
- Use existing context-lifecycle and renderer-transaction tests

**Work:**

- [ ] Measure Low/Medium/High cold load, steady frame, transition spikes, shader compile,
  height-tile promotion, and context restoration.
- [ ] Record GPU/CPU memory by assets, terrain, atmosphere, clouds, shadows, and Sun.
- [ ] Verify no repeated network fetches, LUT rebuild loops, shader recompiles, worker
  leaks, or render-target accumulation.
- [ ] Run a repeated Earth ↔ Moon active-body cycle and tier replacement loop.
- [ ] Compare against Phase 0 on the same machine and browser.
- [ ] Treat regressions as explicit tradeoffs requiring review, not automatic acceptance
  because the image is prettier.

**Done when:** the new look is stable enough to become the foundation for later Artemis
mission presentation.

## Quality-Tier Policy

### Low

- Source-backed compact Earth and Moon.
- Analytic Sun disk with footprint-filtered procedural structure and no volumetric
  corona.
- Reduced atmosphere LUT resolution and update rate.
- Cloud shell with source macro coverage.
- No production shadow map.
- Reduced local material set and terrain source level.
- No night-light channel if it exceeds the measured transfer budget.

### Medium

- Default target and primary acceptance tier.
- Full global source packs within budget.
- Complete atmosphere path at moderate LUT resolution.
- Source-driven parallax/bounded-depth clouds.
- Ocean normal/BRDF hierarchy on the existing camera-local cap.
- Stabilized PCFSoft shadows.
- Source macro terrain plus sourced local PBR detail.
- Static Black Marble night lights.

### High

- Higher global/source terrain level where useful.
- Bounded volumetric clouds with temporal reprojection.
- Higher atmosphere and shadow resolution.
- Enhanced near-Sun corona and optional near-camera ocean wave geometry when measured
  headroom and visual comparison justify them.
- Larger local material arrays and higher anisotropy where supported.
- Same physical scale and core shading model as Medium; High is not a different look.

## Milestone Gates

### Gate A — Scale skeleton

- Sun/Earth/Moon content is active.
- The compact 12-body system is available only through explicit test-fixture injection.
- Production contracts do not reference unavailable fictional bodies.
- Earth and Moon physical meshes render camera-relative.
- Sun angular proxy is correct.
- Reference-station angular tests pass.
- Placeholder materials are acceptable only at this gate.

### Gate B — Source identity

- Earth and Moon source packs are checked, credited, aligned, and committed.
- The analytic Sun passes disk, limb-darkening, and procedural-structure references.
- Global screenshots are recognizable without local-detail tricks.
- This is a mandatory visual review checkpoint. Do not begin the expensive atmosphere,
  cloud, ocean, and unified-lighting program until the user approves the full-disk
  identity and true-scale framing produced by Gates A and B.

### Gate C — Earth light transport

- Atmosphere, aerial perspective, clouds, ocean, environment, exposure, and shadows are
  coherent from orbit to ground.
- No shell-only haze or fixed terrestrial ambient remains.

### Gate D — Moon and terrain continuity

- Compact and near Moon share source and height authority.
- Earth and Moon terrain transitions pass the artifact audit.
- Sourced local materials remain subordinate to global identity.

### Gate E — Final visual foundation

- All numeric, reference-image, performance, lifecycle, and failure gates pass.
- Deferred Artemis/gameplay work has not leaked into this change.
- The result is approved as the visual base for the later mission system.

## Verification Commands

Exact focused commands may change as files land, but the completed implementation must
support at least:

```bash
npm run validate:content
npx vitest run \
  tests/sol-constants.test.ts \
  tests/sol-scale.test.ts \
  tests/sol-resource-budget-policy.test.ts \
  tests/sol-orientation-landmarks.test.ts \
  tests/celestial-projection.test.ts \
  tests/celestial-occlusion.test.ts \
  tests/solar-body-renderer.test.ts \
  tests/earth-assets.test.ts \
  tests/moon-assets.test.ts \
  tests/earth-atmosphere-luts.test.ts \
  tests/earth-clouds.test.ts \
  tests/earth-ocean.test.ts \
  tests/airless-body-renderer.test.ts \
  tests/renderer-transaction.test.ts \
  tests/context-lifecycle.test.ts
npx vitest run tests/ascent.test.ts tests/palla-mission.test.ts \
  tests/gas-body.test.ts tests/isru.test.ts tests/science-biome.test.ts \
  tests/comms.test.ts tests/release-blockers.test.ts
npm run typecheck
npm run build
npx playwright test e2e/sol-visual-reference.spec.ts --project=chromium
```

Run the full existing suite at milestone gates because body IDs and scale affect broad
content assumptions even though gameplay design is deferred.

## Risks and Controls

### Risk: real scale is technically correct but impossible to frame

**Control:** preserve scale and use camera/FOV/reference-station choices. Do not enlarge
the Moon or shrink the Earth-Moon gap for screenshots.

### Risk: the Sun proxy breaks eclipses or lighting

**Control:** derive disk, glare, direct light, and atmosphere from one angular-occlusion
authority. Glare is composited after physical disk overlap.

### Risk: source imagery looks flat near ground

**Control:** separate macro identity from local sourced PBR detail and canonical
geometric detail. Never stretch a 500 m/pixel color map into a meter-scale texture.

### Risk: Earth becomes a giant asset download

**Control:** Task 8 measures representative encoded channels before pack resolutions
are locked. Deterministic tiered KTX2 packs, explicit revised ceilings when justified,
source-height pyramids, and runtime-only derived files keep the decision visible.
Source rasters remain offline authoring inputs.

### Risk: the legacy fixture leaks back into production

**Control:** production `GameState` defaults to `SOL_SYSTEM`; compact tests inject the
fixture explicitly; build/startup guards reject production imports; and active
contracts are validated against the selected system. The fixture preserves regression
coverage, not a second player-selectable universe.

### Risk: geographic elevation and collision disagree

**Control:** route macro height through the canonical surface provider and atomically
commit height versions to both worker geometry and synchronous surface queries.

### Risk: NASA data products use different datums and orientations

**Control:** explicit manifest metadata, checked body reference frames, reprojection in
the compiler, landmark tests, and no material-local UV correction constants.

### Risk: physically bright Sun makes everything else unusable

**Control:** retain HDR ratios, use bounded exposure adaptation, separate disk from
glare, and test pre-tone-map luminance rather than tuning only screenshots.

### Risk: the plan expands into a mission or simulator rewrite

**Control:** the reference harness is query-gated and rendering-only. Gameplay, mission
flow, save migration, and map UI remain listed deferrals at every milestone review.

## Primary Sources and Literature Reviewed

### Visual data and physical authority

- NASA Science, Earth facts and target visual context:
  https://science.nasa.gov/earth/facts/
- NASA SVS, Blue Marble Next Generation:
  https://svs.gsfc.nasa.gov/3539/
- NOAA NCEI, ETOPO 2022 Global Relief Model:
  https://www.ncei.noaa.gov/products/etopo-global-relief-model
- NASA Visible Earth, separate Blue Marble cloud product:
  https://visibleearth.nasa.gov/images/57747/blue-marble-clouds
- NASA SVS, GEOS-5 Modeled Clouds at 3.5 km Global Resolution, used as a
  cloud-motion and lighting reference rather than a runtime texture source:
  https://svs.gsfc.nasa.gov/3659/
- NASA Earthdata, VIIRS Black Marble products:
  https://worldview.earthdata.nasa.gov/
- Poly Haven asset license and texture standards:
  https://polyhaven.com/license
  https://docs.polyhaven.com/en/technical-standards/textures
- NASA SVS, CGI Moon Kit:
  https://svs.gsfc.nasa.gov/4720/
- Deferred solar-observation reference — NASA SDO, HMI/AIA channel descriptions:
  https://sdo.gsfc.nasa.gov/data/channels.php
- Deferred solar-observation reference — NASA SVS, HMI intensity imagery:
  https://svs.gsfc.nasa.gov/3988/
- JPL NAIF, Planetary Constants Kernel documentation and current generic kernels:
  https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/IDL/req/pck.html
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/
- JPL Solar System Dynamics, planetary satellite mean elements:
  https://ssd.jpl.nasa.gov/sats/elem/
- IAU 2015 Resolution B3 nominal values:
  https://arxiv.org/abs/1605.09788
- IAU WGCCRE 2015 report:
  https://ui.adsabs.harvard.edu/abs/2018CeMDA.130...22A/abstract

### Rendering methods

- Bruneton and Neyret, *Precomputed Atmospheric Scattering* (2008), and the tested
  2017 reference implementation:
  https://ebruneton.github.io/precomputed_atmospheric_scattering/
- Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*
  (2020):
  https://sebh.github.io/publications/egsr2020.pdf
- Bruneton, Neyret, and Holzschuch, *Real-time Realistic Ocean Lighting using Seamless
  Transitions from Geometry to BRDF* (2010).
- Schneider and Vos, *The Real-Time Volumetric Cloudscapes of Horizon: Zero Dawn*
  (SIGGRAPH 2015 course material):
  https://www.schneidervfx.com/

## Final Definition of Done

The pass is complete only when:

- production boots into only Sun, Earth, and Moon using physical radii, spacing, and
  checked orientations;
- the 12-body compact system exists only as an explicitly injected legacy test fixture,
  and its existing physics/mission regression suite remains green without claiming Sol
  gameplay compatibility;
- no production-active contract or renderer references a missing fictional body;
- their angular sizes are numerically correct in the reference views;
- Earth and Moon are immediately recognizable from authoritative source data;
- the Sun is a structured luminous photosphere, not a scaled sprite;
- Earth atmosphere affects sky, limb, terrain, ocean, clouds, and nearby opaque objects
  continuously from ground to space;
- Earth ocean and clouds remain coherent from full disk to surface;
- lunar relief and regolith remain coherent from full disk to surface;
- compact/terrain, cloud-layer, atmosphere-top, and Sun near/far transitions show no
  unclassified pop, seam, hole, or flash;
- Medium and High shadows and exposure are stable;
- asset, render-target, terrain, and worker budgets pass on all tiers;
- context restoration and failed renderer replacement preserve a usable scene;
- no player-facing Artemis mission or gameplay system was added.
