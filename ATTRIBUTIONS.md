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
  encoding. The original archive and extracted TIFF are not shipped.
