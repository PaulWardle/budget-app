import { createClient } from '@supabase/supabase-js'

// Defaults point at the production My-Money-OS project. These are PUBLIC
// values by design (they ship in the browser bundle regardless) — all data
// access is protected by auth + row-level security, not by these strings.
// Env vars still override for local/staging setups.
const DEFAULT_URL = 'https://txepbqrnnqzwtynnvgxd.supabase.co'
const DEFAULT_ANON_KEY = 'sb_publishable_xpJ6CoY6_rtxJCQ88_y5AQ_PgtvPFMs'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_URL
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || DEFAULT_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)
