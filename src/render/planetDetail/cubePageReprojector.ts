import { CUBE_FACE_BASES, terrainTileUvBounds, type TerrainTileId } from '../terrain/tile';

export interface EquirectAtlasPixels {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly matrixWidth: number;
  readonly matrixHeight: number;
  readonly startColumn: number;
  readonly startRow: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
}

export interface CubePagePixels {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pageSize: number;
  readonly gutter: number;
}

export interface NumericHeightAtlas {
  readonly values: Float32Array;
  readonly width: number;
  readonly height: number;
  /** Geographic bounds in degrees. Longitudes may be unwrapped past +/-180. */
  readonly boundsDegrees: readonly [number, number, number, number];
  readonly nodata?: number;
}

export interface CubeNormalPagePixels extends CubePagePixels {
  readonly minimumHeightMeters: number;
  readonly maximumHeightMeters: number;
  readonly sourceCellMeters: number;
  readonly validFraction: number;
}

export function directionForCubeFace(face: TerrainTileId['face'], u: number, v: number): readonly [number, number, number] {
  const basis = CUBE_FACE_BASES[face];
  const su = Math.tan(u * Math.PI / 4);
  const sv = Math.tan(v * Math.PI / 4);
  const x = basis.n[0] + basis.u[0] * su + basis.v[0] * sv;
  const y = basis.n[1] + basis.u[1] * su + basis.v[1] * sv;
  const z = basis.n[2] + basis.u[2] * su + basis.v[2] * sv;
  const inverse = 1 / Math.hypot(x, y, z);
  return [x * inverse, y * inverse, z * inverse];
}

function atlasCoordinate(atlas: Readonly<EquirectAtlasPixels>, direction: readonly [number, number, number]): readonly [number, number] | null {
  const longitude = Math.atan2(direction[1], direction[0]);
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction[2])));
  let pageX = (((longitude / (Math.PI * 2) + 0.5) % 1 + 1) % 1) * atlas.matrixWidth;
  if (pageX < atlas.startColumn) pageX += atlas.matrixWidth;
  if (pageX >= atlas.startColumn + atlas.gridWidth) pageX -= atlas.matrixWidth;
  const pageY = (0.5 - latitude / Math.PI) * atlas.matrixHeight;
  const localX = pageX - atlas.startColumn;
  const localY = pageY - atlas.startRow;
  if (localX < 0 || localY < 0 || localX >= atlas.gridWidth || localY >= atlas.gridHeight) return null;
  return [localX / atlas.gridWidth * atlas.width, localY / atlas.gridHeight * atlas.height];
}

function sampleBilinear(atlas: Readonly<EquirectAtlasPixels>, x: number, y: number, output: Uint8ClampedArray, offset: number): void {
  const x0 = Math.max(0, Math.min(atlas.width - 1, Math.floor(x - 0.5)));
  const y0 = Math.max(0, Math.min(atlas.height - 1, Math.floor(y - 0.5)));
  const x1 = Math.min(atlas.width - 1, x0 + 1);
  const y1 = Math.min(atlas.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - 0.5 - x0));
  const fy = Math.max(0, Math.min(1, y - 0.5 - y0));
  for (let channel = 0; channel < 4; channel++) {
    const a = atlas.pixels[(y0 * atlas.width + x0) * 4 + channel];
    const b = atlas.pixels[(y0 * atlas.width + x1) * 4 + channel];
    const c = atlas.pixels[(y1 * atlas.width + x0) * 4 + channel];
    const d = atlas.pixels[(y1 * atlas.width + x1) * 4 + channel];
    output[offset + channel] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
}

export function reprojectEquirectAtlasToCubePage(
  atlas: Readonly<EquirectAtlasPixels>,
  tile: Readonly<TerrainTileId>,
  pageSize = 256,
  gutter = 2,
): CubePagePixels {
  if (!Number.isInteger(pageSize) || pageSize < 2 || !Number.isInteger(gutter) || gutter < 1) {
    throw new RangeError('Cube detail pages require a positive size and gutter');
  }
  if (atlas.pixels.length !== atlas.width * atlas.height * 4) throw new Error('Invalid source atlas byte length');
  const outputSize = pageSize + gutter * 2;
  const output = new Uint8ClampedArray(outputSize * outputSize * 4);
  const { u0, v0, size } = terrainTileUvBounds(tile);
  for (let y = 0; y < outputSize; y++) {
    for (let x = 0; x < outputSize; x++) {
      const localX = (x - gutter + 0.5) / pageSize;
      const localY = (y - gutter + 0.5) / pageSize;
      const direction = directionForCubeFace(tile.face, u0 + localX * size, v0 + localY * size);
      const source = atlasCoordinate(atlas, direction);
      const offset = (y * outputSize + x) * 4;
      if (source) sampleBilinear(atlas, source[0], source[1], output, offset);
    }
  }
  return Object.freeze({ pixels: output, width: outputSize, height: outputSize, pageSize, gutter });
}

