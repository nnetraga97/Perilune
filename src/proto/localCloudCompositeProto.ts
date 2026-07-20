/**
 * Isolated feasibility math for a depth-clipped local cloud pass.
 *
 * This module intentionally does not install a production renderer. It makes
 * the occlusion, density, and optical-depth contracts executable before any
 * render-target or post-composition architecture is approved.
 */

export interface RayInterval {
  readonly start: number;
  readonly end: number;
}

export function clipCloudIntervalToOpaqueDepth(
  interval: Readonly<RayInterval>,
  opaqueDistance: number,
): RayInterval | null {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)
    || interval.start < 0 || interval.end <= interval.start) {
    throw new Error('Invalid local-cloud ray interval');
  }
  if (!Number.isFinite(opaqueDistance) && opaqueDistance !== Number.POSITIVE_INFINITY) {
    throw new Error(`Invalid opaque distance ${opaqueDistance}`);
  }
  const end = Math.min(interval.end, Math.max(0, opaqueDistance));
  return end > interval.start ? Object.freeze({ start: interval.start, end }) : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export interface LocalCloudDensityInput {
  readonly positionBodyFixed: Readonly<{ x: number; y: number; z: number }>;
  readonly bodyRadius: number;
  readonly baseAltitude: number;
  readonly topAltitude: number;
  readonly macroCoverage: number;
  readonly opticalDensity: number;
  readonly timeSeconds: number;
}

/** Stable 3D breakup: vertical coordinate participates independently. */
export function sampleLocalCloudDensity(input: Readonly<LocalCloudDensityInput>): number {
  const radius = Math.hypot(
    input.positionBodyFixed.x,
    input.positionBodyFixed.y,
    input.positionBodyFixed.z,
  );
  if (!(input.bodyRadius > 0) || !(input.topAltitude > input.baseAltitude) || !(radius > 0)) {
    return 0;
  }
  const altitude = radius - input.bodyRadius;
  const heightFraction = (altitude - input.baseAltitude)
    / (input.topAltitude - input.baseAltitude);
  if (!(heightFraction > 0 && heightFraction < 1)) return 0;
  const direction = {
    x: input.positionBodyFixed.x / radius,
    y: input.positionBodyFixed.y / radius,
    z: input.positionBodyFixed.z / radius,
  };
  const heightShape = Math.sin(Math.PI * heightFraction) ** 1.35;
  const drift = input.timeSeconds * 0.00007;
  const first = Math.sin(direction.x * 17.3 + direction.z * 9.7 + heightFraction * 5.1 + drift);
  const second = Math.sin(direction.y * 29.1 - direction.x * 11.4 + heightFraction * 12.7 - drift * 1.7);
  const third = Math.sin(direction.z * 43.7 + direction.y * 7.9 - heightFraction * 21.3 + drift * 0.6);
  const breakup = clamp01(0.5 + first * 0.25 + second * 0.17 + third * 0.08);
  const coverage = clamp01(input.macroCoverage);
  const threshold = 0.72 - coverage * 0.5;
  const density = clamp01((breakup - threshold) / 0.18);
  return density * coverage * clamp01(input.opticalDensity) * heightShape;
}

export interface IntegratedCloudOpticalDepth {
  readonly opticalDepth: number;
  readonly transmittance: number;
  readonly alpha: number;
}

export function integrateLocalCloudOpticalDepth(input: {
  readonly interval: Readonly<RayInterval>;
  readonly samples: number;
  readonly extinctionPerMeter: number;
  readonly densityAtDistance: (distance: number) => number;
}): IntegratedCloudOpticalDepth {
  if (!Number.isInteger(input.samples) || input.samples <= 0) {
    throw new Error(`Invalid local-cloud sample count ${input.samples}`);
  }
  if (!(input.extinctionPerMeter >= 0) || !Number.isFinite(input.extinctionPerMeter)) {
    throw new Error(`Invalid local-cloud extinction ${input.extinctionPerMeter}`);
  }
  const length = input.interval.end - input.interval.start;
  if (!(length > 0)) throw new Error('Invalid local-cloud integration length');
  const step = length / input.samples;
  let opticalDepth = 0;
  for (let index = 0; index < input.samples; index++) {
    const distance = input.interval.start + (index + 0.5) * step;
    opticalDepth += clamp01(input.densityAtDistance(distance)) * step * input.extinctionPerMeter;
  }
  const transmittance = Math.exp(-opticalDepth);
  return Object.freeze({ opticalDepth, transmittance, alpha: 1 - transmittance });
}

/** Crossfade extinction, not already-composited alpha. */
export function crossfadeCloudOpticalDepth(
  localOpticalDepth: number,
  shellOpticalDepth: number,
  shellWeight: number,
): IntegratedCloudOpticalDepth {
  if (localOpticalDepth < 0 || shellOpticalDepth < 0) {
    throw new Error('Cloud optical depth cannot be negative');
  }
  const weight = clamp01(shellWeight);
  const opticalDepth = localOpticalDepth * (1 - weight) + shellOpticalDepth * weight;
  const transmittance = Math.exp(-opticalDepth);
  return Object.freeze({ opticalDepth, transmittance, alpha: 1 - transmittance });
}

export interface LocalCloudPrototypeCapabilities {
  readonly readableOpaqueDepth: boolean;
  readonly halfResolutionComposite: boolean;
  readonly depthReconstructionValidated: boolean;
  readonly shellCanClipIntegratedRay: boolean;
}

export interface LocalCloudFeasibilityDecision {
  readonly approvedMethod: 'depth-clipped-raymarch' | 'improved-shell' | null;
  readonly blockers: readonly string[];
}

/** Gate decision kept pure so tests and the browser prototype use one contract. */
export function decideLocalCloudFeasibility(
  capabilities: Readonly<LocalCloudPrototypeCapabilities>,
): LocalCloudFeasibilityDecision {
  if (capabilities.readableOpaqueDepth
    && capabilities.halfResolutionComposite
    && capabilities.depthReconstructionValidated) {
    return Object.freeze({ approvedMethod: 'depth-clipped-raymarch', blockers: Object.freeze([]) });
  }
  if (capabilities.shellCanClipIntegratedRay) {
    return Object.freeze({ approvedMethod: 'improved-shell', blockers: Object.freeze([]) });
  }
  const blockers: string[] = [];
  if (!capabilities.readableOpaqueDepth) blockers.push('no-readable-opaque-depth');
  if (!capabilities.halfResolutionComposite) blockers.push('no-half-resolution-composite');
  if (!capabilities.depthReconstructionValidated) blockers.push('depth-reconstruction-unproven');
  if (!capabilities.shellCanClipIntegratedRay) blockers.push('shell-cannot-clip-integrated-ray');
  return Object.freeze({ approvedMethod: null, blockers: Object.freeze(blockers) });
}

/** Current forward-renderer evidence: neither candidate crosses the production gate. */
export const CURRENT_LOCAL_CLOUD_DECISION = decideLocalCloudFeasibility({
  readableOpaqueDepth: false,
  halfResolutionComposite: false,
  depthReconstructionValidated: false,
  shellCanClipIntegratedRay: false,
});

export async function runLocalCloudCompositeProto(): Promise<void> {
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  (window as Window & {
    __localCloudComposite?: { readonly ready: true; readonly decision: LocalCloudFeasibilityDecision };
  }).__localCloudComposite = Object.freeze({ ready: true, decision: CURRENT_LOCAL_CLOUD_DECISION });
}
