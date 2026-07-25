// Document extraction: reads statement screenshots/PDFs (and loan contracts)
// with Claude and writes PROPOSED records for user review. Nothing is saved to
// the ledger until the user confirms on the review screen. Deterministic
// duplicate scoring runs against the existing ledger before proposals land.
//
// The request returns immediately with { status: 'processing' } and the real
// work runs as a background task (EdgeRuntime.waitUntil) — long statements can
// take minutes and must not be bounded by the HTTP request. The UI already
// polls the batch row for the processing → review/failed transition.
//
// Long statements exceed a single response's output budget, so extraction
// streams with a high token cap and, when a pass is cut off mid-list, the
// salvaged partial output is kept and another pass continues from the last
// extracted transaction until the whole statement is covered.

import Anthropic from 'npm:@anthropic-ai/sdk@0.65.0'
import { corsHeaders, json, requireUser, type AuthedContext } from '../_shared/common.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const MODEL = 'claude-opus-5'
const MAX_OUTPUT_TOKENS = 32000
const MAX_PASSES = 6

const EXTRACT_TXNS_TOOL: Anthropic.Beta.BetaTool = {
  name: 'record_extracted_transactions',
  description: 'Record every transaction visible in the statement.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['transactions'],
    properties: {
      bank_name: {
        type: ['string', 'null'],
        description: 'The bank or provider this statement belongs to, if visible (e.g. "Halifax", "Monzo", "PayPal")',
      },
      account_hint: {
        type: ['string', 'null'],
        description: 'Any account identifier shown: last 4 digits, sort code, or account label',
      },
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['date', 'description', 'amount_minor', 'confidence'],
          properties: {
            date: { type: 'string', description: 'ISO date YYYY-MM-DD. Infer the year from context if missing.' },
            description: { type: 'string', description: 'The raw description exactly as shown' },
            merchant: { type: ['string', 'null'], description: 'Clean merchant name, e.g. "Starbucks" from "STARBUCKS 2841 LEEDS"' },
            amount_minor: { type: 'integer', description: 'Pence. NEGATIVE for money out / debits, positive for credits.' },
            running_balance_minor: { type: ['integer', 'null'], description: 'Balance after the transaction if shown, in pence' },
            reference: { type: ['string', 'null'] },
            confidence: { type: 'number', description: '0-1: how certain you are that date, description and amount are all read correctly' },
          },
        },
      },
    },
  },
}

const EXTRACT_CONTRACT_TOOL: Anthropic.Beta.BetaTool = {
  name: 'record_extracted_loan_terms',
  description: 'Record the repayment terms found in the credit agreement or loan document.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['confidence'],
    properties: {
      lender: { type: ['string', 'null'] },
      agreement_ref: { type: ['string', 'null'] },
      original_amount_minor: { type: ['integer', 'null'], description: 'Amount borrowed, pence' },
      current_balance_minor: { type: ['integer', 'null'] },
      apr: { type: ['number', 'null'] },
      rate_type: { type: ['string', 'null'], description: 'fixed|variable|unknown' },
      start_date: { type: ['string', 'null'], description: 'First payment date, ISO' },
      term_months: { type: ['integer', 'null'] },
      monthly_payment_minor: { type: ['integer', 'null'] },
      payment_day: { type: ['integer', 'null'] },
      fees_minor: { type: ['integer', 'null'] },
      final_payment_minor: { type: ['integer', 'null'] },
      balloon_minor: { type: ['integer', 'null'], description: 'Optional final balloon / GFV payment (PCP)' },
      settlement_quote_minor: { type: ['integer', 'null'] },
      settlement_quote_expiry: { type: ['string', 'null'] },
      early_repayment_terms: { type: ['string', 'null'] },
      overpayment_rule: { type: ['string', 'null'], description: 'reduce_term|reduce_payment|unknown' },
      liability_type: { type: ['string', 'null'], description: 'personal_loan|credit_card|vehicle_finance|hire_purchase|pcp|mortgage|other' },
      confidence: { type: 'number' },
    },
  },
}

