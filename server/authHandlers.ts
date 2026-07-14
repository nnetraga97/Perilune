import type { SupabaseClient } from '@supabase/supabase-js';
import { clientIp, HttpError, jsonError, jsonOk, methodNotAllowed, readJsonBody, requestId, safeHandlerError } from './http.js';
import { rateLimitIdentity, rateLimitIpIdentity, type RateLimiter } from './rateLimit.js';

interface AuthInput { email?: unknown; password?: unknown }

export interface AuthHandlerDependencies {
  supabase: SupabaseClient;
  adminSupabase?: SupabaseClient;
  limiter: RateLimiter;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthHandler(
  mode: 'signup' | 'login',
  dependencies: AuthHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = requestId(request);
    if (request.method !== 'POST') return methodNotAllowed(['POST'], id);
    try {
      const body = await readJsonBody<AuthInput>(request, 16 * 1024);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!EMAIL.test(email) || email.length > 320) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address');
      if (password.length < 8 || password.length > 256) throw new HttpError(400, 'INVALID_PASSWORD', 'Password must be 8 to 256 characters');
      const ip = clientIp(request);
      const identityLimit = await dependencies.limiter.consume(
        `${mode}:identity`,
        rateLimitIdentity(email, ip),
        mode === 'signup' ? 5 : 10,
        mode === 'signup' ? 900 : 600,
      );
      const ipLimit = await dependencies.limiter.consume(
        `${mode}:ip`,
        rateLimitIpIdentity(ip),
        mode === 'signup' ? 20 : 60,
        mode === 'signup' ? 900 : 600,
      );
      if (!identityLimit.backendAvailable || !ipLimit.backendAvailable) {
        return jsonError('AUTH_TEMPORARILY_UNAVAILABLE', 'Sign-in protection is temporarily unavailable.', 503, id, {
          'Retry-After': '30',
        });
      }
      if (!identityLimit.allowed || !ipLimit.allowed) {
        const retryAfter = Math.max(identityLimit.retryAfterSeconds, ipLimit.retryAfterSeconds);
        return jsonError('RATE_LIMITED', 'Too many attempts. Try again later.', 429, id, {
          'Retry-After': String(retryAfter),
        });
      }
      if (mode === 'signup' && dependencies.adminSupabase) {
        const created = await dependencies.adminSupabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (created.error || !created.data.user) {
          return jsonError('AUTH_FAILED', 'Account creation failed. Check the address or try again later.', 401, id);
        }
      }
      const result = mode === 'signup' && !dependencies.adminSupabase
        ? await dependencies.supabase.auth.signUp({ email, password })
        : await dependencies.supabase.auth.signInWithPassword({ email, password });
      if (result.error || !result.data.session || !result.data.user) {
        const message = mode === 'signup'
          ? 'Account creation failed. Check the address or try again later.'
          : 'Email or password is incorrect.';
        return jsonError('AUTH_FAILED', message, 401, id);
      }
      return jsonOk({
        session: {
          accessToken: result.data.session.access_token,
          refreshToken: result.data.session.refresh_token,
          expiresAt: result.data.session.expires_at ?? null,
        },
        user: { id: result.data.user.id, email: result.data.user.email ?? email },
      }, mode === 'signup' ? 201 : 200);
    } catch (error) {
      return safeHandlerError(error, id);
    }
  };
}
