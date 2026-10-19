-- Prisspænd fundet hos danske vinbutikker (AI + Google-søgning) og datoen for opslaget.
-- Brugerens egen pris ligger fortsat i "price". Kun tilføjelser – intet slettes.
alter table public.wines
  add column if not exists price_dk_min     numeric(10, 2) check (price_dk_min is null or price_dk_min >= 0),
  add column if not exists price_dk_max     numeric(10, 2) check (price_dk_max is null or price_dk_max >= 0),
  add column if not exists price_dk_checked date;
