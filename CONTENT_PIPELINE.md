# Content Pipeline

Planet content has two authorities:

- `src/content/system.ts` assigns explicit body kinds and terrain-recipe
  versions.
- `src/sim/terrainRecipe.ts` constructs immutable, content-addressed recipes;
  `src/sim/terrain.ts` is the only collision-scale height API.

Checked metadata lives under `assets/planets/`. `recipes.json` records the
runtime recipe hashes, `manifest.json` records compiler pins, provenance,
formats, and budgets, and `compiler-output.json` records deterministic raw
height fingerprints. Run:

```bash
npm run validate:content
npm run compile:planet-assets
```

To intentionally refresh compiler fingerprints after a reviewed recipe
change, run `npm run compile:planet-assets -- --write`, inspect the diff, and
commit the recipe and output together. Production builds never download
authoring sources; `prebuild` runs both checks against local declared files.

Every declared runtime channel must include a KTX2 package and its specified
fallback file. Validation derives the complete mip-chain allocation from the
declared dimensions and GPU block format, compares it with the manifest, sums
the actual package file sizes, and enforces per-tier active-body, transient,
and total-renderer ceilings. Budget declarations therefore cannot hide a
larger artifact or omit the files the runtime needs.

Third-party planet sources are admitted only through manifest records with an
exact source URL, author, license URL, attribution, SHA-256 checksum,
transformations, bodies, and channels. Accepted identifiers are CC0-1.0,
Public-Domain, and CC-BY-4.0. NASA/JPL records require the additional case
review fields enforced by the validator. SA, NC, ND, unknown, and ambiguous
licenses fail validation.

## Runtime Content

All content is data-driven TypeScript modules under `src/content/`:

- `system.ts` — celestial bodies (BodyDef): orbits, atmospheres, terrain
  parameters (seed/amplitude/palette), science multipliers, lore text.
- `parts.ts` — PartDef records: mass, cost, shapes (procedural geometry),
  attachment rules, resources, module behaviors (engine/tank/pod/…).
- `science.ts` — ExperimentDef records with valid situations and values.

Adding a part or body = adding one record; geometry, physics, UI cards,
and science hooks derive automatically. Validation lives in tests
(`vessel.test.ts` checks every part for sane data).

Planned (M3+, see MODDING.md): externalized JSON5 definitions with schema
validation and safe loading for user content — the record shapes above are
already serialization-friendly by design.
