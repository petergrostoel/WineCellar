-- Trin 2: AI-felter på vine, smagninger (drukne flasker) og billedlager til etiketter.

-- ---------- Nye felter på wines ----------
alter table public.wines
  add column if not exists description   text,
  add column if not exists food_pairings text[] not null default '{}',
  add column if not exists image_path    text,
  add column if not exists ai_sources    jsonb;

-- ---------- Smagninger: én række pr. drukket flaske ----------
create table if not exists public.tastings (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  wine_id   uuid not null references public.wines (id) on delete cascade,
  drunk_at  timestamptz not null default now(),
  rating    smallint check (rating between 1 and 5),
  notes     text
);

create index if not exists tastings_user_id_idx on public.tastings (user_id);
create index if not exists tastings_wine_id_idx on public.tastings (wine_id);

alter table public.tastings enable row level security;

drop policy if exists "Egne smagninger: læs" on public.tastings;
create policy "Egne smagninger: læs" on public.tastings
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Egne smagninger: opret" on public.tastings;
create policy "Egne smagninger: opret" on public.tastings
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Egne smagninger: ret" on public.tastings;
create policy "Egne smagninger: ret" on public.tastings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Egne smagninger: slet" on public.tastings;
create policy "Egne smagninger: slet" on public.tastings
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- Billedlager: privat bucket, én mappe pr. bruger ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('labels', 'labels', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Egne etiketter: læs" on storage.objects;
create policy "Egne etiketter: læs" on storage.objects
  for select to authenticated
  using (bucket_id = 'labels' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Egne etiketter: upload" on storage.objects;
create policy "Egne etiketter: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'labels' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Egne etiketter: ret" on storage.objects;
create policy "Egne etiketter: ret" on storage.objects
  for update to authenticated
  using (bucket_id = 'labels' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Egne etiketter: slet" on storage.objects;
create policy "Egne etiketter: slet" on storage.objects
  for delete to authenticated
  using (bucket_id = 'labels' and (storage.foldername(name))[1] = (select auth.uid())::text);
