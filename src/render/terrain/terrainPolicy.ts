import type { QualityTier, VectorCoordinates } from '../bodyRenderer';

export interface TerrainQualityPolicy {
  readonly gridResolution: number;
  readonly maximumSsePixels: number;
  readonly mergeSsePixels: number;
  readonly submissionsPerFrame: number;
  readonly schedulingBudgetMs: number;
  readonly installationBudgetMs: number;
  readonly maximumWorkers: number;
  readonly maximumDesiredLeaves: number;
  readonly predictionSeconds: number;
  readonly normalTransitionSeconds: number;
  readonly pressureTransitionSeconds: number;
  readonly softResidencyRatio: number;
  readonly hardReservationRatio: number;
}

function policy(value: TerrainQualityPolicy): TerrainQualityPolicy {
  if (!(value.mergeSsePixels < value.maximumSsePixels)) {
    throw new Error('Terrain merge SSE must be below split SSE');
  }
  return Object.freeze(value);
}

export const TERRAIN_QUALITY_POLICY: Readonly<Record<QualityTier, TerrainQualityPolicy>> = Object.freeze({
  low: policy({
    gridResolution: 9,
    maximumSsePixels: 4,
    mergeSsePixels: 2.8,
    submissionsPerFrame: 3,
    schedulingBudgetMs: 2,
    installationBudgetMs: 2,
    maximumWorkers: 4,
    maximumDesiredLeaves: 320,
    predictionSeconds: 0.5,
    normalTransitionSeconds: 0.35,
    pressureTransitionSeconds: 0.2,
    softResidencyRatio: 0.75,
    hardReservationRatio: 1,
  }),
  medium: policy({
    gridResolution: 17,
    maximumSsePixels: 2.5,
    mergeSsePixels: 1.75,
    submissionsPerFrame: 4,
    schedulingBudgetMs: 2,
    installationBudgetMs: 2,
    maximumWorkers: 4,
    maximumDesiredLeaves: 480,
    predictionSeconds: 0.5,
    normalTransitionSeconds: 0.35,
    pressureTransitionSeconds: 0.2,
    softResidencyRatio: 0.75,
    hardReservationRatio: 1,
  }),
  high: policy({
    gridResolution: 33,
    maximumSsePixels: 1.5,
    mergeSsePixels: 1.05,
    submissionsPerFrame: 5,
    schedulingBudgetMs: 2,
    installationBudgetMs: 2,
    maximumWorkers: 4,
    maximumDesiredLeaves: 640,
    predictionSeconds: 0.5,
    normalTransitionSeconds: 0.35,
    pressureTransitionSeconds: 0.2,
    softResidencyRatio: 0.75,
    hardReservationRatio: 1,
  }),
});

export interface ScreenSpaceErrorInput {
  readonly geometricErrorMeters: number;
  readonly distanceToBoundingVolumeMeters: number;
  readonly drawingBufferHeight: number;
  readonly verticalFovRadians: number;
}

const MINIMUM_BOUND_DISTANCE_METERS = 0.01;

export function screenSpaceErrorPixels(input: Readonly<ScreenSpaceErrorInput>): number {
  if (!Number.isFinite(input.geometricErrorMeters) || input.geometricErrorMeters < 0) {
    throw new Error(`Invalid terrain geometric error ${input.geometricErrorMeters}`);
  }
  if (!Number.isFinite(input.distanceToBoundingVolumeMeters)) {
    throw new Error(`Invalid terrain bound distance ${input.distanceToBoundingVolumeMeters}`);
  }
  if (!Number.isFinite(input.drawingBufferHeight) || input.drawingBufferHeight <= 0) {
    throw new Error(`Invalid drawing-buffer height ${input.drawingBufferHeight}`);
  }
  if (
    !Number.isFinite(input.verticalFovRadians)
    || input.verticalFovRadians <= 0
    || input.verticalFovRadians >= Math.PI
  ) {
    throw new Error(`Invalid vertical FOV ${input.verticalFovRadians}`);
  }
  if (input.geometricErrorMeters === 0) return 0;
  const distance = Math.max(MINIMUM_BOUND_DISTANCE_METERS, input.distanceToBoundingVolumeMeters);
  return input.geometricErrorMeters * input.drawingBufferHeight
    / (2 * distance * Math.tan(input.verticalFovRadians / 2));
}

export function distanceToTerrainBoundingSphereMeters(
  camera: Readonly<VectorCoordinates>,
  center: Readonly<VectorCoordinates>,
  radius: number,
): number {
  if (!Number.isFinite(radius) || radius < 0) throw new Error(`Invalid terrain bound radius ${radius}`);
  const distance = Math.hypot(
    camera.x - center.x,
    camera.y - center.y,
    camera.z - center.z,
  );
  if (!Number.isFinite(distance)) throw new Error('Invalid terrain camera or bound center');
  return Math.max(0, distance - radius);
}

export function nextTerrainSplitState(
  previouslySplit: boolean,
  screenSpaceError: number,
  quality: Readonly<TerrainQualityPolicy>,
): boolean {
  if (!Number.isFinite(screenSpaceError) || screenSpaceError < 0) {
    throw new Error(`Invalid terrain screen-space error ${screenSpaceError}`);
  }
  if (previouslySplit) return screenSpaceError >= quality.mergeSsePixels;
  return screenSpaceError > quality.maximumSsePixels;
}
