import { createHash } from 'node:crypto';
import { fbm3 } from '../../src/core/noise';
import { Vec3 } from '../../src/core/vec3';

export interface RawRaster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}

export interface VeyraCanonicalOptions {
  readonly width: number;
  readonly height: number;
  readonly source: RawRaster;
  readonly radius: number;
  readonly heightAt: (direction: Readonly<Vec3>) => number;
  readonly seed: number;
}

export interface VeyraCanonicalMaps {
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly material: Uint8Array;
  readonly clouds: Uint8Array;
  readonly heightS16le: Uint8Array;
  readonly rawHashes: Readonly<Record<'albedo' | 'normal' | 'material' | 'clouds', string>>;
  readonly texelHeightRange: number;
}

const TAU = Math.PI * 2;

export function directionFromEquirectUv(u: number, v: number): Vec3 {
  if (v <= 0) return new Vec3(0, 0, 1);
  if (v >= 1) return new Vec3(0, 0, -1);
  const longitude = (u - Math.floor(u)) * TAU - Math.PI;
  const latitude = (0.5 - v) * Math.PI;
  const cosLatitude = Math.cos(latitude);
  return new Vec3(
    cosLatitude * Math.cos(longitude),
    cosLatitude * Math.sin(longitude),
    Math.sin(latitude),
  );
}

function setPixelDirection(
  x: number,
  y: number,
  width: number,
  height: number,
  longitudeCos: Float64Array,
  longitudeSin: Float64Array,
  latitudeCos: Float64Array,
  latitudeSin: Float64Array,
  out: Vec3,
): Vec3 {
  const wrappedX = (x + width) % width;
  const clampedY = Math.max(0, Math.min(height - 1, y));
  return out.set(
    latitudeCos[clampedY] * longitudeCos[wrappedX],
    latitudeCos[clampedY] * longitudeSin[wrappedX],
    latitudeSin[clampedY],
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mixNumber(base: number, overlay: number, weight: number): number {
  const t = clamp01(weight);
  return base + (overlay - base) * t;
}

function writeOctNormal(normal: Readonly<Vec3>, output: Uint8Array, offset: number): void {
  const inverseLength = 1 / (Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z));
  let x = normal.x * inverseLength;
  let y = normal.y * inverseLength;
  const z = normal.z * inverseLength;
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * Math.sign(oldX || 1);
    y = (1 - Math.abs(oldX)) * Math.sign(y || 1);
  }
  output[offset] = clampByte((x * 0.5 + 0.5) * 255);
  output[offset + 1] = clampByte((y * 0.5 + 0.5) * 255);
}

export function decodeOctNormal(encodedX: number, encodedY: number): Vec3 {
  let x = (encodedX / 255) * 2 - 1;
  let y = (encodedY / 255) * 2 - 1;
  let z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * Math.sign(oldX || 1);
    y = (1 - Math.abs(oldX)) * Math.sign(y || 1);
  }
  return new Vec3(x, y, z).normalize();
}

export interface SourceColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function bilinearSourceChannel(
  source: RawRaster,
  northWest: number,
  northEast: number,
  southWest: number,
  southEast: number,
  tx: number,
  ty: number,
  channel: 0 | 1 | 2,
): number {
  return mixNumber(
    mixNumber(source.data[northWest + channel], source.data[northEast + channel], tx),
    mixNumber(source.data[southWest + channel], source.data[southEast + channel], tx),
    ty,
  );
}

function sourceColor(
  source: RawRaster,
  u: number,
  v: number,
  out: { r: number; g: number; b: number },
): SourceColor {
  const wrappedU = u - Math.floor(u);
  const scaledX = wrappedU * source.width - 0.5;
  const scaledY = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
  const x0Unwrapped = Math.floor(scaledX);
  const x0 = (x0Unwrapped + source.width) % source.width;
  const x1 = (x0 + 1) % source.width;
  const y0 = Math.floor(scaledY);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const tx = scaledX - x0Unwrapped;
  const ty = scaledY - y0;
  const northWest = (y0 * source.width + x0) * source.channels;
  const northEast = (y0 * source.width + x1) * source.channels;
  const southWest = (y1 * source.width + x0) * source.channels;
  const southEast = (y1 * source.width + x1) * source.channels;
  out.r = bilinearSourceChannel(source, northWest, northEast, southWest, southEast, tx, ty, 0);
  out.g = bilinearSourceChannel(source, northWest, northEast, southWest, southEast, tx, ty, 1);
  out.b = bilinearSourceChannel(source, northWest, northEast, southWest, southEast, tx, ty, 2);
  return out;
}

