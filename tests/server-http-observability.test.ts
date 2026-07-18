import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    with: vi.fn(),
  };
  logger.with.mockReturnValue(logger);
  return { logger, flush: vi.fn().mockResolvedValue(true) };
});

vi.mock('../server/log', () => ({ log: mocks.logger, flushServerTelemetry: mocks.flush }));
vi.mock('../server/sentry', () => ({
  withServerRequestSpan: (_request: Request, callback: () => Promise<Response>) => callback(),
}));

import { HttpError, observeApiRequest } from '../server/http';

describe('API error delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.with.mockReturnValue(mocks.logger);
  });

  it('flushes telemetry after every request so buffered serverless logs are delivered', async () => {
    await observeApiRequest(new Request('https://perilune.test/api/test'), async () => {
      throw new Error('boom');
    });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.flush).toHaveBeenCalledTimes(1);

    mocks.flush.mockClear();
    await observeApiRequest(new Request('https://perilune.test/api/test'), async () => {
      throw new HttpError(503, 'UNAVAILABLE', 'Try later');
    });
    await observeApiRequest(new Request('https://perilune.test/api/test'), async () => new Response(null, { status: 503 }));
    expect(mocks.flush).toHaveBeenCalledTimes(2);
  });
});
