-- AI-forbrug: én række pr. kald til Gemini, så appen kan varsle og stoppe,
-- før den gratis søgekvote eller årsloftet (100 kr) er brugt. Kun tilføjelser.
-- Skrives og læses kun af AI-funktionen (service role) – brugerne har ingen adgang.
create table if not exists public.ai_usage (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  user_id         uuid references auth.users (id) on delete set null,
  action          text not null,
  model           text,
  searched        boolean not null default false,
  search_queries  integer not null default 0,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  cost_usd        numeric(10, 6) not null default 0
);

create index if not exists ai_usage_created_at_idx on public.ai_usage (created_at);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated;
grant select, insert on table public.ai_usage to service_role;

-- Samlet forbrug for alle brugere (de deler Gemini-nøglen og dens kvote).
create or replace function public.ai_usage_summary()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'year_cost_usd',  coalesce((select sum(cost_usd) from public.ai_usage
                                where created_at >= date_trunc('year', now())), 0),
    'month_searches', coalesce((select sum(search_queries) from public.ai_usage
                                where created_at >= date_trunc('month', now())), 0),
    'year_calls',     (select count(*) from public.ai_usage
                       where created_at >= date_trunc('year', now()))
  );
$$;

revoke all on function public.ai_usage_summary() from public, anon, authenticated;
grant execute on function public.ai_usage_summary() to service_role;
