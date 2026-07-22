# Artemis IV mission models

`models/martiandays-spacex-starship-2019.glb` is the exact GLB downloaded from
Sketchfab on 2026-07-21. Its SHA-256 must remain
`287317f26516237ed154b9364914396d562552d330a3041000f6157f97c9304c`.

The asset does not pass through the stock part compiler or any optimization,
texture conversion, geometry edit, or material rewrite. The renderer may apply
only the scene-graph transform recorded in `manifest.json`; that transform
centers the model, converts its source scale to metres, and points its nose along
Perilune's `+Y` craft axis without changing the GLB.

This 2019 model is a generic Starship concept, not Starship HLS. It may appear in
the Artemis IV tutorial with the manifest's stand-in label and provider disclaimer,
or in the Workshop's display-only built-in craft entry with visible author/license
attribution and a non-flight-ready label. Provenance, license, attribution, and
accuracy limits are locked in `source-lock.json`.
