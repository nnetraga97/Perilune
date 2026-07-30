import { describe, expect, it, vi } from 'vitest';
import { planetDataRuntimeHandler } from '../server/planetDataRuntime';

function kscTile(level = 18): Readonly<{ level: number; row: number; column: number }> {
  const longitude = -80.621;
  const latitude = 28.6272;
  return Object.freeze({
    level,
    column: Math.floor((longitude + 180) / 360 * 2 ** (level + 1)),
    row: Math.floor((90 - latitude) / 180 * 2 ** level),
  });
}

function request(query: string): Request {
  return new Request(`https://perilune.test/api/planet-data?${query}`);
}

function jpegResponse(): Response {
  return new Response(new Uint8Array(64).fill(0x2a), {
    headers: { 'content-type': 'image/jpeg', 'content-length': '64' },
  });
}

describe('planet data API', () => {
  it('defaults proxy-backed detail off without the configured cost ceiling', async () => {
    const tile = kscTile();
    const response = await planetDataRuntimeHandler(request(new URLSearchParams({
      datasetId: 'usda-naip-ksc-2025-29992', level: String(tile.level), row: String(tile.row), column: String(tile.column),
    }).toString()), { monthlyCostCeilingUsd: '' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'PLANET_DETAIL_DISABLED' } });
  });

  it('constructs the locked upstream request itself and returns bounded cacheable JPEG data', async () => {
    const tile = kscTile();
    let requestedUrl: URL | null = null;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      requestedUrl = new URL(String(input));
      return jpegResponse();
    });
    const response = await planetDataRuntimeHandler(request(new URLSearchParams({
      datasetId: 'usda-naip-ksc-2025-29992', level: String(tile.level), row: String(tile.row), column: String(tile.column),
    }).toString()), { monthlyCostCeilingUsd: '500', fetchImpl });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-planet-dataset')).toBe('usda-naip-ksc-2025-29992');
    expect(response.headers.get('cache-control')).toContain('s-maxage=2592000');
    const upstream = requestedUrl!;
    expect(upstream.hostname).toBe('apps.geo.fpac.usda.gov');
    expect(upstream.searchParams.get('mosaicRule')).toContain('29992');
    expect(upstream.searchParams.get('size')).toBe('512,512');
  });

  it('allows the complete 3x3 render neighborhood at the KSC coverage edges', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jpegResponse());
    const edgeTiles = [
      // Exact production regression: overlaps coverage but is not fully contained.
      { level: 12, row: 1395, column: 2261 },
      // Outermost 3x3 neighbors when the camera is at each coverage corner.
      { level: 12, row: 1394, column: 2258 },
      { level: 12, row: 1394, column: 2263 },
      { level: 12, row: 1399, column: 2258 },
      { level: 12, row: 1399, column: 2263 },
    ];

    for (const tile of edgeTiles) {
      const response = await planetDataRuntimeHandler(request(new URLSearchParams({
        datasetId: 'usda-naip-ksc-2025-29992',
        level: String(tile.level),
        row: String(tile.row),
        column: String(tile.column),
      }).toString()), { monthlyCostCeilingUsd: '500', fetchImpl });
      expect(response.status).toBe(200);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(edgeTiles.length);
  });

  it('keeps coarser and beyond-neighborhood imagery requests blocked', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jpegResponse());
    const coarse = await planetDataRuntimeHandler(request(
      'datasetId=usda-naip-ksc-2025-29992&level=11&row=697&column=1130',
    ), { monthlyCostCeilingUsd: '500', fetchImpl });
    expect(coarse.status).toBe(400);

    const beyond = await planetDataRuntimeHandler(request(
      'datasetId=usda-naip-ksc-2025-29992&level=12&row=1393&column=2261',
    ), { monthlyCostCeilingUsd: '500', fetchImpl });
    expect(beyond.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects arbitrary inputs, out-of-coverage tiles, and oversized responses', async () => {
    const arbitrary = await planetDataRuntimeHandler(request('datasetId=usda-naip-ksc-2025-29992&level=18&row=1&column=1&url=https://evil.test'), { monthlyCostCeilingUsd: '500' });
    expect(arbitrary.status).toBe(400);
    expect(await arbitrary.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });

    const outside = await planetDataRuntimeHandler(request('datasetId=usda-naip-ksc-2025-29992&level=18&row=0&column=0'), { monthlyCostCeilingUsd: '500' });
    expect(outside.status).toBe(404);

    const tile = kscTile();
    const oversized = await planetDataRuntimeHandler(request(new URLSearchParams({
      datasetId: 'usda-naip-ksc-2025-29992', level: String(tile.level), row: String(tile.row), column: String(tile.column),
    }).toString()), {
      monthlyCostCeilingUsd: '500',
      fetchImpl: vi.fn(async () => new Response(new Uint8Array(32), {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(2 * 1024 * 1024 + 1) },
      })),
    });
    expect(oversized.status).toBe(502);
  });

  it('fails closed when the production limiter is unavailable and honors a limiter denial', async () => {
    const previous = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'production';
    const tile = kscTile();
    const url = new URLSearchParams({ datasetId: 'usda-naip-ksc-2025-29992', level: String(tile.level), row: String(tile.row), column: String(tile.column) }).toString();
    try {
      const unavailable = await planetDataRuntimeHandler(request(url), { monthlyCostCeilingUsd: '500' });
      expect(unavailable.status).toBe(503);
      const denied = await planetDataRuntimeHandler(request(url), {
        monthlyCostCeilingUsd: '500',
        limiter: { consume: async () => ({ allowed: false, retryAfterSeconds: 60, backendAvailable: true }) },
      });
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBe('60');
    } finally {
      if (previous === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previous;
    }
  });
});
