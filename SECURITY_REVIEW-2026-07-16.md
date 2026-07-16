# Perilune — Security Review (2026-07-16)

**Scope:** full-stack review of the app going to production. Covers secret management, the serverless auth + cloud-save API, Supabase/Postgres data authorization, rate limiting, client-side XSS/token handling, telemetry/PII, dependencies, and the **live** Vercel + Supabase production surface (`https://perilune-wine.vercel.app`).

**Reviewer note:** No application code was changed. The stronger-model advisor pass was unavailable this session; findings rest on direct code reading, the deployed bundle, live HTTP probes against production, and the Supabase security advisor.

---

## Verdict

**No critical (P0) vulnerability. Nothing found lets an attacker read another user's data, steal a secret, or bypass authentication.** Secrets are correctly partitioned (none reach the client bundle), cross-user data access is defended in three independent layers, and auth is rate-limited and fails closed.

The production deployment **is public** at `https://perilune-wine.vercel.app` (Vercel Deployment Protection only shields the auto-generated `*-nicknetra` aliases, not this one). So the hardening gaps below are **live now**, not hypothetical. The most urgent items before you promote/announce:

1. **Cloud-save API is fully down in production** — every `/api/saves*` request returns `500`. It fails *closed* (no data leaked), so it's a reliability break, not a breach — but the feature doesn't work.
2. **No HTTP security headers / CSP** on the public app.
3. **`perilune.vercel.app`** (the clean alias) is owned by an unrelated app.

---

## What is solid (verified)

| Area | Evidence |
|---|---|
| **Secrets never committed** | `.env.preview.local` and `.vercel/*.local` are untracked and never appear in git history. `.gitignore`/`.vercelignore` cover `*.local` and `.vercel`. |
| **No secret in the deployed client bundle** | Fetched the live `assets/index-*.js` + `three-*.js` from production and grepped for every sensitive value (service-role key, JWT secret, Postgres password, Resend key, Sentry auth token) → **0 hits**. `vite.config.ts` `define` only injects `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`/anon, `SENTRY_DSN` (public-safe). |
| **No cross-user data access (IDOR)** | Three layers: (a) `verifyUser` validates the JWT via `supabase.auth.getUser(token)` — real validation, not a decode; (b) every query filters `.eq('user_id', userId)`; (c) Postgres **RLS** scopes every op to `auth.uid() = user_id`, `anon` revoked. **Supabase security advisor returns zero lints** → RLS is live with no gaps. |
| **Auth hardening** | Email + password validated, payload capped at 16 KB, per-identity **and** per-IP rate limits, generic error messages (no user enumeration). Live probe: `POST /api/auth/login` with a non-JSON body correctly returns `415` JSON. |
| **Rate limiting fails closed** | `server/env.ts` throws `503` in production if `REDIS_URL` is missing; if Redis is unreachable the limiter reports `backendAvailable=false` and auth returns `503` rather than allowing unlimited attempts. |
| **Save write validation** | Slot regex, 2 MB payload cap with streaming byte-count enforcement, strict `validateSave` structural check, optimistic concurrency via `revision`, refuses saves newer than `SAVE_VERSION`. |
| **No XSS sink** | Every `innerHTML` in `src/` is a clear (`= ''`) or a static literal; no user data is interpolated into HTML. User strings use `textContent`/`.value`. No `eval`/`new Function`/`document.write`. No prototype-pollution merge of untrusted input. |
| **Telemetry / PII** | Analytics uses a hard allowlist (`safeAnalyticsProperties` — only known enum values pass). Sentry (client + server) sets `sendDefaultPii:false` and a `beforeSend` that strips request bodies, breadcrumbs, extra, message; keeps only exception type/mechanism/stacktrace + `user.id`. URLs query-stripped. |
| **No CSRF surface** | API authenticates via `Authorization: Bearer`, not cookies; Supabase session in `localStorage`, `detectSessionInUrl:false`. |
| **Dependencies** | `npm audit` (prod) = 0 vulnerabilities; deps small and current (Supabase 2.110, Sentry 10.65, three 0.170). |
| **Sourcemaps NOT exposed in prod** | `assets/index-*.js.map` returns **404** in production — the client sourcemaps are not publicly served. |
| **HSTS on** | `strict-transport-security: max-age=63072000; includeSubDomains; preload` present. |

