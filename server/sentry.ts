import * as Sentry from '@sentry/node';
import type { ErrorEvent, Event } from '@sentry/node';
import type { LogEvent, LogFields, LogLevel } from '../src/telemetry/logContract.js';

const SAFE_TAGS = new Set(['requestId', 'event', 'operation', 'dependency']);
const enabled = Boolean(process.env.SENTRY_DSN);

export function scrubServerSentryEvent(event: ErrorEvent): ErrorEvent {
  const trace = event.contexts?.trace;
  const tags = Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(([key]) => SAFE_TAGS.has(key)),
  );
  return {
    ...event,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    tags: Object.keys(tags).length ? tags : undefined,
    request: undefined,
    user: undefined,
    contexts: trace ? { trace } : undefined,
    breadcrumbs: [],
    extra: undefined,
    message: undefined,
    exception: event.exception ? {
      values: event.exception.values?.map((value) => ({
        type: value.type,
        mechanism: value.mechanism,
        stacktrace: value.stacktrace,
      })),
    } : undefined,
  };
}

function stripQueryAndHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.split(/[?#]/, 1)[0] ?? '';
}

export function scrubServerSentryTransaction<T extends Event>(event: T): T {
  const trace = event.contexts?.trace;
  return {
    ...event,
    transaction: stripQueryAndHash(event.transaction),
    request: event.request?.url ? { url: stripQueryAndHash(event.request.url) } : undefined,
    user: undefined,
    contexts: trace ? { trace } : undefined,
    breadcrumbs: undefined,
    extra: undefined,
    tags: undefined,
    spans: event.spans?.map((span) => ({
      ...span,
      description: stripQueryAndHash(span.description),
      data: undefined,
    })),
  } as T;
}

if (enabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    enableLogs: true,
    tracesSampleRate: process.env.VERCEL_ENV === 'production' ? 0.1 : 0,
    beforeSend: scrubServerSentryEvent,
    beforeSendTransaction: scrubServerSentryTransaction,
  });
}

export function captureServerError(
  error: unknown,
  context: { requestId?: string; event: string; operation?: string; dependency?: 'redis' | 'supabase' },
): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag('event', context.event);
    if (context.requestId) scope.setTag('requestId', context.requestId);
    if (context.operation) scope.setTag('operation', context.operation);
    if (context.dependency) scope.setTag('dependency', context.dependency);
    Sentry.captureException(error);
  });
}

export function captureServerLog(
  level: LogLevel,
  event: LogEvent,
  fields: LogFields = {},
): void {
  if (!enabled) return;
  const attributes = { ...fields, event };
  if (level === 'error') Sentry.logger.error(event, attributes);
  else if (level === 'warn') Sentry.logger.warn(event, attributes);
  else if (level === 'debug') Sentry.logger.debug(event, attributes);
  else Sentry.logger.info(event, attributes);
}

export function flushServerTelemetry(timeout = 750): Promise<boolean> {
  return enabled ? Sentry.flush(timeout) : Promise.resolve(true);
}

export async function withServerRequestSpan<T>(request: Request, callback: () => Promise<T>): Promise<T> {
  if (!enabled) return callback();
  const sentryTrace = request.headers.get('sentry-trace') ?? undefined;
  const baggage = request.headers.get('baggage') ?? undefined;
  return Sentry.continueTrace({ sentryTrace, baggage }, () => Sentry.startSpan({
    name: `${request.method} ${new URL(request.url).pathname}`,
    op: 'http.server',
    kind: 1,
    forceTransaction: true,
    attributes: {
      'http.request.method': request.method,
      'url.path': new URL(request.url).pathname,
    },
  }, callback));
}
