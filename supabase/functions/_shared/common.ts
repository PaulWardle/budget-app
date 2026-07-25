// Shared helpers for My Money edge functions.
// Every function runs with the CALLING USER'S JWT so RLS applies to all
// database work the AI performs — the AI can never touch another user's rows.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export interface AuthedContext {
  supabase: SupabaseClient
  userId: string
}

/** Build a Supabase client bound to the caller's JWT and resolve the user. */
export async function requireUser(req: Request): Promise<AuthedContext | Response> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing authorization' }, 401)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return json({ error: 'Invalid token' }, 401)
  return { supabase, userId: data.user.id }
}

export async function recordAudit(
  ctx: AuthedContext,
  input: {
    recordType: string
    recordId?: string | null
    action: 'insert' | 'update' | 'delete'
    previous?: unknown
    next?: unknown
    aiActionId?: string | null
    chatMessageId?: string | null
    importBatchId?: string | null
    undoable?: boolean
  },
): Promise<void> {
  await ctx.supabase.from('audit_events').insert({
    user_id: ctx.userId,
    record_type: input.recordType,
    record_id: input.recordId ?? null,
    action: input.action,
    previous_value: input.previous ?? null,
    new_value: input.next ?? null,
    source: 'ai_chat',
    ai_action_id: input.aiActionId ?? null,
    chat_message_id: input.chatMessageId ?? null,
    import_batch_id: input.importBatchId ?? null,
    undo_status: input.undoable ? 'undoable' : 'not_undoable',
  })
}
