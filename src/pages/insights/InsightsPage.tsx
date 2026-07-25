import { assignColors, chartAxis, gbpTooltip, gridStroke, isDarkMode, tooltipStyle } from '@/components/charts/theme'
import { PageHeader, categoryLabel } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, Select, Spinner } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  fetchAccounts,
  fetchCategories,
  fetchInsights,
  fetchLiabilities,
  fetchRecurring,
  fetchTransactions,
  setInsightStatus,
} from '@/lib/api'
import { generateInsights } from '@/lib/insights'
import { everydayBaseline, forecastMonthEnd } from '@/lib/engine/forecast'
import { expandRecurring } from '@/lib/engine/cashflow'
import { splitRegularSpend } from '@/lib/engine/regular'
import { daysInMonthOf, formatDate, money, todayIso } from '@/lib/format'
import type { Insight } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const RANGES = [
  { key: 'month', label: 'Current month', months: 0 },
  { key: 'prev', label: 'Previous month', months: -1 },
  { key: '3m', label: 'Last 3 months', months: 3 },
  { key: '6m', label: 'Last 6 months', months: 6 },
  { key: 'ytd', label: 'Year to date', months: 12 },
  { key: '12m', label: 'Last 12 months', months: 12 },
]

function rangeDates(key: string): { from: string; to: string } {
  const now = new Date()
  const to = todayIso()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  switch (key) {
    case 'month':
      return { from: start.toISOString().slice(0, 10), to }
    case 'prev': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const e = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) }
    }
    case '3m':
      return { from: new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10), to }
    case '6m':
      return { from: new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10), to }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to }
    default:
      return { from: new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString().slice(0, 10), to }
  }
}

