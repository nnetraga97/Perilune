import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createAuthHandler } from '../server/authHandlers';
import { RateLimiter } from '../server/rateLimit';
import type { CacheStore } from '../server/redis';

function cache(count = 1): CacheStore {
  return {
    getJson: async <T>() => null as T | null,
    setJson: async () => {}, delete: async () => {},
    increment: async () => ({ count, ttlSeconds: 60 }),
  };
}

function supabase(result: unknown): SupabaseClient {
  return { auth: {
    signUp: vi.fn().mockResolvedValue(result),
    signInWithPassword: vi.fn().mockResolvedValue(result),
  } } as unknown as SupabaseClient;
}

function loginRequest(body: unknown): Request {
  return new Request('https://perilune.test/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(body),
  });
}

describe('auth handlers', () => {
  it('shapes a successful session without returning the password', async () => {
    const handler = createAuthHandler('login', {
      limiter: new RateLimiter(cache()),
      supabase: supabase({
        error: null,
        data: {
          session: { access_token: 'access', refresh_token: 'refresh', expires_at: 123 },
          user: { id: 'user-1', email: 'pilot@example.com' },
        },
      }),
    });
    const response = await handler(loginRequest({ email: 'Pilot@Example.com', password: 'strong-password' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const text = await response.text();
    expect(text).not.toContain('strong-password');
    expect(JSON.parse(text)).toMatchObject({ ok: true, data: { user: { id: 'user-1', email: 'pilot@example.com' } } });
  });

  it('uses a neutral invalid-credential error and rate limits attempts', async () => {
    const failed = createAuthHandler('login', {
      limiter: new RateLimiter(cache()),
      supabase: supabase({ error: new Error('provider detail'), data: { session: null, user: null } }),
    });
    expect((await failed(loginRequest({ email: 'pilot@example.com', password: 'wrong-pass' }))).status).toBe(401);

    const limited = createAuthHandler('login', {
      limiter: new RateLimiter(cache(11)), supabase: supabase({}),
    });
    const response = await limited(loginRequest({ email: 'pilot@example.com', password: 'wrong-pass' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('uses the provider confirmation flow without issuing a session', async () => {
    const client = supabase({
      error: null,
      data: {
        session: null,
        user: { id: 'user-1', email: 'pilot@example.com' },
      },
    });
    const handler = createAuthHandler('signup', {
      limiter: new RateLimiter(cache()),
      supabase: client,
    });

    const response = await handler(loginRequest({ email: 'pilot@example.com', password: 'strong-password' }));

    expect(response.status).toBe(202);
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: 'pilot@example.com', password: 'strong-password',
    });
    expect(await response.json()).toMatchObject({ ok: true, data: { confirmationRequired: true } });
  });
});
