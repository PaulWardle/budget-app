-- Projects: named pots of one-off spending (a bike build, a holiday, house
-- work) tracked against an optional budget. Assigning a transaction to a
-- project marks it one-off in the app so project spend never inflates the
-- "typical month" baseline, while still counting as real money out.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'complete', 'paused', 'abandoned')),
  budget_minor bigint,
  started_on date,
  target_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;
create policy "owner all" on public.projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

alter table public.transactions
  add column if not exists project_id uuid references public.projects (id) on delete set null;

create index if not exists transactions_project_idx
  on public.transactions (user_id, project_id) where project_id is not null;
