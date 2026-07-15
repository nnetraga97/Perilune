import { Vec3 } from '../../src/core/vec3';

export interface AirlessGlobalMaps {
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly material: Uint8Array;
}

export interface AirlessGlobalMapOptions {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly albedo: Uint8Array;
  readonly heights: Float32Array;
}

const TAU = Math.PI * 2;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
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

/**
 * Builds body-space octahedral normals and a conservative airless material map
 * without changing the source albedo. Geometry, normals, and roughness all use
 * the same height raster so lighting remains stable across the longitude seam.
 */
export function generateAirlessGlobalMaps(options: AirlessGlobalMapOptions): AirlessGlobalMaps {
  const { width, height, radius, albedo, heights } = options;
  if (albedo.length !== width * height * 3) throw new Error('Airless albedo must be RGB8 at the target dimensions');
  if (heights.length !== width * height) throw new Error('Airless height raster dimensions do not match the albedo');

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

  const normal = new Uint8Array(width * height * 2);
  const material = new Uint8Array(width * height * 4);
  const direction = new Vec3();
  const eastDirection = new Vec3();
  const westDirection = new Vec3();
  const northDirection = new Vec3();
  const southDirection = new Vec3();
  const eastPosition = new Vec3();
  const westPosition = new Vec3();
  const northPosition = new Vec3();
  const southPosition = new Vec3();
  const tangentU = new Vec3();
  const tangentV = new Vec3();
  const surfaceNormal = new Vec3();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const eastIndex = y * width + ((x + 1) % width);
      const westIndex = y * width + ((x + width - 1) % width);
      const northIndex = Math.max(0, y - 1) * width + x;
      const southIndex = Math.min(height - 1, y + 1) * width + x;
      setPixelDirection(x, y, width, height, longitudeCos, longitudeSin, latitudeCos, latitudeSin, direction);
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

      const slope = 1 - Math.max(0, surfaceNormal.dot(direction));
      material[index * 4] = clampByte((0.9 - Math.min(0.18, slope * 1.5)) * 255); // roughness
      material[index * 4 + 1] = clampByte((0.96 - Math.min(0.16, slope * 0.8)) * 255); // ambient occlusion
      material[index * 4 + 2] = 0;
      // Keep the unused channel opaque. PNG palette optimizers are allowed to
      // discard RGB values hidden behind zero alpha, but these RGB channels are
      // shader data rather than display color.
      material[index * 4 + 3] = 255;
    }
  }

  return { albedo, normal, material };
}
