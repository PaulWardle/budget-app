import { chartAxis, dateTooltipLabel, gridStroke, tooltipStyle } from '@/components/charts/theme'
import { PageHeader, Stat } from '@/components/shared/common'
import { Badge, Card, CardTitle, Spinner } from '@/components/ui/primitives'
import { BaselineInspector } from '@/components/shared/BaselineInspector'
import { fetchAccounts, fetchCategories, fetchRecurring, fetchTransactions } from '@/lib/api'
import type { Transaction } from '@/types/domain'
import {
  expandRecurring,
  projectDailyBalances,
  safeToSpend,
  type ProjectedItem,
} from '@/lib/engine/cashflow'
import { categoryActuals } from '@/lib/engine/budget'
import { everydayBaseline, forecastMonthEnd, typicalSpendItems } from '@/lib/engine/forecast'
import { analyseOverdraft } from '@/lib/engine/overdraft'
import { daysInMonthOf, formatDateShort, money, monthStartIso, todayIso } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
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
  const [includeTypical, setIncludeTypical] = useState(true)
  const [inspecting, setInspecting] = useState(false)
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'month', month],
    queryFn: () => fetchTransactions({ from: month, limit: 1000 }),
  })
  // Four months back so the baseline has three complete months to measure.
  const historyFrom = isoMonthsAgo(4)
  const { data: history } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
  })

  if (!accounts || !recurring || !txns || !history || !categories) return <Spinner />

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
  // What everyday spending has actually been, projected forward. Without this
  // the line only falls on bill dates and reads far healthier than reality.
  const baseline = everydayBaseline(history.map(toForecastTxn), today)
  // Already-excluded one-offs, so they can be put back from the same place.
  const excludedOneOffs = history
    .filter((t) => t.is_one_off && t.amount_minor < 0 && !t.is_transfer)
    .map(toForecastTxn)
    .sort((a, b) => a.amountMinor - b.amountMinor)
  const typical = includeTypical ? typicalSpendItems(baseline.perDayMinor, today, horizon) : []
  const allItems = [...items, ...typical]

  const projection = projectDailyBalances(opening, allItems, today, horizon)
  const sts = safeToSpend(opening, projection)

  // Overdraft pattern for the busiest current account (running balances are
  // per-account, so a merged series would be meaningless).
  const currentAccounts = accounts.filter((a) => a.account_type === 'current' && !a.archived_at)
  const odAccount = currentAccounts
    .map((a) => ({ a, n: history.filter((t) => t.account_id === a.id && t.running_balance_minor !== null).length }))
    .sort((x, y) => y.n - x.n)[0]
  const overdraft =
    odAccount && odAccount.n > 0
      ? analyseOverdraft(
          history
            .filter((t) => t.account_id === odAccount.a.id)
            .map((t) => ({
              date: t.date,
              amountMinor: t.amount_minor,
              runningBalanceMinor: t.running_balance_minor,
              description: t.description,
            })),
          today,
        )
      : null

  const monthEnd = `${month.slice(0, 8)}${String(daysInMonthOf(month)).padStart(2, '0')}`
  const forecast = forecastMonthEnd({
    today,
    currentBalanceMinor: opening,
    monthTxns: txns.map(toForecastTxn),
    baseline,
    remainingScheduled: items.filter((i) => i.date > today && i.date <= monthEnd),
  })

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
      <PageHeader
        title="Cashflow"
        sub="Where the month lands, based on your bills and how you actually spend"
      />

      <Card>
        <CardTitle>Where this month is heading</CardTitle>
        {forecast.basis === 'none' ? (
          <p className="text-sm text-ink-muted">
            Not enough history yet to project everyday spending. Import a couple of months of
            statements and this becomes a real forecast.
          </p>
        ) : (
          <>
            <p className="text-sm">
              {forecast.basis === 'baseline' ? (
                <>
                  On your last {baseline.monthsUsed} month{baseline.monthsUsed === 1 ? '' : 's'} you
                  typically spend <strong>{money(baseline.perMonthMinor)}</strong> a month on
                  everyday things — roughly {money(baseline.perDayMinor)} a day.
                </>
              ) : (
                <>
                  Working from this month's own pace of {money(Math.round(forecast.everydaySpentMinor / Math.max(1, forecast.dayOfMonth)))} a
                  day, since there's no complete month of history yet.
                </>
              )}{' '}
              With {forecast.daysRemaining} day{forecast.daysRemaining === 1 ? '' : 's'} left and{' '}
              {money(forecast.billsRemainingMinor)} of bills still due, you're tracking to spend{' '}
              <strong>{money(forecast.forecastSpendMinor)}</strong> this month.
            </p>
            <p
              className={`mt-2 text-sm font-medium ${
                forecast.forecastEndBalanceMinor < 0 ? 'text-bad' : 'text-ink'
              }`}
            >
              {forecast.forecastEndBalanceMinor < 0 ? (
                <>
                  That leaves you about {money(forecast.forecastEndBalanceMinor)} at month end —{' '}
                  {money(Math.abs(forecast.forecastEndBalanceMinor))} short.
                </>
              ) : (
                <>That leaves about {money(forecast.forecastEndBalanceMinor)} at month end.</>
              )}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Everyday so far" value={money(forecast.everydaySpentMinor)} />
              <Stat label="Everyday still expected" value={money(forecast.everydayRemainingMinor)} />
              <Stat label="Bills paid" value={money(forecast.billsPaidMinor)} />
              <Stat label="Bills still due" value={money(forecast.billsRemainingMinor)} />
            </div>
            {forecast.basis === 'baseline' && (
              <p className="mt-3 text-[11px] text-ink-faint">
                Everyday spend excludes your bills, transfers and anything marked reimbursable.
                Measured across {baseline.months.map((m) => money(m.totalMinor)).join(', ')} — the
                middle month is used, so one unusual month doesn't skew it.{' '}
                <button
                  type="button"
                  onClick={() => setInspecting(true)}
                  className="text-accent underline hover:no-underline"
                >
                  See the {baseline.contributors.length} transactions behind this
                </button>
                {excludedOneOffs.length > 0 && (
                  <> · {excludedOneOffs.length} already marked one-off and left out</>
                )}
                .
                {forecast.paceRatio >= 1.25 && (
                  <span className="text-warn">
                    {' '}
                    You're running about {Math.round((forecast.paceRatio - 1) * 100)}% above that
                    pace so far this month.
                  </span>
                )}
                {forecast.paceRatio <= 0.75 && (
                  <span className="text-good">
                    {' '}
                    You're running about {Math.round((1 - forecast.paceRatio) * 100)}% below that
                    pace so far this month.
                  </span>
                )}
              </p>
            )}
          </>
        )}
      </Card>

      {overdraft && overdraft.currentMonth && (
        <Card>
          <CardTitle>Overdraft</CardTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Days above £0 this month"
              value={`${overdraft.currentMonth.daysAboveZero} of ${overdraft.currentMonth.daysTracked}`}
              tone={overdraft.currentMonth.daysOverdrawn === 0 ? 'good' : 'warn'}
              sub="the number to grow"
            />
            <Stat
              label="Deepest this month"
              value={money(overdraft.currentMonth.deepestMinor)}
              tone={overdraft.currentMonth.deepestMinor < 0 ? 'bad' : 'good'}
            />
            <Stat
              label="Interest this month"
              value={money(overdraft.currentMonth.interestMinor)}
              sub={`${money(overdraft.totalInterestMinor)} over ${overdraft.months.length} months`}
            />
            <Stat
              label="Lump payments absorbed"
              value={money(overdraft.totalAbsorbedMinor)}
              tone={overdraft.totalAbsorbedMinor > 0 ? 'warn' : undefined}
              sub="swallowed refilling a negative balance"
            />
          </div>
          {overdraft.lumps.filter((l) => l.absorbedMinor > 0).length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Where big incoming payments went
              </p>
              {overdraft.lumps.map((l, i) => (
                <div key={i} className="flex items-center justify-between py-0.5 text-xs">
                  <span className="text-ink-muted">
                    <span className="tnum mr-2 text-ink-faint">{formatDateShort(l.date)}</span>
                    {money(l.amountMinor)} in
                  </span>
                  <span className={`tnum ${l.absorbedMinor > 0 ? 'text-warn' : 'text-good'}`}>
                    {l.absorbedMinor > 0
                      ? `${money(l.absorbedMinor)} refilled the overdraft`
                      : 'landed above £0'}
                  </span>
                </div>
              ))}
              <p className="mt-1.5 text-[11px] text-ink-faint">
                Money that arrives while the balance is negative clears the hole before it can fund
                anything else. Keeping the account above £0 is what frees these payments for the
                things they were meant for.
              </p>
            </div>
          )}
        </Card>
      )}

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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="mb-0">Projected daily balance — next 30 days</CardTitle>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={includeTypical}
              onChange={(e) => setIncludeTypical(e.target.checked)}
              className="accent-[var(--app-accent)]"
            />
            Include typical everyday spending
          </label>
        </div>
        <p className="mb-2 text-xs text-ink-muted">
          {sts.negativeDays.length > 0 ? (
            <span className="text-bad">
              Projected balance falls below zero on {formatDateShort(sts.negativeDays[0])}
              {sts.negativeDays.length > 1 ? ` (and ${sts.negativeDays.length - 1} more days)` : ''}.
            </span>
          ) : (
            <span className="text-good">Projected balance stays positive for the next 30 days.</span>
          )}{' '}
          Lowest point: {money(sts.minProjectedBalanceMinor)}.{' '}
          {includeTypical && baseline.perDayMinor > 0 ? (
            <>Includes {money(baseline.perDayMinor)}/day of everyday spending on top of your bills.</>
          ) : (
            <>Bills only — everyday spending is not counted.</>
          )}
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
            .map((d) => ({ ...d, dated: d.items.filter((i) => i.source !== 'typical') }))
            .filter((d) => d.dated.length > 0)
            .map((d) => (
              <div key={d.date} className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
                <div>
                  <p className="tnum text-xs font-semibold text-ink-muted">{formatDateShort(d.date)}</p>
                  {d.dated.map((item, i) => (
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

      <BaselineInspector
        open={inspecting}
        onClose={() => setInspecting(false)}
        contributors={baseline.contributors}
        excluded={excludedOneOffs}
        categories={categories}
        perMonthMinor={baseline.perMonthMinor}
        monthsUsed={baseline.monthsUsed}
      />
    </div>
  )
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function toForecastTxn(t: Transaction) {
  return {
    id: t.id,
    date: t.date,
    amountMinor: t.amount_minor,
    categoryId: t.category_id,
    merchant: t.merchant_name ?? t.description,
    isTransfer: t.is_transfer,
    excludeFromBudget: t.exclude_from_budget,
    isReimbursable: t.is_reimbursable,
    recurringPaymentId: t.recurring_payment_id,
    isOneOff: t.is_one_off,
  }
}

function isoMonthsAgo(months: number): string {
  const d = new Date()
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - months, 1)).toISOString().slice(0, 10)
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
