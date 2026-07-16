# Logging & Observability — Design (2026-07-16, Revision 2)

## Objective

Give Perilune a production observability baseline that answers what happened, to which request, and why across the browser game and serverless API. The immediate trigger is the production `/api/saves` import-time `FUNCTION_INVOCATION_FAILED` response.

The deliverable is a small logging facade with structured events, one request correlation ID, event-specific field allowlists, privacy-safe domain breadcrumbs, Sentry Errors and Tracing, and JSON stdout consumed by the connected Vercel-to-Sentry log drain. Metrics remain on Vercel Analytics and Speed Insights.

## Decisions

1. **Production baseline, incrementally delivered.** Platform verification comes first, followed by the facade, server adoption and save decoupling, then client adoption and alerts.
2. **One authority per signal.** Vercel runtime/platform output flows through the Sentry log drain. Actual exceptions flow directly through the Sentry SDK. Application traces flow directly through the Sentry browser and Node SDKs. `SENTRY_OTLP_TRACES_URL` is reserved and unused in v1; no Vercel trace drain or second OTel provider is enabled alongside the SDK.
3. **Deliberate client breadcrumbs only.** Automatic DOM, console, navigation, and fetch breadcrumbs are rejected by `beforeBreadcrumb`. The facade adds a small allowlisted set of `perilune.*` breadcrumbs. There are no manual `window.onerror` or `unhandledrejection` listeners; the Sentry Browser SDK remains the single unhandled-error authority.
4. **Errors create Issues; warnings do not.** Every server event reaches stdout. Only `logger.error(event, error, fields)` forwards the supplied exception to Sentry Errors. `warn` remains a structured log so dependency degradation can alert from Sentry Logs without creating duplicate Issues.
5. **No arbitrary structured payloads.** Logger fields are flat primitives. An event-policy map allowlists keys by event; unknown fields are dropped, reserved envelope keys cannot be overridden, and the facade applies a case-insensitive secret denylist plus URL query stripping.
6. **`src/sim/` stays pure.** It never imports logging or telemetry. Boundary code logs typed failures.
7. **Cloud-save validation stays strict and single-source.** The existing full `validateSave` implementation moves into a dependency-free module shared by browser and server. The API does not replace it with a smaller or duplicated shape check.
8. **Email logging intentionally supersedes the 2026-07-13 no-email diagnostics rule.** Email is allowed only on the explicit `auth.*` server event schemas. It never enters browser telemetry, Sentry user context, exception tags, request bodies, or traces. `sendDefaultPii:false` remains enabled. Retention and access follow the Sentry project policy.

## Non-Goals

- No new logging or OpenTelemetry dependency.
- No second log store or trace exporter.
- No per-frame, physics-step, terrain-tile, or other hot-path logging.
- No raw request/response bodies, save contents, auth headers, tokens, cookies, craft names, mission names, or arbitrary caller objects.
- No reactivation of paused Supabase resources or repair of missing client Supabase configuration.
- No guarantee of a server request ID for failures that occur before a request reaches Vercel or before any response exists.

## Current State

- `server/http.ts` derives an ID from `x-vercel-id`, but repeated fallback calls can generate different UUIDs and clients currently discard the ID.
- Server and browser Sentry filters currently remove the context and breadcrumbs this design needs.
- `/api/saves` imports `server/saveHandlers` which imports `src/save/schema.ts`, pulling the game graph into the function before the handler can run.
- The Vercel-to-Sentry log drain is connected and Sentry Logs is enabled. WS0 verifies delivery and field shape; it does not reconfigure the drain.
- Sentry browser and Node packages, source-map upload, `fast-check`, Analytics, and Speed Insights already exist.

## Signal Architecture

### Logs

`server/log.ts` writes exactly one JSON object per console call in deployed environments. Vercel attaches platform metadata and forwards it through the connected drain. The application envelope is:

```ts
interface LogEnvelope {
  level: 'debug' | 'info' | 'warn' | 'error';
  ts: string;
  event: LogEvent;
  requestId?: string;
  // allowlisted flat primitive fields only
}
```

Development output is readable. Console method determines platform severity; the JSON `level` remains part of the application schema. Vercel drain field promotion is not assumed until WS0 records an actual delivered event.

