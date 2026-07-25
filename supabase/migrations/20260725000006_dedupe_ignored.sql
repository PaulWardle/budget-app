-- Saved transactions the user has confirmed are NOT duplicates of each other
-- (e.g. two identical bank fees on the same day). The duplicates view and the
-- Data Quality count skip them.
alter table public.transactions add column if not exists dedupe_ignored boolean not null default false;
