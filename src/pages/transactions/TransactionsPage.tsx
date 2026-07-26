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
  fetchProjects,
  fetchTransactions,
  learnMerchant,
  setTransactionSplits,
  updateTransaction,
  type TxnFilters,
} from '@/lib/api'
import { resolveCategoryId, suggestFromDescription } from '@/lib/autoCategorise'
import { dedupeHash, findSavedDuplicateGroups } from '@/lib/engine/duplicates'
import { normaliseDescription } from '@/lib/engine/recurring'
import { supabase } from '@/lib/supabase'
import { formatDate, money, todayIso } from '@/lib/format'
import type { Transaction } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/** Payment services that hide the real merchant: the money went THROUGH them,
 * not TO them, so the merchant field deserves reassigning. */
function isProcessor(merchant: string | null, description: string): boolean {
  const hay = `${merchant ?? ''} ${description}`.toUpperCase()
  return /PAYPAL|SUMUP|ZETTLE|SQ \*|CASH WITHDRAWAL|LINK ATM/.test(hay)
}

function titleCaseKey(s: string): string {
  return s.toLowerCase().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ------------------------------------------------------- date range presets
const PRESETS = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'prev', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'prevq', label: 'Last quarter' },
  { key: 'ytd', label: 'Year to date' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All time' },
] as const

