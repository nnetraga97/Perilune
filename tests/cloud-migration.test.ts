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
    expect(sql.match(/\(select auth\.uid\(\)\) = user_id/g)).toHaveLength(5);
    expect(sql).toContain('to authenticated');
    expect(sql).toContain('revoke all on table public.cloud_saves from anon');
  });
});
