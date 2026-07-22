# Cloud database migrations

Application and preview builds never receive DDL credentials and never mutate the database.
Production migrations run only from the manually dispatched **Cloud database migrations**
workflow after approval of the `production-database` environment.

Before applying, take or verify a current Supabase backup and review every new checked SQL
file. Dispatch the workflow for the intended commit. The runner applies each unapplied file
transactionally, records its SHA-256 checksum in `public.perilune_schema_migrations`, and
fails if an already-applied file changed. Its output contains counts only.

After schema application, run the version-2 fingerprint backfill from the same protected
environment with `npm run backfill:cloud-fingerprints`. Verify that no rows remain with
`fingerprint_version = 1` before releasing the version-2 client.

Migrations are forward-only. If application fails, stop the client rollout, preserve local
saves, restore from the verified backup only for destructive corruption, and otherwise add
a reviewed corrective migration. Never edit a migration whose checksum is recorded.
