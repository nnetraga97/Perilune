alter table public.flight_director_audits
  add column if not exists cached_input_tokens integer
    check (cached_input_tokens is null or cached_input_tokens >= 0),
  add column if not exists cache_write_tokens integer
    check (cache_write_tokens is null or cache_write_tokens >= 0),
  add column if not exists reasoning_tokens integer
    check (reasoning_tokens is null or reasoning_tokens >= 0);

comment on column public.flight_director_audits.cached_input_tokens is
  'Input tokens read from the OpenAI prompt cache.';
comment on column public.flight_director_audits.cache_write_tokens is
  'Input tokens written to the OpenAI prompt cache.';
comment on column public.flight_director_audits.reasoning_tokens is
  'Reasoning tokens included in output token usage.';
