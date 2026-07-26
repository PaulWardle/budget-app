import { AccountSelect, CategorySelect, MoneyInput, PageHeader } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  CardTitle,
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
  dismissRecurring,
  fetchAccounts,
  fetchCategories,
  fetchDismissedRecurring,
  fetchRecurring,
  fetchTransactions,
  restoreRecurring,
  syncBillPrices,
  upsertRecurring,
} from '@/lib/api'
import { detectRecurring, type RecurringCandidate } from '@/lib/engine/recurring'
import { formatDate, money } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import type { Frequency, RecurringPayment } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

const FREQ_LABELS: Record<Frequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  four_weekly: 'Every 4 weeks',
  quarterly: 'Quarterly',
  six_monthly: 'Every 6 months',
  annual: 'Annual',
  custom: 'Custom',
}

export default function BillsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: recurring, isLoading } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  // 8 months of history for detection
  const historyFrom = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 8)
    return d.toISOString().slice(0, 10)
  }, [])
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
  })
  const { data: dismissed } = useQuery({
    queryKey: ['dismissed-recurring'],
    queryFn: fetchDismissedRecurring,
  })
  const [editing, setEditing] = useState<Partial<RecurringPayment> | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['recurring'] })
  const invalidateDismissed = () => qc.invalidateQueries({ queryKey: ['dismissed-recurring'] })

  // Learn real prices from the ledger once a day on arrival — a bill whose
  // bank charge has settled at a new amount updates itself and shows in the
  // price-changes card below. Fire-and-forget; never blocks the page.
  useEffect(() => {
    const key = 'bill-price-sync'
    const today = new Date().toISOString().slice(0, 10)
    if (localStorage.getItem(key) === today) return
    localStorage.setItem(key, today)
    void syncBillPrices(userId)
      .then((n) => {
        if (n > 0) invalidate()
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const candidates = useMemo(() => {
    if (!txns || !recurring) return []
    const known = new Set(
      recurring.map((r) => r.name.toUpperCase()).concat(recurring.map((r) => (r.notes ?? '').toUpperCase())),
    )
    const rejected = new Set((dismissed ?? []).map((d) => d.match_key))
    return detectRecurring(
      txns
        .filter((t) => !t.is_transfer && !t.recurring_payment_id)
        .map((t) => ({ date: t.date, amountMinor: t.amount_minor, description: t.description })),
    ).filter((c) => !known.has(c.key) && !rejected.has(c.key) && c.confidence >= 0.55)
  }, [txns, recurring, dismissed])

  const confirmCandidate = useMutation({
    mutationFn: (c: RecurringCandidate) =>
      upsertRecurring(userId, {
        name: titleCase(c.key),
        kind: 'bill',
        amount_minor: c.averageAmountMinor,
        frequency: c.frequency,
        next_due_date: c.nextExpectedDate,
        source: 'detected',
        confidence: c.confidence,
        needs_confirmation: false,
        notes: c.key,
      }),
    onSuccess: invalidate,
  })

  const dismissCandidate = useMutation({
    mutationFn: (c: RecurringCandidate) => dismissRecurring(userId, c.key, titleCase(c.key)),
    onSuccess: invalidateDismissed,
  })

  const restoreCandidate = useMutation({
    mutationFn: (id: string) => restoreRecurring(id),
    onSuccess: invalidateDismissed,
  })

  if (isLoading || !accounts || !categories) return <Spinner />

  const active = (recurring ?? []).filter((r) => r.status === 'active')
  const inactive = (recurring ?? []).filter((r) => r.status !== 'active')
  const priceRises = active.filter((r) => {
    const h = r.price_history
    return h.length >= 2 && Math.abs(h[h.length - 1].amount_minor) > Math.abs(h[h.length - 2].amount_minor)
  })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bills & subscriptions"
        sub={`${active.length} active · ${money(monthlyTotal(active))} per month equivalent`}
        actions={
          <Button onClick={() => setEditing({})}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        }
      />

      {active.length > 0 && (
        <Card>
          <CardTitle>Commitments</CardTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['Bills', active.filter((r) => r.kind === 'bill' && r.amount_minor < 0)],
                ['Debts', active.filter((r) => r.kind === 'debt_payment' && r.amount_minor < 0)],
                ['Subscriptions', active.filter((r) => r.kind === 'subscription' && r.amount_minor < 0)],
              ] as const
            ).map(([label, items]) => (
              <div key={label}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</p>
                <p className="tnum text-base font-semibold">{money(monthlyTotal([...items]))}<span className="text-xs font-normal text-ink-faint">/mo</span></p>
                <p className="text-[11px] text-ink-faint">
                  {items.length} item{items.length === 1 ? '' : 's'} · {money(monthlyTotal([...items]) * 12)}/yr
                </p>
              </div>
            ))}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Could be cut</p>
              <p className="tnum text-base font-semibold text-accent">
                {money(monthlyTotal(active.filter((r) => !r.is_essential && r.amount_minor < 0)))}
                <span className="text-xs font-normal text-ink-faint">/mo</span>
              </p>
              <p className="text-[11px] text-ink-faint">
                {money(monthlyTotal(active.filter((r) => !r.is_essential && r.amount_minor < 0)) * 12)}/yr if
                everything non-essential went
              </p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            "Could be cut" counts anything not marked essential — open a bill to change its essential
            flag. Things you value stay essential; this is the honest floor, not a demand to cut.
          </p>
        </Card>
      )}

      {priceRises.length > 0 && (
        <Card>
          <CardTitle>Price changes</CardTitle>
          {priceRises.map((r) => {
            const h = r.price_history
            return (
              <p key={r.id} className="text-sm text-warn">
                {r.name} appears to have increased from {money(Math.abs(h[h.length - 2].amount_minor))} to{' '}
                {money(Math.abs(h[h.length - 1].amount_minor))}.
              </p>
            )
          })}
        </Card>
      )}

      {candidates.length > 0 && (
        <Card>
          <CardTitle>Detected recurring payments — confirm to add</CardTitle>
          <div className="space-y-2">
            {candidates.slice(0, 6).map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{titleCase(c.key)}</p>
                  <p className="text-[11px] text-ink-faint">
                    {FREQ_LABELS[c.frequency]} · ~{money(Math.abs(c.averageAmountMinor))} ·{' '}
                    {c.occurrences} payments seen · next expected {formatDate(c.nextExpectedDate)}
                    {c.priceIncreased && ' · price increased'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => confirmCandidate.mutate(c)}>
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-ink-faint"
                    onClick={() => dismissCandidate.mutate(c)}
                  >
                    Not a bill
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            Dismissing keeps the transactions — it only stops this being suggested as a recurring
            payment.
          </p>
        </Card>
      )}

      {(dismissed ?? []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-faint">
            {dismissed!.length} dismissed as not a bill
          </summary>
          <div className="mt-2 space-y-1.5">
            {dismissed!.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 px-1">
                <span className="truncate text-sm text-ink-muted">{d.label}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => restoreCandidate.mutate(d.id)}
                >
                  Suggest again
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}

      {active.length === 0 && candidates.length === 0 && (
        <EmptyState
          title="No bills or subscriptions yet"
          hint="Import transactions and likely recurring payments will be detected automatically, or add one manually."
        />
      )}

      <div className="space-y-2">
        {active.map((r) => (
          <Card
            key={r.id}
            className="flex cursor-pointer items-center justify-between gap-3 py-3 hover:border-accent/50"
            onClick={() => setEditing(r)}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {r.name}
                {r.kind === 'subscription' && <Badge className="ml-1.5">subscription</Badge>}
                {r.kind === 'income' && <Badge tone="good" className="ml-1.5">income</Badge>}
                {!r.is_essential && r.amount_minor < 0 && <Badge tone="accent" className="ml-1.5">discretionary</Badge>}
                {r.needs_confirmation && <Badge tone="warn" className="ml-1.5">unconfirmed</Badge>}
              </p>
              <p className="text-[11px] text-ink-faint">
                {FREQ_LABELS[r.frequency]} · next {formatDate(r.next_due_date)}
                {r.contract_end_date ? ` · contract ends ${formatDate(r.contract_end_date)}` : ''}
              </p>
            </div>
            <span className={`tnum shrink-0 text-sm font-semibold ${r.amount_minor > 0 ? 'text-good' : ''}`}>
              {money(r.amount_minor, { showSign: true })}
            </span>
          </Card>
        ))}
      </div>

      {inactive.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-faint">
            {inactive.length} paused or cancelled
          </summary>
          <div className="mt-2 space-y-2">
            {inactive.map((r) => (
              <Card key={r.id} className="flex items-center justify-between py-3 opacity-60" onClick={() => setEditing(r)}>
                <span className="text-sm">{r.name}</span>
                <Badge>{r.status}</Badge>
              </Card>
            ))}
          </div>
        </details>
      )}

      {editing && (
        <BillDialog
          bill={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate()
            setEditing(null)
          }}
          userId={userId}
        />
      )}
    </div>
  )
}