function normalise(raw: string): string {
  return raw.toUpperCase().replace(/\d{2,}/g, '').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim()
}

interface ExtractedTxn {
  date: string
  description: string
  merchant?: string | null
  amount_minor: number
  running_balance_minor?: number | null
  reference?: string | null
  confidence: number
}

/** Parse tool JSON that may have been cut off by the output-token cap.
 * Truncation lands mid-way through the transactions array, so trim back to
 * the last complete transaction object and close the array + wrapper. */
function salvageJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const cut = text.lastIndexOf('},')
    if (cut === -1) return null
    try {
      return JSON.parse(`${text.slice(0, cut + 1)}]}`) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

/** One streamed extraction call. Returns the (possibly salvaged) tool input
 * and whether the response was truncated by the token cap. */
async function streamExtract(
  anthropic: Anthropic,
  contentBlock: Anthropic.Beta.BetaContentBlockParam,
  prompt: string,
  tool: Anthropic.Beta.BetaTool,
): Promise<{ input: Record<string, unknown> | null; truncated: boolean }> {
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
  })
  let raw = ''
  let stopReason: string | null = null
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      raw += event.delta.partial_json
    } else if (event.type === 'message_delta' && event.delta.stop_reason) {
      stopReason = event.delta.stop_reason
    }
  }
  if (stopReason === 'refusal') throw new Error('The AI declined to process this document')
  return { input: salvageJson(raw), truncated: stopReason === 'max_tokens' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const auth = await requireUser(req)
  if (auth instanceof Response) return auth
  const ctx = auth

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 503)

  let body: { batch_id?: string; document_id?: string; account_id?: string | null; kind?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body.batch_id || !body.document_id) {
    return json({ error: 'batch_id and document_id are required' }, 400)
  }

  const { data: doc } = await ctx.supabase.from('documents').select('*').eq('id', body.document_id).single()
  if (!doc) {
    await ctx.supabase.from('import_batches').update({ status: 'failed', error: 'Document not found' }).eq('id', body.batch_id)
    return json({ error: 'Document not found' }, 404)
  }

  // Everything slow happens after the response: the UI polls the batch row.
  EdgeRuntime.waitUntil(
    runExtraction(ctx, apiKey, body as { batch_id: string; document_id: string; account_id?: string | null; kind?: string }, doc as Record<string, unknown>).catch(
      async (e) => {
        const message = e instanceof Error ? e.message : 'Extraction failed unexpectedly'
        await ctx.supabase
          .from('import_batches')
          .update({ status: 'failed', error: `AI extraction failed: ${message}` })
          .eq('id', body.batch_id!)
      },
    ),
  )
  return json({ status: 'processing' }, 202)
})