---

## Findings

| # | Severity | Finding |
|---|---|---|
| 1 | **High (reliability; fails closed)** | Cloud-save API 500s on every request in production |
| 2 | **High** | No HTTP security headers / CSP on the public app |
| 3 | **Medium–High (operational)** | Supabase project is **INACTIVE**; cloud stack effectively non-functional |
| 4 | **Medium (operational)** | `perilune.vercel.app` is owned by an unrelated app |
| 5 | **Medium (abuse/UX)** | No email verification — accounts auto-confirmed |
| 6 | **Low–Medium** | Client build shipped without Supabase config |
| 7 | **Low** | Password policy is length-only |
| 8 | **Low (robustness)** | Rate-limit increment is non-atomic |
| 9 | **Informational** | Sentry keeps full stacktrace frames |
| — | **Resolved** | Sourcemaps not served in prod (was a concern; verified 404) |

### 1 — Cloud-save API crashes on every request *(High reliability; security fails closed)*
Live production: `GET /api/saves`, `GET /api/saves/<slot>`, with **no token and with a fake token**, all return `500 FUNCTION_INVOCATION_FAILED` (Vercel platform error, plain text). `POST /api/auth/login` works. A no-auth GET should hit the `bearerToken()` → `401` throw *inside* the handler's try/catch and return JSON `401`; a platform `500` instead means the function is crashing at **module load**, before handler logic runs.

Root cause (from the import graph): the saves functions import `server/saveRuntime` → `saveHandlers` → **`src/save/schema.ts`**, which imports value modules from the client game graph (`sim/interstage`, `content/science`, `content/system`'s `AUREN_SYSTEM`, `sim/science`). Something in that graph throws at import time on the Vercel Node runtime (browser/DOM coupling or a circular-import binding that's `undefined` when executed — invisible to `tsc`, which only type-checks). The auth functions don't import that graph, which is why they load fine. This also crosses the architectural boundary in `CLAUDE.md` (serverless code pulling in the full `src/` game graph).

**Security impact:** none directly — it fails closed (no data returned, no stack trace leaked, generic platform error). But the cloud-save feature is **completely broken in prod**, and every unauthenticated request spins up a crashing invocation (minor DoS/cost amplifier).

