# Development guide

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` synchronizes the checked renderer assets first. The local game
does not need an account or external credentials for normal play.

## Verify a change

| Command | Use |
|---|---|
| `npm run typecheck` | Strict TypeScript check |
| `npm test` | Unit and integration tests |
| `npm run test:e2e` | Browser journeys with Playwright |
| `npm run build` | Content validation, asset sync, typecheck, and production build |
| `npm run validate:content` | Provenance, manifests, checksums, and asset budgets |

For flight or simulation work, add or update deterministic tests. For UI work,
also exercise the affected player flow in the browser.

## Quality and accessibility

Release-blocking issues include crashes, save corruption, NaN physics,
spontaneous vessel destruction, broken controls, and a missing acceptance
scenario. The test suite covers orbital math, craft/staging invariants, saves,
missions, campaign rules, terrain transitions, and browser gameplay.

Current accessibility support includes keyboard flight controls, buttons for
keyboard actions, browser zoom-friendly rem sizing, player-controlled time
warp, and a reduced-motion rendering path. Future mod/content support must not
allow arbitrary code execution.

## Content and environments

Content is data-driven under `src/content/`. Keep simulation authority in
`src/sim/`; visual code must not redefine terrain or flight behavior.

Pip requires `OPENAI_API_KEY` locally. Production Pip also uses Redis for rate
limiting; optional audit persistence uses Supabase server credentials. Do not
put secrets in client code or commit local environment files.

Asset-source and dependency details are in [LEGAL.md](LEGAL.md).
