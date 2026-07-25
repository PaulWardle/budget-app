-- My Money — core schema
-- Money is stored as integer minor units (pence) in *_minor bigint columns.
-- Rates/percentages use numeric. Every private table carries user_id for RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  currency text not null default 'GBP',
  payday_day smallint check (payday_day between 1 and 31),
  document_retention text not null default 'ask'
    check (document_retention in ('keep', 'delete', 'ask')),
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------- category reference data
-- Templates are copied into per-user categories when a profile is created.
create table public.category_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_name text,
  kind text not null default 'expense' check (kind in ('expense', 'income', 'transfer')),
  icon text,
  sort integer not null default 0
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.categories (id) on delete cascade,
  name text not null,
  kind text not null default 'expense' check (kind in ('expense', 'income', 'transfer')),
  icon text,
  is_archived boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, parent_id, name)
);

-- ------------------------------------------------------------- merchants
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  default_category_id uuid references public.categories (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.merchant_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  unique (user_id, alias)
);

create table public.categorisation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  matcher text not null,
  match_type text not null default 'contains'
    check (match_type in ('contains', 'exact', 'starts_with')),
  merchant_id uuid references public.merchants (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  priority integer not null default 100,
  is_active boolean not null default true,
  source text not null default 'manual'
    check (source in ('manual', 'ai_chat', 'import_confirmation', 'system')),
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------- accounts
-- Accounts cover cash accounts AND standalone assets (property, vehicle, …).
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  provider text,
  account_type text not null check (account_type in (
    'current', 'savings', 'credit_card', 'wallet', 'cash',
    'loan', 'vehicle_finance', 'mortgage',
    'investment', 'pension', 'property', 'vehicle',
    'other_asset', 'other_liability')),
  balance_minor bigint not null default 0,
  currency text not null default 'GBP',
  credit_limit_minor bigint,
  include_in_cashflow boolean not null default true,
  include_in_net_worth boolean not null default true,
  is_liquid boolean not null default true,
  archived_at timestamptz,
  balance_updated_at timestamptz not null default now(),
  balance_source text not null default 'manual'
    check (balance_source in ('manual', 'import', 'ai_chat', 'calculated')),
  notes text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.account_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  balance_minor bigint not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'manual'
    check (source in ('manual', 'import', 'ai_chat', 'calculated', 'system')),
  note text
);

-- ---------------------------------------------------------- transactions
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  date date not null,
  posted_time time,
  description text not null,            -- raw bank description
  merchant_id uuid references public.merchants (id) on delete set null,
  merchant_name text,                   -- display name at time of import
  category_id uuid references public.categories (id) on delete set null,
  amount_minor bigint not null,         -- negative = money out
  currency text not null default 'GBP',
  running_balance_minor bigint,
  reference text,
  payment_method text,
  is_transfer boolean not null default false,
  transfer_pair_id uuid references public.transactions (id) on delete set null,
  is_reimbursable boolean not null default false,
  exclude_from_budget boolean not null default false,
  exclude_from_analytics boolean not null default false,
  notes text,
  tags text[] not null default '{}',
  import_batch_id uuid,                 -- fk added after import_batches
  recurring_payment_id uuid,
  liability_id uuid,
  confidence numeric(4, 3),
  needs_review boolean not null default false,
  dedupe_hash text,
  source text not null default 'manual'
    check (source in ('manual', 'import', 'ai_chat', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.transaction_splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  category_id uuid references public.categories (id) on delete set null,
  amount_minor bigint not null,
  note text,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------- budgets
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  month date not null,                  -- first day of month
  expected_income_minor bigint not null default 0,
  rollover_enabled boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month),
  check (extract(day from month) = 1)
);

create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  budget_id uuid not null references public.budgets (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  kind text not null default 'variable' check (kind in (
    'income', 'fixed', 'variable', 'discretionary', 'debt', 'savings', 'one_off')),
  label text,                           -- for one-offs without a category
  planned_minor bigint not null default 0,
  rollover_from_minor bigint not null default 0,
  note text,
  unique (budget_id, category_id, kind, label)
);

