import { chartAxis, dateTooltipLabel, gridStroke, tooltipStyle } from '@/components/charts/theme'
import { PageHeader, Stat } from '@/components/shared/common'
import { Badge, Card, CardTitle, Spinner } from '@/components/ui/primitives'
import { fetchAccounts, fetchRecurring, fetchTransactions } from '@/lib/api'
import {
  expandRecurring,
  projectDailyBalances,
  safeToSpend,
  type ProjectedItem,
} from '@/lib/engine/cashflow'
import { categoryActuals } from '@/lib/engine/budget'
import { formatDateShort, money, monthStartIso, todayIso } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export default function CashflowPage() {
  const today = todayIso()
  const month = monthStartIso()
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'month', month],
    queryFn: () => fetchTransactions({ from: month, limit: 1000 }),
  })

  if (!accounts || !recurring || !txns) return <Spinner />

  const opening = accounts
    .filter((a) => a.include_in_cashflow && ['current', 'cash', 'wallet'].includes(a.account_type))
    .reduce((s, a) => s + a.balance_minor, 0)

  const horizon = 30
  const end = isoPlus(today, horizon)
  const items: ProjectedItem[] = recurring
    .filter((r) => r.status === 'active')
    .flatMap((r) =>
      expandRecurring(
        {
          name: r.name,
          amountMinor: r.amount_minor,
          frequency: r.frequency,
          nextDueDate: r.next_due_date,
          intervalDays: r.interval_days,
          source: r.needs_confirmation ? 'ai_estimated' : 'recurring',
        },
        today,
        end,
      ),
    )
  const projection = projectDailyBalances(opening, items, today, horizon)
  const sts = safeToSpend(opening, projection)

  // Month to date actuals
  const engineTxns = txns.map((t) => ({
    id: t.id,
    date: t.date,
    amountMinor: t.amount_minor,
    categoryId: t.category_id,
    isTransfer: t.is_transfer,
    excludeFromBudget: t.exclude_from_budget,
    isReimbursable: t.is_reimbursable,
  }))
  const actuals = categoryActuals(engineTxns)
  let income = 0
  let spend = 0
  for (const a of actuals.values()) {
    income += a.incomeMinor
    spend += a.spentMinor
  }
  const debtOut = txns.filter((t) => t.liability_id && t.amount_minor < 0).reduce((s, t) => s + -t.amount_minor, 0)
  const savingsOut = txns
    .filter((t) => t.is_transfer && t.amount_minor < 0)
    .reduce((s, t) => s + -t.amount_minor, 0)

  const chartData = projection.map((d) => ({
    date: d.date,
    balance: d.balanceMinor / 100,
  }))

  const heavyWeeks = findHeavyWeeks(items)

  return (
    <div className="space-y-4">
      <PageHeader title="Cashflow" sub="Confirmed transactions vs known recurring commitments over the next 30 days" />

      <Card>
        <CardTitle>This month so far</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Opening cash (today)" value={money(opening)} />
          <Stat label="Income" value={money(income)} />
          <Stat label="Spending" value={money(spend)} />
          <Stat label="Debt repayments" value={money(debtOut)} />
          <Stat label="Savings transfers" value={money(savingsOut)} />
        </div>
      </Card>

      <Card>
        <CardTitle>Projected daily balance — next 30 days</CardTitle>
        <p className="mb-2 text-xs text-ink-muted">
          {sts.negativeDays.length > 0 ? (
            <span className="text-bad">
              Projected balance falls below zero on {formatDateShort(sts.negativeDays[0])}
              {sts.negativeDays.length > 1 ? ` (and ${sts.negativeDays.length - 1} more days)` : ''}.
            </span>
          ) : (
            <span className="text-good">Projected balance stays positive for the next 30 days.</span>
          )}{' '}
          Lowest point: {money(sts.minProjectedBalanceMinor)}.
        </p>
        <div className="h-56">
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => formatDateShort(d)}
                tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }}
                stroke={gridStroke}
                interval={6}
              />
              <YAxis
                tickFormatter={(v: number) => `£${Math.round(v)}`}
                tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }}
                stroke={gridStroke}
                width={56}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: unknown) => [money(Math.round(Number(v ?? 0) * 100)), 'Projected balance']}
                labelFormatter={dateTooltipLabel}
              />
              <ReferenceLine y={0} stroke="var(--app-bad)" strokeDasharray="4 3" />
              <Line
                type="monotone"
                dataKey="balance"
                stroke="var(--app-accent)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {heavyWeeks.length > 0 && (
        <Card>
          <CardTitle>Pressure points</CardTitle>
          {heavyWeeks.map((w) => (
            <p key={w.start} className="text-sm text-ink-muted">
              Week of {formatDateShort(w.start)} has {money(w.totalMinor)} of committed outgoings —
              higher than your other weeks.
            </p>
          ))}
        </Card>
      )}

      <Card>
        <CardTitle>30-day calendar</CardTitle>
        <div className="space-y-1">
          {projection
            .filter((d) => d.items.length > 0)
            .map((d) => (
              <div key={d.date} className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
                <div>
                  <p className="tnum text-xs font-semibold text-ink-muted">{formatDateShort(d.date)}</p>
                  {d.items.map((item, i) => (
                    <p key={i} className="text-sm">
                      {item.name}
                      {item.source === 'ai_estimated' && (
                        <Badge tone="warn" className="ml-1.5">unconfirmed</Badge>
                      )}
                      <span className={`tnum ml-2 font-medium ${item.amountMinor > 0 ? 'text-good' : ''}`}>
                        {money(item.amountMinor, { showSign: true })}
                      </span>
                    </p>
                  ))}
                </div>
                <span className={`tnum shrink-0 text-sm font-semibold ${d.balanceMinor < 0 ? 'text-bad' : 'text-ink-muted'}`}>
                  {money(d.balanceMinor)}
                </span>
              </div>
            ))}
          {items.length === 0 && (
            <p className="text-xs text-ink-faint">
              No recurring commitments yet — confirm bills on the Bills page to build the forecast.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function findHeavyWeeks(items: ProjectedItem[]): { start: string; totalMinor: number }[] {
  const weeks = new Map<string, number>()
  for (const item of items) {
    if (item.amountMinor >= 0) continue
    const d = new Date(`${item.date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - d.getUTCDay())
    const key = d.toISOString().slice(0, 10)
    weeks.set(key, (weeks.get(key) ?? 0) + -item.amountMinor)
  }
  const entries = [...weeks.entries()]
  if (entries.length < 2) return []
  const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length
  return entries
    .filter(([, v]) => v > avg * 1.8)
    .map(([start, totalMinor]) => ({ start, totalMinor }))
    .sort((a, b) => a.start.localeCompare(b.start))
}
