import { describe, expect, it } from 'vitest';
import {
  safeAnalyticsProperties,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentryTransaction,
  stripQuery,
} from '../src/telemetry/privacy';

describe('telemetry privacy', () => {
  it('removes query strings and rejects unapproved analytics properties', () => {
    expect(stripQuery('https://perilune.test/?token=secret#fragment')).toBe('https://perilune.test/');
    expect(safeAnalyticsProperties('cloud_sync', {
      result: 'pending', email: 'pilot@example.com', slot: 'secret-mission',
    })).toEqual({ result: 'pending' });
  });

  it('keeps UUID-only user context and only sanitized deliberate breadcrumbs', () => {
    const event = scrubSentryEvent({
      message: 'Mission Secret failed',
      user: { id: 'uuid-1', email: 'pilot@example.com' },
      request: { url: 'https://perilune.test/?token=secret', headers: { authorization: 'Bearer secret' }, data: 'save' },
      breadcrumbs: [
        { category: 'console', message: 'craft name' },
        { category: 'perilune.cloud.sync.error', data: { requestId: 'req-1', token: 'secret', slot: 'mission' } },
      ],
      extra: { payload: 'save' },
      exception: { values: [{ type: 'Error', value: 'Secret craft', stacktrace: { frames: [] } }] },
    });
    expect(event.user).toEqual({ id: 'uuid-1' });
    expect(event.request).toEqual({ url: 'https://perilune.test/' });
    expect(event.message).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.breadcrumbs).toEqual([{
      category: 'perilune.cloud.sync.error',
      data: { requestId: 'req-1' },
      level: undefined,
      timestamp: undefined,
      type: 'default',
    }]);
    expect(event.exception?.values?.[0]?.value).toBeUndefined();
  });

  it('rejects automatic, unknown, and unsafe breadcrumbs', () => {
    expect(scrubSentryBreadcrumb({ category: 'fetch', data: { url: '/api/saves?token=secret' } })).toBeNull();
    expect(scrubSentryBreadcrumb({ category: 'perilune.unknown', data: { requestId: 'req-1' } })).toBeNull();
    expect(scrubSentryBreadcrumb({
      category: 'perilune.account.request.error',
      data: { operation: 'login', requestId: 'req-1', password: 'secret' },
    })?.data).toEqual({ operation: 'login', requestId: 'req-1' });
  });

  it('strips trace queries and arbitrary transaction metadata', () => {
    const transaction = scrubSentryTransaction({
      transaction: '/flight?token=secret',
      request: { url: 'https://perilune.test/flight?token=secret' },
      user: { id: 'pilot', email: 'pilot@example.com' },
      contexts: { trace: { trace_id: 'trace', span_id: 'span' }, unsafe: { save: 'payload' } },
      tags: { craft: 'secret' },
      spans: [{ span_id: 'child', trace_id: 'trace', start_timestamp: 1, timestamp: 2,
        description: 'GET /api/saves?slot=secret', data: { authorization: 'Bearer secret' } }],
    });
    expect(transaction.transaction).toBe('/flight');
    expect(transaction.request).toEqual({ url: 'https://perilune.test/flight' });
    expect(transaction.user).toBeUndefined();
    expect(transaction.tags).toBeUndefined();
    expect(transaction.contexts).toEqual({ trace: { trace_id: 'trace', span_id: 'span' } });
    expect(transaction.spans?.[0]?.description).toBe('GET /api/saves');
    expect(transaction.spans?.[0]?.data).toBeUndefined();
  });
});