**Remediation:** stop importing the game module graph into serverless functions. Extract a minimal, dependency-free save-validation module (or duplicate just the shape check) that the API can import without dragging in `sim/`/`content/`. Then confirm via Vercel **runtime logs** (they'll name the throwing module).

### 2 — No security headers / CSP on the public app *(High)*
`vercel.json` has no `headers` block; `index.html` has no CSP `<meta>`. Live probe of `https://perilune-wine.vercel.app/` confirms **no** `content-security-policy`, `x-frame-options`, `x-content-type-options`, `referrer-policy`, or `permissions-policy` (only HSTS is set, via Vercel default). The COOP/COEP in `vite.config.ts` apply only to the dev/preview servers.

Why it matters: the Supabase client uses `persistSession:true`, so the **refresh token lives in `localStorage`**. No XSS sink exists today, but with zero CSP a *single future* XSS (new dependency, a careless `innerHTML`) escalates straight to refresh-token theft / account takeover. `X-Frame-Options: DENY` also closes clickjacking of the account UI; `nosniff` closes MIME confusion.

**Remediation:** add a `headers` block to `vercel.json` (or `vercel.ts`) for `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. The CSP's `connect-src` must allow the Supabase URL, Sentry ingest, and Vercel analytics/insights; WebGL/WASM needs care with `script-src`/`worker-src`. I can draft the exact policy.

### 3 — Supabase project is INACTIVE *(Medium–High, operational)*
The project (`xainpccovltwovrmspth`) status is **INACTIVE (paused)** — a live table query timed out. A paused DB means auth + cloud saves can't function (and free-tier auto-pause is unacceptable for prod). Combined with #1 and #6, the cloud stack is effectively non-operational in this deployment. Move to a plan that stays active and un-pause before relying on cloud features.

### 4 — `perilune.vercel.app` belongs to a different app *(Medium, operational)*
`https://perilune.vercel.app` serves an unrelated **Next.js** site (meta description "Simply beautiful open source icons"); its `/api/*` 404s. Global-subdomain name collision, not a flaw in your code — but you can't launch on that hostname, and anyone sent there lands on a stranger's app. Decide/confirm the real production domain (you're currently live on `perilune-wine.vercel.app`) and make sure the Supabase Auth allowed-redirect/origin list matches it.

### 5 — No email verification *(Medium, abuse/UX)*
`server/authHandlers.ts` signup uses `admin.createUser({ email_confirm: true })`, auto-confirming without proving ownership. Anyone can register any address — enabling **account squatting** (register a victim's email, blocking their signup) and unverified contact data. `RESEND_API_KEY` is configured but not wired into a confirmation flow. Decide whether verified email is required before launch.

### 6 — Client build shipped without Supabase config *(Low–Medium)*
The deployed `assets/index-*.js` contains **0** occurrences of `supabase`, `createClient`, the project ref, or the "unavailable in this build" marker — the cloud/account client code isn't in the served bundle, implying `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` were empty at **build** time on Vercel (they're separate from the functions' runtime env). Result: the in-app account UI is likely non-functional even though the API exists. Not a security issue (nothing leaked), but confirms the cloud feature isn't wired end-to-end. Set the build-time public env vars in the Vercel project.

### 7 — Length-only password policy *(Low)*
Passwords checked only for length (8–256). Enable Supabase Auth's **leaked-password protection (HaveIBeenPwned)** and a minimum-strength setting in the dashboard.

### 8 — Non-atomic rate-limit increment *(Low, robustness)*
`redis.ts increment` does `INCR` → `EXPIRE` → `TTL` as separate calls. If the process dies between `INCR` (count==1) and `EXPIRE`, the key can persist without a TTL and wedge that identity's limit. Security holds; reliability edge. Consider a Lua script or `SET key 1 EX win NX` + `INCR`.

### 9 — Sentry retains stacktrace frames *(Informational)*
Both scrubbers keep `exception.stacktrace` verbatim. The SDKs don't attach local-variable values by default, so PII exposure is unlikely — do not enable local-variable capture, and keep `sendDefaultPii:false`.

---

## Production verification (live: `perilune-wine.vercel.app`)

| Check | Result |
|---|---|
| Public accessibility | **Public**, HTTP 200 (this alias has no Deployment Protection) |
| HSTS | ✅ present |
| CSP / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy | ❌ **all absent** (finding #2) |
| Secret in served JS bundle | ✅ none (0 hits for every server secret) |
| Sourcemaps served | ✅ no — `.map` returns 404 |
| `POST /api/auth/login` (bad content-type) | ✅ `415` JSON — function healthy, validation works |
| `GET /api/saves*` (no auth / fake token) | ❌ `500 FUNCTION_INVOCATION_FAILED` — crashes at load (finding #1); fails closed |
| Supabase security advisor | ✅ 0 lints (RLS live) |
| Supabase project status | ❌ INACTIVE (finding #3) |

**Still not directly verified (needs access):** Vercel **runtime logs** (would name the module that crashes the saves function), and the Vercel project **environment-variable** configuration. The Vercel MCP token is scoped to `nicknetra` and returns **403** on this team — re-authenticate it to the team scope and I can pull both.

---

## Recommended order before you announce / rely on cloud

1. **Fix the saves-function crash** (finding #1) — decouple serverless code from the `src/` game graph; confirm via Vercel runtime logs.
2. **Add the `vercel.json` security-headers + CSP block** (finding #2).
3. **Un-pause / upgrade Supabase** (#3) and **set the build-time public env vars** so cloud accounts actually work client-side (#6).
4. **Resolve the production hostname / domain** (#4).
5. **Decide email verification** (#5) and **enable leaked-password protection** (#7).
6. Lower-priority robustness: rate-limit atomicity (#8).

**Net:** the security *design* is strong and there is no data-exposure hole today. The blockers are that the cloud stack isn't actually working in prod (#1, #3, #6) and the public app lacks defense-in-depth headers (#2). Fix those before leaning on cloud saves publicly.
