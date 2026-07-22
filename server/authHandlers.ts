import type { SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { clientIp, HttpError, jsonError, jsonOk, methodNotAllowed, readJsonBody, requestId, safeHandlerError } from './http.js';
import { log } from './log.js';
import { rateLimitIdentity, rateLimitIpIdentity, type RateLimiter } from './rateLimit.js';

interface AuthInput { email?: unknown; password?: unknown }

export interface AuthHandlerDependencies {
  supabase: SupabaseClient;
  limiter: RateLimiter;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function accountCorrelation(email: string): string | undefined {
  const secret = process.env.LOG_CORRELATION_SECRET;
  return secret ? createHmac('sha256', secret).update(email).digest('hex').slice(0, 16) : undefined;
}

export function createAuthHandler(
  mode: 'signup' | 'login',
  dependencies: AuthHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = requestId(request);
    const requestLog = log.with({ requestId: id });
    if (request.method !== 'POST') return methodNotAllowed(['POST'], id);
    let email = '';
    try {
      const body = await readJsonBody<AuthInput>(request, 16 * 1024);
      email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const correlation = accountCorrelation(email);
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
        requestLog.warn(mode === 'signup' ? 'auth.signup.fail' : 'auth.login.fail', {
          ...(correlation ? { accountCorrelation: correlation } : {}), status: 503, reason: 'rate_limit_backend_unavailable',
        });
        return jsonError('AUTH_TEMPORARILY_UNAVAILABLE', 'Sign-in protection is temporarily unavailable.', 503, id, {
          'Retry-After': '30',
        });
      }
      if (!identityLimit.allowed || !ipLimit.allowed) {
        const retryAfter = Math.max(identityLimit.retryAfterSeconds, ipLimit.retryAfterSeconds);
        requestLog.warn('auth.ratelimited', { ...(correlation ? { accountCorrelation: correlation } : {}), status: 429, retryAfterSeconds: retryAfter });
        return jsonError('RATE_LIMITED', 'Too many attempts. Try again later.', 429, id, {
          'Retry-After': String(retryAfter),
        });
      }
      const result = mode === 'signup'
        ? await dependencies.supabase.auth.signUp({ email, password })
        : await dependencies.supabase.auth.signInWithPassword({ email, password });
      if (result.error || !result.data.user) {
        const message = mode === 'signup'
          ? 'Account creation failed. Check the address or try again later.'
          : 'Email or password is incorrect.';
        requestLog.info(mode === 'signup' ? 'auth.signup.fail' : 'auth.login.fail', {
          ...(correlation ? { accountCorrelation: correlation } : {}), status: 401, reason: 'provider_rejected',
        });
        return jsonError('AUTH_FAILED', message, 401, id);
      }
      if (mode === 'signup' && !result.data.session) {
        requestLog.info('auth.signup.pending', {
          ...(correlation ? { accountCorrelation: correlation } : {}), status: 202,
        });
        return jsonOk({ confirmationRequired: true }, 202);
      }
      if (!result.data.session) return jsonError('AUTH_FAILED', 'Email or password is incorrect.', 401, id);
      requestLog.info(mode === 'signup' ? 'auth.signup.ok' : 'auth.login.ok', {
        ...(correlation ? { accountCorrelation: correlation } : {}), userId: result.data.user.id, status: mode === 'signup' ? 201 : 200,
      });
      return jsonOk({
        session: {
          accessToken: result.data.session.access_token,
          refreshToken: result.data.session.refresh_token,
          expiresAt: result.data.session.expires_at ?? null,
        },
        user: { id: result.data.user.id, email: result.data.user.email ?? email },
      }, mode === 'signup' ? 201 : 200);
    } catch (error) {
      if (error instanceof HttpError) {
        requestLog.info(mode === 'signup' ? 'auth.signup.fail' : 'auth.login.fail', {
          ...(accountCorrelation(email) ? { accountCorrelation: accountCorrelation(email) } : {}), status: error.status, reason: error.code,
        });
      }
      return safeHandlerError(error, id);
    }
  };
}
