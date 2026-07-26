// Shared upload → extract → review pipeline, used by both the Imports page
// and AI Chat attachments. CSVs are parsed deterministically in the browser;
// images/PDFs go to the ai-extract edge function. Everything lands as
// PROPOSED items for the review screen — nothing enters the ledger directly.

import { applyRules, fetchAccounts, fetchCategories, fetchRules, fetchTransactions, recordAudit, uploadDocument } from '@/lib/api'
import { resolveCategoryId, suggestFromDescription } from '@/lib/autoCategorise'
import { parseStatementCsv } from '@/lib/csv'
import { findDuplicates } from '@/lib/engine/duplicates'
import { supabase } from '@/lib/supabase'

export interface UploadOutcome {
  batchId: string
  status: 'review' | 'failed' | 'processing'
  extracted: number
  fileName: string
  error?: string
}

export function isCsvFile(file: File): boolean {
  return file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv')
}

export function isSupportedUpload(file: File): boolean {
  return (
    isCsvFile(file) ||
    ['image/png', 'image/jpeg', 'application/pdf'].includes(file.type)
  )
}

/**
 * Upload a loan/finance agreement and extract its terms. Unlike statements,
 * the output is a proposed loan_contracts row for the Debts page to review
 * and apply — never ledger transactions.
 */
export async function processContractUpload(userId: string, file: File): Promise<UploadOutcome> {
  if (isCsvFile(file)) throw new Error('Agreements should be a PDF or photo, not a CSV')
  const doc = await uploadDocument(userId, file, 'contract')
  const { data: batch, error: bErr } = await supabase
    .from('import_batches')
    .insert({
      user_id: userId,
      document_id: doc.id,
      source_type: file.type === 'application/pdf' ? 'pdf' : 'screenshot',
      file_name: file.name,
      status: 'processing',
    })
    .select()
    .single()
  if (bErr) throw new Error(bErr.message)
  const { data: session } = await supabase.auth.getSession()
  const { error: fnErr } = await supabase.functions.invoke('ai-extract', {
    body: { batch_id: batch.id, document_id: doc.id, kind: 'contract' },
    headers: { Authorization: `Bearer ${session.session?.access_token}` },
  })
  if (fnErr) {
    let message = 'AI extraction failed — could not reach the ai-extract function.'
    const resp = (fnErr as { context?: unknown }).context
    if (resp instanceof Response) {
      const errBody = (await resp.json().catch(() => null)) as { error?: string } | null
      if (errBody?.error) message = errBody.error
    }
    await supabase.from('import_batches').update({ status: 'failed', error: message }).eq('id', batch.id)
    return { batchId: batch.id, status: 'failed', extracted: 0, fileName: file.name, error: message }
  }
  return { batchId: batch.id, status: 'processing', extracted: 0, fileName: file.name }
}

/** Upload one file for an account and run it through extraction.
 * Returns the batch outcome; throws only on upload/infrastructure errors. */
