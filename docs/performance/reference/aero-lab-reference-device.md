# Aerodynamics Lab reference device

Aerodynamics Lab performance checks use the repository's existing reference profile:

- MacBook Pro `Mac15,10`
- Apple M3 Max, 30 GPU cores
- 36 GB unified memory
- Stable headed Google Chrome with hardware WebGL2
- 1920 × 1080 drawing buffer
- AC power, `powermode 0`, automatic thermal management

Record the exact macOS and Chrome builds with every result. Run the production build before profiling and use the medium-flow preset with the representative small, medium, and large craft set. Host observations must use the repository's sanitized host-observation tooling; never store serial numbers or device identifiers.

## 2026-07-30 smoke result

- macOS 26.5.2 (25F84)
- Google Chrome 150.0.7871.187
- AC power, `powermode 0`
- Wayfarer Heavy Demonstrator, medium flow: 34 ms worker preparation in the browser
- Lazy UI chunk: 18.43 kB minified / 6.43 kB gzip
- Lazy analysis worker: 143.08 kB minified

This is a smoke measurement, not the multi-run certification set.
