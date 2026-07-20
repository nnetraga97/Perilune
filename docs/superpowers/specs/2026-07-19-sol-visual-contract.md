# Sol Visual and Scale Acceptance Contract

**Authority:** `docs/superpowers/plans/2026-07-19-sol-earth-moon-visuals-and-scale.md`
**Scope:** Sun, Earth, and Moon visuals and physical scale only. Gameplay and Artemis IV presentation remain deferred.

## Non-negotiable scale rules

- One simulation unit is one metre. Body radii, orbit distances, atmosphere height, terrain relief, and Earth-Moon spacing are never independently rescaled for framing.
- Simulation positions and apparent-size calculations remain f64 until the final camera-relative conversion for Three.js.
- Apparent radius is `asin(radius / observerDistance)`. For a projected diameter above 16 drawing-buffer pixels, error must be at most 0.5%; below that threshold it must be at most 0.5 pixel.
- The Sun may use a safe-depth proxy, but its proxy radius is derived from the true angular radius. Glare and corona do not participate in scale or occultation measurements.
- The physical camera envelope must contain lunar apogee, body radius, and framing margin without moving the far plane to one AU.

## Coordinate and identity rules

- Runtime spherical UV is east-positive longitude, seam at 180 degrees, north at `v=0`, south at `v=1`, and no material-specific corrective half-turn.
- Africa and the Atlantic must occupy their expected Earth-fixed directions. The lunar near-side maria, far-side highlands, poles, and seam must agree between albedo, height, normals, compact geometry, and terrain.
- Fallback images and KTX2 products use the same top-left source convention. Browser texture loading must not invert north and south.
- Source macro height and deterministic local relief are the single render/contact authority. Shading PBR maps never displace collision geometry.

## Visual rules

- Earth uses restrained natural color, a narrow orbital limb, continuous descent sky/aerial perspective, distinct sourced clouds, reflective rather than opaque-blue ocean, and geographically bounded night emission.
- The Moon remains dark, rough, atmosphere-free, and primarily readable through direct solar illumination and grazing shadows.
- The Sun presents a stable photospheric disk with limb darkening and filtered structure. Glare stays subordinate to the disk; corona is outside the limb.
- Compact/terrain, atmosphere-top, and cloud-layer crossings may not expose holes, square boundaries, double rims, flashes, or a luminance discontinuity lasting longer than one frame at a fixed station.
- Reference captures use deterministic exposure. Sidecars record exposure, frame-time percentiles, resource allocations, transition state, and post-tone-map luminance/clipping. Pre-tone-map readback remains a required follow-up if the renderer gains an HDR composition target; the current forward canvas does not expose a truthful linear framebuffer readback.

## Source references and comparison crops

| Subject | Authority | Comparison use | Crop/lighting note |
| --- | --- | --- | --- |
| Earth daylight | [NASA Blue Marble Next Generation July 2004](https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg) | continent color and coastline identity | Africa/Atlantic, source-native equirectangular crop |
| Earth clouds | [NASA Visible Earth separate cloud composite](https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif) | synoptic macro structure | alpha/optical field only; never baked into land |
| Earth night | [NASA Black Marble 2016](https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km_geo.tif) | city-light geography | compare only on the night side under similar phase |
| Earth relief | [NOAA ETOPO 2022 surface](https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif) | shoreline and macro elevation | datum-resampled, not visually exaggerated |
| Moon | [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) | LROC color and LOLA relief | near side, far side, south-polar and grazing-light crops |
| Sun | [NASA Sun facts](https://science.nasa.gov/sun/facts/) | white-light silhouette and scale | perceptual white-light grade, not false-color EUV |

Exact downloaded URLs, checksums, transformations, and licenses are checked in `assets/planets/sol-source-lock.json`, `assets/planets/local-material-source-lock.json`, and the generated manifest.

## Reference matrix

`src/proto/solVisualReferenceStations.ts` is the station authority. `e2e/sol-visual-reference.spec.ts` captures Medium and High PNGs and JSON sidecars. Raw images remain ignored; reviewed metadata and audit results are committed under `docs/performance/reference`.

Required reviews include: Sun at Earth distance; partial occultation; true-scale Earth-Moon framing; Earth day, terminator, night, limb, orbit, descent, ground, and ocean; Moon Earth-view size, near/far side, pole, orbit, and surface; and every relevant presentation transition.

## Explicit deferrals

Artemis IV playback/UI, spacecraft and launch-site fidelity, craft balance, mission/campaign/progression migration, live weather/ephemerides, runtime oblate Earth, survey-grade local terrain, and other Solar System bodies are outside this contract.
