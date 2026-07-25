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

The AI secret can also be set in the dashboard: Project Settings → Edge Functions →
Secrets → add `ANTHROPIC_API_KEY`. Get a key at https://console.anthropic.com →
API keys. The key never reaches the browser — it lives only in the function runtime.

Auth settings (Dashboard → Authentication):
- Enable Email provider. Disable public sign-ups if you want strictly single-user
  (create your user manually), or leave enabled and simply don't share the URL.
- Set the Site URL to your Cloudflare Pages URL so password-reset emails link correctly.

## 2. Cloudflare Workers (frontend)

The repo ships `wrangler.jsonc` (Workers static-assets config with SPA fallback
via `not_found_handling` and a build step) and `public/_headers` (security
headers). Do NOT add a `_redirects` SPA rule — Workers assets rejects
`/* /index.html 200` as an infinite loop; the SPA fallback lives in
`wrangler.jsonc` instead.

1. Cloudflare dashboard → **Workers & Pages → Create → Connect to Git**
   and select this repository + branch.
2. Build settings can stay minimal — the deploy command `npx wrangler deploy`
   is enough (wrangler runs `npm run build` itself via the config's `build.command`).
3. Environment variables (project → Settings → Variables, Build environment):
   - `VITE_SUPABASE_URL` = https://<ref>.supabase.co
   - `VITE_SUPABASE_ANON_KEY` = the publishable/anon key (never the service role key)
   These are build-time values baked into the static bundle, so set them for builds.
4. Deploy. Every push to the branch redeploys automatically.

A custom domain can be added later under the Pages project → Custom domains
(free on Cloudflare, including the certificate).

## 3. Post-deploy checklist

- [ ] Sign in works, password reset email arrives and redirects to the site
- [ ] Upload a statement image → extraction → review → confirm (requires
      `ANTHROPIC_API_KEY` secret; CSV import works without it)
- [ ] RLS smoke test: a second user (if created) sees no data
- [ ] Storage bucket `documents` is private; files open only via signed URLs
