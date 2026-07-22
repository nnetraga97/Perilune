alter table public.cloud_saves
  add column if not exists fingerprint_version integer not null default 1
  check (fingerprint_version in (1, 2));

comment on column public.cloud_saves.fingerprint_version is
  '1 = historical JSON.stringify hash; 2 = recursively key-sorted canonical JSON hash';
