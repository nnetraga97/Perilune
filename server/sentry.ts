import * as Sentry from '@sentry/node';

let initialized = false;

function ensureSentry(): boolean {
  if (initialized) return Boolean(process.env.SENTRY_DSN);
  initialized = true;
  if (!process.env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: process.env.VERCEL_ENV === 'production' ? 0.1 : 0,
    beforeSend(event) {
      return {
        ...event,
        event_id: event.event_id,
        timestamp: event.timestamp,
        platform: event.platform,
        level: event.level,
        environment: event.environment,
        release: event.release,
        tags: event.tags,
        request: undefined,
        user: undefined,
        contexts: undefined,
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
    },
  });
  return true;
}

export function captureServerError(
  error: unknown,
  context: { requestId: string; operation: string; dependency?: 'redis' | 'supabase' },
): void {
  if (!ensureSentry()) return;
  Sentry.withScope((scope) => {
    scope.setTags({ operation: context.operation, dependency: context.dependency ?? 'none' });
    scope.setContext('request', { id: context.requestId });
    Sentry.captureException(error);
  });
}

export function captureServerWarning(operation: string, dependency: 'redis' | 'supabase'): void {
  if (!ensureSentry()) return;
  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTags({ operation, dependency });
    Sentry.captureMessage(`${dependency} dependency fallback`);
  });
}
