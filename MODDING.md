# Modding (design; ships M3+)

Perilune's content is data-driven from day one (see CONTENT_PIPELINE.md).
The modding surface will expose exactly those record types:

- Parts, engines, resources, experiments, celestial bodies, difficulty
  profiles, missions — as versioned JSON5 documents.
- Schema validation with actionable error messages; a mod that fails
  validation is skipped, never half-loaded.
- No arbitrary code execution from content packages. Scripted behavior is
  limited to the sandboxed flight computer (M4) with instruction budgets
  and no DOM/network access.
- Craft files, mission files, and script files are import/exportable as
  local files; campaigns declare the mods they depend on.

## Atmospheric-entry palettes

Renderer-owned body definitions may provide an `entryVisual` record in
`src/content/bodyVisuals.ts`. It controls glow, hot-glow, three trail colors,
streak, wrap-layer and shockwave colors plus bounded strength, length, opacity,
glow, streak-probability and particle-threshold values. Bodies with a physical
atmosphere but no override use `DEFAULT_ENTRY_VISUAL`; airless bodies never
activate the effect. These values are art direction only and cannot change
heating, drag, ablator use, or destruction.

The current TypeScript registry validates this surface at test time. When the
planned JSON5 mod loader ships, the same bounds must be enforced at the content
boundary and an invalid palette must fall back atomically to the default.
