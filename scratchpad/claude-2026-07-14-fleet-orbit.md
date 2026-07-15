# Fleet orbit action

## Goal

Add an `Orbit` action to the selected body in the Fleet window. Activating it places the current craft into a stable circular orbit around that body.

## Decisions

- Show the action only for the body currently selected as the active vessel's target.
- Move only the active vessel; other fleet vessels remain untouched.
- Choose a safe altitude above the body's atmosphere and terrain, while staying comfortably inside its sphere of influence.
- Stop time warp and clear landed, thrust, translation, and stale rails state before resuming active flight.
- Clear the body target after arrival because the craft is now orbiting that body.

## Verification

- Add focused simulation coverage for cross-body placement, circular-orbit invariants, state reset, and fleet isolation.
- Run the focused test, full unit suite, production build, and diff checks before committing and pushing.