### Errors

The facade contract separates exceptions from fields:

```ts
interface Logger {
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, error: unknown, fields?: LogFields): void;
  with(fields: LogFields): Logger;
}
```

`error` emits one stdout line and one `captureException`. `api.request` is emitted once at completion for every handled response. A 5xx does not emit a second `api.error` Issue after `safeHandlerError` has captured the exception. The outer API wrapper awaits a bounded Sentry flush after a captured error before returning; timeout does not alter the API response.

### Traces

The installed Sentry SDK is the only application trace authority in v1:

- Browser tracing uses the existing integration and same-origin propagation.
- Each API entrypoint runs inside one explicit Sentry request span created after initialization.
- Browser and server transaction hooks remove user/arbitrary metadata and strip query/hash data from transaction and span descriptions while preserving trace topology and timing.
- Server SDK initialization occurs in an instrumentation module imported first by every API entrypoint.
- Vercel trace-drain/OTLP export stays disabled for this project in v1, preventing duplicate or conflicting OTel providers.
- Import-time failures before instrumentation remain visible through Vercel platform logs, not app code.

### Metrics

Vercel Analytics and Speed Insights are unchanged and remain governed by `telemetry.enabled`.

## Correlation Contract

`requestId(request)` caches exactly one value per `Request` in a `WeakMap`: a validated `x-vercel-id` when present, otherwise one UUID. The API wrapper computes it once, passes the same request object through all handlers, adds `x-request-id` to every handled response, and attaches it to logs and Sentry exception tags.

Client API adapters read, in order, the structured error-body ID, `x-request-id`, then `x-vercel-id`. `CloudClientError` and the auth error type preserve `requestId?: string`. Client cloud/auth breadcrumbs include it when available. A network failure without a response records no server ID and is not represented as end-to-end correlated.

Traces provide correlation for successful requests. `requestId` remains the support/debug key returned to players for handled failures.

## Privacy and Field Policy

`LogFields` permits only `string | number | boolean | null`. The policy map is deny-by-default:

- Each known event lists its permitted keys.
- Unknown event names are rejected by the typed facade and runtime breadcrumb guard.
- Reserved keys (`level`, `ts`, `event`) cannot be supplied by callers. Server `requestId` is accepted only from the child logger/API wrapper; allowlisted client correlation events may accept a validated response ID.
- Keys are normalized case-insensitively before denylist evaluation.
- Password, token, authorization, cookie, secret, key, DSN, database URL, request/response body, and save payload keys are dropped regardless of event policy.
- URL fields are query/hash stripped.
- Oversized strings are truncated to a documented bound.
- Because values are primitives, circular/nested serialization is impossible.

Errors are serialized into stdout as bounded `errorType` and redacted `errorMessage`; the raw exception is supplied separately to Sentry, where `beforeSend` preserves stack frames but removes exception values, bodies, extras, and non-allowlisted tags. `beforeSendTransaction` independently removes arbitrary span data and query/hash content; error scrubbing is not assumed to cover traces.

Allowed auth-log PII is limited to normalized `email` and authenticated `userId`. A failed login normally has email but no user ID; tests treat `userId` as optional.

Save payloads are never logged. Save operations may log `payloadHash` and `payloadBytes`, never the document, label, slot content, craft names, or mission names.

## Event Taxonomy

Logger events use dotted names. Existing Analytics event names remain unchanged and are mapped deliberately rather than renamed.

| Logger event | Existing Analytics event |
|---|---|
| `game.start` | `game_started` |
| `game.load` | `load` |
| `game.save` | `local_save` |
| `cloud.sync` | `cloud_sync` |
| `launch` | `launch` |
| `tech.unlock` | none |

Server domains are `api.*`, `auth.*`, `save.*`, and `dep.*`. Client-only failure events are `client.boot.error`, `account.request.error`, `cloud.sync.error`, and `sim.boundary.error`. `account.request.error` contains operation, status, reason code, and an optional request ID; it never contains email or credentials.

Levels:

- `debug`: bounded diagnostic detail; enabled in production for v1, never in a hot path.
- `info`: normal completed operation or lifecycle transition.
- `warn`: degraded but recovered operation, conflict, rate limit, or suspicious 4xx.
- `error`: failed operation, 5xx, or explicit boundary exception; creates one Sentry Issue event.

