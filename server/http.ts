import { randomUUID } from 'node:crypto';
import { log, flushServerTelemetry } from './log.js';
import { withServerRequestSpan } from './sentry.js';

export interface ApiErrorBody {
  ok: false;
  error: { code: string; message: string; requestId: string };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const REQUEST_IDS = new WeakMap<Request, string>();

export function requestId(request: Request): string {
  const existing = REQUEST_IDS.get(request);
  if (existing) return existing;
  const candidate = request.headers.get('x-vercel-id') ?? '';
  const id = candidate && candidate.length <= 160 && /^[A-Za-z0-9:._-]+$/.test(candidate)
    ? candidate
    : randomUUID();
  REQUEST_IDS.set(request, id);
  return id;
}

export function jsonOk<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return Response.json({ ok: true, data }, { status, headers });
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  id: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { ok: false, error: { code, message, requestId: id } } satisfies ApiErrorBody,
    { status, headers },
  );
}

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large');
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

export function methodNotAllowed(allowed: readonly string[], id: string): Response {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed', 405, id, {
    Allow: allowed.join(', '),
  });
}

export function safeHandlerError(error: unknown, id: string): Response {
  if (error instanceof HttpError) return jsonError(error.code, error.message, error.status, id);
  log.with({ requestId: id }).error('api.error', error, { status: 500 });
  return jsonError('INTERNAL_ERROR', 'The request could not be completed', 500, id);
}

export async function observeApiRequest(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const id = requestId(request);
  const started = performance.now();
  let response: Response;
  try {
    response = await withServerRequestSpan(request, handler);
  } catch (error) {
    response = safeHandlerError(error, id);
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const pathname = new URL(request.url).pathname;
  log.with({ requestId: id }).info('api.request', {
    method: request.method,
    path: pathname,
    status: response.status,
    durationMs,
  });
  // Sentry batches logs. Flush before the serverless invocation can freeze so
  // successful request logs are delivered as reliably as captured errors.
  await flushServerTelemetry();
  const headers = new Headers(response.headers);
  headers.set('x-request-id', id);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function clientIp(request: Request): string {
  // Forwarding headers are trustworthy only behind the configured Vercel
  // proxy. Self-hosted callers cannot select their own rate-limit identity.
  if (process.env.VERCEL === '1') {
    const forwarded = request.headers.get('x-forwarded-for');
    return (forwarded?.split(',')[0]?.trim() || 'unknown').slice(0, 128);
  }
  return 'direct';
}
