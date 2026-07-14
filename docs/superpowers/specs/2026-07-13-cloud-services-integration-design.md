# Cloud Services Integration Design

**Date:** 2026-07-13

**Status:** Approved in conversation; awaiting written-spec review

**Scope:** Supabase authentication and cloud saves, Redis caching and rate limiting, Sentry diagnostics, Vercel Analytics, and Vercel Speed Insights

## Context

Perilune is currently a framework-free Vite/TypeScript browser game. Guest saves live in IndexedDB with a localStorage fallback, UI preferences live in localStorage, and no server API is required to play. The connected Vercel project now supplies Supabase, Redis, Sentry, Vercel Analytics, Speed Insights, and Resend integrations.

The integration must preserve the existing local-first game. A missing environment variable, network outage, expired session, or cloud-service failure must never prevent guest play or destroy a valid local save.

## Goals

- Add optional email/password accounts through Supabase Auth.
- Remember authenticated sessions without storing passwords in Perilune.
- Keep guest play and local saves fully functional.
- Sync signed-in players' saves to Supabase through authenticated Vercel functions.
- Preserve both sides of every ambiguous save conflict until the player resolves it.
- Use Redis as a short-lived read-through cache and API rate limiter, never as authoritative storage.
- Capture privacy-filtered errors and performance data with Sentry.
- Capture anonymous usage with Vercel Analytics and real-user Web Vitals with Speed Insights.
- Give players one default-on setting that can stop all client telemetry.

## Non-goals

- Email verification, password recovery, social login, usernames, or account deletion.
- Direct browser access to the cloud-save table.
- Multiplayer, shared saves, public profiles, or cross-user save access.
- Making cloud availability a prerequisite for starting or playing the game.
- Transactional email. Resend remains reserved for a later defined email feature.
- A decorative live-service indicator. Sync state is communicated only where it affects a save or action.

## Architecture

Perilune remains local-first. The browser gains bounded auth, cloud-save, sync, and telemetry services; Vercel functions form the authenticated server boundary for account entry and cloud saves.

```text
Browser
  |- existing IndexedDB/localStorage persistence (always available)
  |- AuthService ---------------------> /api/auth/* -> Supabase Auth
  |- CloudSaveClient + SyncCoordinator -> /api/saves/*
  |                                         |- verify Supabase access token
  |                                         |- Redis rate limit/cache
  |                                         `- Supabase cloud_saves under RLS
  `- TelemetryService
       |- Vercel Analytics
       |- Vercel Speed Insights
       `- Sentry browser client

Vercel Functions -> Sentry server client and existing Sentry log drain
```

### Browser modules

- `AuthService` owns sign-up, sign-in, sign-out, restored sessions, refreshes, and auth-state notifications. It hands proxy-returned tokens to the Supabase browser client, whose normal persisted-session behavior remembers the login. Passwords are never stored by Perilune.
- `CloudSaveClient` is a typed HTTP client for the save API. It supplies the current bearer token and maps stable API error codes to application results.
- `SyncCoordinator` compares local and cloud catalogs, maintains per-slot revision/hash metadata, queues failed uploads, and produces explicit conflicts. It never mutates simulation state.
- `TelemetryService` is the only application-facing API for Analytics, Speed Insights, and Sentry. It owns initialization, filtering, user context, event allowlists, and the telemetry preference.

### Server modules

- Auth handlers proxy only sign-up and sign-in so Redis can rate-limit attempts. They use Supabase's publishable credential and return a Supabase session for the browser client to persist.
- Save handlers authenticate every request, create a Supabase client scoped with that request's access token, and rely on Row Level Security. Runtime save operations do not use the service-role key.
- Redis helpers provide bounded rate limiting and best-effort cache operations. Redis errors fall through to Supabase.
- Shared response helpers return stable, sanitized error shapes and attach a request ID for Sentry correlation.

## Environment boundaries

The Vite build may expose only values designed to be public:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`, with `SUPABASE_ANON_KEY` as a compatibility fallback
- `SENTRY_DSN`
- `VERCEL_GIT_COMMIT_SHA` as the release identifier

These values are explicitly selected in Vite configuration; arbitrary environment variables are never copied into the browser bundle.

Server or build-only values include:

