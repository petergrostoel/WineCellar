-- Nye Supabase-projekter giver ikke automatisk app-rollerne adgang til tabeller.
-- Indloggede brugere skal kunne læse og skrive; Row Level Security sørger for,
-- at de kun ser deres egne rækker. Anonyme brugere får ingen adgang.
grant select, insert, update, delete on table public.wines to authenticated;
grant select, insert, update, delete on table public.tastings to authenticated;
revoke all on table public.wines from anon;
revoke all on table public.tastings from anon;