## Server Wiring

- `server/instrumentation.ts`: initialize Sentry once before handlers, with app tracing enabled and strict `beforeSend`.
- `server/log.ts`: JSON stdout, child fields, event policy, exception capture, bounded flush hook.
- `server/http.ts`: cached request ID, response correlation header, outer request timing/span wrapper, and `safeHandlerError` routed through the logger.
- API entrypoints: import instrumentation first and execute through the outer wrapper.
- `server/redis.ts`, auth handlers, and save handlers: replace raw console calls and add domain events without bodies, tokens, or save contents.

## Save Validation Decoupling

Move `SAVE_VERSION`, `validateSave`, and their pure helper predicates to `src/save/validation.ts`. It may import `SaveGame` as a type and runtime-import only pure structural validators from `src/core`; it has no imports from `sim`, `content`, rendering, browser APIs, Supabase, or telemetry. `src/save/schema.ts` re-exports the same symbols so existing browser call sites keep one authority. `server/saveHandlers.ts` imports runtime validation only from the dependency-free module and imports `SaveGame` as a type.

Tests must prove:

- the module imports in a Node process without loading `src/sim` or `src/content`;
- existing valid/invalid save fixtures produce unchanged results;
- browser and server imports reference the same `validateSave` function and `SAVE_VERSION`;
- a version bump cannot update one side without the other.

## Client Wiring

- `src/telemetry/log.ts` implements the browser facade using readable development console output plus deliberate Sentry breadcrumbs.
- `TelemetryService` exposes consent/readiness and safe breadcrumb methods. `beforeBreadcrumb` keeps only sanitized `perilune.*` categories; `scrubSentryEvent` preserves those sanitized breadcrumbs and trace context.
- Existing boot, save-sync, launch, load, and technology boundaries emit mapped logger events without replacing Analytics calls.
- Cloud and auth client error types preserve `requestId`.
- `game.ts` catches explicit sim/UI boundary failures and logs `sim.boundary.error`; `src/sim/` remains import-free.

## Alerting

Configure three high-signal Sentry alerts after preview verification:

- platform/function crash or 5xx-rate spike;
- auth failure/rate-limit spike;
- repeated Redis or Supabase degradation.

Warnings alert from Sentry Logs; only exception events alert from Sentry Issues. Initial thresholds are loose and documented after traffic observation.

## Testing and Acceptance

- Property tests cover field allowlists, case variants, reserved keys, URL stripping, oversized values, and secrets embedded in both keys and primitive values.
- Logger tests cover child merge precedence, exact console severity, one exception capture for `error`, no Issue capture for `warn`, and bounded flush behavior.
- Privacy tests prove deliberate breadcrumbs and request IDs survive while automatic or unsafe breadcrumbs do not.
- API tests prove one stable ID across nested calls, `x-request-id` on success and failure, one completion line, correct status/duration, and no body/token leakage.
- Cloud/auth client tests prove response IDs survive in typed errors and network failures have no fabricated ID.
- Save validation and `src/sim` boundary guards run in CI.
- Preview smoke: deliberate handled 500 produces one stdout event and one Sentry exception with the same request ID; successful request produces one connected trace; deliberate import crash appears in drained platform logs.

## Workstreams

- **WS0 — Verify connected drain.** Record delivered field shape, environments, sampling, retention, and confirm logs-only configuration. No code or configuration mutation unless verification disproves a resolved decision.
- **WS1 — Pure foundations.** Dependency-free save validation, shared log contract/policy, redaction/property tests, and sim import guard. This commit preserves behavior.
- **WS2 — Server adoption.** Instrumentation bootstrap, server facade, cached correlation ID, API wrapper/spans/flush, handler events, and server tests. This also removes the save import-time game-graph dependency.
- **WS3 — Client adoption.** Browser facade, deliberate breadcrumbs, privacy-hook revision, error correlation, mapped lifecycle events, and client tests.
- **WS4 — Preview proof and alerts.** Deploy preview, execute the three smoke cases, record Sentry queries/screenshots or event IDs, then configure alerts.

Each code workstream must pass unit tests, typecheck, content validation, and production build before the next begins.
