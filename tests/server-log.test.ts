import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  captureServerError: vi.fn(),
  captureServerLog: vi.fn(),
  flushServerTelemetry: vi.fn().mockResolvedValue(true),
}));

vi.mock('../server/sentry', () => sentry);

import { log } from '../server/log';

describe('server logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sentry.captureServerError.mockClear();
    sentry.captureServerLog.mockClear();
  });

  it('uses console severity and preserves latest validated child request ID', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.with({ requestId: 'req-1' }).with({ requestId: 'req-2' }).info('api.request', {
      method: 'GET', path: '/api/saves?secret=yes', status: 200, durationMs: 2,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      level: 'info', event: 'api.request', requestId: 'req-2', path: '/api/saves',
    });

    info.mockClear();
    log.with({ requestId: 'child-id' }).info('cloud.sync', { result: 'pending', requestId: 'caller-id' });
    expect(info.mock.calls[0]?.[1]).toMatchObject({ requestId: 'child-id' });
    expect(sentry.captureServerLog).toHaveBeenLastCalledWith('info', 'cloud.sync', expect.objectContaining({
      event: 'cloud.sync', requestId: 'child-id', result: 'pending',
    }));
  });

  it('captures exactly one supplied exception for error and none for warn', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('failed');
    log.with({ requestId: 'req-1' }).warn('dep.redis.unavailable', { operation: 'read', reason: 'timeout' });
    expect(sentry.captureServerError).not.toHaveBeenCalled();
    log.with({ requestId: 'req-1' }).error('api.error', error, { status: 500 });
    expect(sentry.captureServerError).toHaveBeenCalledTimes(1);
    expect(sentry.captureServerError).toHaveBeenCalledWith(error, expect.objectContaining({
      requestId: 'req-1', event: 'api.error',
    }));
    expect(sentry.captureServerLog).toHaveBeenCalledWith('error', 'api.error', expect.objectContaining({
      event: 'api.error', requestId: 'req-1', status: 500,
    }));
  });
});
