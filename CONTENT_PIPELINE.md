# Content Pipeline

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
