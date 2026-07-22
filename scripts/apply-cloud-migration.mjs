import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

const databaseUrl = process.env.POSTGRES_URL_NON_POOLING;
if (!databaseUrl) throw new Error('POSTGRES_URL_NON_POOLING is required');
const migrationsUrl = new URL('../supabase/migrations/', import.meta.url);
const sql = postgres(databaseUrl, { max: 1, ssl: 'require' });

try {
  await sql.unsafe(`
    create table if not exists public.perilune_schema_migrations (
      version text primary key,
      checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz not null default now()
    );
    alter table public.perilune_schema_migrations enable row level security;
    revoke all on table public.perilune_schema_migrations from anon, authenticated;
    grant select, insert on table public.perilune_schema_migrations to service_role;
  `);
  const migrationFiles = (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  let applied = 0;
  for (const name of migrationFiles) {
    const source = await readFile(new URL(name, migrationsUrl), 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const prior = await sql`
      select checksum from public.perilune_schema_migrations where version = ${name}
    `;
    if (prior.length > 0) {
      if (prior[0].checksum !== checksum) throw new Error(`migration checksum mismatch: ${name}`);
      continue;
    }
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`
        insert into public.perilune_schema_migrations (version, checksum)
        values (${name}, ${checksum})
      `;
    });
    applied++;
  }
  const verification = await sql`
    select
      c.relrowsecurity as rls_enabled,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cloud_saves'
          and column_name = 'fingerprint_version'
      ) as fingerprint_version_present,
      (select count(*)::int from pg_policies
        where schemaname = 'public' and tablename = 'cloud_saves') as policy_count,
      (select count(*)::int from public.perilune_schema_migrations) as migration_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cloud_saves'
  `;
  const verified = verification[0];
  if (!verified?.rls_enabled || !verified.fingerprint_version_present
    || verified.policy_count !== 4 || verified.migration_count !== migrationFiles.length) {
    throw new Error('cloud database verification failed');
  }
  console.log(`cloud database: discovered=${migrationFiles.length} applied=${applied} verified=${verified.migration_count}`);
} finally {
  await sql.end();
}