- `REDIS_URL`
- `POSTGRES_URL_NON_POOLING` for applying migrations
- `SUPABASE_SERVICE_ROLE_KEY` for disposable-test cleanup only
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` for source-map upload
- `SENTRY_DSN` for server exceptions
- all other database credentials and Supabase secrets
- `RESEND_API_KEY` and `RESEND_EMAIL_DOMAIN`, which remain unused

Local development without cloud values starts in guest-only mode. A developer can pull Preview values into a gitignored local environment file when exercising the real integrations.

## Authentication

The account window supports:

- Create account with email and password.
- Sign in with email and password.
- Sign out while retaining every local save.
- A signed-in summary containing the email address and a sign-out action.

Email verification is disabled for this phase. Supabase still owns password hashing, password policy, access tokens, refresh tokens, session expiry, and token refresh.

`POST /api/auth/signup` and `POST /api/auth/login` accept narrowly validated JSON bodies and are rate-limited by a non-reversible hash of normalized email plus client IP. Neither raw email nor password is placed in Redis, Sentry context, structured logs, or Analytics. Supabase authentication errors are mapped to neutral UI copy; server responses must not reveal internal credentials or stack traces.

On a successful response, the browser calls Supabase `setSession` with the returned access and refresh tokens. On boot it restores the persisted session before starting background sync. A failed refresh clears only cloud auth state and returns the player to guest mode; local data remains untouched.

## Cloud-save data model

A versioned Supabase migration creates `public.cloud_saves` with:

| Column | Purpose |
|---|---|
| `user_id uuid` | Owner; foreign key to `auth.users(id)` with cascade delete |
| `slot text` | Existing normalized save slot, at most 48 characters |
| `label text` | Player-facing save label |
| `save_version integer` | Perilune save-schema version |
| `payload jsonb` | Complete validated `SaveGame` document |
| `payload_hash text` | SHA-256 digest used during reconciliation |
| `revision bigint` | Optimistic concurrency counter beginning at 1 |
| `created_at timestamptz` | First cloud creation time |
| `updated_at timestamptz` | Last accepted cloud mutation time |

The primary key is `(user_id, slot)`. Indexes support user catalog reads ordered by `updated_at`. Constraints enforce slot shape, finite supported metadata, nonempty hashes, positive revisions, and bounded labels where PostgreSQL can do so cheaply. The API still performs full structural validation and a 2 MB request limit before reaching the table.

RLS is enabled. Authenticated users may select, insert, update, and delete only rows whose `user_id` equals `auth.uid()`. The anonymous role receives no table privileges. The migration grants only the operations required by the authenticated and service roles.

## API contract

All save endpoints require `Authorization: Bearer <Supabase access token>`.

- `GET /api/saves` returns cloud metadata, hashes, and revisions without payloads.
- `GET /api/saves/:slot` returns one complete cloud save plus its revision and hash.
- `PUT /api/saves/:slot` validates a complete save and accepts the caller's expected revision. Creation requires no existing revision and starts at revision 1. An update matches the previous revision atomically and advances it by one.
- `DELETE /api/saves/:slot` requires the last observed revision before deleting the cloud copy.

A unique-key collision during creation, an update that no longer matches its expected revision, or a stale delete returns `409 SAVE_CONFLICT`. Authentication failures return `401`; malformed input returns `400`; oversized input returns `413`; rate limiting returns `429`; an unavailable authoritative dependency returns sanitized `503`. Every response uses a small stable JSON envelope and a request ID.

The API uses same-origin requests and bearer tokens rather than application cookies, so it does not add a cookie-CSRF surface. CORS is not opened to arbitrary origins.

## Redis caching and rate limiting

Redis is non-authoritative and uses a five-minute TTL:

- Per-user catalog key for `GET /api/saves`.
- Per-user/per-slot item key for `GET /api/saves/:slot`.
- Short-lived counters for auth and save-API rate limits.

Every cache key is namespaced and contains only an opaque Supabase user ID or a hash, never a raw email or token. A successful put or delete invalidates both the affected item and its catalog. A cache read or write failure is captured by Sentry at warning level and the request continues against Supabase. Redis content is never used until after the request's access token has been verified.

Rate-limit thresholds are named configuration constants with conservative defaults and separate policies for signup, login, reads, and mutations. Responses expose only when the caller may retry, not internal Redis state.

## Local-first synchronization

The existing local write remains the first durable step for every save:

1. Serialize and validate with the current save schema.
2. Transactionally write the local slot and backups.
3. If signed in, enqueue a cloud upload containing the last observed revision.
4. On success, store the returned revision and hash as sync metadata.
5. On a transient failure, retain the local save and pending operation.
6. On a stale revision, retain both versions and expose a conflict.

Pending sync metadata lives beside local persistence, not inside the game save schema. Retries occur after session restoration, an online event, a successful unrelated cloud call, and opening Save & Load. Retries use bounded exponential backoff and do not block the game loop.

### Sign-in reconciliation

After a session is restored or newly established, the coordinator compares local and cloud catalogs:

- Local only: upload it.
- Cloud only: list it immediately; download and persist it locally when the player loads it.
- Same slot and same hash: record the cloud revision and mark it synced.
- Same slot and different hash: preserve both and mark a conflict.

Conflict resolution offers:

- **Keep local:** overwrite cloud only against the conflicting revision the player just reviewed.
- **Keep cloud:** replace the local primary through the existing transactional persistence path while retaining normal local backup rotation.
- **Keep both:** rename the local slot with a collision-safe suffix, then upload it as a separate cloud slot.

No conflict choice is automatic. A newer timestamp may help the player decide but never decides for them.

### Deletion

For a synced slot, deletion removes the cloud row first using the last observed revision, then removes local primary/backups and sync metadata. If cloud deletion fails or conflicts, the local save remains. Local-only guest saves use the current local deletion behavior. Signing out never deletes or hides local copies.

## UI changes

- Add an **Account** button to the main menu and an account window managed by the existing window system.
- Keep Save & Load available in guest mode.
- In signed-in mode, render the unified local/cloud catalog with functional text labels: `Local`, `Cloud`, `Synced`, `Pending`, or `Conflict`.
- Show precise, nonblocking copy such as `Saved locally; cloud sync pending` when cloud work fails after a local success.
- Add conflict actions only on affected rows.
- Add **Share anonymous diagnostics and usage** to Settings, defaulting to enabled.
- Do not add animated or decorative status dots.

## Telemetry

### Vercel Analytics

Initialize `@vercel/analytics` through `TelemetryService`. Automatic page views and custom events pass through `beforeSend`. The custom-event allowlist is:

- account created
- signed in and signed out
- game started
- launch
- local save
- cloud sync
- load
- save conflict
- pending sync recovered

Events contain only bounded enums or booleans needed for aggregate behavior. They never contain email, user ID, save labels, slot names, craft names, mission names, tokens, or save contents.

### Vercel Speed Insights

Install `@vercel/speed-insights` and initialize its framework-agnostic `injectSpeedInsights()` through `TelemetryService`. Begin with a 100% sample rate and route all measurements through `beforeSend`. Speed Insights receives anonymous Web Vitals and route performance only; no player identity or gameplay content is attached. Sampling can be lowered later if usage justifies it.

### Sentry

Initialize browser and Node clients with environment, Vercel commit SHA, and privacy filters. Capture:

- browser boot failures and unhandled exceptions
- explicitly reported persistence and sync failures
- API exceptions and dependency failures
- cache fallback warnings
- sampled browser/API performance traces

When signed in, Sentry user context contains only the Supabase UUID. `beforeSend` removes email, request bodies, response bodies, authorization headers, cookies, tokens, query strings, save metadata, and gameplay names. `sendDefaultPii` remains disabled.

The Sentry Vite plugin uploads production source maps with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`; maps are not published as downloadable deployment assets. The existing Vercel Sentry log drain remains active, while the SDK adds structured exception context.

