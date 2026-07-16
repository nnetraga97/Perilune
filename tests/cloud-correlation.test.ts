import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AccountRequestError, AuthService } from '../src/cloud/auth';
import { CloudClientError, CloudSaveClient } from '../src/cloud/client';

function authTokenService() {
  return { accessToken: vi.fn().mockResolvedValue('access') };
}

function supabaseClient(): SupabaseClient {
  return { auth: {
    setSession: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(),
  } } as unknown as SupabaseClient;
}

describe('client request correlation', () => {
  it('prefers a structured cloud error ID over response headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      ok: false, error: { code: 'SAVE_CONFLICT', message: 'Conflict', requestId: 'body-id' },
    }, { status: 409, headers: { 'x-request-id': 'header-id' } }));
    const client = new CloudSaveClient(authTokenService() as never, fetcher);
    await expect(client.read('mission')).rejects.toMatchObject({
      code: 'SAVE_CONFLICT', status: 409, requestId: 'body-id',
    } satisfies Partial<CloudClientError>);
  });

  it('uses the response header for malformed cloud responses and invents no network ID', async () => {
    const malformed = new CloudSaveClient(authTokenService() as never, vi.fn().mockResolvedValue(new Response('nope', {
      status: 502, headers: { 'x-request-id': 'header-id' },
    })));
    await expect(malformed.read('mission')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', requestId: 'header-id' });
    const offline = new CloudSaveClient(authTokenService() as never, vi.fn().mockRejectedValue(new Error('offline')));
    await expect(offline.read('mission')).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE', requestId: undefined });
  });

  it('preserves auth response IDs in typed errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'No', requestId: 'auth-body-id' },
    }, { status: 401, headers: { 'x-request-id': 'auth-header-id' } }));
    const auth = new AuthService(fetcher, supabaseClient());
    await expect(auth.signIn('pilot@example.com', 'password')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS', status: 401, requestId: 'auth-body-id',
    } satisfies Partial<AccountRequestError>);
  });
});
