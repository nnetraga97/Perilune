# Moon and Sun Visual Completion Plan

**Date:** 2026-07-20

**Status:** Implemented through M8 code and Medium reference validation on 2026-07-21;
Low/High and M3 Max hardware acceptance remain the final release gate

**Branch reviewed:** `integration/sol-earth-moon`

**Reviewed commit:** `b04a789` (`feat: integrate Sol gameplay and maneuver automation`)

**Continues after:** Milestone 3 of
`docs/superpowers/plans/2026-07-20-sol-source-backed-visual-fidelity-correction.md`

## Implementation Record

- M4: locked and probed the 2025 Moon color, all five PGDA Site 01 products, and
  the pinned HMI observation; added the requested reference stations and baseline.
- M5: selected a fold-free east/north tangent-slope representation, made the
  equirectangular pole endpoint single-valued, added polar convergence filtering,
  and replaced the Moon color tiers with the checked 2025 derivative.
- M6: compiled the 5 m Site 01 source into a checked 10 m U16 runtime authority,
  retained its south-polar projection, and froze Earth and Moon authorities together
  at the VAB-to-flight boundary. SOI transitions remain synchronous selectors.
- M7: generated checked 512/1024/2048 HMI activity tiers and made the solar renderer
  accept them transactionally over a procedural no-hole fallback.
- M8: stabilized granulation, shared one occluder contract between disk and corona,
  added a bounded anisotropic corona and linear-region diagnostics, and ran targeted
  Medium browser references without runtime or shader errors.

The PGDA runtime grid is deliberately 10 m/pixel after deterministic 2x2 reduction;
the 5 m source, uncertainty, slope, and count products remain byte-locked authoring
provenance. The full Low/Medium/High visual matrix and M3 Max performance thresholds
are not represented as complete until run on the approved hardware.

## Goal

Finish the visual foundation for the Moon and Sun without reopening Earth work or
expanding into Artemis IV mission presentation.

The Moon should retain its recognizable NASA/LRO identity from Earth distance, lose
its current polar and transition artifacts, and gain one honest bounded region where
source height drives geometry and contact. The Sun should remain physically scaled and
angularly correct while gaining a pinned visible-photosphere source, believable
resolved structure, controlled glare, and correct eclipse behavior.

## Decision Summary

1. Complete the Moon before the Sun. The Moon is both a rendered body and the primary
   solar occluder, so its silhouette and presentation must be stable before final Sun
   and eclipse tuning.
2. Preserve the current global Moon pack and streaming architecture, but refresh its
   color source to the 2025 NASA CGI Moon Kit if a controlled comparison passes. Fix
   the polar/normal representation rather than hiding artifacts with blur or fill.
3. Promote one lunar region to source-backed geometry: NASA PGDA Site 01, Connecting
   Ridge, at the lunar south pole. It has an official 5 m/pixel LOLA DEM, published
   uncertainty products, and useful grazing-light relief. Other landing regions remain
   on the checked global parent.
4. Give the Sun a small source-backed asset pack based on a pinned SDO/HMI visible
   continuum observation. The observation supplies sunspot and broad photospheric
   structure only. Limb darkening, granulation, radiance hierarchy, corona, and glare
   remain analytic renderer responsibilities.
5. Keep the Sun as an angularly correct far-field disk for the Earth-Moon game slice.
   Do not introduce a physical 1 AU mesh or a false-color EUV globe.
6. No source product in this plan changes solar power, heating, gravity, illumination
   direction, or simulation time. Moon numeric authority may change contact only
   inside the explicitly frozen regional generation.

## Current State and Concrete Gaps

### Moon

Already present:

- Low, Medium, and High packs with `albedo`, `normal`, `material`, `heightMacro`, and
  `localDetail` channels.
- NASA CGI Moon Kit LROC color and LOLA global height inputs.
- Moon Trek WAC 303 ppd streamed visual pages and LOLA 128 ppd decoded height pages.
- Compact/global height displacement, near-terrain rendering, local regolith PBR,
  deterministic boulder/clast scatter, shadows, and exact body-fixed orientation.
- Reference stations for Earth view, near side, far side, pole, low orbit, and surface.

Observed gaps on the reviewed branch/reference artifacts:

- The compact Moon has severe speckled/radial artifacts near the poles. Equirectangular
  pole convergence and body-space oct-normal filtering are the leading code-level
  causes and must be proven independently.
- Low-orbit and polar views show detail-transition softness and visible source/normal
  disagreement instead of one continuous lunar surface.
- The `moon-surface` station is visually flat at the horizon because streamed LOLA is
  shading-only. It cannot honestly claim source-backed geometric relief.
