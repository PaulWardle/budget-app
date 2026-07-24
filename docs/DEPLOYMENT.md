# Deployment

## 1. Supabase (database, auth, storage, functions)

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>

# schema + RLS + storage buckets
supabase db push

# reference data (categories etc.)
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # or paste into the SQL editor

# AI functions (server-side Anthropic calls)
supabase functions deploy ai-chat ai-extract
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

Auth settings (Dashboard → Authentication):
- Enable Email provider. Disable public sign-ups if you want strictly single-user
  (create your user manually), or leave enabled and simply don't share the URL.
- Set the Site URL to your Netlify URL so password-reset emails link correctly.

## 2. Netlify (frontend)

`netlify.toml` is committed (build `npm run build`, publish `dist`, SPA redirect).

1. New site → import this repository.
2. Environment variables:
   - `VITE_SUPABASE_URL` = https://<ref>.supabase.co
   - `VITE_SUPABASE_ANON_KEY` = the publishable/anon key (never the service role key)
3. Deploy. 

## 3. Post-deploy checklist

- [ ] Sign in works, password reset email arrives and redirects to the site
- [ ] Upload a statement image → extraction → review → confirm (requires
      `ANTHROPIC_API_KEY` secret; CSV import works without it)
- [ ] RLS smoke test: a second user (if created) sees no data
- [ ] Storage bucket `documents` is private; files open only via signed URLs
