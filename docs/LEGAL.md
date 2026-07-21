# Legal and attribution

## Perilune

Copyright © 2026 the Perilune authors. The repository has no selected public
software license yet; choose one before a public release.

Perilune's original game systems, writing, original fictional setting, and
procedural rendering code are created for this project. The game uses standard
aerospace and graphics methods implemented independently. It is inspired by
the orbital-sandbox genre and does not include assets, names, code, text, or
trademarks from Kerbal Space Program or its mods.

## Software

- Three.js (MIT) is the runtime renderer.
- TypeScript, Vite, Vitest, fast-check, tsx, and the Three type definitions are
  MIT licensed.
- Playwright and Sharp are Apache-2.0; Sharp's development-only libvips
  components include LGPL-2.1-or-later material.
- KTX-Software 4.4.2 is Apache-2.0 and used during asset compilation.

## Source material

- Natural Earth II 3.2.0 is a public-domain authoring input for the Veyra
  albedo. Perilune transforms it into derived visual assets; it does not supply
  collision-height authority. Its source terms are retained at
  `assets/planets/sources/natural-earth-ii-3.2.0/TERMS.md`.
- Selected NASA 3D resources are modified for optional part models: Orion,
  Viking Lander, TDRS-C, Mars 2020 wheel, Apollo Lunar Module, Space Shuttle
  engine, and Space Shuttle External Tank. Source URLs and transformation
  records remain in the content manifest.
- The atmospheric-entry renderer is original. Leah Lindner's *Atmospheric
  Entry* paper and NASA reentry imagery informed visual research; Firefly is
  acknowledged as prior art only—no code, shaders, textures, or configuration
  were copied.

Every new third-party asset must have a recorded source URL, license, checksum,
and transformation record before it is shipped. Run `npm run validate:content`
after changing content or asset metadata.
