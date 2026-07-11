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
