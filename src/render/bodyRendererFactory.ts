import { BODY_VISUALS } from '../content/bodyVisuals';
import type { BodyId } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import { bodyMaterialDescriptor } from './bodyMaterial';
import type { RenderCaps } from './context';
import type { BodyRenderer, QualityTier } from './bodyRenderer';
import { LegacyBodyRenderer, type LegacyBodyRendererDependencies } from './legacyBodyRenderer';
import { SolarBodyRenderer } from './solarBodyRenderer';
import { TerrestrialBodyRenderer } from './terrestrialBodyRenderer';
import { AirlessBodyRenderer } from './airlessBodyRenderer';
import { CompactPlanetBodyRenderer } from './compactPlanetBodyRenderer';
import { GasGiantBodyRenderer } from './gasGiantBodyRenderer';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import type { FlightAerialPerspectiveController } from './flightAerialPerspective';
import {
  planetDataAuthorityForBody,
  type FrozenPlanetDataAuthority,
} from '../sim/planetDataAuthority';

export interface BodyRendererCandidateOptions {
  readonly body: Body;
  readonly caps: Readonly<RenderCaps>;
  readonly quality: QualityTier;
  readonly legacyDependencies?: LegacyBodyRendererDependencies;
  readonly diagnostics?: RenderDiagnosticsPort;
  readonly activeBodyBudgetBytes?: number;
  readonly flightAerial?: FlightAerialPerspectiveController;
  readonly authority?: Readonly<FrozenPlanetDataAuthority>;
}

export function createBodyRendererCandidate(options: BodyRendererCandidateOptions): BodyRenderer {
  const visual = BODY_VISUALS[options.body.id as BodyId];
  if (!visual) throw new Error(`Missing body visual assignment for ${options.body.id}`);
  const descriptor = bodyMaterialDescriptor(options.body, visual);
  const authority = options.authority ?? planetDataAuthorityForBody(options.body);
  switch (visual.renderer) {
    case 'star':
      return new SolarBodyRenderer(options.body, descriptor, options.caps, options.quality);
    case 'legacy':
      return new LegacyBodyRenderer(options.body, descriptor, options.caps, options.quality, options.legacyDependencies);
    case 'terrestrial':
      return new TerrestrialBodyRenderer(
        options.body,
        descriptor,
        options.caps,
        options.quality,
        options.diagnostics,
        options.activeBodyBudgetBytes,
        options.flightAerial,
        authority,
      );
    case 'airless':
      return new AirlessBodyRenderer(
        options.body,
        descriptor,
        options.caps,
        options.quality,
        options.diagnostics,
        options.flightAerial,
        authority,
      );
    case 'compact-planet': {
      if (!visual.compactPlanetVisual) {
        throw new Error(`${options.body.id} compact planet is missing visual configuration`);
      }
      return new CompactPlanetBodyRenderer(
        options.body,
        descriptor,
        visual.compactPlanetVisual,
        options.caps,
        options.quality,
      );
    }
    case 'gas-giant': {
      if (!visual.gasGiantVisual) {
        throw new Error(`${options.body.id} gas giant is missing visual configuration`);
      }
      return new GasGiantBodyRenderer(
        options.body,
        descriptor,
        visual.gasGiantVisual,
        options.caps,
        options.quality,
      );
    }
    default:
      throw new Error(`Body renderer '${visual.renderer}' is not implemented for ${options.body.id}`);
  }
}
