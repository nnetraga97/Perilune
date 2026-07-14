# Observability Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-filtered Sentry diagnostics, Vercel Analytics, and Vercel Speed Insights under one default-on player preference.

**Architecture:** A single TelemetryService is the only application-facing observability API. It initializes browser products from narrowly inlined public configuration, filters every event, and can stop or restart collection dynamically; server functions use a separate scrubbed Sentry Node helper.

**Tech Stack:** TypeScript, `@sentry/browser`, `@sentry/node`, `@sentry/vite-plugin`, `@vercel/analytics`, `@vercel/speed-insights`, Vitest, Playwright

## Global Constraints

- Telemetry is enabled by default and controlled by one Settings toggle.
- Turning telemetry off must suppress Analytics, Speed Insights, custom events, and Sentry delivery without affecting functional API calls.
- Never send email, password, tokens, authorization headers, cookies, request/response bodies, query strings, save metadata, craft names, or mission names.
- Sentry user context may contain only the Supabase UUID.
- Speed Insights starts at a 100% sample rate.
- Production source maps are uploaded to Sentry and removed from deployment artifacts.
- Resend remains unused.

---

## File map

- `src/telemetry/privacy.ts`: pure URL/event scrubbing and allowlists.
- `src/telemetry/service.ts`: browser Sentry, Analytics, and Speed Insights lifecycle.
- `server/sentry.ts`: Node Sentry setup and sanitized capture helpers.
- `vite.config.ts`: conditional Sentry plugin and source-map cleanup.
- `src/ui/utilityTools.ts`: telemetry preference.
- `src/main.ts`, `src/game.ts`, `src/cloud/auth.ts`, `src/cloud/saveSync.ts`: allowlisted event calls and error capture.
- `api/**/*.ts`: server capture wrapper.
- `tests/telemetry.test.ts`, `tests/server-sentry.test.ts`, `e2e/telemetry.spec.ts`: focused privacy and toggle tests.

### Task 1: Dependencies and pure privacy policy

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/telemetry/privacy.ts`
- Create: `tests/telemetry.test.ts`

**Interfaces:**
- Produces `TelemetryEventName` allowlist.
- Produces `stripQuery(url)`, `scrubSentryEvent(event)`, and `safeAnalyticsProperties(name, input)`.

- [ ] **Step 1: Install observability dependencies**

Run:

```bash
npm install @sentry/browser @sentry/node @vercel/speed-insights
npm install --save-dev @sentry/vite-plugin
```

- [ ] **Step 2: Write failing privacy tests**

Assert query stripping, removal of request headers/data/cookies, email removal, UUID-only user context, and rejection of unknown Analytics properties:

```ts
expect(stripQuery('https://perilune.test/?token=secret')).toBe('https://perilune.test/');
expect(safeAnalyticsProperties('cloud_sync', { result: 'pending', email: 'x@y.test' })).toEqual({ result: 'pending' });
```

- [ ] **Step 3: Verify failure**

Run: `npx vitest run tests/telemetry.test.ts`

Expected: FAIL with missing privacy module.

- [ ] **Step 4: Implement the allowlist and scrubber**

The event union is:

```ts
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
```

Each name has an explicit property schema of bounded enums/booleans. Unknown properties are dropped. The Sentry scrubber reconstructs a minimal safe event instead of recursively trying to redact arbitrary payloads.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run tests/telemetry.test.ts
git add package.json package-lock.json src/telemetry/privacy.ts tests/telemetry.test.ts
git commit -m "feat: define privacy-safe telemetry policy"
```

### Task 2: Browser telemetry lifecycle and Settings toggle

**Files:**
- Create: `src/telemetry/service.ts`
- Modify: `src/ui/utilityTools.ts`
- Modify: `src/main.ts`
- Modify: `src/game.ts`
- Modify: `src/cloud/auth.ts`
- Modify: `src/cloud/saveSync.ts`
- Modify: `tests/telemetry.test.ts`

**Interfaces:**
- Produces `TelemetryService.start`, `setEnabled`, `setUser`, `track`, `captureError`, and `close`.
- Extends `UiSettings` with `telemetryEnabled: boolean`, default `true`.

- [ ] **Step 1: Add failing lifecycle tests with injected SDK ports**

Assert disabled boot initializes nothing, enabled boot initializes all three products, `beforeSend` returns null after disable, Sentry closes, re-enable reinitializes, user context contains only ID, and disallowed custom data is dropped.

- [ ] **Step 2: Implement TelemetryService**

