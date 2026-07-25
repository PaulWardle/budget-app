-- Recurring-payment candidates the user has explicitly rejected.
-- Detection re-runs over the whole ledger every time it is asked, so without a
-- record of "this is not a bill" a dismissed suggestion reappears immediately.
-- Keyed by the normalised description the detector groups on, not by row id.

create table if not exists dismissed_recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  match_key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (user_id, match_key)
);

create index if not exists dismissed_recurring_user_idx on dismissed_recurring (user_id);

alter table dismissed_recurring enable row level security;

create policy dismissed_recurring_owner on dismissed_recurring
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
