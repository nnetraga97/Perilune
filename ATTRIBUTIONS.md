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

- **Orion Capsule** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/orion-capsule/
- **Viking Lander leg** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/viking-lander-2/
- **Viking Lander foot** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/viking-lander-2/
- **TDRS-C left antenna** — NASA/Ames Research Center source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/tracking-and-data-relay-satellites-tdrs-c/
- **Mars 2020 five-inch wheel** — NASA source geometry; modified by Perilune. https://science.nasa.gov/3d-resources/mars-2020-5-inch-wheel/