Use injected ports in tests and dynamic imports in production. Initialize Analytics with `inject({ beforeSend })`, Speed Insights with `injectSpeedInsights({ sampleRate: 1, beforeSend })`, and Sentry with `sendDefaultPii: false`, release, environment, scrubber, and a conservative traces sample rate. `track` delegates only approved names and properties.

- [ ] **Step 3: Add the Settings toggle**

Add `telemetryEnabled` to the settings type/defaults and render **Share anonymous diagnostics and usage**. Apply changes immediately through a new `UtilityCallbacks.onTelemetry(enabled)` callback.

- [ ] **Step 4: Instrument approved events**

Track only the approved lifecycle points. Pass enums such as `{ mode: 'guest' | 'account' }` or `{ result: 'synced' | 'pending' | 'conflict' }`; do not pass dynamic names or labels. Capture boot and explicit persistence/sync errors through the service.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/telemetry.test.ts tests/cloud-auth.test.ts tests/cloud-sync.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry src/ui/utilityTools.ts src/main.ts src/game.ts src/cloud/auth.ts src/cloud/saveSync.ts tests/telemetry.test.ts
git commit -m "feat: add opt-out browser observability"
```

### Task 3: Server Sentry and production source maps

**Files:**
- Create: `server/sentry.ts`
- Create: `tests/server-sentry.test.ts`
- Modify: `server/redis.ts`
- Modify: `api/auth/signup.ts`
- Modify: `api/auth/login.ts`
- Modify: `api/saves/index.ts`
- Modify: `api/saves/[slot].ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Produces `captureServerError(error, context)` and `withServerTelemetry(handler)`.
- Conditionally configures `sentryVitePlugin` only when auth token, org, and project exist.

- [ ] **Step 1: Write failing server scrub tests**

Inject a capture port and assert errors include request ID, operation, and dependency enums while excluding headers, request bodies, email, slot, label, and payload.

- [ ] **Step 2: Implement Node Sentry wrapper**

Initialize once per process with `sendDefaultPii: false`. Wrap route handlers in a try/catch that captures sanitized context, flushes within a short bound, and returns the existing stable `500 INTERNAL_ERROR` envelope. Redis fallback uses warning-level messages without cache values or keys containing user material.

- [ ] **Step 3: Configure source-map upload**

Make `vite.config.ts` a function config. When `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` exist, add `sentryVitePlugin({ org, project, authToken, sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] } })`. Keep production `build.sourcemap: true`; no plugin runs during ordinary local tests without credentials.

- [ ] **Step 4: Run verification and commit**

```bash
npx vitest run tests/server-sentry.test.ts tests/server-http.test.ts tests/server-auth.test.ts tests/server-saves.test.ts
npm run typecheck
npm run build
git add server/sentry.ts tests/server-sentry.test.ts server/redis.ts api vite.config.ts
git commit -m "feat: add server diagnostics and source maps"
```

### Task 4: Telemetry browser verification and connected-service smoke test

**Files:**
- Create: `e2e/telemetry.spec.ts`
- Create: `scripts/smoke-cloud-services.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `npm run smoke:cloud` for disposable Preview-service verification.

- [ ] **Step 1: Add telemetry browser test**

Intercept Vercel Analytics and Speed Insights intake. With telemetry enabled, assert their scripts are requested; toggle the setting off and assert `beforeSend` prevents subsequent intake. Assert no captured request contains account email or save labels.

- [ ] **Step 2: Add disposable cloud smoke script**

Generate a unique `codex-smoke-<timestamp>@example.invalid` account, sign up, save/list/read/update, deliberately issue a stale update and expect `409`, delete the save, and remove the test user through the server-only service-role client in a `finally` block. Print only step names and statuses.

- [ ] **Step 3: Run change-specific verification**

Run:

```bash
npx playwright test e2e/cloud-account.spec.ts e2e/telemetry.spec.ts e2e/mission-tools.spec.ts e2e/game-loop.spec.ts
npm test
npm run typecheck
npm run build
```

Expected: all change-specific tests, Vitest, typecheck, and build pass.

- [ ] **Step 4: Deploy Preview and run connected checks**

Deploy a Vercel Preview, run `npm run smoke:cloud -- <preview-url>` with pulled Preview secrets, and verify Analytics/Speed Insights intake in Playwright. Verify the disposable user is removed even after a failed assertion.

- [ ] **Step 5: Commit**

```bash
git add e2e/telemetry.spec.ts scripts/smoke-cloud-services.mjs package.json package-lock.json
git commit -m "test: verify cloud services integration"
```
