import { BODY_VISUALS } from '../content/bodyVisuals';
import type { BodyId } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import { bodyMaterialDescriptor } from './bodyMaterial';
import type { RenderCaps } from './context';
import type { BodyRenderer, QualityTier } from './bodyRenderer';
import { LegacyBodyRenderer, type LegacyBodyRendererDependencies } from './legacyBodyRenderer';
import { StarBodyRenderer } from './starBodyRenderer';
import { TerrestrialBodyRenderer } from './terrestrialBodyRenderer';

export interface BodyRendererCandidateOptions {
  readonly body: Body;
  readonly caps: Readonly<RenderCaps>;
  readonly quality: QualityTier;
  readonly legacyDependencies?: LegacyBodyRendererDependencies;
}

export function createBodyRendererCandidate(options: BodyRendererCandidateOptions): BodyRenderer {
  const visual = BODY_VISUALS[options.body.id as BodyId];
  if (!visual) throw new Error(`Missing body visual assignment for ${options.body.id}`);
  const descriptor = bodyMaterialDescriptor(options.body, visual);
  switch (visual.renderer) {
    case 'star':
      return new StarBodyRenderer(options.body, descriptor, options.caps, options.quality);
    case 'legacy':
      return new LegacyBodyRenderer(options.body, descriptor, options.caps, options.quality, options.legacyDependencies);
    case 'terrestrial':
      return new TerrestrialBodyRenderer(options.body, descriptor, options.caps, options.quality);
    default:
      throw new Error(`Body renderer '${visual.renderer}' is not implemented for ${options.body.id}`);
  }
}
