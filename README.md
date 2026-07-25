# My Money OS

A private, mobile-first personal finance command centre. Bank statement screenshots,
PDFs, CSVs, manual entry and an AI assistant go in; reliable budgets, cashflow
forecasts, debt calculations, net worth and insights come out.

**Core principle:** a deterministic finance engine owns every number (tested, minor-unit
integer arithmetic); the AI layer only interprets documents and language, and acts
through validated, audited, undoable server-side actions. See `docs/ARCHITECTURE.md`.

## Local development

```bash
npm install
cp .env.example .env        # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

### Supabase setup

1. Create a Supabase project (or `supabase start` for a local stack).
2. Apply migrations: `supabase link --project-ref <ref> && supabase db push`
   (or paste `supabase/migrations/*.sql` into the SQL editor in order).
3. Seed reference data: run `supabase/seed.sql`.
4. Create a user: Authentication → Add user (email + password), or use the app's
   sign-up form. Signing in bootstraps the profile + default categories automatically.
5. Deploy edge functions and set the AI secret:
   ```bash
   supabase functions deploy ai-chat ai-extract
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
   The app works fully without the AI functions — imports fall back to CSV parsing
   and chat explains that AI is not configured.

## Tests

```bash
npm test        # finance engine: money, amortisation, budgets, net worth,
                # duplicates, recurring detection, cashflow forecasting
```

## Deployment

See `docs/DEPLOYMENT.md` for Cloudflare Pages + Supabase production steps.

## Security notes

- RLS on every table; private storage buckets with signed URLs.
- The Anthropic API key exists only as a Supabase Edge Function secret.
- The AI cannot run SQL; it calls a fixed set of Zod-validated actions under the
  calling user's JWT, all recorded in `audit_events` with undo support.
