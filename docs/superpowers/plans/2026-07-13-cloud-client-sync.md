# Cloud Client and Save Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional remembered accounts and local-first cloud-save synchronization without changing guest play.

**Architecture:** A browser AuthService restores Supabase sessions, a typed CloudSaveClient calls the Vercel API, and a SaveSyncService wraps the existing persistence layer. Pure reconciliation produces explicit conflict states consumed by the Account and Save & Load windows.

**Tech Stack:** TypeScript, Supabase JS browser client, IndexedDB/localStorage persistence, existing DOM window kit, Vitest, Playwright

## Global Constraints

- Guest play and local saves remain fully functional without an account or network.
- Passwords are never stored by Perilune; Supabase persists only its session.
- Local persistence succeeds before cloud sync is attempted.
- Same-slot divergent saves are never resolved automatically.
- No animated or decorative status dots.
- Resend remains unused.

---

## File map

- `src/cloud/config.ts`: typed access to the narrowly inlined browser configuration.
- `src/cloud/auth.ts`: account/session state machine.
- `src/cloud/client.ts`: typed cloud-save API client.
- `src/cloud/reconcile.ts`: pure catalog reconciliation.
- `src/cloud/syncStore.ts`: persisted revisions, hashes, pending work, and conflicts.
- `src/cloud/saveSync.ts`: local-first orchestration and retries.
- `src/ui/account.ts`: Account window.
- `src/ui/utilityTools.ts`: unified save catalog, sync labels, and conflict actions.
- `src/save/persistence.ts`: write an already-validated SaveGame through existing backup rotation.
- `src/game.ts`: construct services and route all save/load/delete operations through sync.
- `tests/cloud-auth.test.ts`, `tests/cloud-reconcile.test.ts`, `tests/cloud-sync.test.ts`, `e2e/cloud-account.spec.ts`: focused behavior tests.

### Task 1: Safe browser configuration and remembered AuthService

**Files:**
- Modify: `vite.config.ts`
- Create: `src/env.d.ts`
- Create: `src/cloud/config.ts`
- Create: `src/cloud/auth.ts`
- Create: `tests/cloud-auth.test.ts`

**Interfaces:**
- Produces `CloudPublicConfig | null` from compile-time constants.
- Produces `AuthService.start`, `signUp`, `signIn`, `signOut`, `session`, and `subscribe`.

- [ ] **Step 1: Write failing auth tests with an injected Supabase port**

Define and test:

```ts
export type AuthState =
  | { kind: 'guest' }
  | { kind: 'loading' }
  | { kind: 'signed-in'; userId: string; email: string; accessToken: string }
  | { kind: 'unavailable'; message: string };

export interface AuthApi {
  restore(): Promise<AuthSession | null>;
  setSession(accessToken: string, refreshToken: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  onChange(listener: (session: AuthSession | null) => void): () => void;
}
```

Assert restored sessions become signed-in, invalid restoration becomes guest, proxy credentials are not persisted by the service, and sign-out retains unrelated storage.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/cloud-auth.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Add narrow Vite defines**

Read only the approved public values from `process.env` in `vite.config.ts` and define JSON string constants `__SUPABASE_URL__`, `__SUPABASE_PUBLISHABLE_KEY__`, `__SENTRY_DSN__`, and `__PERILUNE_RELEASE__`. Declare those constants in `src/env.d.ts`. Never spread `process.env` or use Vite's unrestricted env loading.

- [ ] **Step 4: Implement AuthService**

Create the Supabase browser client with `persistSession: true`, `autoRefreshToken: true`, and `detectSessionInUrl: false`. Signup/login call `/api/auth/*`, then call `setSession`. Map errors to stable account messages and publish auth state to subscribers.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npx vitest run tests/cloud-auth.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts src/env.d.ts src/cloud/config.ts src/cloud/auth.ts tests/cloud-auth.test.ts
git commit -m "feat: add remembered Supabase account sessions"
```

### Task 2: Typed cloud client and pure reconciliation

**Files:**
- Create: `src/cloud/client.ts`
- Create: `src/cloud/reconcile.ts`
- Create: `tests/cloud-reconcile.test.ts`

**Interfaces:**
- Produces `CloudSaveClient.list`, `read`, `put`, and `delete`.
- Produces `reconcileCatalog(local, cloud, syncState): ReconcileAction[]`.

- [ ] **Step 1: Write failing reconciliation tests**

Use these exact actions:

```ts
export type ReconcileAction =
  | { kind: 'upload'; slot: string }
  | { kind: 'cloud-only'; slot: string; cloud: CloudSaveMeta }
  | { kind: 'synced'; slot: string; cloud: CloudSaveMeta }
  | { kind: 'conflict'; slot: string; local: SaveSlotMeta; cloud: CloudSaveMeta };
