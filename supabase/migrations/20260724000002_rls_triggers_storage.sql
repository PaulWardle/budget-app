-- My Money — RLS, triggers, bootstrap and storage
-- Every private table is locked to user_id = auth.uid() for ALL operations.

-- ------------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
create policy "own profile select" on public.profiles
  for select using (id = auth.uid());
create policy "own profile insert" on public.profiles
  for insert with check (id = auth.uid());
create policy "own profile update" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

alter table public.category_templates enable row level security;
create policy "templates readable" on public.category_templates
  for select to authenticated using (true);

-- Uniform owner policy for every user_id table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'merchants', 'merchant_aliases', 'categorisation_rules',
    'accounts', 'account_balance_snapshots', 'transactions', 'transaction_splits',
    'budgets', 'budget_lines', 'recurring_payments', 'liabilities',
    'loan_contracts', 'loan_payment_schedules', 'debt_payments',
    'net_worth_snapshots', 'savings_goals', 'financial_facts', 'documents',
    'import_batches', 'imported_items', 'insights', 'insight_feedback',
    'chat_conversations', 'chat_messages', 'ai_actions', 'audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "owner all" on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ------------------------------------------------------------- updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'accounts', 'transactions', 'budgets', 'recurring_payments',
    'liabilities', 'savings_goals', 'chat_conversations'
  ]
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ------------------------------------------- profile + defaults bootstrap
-- Creates profile row and copies category templates on first sign-in.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  tmpl record;
  parent_ids jsonb := '{}'::jsonb;
  new_id uuid;
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;

  -- top-level categories first
  for tmpl in
    select * from public.category_templates where parent_name is null order by sort
  loop
    insert into public.categories (user_id, name, kind, icon, sort)
    values (new.id, tmpl.name, tmpl.kind, tmpl.icon, tmpl.sort)
    on conflict (user_id, parent_id, name) do nothing
    returning id into new_id;
    if new_id is not null then
      parent_ids := parent_ids || jsonb_build_object(tmpl.name, new_id::text);
    end if;
  end loop;

  -- subcategories
  for tmpl in
    select * from public.category_templates where parent_name is not null order by sort
  loop
    if parent_ids ? tmpl.parent_name then
      insert into public.categories (user_id, parent_id, name, kind, icon, sort)
      values (new.id, (parent_ids ->> tmpl.parent_name)::uuid, tmpl.name,
              tmpl.kind, tmpl.icon, tmpl.sort)
      on conflict (user_id, parent_id, name) do nothing;
    end if;
  end loop;

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------- balance history on account changes
create or replace function public.snapshot_account_balance()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.balance_minor is distinct from old.balance_minor then
    insert into public.account_balance_snapshots
      (user_id, account_id, balance_minor, source)
    values (new.user_id, new.id, new.balance_minor, new.balance_source);
    new.balance_updated_at = now();
  end if;
  return new;
end $$;

create trigger account_balance_snapshot
  before insert or update on public.accounts
  for each row execute function public.snapshot_account_balance();

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false,
  15728640, -- 15 MB
  array['image/png', 'image/jpeg', 'application/pdf', 'text/csv',
        'application/vnd.ms-excel']
)
on conflict (id) do nothing;

create policy "own documents read" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own documents insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own documents delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
