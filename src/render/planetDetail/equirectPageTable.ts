import type { PlanetDetailSourceAdapter } from './sourceAdapter';

export interface EquirectPageSelection {
  readonly level: number;
  readonly centerRow: number;
  readonly centerColumn: number;
  readonly startRow: number;
  readonly startColumn: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly signature: string;
}

export function selectEquirectPages(
  source: Readonly<PlanetDetailSourceAdapter>,
  level: number,
  direction: Readonly<{ x: number; y: number; z: number }>,
  gridWidth = 3,
  gridHeight = 3,
): EquirectPageSelection | null {
  const matrix = source.matrix(level);
  if (matrix.width < gridWidth || matrix.height < gridHeight) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return null;
  const longitude = Math.atan2(direction.y, direction.x);
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction.z / length)));
  const u = ((longitude / (Math.PI * 2) + 0.5) % 1 + 1) % 1;
  const v = Math.max(0, Math.min(1 - Number.EPSILON, 0.5 - latitude / Math.PI));
  const centerColumn = Math.min(matrix.width - 1, Math.floor(u * matrix.width));
  const centerRow = Math.min(matrix.height - 1, Math.floor(v * matrix.height));
  const startColumn = centerColumn - Math.floor(gridWidth / 2);
  const startRow = Math.max(0, Math.min(matrix.height - gridHeight, centerRow - Math.floor(gridHeight / 2)));
  return Object.freeze({
    level, centerRow, centerColumn, startRow, startColumn, gridWidth, gridHeight,
    signature: `${source.datasetId}/${source.generation}/${level}/${startRow}/${startColumn}/${gridWidth}x${gridHeight}`,
  });
}

