# Perilune

An original browser-based orbital engineering game by the Skyward
Cooperative: build spacecraft, fly them with credible physics, reach orbit,
land on moons, and bring your crew home.

**Status: Milestone 1 vertical slice — playable.** Build a rocket in the
Workshop, launch from Veyra, reach orbit, plan a transfer to the moon Palla
with maneuver nodes, land, return, and recover. The star system, parts,
simulation, and writing are original. Veyra's authored global albedo uses a
public-domain Natural Earth II source through Perilune's deterministic asset
compiler; its provenance and modifications are recorded in
`ATTRIBUTIONS.md` and `LICENSES.md`.

## Play (development)

```bash
npm install
npm run dev        # http://localhost:5173
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build (static, `dist/`) |
| `npm run serve` | Serve the production build locally |
| `npm test` | Unit / property / integration tests (vitest) |
| `npm run test:e2e` | Browser end-to-end tests (Playwright) |
| `npm run bench` | Performance benchmarks with CI budgets |
| `npm run typecheck` | Strict TypeScript check |
| `npm run validate:content` | Validate planet assets, provenance, checksums, and budgets |
| `npm run compile:planet-assets:container` | Regenerate authoritative planet packs in the pinned container |

The production build deploys to any HTTPS static host.

## Controls

| Input | Action |
|---|---|
| Shift / Ctrl | Throttle up / down · Z full · X cut |
| W S A D Q E | Pitch / yaw / roll |
| Space | Fire next stage |
| T | Toggle SAS · navball buttons pick hold modes |
| R | RCS toggle · IJKL/UO translate |
| M | Map view (maneuver planning) |
| , . | Time warp down / up |
| F5 / F9 | Quicksave / quickload |
| F3 | Performance overlay |
| Mouse drag / wheel | Camera orbit / zoom |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — decisions + measurements (ADRs)
- [PHYSICS.md](PHYSICS.md) — simulation model
- [RENDERING.md](RENDERING.md) — planet/vessel rendering pipeline
- [PERFORMANCE.md](PERFORMANCE.md) — budgets and benchmark history
- [FEATURES.md](FEATURES.md) — feature traceability matrix
- [QA.md](QA.md) — test strategy and gates
- [LICENSES.md](LICENSES.md) / [ATTRIBUTIONS.md](ATTRIBUTIONS.md)
- [CHANGELOG.md](CHANGELOG.md)
