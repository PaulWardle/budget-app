import {
  AccountSelect,
  CategorySelect,
  ConfidenceBadge,
  MoneyInput,
  PageHeader,
  categoryLabel,
} from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  createTransaction,
  deleteTransaction,
  fetchAccounts,
  fetchCategories,
  fetchTransactions,
  learnMerchant,
  setTransactionSplits,
  updateTransaction,
  type TxnFilters,
} from '@/lib/api'
import { resolveCategoryId, suggestFromDescription } from '@/lib/autoCategorise'
import { dedupeHash } from '@/lib/engine/duplicates'
import { normaliseDescription } from '@/lib/engine/recurring'
import { supabase } from '@/lib/supabase'
import { formatDate, money, todayIso } from '@/lib/format'
import type { Transaction } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

function titleCaseKey(s: string): string {
  return s.toLowerCase().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function TransactionsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const filtersFromParams = (): TxnFilters & { duplicatesOnly?: boolean } => ({
    accountId: params.get('account') ?? undefined,
    categoryId: params.get('category') ?? undefined,
    merchantName: params.get('merchant') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    uncategorised: params.get('uncategorised') === '1' || undefined,
    importBatchId: params.get('batch') ?? undefined,
    duplicatesOnly: params.get('duplicates') === '1' || undefined,
  })
  const [filters, setFilters] = useState<TxnFilters & { duplicatesOnly?: boolean }>(filtersFromParams)
  // Keep filters in sync when arriving via a link (e.g. from Data Quality)
  useEffect(() => {
    setFilters(filtersFromParams())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const effective = useMemo(
    () => ({
      ...filters,
      duplicatesOnly: undefined,
      search: search || undefined,
      limit: filters.duplicatesOnly || filters.uncategorised ? 3000 : undefined,
    }),
    [filters, search],
  )
  const { data: rawTxns, isLoading } = useQuery({
    queryKey: ['transactions', effective],
    queryFn: () => fetchTransactions(effective),
  })
  // Duplicates view: keep only transactions whose account+date+amount+
  // normalised description occurs more than once in the ledger
  const txns = useMemo(() => {
    if (!rawTxns) return rawTxns
    if (!filters.duplicatesOnly) return rawTxns
    const counts = new Map<string, number>()
    for (const t of rawTxns) {
      const h = dedupeHash({ accountId: t.account_id, date: t.date, amountMinor: t.amount_minor, description: t.description })
      counts.set(h, (counts.get(h) ?? 0) + 1)
    }
    return rawTxns.filter(
      (t) =>
        (counts.get(
          dedupeHash({ accountId: t.account_id, date: t.date, amountMinor: t.amount_minor, description: t.description }),
        ) ?? 0) > 1,
    )
  }, [rawTxns, filters.duplicatesOnly])

  // Bulk categorisation groups: uncategorised transactions clustered by merchant
  const bulkGroups = useMemo(() => {
    if (!filters.uncategorised || !txns) return []
    const groups = new Map<string, { name: string; ids: string[]; totalMinor: number }>()
    for (const t of txns) {
      const key = (t.merchant_name ?? normaliseDescription(t.description)) || 'Unknown'
      const g = groups.get(key) ?? { name: t.merchant_name ?? titleCaseKey(key), ids: [], totalMinor: 0 }
      g.ids.push(t.id)
      if (t.amount_minor < 0) g.totalMinor += -t.amount_minor
      groups.set(key, g)
    }
    return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length).slice(0, 40)
  }, [filters.uncategorised, txns])

  const [bulkPicks, setBulkPicks] = useState<Record<string, string | null>>({})
  const bulkApply = useMutation({
    mutationFn: async (g: { name: string; ids: string[]; categoryId: string }) => {
      const { error } = await supabase
        .from('transactions')
        .update({ category_id: g.categoryId, merchant_name: g.name })
        .in('id', g.ids)
      if (error) throw new Error(error.message)
      // Learn it so every future import auto-categorises this merchant
      await learnMerchant(userId, {
        merchantName: g.name,
        aliasPatterns: [g.name],
        categoryId: g.categoryId,
        source: 'manual',
      }).catch(() => {})
    },
    onSuccess: () => invalidate(),
  })

  // One tap: run the built-in dictionary of unmistakable shops over every
  // uncategorised transaction on screen. Anything ambiguous stays flagged.
  const autoFill = useMutation({
    mutationFn: async () => {
      const groups = new Map<string, { categoryId: string; merchant: string; keepName: boolean; ids: string[] }>()
      for (const t of txns ?? []) {
        if (t.category_id) continue
        const s = suggestFromDescription(`${t.merchant_name ?? ''} ${t.description}`)
        const categoryId = s ? resolveCategoryId(categories ?? [], s.path) : null
        if (!s || !categoryId) continue
        const keepName = !!t.merchant_name
        const key = `${categoryId}|${s.merchant}|${keepName}`
        const g = groups.get(key) ?? { categoryId, merchant: s.merchant, keepName, ids: [] }
        g.ids.push(t.id)
        groups.set(key, g)
      }
      let n = 0
      for (const g of groups.values()) {
        const patch = g.keepName ? { category_id: g.categoryId } : { category_id: g.categoryId, merchant_name: g.merchant }
        const { error } = await supabase.from('transactions').update(patch).in('id', g.ids)
        if (error) throw new Error(error.message)
        n += g.ids.length
      }
      return n
    },
    onSuccess: () => invalidate(),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['budget'] })
  }

  const totals = useMemo(() => {
    const rows = txns ?? []
    const out = rows.filter((t) => t.amount_minor < 0 && !t.is_transfer).reduce((s, t) => s + -t.amount_minor, 0)
    const inn = rows.filter((t) => t.amount_minor > 0 && !t.is_transfer).reduce((s, t) => s + t.amount_minor, 0)
    return { out, inn, count: rows.length }
  }, [txns])

  if (!accounts || !categories) return <Spinner />

  return (
    <div>
      <PageHeader
        title="Transactions"
        sub={`${totals.count} shown · out ${money(totals.out)} · in ${money(totals.inn)}`}
        actions={
          <>
            <Button variant="outline" onClick={() => setShowFilters((v) => !v)}>
              <SlidersHorizontal className="h-4 w-4" /> Filters
            </Button>
            <Button onClick={() => setAdding(true)} disabled={accounts.length === 0}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </>
        }
      />

      <Input
        placeholder="Search description, merchant or notes…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-3"
      />

      {showFilters && (
        <Card className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <Label>Account</Label>
            <AccountSelect
              accounts={accounts}
              value={filters.accountId ?? null}
              onChange={(v) => setFilters({ ...filters, accountId: v ?? undefined })}
              allowNone
            />
          </div>
          <div>
            <Label>Category</Label>
            <CategorySelect
              categories={categories}
              value={filters.categoryId ?? null}
              onChange={(v) => setFilters({ ...filters, categoryId: v ?? undefined })}
            />
          </div>
          <div>
            <Label>From</Label>
            <Input
              type="date"
              value={filters.from ?? ''}
              onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })}
            />
          </div>
          <div>
            <Label>To</Label>
            <Input
              type="date"
              value={filters.to ?? ''}
              onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })}
            />
          </div>
          <div>
            <Label>Min amount (£)</Label>
            <MoneyInput
              valueMinor={filters.minAmountMinor ?? null}
              onChangeMinor={(m) => setFilters({ ...filters, minAmountMinor: m ?? undefined })}
            />
          </div>
          <div className="flex flex-col justify-end gap-1.5 pb-1">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={filters.uncategorised ?? false}
                onChange={(e) => setFilters({ ...filters, uncategorised: e.target.checked || undefined })}
              />
              Uncategorised only
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={filters.recurringOnly ?? false}
                onChange={(e) => setFilters({ ...filters, recurringOnly: e.target.checked || undefined })}
              />
              Recurring only
            </label>
          </div>
        </Card>
      )}

      {filters.uncategorised && bulkGroups.length > 0 && (
        <Card className="mb-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Bulk categorise — biggest merchants first
          </p>
          <p className="mb-2 text-[11px] text-ink-faint">
            Pick a category once per merchant; it applies to every matching transaction and is
            remembered for all future imports.
          </p>
          <div className="mb-2">
            <Button size="sm" variant="outline" disabled={autoFill.isPending} onClick={() => autoFill.mutate()}>
              {autoFill.isPending ? 'Categorising…' : 'Auto-categorise obvious shops'}
            </Button>
            {autoFill.isSuccess && (
              <span className="ml-2 text-[11px] text-ink-faint">
                {autoFill.data} transaction{autoFill.data === 1 ? '' : 's'} categorised
              </span>
            )}
          </div>
          <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {bulkGroups.map((g) => (
              <div key={g.name} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{g.name}</p>
                  <p className="text-[11px] text-ink-faint">
                    {g.ids.length} transaction{g.ids.length === 1 ? '' : 's'} · {money(g.totalMinor)}
                  </p>
                </div>
                <div className="w-48">
                  <CategorySelect
                    categories={categories}
                    value={bulkPicks[g.name] ?? null}
                    onChange={(v) => setBulkPicks({ ...bulkPicks, [g.name]: v })}
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!bulkPicks[g.name] || bulkApply.isPending}
                  onClick={() => bulkApply.mutate({ name: g.name, ids: g.ids, categoryId: bulkPicks[g.name]! })}
                >
                  Apply
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {filters.duplicatesOnly && (
        <p className="mb-3 rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">
          Showing only transactions that appear more than once (same account, date, amount and
          description). Open one and delete it if it's a genuine duplicate.
        </p>
      )}

      {isLoading && <Spinner />}
      {txns && txns.length === 0 && (
        <EmptyState title="No transactions match" hint="Import a statement or add one manually." />
      )}

      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {(txns ?? []).map((t) => (
          <button
            key={t.id}
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 cursor-pointer"
            onClick={() => setEditing(t)}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {t.merchant_name ?? t.description}
              </p>
              <p className="truncate text-[11px] text-ink-faint">
                {formatDate(t.date)} · {categoryLabel(categories, t.category_id)}
                {t.transaction_splits && t.transaction_splits.length > 0 && ' · split'}
                {t.notes ? ` · ${t.notes}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {t.is_transfer && <Badge>transfer</Badge>}
              {t.is_reimbursable && <Badge tone="accent">reimbursable</Badge>}
              {t.exclude_from_budget && !t.is_transfer && <Badge>excluded</Badge>}
              {t.needs_review && <ConfidenceBadge value={t.confidence} />}
              <span
                className={`tnum text-sm font-semibold ${t.amount_minor > 0 && !t.is_transfer ? 'text-good' : ''}`}
              >
                {money(t.amount_minor, { showSign: true })}
              </span>
            </div>
          </button>
        ))}
      </div>

      {(adding || editing) && (
        <TxnDialog
          txn={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={invalidate}
          userId={userId}
        />
      )}
    </div>
  )
}

function TxnDialog({
  txn,
  onClose,
  onSaved,
  userId,
}: {
  txn: Transaction | null
  onClose: () => void
  onSaved: () => void
  userId: string
}) {
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const [form, setForm] = useState({
    account_id: txn?.account_id ?? '',
    date: txn?.date ?? todayIso(),
    description: txn?.description ?? '',
    merchant_name: txn?.merchant_name ?? '',
    category_id: txn?.category_id ?? null,
    amount_minor: txn?.amount_minor ?? null,
    direction: (txn?.amount_minor ?? -1) < 0 ? 'out' : 'in',
    is_transfer: txn?.is_transfer ?? false,
    is_reimbursable: txn?.is_reimbursable ?? false,
    exclude_from_budget: txn?.exclude_from_budget ?? false,
    exclude_from_analytics: txn?.exclude_from_analytics ?? false,
    notes: txn?.notes ?? '',
    tags: (txn?.tags ?? []).join(', '),
  })
  const [splits, setSplits] = useState<{ category_id: string | null; amount_minor: number | null }[]>(
    txn?.transaction_splits?.map((s) => ({ category_id: s.category_id, amount_minor: s.amount_minor })) ?? [],
  )
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const magnitude = Math.abs(form.amount_minor ?? 0)
      const amount = form.direction === 'out' ? -magnitude : magnitude
      const payload = {
        account_id: form.account_id,
        date: form.date,
        description: form.description || form.merchant_name || 'Manual entry',
        merchant_name: form.merchant_name || null,
        category_id: form.category_id,
        amount_minor: amount,
        is_transfer: form.is_transfer,
        is_reimbursable: form.is_reimbursable,
        exclude_from_budget: form.exclude_from_budget,
        exclude_from_analytics: form.exclude_from_analytics,
        notes: form.notes || null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        needs_review: false,
      }
      let id = txn?.id
      if (id) await updateTransaction(userId, id, payload)
      else id = (await createTransaction(userId, payload as Parameters<typeof createTransaction>[1] & typeof payload)).id
      const validSplits = splits.filter((s) => s.amount_minor !== null && s.amount_minor !== 0)
      if (txn || validSplits.length > 0) {
        await setTransactionSplits(
          userId,
          id!,
          validSplits.map((s) => ({ category_id: s.category_id, amount_minor: s.amount_minor! })),
        )
      }
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteTransaction(userId, txn!.id),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  if (!accounts || !categories) return null
  const targetAmount = form.direction === 'out' ? -Math.abs(form.amount_minor ?? 0) : Math.abs(form.amount_minor ?? 0)
  const splitSum = splits.reduce((a, s) => a + (s.amount_minor ?? 0), 0)

  return (
    <Dialog open onClose={onClose} title={txn ? 'Edit transaction' : 'Add transaction'} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Account</Label>
            <AccountSelect
              accounts={accounts}
              value={form.account_id || null}
              onChange={(v) => setForm({ ...form, account_id: v ?? '' })}
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div>
            <Label>Amount</Label>
            <div className="flex gap-2">
              <Select
                className="w-20"
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
              >
                <option value="out">Out</option>
                <option value="in">In</option>
              </Select>
              <MoneyInput
                valueMinor={form.amount_minor === null ? null : Math.abs(form.amount_minor)}
                onChangeMinor={(m) => setForm({ ...form, amount_minor: m })}
              />
            </div>
          </div>
          <div>
            <Label>Category</Label>
            <CategorySelect
              categories={categories}
              value={form.category_id}
              onChange={(v) => setForm({ ...form, category_id: v })}
            />
          </div>
          <div>
            <Label>Merchant</Label>
            <Input
              value={form.merchant_name}
              onChange={(e) => setForm({ ...form, merchant_name: e.target.value })}
              placeholder="e.g. Tesco"
            />
          </div>
          <div>
            <Label>Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Raw bank description"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div>
            <Label>Tags (comma separated)</Label>
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['Transfer between my accounts', 'is_transfer'],
              ['Reimbursable (work will pay back)', 'is_reimbursable'],
              ['Exclude from budget', 'exclude_from_budget'],
              ['Exclude from analytics', 'exclude_from_analytics'],
            ] as const
          ).map(([label, key]) => (
            <div key={key} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
              <span className="text-xs">{label}</span>
              <Switch
                checked={form[key] as boolean}
                onChange={(v) => setForm({ ...form, [key]: v })}
              />
            </div>
          ))}
        </div>

        {/* Splits */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold">Split transaction</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSplits([...splits, { category_id: null, amount_minor: null }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add part
            </Button>
          </div>
          {splits.length === 0 && (
            <p className="text-[11px] text-ink-faint">
              e.g. split a £100 Tesco shop into £75 groceries, £15 household, £10 alcohol. Parts
              must add up to the full amount.
            </p>
          )}
          {splits.map((s, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <div className="flex-1">
                <CategorySelect
                  categories={categories}
                  value={s.category_id}
                  onChange={(v) => setSplits(splits.map((x, j) => (j === i ? { ...x, category_id: v } : x)))}
                />
              </div>
              <div className="w-28">
                <MoneyInput
                  valueMinor={s.amount_minor === null ? null : Math.abs(s.amount_minor)}
                  onChangeMinor={(m) =>
                    setSplits(
                      splits.map((x, j) =>
                        j === i
                          ? { ...x, amount_minor: m === null ? null : form.direction === 'out' ? -Math.abs(m) : Math.abs(m) }
                          : x,
                      ),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSplits(splits.filter((_, j) => j !== i))}
              >
                ×
              </Button>
            </div>
          ))}
          {splits.length > 0 && splitSum !== targetAmount && (
            <p className="text-[11px] text-warn">
              Parts total {money(splitSum)} but the transaction is {money(targetAmount)}.
            </p>
          )}
        </div>

        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-between">
          {txn ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={() => remove.mutate()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={save.isPending || !form.account_id || form.amount_minor === null}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
