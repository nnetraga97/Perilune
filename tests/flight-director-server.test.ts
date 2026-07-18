import { describe, expect, it, vi } from 'vitest';
import {
  createFlightDirectorHandler,
  createOpenAIFlightDirectorProvider,
  type FlightDirectorProvider,
} from '../server/flightDirector';
import type { CacheStore } from '../server/redis';
import {
  createSupabaseFlightDirectorAuditRepository,
  type FlightDirectorAuditRecord,
  type FlightDirectorAuditRepository,
} from '../server/flightDirectorAudit';
import {
  FLIGHT_DIRECTOR_MODEL,
  isFlightDirectorAdvisory,
  type FlightDirectorAdvisory,
  type FlightDirectorSnapshot,
} from '../src/ai/flightDirector';

class MemoryCache implements CacheStore {
  readonly values = new Map<string, unknown>();

  async getJson<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(...keys: string[]): Promise<void> {
    keys.forEach((key) => this.values.delete(key));
  }

  async increment(): Promise<{ count: number; ttlSeconds: number }> {
    return { count: 1, ttlSeconds: 60 };
  }
}

function snapshot(): FlightDirectorSnapshot {
  return {
    schemaVersion: 1,
    requestType: 'flight-briefing',
    mission: { elapsedSeconds: 42, mode: 'sandbox', objective: 'Reach a stable orbit' },
    phase: { situation: 'suborbital', regime: 'active' },
    currentBody: {
      id: 'wayfarer', name: 'Wayfarer', parentId: 'helios', surfaceKind: 'solid',
      surfaceGravityMps2: 7.8, hasAtmosphere: false, atmosphereTopMeters: 0,
    },
    targetBody: null,
    vessel: {
      crewCount: 1, controllable: true, currentStage: 1, stagesRemaining: 2,
      throttle: 0.8, sasMode: 'prograde', rcsEnabled: false, massKg: 12_000,
      stageDeltaVMps: 1_400, totalDeltaVMps: 2_100, fuelFraction: 0.58,
      chargeFraction: 0.92, monopropFraction: 1,
    },
    flight: {
      altitudeAslMeters: 82_000, verticalSpeedMps: 470, horizontalSpeedMps: 1_900,
      properG: 1.2, dynamicPressurePa: 0, insideAtmosphere: false,
    },
    orbit: {
      bound: true, apoapsisMeters: 155_000, periapsisMeters: -35_000,
      timeToApoapsisSeconds: 38, eccentricity: 0.34, inclinationDegrees: 0.2,
    },
    maneuver: null,
    entry: null,
    comms: { connected: true, strength: 1, controlBlocked: false },
    recentEvents: [{ ageSeconds: 4, severity: 'info', text: 'Stage separation confirmed' }],
  };
}

function advisory(evidenceKeys: FlightDirectorAdvisory['evidenceKeys'] = ['orbit.periapsisMeters']): FlightDirectorAdvisory {
  return {
    tone: 'warning',
    headline: 'Periapsis is still below ground',
    summary: 'Your apoapsis is established, but the current trajectory will intersect Wayfarer.',
    evidenceKeys,
    nextAction: {
      actionId: 'raise-periapsis',
      instruction: 'Burn prograde near apoapsis to raise periapsis.',
      timing: 'Near apoapsis',
    },
    warnings: ['Do not coast through apoapsis.'],
    unknowns: [],
  };
}