export default function InsightsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const [range, setRange] = useState('ytd')
  const { from, to } = useMemo(() => rangeDates(range), [range])
  // Drill-down state lives in the URL so back button and sharing work:
  // ?cat=<parent id> shows the shops within a category,
  // ?cat=..&merchant=<name> shows one shop's months + transactions.
  const [searchParams, setSearchParams] = useSearchParams()
  const selCat = searchParams.get('cat')
  const selMerchant = searchParams.get('merchant')
  const drill = (patch: { cat?: string | null; merchant?: string | null }) => {
    const next = new URLSearchParams(searchParams)
    if (patch.cat !== undefined) {
      if (patch.cat === null) next.delete('cat')
      else next.set('cat', patch.cat)
    }
    if (patch.merchant !== undefined) {
      if (patch.merchant === null) next.delete('merchant')
      else next.set('merchant', patch.merchant)
    }
    setSearchParams(next)
  }

  const { data: insights, isLoading } = useQuery({ queryKey: ['insights'], queryFn: () => fetchInsights() })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'analytics', from, to],
    queryFn: () => fetchTransactions({ from, to, limit: 3000 }),
  })
  // Wide history for generation
  const historyFrom = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 6)
    return d.toISOString().slice(0, 10)
  }, [])
  const { data: historyTxns } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
  })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })

  const regen = useMutation({
    mutationFn: async () => {
      if (!historyTxns || !categories || !recurring) return 0
      const cashMinor = (accounts ?? [])
        .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type) && !a.archived_at)
        .reduce((s, a) => s + a.balance_minor, 0)
      return generateInsights(userId, historyTxns, categories, recurring, { cashMinor })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  })

  const feedback = useMutation({
    mutationFn: (p: { id: string; status: Insight['status']; fb?: 'dismissed' | 'muted_type' | 'useful' }) =>
      setInsightStatus(userId, p.id, p.status, p.fb),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  })

  // Roll every category up to its top-level parent so "Shopping" includes
  // Clothing, Alcohol etc. — the drill-down then breaks a parent apart.
  const parentOf = useMemo(() => {
    const tops = new Map<string, { id: string; name: string }>()
    for (const c of categories ?? []) if (!c.parent_id) tops.set(c.id, { id: c.id, name: c.name })
    const map = new Map<string, { id: string; name: string }>()
    for (const c of categories ?? []) {
      map.set(c.id, (c.parent_id ? tops.get(c.parent_id) : undefined) ?? { id: c.id, name: c.name })
    }
    return map
  }, [categories])
  const merchantLabel = (t: { merchant_name: string | null; description: string }) =>
    (t.merchant_name ?? t.description).trim()

  // Habitual spending vs one-offs across the selected range. A YTD total that
  // mixes weekly food shops with a one-off tattoo describes no actual month.
  const regularSplit = useMemo(() => {
    if (!txns) return null
    return splitRegularSpend(
      txns.map((t) => ({
        id: t.id,
        date: t.date,
        merchant: (t.merchant_name ?? t.description).trim(),
        amountMinor: t.amount_minor,
        categoryId: parentOf.get(t.category_id ?? '')?.id ?? t.category_id,
        isTransfer: t.is_transfer,
        excludeFromBudget: t.exclude_from_budget,
        isReimbursable: t.is_reimbursable,
        recurringPaymentId: t.recurring_payment_id,
      })),
    )
  }, [txns, parentOf])

  // Live forward view. Insights below are "something happened"; this is "where
  // the month is heading", recomputed on every render rather than stored.
  const outlook = useMemo(() => {
    if (!historyTxns || !accounts) return null
    const today = todayIso()
    const monthStart = `${today.slice(0, 7)}-01`
    const map = (t: (typeof historyTxns)[number]) => ({
      id: t.id,
      date: t.date,
      merchant: t.merchant_name ?? t.description,
      amountMinor: t.amount_minor,
      categoryId: t.category_id,
      isTransfer: t.is_transfer,
      excludeFromBudget: t.exclude_from_budget,
      isReimbursable: t.is_reimbursable,
      recurringPaymentId: t.recurring_payment_id,
      isOneOff: t.is_one_off,
    })
    const baseline = everydayBaseline(historyTxns.map(map), today)
    const cash = accounts
      .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type) && !a.archived_at)
      .reduce((s, a) => s + a.balance_minor, 0)
    const dim = daysInMonthOf(monthStart)
    const monthEnd = `${monthStart.slice(0, 8)}${String(dim).padStart(2, '0')}`
    const scheduled = (recurring ?? [])
      .filter((r) => r.status === 'active')
      .flatMap((r) =>
        expandRecurring(
          {
            name: r.name,
            amountMinor: r.amount_minor,
            frequency: r.frequency,
            nextDueDate: r.next_due_date,
            intervalDays: r.interval_days,
          },
          today,
          monthEnd,
        ),
      )
      .filter((i) => i.date > today)
    const forecast = forecastMonthEnd({
      today,
      currentBalanceMinor: cash,
      monthTxns: historyTxns.filter((t) => t.date >= monthStart).map(map),
      baseline,
      remainingScheduled: scheduled,
    })
    // Everyday spend this month per category, against its typical full month.
    const spentByCat = new Map<string | null, number>()
    for (const t of historyTxns) {
      if (t.date < monthStart) continue
      if (t.is_transfer || t.exclude_from_budget || t.is_reimbursable) continue
      if (t.recurring_payment_id || t.amount_minor >= 0 || t.is_one_off) continue
      const key = parentOf.get(t.category_id ?? '')?.id ?? t.category_id
      spentByCat.set(key, (spentByCat.get(key) ?? 0) + -t.amount_minor)
    }
    const typicalByCat = new Map<string | null, number>()
    for (const c of baseline.byCategory) {
      const key = parentOf.get(c.categoryId ?? '')?.id ?? c.categoryId
      typicalByCat.set(key, (typicalByCat.get(key) ?? 0) + c.perMonthMinor)
    }
    const categoryPace = [...typicalByCat.entries()]
      .map(([categoryId, typicalMinor]) => ({
        categoryId,
        typicalMinor,
        spentMinor: spentByCat.get(categoryId) ?? 0,
      }))
      .filter((c) => c.typicalMinor > 1000 || c.spentMinor > 1000)
      .sort((a, b) => b.typicalMinor - a.typicalMinor)
      .slice(0, 6)
    return { baseline, forecast, categoryPace, monthEnd }
  }, [historyTxns, accounts, recurring, parentOf])

  const analytics = useMemo(() => {
    const rows = (txns ?? []).filter(
      (t) => !t.is_transfer && !t.exclude_from_analytics && !t.is_reimbursable,
    )
    const spend = rows.filter((t) => t.amount_minor < 0)
    const byCat = new Map<string, number>()
    const roll = (id: string | null) => (id ? (parentOf.get(id)?.id ?? id) : 'none')
    for (const t of spend) {
      // Respect splits in analytics
      if (t.transaction_splits && t.transaction_splits.length > 0) {
        for (const s of t.transaction_splits) {
          if (s.amount_minor < 0) byCat.set(roll(s.category_id), (byCat.get(roll(s.category_id)) ?? 0) + -s.amount_minor)
        }
      } else {
        byCat.set(roll(t.category_id), (byCat.get(roll(t.category_id)) ?? 0) + -t.amount_minor)
      }
    }
    const byMerchant = new Map<string, number>()
    for (const t of spend) {
      const m = merchantLabel(t)
      byMerchant.set(m, (byMerchant.get(m) ?? 0) + -t.amount_minor)
    }
    const totalSpend = spend.reduce((s, t) => s + -t.amount_minor, 0)
    const totalIncome = rows.filter((t) => t.amount_minor > 0).reduce((s, t) => s + t.amount_minor, 0)
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1)
    return { spend, byCat, byMerchant, totalSpend, totalIncome, days, count: spend.length }
  }, [txns, from, to, parentOf])

  // Level 1: the shops inside the selected category
  const catMerchants = useMemo(() => {
    if (!selCat) return []
    const roll = (id: string | null) => (id ? (parentOf.get(id)?.id ?? id) : 'none')
    const groups = new Map<string, { name: string; count: number; totalMinor: number }>()
    for (const t of analytics.spend) {
      if (roll(t.category_id) !== selCat) continue
      const name = merchantLabel(t)
      const g = groups.get(name.toLowerCase()) ?? { name, count: 0, totalMinor: 0 }
      g.count++
      g.totalMinor += -t.amount_minor
      groups.set(name.toLowerCase(), g)
    }
    return [...groups.values()].sort((a, b) => b.totalMinor - a.totalMinor)
  }, [analytics.spend, selCat, parentOf])

  // Level 2: one shop — months + individual transactions
  const merchantDetail = useMemo(() => {
    if (!selMerchant) return null
    const roll = (id: string | null) => (id ? (parentOf.get(id)?.id ?? id) : 'none')
    const rows = analytics.spend.filter(
      (t) =>
        merchantLabel(t).toLowerCase() === selMerchant.toLowerCase() &&
        (!selCat || roll(t.category_id) === selCat),
    )
    const byMonth = new Map<string, number>()
    for (const t of rows) byMonth.set(t.date.slice(0, 7), (byMonth.get(t.date.slice(0, 7)) ?? 0) + -t.amount_minor)
    const monthly = [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({
        month: new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
        Spend: Math.round(v) / 100,
      }))
    const totalMinor = rows.reduce((s, t) => s + -t.amount_minor, 0)
    return { rows: rows.slice(0, 25), allCount: rows.length, monthly, totalMinor }
  }, [analytics.spend, selMerchant, selCat, parentOf])

  if (isLoading || !categories) return <Spinner />

  const dark = isDarkMode()
  const catData = [...analytics.byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, v]) => ({ id, name: categoryLabel(categories, id === 'none' ? null : id), value: v / 100 }))
  const restCat = [...analytics.byCat.entries()].sort((a, b) => b[1] - a[1]).slice(6)
  if (restCat.length > 0) {
    catData.push({ id: 'other', name: 'Other', value: restCat.reduce((s, [, v]) => s + v, 0) / 100 })
  }
  const catColors = assignColors(catData.map((d) => d.name), dark)
  const merchantData = [...analytics.byMerchant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, v]) => ({ name, value: v / 100 }))

  // Income vs spending per month (last 6 months, from wide history)
  const byMonth = new Map<string, { spend: number; income: number }>()
  for (const t of historyTxns ?? []) {
    if (t.is_transfer || t.exclude_from_analytics || t.is_reimbursable) continue
    const key = t.date.slice(0, 7)
    const entry = byMonth.get(key) ?? { spend: 0, income: 0 }
    if (t.amount_minor < 0) entry.spend += -t.amount_minor / 100
    else entry.income += t.amount_minor / 100
    byMonth.set(key, entry)
  }
  const monthlyData = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([k, v]) => ({
      month: new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' }),
      Spending: Math.round(v.spend),
      Income: Math.round(v.income),
    }))

  // Cumulative spending across the selected range
  const cumulative: { date: string; total: number }[] = []
  {
    let run = 0
    const spendTxns = (txns ?? [])
      .filter((t) => !t.is_transfer && !t.exclude_from_analytics && !t.is_reimbursable && t.amount_minor < 0)
      .sort((a, b) => a.date.localeCompare(b.date))
    for (const t of spendTxns) {
      run += -t.amount_minor / 100
      const last = cumulative[cumulative.length - 1]
      if (last && last.date === t.date) last.total = run
      else cumulative.push({ date: t.date, total: run })
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Insights & analytics"
        actions={
          <Button variant="outline" onClick={() => regen.mutate()} disabled={regen.isPending || !historyTxns}>
            <RefreshCw className={`h-4 w-4 ${regen.isPending ? 'animate-spin' : ''}`} />
            {regen.isPending ? 'Analysing…' : 'Refresh insights'}
          </Button>
        }
      />

      {/* Live forward view — recomputed each render, not a stored insight */}
      {outlook && outlook.forecast.basis !== 'none' && (
        <Card>
          <CardTitle>Where this month is heading</CardTitle>
          <p className="text-sm">
            {outlook.forecast.basis === 'baseline' ? (
              <>
                Across your last {outlook.baseline.monthsUsed} complete month
                {outlook.baseline.monthsUsed === 1 ? '' : 's'} you spend{' '}
                <strong>{money(outlook.baseline.perMonthMinor)}</strong> a month on everyday things
                (ranging {money(outlook.baseline.lowMinor)}–{money(outlook.baseline.highMinor)}).
              </>
            ) : (
              <>Working from this month's own pace — there's no complete month of history yet.</>
            )}{' '}
            With {outlook.forecast.daysRemaining} day
            {outlook.forecast.daysRemaining === 1 ? '' : 's'} left, you're on course to spend{' '}
            <strong>{money(outlook.forecast.forecastSpendMinor)}</strong> in total this month against{' '}
            {money(outlook.forecast.forecastIncomeMinor)} coming in.
          </p>
          <p
            className={`mt-2 text-sm font-medium ${
              outlook.forecast.forecastEndBalanceMinor < 0 ? 'text-bad' : 'text-good'
            }`}
          >
            {outlook.forecast.forecastEndBalanceMinor < 0
              ? `On this pace you're about ${money(Math.abs(outlook.forecast.forecastEndBalanceMinor))} short by ${formatDate(outlook.monthEnd)} — even before anything unexpected.`
              : `On this pace you end ${formatDate(outlook.monthEnd)} with about ${money(outlook.forecast.forecastEndBalanceMinor)}.`}
          </p>
          {outlook.categoryPace.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Everyday spend so far vs a typical month
              </p>
              {outlook.categoryPace.map((c) => {
                const pct =
                  c.typicalMinor > 0 ? Math.round((c.spentMinor / c.typicalMinor) * 100) : null
                const expectedByNow =
                  (c.typicalMinor * outlook.forecast.dayOfMonth) / outlook.forecast.daysInMonth
                const hot = c.spentMinor > expectedByNow * 1.25
                return (
                  <button
                    key={c.categoryId ?? 'none'}
                    type="button"
                    onClick={() => drill({ cat: c.categoryId ?? 'none', merchant: null })}
                    className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-app"
                  >
                    <span>{categoryLabel(categories ?? [], c.categoryId)}</span>
                    <span className="tnum text-ink-muted">
                      {money(c.spentMinor)} of {money(c.typicalMinor)} typical
                      {pct !== null && (
                        <span className={hot ? 'ml-1.5 text-warn' : 'ml-1.5 text-ink-faint'}>
                          {pct}%
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
              <p className="pt-1 text-[11px] text-ink-faint">
                Day {outlook.forecast.dayOfMonth} of {outlook.forecast.daysInMonth}, so roughly{' '}
                {Math.round((outlook.forecast.dayOfMonth / outlook.forecast.daysInMonth) * 100)}% of
                the month has passed. Bills are excluded — these are the categories you can actually
                move.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Insight feed */}
      {(insights ?? []).length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">Nothing material needs your attention right now.</p>
          {regen.isSuccess && regen.data === 0 && (
            <p className="mt-1 text-xs text-ink-faint">
              Analysis ran across your history — no significant patterns found.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {(insights ?? []).map((ins) => (
            <Card key={ins.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {ins.severity === 'warning' && <Badge tone="warn" className="mr-1.5">attention</Badge>}
                    {ins.headline}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">{ins.body}</p>
                  {ins.suggested_action && (
                    <p className="mt-1 text-xs text-accent">{ins.suggested_action}</p>
                  )}
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {ins.comparison_period ? `vs ${ins.comparison_period} · ` : ''}
                    confidence {ins.confidence} · {formatDate(ins.created_at.slice(0, 10))}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'dismissed', fb: 'dismissed' })}>
                  Dismiss
                </Button>
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'muted', fb: 'muted_type' })}>
                  Mute this type
                </Button>
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'actioned', fb: 'useful' })}>
                  Useful
                </Button>
                <Link to="/chat">
                  <Button size="sm" variant="ghost">Ask AI</Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Analytics */}
      <div className="flex items-center gap-2">
        <Select className="w-48" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
        <span className="text-xs text-ink-faint">
          {formatDate(from)} – {formatDate(to)}
        </span>
      </div>

      <Card>
        <CardTitle>Headline numbers</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Spend</p>
            <p className="tnum text-base font-semibold">{money(analytics.totalSpend)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Income</p>
            <p className="tnum text-base font-semibold">{money(analytics.totalIncome)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Avg per day</p>
            <p className="tnum text-base font-semibold">{money(Math.round(analytics.totalSpend / analytics.days))}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Avg per transaction</p>
            <p className="tnum text-base font-semibold">
              {money(analytics.count ? Math.round(analytics.totalSpend / analytics.count) : 0)}
            </p>
            <p className="text-[11px] text-ink-faint">{analytics.count} transactions</p>
          </div>
        </div>
      </Card>

      {regularSplit && regularSplit.regular.length > 0 && (
        <Card>
          <CardTitle>Running costs vs one-offs</CardTitle>
          <p className="mb-3 text-xs text-ink-muted">
            Shops you return to most months are a running cost you can plan around. Everything else
            — a tattoo, a sofa, a repair — is a one-off and shouldn't be averaged into a monthly
            figure. Bills are counted separately. Over {regularSplit.monthsInRange} month
            {regularSplit.monthsInRange === 1 ? '' : 's'}, a shop counts as regular once it appears
            in {regularSplit.threshold} or more of them.
          </p>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Running costs</p>
              <p className="tnum text-base font-semibold">{money(regularSplit.regularTotalMinor)}</p>
              <p className="text-[11px] text-ink-faint">
                {money(regularSplit.regularPerMonthMinor)} a month
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">One-offs</p>
              <p className="tnum text-base font-semibold">{money(regularSplit.adHocTotalMinor)}</p>
              <p className="text-[11px] text-ink-faint">{regularSplit.adHoc.length} separate items</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">Regular share</p>
              <p className="tnum text-base font-semibold">
                {regularSplit.regularTotalMinor + regularSplit.adHocTotalMinor > 0
                  ? Math.round(
                      (regularSplit.regularTotalMinor /
                        (regularSplit.regularTotalMinor + regularSplit.adHocTotalMinor)) *
                        100,
                    )
                  : 0}
                %
              </p>
              <p className="text-[11px] text-ink-faint">of everyday spending</p>
            </div>
          </div>

          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Running costs by category
          </p>
          <div className="space-y-1">
            {regularSplit.byCategory.slice(0, 8).map((c) => (
              <button
                key={c.categoryId ?? 'none'}
                type="button"
                onClick={() => drill({ cat: c.categoryId ?? 'none', merchant: null })}
                className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-app"
              >
                <span>
                  {categoryLabel(categories, c.categoryId)}
                  <span className="ml-1.5 text-ink-faint">
                    {c.merchants} shop{c.merchants === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="tnum text-ink-muted">
                  {money(c.perMonthMinor)}/mo · {money(c.regularMinor)} total
                  <ChevronRight className="ml-1 inline h-3 w-3 text-ink-faint" />
                </span>
              </button>
            ))}
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-faint">
              The {regularSplit.adHoc.length} one-offs, largest first
            </summary>
            <div className="mt-2 space-y-1">
              {regularSplit.adHoc.slice(0, 15).map((r) => (
                <button
                  key={r.merchant}
                  type="button"
                  onClick={() => drill({ cat: r.categoryId ?? 'none', merchant: r.merchant })}
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-app"
                >
                  <span className="truncate">
                    {r.merchant}
                    <span className="ml-1.5 text-ink-faint">
                      {formatDate(r.lastDate)}
                      {r.txnCount > 1 ? ` · ${r.txnCount} payments` : ''}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-ink-muted">{money(r.totalMinor)}</span>
                </button>
              ))}
              {regularSplit.adHoc.length > 15 && (
                <p className="px-1 pt-1 text-[11px] text-ink-faint">
                  Showing the 15 largest of {regularSplit.adHoc.length}.
                </p>
              )}
            </div>
          </details>
        </Card>
      )}

      {/* ------------------------------------------------ spending explorer */}
      {(selCat || selMerchant) && (
        <nav className="flex flex-wrap items-center gap-1 text-xs">
          <button className="text-accent hover:underline" onClick={() => drill({ cat: null, merchant: null })}>
            All spending
          </button>
          {selCat && (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                className={selMerchant ? 'text-accent hover:underline' : 'font-semibold'}
                onClick={() => drill({ merchant: null })}
              >
                {categoryLabel(categories, selCat === 'none' ? null : selCat)}
              </button>
            </>
          )}
          {selMerchant && (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <span className="font-semibold">{selMerchant}</span>
            </>
          )}
        </nav>
      )}

      {selMerchant && merchantDetail ? (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{selMerchant}</CardTitle>
            <p className="text-xs text-ink-muted">
              <span className="tnum font-semibold text-ink">{money(merchantDetail.totalMinor)}</span>
              {' '}across {merchantDetail.allCount} transaction{merchantDetail.allCount === 1 ? '' : 's'} in this range
            </p>
          </div>
          {merchantDetail.monthly.length > 0 && (
            <div className="mt-2 h-40">
              <ResponsiveContainer>
                <BarChart data={merchantDetail.monthly} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  <XAxis dataKey="month" tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} />
                  <YAxis tickFormatter={(v: number) => `£${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} width={44} />
                  <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} cursor={{ fill: 'color-mix(in srgb, var(--app-border) 40%, transparent)' }} />
                  <Bar dataKey="Spend" fill="var(--app-accent)" radius={[4, 4, 0, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 divide-y divide-border">
            {merchantDetail.rows.map((t) => (
              <div key={t.id} className="flex items-center justify-between py-1.5 text-xs">
                <span className="text-ink-muted">{formatDate(t.date)}</span>
                <span className="mx-2 flex-1 truncate">{t.description}</span>
                <span className="tnum font-medium">{money(-t.amount_minor)}</span>
              </div>
            ))}
          </div>
          <Link
            to={`/transactions?merchant=${encodeURIComponent(selMerchant)}&from=${from}&to=${to}`}
            className="mt-2 inline-block text-xs text-accent hover:underline"
          >
            Open in Transactions ›
          </Link>
        </Card>
      ) : selCat ? (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{categoryLabel(categories, selCat === 'none' ? null : selCat)} — by shop</CardTitle>
            <p className="text-xs text-ink-muted">
              <span className="tnum font-semibold text-ink">{money(analytics.byCat.get(selCat) ?? 0)}</span> in this range
            </p>
          </div>
          {catMerchants.length === 0 ? (
            <p className="text-xs text-ink-faint">No spending here in this range.</p>
          ) : (
            <div className="mt-1 divide-y divide-border">
              {catMerchants.map((m) => (
                <button
                  key={m.name}
                  onClick={() => drill({ merchant: m.name })}
                  className="flex w-full items-center justify-between py-2 text-left text-sm hover:text-accent"
                >
                  <span className="truncate">
                    {m.name}
                    <span className="ml-2 text-[11px] text-ink-faint">×{m.count}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="tnum text-ink-muted">{money(m.totalMinor)}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
                  </span>
                </button>
              ))}
            </div>
          )}
          {selCat !== 'none' && (
            <Link
              to={`/transactions?category=${selCat}&from=${from}&to=${to}`}
              className="mt-2 inline-block text-xs text-accent hover:underline"
            >
              Open in Transactions ›
            </Link>
          )}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardTitle>Spending by category</CardTitle>
            {catData.length === 0 ? (
              <p className="text-xs text-ink-faint">No spending in this range.</p>
            ) : (
              <>
                <p className="mb-1 text-xs text-ink-muted">
                  Tap a category to see which shops it went to.
                </p>
                <div className="h-44">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={catData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2} stroke="var(--app-surface)" strokeWidth={2}>
                        {catData.map((d) => (
                          <Cell
                            key={d.name}
                            fill={catColors.get(d.name)}
                            cursor={d.id !== 'other' ? 'pointer' : undefined}
                            onClick={() => d.id !== 'other' && drill({ cat: d.id })}
                          />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 space-y-0.5">
                  {catData.map((d) => (
                    <button
                      key={d.name}
                      onClick={() => d.id !== 'other' && drill({ cat: d.id })}
                      className="flex w-full items-center justify-between text-left text-xs hover:text-accent"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: catColors.get(d.name) }} />
                        {d.name}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="tnum text-ink-muted">{money(Math.round(d.value * 100))}</span>
                        {d.id !== 'other' && <ChevronRight className="h-3 w-3 text-ink-faint" />}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card>
            <CardTitle>Top shops</CardTitle>
            {merchantData.length === 0 ? (
              <p className="text-xs text-ink-faint">No spending in this range.</p>
            ) : (
              <div className="mt-1 divide-y divide-border">
                {merchantData.map((m) => (
                  <button
                    key={m.name}
                    onClick={() => drill({ merchant: m.name })}
                    className="flex w-full items-center justify-between py-1.5 text-left text-sm hover:text-accent"
                  >
                    <span className="truncate">{m.name}</span>
                    <span className="flex items-center gap-1">
                      <span className="tnum text-ink-muted">{money(Math.round(m.value * 100))}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Income vs spending — last 6 months</CardTitle>
          {monthlyData.length === 0 ? (
            <p className="text-xs text-ink-faint">Import some transactions to see the trend.</p>
          ) : (
            <>
              <div className="h-52">
                <ResponsiveContainer>
                  <BarChart data={monthlyData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }} barGap={2}>
                    <XAxis dataKey="month" tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} />
                    <YAxis tickFormatter={(v: number) => `£${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} width={48} />
                    <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} cursor={{ fill: 'color-mix(in srgb, var(--app-border) 40%, transparent)' }} />
                    <Bar dataKey="Income" fill="var(--app-good)" radius={[4, 4, 0, 0]} barSize={14} />
                    <Bar dataKey="Spending" fill="var(--app-accent)" radius={[4, 4, 0, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 flex gap-3 text-[11px] text-ink-muted">
                <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-good" />Income</span>
                <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />Spending</span>
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardTitle>Cumulative spending — selected range</CardTitle>
          {cumulative.length < 2 ? (
            <p className="text-xs text-ink-faint">Not enough spending in this range yet.</p>
          ) : (
            <>
              <p className="mb-1 text-xs text-ink-muted">
                Running total reaches {money(Math.round(cumulative[cumulative.length - 1].total * 100))}
              </p>
              <div className="h-52">
                <ResponsiveContainer>
                  <LineChart data={cumulative} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                    <XAxis dataKey="date" tickFormatter={(d: string) => formatDate(d).slice(0, 6)} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} interval="preserveStartEnd" />
                    <YAxis tickFormatter={(v: number) => `£${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} width={48} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => [money(Math.round(Number(v ?? 0) * 100)), 'Spent so far']} />
                    <Line type="monotone" dataKey="total" stroke="var(--app-accent)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
