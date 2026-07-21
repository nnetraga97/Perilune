# Attributions

## Third-party software

- **Three.js** (MIT) — 3D rendering engine. https://threejs.org
- **Vite, Vitest, TypeScript, Playwright, fast-check** — development
  toolchain (see LICENSES.md).

## Original content statement

Perilune's title, star system (Auren, Veyra, Palla, Wisp, Ashen, Vess,
Rusk, Tyran, Brimm, Glacia, Mote, Farfall), species (Vellans), agency
(Skyward Cooperative), all 44 part designs and names, all writing, and all
procedural art/texturing code are original to this project. The game is
inspired by the orbital-sandbox *genre* but contains no assets, names,
code, text, or trademarks from any existing game. No content was copied
from Kerbal Space Program or its mods.

## Algorithm provenance (public-domain mathematics)

Standard aerospace/graphics mathematics implemented from first principles:
Kepler's equation solvers, universal-variable propagation with Stumpff
functions, patched conics, sphere-of-influence formula, quadtree LOD,
gradient-noise fBm, PD attitude control. These are textbook methods
(Vallado, "Fundamentals of Astrodynamics and Applications" et al.) and the
implementations here are original code.

## Atmospheric-entry visual reference

Perilune's atmospheric-entry renderer is an original WebGL2 implementation
informed by Leah Lindner's published *Atmospheric Entry* graphics paper:
https://leah-lindner.com/blog/atmospheric-entry/

The Firefly KSP mod is acknowledged as prior art and a visual/architectural
inspiration. No Firefly code, shader text, numeric configuration, textures, or
other assets are included or translated. Perilune uses independently authored
procedural geometry, shaders, palettes, and particles.

NASA reentry imagery and descriptions informed the original Veyra palette:
https://www.nasa.gov/humans-in-space/heat-shield-testing-recycles-waste-on-earth/
and https://www.nasa.gov/news-release/video-gives-astronauts-eye-view-inside-nasas-orion-spacecraft-2/

## Planet source assets

- **Natural Earth II 3.2.0** — original public-domain 1:10m land-cover raster
  by Natural Earth. Source: https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-2/
  Terms: https://www.naturalearthdata.com/about/terms-of-use/

  Used as an authoring input for Veyra's albedo geography. Perilune modifies it
  through body-fixed reprojection, deterministic geographic warping and
  recoloring, terrain-derived shoreline/material masks and oct normals,
  deterministic cloud synthesis, Lanczos3 resampling, and KTX2/WebP/PNG
  encoding. The original archive and extracted TIFF are not shipped. The
  archive SHA-256 is pinned in the content manifest; the fetch tool verifies it
  and atomically re-derives the TIFF on every explicit authoring-source fetch.
  The shipped canonical height field is derived solely from Perilune's original
  procedural `solidHeight` terrain; Natural Earth contributes visual albedo
  detail only and is not collision-height authority.

## NASA part model source assets

- **Orion Capsule** — NASA source geometry for the pod and visual reference for Perilune's custom closed forward-bay housing; modified by Perilune. https://science.nasa.gov/3d-resources/orion-capsule/
- **Viking Lander leg** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/viking-lander-2/
- **Viking Lander foot** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/viking-lander-2/
- **TDRS-C left antenna** — NASA/Ames Research Center source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/tracking-and-data-relay-satellites-tdrs-c/
- **Mars 2020 five-inch wheel** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/mars-2020-5-inch-wheel/
- **Apollo Lunar Module** — NASA/Michael D. Carbajal source geometry; central descent-engine bell isolated and modified by Perilune. https://science.nasa.gov/3d-resources/apollo-lunar-module/
- **Space Shuttle (D) engine** — NASA/Johnson Space Center source geometry; modified and arranged as an unmarked three-engine assembly by Perilune. https://science.nasa.gov/3d-resources/space-shuttle-d/
- **Space Shuttle External Tank** — NASA/Johnson Space Center source geometry; straight barrel, feedline, seam, and bracket geometry cropped and modified by Perilune. https://science.nasa.gov/3d-resources/space-shuttle-parts/

## Artemis IV mission model

- **SpaceX Starship** — model by MartianDays, downloaded from Sketchfab and
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Source: https://sketchfab.com/3d-models/spacex-starship-a8a0b69f776841a1a465cd9fb3762fd2

  The downloaded GLB is redistributed unmodified. Perilune applies only a
  runtime scene transform for scale, centering, and craft-axis alignment. It is
  a 2019 generic Starship concept used as a visual stand-in, not an accurate
  Starship HLS model. No endorsement by SpaceX, NASA, Sketchfab, or the artist
  is implied. Exact provenance and checksum are recorded in
  `assets/missions/artemis-iv/source-lock.json`.