- Surface scatter reads as isolated black flecks in some lighting rather than rocks
  embedded in regolith.
- The checked Moon color source is the older CGI Moon Kit path. NASA now publishes a
  2025 color product with greater dynamic range and improved polar detail; it needs a
  controlled source-lock and comparison rather than an in-place URL replacement.

### Sun

Already present:

- Correct physical radius, one-AU angular size, proxy depth/radius projection, and
  finite-disk occultation math.
- A procedural billboard photosphere with a restrained limb function and noise.
- A separate additive corona, directional solar light, shadow ownership, and shared
  exposure policy.

Missing or incomplete:

- `SolarBodyRenderer.stageAssets` rejects every runtime asset pack. There is no checked
  Sun source, manifest entry, generated tier, or runtime texture.
- The photosphere is a nearly featureless white dot at ordinary Earth framing and a
  simple noise disk when enlarged. It has no real sunspot or active-region identity.
- The current noise drifts with time instead of representing stable, footprint-filtered
  granulation.
- The corona is a uniform radial halo. It is not masked with the exact occluder shape,
  so eclipse presentation and physical light visibility are not owned by one contract.
- There is no explicit linear solar-region luminance diagnostic; tone-mapped screenshots
  alone cannot prove that disk detail, glare, and exposure are balanced.

## Scope

### Included

- Moon global color/source audit, pole repair, normal representation, and compact to
  terrain continuity.
- One bounded lunar south-pole geometric authority region with frozen source generation.
- Moon regolith material, scatter, lighting, and shadow calibration.
- A pinned Sun photosphere source lock and derived runtime texture tiers.
- Sun asset loading, source/procedural composition, stable granulation, limb darkening,
  corona, glare, exposure, and eclipse/occultation behavior.
- Updated Moon/Sun reference stations, diagnostics, focused automated coverage, and a
  final M3 Max Medium/High visual-performance comparison.
- Earth, Earth-Moon scale, and existing Sol gameplay as regression guards only.

### Explicitly deferred

- Artemis IV phases, mission UI, playback, narration, telemetry choreography, or
  directed mission cameras.
- Arbitrary high-resolution lunar landing terrain everywhere.
- Apollo landing-site props, flags, astronaut footprints, bases, rovers, or authored
  mission scenery.
- Live SDO downloads, time-varying solar weather, flares, CMEs, prominences, solar wind,
  or space-weather gameplay.
- A complete rotating 360-degree solar observation sphere. The active game slice stays
  near the Earth-Moon observer line.
- Earth visual changes, other planets, gameplay balance, save migration, or new UI.

## Source Locks

### Moon global identity

Identity-verified candidate, pending the M4 byte-level checksum, decoded-metadata,
and license lock:

- NASA SVS CGI Moon Kit 2025 color map, preferably the 16-bit sRGB 8K TIFF for the
  current authoring pipeline. Preserve the full-size linear EXR as a future option, not
  a runtime dependency.
- Existing CGI Moon Kit LOLA displacement remains the checked global parent unless a
  numeric audit proves a newer product is needed.
- Existing direct Moon Trek WAC and LOLA services remain the bounded visual/normal
  detail sources.

Required source-lock behavior:

- Pin product version, original URL, acquisition/release note, byte size, dimensions,
  checksum, color space, seam, axis convention, and NASA attribution.
- Never silently accept new bytes from the existing stable-looking URL.
- Compare 2019 and 2025 derivatives at near side, far side, both poles, seam, and
  terminator before selecting the replacement.
- Reject the 2025 source if it introduces baked lighting, a changed longitude
  convention, clipped blacks/highlights, or worse runtime compression behavior.

### Moon bounded geometry

Identity-verified candidate region, pending the M4 byte-level checksum,
decoded-metadata, reference-frame, and license lock:

- NASA Goddard PGDA Site 01, Connecting Ridge, south pole.
- Pin the 5 m/pixel `LDEM` GeoTIFF plus count, total-height-uncertainty, slope, and
  slope-uncertainty companions needed to distinguish source support from interpolation.
- Treat the product as a controlled surface model in the MOON_ME/DE421 reference frame,
  not as direct measurement at every pixel. The published product notes substantial
  interpolation, so diagnostics and claims must retain the uncertainty metadata.

The regional compiler must reproject once into the engine's checked Moon frame, retain
a parent overlap band, emit a content digest, and package runtime-ready numeric tiles.
No gameplay flight may contact the source until the complete region has been validated
and frozen.

### Sun photosphere

Identity-verified candidate source, pending the M4 byte-level checksum,
decoded-metadata, observation-orientation, and license lock:

