-- "Kommer fra": brugerens egen tekst om, hvor vinen kommer fra (fx "Jubilæumsgave").
-- Kun en tilføjelse: eksisterende vine får origin = null. Intet slettes.
alter table public.wines
  add column if not exists origin text;
