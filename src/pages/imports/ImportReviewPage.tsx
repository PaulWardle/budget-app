import { AccountSelect, CategorySelect, ConfidenceBadge, MoneyInput, PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, Input, Spinner } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import { fetchAccounts, fetchBatchItems, fetchBatches, fetchCategories, learnMerchant, recordAudit, syncRecurringFromLedger, updateAccount } from '@/lib/api'
import { resolveCategoryId, suggestFromDescription } from '@/lib/autoCategorise'
import { dedupeHash } from '@/lib/engine/duplicates'
import { formatDate, money } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import type { ImportedItem } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

interface EditableItem {
  id: string
  date: string
  description: string
  merchant: string
  amountMinor: number | null
  categoryId: string | null
  confidence: number | null
  duplicateOf: string | null
  duplicateScore: number | null
  runningBalanceMinor: number | null
  rawText: string | null
  status: ImportedItem['status']
  include: boolean
}

export default function ImportReviewPage() {
  const { batchId } = useParams<{ batchId: string }>()
  const userId = useUserId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: batches } = useQuery({
    queryKey: ['batches'],
    queryFn: fetchBatches,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((b) => b.id === batchId && (b.status === 'processing' || b.status === 'pending'))
        ? 2500
        : false,
  })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: items, isLoading } = useQuery({
    queryKey: ['batch-items', batchId],
    queryFn: () => fetchBatchItems(batchId!),
    enabled: !!batchId,
    refetchInterval: (q) => ((q.state.data?.length ?? 0) === 0 ? 2500 : false),
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const [edits, setEdits] = useState<EditableItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null)

  const batch = batches?.find((b) => b.id === batchId)

  useEffect(() => {
    if (items && categories) {
      setEdits(
        items
          .filter((i) => i.status === 'proposed')
          .map((i) => {
            // Fill unmistakable merchants automatically; leave doubt flagged.
            const builtin = i.proposed_category_id
              ? null
              : suggestFromDescription(i.proposed_description ?? '')
            return {
            id: i.id,
            date: i.proposed_date ?? '',
            description: i.proposed_description ?? '',
            merchant: i.proposed_merchant ?? builtin?.merchant ?? '',
            amountMinor: i.proposed_amount_minor,
            categoryId:
              i.proposed_category_id ??
              (builtin ? resolveCategoryId(categories, builtin.path) : null),
            confidence: i.confidence,
            duplicateOf: i.duplicate_of,
            duplicateScore: i.duplicate_score,
            runningBalanceMinor: i.running_balance_minor,
            rawText: i.raw_text,
            status: i.status,
            include: i.duplicate_of === null, // possible duplicates default to excluded
            }
          }),
      )
    }
  }, [items, categories])

  const confirm = useMutation({
    mutationFn: async () => {
      if (!batch) throw new Error('Batch not found')
      const accountId = pickedAccountId ?? batch.account_id
      if (!accountId) throw new Error('Choose which account these transactions belong to first.')
      if (accountId !== batch.account_id) {
        await supabase.from('import_batches').update({ account_id: accountId }).eq('id', batch.id)
      }
      const chosen = edits.filter((e) => e.include && e.amountMinor !== null && e.date && e.description)
      const rejected = edits.filter((e) => !e.include)
      // Second duplicate gate at save time: extraction-time checks only see
      // transactions that were already saved, so two copies of the same
      // statement sitting in review together would slip through. Anything
      // whose exact hash is already in the ledger is skipped — unless the
      // user explicitly ticked a flagged duplicate to override.
      let existingHashes = new Set<string>()
      if (chosen.length > 0) {
        const dates = chosen.map((e) => e.date).sort()
        const { data: existing } = await supabase
          .from('transactions')
          .select('dedupe_hash')
          .eq('account_id', accountId)
          .gte('date', dates[0])
          .lte('date', dates[dates.length - 1])
        existingHashes = new Set(
          ((existing ?? []) as { dedupe_hash: string | null }[])
            .map((r) => r.dedupe_hash)
            .filter((h): h is string => !!h),
        )
      }
      let confirmedCount = 0
      let skippedDuplicates = 0
      let latestBalance: { date: string; balanceMinor: number } | null = null
      for (const e of chosen) {
        const hash = dedupeHash({
          accountId,
          date: e.date,
          amountMinor: e.amountMinor!,
          description: e.description,
        })
        if (existingHashes.has(hash) && !e.duplicateOf) {
          await supabase.from('imported_items').update({ status: 'duplicate' }).eq('id', e.id)
          skippedDuplicates++
          continue
        }
        const { data: txn, error: tErr } = await supabase
          .from('transactions')
          .insert({
            user_id: userId,
            account_id: accountId,
            date: e.date,
            description: e.description,
            merchant_name: e.merchant || null,
            category_id: e.categoryId,
            amount_minor: e.amountMinor,
            running_balance_minor: e.runningBalanceMinor,
            import_batch_id: batch.id,
            confidence: e.confidence,
            needs_review: (e.confidence ?? 1) < 0.6,
            dedupe_hash: hash,
            source: 'import',
          })
          .select('id')
          .single()
        if (tErr) throw new Error(tErr.message)
        if (e.runningBalanceMinor !== null && (!latestBalance || e.date >= latestBalance.date)) {
          latestBalance = { date: e.date, balanceMinor: e.runningBalanceMinor }
        }
        await supabase
          .from('imported_items')
          .update({
            status: 'confirmed',
            transaction_id: txn.id,
            user_corrected: {
              date: e.date,
              description: e.description,
              amount_minor: e.amountMinor,
              category_id: e.categoryId,
            },
          })
          .eq('id', e.id)
        confirmedCount++
        // Merchant learning: user set both a merchant name and category
        if (e.merchant && e.categoryId) {
          await learnMerchant(userId, {
            merchantName: e.merchant,
            aliasPatterns: [e.merchant],
            categoryId: e.categoryId,
            source: 'import_confirmation',
          }).catch(() => {}) // duplicate rules are fine
        }
      }
      for (const e of rejected) {
        await supabase
          .from('imported_items')
          .update({ status: e.duplicateOf ? 'duplicate' : 'rejected' })
          .eq('id', e.id)
      }
      // Statements carry the account's actual balance — feed it into Wealth.
      // Take the newest running balance across the WHOLE ledger for this
      // account, not just this batch, so uploading statements out of order
      // still leaves the most recent balance in place.
      if (latestBalance) {
        const { data: newest } = await supabase
          .from('transactions')
          .select('running_balance_minor')
          .eq('account_id', accountId)
          .not('running_balance_minor', 'is', null)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1)
        const balanceMinor = (newest?.[0] as { running_balance_minor: number } | undefined)?.running_balance_minor
        const acct = (accounts ?? []).find((a) => a.id === accountId)
        if (balanceMinor != null && acct && acct.balance_minor !== balanceMinor) {
          await updateAccount(userId, accountId, { balance_minor: balanceMinor }, 'import').catch(() => {})
        }
      }
      await supabase
        .from('import_batches')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          stats: {
            ...batch.stats,
            confirmed: confirmedCount,
            rejected: rejected.length,
            duplicates: rejected.filter((e) => e.duplicateOf).length + skippedDuplicates,
          },
        })
        .eq('id', batch.id)
      await recordAudit({
        userId, recordType: 'import_batch', recordId: batch.id, action: 'update',
        next: { confirmed: confirmedCount, rejected: rejected.length }, source: 'import', undoable: true,
        importBatchId: batch.id,
      })
      // Turn the new history into known bills so Home, Cashflow and Bills
      // have something to show without any extra steps.
      await syncRecurringFromLedger(userId).catch(() => {})
      return confirmedCount
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['batches'] })
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['recurring'] })
      qc.invalidateQueries({ queryKey: ['networth'] })
      navigate('/imports')
    },
    onError: (e: Error) => setError(e.message),
  })

  if (isLoading || !categories) return <Spinner />

  if ((items ?? []).length === 0) {
    return (
      <div>
        <PageHeader title="Import review" sub={batch?.file_name ?? ''} />
        <Card className="flex items-center gap-3">
          {batch?.status === 'processing' ? (
            <>
              <Spinner />
              <p className="text-sm text-ink-muted">
                Extraction in progress — this page refreshes automatically.
              </p>
            </>
          ) : batch?.status === 'failed' ? (
            <p className="text-sm text-bad">{batch.error ?? 'Extraction failed.'}</p>
          ) : (
            <p className="text-sm text-ink-muted">
              No proposed items in this batch. <Link className="text-accent" to="/imports">Back to imports</Link>
            </p>
          )}
        </Card>
      </div>
    )
  }

  const included = edits.filter((e) => e.include).length
  const total = edits.reduce((s, e) => (e.include ? s + (e.amountMinor ?? 0) : s), 0)

  return (
    <div>
      <PageHeader
        title="Import review"
        sub={`${batch?.file_name ?? ''} · ${edits.length} extracted · ${included} selected · net ${money(total)}`}
        actions={
          <Button
            onClick={() => confirm.mutate()}
            disabled={confirm.isPending || included === 0 || !(pickedAccountId ?? batch?.account_id)}
          >
            {confirm.isPending ? 'Saving…' : `Save ${included} transactions`}
          </Button>
        }
      />
      {error && <p className="mb-3 text-xs text-bad">{error}</p>}
      {batch && (
        <Card className="mb-3 flex flex-wrap items-center gap-3 py-3">
          <span className="text-xs font-semibold">Account</span>
          <div className="w-56">
            <AccountSelect
              accounts={accounts ?? []}
              value={pickedAccountId ?? batch.account_id}
              onChange={setPickedAccountId}
              allowNone
            />
          </div>
          <span className="text-[11px] text-ink-faint">
            {batch.account_id
              ? 'Matched automatically — change if wrong.'
              : 'Couldn’t match this statement to an account — pick one to enable saving.'}
          </span>
        </Card>
      )}
      <p className="mb-3 text-xs text-ink-muted">
        Check everything before saving — especially low-confidence rows. Possible duplicates are
        unticked by default rather than deleted, so nothing is lost silently.
      </p>
      <div className="space-y-2">
        {edits.map((e, i) => (
          <Card key={e.id} className={e.include ? '' : 'opacity-60'}>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1.5"
                checked={e.include}
                onChange={(ev) => setEdits(edits.map((x, j) => (j === i ? { ...x, include: ev.target.checked } : x)))}
                aria-label="Include this transaction"
              />
              <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <Input
                    type="date"
                    value={e.date}
                    onChange={(ev) => setEdits(edits.map((x, j) => (j === i ? { ...x, date: ev.target.value } : x)))}
                  />
                </div>
                <div>
                  <MoneyInput
                    valueMinor={e.amountMinor}
                    onChangeMinor={(m) => setEdits(edits.map((x, j) => (j === i ? { ...x, amountMinor: m } : x)))}
                    allowNegative
                  />
                </div>
                <div>
                  <Input
                    placeholder="Merchant"
                    value={e.merchant}
                    onChange={(ev) => setEdits(edits.map((x, j) => (j === i ? { ...x, merchant: ev.target.value } : x)))}
                  />
                </div>
                <div>
                  <CategorySelect
                    categories={categories}
                    value={e.categoryId}
                    onChange={(v) => setEdits(edits.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))}
                  />
                </div>
                <div className="col-span-2 sm:col-span-4">
                  <Input
                    value={e.description}
                    onChange={(ev) => setEdits(edits.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))}
                    className="text-xs text-ink-muted"
                  />
                </div>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
              <ConfidenceBadge value={e.confidence} />
              {e.duplicateOf && (
                <Badge tone="warn">
                  possible duplicate ({Math.round((e.duplicateScore ?? 0) * 100)}% match) — tick to import anyway
                </Badge>
              )}
              {!e.duplicateOf && (e.duplicateScore ?? 0) >= 0.5 && (
                <Badge tone="warn">
                  similar to an existing transaction ({Math.round((e.duplicateScore ?? 0) * 100)}% match) — check
                </Badge>
              )}
              {e.runningBalanceMinor !== null && (
                <span className="text-[11px] text-ink-faint">balance after: {money(e.runningBalanceMinor)}</span>
              )}
              {e.rawText && (
                <details className="text-[11px] text-ink-faint">
                  <summary className="cursor-pointer">original text</summary>
                  <code className="break-all">{e.rawText}</code>
                </details>
              )}
              {e.date && <span className="text-[11px] text-ink-faint">{formatDate(e.date)}</span>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
