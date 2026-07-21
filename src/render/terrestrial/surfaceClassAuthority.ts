import authority from '../../generated/earth-surface-class-authority.json';
import { SurfaceClass, decodeSurfaceClassByte, type SurfaceClassCode } from './surfaceClass';
import type { SurfaceClassSampler } from './scatter';

interface EncodedRaster {
  readonly width: number;
  readonly height: number;
  readonly boundsDegrees: readonly [number, number, number, number];
  readonly runsBase64: string;
}

function decodeRuns(encoded: Readonly<EncodedRaster>): Uint8Array {
  const packed = Uint8Array.from(atob(encoded.runsBase64), (character) => character.charCodeAt(0));
  if (packed.length % 5 !== 0) throw new Error('Malformed surface-class run authority');
  const pixels = new Uint8Array(encoded.width * encoded.height);
  let cursor = 0;
  for (let offset = 0; offset < packed.length; offset += 5) {
    const code = decodeSurfaceClassByte(packed[offset]);
    const length = (packed[offset + 1]
      | packed[offset + 2] << 8
      | packed[offset + 3] << 16
      | packed[offset + 4] << 24) >>> 0;
    if (length === 0 || cursor + length > pixels.length) throw new Error('Surface-class run exceeds raster');
    pixels.fill(code, cursor, cursor + length);
    cursor += length;
  }
  if (cursor !== pixels.length) throw new Error('Surface-class run authority is incomplete');
  return pixels;
}

function sample(
  raster: Readonly<EncodedRaster>,
  pixels: Uint8Array,
  longitudeDegrees: number,
  latitudeDegrees: number,
): SurfaceClassCode {
  const [xmin, ymin, xmax, ymax] = raster.boundsDegrees;
  if (longitudeDegrees < xmin || longitudeDegrees > xmax || latitudeDegrees < ymin || latitudeDegrees > ymax) {
    return SurfaceClass.Unknown;
  }
  const u = (longitudeDegrees - xmin) / (xmax - xmin);
  const v = (ymax - latitudeDegrees) / (ymax - ymin);
  const x = Math.min(raster.width - 1, Math.max(0, Math.floor(u * raster.width)));
  const y = Math.min(raster.height - 1, Math.max(0, Math.floor(v * raster.height)));
  return decodeSurfaceClassByte(pixels[y * raster.width + x]);
}

let globalPixels: Uint8Array | undefined;
let regionalPixels: Uint8Array | undefined;

export function sampleEarthSurfaceClass(
  dirX: number,
  dirY: number,
  dirZ: number,
): SurfaceClassCode {
  const length = Math.hypot(dirX, dirY, dirZ);
  if (!(length > 0) || !Number.isFinite(length)) return SurfaceClass.Unknown;
  const longitude = Math.atan2(dirY, dirX) * 180 / Math.PI;
  const latitude = Math.asin(Math.max(-1, Math.min(1, dirZ / length))) * 180 / Math.PI;
  const regional = authority.regional as unknown as EncodedRaster;
  const child = sample(regional, regionalPixels ??= decodeRuns(regional), longitude, latitude);
  if (child !== SurfaceClass.Unknown) return child;
  const global = authority.global as unknown as EncodedRaster;
  return sample(global, globalPixels ??= decodeRuns(global), longitude, latitude);
}

export function createEarthSurfaceClassSampler(): SurfaceClassSampler {
  return sampleEarthSurfaceClass;
}
