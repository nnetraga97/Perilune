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

create index if not exists cloud_saves_user_updated_idx
  on public.cloud_saves (user_id, updated_at desc);

alter table public.cloud_saves enable row level security;

revoke all on table public.cloud_saves from anon;
grant select, insert, update, delete on table public.cloud_saves to authenticated;
grant select, insert, update, delete on table public.cloud_saves to service_role;

drop policy if exists "cloud saves select own" on public.cloud_saves;
create policy "cloud saves select own"
  on public.cloud_saves for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "cloud saves insert own" on public.cloud_saves;
create policy "cloud saves insert own"
  on public.cloud_saves for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "cloud saves update own" on public.cloud_saves;
create policy "cloud saves update own"
  on public.cloud_saves for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "cloud saves delete own" on public.cloud_saves;
create policy "cloud saves delete own"
  on public.cloud_saves for delete
  to authenticated
  using ((select auth.uid()) = user_id);
