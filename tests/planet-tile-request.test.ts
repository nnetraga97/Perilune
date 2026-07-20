import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetailTileAddress } from '../src/render/planetDetail/sourceAdapter';
import { requestPlanetTile } from '../src/render/planetDetail/tileRequest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function address(key: string): DetailTileAddress {
  return {
    datasetId: 'test-source', level: 1, row: 0, column: 0,
    matrixWidth: 2, matrixHeight: 1, tileSize: 1,
    url: `https://tiles.test/${key}.jpg`, cacheKey: key, maximumBytes: 1024,
  };
}

describe('planet tile request boundary', () => {
  it('does not retry a permanent MIME/schema failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>error</html>', {
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(requestPlanetTile(address('invalid-mime'), new AbortController().signal)).rejects.toThrow(/Permanent/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not continue retrying after its generation is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchImpl);
    await expect(requestPlanetTile(address('aborted-generation'), controller.signal)).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('accepts only the explicitly declared numeric TIFF MIME for height pages', async () => {
    const numeric = { ...address('numeric-height'), expectedMimeTypes: ['image/tiff'] };
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(64), {
      headers: { 'content-type': 'image/tiff' },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(requestPlanetTile(numeric, new AbortController().signal)).resolves.toMatchObject({
      bytes: 64, cache: 'network',
    });
  });
});
