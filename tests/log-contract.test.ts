import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeChildFields, sanitizeLogFields } from '../src/telemetry/logContract';

describe('structured log field policy', () => {
  it('allows only event fields and strips reserved or secret-shaped inputs', () => {
    expect(sanitizeLogFields('api.request', {
      method: 'GET', path: '/api/saves?token=secret#fragment', status: 200, durationMs: 12,
      event: 'override', level: 'error', authorization: 'Bearer abc', body: { save: true },
    })).toEqual({ method: 'GET', path: '/api/saves', status: 200, durationMs: 12 });
    expect(sanitizeLogFields('auth.login.ok', {
      email: 'pilot@example.com', userId: 'user-1', password: 'never', ToKeN: 'never', status: 200,
    })).toEqual({ email: 'pilot@example.com', userId: 'user-1', status: 200 });
  });

  it('drops secret-bearing primitive values and bounds strings', () => {
    expect(sanitizeLogFields('auth.login.fail', {
      reason: 'token=super-secret', status: 401,
    })).toEqual({ status: 401 });
    expect(sanitizeLogFields('dep.redis.unavailable', {
      operation: 'read', reason: 'Bearer abc.def-123',
    })).toEqual({ operation: 'read' });
    expect(String(sanitizeLogFields('save.write.invalid', { reason: 'x'.repeat(900) }).reason)).toHaveLength(512);
  });

  it('never emits nested or non-finite values for arbitrary primitive-like input', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.oneof(
      fc.string(), fc.integer(), fc.boolean(), fc.constant(null),
      fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY), fc.array(fc.integer()),
    )), (input) => {
      const output = sanitizeLogFields('api.request', input);
      expect(Object.keys(output).every((key) => ['method', 'path', 'status', 'durationMs'].includes(key))).toBe(true);
      expect(Object.values(output).every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))).toBe(true);
      expect(Object.values(output).every((value) => typeof value !== 'number' || Number.isFinite(value))).toBe(true);
    }));
  });

  it('accepts only validated request IDs as child context', () => {
    expect(sanitizeChildFields({ requestId: 'iad1::abc-123', event: 'override' })).toEqual({ requestId: 'iad1::abc-123' });
    expect(sanitizeChildFields({ requestId: 'token=secret' })).toEqual({});
    expect(sanitizeChildFields({ requestId: { nested: true } })).toEqual({});
  });
});
