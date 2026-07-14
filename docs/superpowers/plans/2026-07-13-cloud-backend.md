# Cloud Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Supabase schema and Vercel API boundary for rate-limited authentication and revision-safe cached cloud saves.

**Architecture:** Vercel Web API functions delegate to focused server modules. Every save request verifies a Supabase bearer token, reads or mutates `cloud_saves` through an RLS-scoped client, and treats Redis as a five-minute best-effort cache.

**Tech Stack:** TypeScript, Vercel Node.js Web API functions, Supabase JS, node-redis, Vitest, PostgreSQL/RLS

## Global Constraints

- Guest play and local saves must work without any cloud environment variables.
- The browser may receive only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` or its anon-key fallback, `SENTRY_DSN`, and `VERCEL_GIT_COMMIT_SHA`.
- Save payloads are limited to 2 MB and slots to the existing 48-character normalized form.
- Redis has a five-minute TTL, is never authoritative, and is accessed only after authentication for save data.
- Runtime save operations must use an RLS-scoped Supabase client, never the service-role key.
- Resend stays uninitialized.

---

## File map

- `supabase/migrations/20260713221500_cloud_saves.sql`: table, constraints, grants, indexes, RLS.
- `scripts/apply-cloud-migration.mjs`: apply and verify the checked-in migration through the non-pooling Postgres URL.
- `server/env.ts`: validate server configuration without exposing values.
- `server/http.ts`: request parsing, stable JSON envelopes, request IDs, size limits.
- `server/redis.ts`: one reusable node-redis connection plus best-effort cache helpers.
- `server/rateLimit.ts`: hashed identities and fixed-window limits.
- `server/supabase.ts`: auth proxy client, token verification, and RLS-scoped client creation.
- `server/authHandlers.ts`: injectable signup/login behavior.
- `server/saveHandlers.ts`: injectable list/read/put/delete behavior and cache invalidation.
- `api/auth/signup.ts`, `api/auth/login.ts`, `api/saves/index.ts`, `api/saves/[slot].ts`: thin Vercel function adapters.
- `tests/cloud-migration.test.ts`, `tests/server-http.test.ts`, `tests/server-auth.test.ts`, `tests/server-saves.test.ts`: focused backend tests.

### Task 1: Dependencies and compilation boundaries

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces installed `@supabase/supabase-js` and `redis` packages.
- Produces strict compilation coverage for `api/**/*.ts` and `server/**/*.ts`.

- [ ] **Step 1: Install backend dependencies**

Run:

```bash
npm install @supabase/supabase-js redis
npm install --save-dev postgres
```

Expected: package and lock files list both runtime dependencies.

- [ ] **Step 2: Compile server and API code under the root config**

Change `tsconfig.json` to:

```json
"include": ["src", "api", "server", "tests", "bench", "scripts"]
```

- [ ] **Step 3: Verify the baseline**

Run: `npm run typecheck`

Expected: PASS before new backend files are introduced.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "build: add cloud backend dependencies"
```

### Task 2: Supabase cloud-save migration

**Files:**
- Create: `supabase/migrations/20260713221500_cloud_saves.sql`
- Create: `scripts/apply-cloud-migration.mjs`
- Create: `tests/cloud-migration.test.ts`

**Interfaces:**
- Produces table `public.cloud_saves` with primary key `(user_id, slot)`.
- Produces authenticated-only RLS policies based on `(select auth.uid()) = user_id`.

- [ ] **Step 1: Write the migration contract test**

Create a test that loads the SQL and asserts the load-bearing clauses:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../supabase/migrations/20260713221500_cloud_saves.sql', import.meta.url),
  'utf8',
);

