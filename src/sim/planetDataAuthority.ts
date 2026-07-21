import { CHECKED_HEIGHT_AUTHORITY_VERSION, sourceHeightGrid } from './sourceHeightAuthority';
import type { Body } from './universe';
import {
  KSC_3DEP_HEIGHT,
  type HeightImageAddress,
} from '../render/planetDetail/heightSourceAdapter';
import { decodeFloat32Tiff } from '../render/planetDetail/numericTiff';
import { kscNavd88ToEgm2008Correction } from '../render/planetDetail/heightDatum';
import { requestPlanetTile } from '../render/planetDetail/tileRequest';
import type { FrozenSourceHeightRegion } from './sourceHeightAuthority';
import moonSite01 from '../../assets/planets/moon-site01-authority.json';

export type PlanetAuthorityRequest = 'parent' | 'ksc-launch' | 'moon-site01';
export type PlanetAuthorityMode = 'resident-parent' | 'promoted-region';

export interface FrozenPlanetDataAuthority {
  readonly bodyId: string;
  readonly datasetId: string;
  readonly version: string;
  readonly coverage: readonly [number, number, number, number];
  readonly datum: string;
  /** Content-addressed generation frozen for the complete flight. */
  readonly generation: string;
  /** Stable positive scheduler generation derived from the content generation. */
  readonly terrainGeneration: number;
  readonly mode: PlanetAuthorityMode;
  readonly region: FrozenSourceHeightRegion | null;
  readonly fallbackReason?: string;
}

const installed = new WeakMap<Body, FrozenPlanetDataAuthority>();
const parents = new WeakMap<Body, FrozenPlanetDataAuthority>();
const promoted = new Map<string, FrozenPlanetDataAuthority>();

function generationNumber(generation: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < generation.length; index++) {
    hash ^= generation.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) + 1;
}

function parentAuthority(body: Body, fallbackReason?: string): FrozenPlanetDataAuthority {
  const cached = parents.get(body);
  if (cached && !fallbackReason) return cached;
  const grid = sourceHeightGrid(body.id);
  const generation = `${CHECKED_HEIGHT_AUTHORITY_VERSION}:${body.id}:parent`;
  const authority = Object.freeze({
    bodyId: body.id,
    datasetId: grid?.sourceId ?? `procedural-${body.id}`,
    version: grid?.sourceSha256 ?? `terrain-recipe-${body.def.terrainRecipeVersion}`,
    coverage: Object.freeze([-180, -90, 180, 90] as const),
    datum: grid?.verticalDatum ?? 'body reference sphere',
    generation,
    terrainGeneration: generationNumber(generation),
    mode: 'resident-parent' as const,
    region: null,
    ...(fallbackReason ? { fallbackReason } : {}),
  });
  if (!fallbackReason) parents.set(body, authority);
  return authority;
}

