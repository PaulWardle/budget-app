# My Money OS — Architecture

A private, single-user, mobile-first personal finance command centre. Financial data
enters via statement screenshots, PDFs, CSVs, manual entry and natural-language AI
chat — not Open Banking (yet). The design keeps a hard boundary between:

1. **Deterministic finance engine** (`src/lib/engine/`) — owns every number: balances,
   budget totals, loan amortisation, forecasts, net worth. Pure TypeScript, integer
   minor-unit (pence) arithmetic, fully unit-tested. Never sourced from AI output.
2. **AI interpretation layer** (Supabase Edge Functions + Anthropic Claude) — reads
   documents/screenshots, interprets natural language, proposes **structured actions**
   that are validated server-side (Zod) and executed through explicit functions.
   The AI never writes SQL and never invents a number the engine can compute.

## Stack

| Concern | Choice |
| --- | --- |
| UI | React 19 + TypeScript + Vite, Tailwind CSS v4, shadcn-style component primitives |
| Charts | Recharts |
| Server state | TanStack Query |
| Validation | Zod (client forms + edge-function payloads) |
| Backend | Supabase: Postgres, Auth, Storage (private buckets), Edge Functions, RLS |
| AI | Anthropic Claude via Edge Functions only (`ANTHROPIC_API_KEY` is a function secret) |
| Deploy | Cloudflare Pages (static SPA) + Supabase (db/functions) |

## Money representation

All monetary values are stored and computed as **integer minor units** (pence) in
`bigint` columns (`amount_minor`, `balance_minor`, …) with a `currency` code (default
`GBP`). The engine (`src/lib/engine/money.ts`) provides parsing, formatting, rounding
and allocation helpers. Floating point is never used for money. Percentages/rates are
stored as `numeric` (e.g. APR `numeric(8,4)`).

Sign convention for transactions: `amount_minor < 0` is money out, `> 0` is money in.

## Data flow

```
uploads (png/jpg/pdf/csv) ─► Storage (private) ─► import batch
                                                 │
                    Edge Fn `ai-extract` (Claude vision/document) or CSV parser
                                                 │
                                          imported_items (proposed)
                                                 │
                        review screen: edit / confirm / reject / dedupe
                                                 │
                                          transactions  ──► engine ──► dashboards,
chat ─► Edge Fn `ai-chat` ─► structured actions ──┘                    budgets, cashflow,
        (validated, audited, undoable)                                 debts, net worth
```

## AI actions

The chat/extraction functions expose an explicit tool list (`create_transaction`,
`update_account_balance`, `create_liability`, `record_debt_payment`,
`create_merchant_rule`, `create_recurring_payment`, `update_budget`,
`create_savings_goal`, `create_financial_fact`, …). Every call is:

1. validated with Zod on the server,
2. executed with the **user's own JWT** (RLS applies — the AI can only touch the
   calling user's rows),
3. recorded in `ai_actions` + `audit_events` with before/after values,
4. surfaced in chat with what/where/assumptions and an **Undo**.

Direct explicit statements ("I still owe £500 on PayPal") are executed and confirmed.
Inferred conclusions (recurring detection from patterns) are proposed and require
user confirmation before saving.

## Multi-user readiness

Single user today, but every private table carries `user_id uuid references auth.users`
with RLS `user_id = auth.uid()` on ALL operations. Adding users later requires no
schema change. Open Banking later maps to the same `accounts`/`transactions`/
`import_batches` model (a new `balance_source` / import source value).

## Auditability & undo

`audit_events` records every mutation (source: manual / import / ai_chat / system,
previous & new values, linked chat message / import batch). Recent safe actions are
undoable: rule creation, batch import, balance update, splits, AI-created records.

## Key engine modules (all unit-tested)

- `money.ts` — minor-unit maths, GBP formatting, proportional allocation
- `amortisation.ts` — repayment schedules, APR→monthly rate, overpayment scenarios
  (reduce-term vs reduce-payment), interest saved / months saved, balloon payments
- `budget.ts` — budget vs actual, forecast month-end (run-rate + known commitments),
  status thresholds, splits/transfers/exclusions respected
- `networth.ts` — assets/liabilities totals, liquid position, adjusted views (excludes
  never overwrite the true figure)
- `cashflow.ts` — daily projection, payday-aware safe-to-spend, negative-day detection
- `recurring.ts` — frequency detection (weekly/fortnightly/monthly/4-weekly/quarterly/…)
- `duplicates.ts` — import dedupe scoring (account+date+amount+description±balance)

## Security

- RLS on every private table; storage buckets private with signed URLs
- Anthropic key only in Edge Function secrets; functions verify the Supabase JWT
- File size + MIME validation on upload; Zod validation on every AI action
- No arbitrary AI SQL; no financial values logged to the browser console
- Document retention setting: keep / delete after extraction / ask each time
- Data export (JSON) and account deletion in Settings

## Deployment

- **Supabase**: `supabase link`, `supabase db push` (migrations in `supabase/migrations/`),
  `supabase functions deploy ai-chat ai-extract`, `supabase secrets set ANTHROPIC_API_KEY=…`
- **Cloudflare Pages**: build `npm run build`, output `dist/`, SPA fallback via
  `public/_redirects`, security headers via `public/_headers`, env vars
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`. See `docs/DEPLOYMENT.md`.
