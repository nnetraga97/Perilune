# Moon and Sun Visual Baseline — July 2026

This baseline is tied to integration commit `b04a789` and the deterministic stations in
`src/proto/solVisualReferenceStations.ts`. Source files are accepted only when
`node scripts/probe-moon-sun-sources.mjs` reproduces their checked byte length,
SHA-256 digest, and decoded dimensions.

## Recorded defects

- Moon compact rendering: polar speckle/rays and longitudinal disagreement at the
  equirectangular pole rows; softened compact-to-terrain transition in low orbit.
- Moon surface: streamed LOLA contributes shading but not contact geometry; sparse
  scatter can silhouette as black flecks.
- Sun physical framing: correct angular disk, but no observed activity identity.
- Sun enlarged framing: time-scrolling procedural noise, featureless broad disk, and a
  corona whose mask does not share the photosphere occluder contract.

## Acceptance stations

- Global Moon: `moon-from-earth`, `moon-near-full`, `moon-far-full`,
  `moon-south-pole-orbit`, and `moon-low-orbit`.
- Site 01: `moon-site01-10km`, `moon-site01-1km`, and `moon-site01-surface`.
- Sun: `sun-from-earth`, `sun-zoomed-disk`, and `sun-partial-occultation`.

Low, Medium, and High must retain the same source identity. Resolution and secondary
detail may change; feature location, source generation, occultation geometry, and
terrain contact authority may not.
