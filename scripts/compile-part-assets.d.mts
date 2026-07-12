export interface CheckedPartModel {
  assetId: string;
  partId: string;
  outputPath: string;
  sha256: string;
  triangles: number;
  transferBytes: number;
  gpuBytes: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  plumeAnchors: Array<{ position: [number, number, number]; rotation: [number, number, number, number]; scale: number }>;
}

export interface CheckedPartArtifact {
  schemaVersion: number;
  manifestSha256: string;
  manifest: { schemaVersion: number; models: CheckedPartModel[] };
}

export interface OptimizeArgs {
  inputPath: string;
  outputPath: string;
  simplifyRatio: number;
  textureMaxDimension: number;
  recipe: Record<string, unknown>;
}

export function compilePartAssets(options?: {
  root?: string;
  write?: boolean;
  optimize?: (args: OptimizeArgs) => Promise<void>;
}): Promise<CheckedPartArtifact>;
