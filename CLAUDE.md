# CLAUDE.md

## Repository Overview

Perilune is a browser-based orbital-engineering game. The simulation and UI are written in strict TypeScript, rendered with Three.js/WebGL2, bundled by Vite, tested with Vitest, and exercised in Chromium with Playwright.

## Commands

- `npm install` — install the locked Node dependencies.
- `npm run dev` — run the Vite development server.
- `npm test` — run the full Vitest unit and integration suite.
- `npm run build` — run strict TypeScript checking and produce `dist/`.
- `npm run test:e2e` — run Playwright browser journeys.
- `npm run bench` — run simulation benchmarks.
- `npm run validate:content` — validate planet recipes, compiler pins, source provenance, packaged files, and transfer/GPU memory budgets.
- `npm run compile:planet-assets` — verify deterministic terrain fingerprints; add `-- --write` only for an intentional reviewed refresh.

## Architecture

- `src/sim/` owns deterministic gameplay and planning logic. Keep it independent of DOM and renderer state.
- `src/render/` owns Three.js scenes and body/vessel visuals.
- `src/ui/` owns browser controls and presentation.
- `src/save/` owns versioned schemas, migration, and transactional persistence.
- `src/content/` owns celestial-body and part definitions.
- `tests/` contains deterministic simulation and mission tests; `e2e/` contains browser tests.

Use test-first development for simulation changes. Rendering may consume simulation authority but must not redefine collision height or other gameplay state.

## Current Work

The interrupted M2 planning baseline has been restored: transfer windows, mission alarms with warp interlock and save persistence, and pure atmospheric-entry prediction are implemented. The approved planet-graphics redesign is specified in `docs/superpowers/specs/2026-07-10-planet-graphics-design.md` and is being delivered in its numbered sequence.