function numericHeightAt(atlas: Readonly<NumericHeightAtlas>, direction: readonly [number, number, number]): number | null {
  const [west, south, east, north] = atlas.boundsDegrees;
  const centerLongitude = (west + east) * 0.5;
  let longitude = Math.atan2(direction[1], direction[0]) * 180 / Math.PI;
  while (longitude - centerLongitude > 180) longitude -= 360;
  while (longitude - centerLongitude < -180) longitude += 360;
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction[2]))) * 180 / Math.PI;
  if (longitude < west || longitude > east || latitude < south || latitude > north) return null;
  const x = (longitude - west) / (east - west) * (atlas.width - 1);
  // ArcGIS exportImage rows run north to south.
  const y = (north - latitude) / (north - south) * (atlas.height - 1);
  const x0 = Math.max(0, Math.min(atlas.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(atlas.height - 1, Math.floor(y)));
  const x1 = Math.min(atlas.width - 1, x0 + 1);
  const y1 = Math.min(atlas.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = atlas.values[y0 * atlas.width + x0];
  const b = atlas.values[y0 * atlas.width + x1];
  const c = atlas.values[y1 * atlas.width + x0];
  const d = atlas.values[y1 * atlas.width + x1];
  const invalid = (value: number): boolean => !Number.isFinite(value)
    || (atlas.nodata !== undefined && value === atlas.nodata);
  if (invalid(a) || invalid(b) || invalid(c) || invalid(d)) return null;
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function surfacePosition(direction: readonly [number, number, number], radius: number, height: number): readonly [number, number, number] {
  const scale = radius + height;
  return [direction[0] * scale, direction[1] * scale, direction[2] * scale];
}

/**
 * Reprojects decoded scalar metres and derives an outward body-space shading
 * normal. It never changes a terrain vertex or a simulation contact query.
 */
export function reprojectHeightAtlasToCubeNormalPage(
  atlas: Readonly<NumericHeightAtlas>,
  tile: Readonly<TerrainTileId>,
  bodyRadius: number,
  pageSize = 256,
  gutter = 2,
): CubeNormalPagePixels {
  if (atlas.values.length !== atlas.width * atlas.height) throw new Error('Invalid numeric height atlas length');
  if (!(bodyRadius > 0) || !Number.isFinite(bodyRadius)) throw new RangeError('Body radius must be positive');
  const outputSize = pageSize + gutter * 2;
  const directions: Array<readonly [number, number, number]> = new Array(outputSize * outputSize);
  const heights = new Float64Array(outputSize * outputSize);
  const valid = new Uint8Array(outputSize * outputSize);
  const { u0, v0, size } = terrainTileUvBounds(tile);
  let minimumHeightMeters = Number.POSITIVE_INFINITY;
  let maximumHeightMeters = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < outputSize; y++) for (let x = 0; x < outputSize; x++) {
    const localX = (x - gutter + 0.5) / pageSize;
    const localY = (y - gutter + 0.5) / pageSize;
    const direction = directionForCubeFace(tile.face, u0 + localX * size, v0 + localY * size);
    const height = numericHeightAt(atlas, direction);
    const index = y * outputSize + x;
    directions[index] = direction;
    if (height !== null) {
      heights[index] = height;
      valid[index] = 1;
      minimumHeightMeters = Math.min(minimumHeightMeters, height);
      maximumHeightMeters = Math.max(maximumHeightMeters, height);
    }
  }

  const pixels = new Uint8ClampedArray(outputSize * outputSize * 4);
  let validCount = 0;
  const encode = (value: number): number => Math.round(Math.max(0, Math.min(1, value * 0.5 + 0.5)) * 255);
  for (let y = 0; y < outputSize; y++) for (let x = 0; x < outputSize; x++) {
    const center = y * outputSize + x;
    const westIndex = y * outputSize + Math.max(0, x - 1);
    const eastIndex = y * outputSize + Math.min(outputSize - 1, x + 1);
    const southIndex = Math.max(0, y - 1) * outputSize + x;
    const northIndex = Math.min(outputSize - 1, y + 1) * outputSize + x;
    const offset = center * 4;
    if (!valid[center] || !valid[westIndex] || !valid[eastIndex] || !valid[southIndex] || !valid[northIndex]) continue;
    const west = surfacePosition(directions[westIndex], bodyRadius, heights[westIndex]);
    const east = surfacePosition(directions[eastIndex], bodyRadius, heights[eastIndex]);
    const southPosition = surfacePosition(directions[southIndex], bodyRadius, heights[southIndex]);
    const northPosition = surfacePosition(directions[northIndex], bodyRadius, heights[northIndex]);
    const du = [east[0] - west[0], east[1] - west[1], east[2] - west[2]];
    const dv = [northPosition[0] - southPosition[0], northPosition[1] - southPosition[1], northPosition[2] - southPosition[2]];
    let nx = du[1] * dv[2] - du[2] * dv[1];
    let ny = du[2] * dv[0] - du[0] * dv[2];
    let nz = du[0] * dv[1] - du[1] * dv[0];
    const direction = directions[center];
    if (nx * direction[0] + ny * direction[1] + nz * direction[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const inverse = 1 / Math.max(1e-12, Math.hypot(nx, ny, nz));
    pixels[offset] = encode(nx * inverse);
    pixels[offset + 1] = encode(ny * inverse);
    pixels[offset + 2] = encode(nz * inverse);
    pixels[offset + 3] = 255;
    validCount++;
  }
  const centerLatitude = (atlas.boundsDegrees[1] + atlas.boundsDegrees[3]) * 0.5 * Math.PI / 180;
  const lonCell = Math.abs(atlas.boundsDegrees[2] - atlas.boundsDegrees[0]) * Math.PI / 180
    * bodyRadius * Math.max(0.01, Math.cos(centerLatitude)) / Math.max(1, atlas.width - 1);
  const latCell = Math.abs(atlas.boundsDegrees[3] - atlas.boundsDegrees[1]) * Math.PI / 180
    * bodyRadius / Math.max(1, atlas.height - 1);
  return Object.freeze({
    pixels,
    width: outputSize,
    height: outputSize,
    pageSize,
    gutter,
    minimumHeightMeters: Number.isFinite(minimumHeightMeters) ? minimumHeightMeters : 0,
    maximumHeightMeters: Number.isFinite(maximumHeightMeters) ? maximumHeightMeters : 0,
    sourceCellMeters: Math.max(lonCell, latCell),
    validFraction: validCount / (outputSize * outputSize),
  });
}
