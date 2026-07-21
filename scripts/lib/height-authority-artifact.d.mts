export interface HeightAuthorityBuildEntry {
  readonly bodyId: string;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceDimensions: readonly [number, number];
  readonly verticalDatum: string;
  readonly derivationKernel: string;
  readonly width: number;
  readonly height: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly noDataCount: number;
  readonly quantizationScaleMeters: number;
  readonly quantizationOffsetMeters: number;
  readonly worstQuantizationErrorMeters: number;
  readonly rmsQuantizationErrorMeters: number;
  readonly data: string;
}

export interface CheckedHeightArtifactGrid {
  readonly bodyId: string;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceDimensions: readonly number[];
  readonly verticalDatum: string;
  readonly derivationKernel: string;
  readonly width: number;
  readonly height: number;
  readonly minimumHeightMeters: number;
  readonly maximumHeightMeters: number;
  readonly noDataCount: number;
  readonly quantizationScaleMeters: number;
  readonly quantizationOffsetMeters: number;
  readonly worstQuantizationErrorMeters: number;
  readonly rmsQuantizationErrorMeters: number;
  readonly encodedInt16Base64: string;
}

export function checkedHeightGridFromEntry(entry: HeightAuthorityBuildEntry): CheckedHeightArtifactGrid;
export function checkedHeightArtifactDigest(grids: readonly CheckedHeightArtifactGrid[]): string;
