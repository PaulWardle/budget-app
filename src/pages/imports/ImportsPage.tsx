import { AccountSelect, PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, EmptyState, Label, Spinner } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  applyRules,
  fetchAccounts,
  fetchBatches,
  fetchLiabilities,
  fetchRecurring,
  fetchRules,
  fetchTransactions,
  recordAudit,
  undoImportBatch,
  uploadDocument,
} from '@/lib/api'
import { parseStatementCsv } from '@/lib/csv'
import { dedupeHash } from '@/lib/engine/duplicates'
import { formatDateTime, relativeDays } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function ImportsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: batches, isLoading } = useQuery({ queryKey: ['batches'], queryFn: fetchBatches })
  const { data: transactions } = useQuery({
    queryKey: ['transactions', 'quality'],
    queryFn: () => fetchTransactions({ limit: 2000 }),
  })
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const fileRef = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      if (!accountId && ![...files].every((f) => f.name.toLowerCase().endsWith('.pdf'))) {
        // Account required for statements; contracts can go without
      }
      for (const file of files) {
        setStatus(`Uploading ${file.name}…`)
        const isCsv = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv')
        const kind = isCsv ? 'statement' : file.type === 'application/pdf' ? 'statement' : 'statement'
        const doc = await uploadDocument(userId, file, kind)
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

        if (isCsv) {
          setStatus(`Reading ${file.name}…`)
          const text = await file.text()
          const parsed = parseStatementCsv(text)
          if (parsed.error && parsed.transactions.length === 0) {
            await supabase.from('import_batches').update({ status: 'failed', error: parsed.error }).eq('id', batch.id)
            throw new Error(parsed.error)
          }
          const rules = await fetchRules()
          const existing = (transactions ?? []).map((t) => ({
            id: t.id,
            accountId: t.account_id,
            date: t.date,
            amountMinor: t.amount_minor,
            description: t.description,
            runningBalanceMinor: t.running_balance_minor,
          }))
          const { findDuplicates } = await import('@/lib/engine/duplicates')
          const items = parsed.transactions.map((t) => {
            const ruleHit = applyRules(t.description, rules)
            const dupes = accountId
              ? findDuplicates(
                  { accountId, date: t.date, amountMinor: t.amountMinor, description: t.description, runningBalanceMinor: t.balanceMinor },
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
              proposed_merchant: null,
              proposed_category_id: ruleHit?.categoryId ?? null,
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
            userId, recordType: 'import_batch', recordId: batch.id, action: 'insert',
            next: { file: file.name, extracted: items.length }, source: 'import',
          })
          navigate(`/imports/${batch.id}`)
        } else {
          // Image/PDF → AI extraction via edge function
          setStatus(`Asking AI to read ${file.name}…`)
          const { data: session } = await supabase.auth.getSession()
          const { error: fnErr } = await supabase.functions.invoke('ai-extract', {
            body: { batch_id: batch.id, document_id: doc.id, account_id: accountId },
            headers: { Authorization: `Bearer ${session.session?.access_token}` },
          })
          if (fnErr) {
            await supabase
              .from('import_batches')
              .update({ status: 'failed', error: 'AI extraction unavailable. Deploy the ai-extract edge function and set ANTHROPIC_API_KEY.' })
              .eq('id', batch.id)
            throw new Error(
              'AI extraction is not available yet. CSV imports work without it; for screenshots/PDFs deploy the ai-extract function (see README).',
            )
          }
          navigate(`/imports/${batch.id}`)
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batches'] })
      setStatus(null)
      setError(null)
    },
    onError: (e: Error) => {
      setStatus(null)
      setError(e.message)
      qc.invalidateQueries({ queryKey: ['batches'] })
    },
  })

  const undo = useMutation({
    mutationFn: (batchId: string) => undoImportBatch(userId, batchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batches'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
    },
  })

  if (!accounts || isLoading) return <Spinner />

  // ---- Data quality ----
  const uncategorised = (transactions ?? []).filter((t) => !t.category_id && !t.is_transfer).length
  const lowConfidence = (transactions ?? []).filter((t) => t.needs_review).length
  const staleAccounts = accounts.filter(
    (a) =>
      ['current', 'savings', 'credit_card', 'wallet'].includes(a.account_type) &&
      Date.now() - new Date(a.balance_updated_at).getTime() > 14 * 86_400_000,
  )
  const staleDebts = (liabilities ?? []).filter(
    (l) => l.status === 'active' && Date.now() - Date.parse(l.balance_effective_date) > 45 * 86_400_000,
  )
  const missingLoanInfo = (liabilities ?? []).filter(
    (l) => l.status === 'active' && (!l.apr || !l.term_months || !l.original_balance_minor),
  )
  const unconfirmedRecurring = (recurring ?? []).filter((r) => r.needs_confirmation).length
  const dupes = countPossibleDuplicates(transactions ?? [])

  return (
    <div className="space-y-4">
      <PageHeader title="Imports" sub="Screenshots, PDF statements, CSV exports and loan contracts" />

      <Card>
        <CardTitle>Upload statements or contracts</CardTitle>
        <div className="space-y-3">
          <div>
            <Label>Account the file belongs to</Label>
            <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} allowNone />
            <p className="mt-1 text-[11px] text-ink-faint">
              Choose the account for bank statements. Loan contracts can be uploaded without one.
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.pdf,.csv,image/png,image/jpeg,application/pdf,text/csv"
            className="hidden"
            onChange={(e) => e.target.files && e.target.files.length > 0 && upload.mutate(e.target.files)}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            <Upload className="h-4 w-4" />
            {upload.isPending ? (status ?? 'Working…') : 'Choose files'}
          </Button>
          <p className="text-[11px] text-ink-faint">
            PNG, JPG, PDF or CSV, up to 15&nbsp;MB. CSVs are parsed deterministically in the app;
            screenshots and PDFs are read by AI and always go through your review before saving.
          </p>
          {error && <p className="text-xs text-bad">{error}</p>}
        </div>
      </Card>

      <Card>
        <CardTitle>Data quality</CardTitle>
        <div className="space-y-1.5 text-sm">
          <QualityRow ok={staleAccounts.length === 0} label={staleAccounts.length === 0 ? 'All cash balances updated in the last 14 days' : `${staleAccounts.length} account(s) with stale balances: ${staleAccounts.map((a) => `${a.name} (${relativeDays(a.balance_updated_at)})`).join(', ')}`} />
          <QualityRow
            ok={uncategorised === 0}
            label={uncategorised === 0 ? 'All transactions categorised' : `${uncategorised} uncategorised transactions`}
            link={uncategorised > 0 ? '/transactions?uncategorised=1' : undefined}
          />
          <QualityRow ok={lowConfidence === 0} label={lowConfidence === 0 ? 'No imports awaiting review' : `${lowConfidence} low-confidence imported transactions to check`} />
          <QualityRow ok={dupes === 0} label={dupes === 0 ? 'No possible duplicates detected' : `${dupes} possible duplicate transaction pairs`} />
          <QualityRow ok={missingLoanInfo.length === 0} label={missingLoanInfo.length === 0 ? 'All debts have full loan details' : `${missingLoanInfo.length} debt(s) missing APR/term/original amount: ${missingLoanInfo.map((l) => l.name).join(', ')}`} link={missingLoanInfo.length > 0 ? '/debts' : undefined} />
          <QualityRow ok={staleDebts.length === 0} label={staleDebts.length === 0 ? 'Debt balances are recent' : `${staleDebts.length} debt(s) without a balance update in 45+ days`} link={staleDebts.length > 0 ? '/debts' : undefined} />
          <QualityRow ok={unconfirmedRecurring === 0} label={unconfirmedRecurring === 0 ? 'No recurring payments awaiting confirmation' : `${unconfirmedRecurring} recurring payment(s) need confirmation`} link={unconfirmedRecurring > 0 ? '/bills' : undefined} />
        </div>
      </Card>

      <Card>
        <CardTitle>Import history</CardTitle>
        {(batches ?? []).length === 0 ? (
          <EmptyState title="No imports yet" hint="Upload your first statement above." />
        ) : (
          <div className="space-y-2">
            {(batches ?? []).map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 border-b border-border py-2 last:border-0">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    <FileUp className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    {b.file_name ?? b.source_type}
                  </p>
                  <p className="text-[11px] text-ink-faint">
                    {formatDateTime(b.created_at)} · {b.source_type}
                    {b.stats.extracted !== undefined && ` · ${b.stats.extracted} extracted`}
                    {b.stats.confirmed !== undefined && ` · ${b.stats.confirmed} confirmed`}
                    {b.error && <span className="text-bad"> · {b.error}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge
                    tone={
                      b.status === 'completed' ? 'good'
                      : b.status === 'review' ? 'warn'
                      : b.status === 'failed' ? 'bad'
                      : 'neutral'
                    }
                  >
                    {b.status}
                  </Badge>
                  {b.status === 'review' && (
                    <Link to={`/imports/${b.id}`}>
                      <Button size="sm" variant="secondary">Review</Button>
                    </Link>
                  )}
                  {b.status === 'completed' && (
                    <Button size="sm" variant="ghost" onClick={() => undo.mutate(b.id)}>
                      Undo
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function QualityRow({ ok, label, link }: { ok: boolean; label: string; link?: string }) {
  const inner = (
    <span className="flex items-start gap-2">
      <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-good' : 'bg-warn'}`} />
      <span className={ok ? 'text-ink-muted' : ''}>{label}</span>
    </span>
  )
  return link ? (
    <Link to={link} className="block hover:text-accent">
      {inner}
    </Link>
  ) : (
    inner
  )
}

function countPossibleDuplicates(txns: { date: string; amount_minor: number; description: string; account_id: string }[]): number {
  const seen = new Map<string, number>()
  let count = 0
  for (const t of txns) {
    const key = dedupeHash({ accountId: t.account_id, date: t.date, amountMinor: t.amount_minor, description: t.description })
    const n = seen.get(key) ?? 0
    if (n === 1) count++
    seen.set(key, n + 1)
  }
  return count
}
