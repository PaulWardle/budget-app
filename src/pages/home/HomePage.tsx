import { PageHeader, StalenessNote, Stat } from '@/components/shared/common'
import { Badge, Card, CardTitle, ProgressBar, Spinner } from '@/components/ui/primitives'
import {
  buildNetWorthItems,
  fetchAccounts,
  fetchBudget,
  fetchCategories,
  fetchInsights,
  fetchLiabilities,
  fetchRecurring,
  fetchTransactions,
} from '@/lib/api'
import { categoryActuals, budgetSummary, lineStatuses } from '@/lib/engine/budget'
import { expandRecurring, projectDailyBalances, safeToSpend, type ProjectedItem } from '@/lib/engine/cashflow'
import { computeNetWorth } from '@/lib/engine/networth'
import { daysInMonthOf, formatDateShort, formatDateTime, money, monthStartIso, todayIso } from '@/lib/format'
import { LIQUID_ACCOUNT_TYPES } from '@/types/domain'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

export default function HomePage() {
  const month = monthStartIso()
  const today = todayIso()
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'month', month],
    queryFn: () => fetchTransactions({ from: month, limit: 1000 }),
  })
  const { data: budget } = useQuery({ queryKey: ['budget', month], queryFn: () => fetchBudget(month) })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: insights } = useQuery({ queryKey: ['insights'], queryFn: () => fetchInsights() })

  if (!accounts || !liabilities || !txns || !categories || !recurring) {
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
  const dayOfMonth = Number(today.slice(8, 10))
  const daysInMonth = daysInMonthOf(month)

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

  // ---- Upcoming commitments (30 days) ----
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  const to = in30.toISOString().slice(0, 10)
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

  const billsPaid = txns.filter((t) => t.recurring_payment_id && t.amount_minor < 0)
  const dueThisMonth = upcoming.filter((u) => u.date <= `${month.slice(0, 8)}${String(daysInMonth).padStart(2, '0')}` && u.amountMinor < 0)

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

      {/* Position */}
      <Card>
        <CardTitle>Financial position</CardTitle>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat large label="Cash" value={money(cash)} />
          <Stat large label="Savings" value={money(savings)} />
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
          />
        </div>
        {sts.negativeDays.length > 0 && (
          <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
            Projected balance goes negative on {formatDateShort(sts.negativeDays[0])} based on known
            commitments. See <Link to="/cashflow" className="underline">Cashflow</Link>.
          </p>
        )}
      </Card>

      {/* Monthly position */}
      <Card>
        <CardTitle>
          This month · day {dayOfMonth} of {daysInMonth}
        </CardTitle>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat label="Income received" value={money(incomeReceived)} />
          <Stat label="Spending to date" value={money(spendingToDate)} />
          <Stat label="Bills paid" value={`${billsPaid.length}`} sub={money(billsPaid.reduce((s, t) => s + -t.amount_minor, 0))} />
          <Stat
            label="Bills still due"
            value={`${dueThisMonth.length}`}
            sub={money(dueThisMonth.reduce((s, u) => s + -u.amountMinor, 0))}
          />
          {summary && (
            <>
              <Stat
                label="Budget remaining"
                value={money(summary.remainingMinor)}
                tone={summary.remainingMinor < 0 ? 'bad' : undefined}
              />
              <Stat
                label="Forecast month-end spend"
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
        {!budget && (
          <p className="mt-3 text-xs text-ink-faint">
            No budget for this month yet.{' '}
            <Link to="/budget" className="text-accent hover:underline">
              Create one
            </Link>
            .
          </p>
        )}
      </Card>

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
    </div>
  )
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