async function runExtraction(
  ctx: AuthedContext,
  apiKey: string,
  body: { batch_id: string; document_id: string; account_id?: string | null; kind?: string },
  doc: Record<string, unknown>,
) {
  const fail = async (message: string) => {
    await ctx.supabase.from('import_batches').update({ status: 'failed', error: message }).eq('id', body.batch_id)
  }

  const { data: file, error: dlErr } = await ctx.supabase.storage
    .from('documents')
    .download(doc.storage_path as string)
  if (dlErr || !file) return fail('Could not download the uploaded file')

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > 15 * 1024 * 1024) return fail('File exceeds 15 MB limit')
  let b64 = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  b64 = btoa(b64)

  const mime = doc.mime_type as string
  const isPdf = mime === 'application/pdf'
  const isContract = doc.kind === 'contract' || body.kind === 'contract'
  const contentBlock: Anthropic.Beta.BetaContentBlockParam = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime as 'image/png' | 'image/jpeg', data: b64 } }

  const anthropic = new Anthropic({ apiKey })

  // ---------------------------------------------------------- contracts
  if (isContract) {
    const prompt =
      'Extract the loan/credit agreement terms from this document. All money values in integer pence (£1,234.56 = 123456). Use null for anything not stated — never guess. Then call record_extracted_loan_terms exactly once.'
    let extracted: Record<string, unknown> | null = null
    try {
      const result = await streamExtract(anthropic, contentBlock, prompt, EXTRACT_CONTRACT_TOOL)
      extracted = result.input
    } catch (e) {
      return fail(`AI extraction failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
    if (!extracted) return fail('No structured data could be extracted from this file')
    const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : null
    const { error } = await ctx.supabase
      .from('loan_contracts')
      .insert({
        user_id: ctx.userId,
        document_id: body.document_id,
        extracted,
        confidence,
        status: 'proposed',
      })
    if (error) return fail(error.message)
    await ctx.supabase
      .from('import_batches')
      .update({ status: 'review', ai_model: MODEL, stats: { extracted: 1 } })
      .eq('id', body.batch_id)
    return
  }

  // -------------------------------------------------------- transactions
  const basePrompt = `Extract every transaction visible in this bank statement. Also identify which bank or provider the statement is from, and any account number hint shown. All amounts in integer pence; money out is NEGATIVE. Read dates carefully (UK format is day/month). Today is ${new Date().toISOString().slice(0, 10)} — infer missing years from context. Include partially-visible rows with low confidence rather than omitting them. Work through the statement strictly in order from the first page to the last. Then call record_extracted_transactions exactly once.`

  const all: ExtractedTxn[] = []
  const seen = new Set<string>()
  let bankName = ''
  let passes = 0
  try {
    let continueFrom: ExtractedTxn | null = null
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      passes = pass + 1
      const prompt = continueFrom
        ? `${basePrompt}\n\nIMPORTANT: a previous pass over this document was cut short. It already recorded every transaction up to and including this one: date ${continueFrom.date}, description "${continueFrom.description}", amount ${continueFrom.amount_minor} pence. Skip everything up to and including that transaction and record ONLY the transactions that come after it in the statement.`
        : basePrompt
      const { input, truncated } = await streamExtract(anthropic, contentBlock, prompt, EXTRACT_TXNS_TOOL)
      if (!input) {
        if (all.length === 0) return fail('No structured data could be extracted from this file')
        break
      }
      if (!bankName && typeof input.bank_name === 'string') bankName = input.bank_name.trim()
      const txns = (input.transactions ?? []) as ExtractedTxn[]
      let added = 0
      for (const t of txns) {
        const key = `${t.date}|${t.amount_minor}|${(t.description ?? '').trim()}`
        if (!seen.has(key)) {
          seen.add(key)
          all.push(t)
          added++
        }
      }
      if (!truncated || added === 0) break
      continueFrom = all[all.length - 1] ?? null
    }
  } catch (e) {
    if (all.length === 0) {
      return fail(`AI extraction failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
    // Later passes failing still leaves a usable partial extraction.
  }

  // Auto-attribute the account: if the caller didn't pick one, match the
  // extracted bank name against the user's accounts. Only a single
  // unambiguous match is used — otherwise the review screen asks.
  let accountId = body.account_id ?? null
  if (!accountId && bankName) {
    const { data: accts } = await ctx.supabase
      .from('accounts')
      .select('id,name,provider')
      .is('archived_at', null)
    const bank = bankName.toUpperCase()
    const matches = ((accts ?? []) as { id: string; name: string; provider: string | null }[]).filter(
      (a) => {
        const hay = `${a.name} ${a.provider ?? ''}`.toUpperCase()
        return hay.includes(bank) || (a.provider ?? '').toUpperCase() === bank
      },
    )
    if (matches.length === 1) {
      accountId = matches[0].id
      await ctx.supabase.from('import_batches').update({ account_id: accountId }).eq('id', body.batch_id)
    }
  }
  const valid = all.filter(
    (t) =>
      /^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '') &&
      typeof t.description === 'string' &&
      Number.isInteger(t.amount_minor) &&
      t.amount_minor !== 0,
  )

  // Learned categorisation rules
  const { data: rules } = await ctx.supabase
    .from('categorisation_rules')
    .select('matcher,match_type,merchant_id,category_id,priority')
    .eq('is_active', true)
    .order('priority')

  // Existing ledger rows for duplicate detection (same account, date window)
  const dates = valid.map((t) => t.date).sort()
  let existing: { id: string; date: string; amount_minor: number; description: string; running_balance_minor: number | null }[] = []
  if (accountId && dates.length > 0) {
    const { data } = await ctx.supabase
      .from('transactions')
      .select('id,date,amount_minor,description,running_balance_minor')
      .eq('account_id', accountId)
      .gte('date', shiftDays(dates[0], -3))
      .lte('date', shiftDays(dates[dates.length - 1], 3))
    existing = (data ?? []) as typeof existing
  }

  const items = valid.map((t) => {
    let categoryId: string | null = null
    const hay = t.description.toUpperCase()
    for (const r of (rules ?? []) as { matcher: string; match_type: string; category_id: string | null }[]) {
      const hit =
        r.match_type === 'exact' ? hay === r.matcher
        : r.match_type === 'starts_with' ? hay.startsWith(r.matcher)
        : hay.includes(r.matcher)
      if (hit) {
        categoryId = r.category_id
        break
      }
    }
    // Duplicate scoring
    let duplicateOf: string | null = null
    let duplicateScore: number | null = null
    for (const e of existing) {
      if (e.amount_minor !== t.amount_minor) continue
      const dayDiff = Math.abs((Date.parse(e.date) - Date.parse(t.date)) / 86_400_000)
      if (dayDiff > 3) continue
      const sameNorm = normalise(e.description) === normalise(t.description)
      const balancesDisagree =
        t.running_balance_minor != null &&
        e.running_balance_minor != null &&
        t.running_balance_minor !== e.running_balance_minor
      // Same day + same amount on the same account is a likely duplicate even
      // when the wording differs (CSV vs PDF renderings of one statement);
      // disagreeing running balances rescue genuine repeat purchases.
      let score = sameNorm && dayDiff === 0 ? 1 : sameNorm ? 0.85 : dayDiff === 0 ? 0.75 : 0.5
      if (balancesDisagree) score -= 0.45
      if (score >= 0.5 && (duplicateScore === null || score > duplicateScore)) {
        duplicateScore = Math.min(1, score)
        duplicateOf = score >= 0.75 ? e.id : duplicateOf
      }
    }
    return {
      user_id: ctx.userId,
      batch_id: body.batch_id,
      raw_text: t.description,
      extracted: { reference: t.reference ?? null, merchant: t.merchant ?? null },
      proposed_date: t.date,
      proposed_description: t.description,
      proposed_amount_minor: t.amount_minor,
      proposed_merchant: t.merchant ?? null,
      proposed_category_id: categoryId,
      running_balance_minor: t.running_balance_minor ?? null,
      confidence: Math.max(0, Math.min(1, t.confidence)),
      duplicate_of: duplicateOf,
      duplicate_score: duplicateScore,
      status: 'proposed',
    }
  })

  // Long statements produce thousands of rows — insert in chunks.
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await ctx.supabase.from('imported_items').insert(items.slice(i, i + 500))
    if (error) return fail(error.message)
  }

  await ctx.supabase
    .from('import_batches')
    .update({
      status: items.length > 0 ? 'review' : 'failed',
      error: items.length > 0 ? null : 'No transactions could be read from this file',
      ai_model: MODEL,
      stats: {
        extracted: items.length,
        skipped: all.length - valid.length,
        passes,
        ...(bankName ? { bank: bankName } : {}),
      },
    })
    .eq('id', body.batch_id)

  // Document retention preference
  const { data: profile } = await ctx.supabase.from('profiles').select('document_retention').single()
  if ((profile as { document_retention: string } | null)?.document_retention === 'delete' && items.length > 0) {
    await ctx.supabase.storage.from('documents').remove([doc.storage_path as string])
    await ctx.supabase
      .from('documents')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', body.document_id)
  }
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
