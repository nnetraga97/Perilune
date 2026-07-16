import { describe, expect, it, vi } from 'vitest';
import { serverEnv } from '../server/env';
import { HttpError, jsonError, observeApiRequest, readJsonBody, requestId } from '../server/http';
import { rateLimitIdentity, RateLimiter } from '../server/rateLimit';
import type { CacheStore } from '../server/redis';

class CounterCache implements CacheStore {
  count = 0;
  async getJson<T>(): Promise<T | null> { return null; }
  async setJson(): Promise<void> {}
  async delete(): Promise<void> {}
  async increment(): Promise<{ count: number; ttlSeconds: number }> {
    return { count: ++this.count, ttlSeconds: 60 };
  }
}

describe('cloud API primitives', () => {
  it('requires server configuration without exposing values', () => {
    expect(() => serverEnv({})).toThrow('Cloud services are not configured');
    expect(serverEnv({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public' })).toEqual({
      supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'public',
      supabaseServiceRoleKey: null, redisUrl: null,
    });
  });

  it('returns stable sanitized errors', async () => {
    expect(await jsonError('BAD_REQUEST', 'Invalid request', 400, 'req-1').json()).toEqual({
      ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request', requestId: 'req-1' },
    });
  });

  it('uses one request ID across nested calls, logs once, and returns it on success and failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const request = new Request('https://perilune.test/api/saves?token=secret', {
      headers: { 'x-vercel-id': 'iad1::stable-id' },
    });
    expect(requestId(request)).toBe('iad1::stable-id');
    expect(requestId(request)).toBe('iad1::stable-id');
    const success = await observeApiRequest(request, async () => {
      expect(requestId(request)).toBe('iad1::stable-id');
      return Response.json({ ok: true });
    });
    expect(success.headers.get('x-request-id')).toBe('iad1::stable-id');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      event: 'api.request', requestId: 'iad1::stable-id', path: '/api/saves', status: 200,
    });

    info.mockClear();
    const failure = await observeApiRequest(new Request('https://perilune.test/api/saves'), async () => {
      throw new HttpError(400, 'BAD_REQUEST', 'Invalid request');
    });
    const body = await failure.json();
    expect(failure.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized JSON and hashes rate-limit identities', async () => {
    const request = new Request('https://perilune.test/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'large' }),
    });
    await expect(readJsonBody(request, 4)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' } satisfies Partial<HttpError>);
    expect(rateLimitIdentity('Player@Example.com', '127.0.0.1')).toMatch(/^[a-f0-9]{64}$/);
    expect(rateLimitIdentity('Player@Example.com', '127.0.0.1')).toBe(rateLimitIdentity('player@example.com', '127.0.0.1'));
  });

  it('enforces fixed-window limits while allowing Redis fallback count zero', async () => {
    const limiter = new RateLimiter(new CounterCache());
    expect((await limiter.consume('login', 'id', 1, 60)).allowed).toBe(true);
    expect((await limiter.consume('login', 'id', 1, 60)).allowed).toBe(false);
  });
});
