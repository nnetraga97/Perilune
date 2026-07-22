export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

const EVENT_FIELD_POLICY = {
  'api.request': ['method', 'path', 'status', 'durationMs'],
  'api.error': ['method', 'path', 'status', 'durationMs', 'errorType', 'errorMessage'],
  'auth.signup.ok': ['accountCorrelation', 'userId', 'status'],
  'auth.signup.pending': ['accountCorrelation', 'status'],
  'auth.signup.fail': ['accountCorrelation', 'userId', 'status', 'reason'],
  'auth.login.ok': ['accountCorrelation', 'userId', 'status'],
  'auth.login.fail': ['accountCorrelation', 'userId', 'status', 'reason'],
  'auth.ratelimited': ['accountCorrelation', 'status', 'retryAfterSeconds'],
  'save.read.ok': ['status', 'cache'],
  'save.read.miss': ['status'],
  'save.write.ok': ['status', 'payloadHash', 'payloadBytes'],
  'save.write.conflict': ['status'],
  'save.write.invalid': ['status', 'reason'],
  'save.delete.ok': ['status'],
  'save.delete.conflict': ['status'],
  'save.delete.missing': ['status'],
  'dep.redis.unavailable': ['operation', 'reason'],
  'dep.supabase.error': ['operation', 'reason'],
  'ai.briefing.ok': [
    'model', 'status', 'durationMs', 'inputTokens', 'outputTokens',
    'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'cache',
  ],
  'ai.briefing.fail': ['status', 'reason'],
  'ai.briefing.audit.fail': ['status', 'reason'],
  'ai.briefing.ratelimited': ['status', 'retryAfterSeconds'],
  'client.boot.error': ['source', 'errorType', 'requestId'],
  'account.request.error': ['operation', 'status', 'reason', 'requestId'],
  'game.start': ['mode'],
  'game.load': ['source'],
  'game.save': ['kind'],
  'cloud.sync': ['result', 'requestId'],
  'cloud.sync.error': ['errorType', 'requestId'],
  'tech.unlock': ['technologyId'],
  launch: ['mode'],
  'terrain.authority.fallback': ['bodyId', 'generation', 'reason'],
  'sim.boundary.error': ['boundary', 'errorType'],
} as const;

export type LogEvent = keyof typeof EVENT_FIELD_POLICY;

export function isLogEvent(value: string): value is LogEvent {
  return Object.prototype.hasOwnProperty.call(EVENT_FIELD_POLICY, value);
}

const RESERVED_KEYS = new Set(['level', 'ts', 'event']);
const SAFE_TOKEN_COUNT_KEYS = new Set([
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens',
]);
const NEVER_LOG_KEY = /(pass(word)?|token|authorization|cookie|secret|dsn|database.?url|postgres|request.?body|response.?body|save.?payload|payload.?content|(?:^|[_-])(?:api|private|publishable|service)?key$)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+|(?:password|token|secret|authorization|api[_-]?key)\s*[=:]\s*[^\s&]+|postgres(?:ql)?:\/\/[^\s]+|(?:redis|rediss|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s]+|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})/i;
const MAX_STRING_LENGTH = 512;

function stripQueryAndHash(value: string): string {
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  const end = [query, hash].filter((index) => index >= 0).reduce((min, index) => Math.min(min, index), value.length);
  return value.slice(0, end);
}

function safeValue(key: string, value: unknown): LogValue | undefined {
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value !== 'string') return value as number | boolean | null;
  const stripped = /(url|path)$/i.test(key) ? stripQueryAndHash(value) : value;
  if (SECRET_VALUE.test(stripped)) return undefined;
  return stripped.slice(0, MAX_STRING_LENGTH);
}

export function sanitizeLogFields(
  event: LogEvent,
  input: Readonly<Record<string, unknown>> | undefined,
): Record<string, LogValue> {
  if (!input) return {};
  const allowed = new Set<string>(EVENT_FIELD_POLICY[event]);
  const output: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const safeAggregateTokenCount = SAFE_TOKEN_COUNT_KEYS.has(key)
      && typeof value === 'number'
      && Number.isFinite(value);
    if (RESERVED_KEYS.has(key.toLocaleLowerCase())
      || (NEVER_LOG_KEY.test(key) && !safeAggregateTokenCount)
      || !allowed.has(key)) continue;
    const sanitized = safeValue(key, value);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function sanitizeChildFields(input: Readonly<Record<string, unknown>> | undefined): Record<string, LogValue> {
  const requestId = input?.requestId;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 160 || SECRET_VALUE.test(requestId)) return {};
  return { requestId };
}

export function errorFields(error: unknown): Pick<Record<string, LogValue>, 'errorType' | 'errorMessage'> {
  if (error instanceof Error) {
    const message = safeValue('errorMessage', error.message);
    return {
      errorType: error.name.slice(0, 120),
      errorMessage: typeof message === 'string' ? message : '[redacted]',
    };
  }
  return { errorType: 'UnknownError', errorMessage: '[unavailable]' };
}