-- ------------------------------------------------ recurring payments/bills
-- Bills, subscriptions, expected income, debt payments and savings transfers.
create table public.recurring_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null default 'bill' check (kind in (
    'bill', 'subscription', 'income', 'debt_payment', 'savings', 'transfer')),
  merchant_id uuid references public.merchants (id) on delete set null,
  category_id uuid references public.categories (id) on delete set null,
  account_id uuid references public.accounts (id) on delete set null,
  liability_id uuid,
  amount_minor bigint not null,         -- negative = money out
  frequency text not null check (frequency in (
    'weekly', 'fortnightly', 'monthly', 'four_weekly', 'quarterly',
    'six_monthly', 'annual', 'custom')),
  interval_days integer,                -- for custom frequency
  next_due_date date not null,
  day_of_month smallint,
  start_date date,
  renewal_date date,
  contract_end_date date,
  status text not null default 'active'
    check (status in ('active', 'paused', 'cancelled')),
  is_essential boolean not null default true,
  price_history jsonb not null default '[]',
  needs_confirmation boolean not null default false,
  confidence numeric(4, 3),
  source text not null default 'manual'
    check (source in ('manual', 'detected', 'ai_chat', 'import')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- debts
create table public.liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete set null,
  name text not null,
  provider text,
  liability_type text not null check (liability_type in (
    'personal_loan', 'credit_card', 'paypal_credit', 'vehicle_finance',
    'hire_purchase', 'pcp', 'mortgage', 'informal', 'other')),
  original_balance_minor bigint,
  current_balance_minor bigint not null default 0,
  balance_effective_date date not null default current_date,
  balance_source text not null default 'user_stated' check (balance_source in (
    'user_stated', 'calculated', 'lender_confirmed', 'imported', 'estimated')),
  apr numeric(8, 4),
  rate_type text check (rate_type in ('fixed', 'variable', 'unknown')),
  monthly_payment_minor bigint,
  payment_day smallint check (payment_day between 1 and 31),
  start_date date,
  term_months integer,
  remaining_payments integer,
  final_payment_minor bigint,
  balloon_minor bigint,
  fees_minor bigint not null default 0,
  settlement_quote_minor bigint,
  settlement_quote_expiry date,
  overpayment_rule text not null default 'unknown'
    check (overpayment_rule in ('reduce_term', 'reduce_payment', 'unknown')),
  early_repayment_terms text,
  agreement_ref text,
  status text not null default 'active'
    check (status in ('active', 'settled', 'archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.loan_contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  liability_id uuid references public.liabilities (id) on delete cascade,
  document_id uuid,                     -- fk added after documents
  extracted jsonb not null default '{}',
  confidence numeric(4, 3),
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'rejected')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.loan_payment_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  liability_id uuid not null references public.liabilities (id) on delete cascade,
  schedule_type text not null default 'original'
    check (schedule_type in ('original', 'revised')),
  payment_number integer not null,
  due_date date not null,
  payment_minor bigint not null,
  principal_minor bigint not null,
  interest_minor bigint not null,
  balance_after_minor bigint not null,
  generated_at timestamptz not null default now(),
  unique (liability_id, schedule_type, payment_number)
);

create table public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  liability_id uuid not null references public.liabilities (id) on delete cascade,
  transaction_id uuid references public.transactions (id) on delete set null,
  date date not null,
  amount_minor bigint not null,         -- positive = payment made
  kind text not null default 'scheduled' check (kind in (
    'scheduled', 'overpayment', 'missed', 'fee', 'interest', 'adjustment')),
  note text,
  source text not null default 'manual'
    check (source in ('manual', 'import', 'ai_chat', 'matched')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- net worth
create table public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  assets_minor bigint not null,
  liabilities_minor bigint not null,    -- positive number
  net_worth_minor bigint not null,
  liquid_assets_minor bigint not null default 0,
  liquid_liabilities_minor bigint not null default 0,
  breakdown jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- --------------------------------------------------------------- savings
create table public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null default 'goal' check (kind in (
    'general', 'emergency_fund', 'goal', 'sinking_fund', 'purchase', 'debt_pot')),
  target_minor bigint not null,
  current_minor bigint not null default 0,
  target_date date,
  monthly_planned_minor bigint not null default 0,
  linked_account_id uuid references public.accounts (id) on delete set null,
  priority smallint not null default 3 check (priority between 1 and 5),
  status text not null default 'active'
    check (status in ('active', 'achieved', 'paused', 'archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------- financial facts
create table public.financial_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  fact_type text not null,              -- e.g. 'payday', 'merchant_meaning', 'debt_balance'
  fact_key text not null,               -- e.g. 'salary_day', 'rent_amount'
  value jsonb not null,
  effective_date date not null default current_date,
  source text not null default 'user_chat'
    check (source in ('user_chat', 'inferred', 'import', 'manual')),
  confidence text not null default 'confirmed'
    check (confidence in ('confirmed', 'likely', 'uncertain')),
  last_confirmed_at timestamptz not null default now(),
  affects_calculations boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  kind text not null default 'statement'
    check (kind in ('statement', 'contract', 'receipt', 'other')),
  status text not null default 'stored' check (status in ('stored', 'deleted')),
  uploaded_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.loan_contracts
  add constraint loan_contracts_document_fk
  foreign key (document_id) references public.documents (id) on delete set null;

-- --------------------------------------------------------------- imports
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete set null,
  document_id uuid references public.documents (id) on delete set null,
  source_type text not null check (source_type in ('screenshot', 'pdf', 'csv', 'manual')),
  file_name text,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'review', 'completed', 'failed', 'undone')),
  error text,
  ai_model text,
  stats jsonb not null default '{}',    -- {extracted, confirmed, rejected, duplicates}
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.transactions
  add constraint transactions_import_batch_fk
  foreign key (import_batch_id) references public.import_batches (id) on delete set null;

create table public.imported_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  raw_text text,
  extracted jsonb not null default '{}',
  proposed_date date,
  proposed_description text,
  proposed_amount_minor bigint,
  proposed_merchant text,
  proposed_category_id uuid references public.categories (id) on delete set null,
  running_balance_minor bigint,
  confidence numeric(4, 3),
  duplicate_of uuid references public.transactions (id) on delete set null,
  duplicate_score numeric(4, 3),
  status text not null default 'proposed' check (status in (
    'proposed', 'confirmed', 'rejected', 'duplicate')),
  transaction_id uuid references public.transactions (id) on delete set null,
  user_corrected jsonb,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------- insights
create table public.insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  insight_type text not null,
  headline text not null,
  body text not null,
  figures jsonb not null default '{}',
  comparison_period text,
  confidence text not null default 'medium'
    check (confidence in ('high', 'medium', 'low')),
  suggested_action text,
  impact_minor bigint,
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'positive')),
  status text not null default 'active'
    check (status in ('active', 'dismissed', 'muted', 'actioned')),
  period_start date,
  period_end date,
  dedupe_key text,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create table public.insight_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  insight_id uuid not null references public.insights (id) on delete cascade,
  action text not null check (action in (
    'dismissed', 'muted_merchant', 'muted_type', 'useful', 'converted')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- chat
create table public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  actions jsonb not null default '[]',  -- summaries of executed/proposed actions
  created_at timestamptz not null default now()
);