- A pinned NASA SDO/HMI continuum image. Start with the December 6, 2010 full-disk HMI
  visible-photosphere image published by NASA SVS because it is high resolution,
  permanently identified, and not a mutable `latest` endpoint.

Authoring transformation:

1. Detect and crop the calibrated solar disk without resampling its center.
2. Preserve the observation timestamp and observer orientation in provenance.
3. Fit and remove only the broad radial limb baseline from a linearized luminance copy.
4. Encode a bounded signed activity residual around neutral gray. Dark values represent
   sunspots; modest bright values represent resolved facular/broad structure.
5. Reject pixels outside the measured disk and generate edge-safe mip levels.
6. Emit a single-channel `photosphereActivity` texture. It modulates the analytic
   photosphere; it never becomes emitted RGB color or solar energy authority.

Do not use SDO/AIA EUV imagery as the visible photosphere. It is valuable science data
but would give this natural-light renderer a false-color identity.

## Milestone Sequence

## M4 — Freeze the Moon/Sun Baseline and Source Contracts

### Work

- Add integration-branch captures rather than relying only on artifacts from the
  earlier feature worktree.
- Record current Moon pole/seam defects, transition behavior, surface scatter, Sun disk,
  corona, and partial occultation at Low, Medium, and High.
- Add a resolved `sun-zoomed-disk` station while retaining `sun-from-earth` as the
  physical framing authority.
- Add `moon-south-pole-orbit`, `moon-site01-10km`, `moon-site01-1km`, and
  `moon-site01-surface` stations. The last three may use the parent surface until M6.
- Lock and probe the candidate 2025 Moon color and HMI continuum sources without yet
  changing production packs.
- Add source comparison scripts that are deterministic and network-free after the
  original bytes are cached.

### Likely files