function directionColor(
  source: RawRaster,
  x: number,
  y: number,
  z: number,
  out: { r: number; g: number; b: number },
): SourceColor {
  const length = Math.hypot(x, y, z) || 1;
  const nx = x / length;
  const ny = y / length;
  const nz = Math.max(-1, Math.min(1, z / length));
  const u = Math.atan2(ny, nx) / TAU + 0.5;
  const v = 0.5 - Math.asin(nz) / Math.PI;
  const poleBlend = smoothstep(0.96, 0.9995, Math.abs(nz));
  sourceColor(source, u, v, out);
  if (poleBlend <= 0) return out;
  const directionalR = out.r;
  const directionalG = out.g;
  const directionalB = out.b;
  sourceColor(source, 0.5, v, out);
  out.r = mixNumber(directionalR, out.r, poleBlend);
  out.g = mixNumber(directionalG, out.g, poleBlend);
  out.b = mixNumber(directionalB, out.b, poleBlend);
  return out;
}

/**
 * Pole- and seam-safe Natural Earth color sampled from one deterministic
 * body-space rotation. Keeping a single projection preserves authored color
 * structure; the previous three-way luminance average visibly smeared it.
 */
export function sampleVeyraSourceColor(
  source: RawRaster,
  direction: Readonly<Vec3>,
  out: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 },
): SourceColor {
  return directionColor(source, direction.y, direction.z, direction.x, out);
}

