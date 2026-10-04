-- Naturvin, alkoholfri og alkoholprocent. Kun tilføjelser: eksisterende vine
-- får is_natural = false, alcohol_free = false og abv = null. Intet slettes.
alter table public.wines
  add column if not exists is_natural   boolean not null default false,
  add column if not exists alcohol_free boolean not null default false,
  add column if not exists abv          numeric(4, 1) check (abv is null or (abv >= 0 and abv <= 25));
