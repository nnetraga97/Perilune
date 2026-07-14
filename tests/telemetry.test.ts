import { describe, expect, it } from 'vitest';
import { safeAnalyticsProperties, scrubSentryEvent, stripQuery } from '../src/telemetry/privacy';

describe('telemetry privacy', () => {
  it('removes query strings and rejects unapproved analytics properties', () => {
    expect(stripQuery('https://perilune.test/?token=secret#fragment')).toBe('https://perilune.test/');
    expect(safeAnalyticsProperties('cloud_sync', {
      result: 'pending', email: 'pilot@example.com', slot: 'secret-mission',
    })).toEqual({ result: 'pending' });
  });

  it('keeps UUID-only user context and strips event contents', () => {
    const event = scrubSentryEvent({
      message: 'Mission Secret failed',
      user: { id: 'uuid-1', email: 'pilot@example.com' },
      request: { url: 'https://perilune.test/?token=secret', headers: { authorization: 'Bearer secret' }, data: 'save' },
      breadcrumbs: [{ message: 'craft name' }], extra: { payload: 'save' },
      exception: { values: [{ type: 'Error', value: 'Secret craft', stacktrace: { frames: [] } }] },
    });
    expect(event.user).toEqual({ id: 'uuid-1' });
    expect(event.request).toEqual({ url: 'https://perilune.test/' });
    expect(event.message).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.breadcrumbs).toEqual([]);
    expect(event.exception?.values?.[0]?.value).toBeUndefined();
  });
});
