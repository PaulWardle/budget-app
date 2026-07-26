import { PageHeader, StalenessNote, Stat, categoryLabel } from '@/components/shared/common'
import { assignColors, gbpTooltip, isDarkMode, tooltipStyle } from '@/components/charts/theme'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Badge, Card, CardTitle, ProgressBar, Spinner } from '@/components/ui/primitives'
import {
  buildNetWorthItems,
  fetchAccounts,
  fetchBudget,
  fetchCategories,
  fetchInsights,
  fetchLiabilities,
  fetchProfile,
  fetchRecurring,
  fetchTransactions,
} from '@/lib/api'
import { payPeriodFor, previousPayPeriods } from '@/lib/engine/payperiod'
import { categoryActuals, budgetSummary, lineStatuses } from '@/lib/engine/budget'
import { expandRecurring, projectDailyBalances, safeToSpend, type ProjectedItem } from '@/lib/engine/cashflow'
import { computeNetWorth } from '@/lib/engine/networth'
import { formatDateShort, formatDateTime, money, todayIso } from '@/lib/format'
import { DrillDown, type DrillRow } from '@/components/shared/drilldown'
import { everydayBaseline, forecastMonthEnd } from '@/lib/engine/forecast'
import { LIQUID_ACCOUNT_TYPES } from '@/types/domain'
import { generateInsights } from '@/lib/insights'
import { useUserId } from '@/context/AuthContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

type Drill = {
  title: string
  rows: DrillRow[]
  note?: string
  linkTo?: string
  linkLabel?: string
  emptyHint?: string
}

