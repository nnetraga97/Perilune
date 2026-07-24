import type { BodyVisualDef } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type { QualityTier } from './bodyRenderer';
import { CompactPlanetBodyRenderer } from './compactPlanetBodyRenderer';
import type { RenderCaps } from './context';

/**
 * Cloud-top ellipsoid renderer. It deliberately reuses the proven analytic
 * physical-to-proxy-to-point presentation path without claiming terrain.
 */
export class GasGiantBodyRenderer extends CompactPlanetBodyRenderer {
  constructor(
    body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    visual: Readonly<NonNullable<BodyVisualDef['gasGiantVisual']>>,
    caps: Readonly<RenderCaps>,
    quality: QualityTier,
  ) {
    super(body, descriptor, visual, caps, quality, 'gas-giant');
  }
}
