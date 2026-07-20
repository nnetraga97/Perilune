import type { DetailTileAddress, PlanetDetailSourceAdapter } from './sourceAdapter';
import { wrapColumn } from './sourceAdapter';

export interface WmtsAdapterOptions {
  readonly datasetId: string;
  readonly bodyId: 'earth' | 'moon';
  readonly generation: string;
  readonly tileSize: number;
  readonly matrices: readonly Readonly<{ width: number; height: number }>[];
  readonly maximumBytes: number;
  readonly urlFor: (level: number, row: number, column: number) => string;
}

export class WmtsAdapter implements PlanetDetailSourceAdapter {
  readonly datasetId: string;
  readonly bodyId: 'earth' | 'moon';
  readonly generation: string;
  readonly tileSize: number;
  readonly maxLevel: number;
  readonly maximumBytes: number;

  constructor(private readonly options: Readonly<WmtsAdapterOptions>) {
    this.datasetId = options.datasetId;
    this.bodyId = options.bodyId;
    this.generation = options.generation;
    this.tileSize = options.tileSize;
    this.maxLevel = options.matrices.length - 1;
    this.maximumBytes = options.maximumBytes;
  }

  matrix(level: number): Readonly<{ width: number; height: number }> {
    const matrix = this.options.matrices[level];
    if (!matrix) throw new Error(`${this.datasetId} does not define level ${level}`);
    return matrix;
  }

  address(level: number, row: number, column: number): DetailTileAddress {
    const matrix = this.matrix(level);
    if (!Number.isInteger(row) || row < 0 || row >= matrix.height) throw new Error(`Invalid ${this.datasetId} row ${row}`);
    const wrappedColumn = wrapColumn(column, matrix.width);
    const url = this.options.urlFor(level, row, wrappedColumn);
    return Object.freeze({
      datasetId: this.datasetId,
      level,
      row,
      column: wrappedColumn,
      matrixWidth: matrix.width,
      matrixHeight: matrix.height,
      tileSize: this.tileSize,
      url,
      maximumBytes: this.maximumBytes,
      cacheKey: `${this.datasetId}/${this.generation}/${level}/${row}/${wrappedColumn}`,
    });
  }

  levelForProjectedFootprint(bodyRadius: number, latitudeRadians: number, metersPerPixel: number): number {
    if (!(bodyRadius > 0) || !(metersPerPixel > 0)) return 0;
    const latitudeScale = Math.max(0.12, Math.cos(latitudeRadians));
    let selected = 0;
    for (let level = 0; level <= this.maxLevel; level++) {
      const matrix = this.matrix(level);
      const longitudeMeters = 2 * Math.PI * bodyRadius * latitudeScale / (matrix.width * this.tileSize);
      const latitudeMeters = Math.PI * bodyRadius / (matrix.height * this.tileSize);
      if (Math.max(longitudeMeters, latitudeMeters) <= metersPerPixel * 1.5) return level;
      selected = level;
    }
    return selected;
  }
}

