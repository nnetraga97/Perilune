# Perilune for OpenAI Build Week

## The idea

Spaceflight is usually taught with diagrams, equations, or a simulation that
expects players to already know what every instrument means. Perilune makes the
same decisions approachable: build a spacecraft, launch it, see an orbit take
shape, and learn why each burn changes the path.

The first experience is **First Light**. A prepared vehicle takes a new player
from Earth launch through orbit, a planned Moon transfer, lunar capture, and
circularization. The tutorial names the idea at the moment it becomes visible:
speed is what keeps a spacecraft falling around Earth; a forward burn raises
the opposite side of an orbit; slowing down near the Moon captures you there.

**Track:** Apps for Your Life

## What is working now

- Workshop building, staging, Δv, and thrust-to-weight feedback.
- A guided Earth-to-Moon First Light mission, including a checked maneuver and
  optional maneuver automation.
- A map with orbital paths, maneuver planning, transfer guidance, time warp,
  entry prediction, and alarms.
- Sandbox, Exploration, and Space Program modes, plus science, technology,
  contracts, funding, recovery, docking, communications, rovers, and ISRU.
- Source-backed Sun, Earth, and Moon visuals, including low-altitude and
  Moon-surface detail work.
- Responsive flight and Workshop interfaces, cloud-save support where the
  deployment is configured, and a local fallback for core play.

The README is the concise player guide; this file keeps the fuller project and
submission context in one place.

## GPT-5.6 in the experience: Pip, the flight companion

Pip is not a chatbot pasted onto the game. When a player asks for a briefing,
the game creates a structured snapshot of the current mission: flight phase,
vehicle capability, fuel, orbit margins, maneuver timing, entry prediction,
communications, and recent events. The server sends that constrained context
to the OpenAI Responses API using `gpt-5.6-luna`.

The response must match a checked shape: a headline, short explanation,
evidence keys, one allowed next action, warnings, and stated unknowns. Perilune
rejects a response that cites unavailable evidence or suggests an action the
current flight cannot take. Pip is advisory-only—players remain in control—and
the existing local guidance still works if the AI service is unavailable.

This turns the model into a context-aware instructor rather than an authority
that invents flight data. The implementation lives in `src/ai/flightDirector.ts`,
`src/ui/flightDirectorSnapshot.ts`, and `server/flightDirector.ts`; its server
tests cover the response contract and failure cases.

## How Codex contributed

Codex was used throughout the Build Week development cycle to explore the
codebase, implement and refine gameplay/UI changes, review behavior, and run
validation. The Build Week commit history records the resulting work, including:

- `2bc24ed` — initial AI flight companion.
- `4a8ef06` and `c425f42` — audited, mission-grounded flight briefings.
- `6a9b421` and `b04a789` — map/transfer planning and Sol gameplay with
  maneuver automation.
- `a9e8b72` and `163b6c6` — Sun/Moon visual completion and the First Light
  tutorial overhaul.

The primary Codex session identifier for the Devpost form must be supplied by
the submitter from the main build thread; it is intentionally not stored in the
repository.

## Run it locally

```bash
npm install
npm run dev
```

Choose **First Light** at the menu. For a local Pip briefing, set
`OPENAI_API_KEY`; without it, the rest of the game and Pip's local callouts
remain available. The production flight-director route additionally uses Redis
for rate limiting and can persist server-side audit records when its Supabase
environment variables are configured.

## Build Week submission checklist

- [ ] Choose **Apps for Your Life** on Devpost.
- [ ] Add the public demo URL or clear local-run instructions.
- [ ] Record a public YouTube demo of three minutes or less, with an English
  voiceover showing First Light, Pip, and how Codex/GPT-5.6 were used.
- [ ] Add the repository URL and this README to the submission.
- [ ] Paste the `/feedback` Session ID from the primary Codex build thread.
- [ ] Confirm third-party sources are disclosed in [docs/LEGAL.md](docs/LEGAL.md).
- [ ] Recheck the official rules and Devpost form immediately before submitting.

The official requirements call for a working project built with Codex and
GPT-5.6, a clear description, a public narrated YouTube demo, repository/testing
access, and the primary Codex `/feedback` Session ID. The video must be three
minutes or less. Refer to the [Build Week FAQ](https://openai.devpost.com/details/faqs)
and [official rules](https://openai.devpost.com/rules) as the source of truth.
