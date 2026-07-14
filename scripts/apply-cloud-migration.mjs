import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) throw new Error('POSTGRES_URL_NON_POOLING is required');

const migrationUrl = new URL('../supabase/migrations/20260713221500_cloud_saves.sql', import.meta.url);
const migration = await readFile(migrationUrl, 'utf8');
const sql = postgres(url, { max: 1, ssl: 'require' });

try {
  await sql.unsafe(migration);
  const [table] = await sql`
    select c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cloud_saves'
  `;
  const [{ count: primaryKeys }] = await sql`
    select count(*)::int as count
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'cloud_saves'
      and constraint_type = 'PRIMARY KEY'
  `;
  const policies = await sql`
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'cloud_saves'
    order by policyname
  `;
  if (!table?.rls_enabled || primaryKeys !== 1 || policies.length !== 4) {
    throw new Error('cloud_saves verification failed');
  }
  console.log(`cloud_saves: rls=${table.rls_enabled} primary_keys=${primaryKeys} policies=${policies.length}`);
} finally {
  await sql.end();
}
