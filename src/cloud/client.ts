import type { SaveGame } from '../save/schema';
import type { AuthService } from './auth';
import type { CloudSaveMeta, CloudSaveRecord } from './types';

interface Success<T> { ok: true; data: T }
interface Failure { ok: false; error: { code: string; message: string; requestId?: string } }

export class CloudClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export class CloudSaveClient {
  constructor(
    private readonly auth: AuthService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  list(): Promise<CloudSaveMeta[]> {
    return this.request('/api/saves');
  }

  read(slot: string): Promise<CloudSaveRecord> {
    return this.request(`/api/saves/${encodeURIComponent(slot)}`);
  }

  put(slot: string, save: SaveGame, expectedRevision: number | null): Promise<CloudSaveRecord> {
    return this.request(`/api/saves/${encodeURIComponent(slot)}`, {
      method: 'PUT',
      body: JSON.stringify({ save, expectedRevision }),
    });
  }

  delete(slot: string, expectedRevision: number): Promise<{ deleted: true }> {
    return this.request(`/api/saves/${encodeURIComponent(slot)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision }),
    });
  }

  private async request<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.auth.accessToken(retried);
    if (!token) throw new CloudClientError('AUTH_REQUIRED', 401, 'Sign in to use cloud saves.');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new CloudClientError('NETWORK_UNAVAILABLE', 0, 'Cloud service is unreachable.');
    }
    if (response.status === 401 && !retried) return this.request<T>(url, init, true);
    let body: Success<T> | Failure;
    try {
      body = await response.json() as Success<T> | Failure;
    } catch {
      throw new CloudClientError('INVALID_RESPONSE', response.status, 'Cloud service returned an invalid response.');
    }
    if (!response.ok || !body.ok) {
      const failure = body as Failure;
      throw new CloudClientError(failure.error?.code ?? 'CLOUD_ERROR', response.status, failure.error?.message ?? 'Cloud request failed.');
    }
    return body.data;
  }
}