/** Backwards-compatible luminance view used by source-sampling diagnostics. */
export function sampleVeyraSourceDetail(source: RawRaster, direction: Readonly<Vec3>): number {
  const color = sampleVeyraSourceColor(source, direction);
  return color.r * 0.21 + color.g * 0.72 + color.b * 0.07;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Produces every canonical Veyra channel from one body-fixed height grid.
 * Packed material channels match the shared terrestrial shader contract:
 * roughness, ambient occlusion, ocean mask, ice mask.
 */
export function generateVeyraCanonicalMaps(options: VeyraCanonicalOptions): VeyraCanonicalMaps {
  const { width, height, source, radius, heightAt, seed } = options;
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new Error('Canonical map dimensions must be integers of at least 2 texels');
  }
  if (source.data.byteLength !== source.width * source.height * source.channels) {
    throw new Error('Source raster byte length does not match its dimensions');
  }

  const heights = new Float32Array(width * height);
  const heightS16le = new Uint8Array(width * height * 2);
  const heightView = new DataView(heightS16le.buffer);
  const longitudeCos = new Float64Array(width);
  const longitudeSin = new Float64Array(width);
  const latitudeCos = new Float64Array(height);
  const latitudeSin = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    const longitude = ((x + 0.5) / width) * TAU - Math.PI;
    longitudeCos[x] = Math.cos(longitude);
    longitudeSin[x] = Math.sin(longitude);
  }
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    latitudeCos[y] = Math.cos(latitude);
    latitudeSin[y] = Math.sin(latitude);
  }
  const evaluationDirection = new Vec3();
  let texelHeightRange = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      setPixelDirection(
        x, y, width, height,
        longitudeCos, longitudeSin, latitudeCos, latitudeSin,
        evaluationDirection,
      );
      heights[index] = heightAt(evaluationDirection);
      const quantizedHeight = Math.round(heights[index] / 0.5);
      if (quantizedHeight < -32768 || quantizedHeight > 32767) {
        throw new Error(`Veyra canonical height exceeds signed-16 range at ${x},${y}`);
      }
      heightView.setInt16(index * 2, quantizedHeight, true);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const east = heights[y * width + ((x + 1) % width)];
      const west = heights[y * width + ((x + width - 1) % width)];
      const north = heights[Math.max(0, y - 1) * width + x];
      const south = heights[Math.min(height - 1, y + 1) * width + x];
      texelHeightRange = Math.max(
        texelHeightRange,
        Math.abs(heights[index] - east),
        Math.abs(heights[index] - west),
        Math.abs(heights[index] - north),
        Math.abs(heights[index] - south),
      );
    }
  }

  const albedo = new Uint8Array(width * height * 3);
  const normal = new Uint8Array(width * height * 2);
  const material = new Uint8Array(width * height * 4);
  const clouds = new Uint8Array(width * height * 2);
  const tangentU = new Vec3();
  const tangentV = new Vec3();
  const surfaceNormal = new Vec3();
  const eastPosition = new Vec3();
  const westPosition = new Vec3();
  const northPosition = new Vec3();
  const southPosition = new Vec3();
  const direction = new Vec3();
  const eastDirection = new Vec3();
  const westDirection = new Vec3();
  const northDirection = new Vec3();
  const southDirection = new Vec3();
  const sourceColor = { r: 0, g: 0, b: 0 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      setPixelDirection(
        x, y, width, height,
        longitudeCos, longitudeSin, latitudeCos, latitudeSin,
        direction,
      );
      const terrainHeight = heights[index];
      const eastIndex = y * width + ((x + 1) % width);
      const westIndex = y * width + ((x + width - 1) % width);
      const northIndex = Math.max(0, y - 1) * width + x;
      const southIndex = Math.min(height - 1, y + 1) * width + x;
      setPixelDirection(x + 1, y, width, height, longitudeCos, longitudeSin, latitudeCos, latitudeSin, eastDirection);
      setPixelDirection(x - 1, y, width, height, longitudeCos, longitudeSin, latitudeCos, latitudeSin, westDirection);
      setPixelDirection(x, y - 1, width, height, longitudeCos, longitudeSin, latitudeCos, latitudeSin, northDirection);
      setPixelDirection(x, y + 1, width, height, longitudeCos, longitudeSin, latitudeCos, latitudeSin, southDirection);
      eastPosition.copy(eastDirection).scale(radius + heights[eastIndex]);
      westPosition.copy(westDirection).scale(radius + heights[westIndex]);
      northPosition.copy(northDirection).scale(radius + heights[northIndex]);
      southPosition.copy(southDirection).scale(radius + heights[southIndex]);
      tangentU.copy(eastPosition).sub(westPosition);
      tangentV.copy(southPosition).sub(northPosition);
      Vec3.cross(tangentV, tangentU, surfaceNormal).normalize();
      if (surfaceNormal.dot(direction) < 0) surfaceNormal.negate();
      writeOctNormal(surfaceNormal, normal, index * 2);

      sampleVeyraSourceColor(source, direction, sourceColor);
      const sourceLuminance = sourceColor.r * 0.21 + sourceColor.g * 0.72 + sourceColor.b * 0.07;
      const ocean = terrainHeight < 0;
      const elevation = Math.max(-1, Math.min(1, terrainHeight / 8_000));
      if (ocean) {
        const depth = Math.min(1, -terrainHeight / 6_000);
        const sourceGain = 0.82 + (sourceLuminance / 255) * 0.36;
        albedo[index * 3] = clampByte(18 * sourceGain - depth * 4);
        albedo[index * 3 + 1] = clampByte(68 * sourceGain - depth * 18);
        albedo[index * 3 + 2] = clampByte(118 * sourceGain - depth * 28);
      } else {
        const latitude = Math.abs(direction.z);
        const moistureNoise = fbm3(direction.x * 3.4, direction.y * 3.4, direction.z * 3.4, seed + 91, 5);
        const temperatureNoise = fbm3(direction.x * 2.1, direction.y * 2.1, direction.z * 2.1, seed + 151, 4);
        const moisture = clamp01(0.52 + moistureNoise * 0.48);
        const temperature = clamp01(
          1 - Math.pow(latitude, 1.65) - Math.max(0, elevation) * 0.38 + temperatureNoise * 0.12,
        );
        const desertWeight = (1 - smoothstep(0.18, 0.5, moisture)) * smoothstep(0.32, 0.68, temperature);
        const forestWeight = smoothstep(0.42, 0.82, moisture) * smoothstep(0.16, 0.42, temperature);
        const rockWeight = smoothstep(0.24, 0.78, Math.max(0, elevation)) * (1 - forestWeight * 0.55);
        const snowWeight = (1 - smoothstep(0.04, 0.24, temperature)) * (0.62 + rockWeight * 0.38);
        let baseR = 101;
        let baseG = 121;
        let baseB = 76;
        baseR = mixNumber(baseR, 162, desertWeight);
        baseG = mixNumber(baseG, 132, desertWeight);
        baseB = mixNumber(baseB, 78, desertWeight);
        baseR = mixNumber(baseR, 48, forestWeight);
        baseG = mixNumber(baseG, 96, forestWeight);
        baseB = mixNumber(baseB, 62, forestWeight);
        baseR = mixNumber(baseR, 116, rockWeight);
        baseG = mixNumber(baseG, 112, rockWeight);
        baseB = mixNumber(baseB, 102, rockWeight);
        baseR = mixNumber(baseR, 198, snowWeight);
        baseG = mixNumber(baseG, 207, snowWeight);
        baseB = mixNumber(baseB, 205, snowWeight);
        // Preserve macro contrast and some chroma from the authored source,
        // while retaining Veyra's terrain-derived coastline and biome palette.
        const sourceGain = 0.7 + (sourceLuminance / 255) * 0.6;
        const neutral = Math.max(24, sourceLuminance);
        const sourceChromaR = Math.max(0.72, Math.min(1.28, sourceColor.r / neutral));
        const sourceChromaG = Math.max(0.72, Math.min(1.28, sourceColor.g / neutral));
        const sourceChromaB = Math.max(0.72, Math.min(1.28, sourceColor.b / neutral));
        albedo[index * 3] = clampByte(
          (baseR + elevation * 24) * sourceGain * mixNumber(1, sourceChromaR, 0.28),
        );
        albedo[index * 3 + 1] = clampByte(
          (baseG + elevation * 19) * sourceGain * mixNumber(1, sourceChromaG, 0.28),
        );
        albedo[index * 3 + 2] = clampByte(
          (baseB + elevation * 16) * sourceGain * mixNumber(1, sourceChromaB, 0.28),
        );
      }

      const radialAgreement = Math.max(0, surfaceNormal.dot(direction));
      const slope = 1 - radialAgreement;
      material[index * 4] = clampByte((ocean ? 0.24 : 0.76 - slope * 1.8) * 255); // roughness
      material[index * 4 + 1] = clampByte((0.82 - slope * 0.55) * 255); // ambient occlusion
      const localShoreWidth = Math.max(
        0.5,
        Math.abs(terrainHeight - heights[eastIndex]),
        Math.abs(terrainHeight - heights[westIndex]),
        Math.abs(terrainHeight - heights[northIndex]),
        Math.abs(terrainHeight - heights[southIndex]),
      );
      material[index * 4 + 2] = clampByte(
        smoothstep(localShoreWidth, -localShoreWidth, terrainHeight) * 255,
      );
      // Keep packed shader RGB opaque through PNG/browser decoding. Veyra's
      // renderer disables the Earth-only semantic use of this channel.
      material[index * 4 + 3] = 255;

      const warpNoise = fbm3(direction.x * 2.6, direction.y * 2.6, direction.z * 2.6, seed + 211, 3);
      const warpedX = direction.x * 3.4 + warpNoise * 0.72;
      const warpedY = direction.y * 3.4 - warpNoise * 0.48;
      const warpedZ = direction.z * 3.4 + warpNoise * 0.31;
      const broadCloud = fbm3(warpedX, warpedY, warpedZ, seed + 233, 5);
      const cloudDetail = fbm3(
        direction.x * 11.5 + broadCloud * 1.3,
        direction.y * 11.5 - broadCloud * 0.9,
        direction.z * 11.5 + broadCloud * 0.6,
        seed + 271,
        4,
      );
      const coverage = smoothstep(0.02, 0.42, broadCloud + cloudDetail * 0.28);
      const opticalDepth = coverage * (0.58 + smoothstep(-0.25, 0.5, cloudDetail) * 0.42);
      clouds[index * 2] = clampByte(coverage * 255);
      clouds[index * 2 + 1] = clampByte(opticalDepth * 255);
    }
  }

  // The rendered ocean/land boundary must remain derived from the same signed
  // height field used by terrain geometry and physics. This turns coastline
  // agreement into a compiler invariant instead of trusting two outputs that
  // merely happened to be produced in the same function.
  for (let index = 0; index < heights.length; index++) {
    if (heights[index] === 0) continue; // datum itself is an intentionally blended shoreline texel
    const heightSaysOcean = heights[index] < 0;
    const materialSaysOcean = material[index * 4 + 2] >= 128;
    if (heightSaysOcean !== materialSaysOcean) {
      const x = index % width;
      const y = Math.floor(index / width);
      throw new Error(`Veyra coastline mask disagrees with canonical height at ${x},${y}`);
    }
  }

  return {
    albedo,
    normal,
    material,
    clouds,
    heightS16le,
    rawHashes: {
      albedo: sha256(albedo),
      normal: sha256(normal),
      material: sha256(material),
      clouds: sha256(clouds),
    },
    texelHeightRange,
  };
}