create table public.ai_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_message_id uuid references public.chat_messages (id) on delete set null,
  action_type text not null,
  payload jsonb not null,
  result jsonb,
  status text not null default 'executed' check (status in (
    'proposed', 'executed', 'failed', 'undone')),
  undo_data jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

-- ------------------------------------------------------------------ audit
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  record_type text not null,
  record_id uuid,
  action text not null check (action in ('insert', 'update', 'delete', 'undo')),
  previous_value jsonb,
  new_value jsonb,
  source text not null default 'manual' check (source in (
    'manual', 'import', 'ai_chat', 'system', 'undo')),
  import_batch_id uuid references public.import_batches (id) on delete set null,
  chat_message_id uuid references public.chat_messages (id) on delete set null,
  ai_action_id uuid references public.ai_actions (id) on delete set null,
  undo_status text not null default 'not_undoable'
    check (undo_status in ('undoable', 'undone', 'not_undoable')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- indexes
create index transactions_user_date_idx on public.transactions (user_id, date desc);
create index transactions_account_idx on public.transactions (account_id, date desc);
create index transactions_merchant_idx on public.transactions (merchant_id);
create index transactions_category_idx on public.transactions (category_id);
create index transactions_dedupe_idx on public.transactions (user_id, dedupe_hash);
create index transactions_batch_idx on public.transactions (import_batch_id);
create index splits_transaction_idx on public.transaction_splits (transaction_id);
create index snapshots_account_idx on public.account_balance_snapshots (account_id, recorded_at desc);
create index budget_lines_budget_idx on public.budget_lines (budget_id);
create index recurring_user_due_idx on public.recurring_payments (user_id, next_due_date);
create index schedules_liability_idx on public.loan_payment_schedules (liability_id, schedule_type, payment_number);
create index debt_payments_liability_idx on public.debt_payments (liability_id, date desc);
create index imported_items_batch_idx on public.imported_items (batch_id);
create index insights_user_status_idx on public.insights (user_id, status, created_at desc);
create index chat_messages_conv_idx on public.chat_messages (conversation_id, created_at);
create index audit_user_idx on public.audit_events (user_id, created_at desc);
create index networth_user_date_idx on public.net_worth_snapshots (user_id, date desc);
