# Technical overview

## Runtime

Perilune is a strict TypeScript browser game built with Vite and rendered with
Three.js on WebGL2. It needs WebGL2; there is no WebGL1 fallback.

The simulation runs on a fixed 50 Hz clock. Rendering interpolates the result,
so a slow frame does not change the flight physics.

## Flight model

- The active craft and nearby vehicles use a six-degree-of-freedom rigid-body
  simulation with engines, aerodynamics, heating, terrain contact, staging,
  RCS, and SAS.
- Background craft use analytic patched-conic propagation. Moving a craft
  between the active and on-rails regimes preserves its state.
- World coordinates are stored relative to the current sphere of influence and
  converted to camera-relative values before rendering, which keeps large
  orbital distances stable.

## Rendering and assets

The renderer separates gameplay authority from visuals: rendering may consume
terrain and body data, but it never decides collision height or flight state.
The current Sol experience includes Earth, Moon, and Sun rendering across
orbit-to-ground views.

Planet and checked part assets have pinned provenance, checksums, and size
budgets. `npm run validate:content` verifies that manifest before a build.
Deliberate asset regeneration uses the pinned container command:

```bash
npm run compile:planet-assets:container
```

## Pip: the AI flight companion

Pip requests a briefing only when the player asks. The game assembles a
structured snapshot of the current mission, vehicle, orbit, maneuver, entry,
communications, and recent events. The server sends that limited context to
the OpenAI Responses API using `gpt-5.6-luna`.

Responses must contain supported evidence keys and an action that is valid for
the current flight. Unsupported or malformed advice is rejected; Pip is
advisory-only and local guidance remains available if the service cannot be
reached. The relevant implementation is in `src/ai/`, `src/ui/flightDirectorSnapshot.ts`,
and `server/flightDirector.ts`.

## Where code lives

| Location | Responsibility |
|---|---|
| `src/sim/` | Deterministic flight, planning, campaign, and terrain authority |
| `src/render/` | Three.js scenes and visual presentation |
| `src/ui/` | Controls, HUD, tutorial, Workshop, and map |
| `src/content/` | Bodies, parts, missions, and gameplay profiles |
| `src/ai/` / `server/` | Pip client contract and server-backed briefing route |
| `tests/` / `e2e/` | Simulation, integration, and browser regression coverage |
