-- Client-side error log. Errors are captured as they happen so they can be
-- exported and diagnosed later, rather than vanishing with the toast that
-- showed them. Same RLS model as every other table: your rows only.
create table if not exists public.error_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  context text not null,               -- where it happened, e.g. 'import', 'ai_chat'
  message text not null,
  detail jsonb,                        -- stack, request payload, route
  created_at timestamptz not null default now()
);

create index if not exists error_log_user_time on public.error_log (user_id, occurred_at desc);

alter table public.error_log enable row level security;

drop policy if exists "error_log owner" on public.error_log;
create policy "error_log owner" on public.error_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
