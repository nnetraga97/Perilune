# Perilune

**Design a spacecraft. Learn why an orbit works. Fly it from Earth to the Moon.**

Perilune is a browser-based orbital engineering game. It makes the ideas behind
spaceflight playable: build a vehicle in the Workshop, launch from Earth,
shape an orbit, plan a maneuver, and attempt a Moon transfer. The current
experience is built around **First Light**, a guided mission that explains each
step while the player flies it.

> **OpenAI Build Week** — Perilune's suggested track is **Apps for Your Life**:
> hands-on way to learn orbital flight. Start with [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the
> project story, the GPT-5.6/Codex implementation, and the submission checklist.

## Start here

```bash
npm install
npm run dev
```

Open the local address Vite prints, then choose **First Light**. It starts with
a prepared vehicle and leads from launch to a Moon orbit. No account is needed
for local play.

## What you can do

| Try | What it teaches |
|---|---|
| First Light | Launch, achieve Earth orbit, execute a Moon transfer, and capture |
| Workshop | Assemble and stage a spacecraft; inspect Δv and thrust-to-weight ratio |
| Map | Read an orbit, create a maneuver, and use the flight computer to execute it |
| Pip | Ask the optional GPT-5.6 flight companion for an evidence-backed next step |
| Exploration / Space Program | Turn recovered science into technology, contracts, funding, and reputation |

The complete project story and Build Week submission context are in
[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

## Controls worth knowing

| Input | Action |
|---|---|
| `Space` | Fire the next stage |
| `Shift` / `Ctrl` | Increase / decrease throttle |
| `M` | Open the map and maneuver planner |
| `,` / `.` | Decrease / increase time warp |
| `F5` / `F9` | Quicksave / quickload |
| Mouse drag / wheel | Orbit / zoom the camera |

## Run and check it

| Command | Purpose |
|---|---|
| `npm run dev` | Run locally with hot reload |
| `npm run build` | Type-check, validate content, and build the app |
| `npm test` | Run deterministic unit and integration tests |
| `npm run test:e2e` | Run browser journeys |
| `npm run validate:content` | Check asset provenance and content budgets |

## Documentation

[docs/README.md](docs/README.md) is the organized reference: architecture,
quality, content, legal attribution, and dated design history. Historical
planning and review notes are retained for traceability but kept out of the
project's main path.

## Credits and license information

Perilune's game systems, writing, and presentation are original. Some visual
source material is used under documented terms; see
[legal and attribution](docs/LEGAL.md).