async function digestRegion(address: Readonly<HeightImageAddress>, samples: Float32Array): Promise<string> {
  const metadata = new TextEncoder().encode([
    address.datasetId,
    address.cacheKey,
    address.verticalDatum,
    address.engineDatum,
    address.bounds.join(','),
    address.width,
    address.height,
  ].join('|'));
  const sampleBytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const content = new Uint8Array(metadata.byteLength + sampleBytes.byteLength);
  content.set(metadata, 0);
  content.set(sampleBytes, metadata.byteLength);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', content);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0x811c9dc5;
  for (const value of content) hash = Math.imul(hash ^ value, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function prepareKscAuthority(body: Body): Promise<FrozenPlanetDataAuthority> {
  const source = KSC_3DEP_HEIGHT;
  const cached = promoted.get(`${body.id}:${source.generation}`);
  if (cached) return cached;
  const bounds = source.coverage;
  const address = source.request(bounds, 512, 512);
  const response = await requestPlanetTile(address, new AbortController().signal);
  const decoded = decodeFloat32Tiff(await response.blob.arrayBuffer(), 512 * 512);
  if (decoded.width !== address.width || decoded.height !== address.height) {
    throw new Error('KSC authority dimensions do not match the frozen request');
  }
  const samples = new Float32Array(decoded.values.length);
  let minimumHeightMeters = Number.POSITIVE_INFINITY;
  let maximumHeightMeters = Number.NEGATIVE_INFINITY;
  const [west, south, east, north] = bounds;
  for (let y = 0; y < decoded.height; y++) {
    const latitude = north - (y / (decoded.height - 1)) * (north - south);
    for (let x = 0; x < decoded.width; x++) {
      const longitude = west + (x / (decoded.width - 1)) * (east - west);
      const sourceHeight = decoded.values[y * decoded.width + x];
      if (!Number.isFinite(sourceHeight) || sourceHeight < -100 || sourceHeight > 250) {
        throw new Error(`KSC authority contains invalid height ${sourceHeight}`);
      }
      const height = sourceHeight + kscNavd88ToEgm2008Correction(longitude, latitude);
      samples[y * decoded.width + x] = height;
      minimumHeightMeters = Math.min(minimumHeightMeters, height);
      maximumHeightMeters = Math.max(maximumHeightMeters, height);
    }
  }
  const digest = await digestRegion(address, samples);
  const generation = `${source.generation}:${digest}`;
  const region: FrozenSourceHeightRegion = Object.freeze({
    datasetId: source.datasetId,
    version: source.generation,
    digest,
    coverage: Object.freeze([...bounds]) as unknown as readonly [number, number, number, number],
    verticalDatum: source.verticalDatum,
    engineDatum: source.engineDatum,
    width: decoded.width,
    height: decoded.height,
    /** Match the complete ETOPO parent over the outer ~1.1 km of the region. */
    blendBandDegrees: 0.01,
    minimumHeightMeters,
    maximumHeightMeters,
    samples,
  });
  const authority = Object.freeze({
    bodyId: body.id,
    datasetId: source.datasetId,
    version: source.generation,
    coverage: region.coverage,
    datum: source.engineDatum,
    generation,
    terrainGeneration: generationNumber(generation),
    mode: 'promoted-region' as const,
    region,
  });
  promoted.set(`${body.id}:${source.generation}`, authority);
  return authority;
}

async function prepareMoonSite01Authority(body: Body): Promise<FrozenPlanetDataAuthority> {
  const cached = promoted.get(`${body.id}:${moonSite01.version}`);
  if (cached) return cached;
  const response = await fetch(`/planets/${moonSite01.path}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Site 01 authority HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== moonSite01.byteLength) throw new Error('Site 01 authority byte length changed');
  if (!globalThis.crypto?.subtle) throw new Error('Site 01 authority requires SHA-256 support');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const digest = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (digest !== moonSite01.sha256) throw new Error('Site 01 authority checksum changed');
  const samples = new Float32Array(moonSite01.width * moonSite01.height);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const span = moonSite01.quantizationMaximumMeters - moonSite01.quantizationMinimumMeters;
  for (let index = 0; index < samples.length; index++) {
    samples[index] = moonSite01.quantizationMinimumMeters + view.getUint16(index * 2, true) / 65535 * span;
  }
  const region: FrozenSourceHeightRegion = Object.freeze({
    datasetId: moonSite01.datasetId,
    version: moonSite01.version,
    digest,
    coverage: Object.freeze([-180, -90, 180, -89] as const),
    verticalDatum: moonSite01.verticalDatum,
    engineDatum: moonSite01.verticalDatum,
    width: moonSite01.width,
    height: moonSite01.height,
    blendBandDegrees: 0,
    projection: 'south-polar-stereographic' as const,
    sphereRadiusMeters: moonSite01.sphereRadiusMeters,
    projectedExtentMeters: Object.freeze([...moonSite01.projectedExtentMeters]) as readonly [number, number, number, number],
    sampleOriginMeters: Object.freeze([...moonSite01.sampleOriginMeters]) as readonly [number, number],
    pixelSizeMeters: moonSite01.pixelSizeMeters,
    blendBandMeters: moonSite01.blendBandMeters,
    minimumHeightMeters: moonSite01.observedMinimumHeightMeters,
    maximumHeightMeters: moonSite01.observedMaximumHeightMeters,
    samples,
  });
  const generation = `${moonSite01.version}:${digest}`;
  const authority = Object.freeze({
    bodyId: body.id,
    datasetId: moonSite01.datasetId,
    version: moonSite01.version,
    coverage: region.coverage,
    datum: moonSite01.verticalDatum,
    generation,
    terrainGeneration: generationNumber(generation),
    mode: 'promoted-region' as const,
    region,
  });
  promoted.set(`${body.id}:${moonSite01.version}`, authority);
  return authority;
}

export function planetDataAuthorityForBody(body: Body): FrozenPlanetDataAuthority {
  return installed.get(body) ?? parentAuthority(body);
}

export function installPlanetDataAuthority(body: Body, authority: FrozenPlanetDataAuthority): void {
  if (authority.bodyId !== body.id) {
    throw new Error(`Cannot install ${authority.bodyId} authority on ${body.id}`);
  }
  installed.set(body, authority);
}

export async function preparePlanetDataAuthority(
  body: Body,
  request: PlanetAuthorityRequest,
): Promise<FrozenPlanetDataAuthority> {
  if (request === 'parent') return parentAuthority(body);
  if (request === 'moon-site01') {
    if (body.id !== 'moon') return parentAuthority(body);
    try {
      return await prepareMoonSite01Authority(body);
    } catch (error) {
      return parentAuthority(body, `Site 01 promotion unavailable: ${String(error)}`);
    }
  }
  if (body.id !== 'earth') return parentAuthority(body);
  try {
    return await prepareKscAuthority(body);
  } catch (error) {
    return parentAuthority(body, `KSC promotion unavailable: ${String(error)}`);
  }
}
