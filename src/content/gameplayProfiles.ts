import type { BodyDef } from '../sim/universe';
import {
  LEGACY_FLIGHT_TUNING,
  SOL_FLIGHT_TUNING,
  type FlightTuning,
} from '../sim/gameplayTuning';
import { LEGACY_AUREN_HOME_BODY_ID, LEGACY_AUREN_SYSTEM } from './legacySystem';
import { HOME_BODY_ID, SOL_SYSTEM } from './system';

export type GameplaySystemId = 'sol' | 'legacy';

export interface GameplayProfile {
  readonly id: GameplaySystemId;
  readonly systemId: GameplaySystemId;
  readonly label: string;
  readonly bodies: readonly BodyDef[];
  readonly homeBodyId: string;
  readonly persistence: 'enabled' | 'session-only';
  readonly flightTuning: Readonly<FlightTuning>;
}

export const GAMEPLAY_PROFILES: Readonly<Record<GameplaySystemId, GameplayProfile>> = Object.freeze({
  sol: Object.freeze({
    id: 'sol',
    systemId: 'sol',
    label: 'Sol — new visuals and real-scale worlds',
    bodies: SOL_SYSTEM,
    homeBodyId: HOME_BODY_ID,
    persistence: 'enabled',
    flightTuning: SOL_FLIGHT_TUNING,
  }),
  legacy: Object.freeze({
    id: 'legacy',
    systemId: 'legacy',
    label: 'Legacy Auren — original gameplay',
    bodies: LEGACY_AUREN_SYSTEM,
    homeBodyId: LEGACY_AUREN_HOME_BODY_ID,
    persistence: 'session-only',
    flightTuning: LEGACY_FLIGHT_TUNING,
  }),
});

export function gameplayProfile(id: GameplaySystemId): GameplayProfile {
  return GAMEPLAY_PROFILES[id];
}
