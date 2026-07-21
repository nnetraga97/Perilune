import type { DetailTileAddress, PlanetDetailSourceAdapter } from './sourceAdapter';

export interface ArcGisImageAdapterOptions {
  readonly datasetId: string;
  readonly bodyId: 'earth';
  readonly generation: string;
  readonly tileSize: number;
  readonly maxLevel: number;
  readonly maximumBytes: number;
  readonly coverage: readonly [number, number, number, number];
}

export class ArcGisImageAdapter implements PlanetDetailSourceAdapter {
  readonly datasetId;
  readonly bodyId;
  readonly generation;
  readonly tileSize;
  readonly maxLevel;
  readonly maximumBytes;
  readonly coverage;

  constructor(options: Readonly<ArcGisImageAdapterOptions>) {
    this.datasetId = options.datasetId;
    this.bodyId = options.bodyId;
    this.generation = options.generation;
    this.tileSize = options.tileSize;
    this.maxLevel = options.maxLevel;
    this.maximumBytes = options.maximumBytes;
    this.coverage = options.coverage;
  }

  matrix(level: number): Readonly<{ width: number; height: number }> {
    if (!Number.isInteger(level) || level < 0 || level > this.maxLevel) throw new RangeError('Invalid ArcGIS detail level');
    return Object.freeze({ width: 2 ** (level + 1), height: 2 ** level });
  }

  address(level: number, row: number, column: number): DetailTileAddress {
    const matrix = this.matrix(level);
    if (!Number.isInteger(row) || row < 0 || row >= matrix.height
      || !Number.isInteger(column) || column < 0 || column >= matrix.width) throw new RangeError('Invalid ArcGIS detail tile');
    const query = new URLSearchParams({ datasetId: this.datasetId, level: String(level), row: String(row), column: String(column) });
    return Object.freeze({
      datasetId: this.datasetId, level, row, column,
      matrixWidth: matrix.width, matrixHeight: matrix.height,
      tileSize: this.tileSize,
      url: `/api/planet-data?${query.toString()}`,
      cacheKey: `${this.generation}:${level}:${row}:${column}`,
      maximumBytes: this.maximumBytes,
    });
  }

  levelForProjectedFootprint(bodyRadius: number, latitudeRadians: number, metersPerPixel: number): number {
    const circumference = 2 * Math.PI * bodyRadius * Math.max(0.05, Math.cos(latitudeRadians));
    for (let level = 0; level <= this.maxLevel; level++) {
      const matrix = this.matrix(level);
      if (circumference / (matrix.width * this.tileSize) <= metersPerPixel * 1.5) return level;
    }
    return this.maxLevel;
  }
}