- Modify: `src/proto/solVisualReferenceStations.ts`
- Modify: `e2e/sol-visual-reference.spec.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Create: `assets/planets/sources/nasa-lro-moon-2025/source.lock.json`
- Create: `assets/planets/sources/nasa-pgda-moon-site01/source.lock.json`
- Create: `assets/planets/sources/nasa-sdo-hmi-photosphere/source.lock.json`
- Create: `scripts/probe-moon-sun-sources.mjs`
- Create: `docs/performance/reference/moon-sun-baseline-2026-07.md`

### Gate

- Every source has immutable identity and verified decoded metadata.
- The reference harness reproduces each observed defect from `b04a789` without runtime
  errors or hidden camera changes.
- Source downloads remain authoring-only; no new runtime fetch endpoint is introduced.

## M5 — Repair the Global Moon and Its Scale Transitions

### Work

- Compare the 2025 CGI Moon Kit color derivative to the current 2019-derived pack and
  adopt it only if the visual/source gate passes.
- After M4 reproduces and isolates the root cause, select a fold-free Moon normal
  representation. A seam-safe tangent-slope encoding reconstructed from the radial
  basis is the leading candidate, not a predetermined remedy.
- If the reproduced defect proves that equirectangular pole convergence is creating
  multiple physical heights at one pole, make each polar height sample single-valued
  before vertex displacement. Do not alter the source pole rows merely because this
  diagnosis is plausible.
- Generate latitude-aware mips for height/slope inputs and validate seam wrapping.
- Ensure compact geometry, resident normal detail, streamed WAC color, streamed LOLA
  normals, and terrain geometry fade as one surface. The parent remains fully valid
  until all replacement pages are ready.
- Calibrate lunar albedo in linear light. Remove the current warm/brown presentation if
  the source comparison shows it is a renderer grade rather than source identity.
- Retune local-detail strength by projected texel footprint so regolith detail appears
  near ground without tiling in orbit.

### Likely files

- Modify: `scripts/lib/airless-global-maps.ts`
- Modify: `scripts/compile-planet-assets.ts`
- Modify: `src/render/airless/globalMaterial.ts`
- Modify: `src/render/airless/surfaceMaterial.ts`
- Modify: `src/render/planetDetail/detailWorker.ts`
- Modify: `src/render/planetDetail/detailColorTransform.ts`
- Modify: `src/render/planetDetail/terrainDetailMaterial.ts`
- Modify generated Moon packs and `src/generated/checked-planet-manifest.json`

### Focused proof

- Pole rows are invariant across longitude after decode and after every mip level.
- Longitude seam slopes and normals agree within quantization tolerance.
- Near-side/far-side landmarks retain correct handedness and phase.
- `moon-near-full`, `moon-far-full`, and `moon-polar` contain no radial sparkles,
  black wedges, pinched silhouette, or mip-dependent seam.
- `moon-low-orbit` shows no square page boundary, double normal, or color-temperature
  jump during compact/terrain handoff.

## M6 — Promote One Honest Lunar Surface Region

### Work

- Extend `PlanetDataAuthority` from one launch-only Earth authority to a flight-wide
  frozen authority map. The VAB-to-flight boundary is the concrete asynchronous gate:
  after validation and before any vessel is spawned, prepare Earth and Moon authority
  together. Freeze either the complete Site 01 generation or the complete lunar global
  parent for the entire flight.
- `GameState` owns this flight authority map and `WorldScene` installs/rebuilds render
  state from the same frozen generations before flight begins. Both integrated-flight
  and rails SOI transitions in `src/sim/state.ts` only select an already-frozen body
  authority; neither path fetches, awaits, promotes, or relies on a UI timer.
- A failed, missing, corrupt, or over-budget lunar region freezes the parent and reports
  the reason. It must not promote later during the same flight.
- Make contact, terrain vertices, generated normals, slope, scatter placement, and
  shadow receivers consume the same frozen lunar generation.
- Blend regional numeric height into the global parent only inside the compiled overlap
  band and within one declared datum/frame.
- Move the reference surface stations to the real selected region and replace the
  shading-only claim with source-backed geometry only after numeric agreement passes.
- Retune boulder/clast density, scale, embed depth, albedo, and shadow bias against the
  new surface. Scatter should act as a scale cue, not visual noise.

### Likely files

- Modify: `src/sim/planetDataAuthority.ts`
- Modify: `src/sim/sourceHeightAuthority.ts`
- Modify: `src/sim/terrainRecipe.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/game.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/render/airlessBodyRenderer.ts`
- Modify: `src/render/terrain/surfaceProvider.ts`
- Modify: `src/render/terrain/chunkWorker.ts`
- Modify: `src/render/terrain/chunkWorkerPool.ts`
- Modify: `src/render/terrestrial/scatter.ts`
- Create: `tests/lunar-region-authority.test.ts`
- Create: `tests/lunar-contact-generation.test.ts`

### Gate

- Regional source samples match the compiled oracle within declared source uncertainty
  and final quantization tolerance.
- Contact and rendered mesh agree at random interior points, tile edges, overlap edges,
  and station/craft placement points.
- Rebuilds, quality changes, SOI transitions, revert, and cache fills cannot change the
  frozen lunar authority generation.
- Surface captures show real silhouette/occlusion relief, long stable shadows, embedded
  scatter, and no floating or buried craft.
- Outside Site 01, diagnostics and claims continue to identify the global parent.

## M7 — Add the Source-Backed Sun Photosphere

### Work

- Add Sun source and pack semantics to the asset compiler and checked manifest.
- Generate `photosphereActivity` at 512, 1024, and 2048 pixels for Low, Medium, and
  High. Re-measure before finalizing sizes; the channel should remain small enough to
  load with the Sol visual foundation.
- Allow `SolarBodyRenderer` to stage a Sun pack transactionally while retaining the
  procedural disk as the no-hole fallback.
- Compose the source activity residual with an analytic visible-light limb function and
  band-limited procedural granulation.
- Replace time-scrolling value noise with stable surface detail. Temporal evolution is
  out of scope; no boiling or sliding texture is preferable to fake dynamics.
- Use texture derivatives/mips and projected solar radius so structure disappears
  cleanly below resolvable scale instead of aliasing.
- Keep the disk near-white in linear rendering, with only a restrained warm perceptual
  grade after tone mapping.
- Record the observation timestamp and expose it in diagnostics, not player UI.

### Likely files

- Modify: `scripts/compile-planet-assets.ts`
- Modify: `src/render/solarBodyRenderer.ts`
- Modify: `src/render/solar/photosphereMaterial.ts`
- Modify: `src/render/bodyRenderer.ts`
- Modify: `src/render/bodyRendererManager.ts`
- Modify: `src/generated/checked-planet-manifest.json`
- Add generated Sun runtime packs under `public/planets/generated/sun/`
- Modify: `tests/solar-body-renderer.test.ts`
- Create: `tests/solar-asset-pack.test.ts`

### Gate

- `sun-from-earth` preserves the physical angular diameter within the existing 0.5%
  tolerance and reads first as a luminous solar disk, not a textured orange planet.
- `sun-zoomed-disk` shows recognizable but restrained sunspot structure, correct limb
  falloff, stable granulation, and no circular crop edge.
- Source load failure or tier replacement never flashes, changes apparent size, or
  affects lighting authority.
- Low/Medium/High converge to the same broad solar identity without high-tier aliasing.

## M8 — Unify Eclipse, Corona, Exposure, and Final Acceptance

### Work

- Apply the same analytic occluder geometry to photosphere detail, disk emission, and
  the inner corona. Corona outside the occulting body may remain visible; no unmasked
  glow may leak through the body silhouette.
- Keep post/presentation glare separate from the geometric disk so bloom cannot enlarge
  eclipse contacts or alter the angular-size diagnostic.
- Replace the uniform corona with a restrained analytic anisotropic profile whose
  amplitude falls with projected size and exposure. Do not import EUV color.
- Add a solar-region linear luminance readback using a disk ROI/max statistic rather
  than whole-frame percentiles. Restore render target, viewport, scissor, and color
  state after diagnostics.
- Verify exposure adaptation across Sun in frame, partial eclipse, total occultation,
  lunar day surface, lunar night horizon, and return to Earth.
- Run the Moon/Sun matrix on the approved M3 Max after all visual work is integrated.

### Likely files

- Modify: `src/render/solar/photosphereMaterial.ts`
- Modify: `src/render/solar/coronaMaterial.ts`
- Modify: `src/render/solarBodyRenderer.ts`
- Modify: `src/render/celestialOcclusion.ts`
- Modify: `src/render/exposurePolicy.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `e2e/sol-visual-reference.spec.ts`
- Create: `tests/solar-corona-occlusion.test.ts`
- Create: `docs/performance/reference/moon-sun-final-2026-07.md`

