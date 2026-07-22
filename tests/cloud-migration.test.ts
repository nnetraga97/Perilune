import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../supabase/migrations/20260713221500_cloud_saves.sql', import.meta.url),
  'utf8',
);
const auditSql = readFileSync(
  new URL('../supabase/migrations/20260718193500_flight_director_audits.sql', import.meta.url),
  'utf8',
);
const auditUsageSql = readFileSync(
  new URL('../supabase/migrations/20260719090000_flight_director_usage_details.sql', import.meta.url),
  'utf8',
);
const fingerprintSql = readFileSync(
  new URL('../supabase/migrations/20260721230000_cloud_save_fingerprint_version.sql', import.meta.url),
  'utf8',
);

describe('cloud save migration', () => {
  it('creates an owner-scoped revisioned save table with RLS', () => {
    expect(sql).toContain('create table if not exists public.cloud_saves');
    expect(sql).toContain('primary key (user_id, slot)');
    expect(sql).toContain('enable row level security');
    expect(sql.match(/\(select auth\.uid\(\)\) = user_id/g)).toHaveLength(5);
    expect(sql).toContain('to authenticated');
    expect(sql).toContain('revoke all on table public.cloud_saves from anon');
  });

});

describe('canonical fingerprint migration', () => {
  it('adds an explicit dual-version marker for the staged backfill', () => {
    expect(fingerprintSql).toContain('fingerprint_version integer not null default 1');
    expect(fingerprintSql).toContain('fingerprint_version in (1, 2)');
  });

  it('keeps Vercel builds free of database mutation', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(vercel.buildCommand).toBe('npm run build');
  });
});

describe('flight director audit migration', () => {
  it('creates a server-only structured audit table with RLS', () => {
    expect(auditSql).toContain('create table if not exists public.flight_director_audits');
    expect(auditSql).toContain('snapshot jsonb not null');
    expect(auditSql).toContain('advisory jsonb not null');
    expect(auditSql).toContain('enable row level security');
    expect(auditSql).toContain('revoke all on table public.flight_director_audits from anon');
    expect(auditSql).toContain('revoke all on table public.flight_director_audits from authenticated');
    expect(auditSql).toContain('to service_role');
    expect(auditSql).not.toContain('create policy');
  });

  it('adds prompt-cache and reasoning usage details for cost review', () => {
    expect(auditUsageSql).toContain('cached_input_tokens integer');
    expect(auditUsageSql).toContain('cache_write_tokens integer');
    expect(auditUsageSql).toContain('reasoning_tokens integer');
  });
});
