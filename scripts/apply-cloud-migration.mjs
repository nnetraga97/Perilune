import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) throw new Error('POSTGRES_URL_NON_POOLING is required');

const migrationsUrl = new URL('../supabase/migrations/', import.meta.url);
const sql = postgres(url, { max: 1, ssl: 'require' });

try {
  const migrationFiles = (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of migrationFiles) {
    await sql.unsafe(await readFile(new URL(name, migrationsUrl), 'utf8'));
  }
  const tables = await sql`
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('cloud_saves', 'flight_director_audits')
    order by c.relname
  `;
  const primaryKeys = await sql`
    select table_name, count(*)::int as count
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name in ('cloud_saves', 'flight_director_audits')
      and constraint_type = 'PRIMARY KEY'
    group by table_name
    order by table_name
  `;
  const policies = await sql`
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'cloud_saves'
    order by policyname
  `;
  if (tables.length !== 2 || tables.some((table) => !table.rls_enabled)
    || primaryKeys.length !== 2 || primaryKeys.some((table) => table.count !== 1)
    || policies.length !== 4) {
    throw new Error('cloud database verification failed');
  }
  console.log(`cloud database: migrations=${migrationFiles.length} tables=${tables.length} policies=${policies.length}`);
} finally {
  await sql.end();
}