### Telemetry preference

The existing profile store persists a default-true telemetry setting. On boot, `TelemetryService` reads it before initializing clients.

- Analytics and Speed Insights `beforeSend` return `null` while disabled.
- Sentry is closed while disabled.
- Custom telemetry calls become no-ops while disabled.
- Re-enabling initializes or reinitializes all three products without a reload.

Turning telemetry off does not affect functional account, save, Redis, or Supabase requests.

## Failure handling

- Missing client configuration: account/cloud controls explain that cloud services are unavailable; guest play starts normally.
- Missing server configuration: affected endpoints return a sanitized `503 CONFIG_UNAVAILABLE`; guest and local saves remain available.
- Expired access token: refresh once and retry the idempotent request; if refresh fails, return to guest state.
- Offline or transient network failure: keep local state, queue sync, and retry with bounded backoff.
- Redis failure: fall through to Supabase.
- Supabase failure: preserve local state and return a retryable service error.
- Revision mismatch: return `409` and enter explicit conflict resolution.
- Invalid cloud payload: refuse to persist or load it, report a sanitized error, and leave the valid local copy intact.

No server error response includes a stack trace, provider message containing credentials, raw database error, or request body.

## Verification

Implementation stays focused first, followed by change-specific verification:

- Pure unit tests for reconciliation, pending sync, conflict choices, revision handling, payload validation, cache fallback/invalidation, rate limiting, and telemetry filtering.
- API tests with injected Supabase and Redis fakes.
- Browser tests proving guest play remains unchanged and account/save UI handles signed-in, pending, cloud-only, and conflict states.
- Strict typecheck and production build.
- A disposable-account smoke test against the connected Preview services: sign up, restore the session, write/read/cache/update/conflict/delete a save, then remove the test account.
- A Vercel Preview check that Analytics and Speed Insights intake scripts load when enabled and emit nothing through `beforeSend` when disabled.

The full simulation and renderer suites are run after the integration-specific checks pass, with unrelated pre-existing renderer timing diagnostics reported separately rather than treated as cloud-integration failures.

## Rollout

1. Add packages, environment typing, and safe Vite injection.
2. Add the Supabase migration and apply it to the connected project.
3. Build server primitives, auth routes, save routes, Redis caching, and Sentry server setup.
4. Add browser auth, cloud client, sync coordinator, and account/save UI.
5. Add Analytics, Speed Insights, Sentry browser setup, and the telemetry setting.
6. Run focused tests, disposable Preview smoke verification, full typecheck/build, and then the broader regression suites.

Resend is intentionally not initialized in this rollout. A later email spec can define whether it serves password recovery, account notifications, player support, or another concrete workflow.
