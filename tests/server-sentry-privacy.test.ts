import { describe, expect, it } from 'vitest';
import { scrubServerSentryEvent, scrubServerSentryTransaction } from '../server/sentry';

describe('server Sentry privacy', () => {
  it('keeps stack structure and allowlisted tags without error contents', () => {
    const event = scrubServerSentryEvent({
      type: undefined,
      tags: { requestId: 'req-1', event: 'api.error', email: 'pilot@example.com' },
      request: { url: 'https://perilune.test/api?token=secret', data: { password: 'secret' } },
      user: { id: 'pilot', email: 'pilot@example.com' },
      exception: { values: [{ type: 'Error', value: 'database password', stacktrace: { frames: [] } }] },
      extra: { save: 'payload' },
    });
    expect(event.tags).toEqual({ requestId: 'req-1', event: 'api.error' });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.exception?.values?.[0]?.value).toBeUndefined();
    expect(event.exception?.values?.[0]?.stacktrace).toEqual({ frames: [] });
  });

  it('removes transaction metadata and query-bearing span data', () => {
    const event = scrubServerSentryTransaction({
      transaction: 'GET /api/saves?slot=secret',
      request: { url: 'https://perilune.test/api/saves?slot=secret' },
      user: { email: 'pilot@example.com' },
      tags: { slot: 'secret' },
      contexts: { trace: { trace_id: 'trace', span_id: 'root' }, unsafe: { body: 'save' } },
      spans: [{ span_id: 'child', trace_id: 'trace', start_timestamp: 1, timestamp: 2,
        description: 'POST https://db.test/rest?user=pilot', data: { token: 'secret' } }],
    });
    expect(event.transaction).toBe('GET /api/saves');
    expect(event.request).toEqual({ url: 'https://perilune.test/api/saves' });
    expect(event.user).toBeUndefined();
    expect(event.tags).toBeUndefined();
    expect(event.contexts).toEqual({ trace: { trace_id: 'trace', span_id: 'root' } });
    expect(event.spans?.[0]?.description).toBe('POST https://db.test/rest');
    expect(event.spans?.[0]?.data).toBeUndefined();
  });
});