export async function processUpload(
  userId: string,
  file: File,
  accountId: string | null,
  opts: { onBatchCreated?: (batchId: string) => void } = {},
): Promise<UploadOutcome> {
  const isCsv = isCsvFile(file)
  const doc = await uploadDocument(userId, file, 'statement')
  const sourceType = isCsv ? 'csv' : file.type === 'application/pdf' ? 'pdf' : 'screenshot'
  const { data: batch, error: bErr } = await supabase
    .from('import_batches')
    .insert({
      user_id: userId,
      account_id: accountId,
      document_id: doc.id,
      source_type: sourceType,
      file_name: file.name,
      status: 'processing',
    })
    .select()
    .single()
  if (bErr) throw new Error(bErr.message)
  opts.onBatchCreated?.(batch.id)

  if (isCsv) {
    const text = await file.text()
    // Auto-attribute the account from the filename/content when not chosen —
    // e.g. "Monzo Data Export….csv" matches the user's Monzo account.
    let effectiveAccountId = accountId
    if (!effectiveAccountId) {
      const accounts = await fetchAccounts()
      const hay = `${file.name} ${text.slice(0, 1000)}`.toUpperCase()
      const matches = accounts.filter((a) =>
        [a.provider, a.name]
          .filter((t): t is string => !!t && t.length >= 3)
          .some((t) => hay.includes(t.toUpperCase())),
      )
      if (matches.length === 1) {
        effectiveAccountId = matches[0].id
        await supabase.from('import_batches').update({ account_id: effectiveAccountId }).eq('id', batch.id)
      }
    }
    const parsed = parseStatementCsv(text)
    if (parsed.error && parsed.transactions.length === 0) {
      await supabase.from('import_batches').update({ status: 'failed', error: parsed.error }).eq('id', batch.id)
      return { batchId: batch.id, status: 'failed', extracted: 0, fileName: file.name, error: parsed.error }
    }
    const rules = await fetchRules()
    const categories = await fetchCategories()
    const ledger = effectiveAccountId
      ? await fetchTransactions({ accountId: effectiveAccountId, limit: 2000 })
      : []
    // Presumed postings must never make the REAL payment look like a
    // duplicate — reconciliation replaces them after confirm instead.
    const existing = ledger.filter((t) => !t.is_presumed).map((t) => ({
      id: t.id,
      accountId: t.account_id,
      date: t.date,
      amountMinor: t.amount_minor,
      description: t.description,
      runningBalanceMinor: t.running_balance_minor,
    }))
    const items = parsed.transactions.map((t) => {
      const ruleHit = applyRules(t.description, rules)
      // Learned rules win; otherwise fall back to the built-in dictionary of
      // unmistakable merchants. Anything ambiguous stays uncategorised.
      const builtin = ruleHit
        ? null
        : suggestFromDescription(t.merchant ? `${t.description} ${t.merchant}` : t.description)
      const builtinCategoryId = builtin ? resolveCategoryId(categories, builtin.path) : null
      const dupes = effectiveAccountId
        ? findDuplicates(
            {
              accountId: effectiveAccountId,
              date: t.date,
              amountMinor: t.amountMinor,
              description: t.description,
              runningBalanceMinor: t.balanceMinor,
            },
            existing,
          )
        : []
      const top = dupes[0]
      return {
        user_id: userId,
        batch_id: batch.id,
        raw_text: t.raw,
        extracted: { reference: t.reference },
        proposed_date: t.date,
        proposed_description: t.description,
        proposed_amount_minor: t.amountMinor,
        proposed_merchant: t.merchant ?? builtin?.merchant ?? null,
        proposed_category_id: ruleHit?.categoryId ?? builtinCategoryId,
        running_balance_minor: t.balanceMinor,
        confidence: 0.98, // deterministic parse
        duplicate_of: top && top.score >= 0.75 ? top.existingId : null,
        duplicate_score: top?.score ?? null,
        status: 'proposed',
      }
    })
    if (items.length > 0) {
      const { error: iErr } = await supabase.from('imported_items').insert(items)
      if (iErr) throw new Error(iErr.message)
    }
    await supabase
      .from('import_batches')
      .update({ status: 'review', stats: { extracted: items.length, skipped: parsed.skipped } })
      .eq('id', batch.id)
    await recordAudit({
      userId,
      recordType: 'import_batch',
      recordId: batch.id,
      action: 'insert',
      next: { file: file.name, extracted: items.length },
      source: 'import',
    })
    return { batchId: batch.id, status: 'review', extracted: items.length, fileName: file.name }
  }

  // Image / PDF → AI extraction. The function replies immediately with
  // { status: 'processing' } and finishes in the background — the imports
  // list and review screen poll the batch until it flips to review/failed.
  const { data: session } = await supabase.auth.getSession()
  const { data, error: fnErr } = await supabase.functions.invoke('ai-extract', {
    body: { batch_id: batch.id, document_id: doc.id, account_id: accountId },
    headers: { Authorization: `Bearer ${session.session?.access_token}` },
  })
  if (fnErr) {
    // Surface the function's real error rather than a canned guess.
    let message = 'AI extraction failed — could not reach the ai-extract function.'
    const resp = (fnErr as { context?: unknown }).context
    if (resp instanceof Response) {
      const errBody = (await resp.json().catch(() => null)) as { error?: string } | null
      if (errBody?.error) message = errBody.error
    }
    await supabase.from('import_batches').update({ status: 'failed', error: message }).eq('id', batch.id)
    return { batchId: batch.id, status: 'failed', extracted: 0, fileName: file.name, error: message }
  }
  const payload = data as { status?: string; extracted?: number } | null
  if (payload?.status === 'processing') {
    return { batchId: batch.id, status: 'processing', extracted: 0, fileName: file.name }
  }
  const extracted = payload?.extracted ?? 0
  return {
    batchId: batch.id,
    status: extracted > 0 ? 'review' : 'failed',
    extracted,
    fileName: file.name,
    error: extracted > 0 ? undefined : 'No transactions could be read from this file',
  }
}
