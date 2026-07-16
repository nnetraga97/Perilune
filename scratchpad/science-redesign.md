# Science redesign implementation scratchpad

## Contract

- Finalize Revision 2 before implementation.
- Simulation owns collect, transmit, recover, availability, key encoding, caps, and deduplication.
- Existing communications and terrain geometry remain authoritative inputs.
- Saves preserve historical `sciencePoints`, completed-site exhaustion, and aboard data separately.

## Final-review corrections

- Prevent repeated collection of a key while that vessel already holds the result; otherwise ledger-only yield calculation permits click-spam to fill a cap.
- Keep all science values integral: round site cap and collection yield, and round the per-sample transmit target once.
- A transmit press is idempotent for the current sample after its target is delivered; it does not gradually converge without a rate model.

## Implementation order

1. Domain types, keys, ledger/buffers, migration, recovery invariant.
2. Home/tech data and deterministic science biomes.
3. Transmit through `evaluateComms` and experiment fractions.
4. Economy content and repeatable upgrades.
5. HUD feedforward, transmit action, and science/program panels.
6. Focused unit, migration, content, and browser verification.

## Risks to watch

- Avoid importing UI or render code into `sim/science.ts`.
- Avoid a `state.ts`/`science.ts` runtime import cycle; keep science state types structurally owned or type-only where possible.
- Recovery must not remove a vessel or grant refunds before the science command accepts it.
- Existing saves and tutorial/contract flags must continue to work.

## Verification outcome

- Revision 3 is the final implementation contract.
- The archive enumerates untouched sites from the same applicability rules as the budget validator.
- Browser validation found Cape Skyward's comms coordinates had drifted from the launch-site authority; the station now consumes `launchSiteBodyFixedDirection` and Farside retains complementary coverage.
- Unit/integration, content validation, production build, collect-to-recover browser flow, and collect-to-transmit browser flow pass.
