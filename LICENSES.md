# Licenses

## Perilune itself

Copyright © 2026 the Perilune authors. All rights reserved.
(License to be selected before public release; all code and content in
this repository is original work created for this project.)

## Runtime dependencies

| Package | License | Use |
|---|---|---|
| three | MIT | Rendering engine |

## Development dependencies

| Package | License | Use |
|---|---|---|
| typescript | Apache-2.0 | Language/typechecking |
| vite | MIT | Build system/dev server |
| vitest | MIT | Unit/property tests + benchmarks |
| @playwright/test | Apache-2.0 | Browser e2e tests |
| fast-check | MIT | Property-based testing |
| @types/node | MIT | Node compiler-script type definitions |
| @types/three | MIT | Type definitions |
| tsx | MIT | Execute the TypeScript planet compiler |
| sharp | Apache-2.0 | Pinned build-time image decode, color conversion, and resampling |
| KTX-Software 4.4.2 | Apache-2.0 | Pinned build-time KTX2/Basis Universal encoding |

Sharp distributes libvips components under LGPL-2.1-or-later; it is a
development-only compiler dependency and is not shipped in the browser bundle.

Veyra's generated textures use Natural Earth II 3.2.0 as a public-domain
authoring source. Natural Earth's public-domain terms and the exact local
source boundary are recorded in
`assets/planets/sources/natural-earth-ii-3.2.0/TERMS.md`. Any future planet
source must pass the per-file provenance and license policy in
`CONTENT_PIPELINE.md`; a repository software license is not accepted as
evidence that bundled third-party textures are reusable.
