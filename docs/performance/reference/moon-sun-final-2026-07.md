# Moon and Sun Implementation Verification — July 2026

## Reproducibility

- Source probe: all seven locked files reproduced their byte length, SHA-256 digest,
  decoded dimensions, and expected raster type.
- Deterministic container compiler: passed content validation with 29 sources and 14
  body/tier packs.
- Site 01 runtime authority: 1600 x 1600 U16, 10 m/pixel, 5,120,000 bytes,
  SHA-256 `ae96e29314fc50642b61fd07e45bb5f74ccdb1750b235ee4dde241d19fc04909`.
- Production build and focused unit suites passed.

## Medium browser references

The following stations completed in Chrome/SwiftShader without page, console, shader,
asset, or authority errors:

- `sun-zoomed-disk`
- `sun-partial-occultation`
- `moon-polar`
- `moon-south-pole-orbit`
- `moon-site01-surface`

The Site 01 sidecar identified `nasa-pgda-lola-site01-5m` in `promoted-region` mode and
the exact checked content generation. The Sun sidecar identified the Medium authored
pack and the scene-linear disk/corona diagnostic values.

SwiftShader frame times are diagnostic-only and are not a substitute for the approved
M3 Max gate. Low/High captures, repeated Earth-Moon-Earth residency cycles, and the
hardware p50/p95 thresholds remain release acceptance work.
