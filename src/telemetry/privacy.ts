import type { Event } from '@sentry/browser';

export type TelemetryEventName =
  | 'account_created'
  | 'signed_in'
  | 'signed_out'
  | 'game_started'
  | 'launch'
  | 'local_save'
  | 'cloud_sync'
  | 'load'
  | 'save_conflict'
  | 'pending_sync_recovered';

type SafeValue = string | number | boolean | null;

const PROPERTY_VALUES: Record<TelemetryEventName, Record<string, readonly SafeValue[]>> = {
  account_created: {}, signed_in: {}, signed_out: {}, launch: {}, save_conflict: {}, pending_sync_recovered: {},
  game_started: { mode: ['guest', 'account'] },
  local_save: { kind: ['auto', 'quick', 'named'] },
  cloud_sync: { result: ['synced', 'pending', 'conflict'] },
  load: { source: ['local', 'cloud'] },
};

export function stripQuery(raw: string): string {
  try {
    const base = typeof location === 'undefined' ? 'https://perilune.invalid' : location.origin;
    const url = new URL(raw, base);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? '';
  }
}

export function safeAnalyticsProperties(
  name: TelemetryEventName,
  input: Readonly<Record<string, unknown>> = {},
): Record<string, SafeValue> {
  const schema = PROPERTY_VALUES[name];
  const output: Record<string, SafeValue> = {};
  for (const [key, allowed] of Object.entries(schema)) {
    const value = input[key];
    if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
      && allowed.includes(value)) output[key] = value;
  }
  return output;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const trace = event.contexts?.trace;
  return {
    ...event,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    request: event.request?.url ? { url: stripQuery(event.request.url) } : undefined,
    user: event.user?.id ? { id: String(event.user.id) } : undefined,
    contexts: trace ? { trace } : undefined,
    breadcrumbs: [],
    extra: undefined,
    tags: undefined,
    message: undefined,
    logentry: undefined,
    transaction: undefined,
    exception: event.exception ? {
      values: event.exception.values?.map((value) => ({
        type: value.type,
        mechanism: value.mechanism,
        stacktrace: value.stacktrace,
      })),
    } : undefined,
  } as T;
}