describe('cloud save migration', () => {
  it('creates an owner-scoped revisioned save table with RLS', () => {
    expect(sql).toContain('create table if not exists public.cloud_saves');
    expect(sql).toContain('primary key (user_id, slot)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('(select auth.uid()) = user_id');
    expect(sql).toContain('to authenticated');
    expect(sql).toContain('revoke all on table public.cloud_saves from anon');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cloud-migration.test.ts`

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Write the migration**

Create SQL defining the approved columns, constraints, index, grants, and four owner policies. Use these exact core clauses:

```sql
create table if not exists public.cloud_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot text not null check (slot ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  label text not null check (char_length(label) between 1 and 120),
  save_version integer not null check (save_version > 0),
  payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, slot)
);

alter table public.cloud_saves enable row level security;
revoke all on table public.cloud_saves from anon;
grant select, insert, update, delete on table public.cloud_saves to authenticated;
```

Add separate select, insert, update, and delete policies with `to authenticated`, `using`, and `with check` as applicable.

- [ ] **Step 4: Add the migration runner**

Create a script that requires `POSTGRES_URL_NON_POOLING`, reads only the checked-in migration, executes it with `postgres(url, { max: 1, ssl: 'require' })`, then verifies the table, primary key, RLS flag, and four policies through catalog queries. Always call `sql.end()` in `finally`, and print object names/counts without printing the URL.

- [ ] **Step 5: Run the migration test**

Run: `npx vitest run tests/cloud-migration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260713221500_cloud_saves.sql scripts/apply-cloud-migration.mjs tests/cloud-migration.test.ts
git commit -m "feat: define owner-scoped cloud saves"
```

### Task 3: HTTP, environment, Redis, and rate-limit primitives

**Files:**
- Create: `server/env.ts`
- Create: `server/http.ts`
- Create: `server/redis.ts`
- Create: `server/rateLimit.ts`
- Create: `tests/server-http.test.ts`

**Interfaces:**
- Produces `serverEnv(source?: NodeJS.ProcessEnv): ServerEnv`.
- Produces `jsonOk<T>(data: T, status?: number)` and `jsonError(code, message, status, requestId)`.
- Produces `readJsonBody<T>(request, maxBytes): Promise<T>`.
- Produces `RateLimiter.consume(scope, identity, limit, windowSeconds): Promise<RateLimitResult>`.
- Produces `CacheStore.getJson`, `setJson`, `delete`, and `increment` with no-throw best-effort semantics for cache calls.

- [ ] **Step 1: Write failing primitive tests**

Cover missing environment configuration, stable error envelopes, the 2 MB body guard, SHA-256 rate-limit identities, and Redis fallback through an injected fake:

```ts
expect(() => serverEnv({})).toThrow(/SUPABASE_URL/);
expect((await jsonError('BAD_REQUEST', 'Invalid request', 400, 'req-1').json())).toEqual({
  ok: false,
  error: { code: 'BAD_REQUEST', message: 'Invalid request', requestId: 'req-1' },
});
expect(rateLimitIdentity('Player@Example.com', '127.0.0.1')).toMatch(/^[a-f0-9]{64}$/);
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/server-http.test.ts`

Expected: FAIL with missing server modules.

- [ ] **Step 3: Implement the primitives**

Define:

```ts
export interface ServerEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
  redisUrl: string | null;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface CacheStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  increment(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}
```

Use `crypto.randomUUID()` for request IDs and `createHash('sha256')` for rate-limit identities. Reuse one node-redis client promise per process and register an `error` listener. Cache methods catch connection/command errors and return misses; rate limiting fails open only when Redis is unavailable so guest/cloud functionality is not blocked by the cache integration.

- [ ] **Step 4: Run primitive tests and typecheck**

Run:

```bash
npx vitest run tests/server-http.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/env.ts server/http.ts server/redis.ts server/rateLimit.ts tests/server-http.test.ts
git commit -m "feat: add cloud API server primitives"
```

### Task 4: Rate-limited Supabase authentication routes

**Files:**
- Create: `server/supabase.ts`
- Create: `server/authHandlers.ts`
- Create: `api/auth/signup.ts`
- Create: `api/auth/login.ts`
- Create: `tests/server-auth.test.ts`

**Interfaces:**
- Produces `createAuthHandler(mode, dependencies): (request: Request) => Promise<Response>`.
- Produces successful `{ session: { accessToken, refreshToken, expiresAt }, user: { id, email } }` responses.

- [ ] **Step 1: Write failing handler tests**

Use injected fakes to assert method checks, neutral invalid-credential errors, rate limiting, and successful token shaping:

```ts
const response = await handler(new Request('https://perilune.test/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  body: JSON.stringify({ email: 'pilot@example.com', password: 'correct horse battery staple' }),
}));
expect(response.status).toBe(200);
expect(await response.json()).toMatchObject({
  ok: true,
  data: { user: { email: 'pilot@example.com' } },
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/server-auth.test.ts`

Expected: FAIL with missing handler.

- [ ] **Step 3: Implement injectable auth handlers**

Validate email with a bounded pragmatic pattern, require Supabase's minimum password length, limit JSON bodies to 16 KB, normalize email, consume the Redis limit, then call either `supabase.auth.signUp` or `supabase.auth.signInWithPassword`. Return only the tokens, expiry, UUID, and email needed by `setSession`.

Export Vercel adapters in the Web API form:

```ts
export default {
  fetch(request: Request) {
    return signupHandler(request);
  },
};
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npx vitest run tests/server-auth.test.ts tests/server-http.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/supabase.ts server/authHandlers.ts api/auth tests/server-auth.test.ts
git commit -m "feat: add rate-limited account endpoints"
```

### Task 5: Revision-safe cloud-save API with Redis cache

**Files:**
- Create: `server/saveHandlers.ts`
- Create: `api/saves/index.ts`
- Create: `api/saves/[slot].ts`
- Create: `tests/server-saves.test.ts`

**Interfaces:**
- Produces `createSaveCollectionHandler(deps)` for list.
- Produces `createSaveItemHandler(deps)` for get/put/delete.
- Consumes the existing `validateSave` and `SAVE_VERSION` contracts.

- [ ] **Step 1: Write failing save-handler tests**

Test unauthenticated rejection before Redis access, list and item cache hits, cache misses, cache failure fallback, payload validation, 2 MB rejection, creation at revision 1, update at `expectedRevision + 1`, stale `409`, cache invalidation, and stale-delete protection.

Use an injectable repository interface:

```ts
export interface CloudSaveRepository {
  list(userId: string): Promise<CloudSaveMeta[]>;
  read(userId: string, slot: string): Promise<CloudSaveRecord | null>;
  create(userId: string, input: CloudSaveWrite): Promise<CloudSaveRecord | 'conflict'>;
  update(userId: string, input: CloudSaveWrite & { expectedRevision: number }): Promise<CloudSaveRecord | 'conflict'>;
  delete(userId: string, slot: string, expectedRevision: number): Promise<'deleted' | 'conflict' | 'missing'>;
}
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/server-saves.test.ts`

Expected: FAIL with missing save handler.

- [ ] **Step 3: Implement the repository and handlers**

Define stable records:

```ts
export interface CloudSaveMeta {
  slot: string;
  label: string;
  saveVersion: number;
  payloadHash: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSaveRecord extends CloudSaveMeta {
  payload: SaveGame;
}
```

Hash the exact JSON payload with SHA-256. For updates, issue an RLS-scoped Supabase update filtered by `user_id`, `slot`, and `revision`; zero returned rows means conflict. For create, map PostgreSQL unique violations to conflict. Use cache keys `perilune:saves:list:<uuid>` and `perilune:saves:item:<uuid>:<encoded-slot>` with TTL 300.

- [ ] **Step 4: Add thin Vercel adapters**

`api/saves/index.ts` allows GET. `api/saves/[slot].ts` extracts the final decoded pathname segment and delegates GET, PUT, and DELETE to the item handler. Unsupported methods return `405` with an `Allow` header.

- [ ] **Step 5: Run backend verification**

Run:

```bash
npx vitest run tests/cloud-migration.test.ts tests/server-http.test.ts tests/server-auth.test.ts tests/server-saves.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Apply the migration to the connected Supabase project**

Run:

```bash
vercel env pull .env.preview.local --environment=preview --yes
node --env-file=.env.preview.local scripts/apply-cloud-migration.mjs
```

Expected: the script reports `cloud_saves`, RLS enabled, one primary key, and four owner policies without printing credentials.

- [ ] **Step 7: Commit**

```bash
git add server/saveHandlers.ts api/saves tests/server-saves.test.ts
git commit -m "feat: add cached revision-safe cloud save API"
```
