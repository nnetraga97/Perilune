# Natural Earth II 3.2.0 source terms

Source: [Natural Earth II raster data](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-2/)

Natural Earth states that all versions of its raster and vector map data are
in the public domain. The terms are published at
https://www.naturalearthdata.com/about/terms-of-use/.

Perilune uses the original `NE2_LR_LC.zip` archive only as an authoring input.
The archive and extracted TIFF are not committed or shipped. Generated Veyra
assets are modified through body-fixed reprojection, deterministic geographic
warping and recoloring, terrain-authority-derived ocean/material masks and
normals, deterministic cloud synthesis, Lanczos3 tier resampling, and runtime
texture encoding.
