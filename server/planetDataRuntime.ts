import { clientIp } from './http.js';
import { RateLimiter, rateLimitIpIdentity } from './rateLimit.js';
import { createCacheStore } from './redis.js';

const DATASET_ID = 'usda-naip-ksc-2025-29992';
const UPSTREAM = 'https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer/exportImage';
const COVERAGE = Object.freeze({ west: -80.69, south: 28.56, east: -80.58, north: 28.69 });
const TILE_SIZE = 512;
const MAX_LEVEL = 18;
const MAX_RESPONSE_BYTES = 512 * 1024;
const LOCKED_MOSAIC_RULE = JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [29992] });
// Conservative July 2026 authorization threshold documented in
// docs/performance/reference/planet-detail-delivery-budget-2026-07.md.
export const PLANET_DETAIL_CONSERVATIVE_MONTHLY_ESTIMATE_USD = 400;

export interface PlanetDataRuntimeDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly monthlyCostCeilingUsd?: string;
  readonly limiter?: Pick<RateLimiter, 'consume'>;
}

let productionLimiter: RateLimiter | null = null;

function configuredLimiter(dependencies: Readonly<PlanetDataRuntimeDependencies>): Pick<RateLimiter, 'consume'> | null {
  if (dependencies.limiter) return dependencies.limiter;
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (!production) return null;
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;
  productionLimiter ??= new RateLimiter(createCacheStore({ redisUrl }));
  return productionLimiter;
}

async function authorizeInvocation(request: Request, dependencies: Readonly<PlanetDataRuntimeDependencies>): Promise<Response | null> {
  const limiter = configuredLimiter(dependencies);
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (!limiter) return production ? json(503, 'RATE_LIMIT_UNAVAILABLE', 'Planet detail rate limiting is not configured') : null;
  const identity = rateLimitIpIdentity(clientIp(request));
  const monthSeconds = 30 * 24 * 60 * 60;
  const [minute, perIpMonth, globalMonth] = await Promise.all([
    limiter.consume('planet-detail:ip-minute', identity, 256, 60),
    limiter.consume('planet-detail:ip-month', identity, 4_096, monthSeconds),
    limiter.consume('planet-detail:global-month', 'global', 1_008_000, monthSeconds),
  ]);
  if (!minute.backendAvailable || !perIpMonth.backendAvailable || !globalMonth.backendAvailable) {
    return json(503, 'RATE_LIMIT_UNAVAILABLE', 'Planet detail rate limiting is unavailable');
  }
  if (!minute.allowed || !perIpMonth.allowed || !globalMonth.allowed) {
    const retryAfter = Math.max(minute.retryAfterSeconds, perIpMonth.retryAfterSeconds, globalMonth.retryAfterSeconds);
    const response = json(429, 'RATE_LIMITED', 'Planet detail request budget is exhausted');
    response.headers.set('retry-after', String(retryAfter));
    return response;
  }
  return null;
}

function json(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
}

function exactInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function tileBounds(level: number, row: number, column: number): Readonly<{ west: number; south: number; east: number; north: number }> {
  const width = 2 ** (level + 1);
  const height = 2 ** level;
  const west = -180 + column * (360 / width);
  const east = -180 + (column + 1) * (360 / width);
  const north = 90 - row * (180 / height);
  const south = 90 - (row + 1) * (180 / height);
  return Object.freeze({ west, south, east, north });
}

function insideCoverage(bounds: Readonly<{ west: number; south: number; east: number; north: number }>): boolean {
  return bounds.west >= COVERAGE.west && bounds.east <= COVERAGE.east
    && bounds.south >= COVERAGE.south && bounds.north <= COVERAGE.north;
}

function costCeilingEnabled(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= PLANET_DETAIL_CONSERVATIVE_MONTHLY_ESTIMATE_USD;
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function planetDataRuntimeHandler(
  request: Request,
  dependencies: Readonly<PlanetDataRuntimeDependencies> = {},
): Promise<Response> {
  if (request.method !== 'GET') return json(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  const ceiling = dependencies.monthlyCostCeilingUsd ?? process.env.PLANET_DETAIL_MONTHLY_COST_CEILING_USD;
  if (!costCeilingEnabled(ceiling)) {
    return json(503, 'PLANET_DETAIL_DISABLED', 'Proxy-backed planet detail has no sufficient configured cost ceiling');
  }
  const rejected = await authorizeInvocation(request, dependencies);
  if (rejected) return rejected;
  const query = new URL(request.url).searchParams;
  const allowedParameters = new Set(['datasetId', 'level', 'row', 'column']);
  for (const key of query.keys()) {
    if (!allowedParameters.has(key) || query.getAll(key).length !== 1) {
      return json(400, 'INVALID_QUERY', 'Unsupported or repeated query parameter');
    }
  }
  if (query.get('datasetId') !== DATASET_ID) return json(404, 'DATASET_NOT_ALLOWED', 'Unknown planet dataset');
  const level = exactInteger(query.get('level'), 0, MAX_LEVEL);
  if (level === null) return json(400, 'INVALID_TILE', 'Invalid tile level');
  const matrixWidth = 2 ** (level + 1);
  const matrixHeight = 2 ** level;
  const row = exactInteger(query.get('row'), 0, matrixHeight - 1);
  const column = exactInteger(query.get('column'), 0, matrixWidth - 1);
  if (row === null || column === null) return json(400, 'INVALID_TILE', 'Invalid tile coordinate');
  const bounds = tileBounds(level, row, column);
  if (!insideCoverage(bounds)) return json(404, 'OUTSIDE_COVERAGE', 'Tile is outside the locked dataset coverage');

  const upstream = new URL(UPSTREAM);
  upstream.searchParams.set('bbox', `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`);
  upstream.searchParams.set('bboxSR', '4326');
  upstream.searchParams.set('imageSR', '4326');
  upstream.searchParams.set('size', `${TILE_SIZE},${TILE_SIZE}`);
  upstream.searchParams.set('format', 'jpg');
  upstream.searchParams.set('interpolation', 'RSP_BilinearInterpolation');
  upstream.searchParams.set('mosaicRule', LOCKED_MOSAIC_RULE);
  upstream.searchParams.set('f', 'image');

  const abort = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(upstream, {
      method: 'GET', signal: abort, redirect: 'error', headers: { accept: 'image/jpeg' },
    });
  } catch {
    return json(502, 'UPSTREAM_UNAVAILABLE', 'Planet detail source is unavailable');
  }
  if (!response.ok) return json(502, 'UPSTREAM_FAILURE', 'Planet detail source rejected the request');
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declaredBytes = Number(response.headers.get('content-length') ?? 0);
  if (mime !== 'image/jpeg' || declaredBytes > MAX_RESPONSE_BYTES) {
    return json(502, 'UPSTREAM_SCHEMA', 'Planet detail source returned an unexpected response');
  }
  const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  if (!bytes || bytes.byteLength < 32) {
    return json(502, 'UPSTREAM_SCHEMA', 'Planet detail source returned an invalid image');
  }
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800',
      'x-planet-dataset': DATASET_ID,
      'x-planet-cache-generation': 'OBJECTID-29992',
      'x-content-type-options': 'nosniff',
    },
  });
}