function presetRange(key: string): { from?: string; to?: string } {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = iso(now)
  switch (key) {
    case 'week': {
      const d = new Date(now)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // back to Monday
      return { from: iso(d), to: today }
    }
    case 'month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'prev':
      return {
        from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      }
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3
      return { from: iso(new Date(now.getFullYear(), q, 1)), to: today }
    }
    case 'prevq': {
      const q = Math.floor(now.getMonth() / 3) * 3
      return {
        from: iso(new Date(now.getFullYear(), q - 3, 1)),
        to: iso(new Date(now.getFullYear(), q, 0)),
      }
    }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to: today }
    case '12m':
      return { from: iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())), to: today }
    default:
      return { from: undefined, to: undefined }
  }
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
    projectId: params.get('project') ?? undefined,
  })
  // Default to current-month stats. Links that bring their own scope (a date
  // range, the uncategorised/duplicates views, a batch) keep it instead.
  const defaultPresetFor = (f: TxnFilters & { duplicatesOnly?: boolean }): string =>
    f.from || f.to
      ? 'custom'
      : f.uncategorised || f.duplicatesOnly || f.importBatchId || f.projectId
        ? 'all'
        : 'month'
  const [preset, setPreset] = useState<string>(() => defaultPresetFor(filtersFromParams()))
  const [filters, setFilters] = useState<TxnFilters & { duplicatesOnly?: boolean }>(() => {
    const f = filtersFromParams()
    return defaultPresetFor(f) === 'month' ? { ...f, ...presetRange('month') } : f
  })
  // Keep filters in sync when arriving via a link (e.g. from Data Quality)
  useEffect(() => {
    const f = filtersFromParams()
    const p = defaultPresetFor(f)
    setPreset(p)
    setFilters(p === 'month' ? { ...f, ...presetRange('month') } : f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  const pickPreset = (key: string) => {
    setPreset(key)
    setFilters({ ...filters, ...presetRange(key) })
  }
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const projectName = (id: string | null) => projects?.find((p) => p.id === id)?.name
  const effective = useMemo(
    () => ({
      ...filters,
      duplicatesOnly: undefined,
      search: search || undefined,
      limit: 3000, // header totals must cover the whole selected range
    }),
    [filters, search],
  )
  const { data: rawTxns, isLoading } = useQuery({
    queryKey: ['transactions', effective],
    queryFn: () => fetchTransactions(effective),
  })
  // Duplicates view: likely-duplicate groups in the ledger. Rows whose
  // running balances all differ are genuinely separate transactions and are
  // not shown; user-dismissed pairs (dedupe_ignored) are skipped too.
  const txns = useMemo(() => {
    if (!rawTxns) return rawTxns
    if (!filters.duplicatesOnly) return rawTxns
    return findSavedDuplicateGroups(rawTxns).flat()
  }, [rawTxns, filters.duplicatesOnly])

  // "These are both real" — dismiss a whole matching group from the
  // duplicates view (and the Data Quality count) without deleting anything.
  const dismissDuplicateGroup = useMutation({
    mutationFn: async (t: Transaction) => {
      const hash = dedupeHash({ accountId: t.account_id, date: t.date, amountMinor: t.amount_minor, description: t.description })
      const ids = (rawTxns ?? [])
        .filter(
          (x) =>
            dedupeHash({ accountId: x.account_id, date: x.date, amountMinor: x.amount_minor, description: x.description }) === hash,
        )
        .map((x) => x.id)
      const { error } = await supabase.from('transactions').update({ dedupe_ignored: true }).in('id', ids)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => invalidate(),
  })

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
        sub={`${
          PRESETS.find((p) => p.key === preset)?.label ??
          (filters.from || filters.to ? `${filters.from ?? '…'} → ${filters.to ?? 'today'}` : 'All time')
        } · ${totals.count} transactions · out ${money(totals.out)} · in ${money(totals.inn)}`}
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

      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => pickPreset(p.key)}
            className={`flex-1 whitespace-nowrap rounded-full px-3 py-1.5 text-center text-xs font-medium transition-colors ${
              preset === p.key
                ? 'grad-accent text-white'
                : 'border border-border bg-surface text-ink-muted hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

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
              onChange={(e) => {
                setPreset('custom')
                setFilters({ ...filters, from: e.target.value || undefined })
              }}
            />
          </div>
          <div>
            <Label>To</Label>
            <Input
              type="date"
              value={filters.to ?? ''}
              onChange={(e) => {
                setPreset('custom')
                setFilters({ ...filters, to: e.target.value || undefined })
              }}
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
          description). Open one and delete it if it's a genuine duplicate — or use “Keep both”
          if they're really separate payments.
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
              {filters.duplicatesOnly && (
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:border-accent hover:text-accent"
                  onClick={(e) => {
                    e.stopPropagation()
                    dismissDuplicateGroup.mutate(t)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      dismissDuplicateGroup.mutate(t)
                    }
                  }}
                >
                  Keep both — not duplicates
                </span>
              )}
              {t.is_transfer && <Badge>transfer</Badge>}
              {t.project_id && projectName(t.project_id) && (
                <Badge tone="accent">{projectName(t.project_id)}</Badge>
              )}
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
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
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
    project_id: txn?.project_id ?? null,
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
        project_id: form.project_id,
        // Project spend is one-off by definition — it must not feed the
        // "typical month" baseline. Clearing the project leaves the flag as-is.
        ...(form.project_id && !txn?.project_id ? { is_one_off: true } : {}),
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
            <Label>
              {isProcessor(txn?.merchant_name ?? null, txn?.description ?? '')
                ? 'Who was it actually to?'
                : 'Merchant'}
            </Label>
            <Input
              value={form.merchant_name}
              onChange={(e) => setForm({ ...form, merchant_name: e.target.value })}
              placeholder="e.g. Tesco"
            />
            {isProcessor(txn?.merchant_name ?? null, txn?.description ?? '') && (
              <p className="mt-1 text-[11px] text-ink-faint">
                Paid via {txn?.merchant_name ?? 'a payment service'} — that's the till, not the shop.
                Put the real merchant here and what it was for in the notes; the original description
                is kept, so searching "{(txn?.merchant_name ?? '').split(' ')[0] || 'PayPal'}" still
                finds it.
              </p>
            )}
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
          {(projects ?? []).filter((p) => p.status === 'active' || p.id === form.project_id).length > 0 && (
            <div>
              <Label>Project</Label>
              <Select
                value={form.project_id ?? ''}
                onChange={(e) => setForm({ ...form, project_id: e.target.value || null })}
              >
                <option value="">None</option>
                {(projects ?? [])
                  .filter((p) => p.status === 'active' || p.id === form.project_id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </div>
          )}
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