export default function HomePage() {
  const userId = useUserId()
  const today = todayIso()
  const [drill, setDrill] = useState<Drill | null>(null)
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile })
  // Everything below runs payday-to-payday: the "month" is the current pay
  // period (payday rolls back to Friday when it lands on a weekend), so
  // "what's left" means left until the next payday, not until the 31st.
  const paydayDay = (profile?.payday_day as number | null) ?? null
  const period = payPeriodFor(today, paydayDay)
  const month = period.start
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'period', month],
    queryFn: () => fetchTransactions({ from: month, limit: 1000 }),
  })
  const { data: budget } = useQuery({
    queryKey: ['budget', period.budgetMonth],
    queryFn: () => fetchBudget(period.budgetMonth),
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: insights } = useQuery({ queryKey: ['insights'], queryFn: () => fetchInsights() })
  // Four months back so the spending baseline has three complete months.
  const historyFrom = isoMonthsAgo(4)
  const { data: history } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
  })
  const { data: uncategorised } = useQuery({
    queryKey: ['transactions', 'uncategorised-count'],
    queryFn: () => fetchTransactions({ uncategorised: true, limit: 1000 }),
  })

  // Proactive insights: generate once a day on arrival rather than waiting
  // for a manual refresh. Fire-and-forget — a failure here never blocks Home.
  const qc = useQueryClient()
  useEffect(() => {
    if (!history || !categories || !recurring || !accounts) return
    const key = 'insights-auto-run'
    const today = todayIso()
    if (localStorage.getItem(key) === today) return
    localStorage.setItem(key, today)
    const cashMinor = accounts
      .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type) && !a.archived_at)
      .reduce((s, a) => s + a.balance_minor, 0)
    void generateInsights(userId, history, categories, recurring, {
      cashMinor,
      currentAccountIds: accounts.filter((a) => a.account_type === 'current').map((a) => a.id),
    })
      .then((n) => {
        if (n > 0) void qc.invalidateQueries({ queryKey: ['insights'] })
      })
      .catch(() => {})
  }, [history, categories, recurring, accounts, userId, qc])

  if (!accounts || !liabilities || !txns || !categories || !recurring || profile === undefined) {
    return (
      <div className="flex justify-center pt-20">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  // ---- Financial position (deterministic engine) ----
  const nw = computeNetWorth(buildNetWorthItems(accounts, liabilities))
  const cash = accounts
    .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type) && !a.archived_at)
    .reduce((s, a) => s + a.balance_minor, 0)
  const savings = accounts
    .filter((a) => a.account_type === 'savings')
    .reduce((s, a) => s + a.balance_minor, 0)
  const lastUpdated = accounts.reduce<string | null>(
    (max, a) => (max === null || a.balance_updated_at > max ? a.balance_updated_at : max),
    null,
  )

  // ---- Monthly position ----
  const engineTxns = txns.map((t) => ({
    id: t.id,
    date: t.date,
    amountMinor: t.amount_minor,
    categoryId: t.category_id,
    isTransfer: t.is_transfer,
    excludeFromBudget: t.exclude_from_budget,
    isReimbursable: t.is_reimbursable,
    splits: t.transaction_splits?.map((s) => ({ categoryId: s.category_id, amountMinor: s.amount_minor })),
  }))
  const actuals = categoryActuals(engineTxns)
  let incomeReceived = 0
  let spendingToDate = 0
  for (const a of actuals.values()) {
    incomeReceived += a.incomeMinor
    spendingToDate += a.spentMinor
  }
  const dayOfMonth = Math.max(1, Math.round((Date.parse(today) - Date.parse(period.start)) / 86_400_000) + 1)
  const daysInMonth = period.days

  // The exact rows the figures above were summed from — same exclusions as the
  // engine (transfers, budget-excluded and reimbursable rows are left out), and
  // splits contribute per split. Drill-downs read from this so the totals in a
  // breakdown always reconcile with the headline that opened it.
  const contributions = txns.flatMap((t) => {
    if (t.is_transfer || t.exclude_from_budget || t.is_reimbursable) return []
    const splits = t.transaction_splits ?? []
    const base = {
      date: t.date,
      label: t.merchant_name ?? t.description,
      description: t.description,
      recurringId: t.recurring_payment_id,
    }
    if (splits.length > 0) {
      return splits.map((s, i) => ({
        ...base,
        id: `${t.id}:${i}`,
        categoryId: s.category_id,
        amountMinor: s.amount_minor,
      }))
    }
    return [{ ...base, id: t.id, categoryId: t.category_id, amountMinor: t.amount_minor }]
  })

  const toRows = (list: typeof contributions): DrillRow[] =>
    [...list]
      .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor))
      .map((c) => ({
        id: c.id,
        date: c.date,
        label: c.label,
        sub: categoryLabel(categories, c.categoryId),
        amountMinor: c.amountMinor,
      }))

  const monthRange = `from=${month}&to=${today}`

  const lines = budget
    ? lineStatuses(
        budget.budget_lines.map((l) => ({
          categoryId: l.category_id,
          kind: l.kind,
          plannedMinor: l.planned_minor,
          rolloverFromMinor: l.rollover_from_minor,
        })),
        actuals,
        dayOfMonth,
        daysInMonth,
      )
    : []
  const summary = budget ? budgetSummary(budget.expected_income_minor, lines, actuals) : null
  const atRisk = lines.filter((l) => l.status !== 'on_track')

  // Spending-by-category donut (current month)
  const dark = isDarkMode()
  const donutSource = [...actuals.values()]
    .filter((a) => a.spentMinor > 0)
    .sort((a, b) => b.spentMinor - a.spentMinor)
  const donutTop = donutSource.slice(0, 5).map((a) => ({
    name: categoryLabel(categories, a.categoryId),
    value: a.spentMinor / 100,
    categoryIds: [a.categoryId],
  }))
  const donutRest = donutSource.slice(5)
  if (donutRest.length > 0) {
    donutTop.push({
      name: 'Other',
      value: donutRest.reduce((s2, a) => s2 + a.spentMinor, 0) / 100,
      categoryIds: donutRest.map((a) => a.categoryId),
    })
  }
  const donutColors = assignColors(donutTop.map((d) => d.name), dark)

  // ---- Upcoming commitments (30 days, extended to the period end so a long
  // pay period never truncates "bills still due before payday") ----
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  const to30 = in30.toISOString().slice(0, 10)
  const to = to30 > period.end ? to30 : period.end
  const active = recurring.filter((r) => r.status === 'active')
  const upcoming: ProjectedItem[] = active
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
        to,
      ),
    )
    .sort((a, b) => a.date.localeCompare(b.date))

  const projection = projectDailyBalances(cash, upcoming, today, 30)
  const sts = safeToSpend(cash, projection)

  // Behaviour-based forecast: bills alone never explain where a month lands.
  const toForecastTxn = (t: (typeof txns)[number]) => ({
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
  // Baseline measured over the last three complete pay periods, so "typical"
  // means typical between paydays.
  const baseline = everydayBaseline(
    (history ?? []).map(toForecastTxn),
    today,
    3,
    previousPayPeriods(today, paydayDay, 3),
  )
  const monthEndIso = period.end
  const forecast = forecastMonthEnd({
    today,
    currentBalanceMinor: cash,
    monthTxns: txns.map(toForecastTxn),
    baseline,
    remainingScheduled: upcoming.filter((u) => u.date > today && u.date <= monthEndIso),
    period,
  })

  const billsPaid = txns.filter((t) => t.recurring_payment_id && t.amount_minor < 0)
  const dueThisMonth = upcoming.filter((u) => u.date <= period.end && u.amountMinor < 0)

  const liquidNote = accounts.filter(
    (a) => LIQUID_ACCOUNT_TYPES.includes(a.account_type) && !a.archived_at,
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="Home"
        sub={lastUpdated ? `Position last updated: ${formatDateTime(lastUpdated)}` : 'Add accounts to begin'}
      />
      <StalenessNote accounts={liquidNote} />

      {/* Last period's review, surfaced while the new period is fresh */}
      {dayOfMonth <= 10 && (
        <Link to="/review" className="block">
          <Card className="border-accent/40 transition-colors hover:bg-surface-2">
            <p className="text-sm font-medium">
              Your {paydayDay ? 'last pay period' : 'last month'} review is ready →
            </p>
            <p className="text-[11px] text-ink-muted">
              What went where, everyday spend vs typical, overdraft days and the biggest changes.
            </p>
          </Card>
        </Link>
      )}

      {/* Position */}
      <Card>
        <CardTitle>Financial position</CardTitle>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat
            large
            label="Cash"
            value={money(cash)}
            onClick={() =>
              setDrill({
                title: 'Cash',
                rows: accounts
                  .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type) && !a.archived_at)
                  .map((a) => ({
                    id: a.id,
                    label: a.name,
                    sub: `${a.account_type} · updated ${formatDateShort(a.balance_updated_at.slice(0, 10))}`,
                    amountMinor: a.balance_minor,
                  })),
                note: 'Balances come from the latest running balance on each account’s imported statements, or whatever you set manually in Wealth.',
                emptyHint: 'No current, cash or wallet accounts yet.',
              })
            }
          />
          <Stat
            large
            label="Savings"
            value={money(savings)}
            onClick={() =>
              setDrill({
                title: 'Savings',
                rows: accounts
                  .filter((a) => a.account_type === 'savings')
                  .map((a) => ({
                    id: a.id,
                    label: a.name,
                    sub: `updated ${formatDateShort(a.balance_updated_at.slice(0, 10))}`,
                    amountMinor: a.balance_minor,
                  })),
                emptyHint: 'No savings accounts yet.',
              })
            }
          />
          <Stat
            large
            label="Net worth"
            value={money(nw.netWorthMinor)}
            tone={nw.netWorthMinor >= 0 ? undefined : 'bad'}
            sub={
              <Link to="/wealth" className="text-accent hover:underline">
                assets {money(nw.assetsMinor, { compact: true })} · debts{' '}
                {money(nw.liabilitiesMinor, { compact: true })}
              </Link>
            }
          />
          <Stat
            large
            label="Safe to spend"
            value={money(Math.max(0, sts.availableMinor))}
            tone={sts.availableMinor <= 0 ? 'warn' : 'good'}
            sub={
              sts.nextPaydayDate
                ? `before income on ${formatDateShort(sts.nextPaydayDate)}`
                : 'next 30 days of commitments covered'
            }
            onClick={() =>
              setDrill({
                title: 'Safe to spend',
                rows: [
                  { id: 'cash', label: 'Cash available now', amountMinor: cash },
                  ...upcoming.map((u, i) => ({
                    id: `u${i}`,
                    date: u.date,
                    label: u.name,
                    sub: 'known commitment',
                    amountMinor: u.amountMinor,
                  })),
                ],
                note: `Cash today, less every known commitment ${
                  sts.nextPaydayDate ? `before your next income on ${formatDateShort(sts.nextPaydayDate)}` : 'in the next 30 days'
                }. Commitments come from your bills — anything not set up as a bill isn’t counted here.`,
                linkTo: '/cashflow',
                linkLabel: 'See the full projection in Cashflow',
              })
            }
          />
        </div>
        {sts.negativeDays.length > 0 && (
          <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
            Projected balance goes negative on {formatDateShort(sts.negativeDays[0])} based on known
            commitments. See <Link to="/cashflow" className="underline">Cashflow</Link>.
          </p>
        )}
      </Card>

      {/* Pay-period position */}
      <Card>
        <CardTitle>
          {paydayDay ? `This pay period (${period.label}) · day ${dayOfMonth} of ${daysInMonth}` : `This month · day ${dayOfMonth} of ${daysInMonth}`}
        </CardTitle>
        {paydayDay && (
          <p className="-mt-1 mb-2 text-[11px] text-ink-faint">
            Runs payday to payday — next payday {formatDateShort(period.nextPayday)}.
          </p>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat
            label="Income received"
            value={money(incomeReceived)}
            onClick={() =>
              setDrill({
                title: 'Income received this period',
                rows: toRows(contributions.filter((c) => c.amountMinor > 0)),
                note: `Money in since ${formatDateShort(period.start)}. Transfers between your own accounts, reimbursable items and anything excluded from budgeting are left out.`,
                linkTo: `/transactions?${monthRange}`,
                emptyHint: 'No income recorded this period yet.',
              })
            }
          />
          <Stat
            label="Spending to date"
            value={money(spendingToDate)}
            onClick={() =>
              setDrill({
                title: 'Spending this period',
                rows: toRows(contributions.filter((c) => c.amountMinor < 0)),
                note: 'Largest first. Transfers between your own accounts, reimbursable items and anything excluded from budgeting are left out.',
                linkTo: `/transactions?${monthRange}`,
                emptyHint: 'No spending recorded this period yet.',
              })
            }
          />
          <Stat
            label="Bills paid"
            value={`${billsPaid.length}`}
            sub={money(billsPaid.reduce((s, t) => s + -t.amount_minor, 0))}
            onClick={() =>
              setDrill({
                title: 'Bills paid this period',
                rows: billsPaid.map((t) => ({
                  id: t.id,
                  date: t.date,
                  label: t.merchant_name ?? t.description,
                  sub: categoryLabel(categories, t.category_id),
                  amountMinor: t.amount_minor,
                })),
                note: 'Transactions this period that matched one of your bills.',
                linkTo: '/bills',
                linkLabel: 'Manage bills',
                emptyHint: 'No bills matched yet. Set them up on the Bills page and they’ll tick off automatically.',
              })
            }
          />
          <Stat
            label="Bills still due"
            value={`${dueThisMonth.length}`}
            sub={money(dueThisMonth.reduce((s, u) => s + -u.amountMinor, 0))}
            onClick={() =>
              setDrill({
                title: 'Bills still due before payday',
                rows: dueThisMonth.map((u, i) => ({
                  id: `d${i}`,
                  date: u.date,
                  label: u.name,
                  amountMinor: u.amountMinor,
                })),
                note: `Expected from your bill schedule between today and ${formatDateShort(period.end)} (the day before payday).`,
                linkTo: '/bills',
                linkLabel: 'Manage bills',
                emptyHint: 'Nothing else expected before your next payday.',
              })
            }
          />
          {summary && (
            <>
              <Stat
                label="Budget remaining"
                value={money(summary.remainingMinor)}
                tone={summary.remainingMinor < 0 ? 'bad' : undefined}
              />
              <Stat
                label={paydayDay ? 'Forecast spend by payday' : 'Forecast month-end spend'}
                value={money(summary.forecastSpendMinor)}
                sub="run-rate + committed bills"
                tone={summary.forecastSpendMinor > summary.plannedSpendMinor ? 'warn' : undefined}
              />
            </>
          )}
        </div>
        {summary && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-ink-faint">
              <span>
                {money(summary.actualSpendMinor)} of {money(summary.plannedSpendMinor)} budget used
              </span>
              <span>{Math.round((summary.actualSpendMinor / Math.max(1, summary.plannedSpendMinor)) * 100)}%</span>
            </div>
            <ProgressBar
              value={(summary.actualSpendMinor / Math.max(1, summary.plannedSpendMinor)) * 100}
              tone={
                summary.actualSpendMinor > summary.plannedSpendMinor
                  ? 'bad'
                  : summary.forecastSpendMinor > summary.plannedSpendMinor
                    ? 'warn'
                    : 'good'
              }
            />
          </div>
        )}
        {forecast.basis !== 'none' && (
          <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2.5">
            <p className="text-sm">
              Tracking to spend <strong>{money(forecast.forecastSpendMinor)}</strong> this{' '}
              {paydayDay ? 'pay period' : 'month'}
              {forecast.basis === 'baseline'
                ? ` — you typically spend ${money(baseline.perMonthMinor)} on everyday things between paydays, plus your bills.`
                : ' based on the pace so far.'}
            </p>
            <p
              className={`mt-1 text-sm font-medium ${
                forecast.forecastEndBalanceMinor < 0 ? 'text-bad' : 'text-ink-muted'
              }`}
            >
              {forecast.forecastEndBalanceMinor < 0
                ? `That puts you about ${money(Math.abs(forecast.forecastEndBalanceMinor))} short before payday on ${formatDateShort(period.nextPayday)}.`
                : `Leaves about ${money(forecast.forecastEndBalanceMinor)} when payday arrives on ${formatDateShort(period.nextPayday)}.`}{' '}
              <Link to="/cashflow" className="text-accent hover:underline">
                See the projection
              </Link>
            </p>
          </div>
        )}
        {!budget && (
          <p className="mt-3 text-xs text-ink-faint">
            No budget for this {paydayDay ? 'pay period' : 'month'} yet.{' '}
            <Link to="/budget" className="text-accent hover:underline">
              Create one
            </Link>
            .
          </p>
        )}
      </Card>

      {/* Data quality — numbers are only as good as the rows behind them */}
      {((uncategorised ?? []).length > 0 || txns.some((t) => t.needs_review)) && (
        <Card>
          <CardTitle>Tidy-ups</CardTitle>
          <div className="space-y-1.5 text-sm">
            {(uncategorised ?? []).length > 0 && (
              <p>
                <Link to="/transactions?uncategorised=1" className="text-accent hover:underline">
                  {(uncategorised ?? []).length} transaction{(uncategorised ?? []).length === 1 ? '' : 's'} without a category
                </Link>
                <span className="text-ink-muted">
                  {' '}— totals and forecasts treat them as a blind spot until they're filed.
                </span>
              </p>
            )}
            {txns.some((t) => t.needs_review) && (
              <p>
                <Link to="/transactions" className="text-accent hover:underline">
                  {txns.filter((t) => t.needs_review).length} recent item
                  {txns.filter((t) => t.needs_review).length === 1 ? '' : 's'} flagged for review
                </Link>
                <span className="text-ink-muted"> — low-confidence imports and proposed classifications.</span>
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Categories at risk */}
      {atRisk.length > 0 && categories && (
        <Card>
          <CardTitle>Categories needing attention</CardTitle>
          <div className="space-y-2">
            {atRisk.slice(0, 5).map((l) => {
              const cat = categories.find((c) => c.id === l.categoryId)
              return (
                <div key={l.categoryId ?? 'none'} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{cat?.name ?? 'Uncategorised'}</span>
                  <div className="flex items-center gap-2">
                    <span className="tnum text-xs text-ink-muted">
                      {money(l.actualMinor)} / {money(l.plannedMinor)}
                    </span>
                    <Badge tone={l.status === 'over' ? 'bad' : 'warn'}>
                      {l.status === 'over' ? 'over budget' : 'at risk'}
                    </Badge>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Spending donut */}
      {donutTop.length > 0 && (
        <Card>
          <CardTitle>Spending by category this {paydayDay ? 'pay period' : 'month'}</CardTitle>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <div className="h-44 w-44 shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={donutTop} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2} stroke="var(--app-surface)" strokeWidth={2}>
                    {donutTop.map((d) => (
                      <Cell key={d.name} fill={donutColors.get(d.name)} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="w-full flex-1 space-y-1">
              {donutTop.map((d) => (
                <button
                  key={d.name}
                  type="button"
                  onClick={() =>
                    setDrill({
                      title: d.name,
                      rows: toRows(
                        contributions.filter(
                          (c) => c.amountMinor < 0 && d.categoryIds.includes(c.categoryId),
                        ),
                      ),
                      note:
                        d.name === 'Other'
                          ? 'Every category outside the top five this month.'
                          : 'Everything filed under this category this month.',
                      linkTo:
                        d.categoryIds.length === 1 && d.categoryIds[0]
                          ? `/transactions?category=${d.categoryIds[0]}&${monthRange}`
                          : `/transactions?${monthRange}`,
                    })
                  }
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-app"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: donutColors.get(d.name) }} />
                    {d.name}
                  </span>
                  <span className="tnum text-ink-muted">
                    {money(Math.round(d.value * 100))}
                    <span aria-hidden className="ml-1 text-ink-faint/70">›</span>
                  </span>
                </button>
              ))}
              <p className="pt-1 text-[11px] text-ink-faint">
                Largest: {donutTop[0].name} at {money(Math.round(donutTop[0].value * 100))} of {money(spendingToDate)} total
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Upcoming */}
      <Card>
        <CardTitle>Next 14 days</CardTitle>
        {upcoming.filter((u) => u.date <= isoPlus(today, 14)).length === 0 ? (
          <p className="text-xs text-ink-faint">No known commitments in the next 14 days.</p>
        ) : (
          <div className="space-y-1.5">
            {upcoming
              .filter((u) => u.date <= isoPlus(today, 14))
              .slice(0, 8)
              .map((u, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-ink-muted">
                    <span className="tnum mr-2 text-xs text-ink-faint">{formatDateShort(u.date)}</span>
                    {u.name}
                  </span>
                  <span className={`tnum font-medium ${u.amountMinor > 0 ? 'text-good' : ''}`}>
                    {money(u.amountMinor, { showSign: true })}
                  </span>
                </div>
              ))}
          </div>
        )}
      </Card>

      {/* Insights */}
      <Card>
        <CardTitle>Insights</CardTitle>
        {!insights || insights.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing material needs your attention right now.</p>
        ) : (
          <div className="space-y-2.5">
            {insights.slice(0, 4).map((ins) => (
              <Link key={ins.id} to="/insights" className="block">
                <p className="text-sm font-medium">{ins.headline}</p>
                <p className="text-xs text-ink-muted">{ins.body.slice(0, 140)}</p>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <DrillDown
        open={drill !== null}
        onClose={() => setDrill(null)}
        title={drill?.title ?? ''}
        rows={drill?.rows ?? []}
        note={drill?.note}
        linkTo={drill?.linkTo}
        linkLabel={drill?.linkLabel}
        emptyHint={drill?.emptyHint}
      />
    </div>
  )
}

function isoMonthsAgo(months: number): string {
  const d = new Date()
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - months, 1)).toISOString().slice(0, 10)
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
