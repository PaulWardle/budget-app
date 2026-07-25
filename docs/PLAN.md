# Build Plan & Checklist

## Folder structure

```
supabase/
  migrations/            SQL migrations (schema + RLS + triggers)
  seed.sql               default categories & reference data
  functions/
    ai-chat/             chat assistant + structured actions (Anthropic, server-side)
    ai-extract/          screenshot/PDF/CSV extraction to proposed transactions
    _shared/             auth, zod schemas, action executors, anthropic client
src/
  lib/
    engine/              deterministic finance engine (pure TS + tests)
    supabase.ts          client singleton
    format.ts            currency/date display helpers
    queries/             TanStack Query hooks per domain
  components/
    ui/                  shadcn-style primitives (button, card, dialog, …)
    layout/              app shell, sidebar, mobile bottom nav
    charts/              recharts wrappers with conclusions
    shared/              money input, category picker, confidence badge, …
  pages/                 one folder per nav section
  types/                 database types + domain types
docs/                    architecture, plan, deployment
public/                  _redirects + _headers for Cloudflare Pages
```

## Database schema (tables)

profiles, accounts, account_balance_snapshots, transactions, transaction_splits,
merchants, merchant_aliases, categories, categorisation_rules, budgets, budget_lines,
recurring_payments, liabilities, loan_contracts, loan_payment_schedules, debt_payments,
net_worth_snapshots, savings_goals, financial_facts, documents, import_batches,
imported_items, insights, insight_feedback, chat_conversations, chat_messages,
ai_actions, audit_events.
(Subscriptions are recurring_payments with kind='subscription'; assets are accounts
with asset account types — one balance/snapshot model everywhere.)

All money = bigint minor units. All private tables: `user_id` + RLS (= auth.uid()).

## Phases

- [x] **1 Foundation** — scaffold, auth, schema+RLS, navigation, accounts, manual
      transactions, seed, basic dashboard
- [x] **2 Transactions & imports** — storage, upload (png/jpg/pdf/csv), extraction,
      review queue, duplicate detection, merchant/category learning
- [x] **3 Budget & cashflow** — monthly budgets, category budgets, budget vs actual,
      recurring commitments, cashflow forecast, upcoming bills, core charts
- [x] **4 Debts** — liabilities, contract upload/extraction, schedules, payment
      matching, overpayment calculator, scenarios
- [x] **5 Wealth & savings** — assets, net worth, adjusted views, snapshots, goals
- [x] **6 AI chat** — conversation UI, structured actions, financial facts, undo
- [x] **7 Insights** — deterministic analytics + AI explanations, feedback, trends,
      data quality dashboard
- [x] **8 Hardening** — engine tests, security review, docs, deployment config

## Deliberate v1 decisions (simplest reliable option, documented)

- Single currency display (GBP) with per-record currency codes stored for later FX.
- Subscriptions modelled as flagged recurring payments, not a separate table.
- Assets (property/vehicle/investment/pension) modelled as `accounts` rows with asset
  types — one snapshot/balance history mechanism for everything.
- CSV parsing happens client-side (deterministic); AI is only used for images/PDFs
  and for ambiguous CSV column mapping.
- Net-worth snapshots are written on balance changes (max one per day per user).
- Undo = compensating action recorded in `audit_events` (not event sourcing).