function request(body: unknown = { snapshot: snapshot() }): Request {
  return new Request('https://perilune.test/api/flight-director', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies(
  provider: FlightDirectorProvider,
  cache = new MemoryCache(),
  allowed = true,
  audit?: FlightDirectorAuditRepository,
) {
  return {
    provider,
    cache,
    audit,
    limiter: {
      consume: vi.fn(async () => ({ allowed, retryAfterSeconds: 60, backendAvailable: true })),
    },
  };
}

describe('flight director server', () => {
  it('requires one to four unique evidence references', () => {
    expect(isFlightDirectorAdvisory(advisory([]))).toBe(false);
    expect(isFlightDirectorAdvisory(advisory(['phase.situation', 'phase.situation']))).toBe(false);
    expect(isFlightDirectorAdvisory(advisory())).toBe(true);
  });

  it('rejects invalid telemetry before calling the provider', async () => {
    const generate = vi.fn(async () => ({ advisory: advisory(), inputTokens: 1, outputTokens: 1 }));
    const response = await createFlightDirectorHandler(dependencies({ generate }))(request({ snapshot: {} }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_FLIGHT_SNAPSHOT' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns grounded structured guidance and caches identical snapshots', async () => {
    const generate = vi.fn(async () => ({ advisory: advisory(), inputTokens: 420, outputTokens: 75 }));
    const cache = new MemoryCache();
    const auditCreate = vi.fn(
      async (_record: FlightDirectorAuditRecord): Promise<void> => {},
    );
    const handler = createFlightDirectorHandler(dependencies({ generate }, cache, true, { create: auditCreate }));

    const first = await handler(request());
    const second = await handler(request());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      data: { model: FLIGHT_DIRECTOR_MODEL, cached: false, advisory: { headline: 'Periapsis is still below ground' } },
    });
    expect(await second.json()).toMatchObject({ ok: true, data: { cached: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
      model: FLIGHT_DIRECTOR_MODEL,
      cached: false,
      inputTokens: 420,
      outputTokens: 75,
      snapshot: { phase: { situation: 'suborbital' } },
      advisory: { nextAction: { actionId: 'raise-periapsis' } },
    });
    expect(auditCreate.mock.calls[1]?.[0]).toMatchObject({ cached: true, inputTokens: 0, outputTokens: 0 });
  });

  it('keeps a database audit failure from interrupting the briefing', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = { generate: async () => ({ advisory: advisory(), inputTokens: 100, outputTokens: 40 }) };
    const audit = { create: async () => { throw new Error('private database detail'); } };

    const response = await createFlightDirectorHandler(dependencies(provider, new MemoryCache(), true, audit))(request());

    expect(response.status).toBe(200);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toBe('[ai.briefing.audit.fail]');
    expect(warning.mock.calls[0]?.[1]).toMatchObject({ reason: 'database_write_failed' });
  });

  it('rejects evidence that is absent from the supplied snapshot', async () => {
    const provider = {
      generate: async () => ({
        advisory: advisory(['currentBody.atmosphereTopMeters']),
        inputTokens: 100,
        outputTokens: 40,
      }),
    };
    const response = await createFlightDirectorHandler(dependencies(provider))(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'AI_UNAVAILABLE' } });
  });

  it('enforces the server-side request limits before generation', async () => {
    const generate = vi.fn(async () => ({ advisory: advisory(), inputTokens: 1, outputTokens: 1 }));
    const response = await createFlightDirectorHandler(dependencies({ generate }, new MemoryCache(), false))(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends Luna a non-persistent, strict structured-output request', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      output_text: JSON.stringify(advisory()),
      usage: { input_tokens: 321, output_tokens: 54 },
    }));
    const provider = createOpenAIFlightDirectorProvider('test-key', fetchImpl as typeof fetch);

    const result = await provider.generate(snapshot());
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, any>;

    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(body).toMatchObject({
      model: FLIGHT_DIRECTOR_MODEL,
      store: false,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'perilune_flight_advisory', strict: true } },
    });
    expect(body.input).toContain('telemetrySnapshot');
    expect(result).toMatchObject({ advisory: { tone: 'warning' }, inputTokens: 321, outputTokens: 54 });
  });

  it('writes the exact structured snapshot and advisory through the service-role REST endpoint', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 201 }),
    );
    const repository = createSupabaseFlightDirectorAuditRepository({
      supabaseUrl: 'https://project.supabase.co',
      supabaseServiceRoleKey: 'test-service-role',
    }, fetchImpl as typeof fetch);

    await repository.create({
      requestId: 'iad1::audit-1',
      createdAt: '2026-07-18T19:30:00.000Z',
      model: FLIGHT_DIRECTOR_MODEL,
      cached: false,
      durationMs: 2_900,
      inputTokens: 982,
      outputTokens: 356,
      snapshot: snapshot(),
      advisory: advisory(),
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe('https://project.supabase.co/rest/v1/flight_director_audits');
    expect(init?.headers).toMatchObject({
      apikey: 'test-service-role',
      authorization: 'Bearer test-service-role',
      prefer: 'return=minimal',
    });
    expect(row).toMatchObject({
      request_id: 'iad1::audit-1',
      cached: false,
      snapshot: { mission: { objective: 'Reach a stable orbit' } },
      advisory: { headline: 'Periapsis is still below ground' },
    });
    expect(JSON.stringify(row)).not.toContain('test-service-role');
  });
});
