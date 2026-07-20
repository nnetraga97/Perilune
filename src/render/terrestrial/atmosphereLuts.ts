import * as THREE from 'three';
import type { AtmosphereDef } from '../../sim/universe';
import type { AtmosphereVisualCoefficients } from './atmosphereMaterial';

export interface AtmosphereLutSet {
  readonly transmittance: THREE.DataTexture;
  readonly multipleScattering: THREE.DataTexture;
  readonly skyView: THREE.DataTexture;
  readonly aerialPerspective: THREE.DataTexture;
  readonly textures: readonly THREE.DataTexture[];
}

const TRANSMITTANCE_WIDTH = 128;
const TRANSMITTANCE_HEIGHT = 32;
const MULTI_SCATTER_WIDTH = 32;
const MULTI_SCATTER_HEIGHT = 32;
const SKY_VIEW_WIDTH = 64;
const SKY_VIEW_HEIGHT = 32;
const AERIAL_WIDTH = 32;
const AERIAL_HEIGHT = 32;
const INTEGRATION_SAMPLES = 32;
const EARTH_RAYLEIGH = [5.802e-6, 13.558e-6, 33.1e-6] as const;
const EARTH_MIE = 3.996e-6;
interface CachedAtmosphereLutData {
  readonly transmittance: Uint8Array<ArrayBuffer>;
  readonly multipleScattering: Uint8Array<ArrayBuffer>;
  readonly skyView: Uint8Array<ArrayBuffer>;
  readonly aerialPerspective: Uint8Array<ArrayBuffer>;
}
const LUT_DATA_CACHE = new Map<string, CachedAtmosphereLutData>();

function raySphereFar(radial: number, mu: number, sphereRadius: number): number {
  const discriminant = radial * radial * (mu * mu - 1) + sphereRadius * sphereRadius;
  return discriminant <= 0 ? 0 : -radial * mu + Math.sqrt(discriminant);
}

function raySphereNear(radial: number, mu: number, sphereRadius: number): number | null {
  const discriminant = radial * radial * (mu * mu - 1) + sphereRadius * sphereRadius;
  if (discriminant < 0) return null;
  const distance = -radial * mu - Math.sqrt(discriminant);
  return distance > 0 ? distance : null;
}

export function atmosphereScatteringCoefficients(
  physical: Readonly<AtmosphereDef>,
  visual: Readonly<AtmosphereVisualCoefficients>,
): { rayleigh: readonly number[]; mie: number; mieScaleHeight: number } {
  const densityScale = Math.max(0.05, physical.seaLevelDensity / 1.225);
  return {
    rayleigh: EARTH_RAYLEIGH.map((value, channel) =>
      value * densityScale * visual.wavelengthTint[channel] * visual.strength),
    mie: EARTH_MIE * densityScale * visual.strength,
    mieScaleHeight: Math.max(800, physical.scaleHeight * 0.16),
  };
}

function encodeTexture(data: Uint8Array<ArrayBuffer>, width: number, height: number, kind: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.userData.atmosphereLut = kind;
  return texture;
}

function transmittanceAt(
  radius: number,
  physical: Readonly<AtmosphereDef>,
  rayleigh: readonly number[],
  mie: number,
  mieScaleHeight: number,
  altitude: number,
  mu: number,
): readonly [number, number, number] {
  const radial = radius + altitude;
  const atmosphereRadius = radius + physical.height;
  const groundDistance = raySphereNear(radial, mu, radius);
  const topDistance = raySphereFar(radial, mu, atmosphereRadius);
  if (groundDistance !== null && groundDistance < topDistance) return [0, 0, 0];
  if (!(topDistance > 0)) return [1, 1, 1];
  const step = topDistance / INTEGRATION_SAMPLES;
  let rayleighDepth = 0;
  let mieDepth = 0;
  for (let index = 0; index < INTEGRATION_SAMPLES; index++) {
    const distance = (index + 0.5) * step;
    const sampleRadius = Math.sqrt(radial * radial + distance * distance + 2 * radial * mu * distance);
    const sampleAltitude = Math.max(0, sampleRadius - radius);
    rayleighDepth += Math.exp(-sampleAltitude / physical.scaleHeight) * step;
    mieDepth += Math.exp(-sampleAltitude / mieScaleHeight) * step;
  }
  return [0, 1, 2].map((channel) =>
    Math.exp(-(rayleigh[channel] * rayleighDepth + mie * mieDepth))) as [number, number, number];
}

/**
 * Hillaire-style atmosphere foundation: low-dimensional transmittance and
 * isotropic multiple-scattering energy tables, rebuilt from body physics.
 */
