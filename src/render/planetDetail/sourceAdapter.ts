export interface DetailTileAddress {
  readonly datasetId: string;
  readonly level: number;
  readonly row: number;
  readonly column: number;
  readonly matrixWidth: number;
  readonly matrixHeight: number;
  readonly tileSize: number;
  readonly url: string;
  readonly cacheKey: string;
  readonly maximumBytes: number;
  readonly expectedMimeTypes?: readonly string[];
  readonly coverage?: readonly [number, number, number, number];
}

export interface PlanetDetailSourceAdapter {
  readonly datasetId: string;
  readonly bodyId: 'earth' | 'moon';
  readonly generation: string;
  readonly tileSize: number;
  readonly maxLevel: number;
  readonly maximumBytes: number;
  matrix(level: number): Readonly<{ width: number; height: number }>;
  address(level: number, row: number, column: number): DetailTileAddress;
  levelForProjectedFootprint(bodyRadius: number, latitudeRadians: number, metersPerPixel: number): number;
}

export function wrapColumn(column: number, width: number): number {
  return ((column % width) + width) % width;
}
