import type { FlightDirectorAdvisory, FlightDirectorSnapshot } from '../src/ai/flightDirector.js';

const AUDIT_WRITE_TIMEOUT_MS = 2_000;

export interface FlightDirectorAuditRecord {
  requestId: string;
  createdAt: string;
  model: string;
  cached: boolean;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  snapshot: FlightDirectorSnapshot;
  advisory: FlightDirectorAdvisory;
}

export interface FlightDirectorAuditRepository {
  create(record: FlightDirectorAuditRecord): Promise<void>;
}

interface FlightDirectorAuditEnvironment {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

function auditRow(record: FlightDirectorAuditRecord): Record<string, unknown> {
  return {
    request_id: record.requestId,
    created_at: record.createdAt,
    model: record.model,
    cached: record.cached,
    duration_ms: record.durationMs,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    cached_input_tokens: record.cachedInputTokens,
    cache_write_tokens: record.cacheWriteTokens,
    reasoning_tokens: record.reasoningTokens,
    snapshot: record.snapshot,
    advisory: record.advisory,
  };
}

export function createSupabaseFlightDirectorAuditRepository(
  environment: FlightDirectorAuditEnvironment,
  fetchImpl: typeof fetch = fetch,
): FlightDirectorAuditRepository {
  const endpoint = new URL('/rest/v1/flight_director_audits', environment.supabaseUrl);
  return {
    async create(record) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          apikey: environment.supabaseServiceRoleKey,
          authorization: `Bearer ${environment.supabaseServiceRoleKey}`,
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body: JSON.stringify(auditRow(record)),
        signal: AbortSignal.timeout(AUDIT_WRITE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`flight_director_audit_status_${response.status}`);
    },
  };
}
