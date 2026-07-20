export interface HeightSourceDefinition {
  readonly bodyId: 'earth' | 'moon';
  readonly sourceId: string;
  readonly relativePath: string;
  readonly sourceDimensions: readonly [number, number];
  readonly storage: 'float32-metres' | 'uint16-scaled-metres';
  readonly valueScale: number;
  readonly valueOffset: number;
  readonly verticalDatum: string;
  readonly validRange: readonly [number, number];
}

export interface ScientificHeightDerivative {
  readonly heights: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly noDataCount: number;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly verticalDatum: string;
  readonly kernel: string;
}

export const HEIGHT_SOURCE_DEFINITIONS: Readonly<{
  earthSurface: HeightSourceDefinition;
  earthBedrock: HeightSourceDefinition;
  moon: HeightSourceDefinition;
}>;
export const NUMERIC_HEIGHT_KERNEL: string;
export function sourceSha256(root: string, definition: HeightSourceDefinition): Promise<string>;
export function deriveScientificHeight(
  root: string,
  definition: HeightSourceDefinition,
  width: number,
  height: number,
): Promise<ScientificHeightDerivative>;
export function encodeHalfMetreInt16(heights: Float32Array): Readonly<{
  encoded: Buffer;
  scaleMeters: number;
  offsetMeters: number;
  worstQuantizationErrorMeters: number;
  rmsQuantizationErrorMeters: number;
}>;