export function createAtmosphereLuts(
  radius: number,
  physical: Readonly<AtmosphereDef>,
  visual: Readonly<AtmosphereVisualCoefficients>,
): AtmosphereLutSet {
  const { rayleigh, mie, mieScaleHeight } = atmosphereScatteringCoefficients(physical, visual);
  const cacheKey = JSON.stringify([
    radius, physical.height, physical.scaleHeight, physical.seaLevelDensity,
    visual.wavelengthTint, visual.strength,
  ]);
  let cached = LUT_DATA_CACHE.get(cacheKey);
  if (!cached) {
    const transmittanceData = new Uint8Array(TRANSMITTANCE_WIDTH * TRANSMITTANCE_HEIGHT * 4);
    for (let y = 0; y < TRANSMITTANCE_HEIGHT; y++) {
      const mu = ((y + 0.5) / TRANSMITTANCE_HEIGHT) * 2 - 1;
      for (let x = 0; x < TRANSMITTANCE_WIDTH; x++) {
        const heightUnit = (x + 0.5) / TRANSMITTANCE_WIDTH;
        const altitude = heightUnit * heightUnit * physical.height;
        const value = transmittanceAt(radius, physical, rayleigh, mie, mieScaleHeight, altitude, mu);
        const offset = (y * TRANSMITTANCE_WIDTH + x) * 4;
        transmittanceData[offset] = Math.round(value[0] * 255);
        transmittanceData[offset + 1] = Math.round(value[1] * 255);
        transmittanceData[offset + 2] = Math.round(value[2] * 255);
        transmittanceData[offset + 3] = 255;
      }
    }

    const multipleData = new Uint8Array(MULTI_SCATTER_WIDTH * MULTI_SCATTER_HEIGHT * 4);
    for (let y = 0; y < MULTI_SCATTER_HEIGHT; y++) {
      const sunMu = ((y + 0.5) / MULTI_SCATTER_HEIGHT) * 2 - 1;
      for (let x = 0; x < MULTI_SCATTER_WIDTH; x++) {
        const heightUnit = (x + 0.5) / MULTI_SCATTER_WIDTH;
        const altitude = heightUnit * heightUnit * physical.height;
        const direct = transmittanceAt(radius, physical, rayleigh, mie, mieScaleHeight, altitude, sunMu);
        const density = Math.exp(-altitude / physical.scaleHeight);
        const recovery = 0.12 + density * 0.24;
        const offset = (y * MULTI_SCATTER_WIDTH + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          multipleData[offset + channel] = Math.round(Math.min(1, (1 - direct[channel]) * recovery) * 255);
        }
        multipleData[offset + 3] = 255;
      }
    }
    const skyViewData = new Uint8Array(SKY_VIEW_WIDTH * SKY_VIEW_HEIGHT * 4);
    for (let y = 0; y < SKY_VIEW_HEIGHT; y++) {
      const sunMu = ((y + 0.5) / SKY_VIEW_HEIGHT) * 2 - 1;
      const sunTransmittance = transmittanceAt(radius, physical, rayleigh, mie, mieScaleHeight, 0, sunMu);
      for (let x = 0; x < SKY_VIEW_WIDTH; x++) {
        const viewMu = ((x + 0.5) / SKY_VIEW_WIDTH) * 2 - 1;
        const horizon = Math.exp(-Math.abs(viewMu) * 3.2);
        const forward = Math.pow(Math.max(0, viewMu * sunMu + Math.sqrt(Math.max(0, 1 - viewMu * viewMu)) *
          Math.sqrt(Math.max(0, 1 - sunMu * sunMu))), 6);
        const offset = (y * SKY_VIEW_WIDTH + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const rayleighSky = (1 - sunTransmittance[channel]) * (0.22 + horizon * 0.78);
          const mieGlow = forward * (1 - sunTransmittance[channel]) * 0.34;
          skyViewData[offset + channel] = Math.round(Math.min(1, rayleighSky + mieGlow) * 255);
        }
        skyViewData[offset + 3] = 255;
      }
    }

    const aerialData = new Uint8Array(AERIAL_WIDTH * AERIAL_HEIGHT * 4);
    for (let y = 0; y < AERIAL_HEIGHT; y++) {
      const altitude = ((y + 0.5) / AERIAL_HEIGHT) * physical.height;
      const density = Math.exp(-altitude / physical.scaleHeight);
      for (let x = 0; x < AERIAL_WIDTH; x++) {
        const distance = ((x + 0.5) / AERIAL_WIDTH) * 200_000;
        const transmittance = [0, 1, 2].map((channel) =>
          Math.exp(-(rayleigh[channel] + mie) * density * distance));
        const offset = (y * AERIAL_WIDTH + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          aerialData[offset + channel] = Math.round(Math.min(1, (1 - transmittance[channel]) * 1.8) * 255);
        }
        aerialData[offset + 3] = Math.round((1 - (transmittance[0] + transmittance[1] + transmittance[2]) / 3) * 255);
      }
    }
    cached = Object.freeze({
      transmittance: transmittanceData,
      multipleScattering: multipleData,
      skyView: skyViewData,
      aerialPerspective: aerialData,
    });
    LUT_DATA_CACHE.set(cacheKey, cached);
  }

  const transmittance = encodeTexture(
    cached.transmittance,
    TRANSMITTANCE_WIDTH,
    TRANSMITTANCE_HEIGHT,
    'transmittance',
  );
  const multipleScattering = encodeTexture(
    cached.multipleScattering,
    MULTI_SCATTER_WIDTH,
    MULTI_SCATTER_HEIGHT,
    'multiple-scattering',
  );
  const skyView = encodeTexture(cached.skyView, SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT, 'sky-view');
  const aerialPerspective = encodeTexture(
    cached.aerialPerspective,
    AERIAL_WIDTH,
    AERIAL_HEIGHT,
    'aerial-perspective',
  );
  return Object.freeze({
    transmittance,
    multipleScattering,
    skyView,
    aerialPerspective,
    textures: Object.freeze([transmittance, multipleScattering, skyView, aerialPerspective]),
  });
}