function BillDialog({
  bill,
  onClose,
  onSaved,
  userId,
}: {
  bill: Partial<RecurringPayment>
  onClose: () => void
  onSaved: () => void
  userId: string
}) {
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const [form, setForm] = useState({
    name: bill.name ?? '',
    kind: bill.kind ?? 'bill',
    amount_minor: bill.amount_minor ?? null,
    direction: (bill.amount_minor ?? -1) < 0 ? 'out' : 'in',
    frequency: bill.frequency ?? 'monthly',
    next_due_date: bill.next_due_date ?? new Date().toISOString().slice(0, 10),
    category_id: bill.category_id ?? null,
    account_id: bill.account_id ?? null,
    contract_end_date: bill.contract_end_date ?? '',
    renewal_date: bill.renewal_date ?? '',
    is_essential: bill.is_essential ?? true,
    status: bill.status ?? 'active',
    notes: bill.notes ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const magnitude = Math.abs(form.amount_minor ?? 0)
      const amount = form.direction === 'out' ? -magnitude : magnitude
      // Track price history when amount changes on an existing bill
      let priceHistory = bill.price_history ?? []
      if (bill.id && bill.amount_minor !== undefined && bill.amount_minor !== amount) {
        priceHistory = [
          ...priceHistory,
          { date: new Date().toISOString().slice(0, 10), amount_minor: amount },
        ]
      }
      await upsertRecurring(
        userId,
        {
          name: form.name,
          kind: form.kind as RecurringPayment['kind'],
          amount_minor: amount,
          frequency: form.frequency as Frequency,
          next_due_date: form.next_due_date,
          category_id: form.category_id,
          account_id: form.account_id,
          contract_end_date: form.contract_end_date || null,
          renewal_date: form.renewal_date || null,
          is_essential: form.is_essential,
          status: form.status as RecurringPayment['status'],
          needs_confirmation: false,
          notes: form.notes || null,
          price_history: priceHistory,
        },
        bill.id,
      )
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  })

  const remove = useMutation({
    mutationFn: async () => {
      await supabase.from('recurring_payments').delete().eq('id', bill.id!)
    },
    onSuccess: onSaved,
  })

  if (!accounts || !categories) return null
  return (
    <Dialog open onClose={onClose} title={bill.id ? 'Edit bill' : 'Add bill or subscription'} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Name</Label>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as RecurringPayment['kind'] })}>
              <option value="bill">Bill</option>
              <option value="subscription">Subscription</option>
              <option value="income">Expected income</option>
              <option value="debt_payment">Debt payment</option>
              <option value="savings">Savings transfer</option>
              <option value="transfer">Transfer</option>
            </Select>
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
            <Label>Frequency</Label>
            <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>
              {Object.entries(FREQ_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Next expected date</Label>
            <Input
              type="date"
              required
              value={form.next_due_date}
              onChange={(e) => setForm({ ...form, next_due_date: e.target.value })}
            />
          </div>
          <div>
            <Label>Category</Label>
            <CategorySelect categories={categories} value={form.category_id} onChange={(v) => setForm({ ...form, category_id: v })} />
          </div>
          <div>
            <Label>Account</Label>
            <AccountSelect accounts={accounts} value={form.account_id} onChange={(v) => setForm({ ...form, account_id: v })} allowNone />
          </div>
          <div>
            <Label>Contract end date</Label>
            <Input
              type="date"
              value={form.contract_end_date ?? ''}
              onChange={(e) => setForm({ ...form, contract_end_date: e.target.value })}
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as RecurringPayment['status'] })}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-xs">Essential (not discretionary)</span>
          <Switch checked={form.is_essential} onChange={(v) => setForm({ ...form, is_essential: v })} />
        </div>
        {form.status === 'cancelled' && (
          <p className="text-[11px] text-ink-faint">
            Marked cancelled — if a matching payment appears later you'll get an insight flagging it.
          </p>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-between">
          {bill.id ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={() => remove.mutate()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={save.isPending || form.amount_minor === null}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function monthlyTotal(items: RecurringPayment[]): number {
  const perMonth: Record<Frequency, number> = {
    weekly: 52 / 12,
    fortnightly: 26 / 12,
    monthly: 1,
    four_weekly: 13 / 12,
    quarterly: 1 / 3,
    six_monthly: 1 / 6,
    annual: 1 / 12,
    custom: 1,
  }
  return Math.round(
    items
      .filter((i) => i.amount_minor < 0)
      .reduce((s, i) => s + Math.abs(i.amount_minor) * perMonth[i.frequency], 0),
  )
}
