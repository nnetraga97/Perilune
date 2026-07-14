import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ServerEnv } from './env.js';
import { HttpError } from './http.js';

export function createAuthClient(env: ServerEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createAdminAuthClient(env: ServerEnv): SupabaseClient {
  if (!env.supabaseServiceRoleKey) {
    throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Account creation is not configured');
  }
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length <= 7) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to use cloud saves');
  }
  return header.slice(7);
}

export async function verifyUser(env: ServerEnv, request: Request): Promise<{ id: string; token: string }> {
  const token = bearerToken(request);
  const { data, error } = await createAuthClient(env).auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'AUTH_INVALID', 'Your session has expired');
  return { id: data.user.id, token };
}

export function createUserScopedClient(env: ServerEnv, token: string): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