```

Test local-only upload, cloud-only listing, equal-hash sync, divergent-hash conflict, and stale recorded revision conflict.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/cloud-reconcile.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the client and reconciler**

The client obtains a fresh access token from AuthService for every request, uses JSON envelopes, retries once after an auth refresh, and maps `409 SAVE_CONFLICT`, `429`, and retryable `503` without throwing provider details into UI code.

Compute local SHA-256 hashes from the exact serialized SaveGame JSON through `crypto.subtle.digest` in the browser.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npx vitest run tests/cloud-reconcile.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/client.ts src/cloud/reconcile.ts tests/cloud-reconcile.test.ts
git commit -m "feat: add cloud save client and reconciliation"
```

### Task 3: Local-first sync state and orchestration

**Files:**
- Modify: `src/save/persistence.ts`
- Create: `src/cloud/syncStore.ts`
- Create: `src/cloud/saveSync.ts`
- Create: `tests/cloud-sync.test.ts`

**Interfaces:**
- Produces `writeSaveDocument(slot, save): Promise<boolean>` using existing validation and backup rotation.
- Produces `SaveSyncService.initialize`, `write`, `read`, `list`, `delete`, `resolveConflict`, and `retryPending`.

- [ ] **Step 1: Write failing sync tests**

With in-memory local/cloud ports, assert:

```ts
await sync.write(game, 'mission-1', 'Mission 1');
expect(local.has('mission-1')).toBe(true);
expect(cloud.putCalls[0]?.slot).toBe('mission-1');
```

Also assert local success plus cloud failure produces `pending`, restart restores pending work, retries clear it, a stale put produces conflict without overwriting either side, cloud-only load persists locally, and synced delete removes cloud before local.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/cloud-sync.test.ts`

Expected: FAIL with missing sync modules.

- [ ] **Step 3: Expose document persistence**

Refactor `writeSave` to call:

```ts
export async function writeSaveDocument(slot: string, save: SaveGame): Promise<boolean>;
```

This function validates the supplied document, rotates the same three local backups, and writes the same `save:<slot>` key. Existing callers and tests must remain behaviorally unchanged.

- [ ] **Step 4: Implement persisted sync metadata**

Store a versioned record under `perilune.cloud.sync.v1` containing per-slot `{ revision, payloadHash, state }`, pending attempts, next retry time, and conflict cloud metadata. Store no tokens, email, or payloads.

- [ ] **Step 5: Implement SaveSyncService**

Local write is always first. Cloud work begins only when AuthService is signed in. Retry delays are bounded at 1, 2, 4, 8, and 30 seconds. Register `online` and auth-state listeners; never run timers in the simulation loop.

Conflict methods implement `keep-local`, `keep-cloud`, and `keep-both`. `keep-both` chooses `<slot>-local`, then numeric suffixes until both catalogs are collision-free.

- [ ] **Step 6: Run sync tests and persistence regression**

Run:

```bash
npx vitest run tests/cloud-sync.test.ts tests/save-maneuver.test.ts tests/ui-windows.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/save/persistence.ts src/cloud/syncStore.ts src/cloud/saveSync.ts tests/cloud-sync.test.ts
git commit -m "feat: add local-first cloud save sync"
```

### Task 4: Account and unified save UI

**Files:**
- Create: `src/ui/account.ts`
- Modify: `src/ui/utilityTools.ts`
- Modify: `src/ui/kit.ts`
- Modify: `src/game.ts`
- Create: `e2e/cloud-account.spec.ts`

**Interfaces:**
- Consumes AuthService and SaveSyncService.
- Produces Account window plus unified `Local`, `Cloud`, `Synced`, `Pending`, and `Conflict` save rows.

- [ ] **Step 1: Write focused browser tests**

Add a test-only injected cloud port so Playwright can exercise account and sync states without live services. Assert guest Save & Load still works, Account shows create/sign-in, remembered signed-in state shows email/sign-out, and conflict rows expose exactly Keep local, Keep cloud, and Keep both.

- [ ] **Step 2: Verify the focused test fails**

Run: `npx playwright test e2e/cloud-account.spec.ts`

Expected: FAIL because Account UI is absent.

- [ ] **Step 3: Implement AccountWindow**

Register an `account` window with the existing WindowManager. Disable duplicate submissions, use `autocomplete="email"`, `autocomplete="current-password"` or `new-password`, announce errors in an `aria-live="polite"` region, and never echo the password.

- [ ] **Step 4: Integrate SaveSyncService**

Construct AuthService and SaveSyncService after ProfileStore creation in `game.ts`. Route named saves, autosaves, quicksaves, loads, and deletes through sync. Start session restoration and reconciliation without delaying guest boot.

Change UtilityTools callbacks to consume unified save rows and conflict actions. Render functional text labels only; do not add dots or pulsing indicators.

- [ ] **Step 5: Run UI and regression checks**

Run:

```bash
npx playwright test e2e/cloud-account.spec.ts e2e/mission-tools.spec.ts e2e/game-loop.spec.ts
npx vitest run tests/cloud-auth.test.ts tests/cloud-reconcile.test.ts tests/cloud-sync.test.ts tests/ui-windows.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/account.ts src/ui/utilityTools.ts src/ui/kit.ts src/game.ts e2e/cloud-account.spec.ts
git commit -m "feat: add accounts and unified cloud saves"
```
