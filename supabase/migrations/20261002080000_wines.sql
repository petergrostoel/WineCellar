-- Wine Cellar – databaseopsætning til Supabase.
-- Kør hele filen i Supabase: SQL Editor → New query → indsæt → Run.

create table if not exists public.wines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  producer    text,
  type        text,
  vintage     integer,
  country     text,
  region      text,
  grapes      text,
  quantity    integer not null default 0 check (quantity >= 0),
  price       numeric(10, 2),
  drink_from  integer,
  drink_to    integer,
  location    text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists wines_user_id_idx on public.wines (user_id);

-- Hold updated_at opdateret automatisk.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists wines_set_updated_at on public.wines;
create trigger wines_set_updated_at
  before update on public.wines
  for each row execute function public.set_updated_at();

-- Row Level Security: hver bruger kan kun se og ændre sine egne vine.
alter table public.wines enable row level security;

drop policy if exists "Egne vine: læs" on public.wines;
create policy "Egne vine: læs" on public.wines
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Egne vine: opret" on public.wines;
create policy "Egne vine: opret" on public.wines
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Egne vine: ret" on public.wines;
create policy "Egne vine: ret" on public.wines
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Egne vine: slet" on public.wines;
create policy "Egne vine: slet" on public.wines
  for delete to authenticated using ((select auth.uid()) = user_id);
