# Artemis IV current-architecture lock

**Reference date:** 2026-07-21

**Purpose:** factual boundary for Perilune's Artemis IV guided mission
**Status:** implementation source lock; refresh immediately before public release

## Confirmed mission facts

The guided mission may state the following as current NASA facts:

- Artemis IV is a crewed lunar-surface mission targeted for early 2028.
- Four astronauts launch aboard Orion. In lunar orbit, Orion docks directly
  with a commercial human landing system.
- Two crew members descend to the lunar South Pole region, remain on the
  surface for approximately one week, then return to lunar orbit and rejoin
  the other crew members for the flight home.
- NASA has not assigned the Artemis IV landing-system provider. NASA is
  developing landing systems with SpaceX and Blue Origin, and provider
  readiness will determine the landing mission assignment.
- Gateway is not part of NASA's published Artemis IV sequence in the revised
  architecture.
- NASA is replacing ICPS with a standardized second-stage approach and is
  assessing the final configuration. EUS and Mobile Launcher 2 are no longer
  the current Artemis IV plan.

Primary evidence:

- [NASA Artemis IV mission overview](https://www.nasa.gov/mission/artemis-iv/)
- [NASA Strengthens Artemis: Adds Mission, Refines Overall Architecture](https://www.nasa.gov/directorates/esdmd/nasa-strengthens-artemis-adds-mission-refines-overall-architecture/)
- [How NASA's Artemis III Lander Test Will Pave Way for Moon Landings](https://www.nasa.gov/directorates/esdmd/artemis-campaign-development-division/human-landing-system-program/how-nasas-artemis-iii-lander-test-will-pave-way-for-moon-landings/)

## Provisional or unpublished facts

The mission must label these as representative/TBD or omit them:

- landing-system provider and final vehicle configuration;
- crew identities and role assignments;
- exact launch upper stage and launch-stack geometry;
- landing site, trajectory, orbit, burn timing, performance, and propellant;
- science manifest, surface timeline, exact duration, and recovery coordinates.

The existing NASA PGDA Site 01 data is a **South Pole training analogue**, not
an asserted Artemis IV landing site. Perilune gameplay envelopes are
representative simulation tuning, never manufacturer or NASA specifications.

## Vehicle visual lock

### Orion

Perilune's `orion-voyager-pod` visual is derived from NASA's
`Orion Capsule (no fbc).stl`, pinned in `assets/parts/sources.json`. Its checked
render model is approximately 1.20 m in diameter and 0.85 m tall.

The Artemis mission reuses that mesh at a uniform visual scale of `4.164`,
producing approximately 5.0 m diameter and 3.54 m height. NASA publishes an
Orion Crew Module diameter of 5.0 m and height of 3.35 m. The resulting visual
must therefore be labeled:

> Orion Crew Module · simplified exterior

The stock `pod-voyager` definition remains a one-seat, 840 kg game part and is
not Artemis physics authority. The mission supplies its own representative
four-person crew state, mass/propulsion, docking transform, heat-shield
envelope, ESM, and separation behavior.

Sources:

- [NASA Orion Capsule 3D resource](https://science.nasa.gov/3d-resources/orion-capsule/)
- [NASA Orion spacecraft components](https://www.nasa.gov/reference/spacecraft-components/)

### Landing-system stand-in

The exact file
`assets/missions/artemis-iv/models/martiandays-spacex-starship-2019.glb` is
MartianDays' 2019 generic Starship concept, downloaded from Sketchfab under CC
BY 4.0. It is not Starship HLS. The asset stays byte-for-byte unchanged; only
the checked external runtime transform in `manifest.json` may be applied.

Required visible label:

> UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD

The GLB lacks the published HLS-specific docking, lunar-thruster, landing-gear,
and surface-access configuration. Hidden mission physics may provide playable
docking, thrust, RCS, landing contacts, and crew capacity, but neither UI nor
documentation may describe those values as SpaceX specifications.

Source and rights evidence:

- [MartianDays SpaceX Starship model](https://sketchfab.com/3d-models/spacex-starship-a8a0b69f776841a1a465cd9fb3762fd2)
- [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
- `assets/missions/artemis-iv/source-lock.json`
- `ATTRIBUTIONS.md`
- `LICENSES.md`

## Forbidden release claims

Release copy and content checks must reject:

- Artemis IV delivering I-Hab or assembling/visiting Gateway;
- an NRHO station-operations objective;
- claims that Block 1B, EUS, or Mobile Launcher 2 is the current launch plan;
- claims that NASA selected SpaceX or Blue Origin for Artemis IV;
- calling the bundled 2019 mesh `Starship HLS` or an accurate flight model;
- presenting Site 01 or representative simulation values as the final mission
  site or flight plan.

## Refresh rule

This lock records NASA's public architecture as accessed on 2026-07-21. Before
the development flag is removed, re-open the primary sources, record any
changes, update mission copy/tests, and repeat the external accuracy review.
