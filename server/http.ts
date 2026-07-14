import { randomUUID } from 'node:crypto';
import { captureServerError } from './sentry.js';

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

export function requestId(request: Request): string {
  return request.headers.get('x-vercel-id')?.slice(0, 160) || randomUUID();
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
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large');
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
  captureServerError(error, { requestId: id, operation: 'api_request' });
  console.error('Cloud API request failed', { requestId: id, error });
  return jsonError('INTERNAL_ERROR', 'The request could not be completed', 500, id);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return (forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown').slice(0, 128);
}
