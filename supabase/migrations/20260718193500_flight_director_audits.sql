create table if not exists public.flight_director_audits (
  request_id text primary key check (char_length(request_id) between 1 and 160),
  created_at timestamptz not null default now(),
  model text not null check (char_length(model) between 1 and 80),
  cached boolean not null default false,
  duration_ms integer not null check (duration_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  advisory jsonb not null check (jsonb_typeof(advisory) = 'object')
);

create index if not exists flight_director_audits_created_idx
  on public.flight_director_audits (created_at desc);

alter table public.flight_director_audits enable row level security;

revoke all on table public.flight_director_audits from anon;
revoke all on table public.flight_director_audits from authenticated;
grant select, insert, delete on table public.flight_director_audits to service_role;

comment on table public.flight_director_audits is
  'Server-only telemetry and structured advisory records for reviewing Pip flight-director behavior.';
