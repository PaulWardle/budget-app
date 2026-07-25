import { AccountSelect, PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, EmptyState, Label, Spinner } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  fetchAccounts,
  fetchBatches,
  fetchLiabilities,
  fetchRecurring,
  fetchTransactions,
  undoImportBatch,
} from '@/lib/api'
import { processUpload } from '@/lib/importFlow'
import { dedupeHash } from '@/lib/engine/duplicates'
import { formatDateTime, relativeDays } from '@/lib/format'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, FileUp, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

export default function ImportsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: batches, isLoading } = useQuery({
    queryKey: ['batches'],
    queryFn: fetchBatches,
    // Live-update while any extraction is running — no manual refresh needed
    refetchInterval: (q) =>
      (q.state.data ?? []).some((b) => b.status === 'processing' || b.status === 'pending')
        ? 2500
        : false,
  })
  const { data: transactions } = useQuery({
    queryKey: ['transactions', 'quality'],
    queryFn: () => fetchTransactions({ limit: 2000 }),
  })
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The button is busy only while the file itself uploads (a second or two).
  // Extraction continues in the background — the batch appears in the list as
  // "processing" and the list polls until it flips to "review".
  function startUpload(file: File): Promise<void> {
    return new Promise((resolve) => {
      let released = false
      const release = () => {
        if (!released) {
          released = true
          resolve()
        }
      }
      processUpload(userId, file, accountId, {
        onBatchCreated: () => {
          qc.invalidateQueries({ queryKey: ['batches'] })
          release()
        },
      })
        .then((outcome) => {
          if (outcome.status === 'failed') setError(outcome.error ?? `Import of ${outcome.fileName} failed`)
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => {
          qc.invalidateQueries({ queryKey: ['batches'] })
          release()
        })
    })
  }

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      setError(null)
      for (const file of files) {
        setStatus(`Uploading ${file.name}…`)
        await startUpload(file)
      }
    },
    onSettled: () => setStatus(null),
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
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => e.target.files && e.target.files.length > 0 && upload.mutate(e.target.files)}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              <Upload className="h-4 w-4" />
              {upload.isPending ? (status ?? 'Uploading…') : 'Choose files or photos'}
            </Button>
            <Button variant="outline" onClick={() => cameraRef.current?.click()} disabled={upload.isPending}>
              <Camera className="h-4 w-4" /> Take photo
            </Button>
          </div>
          <p className="text-[11px] text-ink-faint">
            Screenshots, photos, PDFs or CSV exports, up to 15&nbsp;MB. On a phone, “Choose files
            or photos” opens your photo library and “Take photo” opens the camera. CSVs are parsed
            in the app; images and PDFs are read by AI — everything goes through your review
            screen before anything is saved.
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