### Final visual matrix

Moon:

- `moon-from-earth`
- `moon-near-full`
- `moon-far-full`
- `moon-polar`
- `moon-low-orbit`
- `moon-south-pole-orbit`
- `moon-site01-10km`
- `moon-site01-1km`
- `moon-site01-surface`
- selected terminator and compact/terrain transition journeys

Sun and joint scale:

- `sun-from-earth`
- `sun-zoomed-disk`
- `sun-partial-occultation`
- total lunar occultation with contact frames
- `earth-moon-true-scale`
- Moon surface with Sun in frame and out of frame

### Final gates

- No runtime/shader errors, black frames, source retry loops, unresolved terrain holes,
  or stale authority generations.
- Moon poles, seam, silhouette, and compact/terrain transition remain continuous under
  at least two sun directions and slow camera motion.
- The selected lunar region is the only new source-geometric claim, and diagnostics
  distinguish it from shading-only/global-parent coverage.
- The Sun remains angularly correct, near-white, structured when resolvable, and stable
  when subpixel.
- Eclipse contacts use the physical disk. Photosphere texture, corona, and glare do not
  enlarge or move the silhouette.
- Medium steady p50 regression above 1 ms, an unexplained p95 increase, a main-thread
  task over 50 ms, or any tier resource-ceiling overrun stops completion.
- Repeat Earth to Moon to Earth active-body cycles and Sun pack tier transactions
  without retained GPU resources, duplicate lights, or authority/cache leakage.
- Earth visual captures remain regression-clean. No Earth retuning is accepted as part
  of this plan.

## Recommended Implementation Order

1. M4 baseline and source locks.
2. M5 global Moon repair and visual approval.
3. M6 bounded lunar geometry and surface approval.
4. M7 source-backed Sun disk.
5. M8 eclipse/exposure integration and final hardware gate.

Do not combine M5 and M6 into one change. The global Moon artifacts are renderer/asset
representation defects, while M6 changes deterministic contact authority. Keeping them
separate makes review and rollback honest.

## Definition of Done

This follow-on is complete only when:

1. The Moon has no visible polar/seam artifacts at global scale.
2. Global, streamed, and terrain presentations read as one Moon across their handoffs.
3. Site 01 has one frozen source-backed geometry/contact generation with explicit
   fallback and uncertainty provenance.
4. The Sun uses a checked HMI-derived activity texture without becoming false-color,
   noisy, or physically authoritative.
5. Disk, corona, glare, light visibility, and occultation share one geometric contract.
6. The complete Moon/Sun reference matrix passes its numeric, visual, lifecycle, and
   M3 Max performance gates.
7. Artemis IV presentation and unrelated gameplay remain deferred.

## Primary Sources

- NASA SVS CGI Moon Kit: https://svs.gsfc.nasa.gov/4720/
- NASA Moon Trek API: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon
- NASA PGDA high-resolution LOLA south-pole sites:
  https://pgda.gsfc.nasa.gov/products/78
- NASA PGDA Site 01 and companion products:
  https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/
- NASA SDO HMI/AIA channel definitions:
  https://sdo.gsfc.nasa.gov/data/channels.php
- NASA SVS pinned HMI visible-photosphere image set:
  https://svs.gsfc.nasa.gov/4269/
