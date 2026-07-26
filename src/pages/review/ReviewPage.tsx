import { PageHeader, Stat, categoryLabel } from '@/components/shared/common'
import { Badge, Card, CardTitle, EmptyState, Select, Spinner } from '@/components/ui/primitives'
import { fetchAccounts, fetchCategories, fetchNetWorthHistory, fetchTransactions } from '@/lib/api'
import { analyseOverdraft, type MonthOverdraft } from '@/lib/engine/overdraft'
import { monthlyReview, prevMonthOf, reviewableMonths } from '@/lib/engine/review'
import { money, todayIso } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })
}

function monthEndOf(month: string): string {
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
  return `${month}-${String(days).padStart(2, '0')}`
}

function monthsBack(month: string, n: number): string {
  let m = month
  for (let i = 0; i < n; i++) m = prevMonthOf(m)
  return m
}

export default function ReviewPage() {
  const today = todayIso()
  const [params, setParams] = useSearchParams()
  const [fallbackMonth] = useState(() => prevMonthOf(today.slice(0, 7)))
  const month = params.get('month') ?? fallbackMonth

  // Five months of history: the reviewed month, 3 baseline months, and the
  // previous month for comparisons — one query serves everything.
  const from = `${monthsBack(month, 4)}-01`
  const to = monthEndOf(month)
  const { data: txns, isLoading } = useQuery({
    queryKey: ['transactions', 'review', from, to],
    queryFn: () => fetchTransactions({ from, to, limit: 6000 }),
  })
  // Separate light query so the month picker can offer every month with data.
  const { data: allTxns } = useQuery({
    queryKey: ['transactions', 'review-months'],
    queryFn: () => fetchTransactions({ from: `${monthsBack(today.slice(0, 7), 14)}-01`, limit: 6000 }),
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: nwHistory } = useQuery({ queryKey: ['networth', 'history'], queryFn: fetchNetWorthHistory })

  const months = useMemo(() => reviewableMonths(allTxns ?? [], today), [allTxns, today])

  const review = useMemo(
    () =>
      txns
        ? monthlyReview(
            txns.map((t) => ({
              date: t.date,
              amountMinor: t.amount_minor,
              categoryId: t.category_id,
              merchantName: t.merchant_name,
              description: t.description,
              isTransfer: t.is_transfer,
              excludeFromBudget: t.exclude_from_budget,
              isReimbursable: t.is_reimbursable,
              recurringPaymentId: t.recurring_payment_id,
              isOneOff: t.is_one_off,
              projectId: t.project_id,
            })),
            month,
          )
        : null,
    [txns, month],
  )

  // Overdraft months from the busiest current account's running balances
  const overdraft = useMemo(() => {
    if (!txns || !accounts) return null
    const currentIds = accounts.filter((a) => a.account_type === 'current').map((a) => a.id)
    const byAccount = new Map<string, typeof txns>()
    for (const t of txns) {
      if (!currentIds.includes(t.account_id) || t.running_balance_minor === null) continue
      byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t])
    }
    const rows = [...byAccount.values()].sort((a, b) => b.length - a.length)[0]
    if (!rows || rows.length === 0) return null
    const summary = analyseOverdraft(
      rows.map((t) => ({
        date: t.date,
        amountMinor: t.amount_minor,
        runningBalanceMinor: t.running_balance_minor,
        description: t.description,
      })),
      to < today ? to : today,
    )
    const find = (m: string): MonthOverdraft | undefined => summary.months.find((x) => x.month === m)
    return { thisMonth: find(month), prevMonth: find(prevMonthOf(month)) }
  }, [txns, accounts, month, to, today])

  // Debt paid: month transactions linked to a liability
  const debtPaidMinor = useMemo(
    () =>
      (txns ?? [])
        .filter((t) => t.date.slice(0, 7) === month && t.liability_id && t.amount_minor < 0 && !t.is_transfer)
        .reduce((s, t) => s + -t.amount_minor, 0),
    [txns, month],
  )

  // Net worth change: last snapshot in the month vs last snapshot before it
  const netWorthDelta = useMemo(() => {
    const snaps = nwHistory ?? []
    const end = [...snaps].reverse().find((s) => s.date <= monthEndOf(month))
    const start = [...snaps].reverse().find((s) => s.date <= monthEndOf(prevMonthOf(month)))
    if (!end || !start || end.date === start.date) return null
    return end.net_worth_minor - start.net_worth_minor
  }, [nwHistory, month])

  if (isLoading || !categories) return <Spinner />

  if (!review || months.length === 0) {
    return (
      <div>
        <PageHeader title="Monthly review" />
        <EmptyState
          title="Nothing to review yet"
          hint="Reviews cover complete months — once a full month of transactions is in, it appears here."
        />
      </div>
    )
  }

  const hasMonthData = review.totalOutMinor > 0 || review.incomeMinor > 0
  const kept = review.netMinor >= 0
  const shareOf = (v: number) => (review.totalOutMinor > 0 ? Math.round((v / review.totalOutMinor) * 100) : 0)
  const buckets = [
    { label: 'Bills & debts', value: review.billsMinor, hint: 'regular commitments' },
    { label: 'Everyday spending', value: review.everydayMinor, hint: 'shops, fuel, food, days out' },
    { label: 'One-offs', value: review.oneOffMinor, hint: 'unusual purchases' },
    { label: 'Projects', value: review.projectMinor, hint: 'assigned to a project' },
  ].filter((b) => b.value > 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monthly review"
        sub={hasMonthData ? `How ${monthLabel(month)} actually went` : undefined}
        actions={
          <Select
            className="w-44"
            value={month}
            onChange={(e) => setParams({ month: e.target.value })}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        }
      />

      {!hasMonthData ? (
        <EmptyState title={`No transactions in ${monthLabel(month)}`} hint="Pick another month." />
      ) : (
        <>
          {/* Verdict */}
          <Card>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                large
                label={kept ? 'Kept this month' : 'Overspent by'}
                value={money(Math.abs(review.netMinor))}
                tone={kept ? 'good' : 'bad'}
              />
              <Stat label="Money in" value={money(review.incomeMinor)} />
              <Stat label="Money out" value={money(review.totalOutMinor)} />
              <Stat
                label="Savings rate"
                value={review.savingsRatePct !== null ? `${review.savingsRatePct}%` : '—'}
                tone={review.savingsRatePct !== null && review.savingsRatePct > 0 ? 'good' : undefined}
              />
            </div>
          </Card>

          {/* Where it went */}
          <Card>
            <CardTitle>Where the money went</CardTitle>
            <div className="space-y-2">
              {buckets.map((b) => (
                <div key={b.label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {b.label}
                      <span className="ml-1.5 text-[11px] text-ink-faint">{b.hint}</span>
                    </span>
                    <span className="tnum font-semibold">
                      {money(b.value)} <span className="text-xs font-normal text-ink-muted">{shareOf(b.value)}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full grad-accent" style={{ width: `${shareOf(b.value)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-right text-[11px]">
              <Link
                className="font-medium text-accent hover:underline"
                to={`/transactions?from=${month}-01&to=${monthEndOf(month)}`}
              >
                All {monthLabel(month)} transactions →
              </Link>
            </p>
          </Card>

          {/* Everyday vs typical */}
          <Card>
            <CardTitle>Everyday spending vs typical</CardTitle>
            {review.baselineMonths === 0 ? (
              <p className="text-xs text-ink-faint">
                No complete earlier months yet — the comparison appears once there's history.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <p className="tnum text-lg font-semibold">{money(review.everydayMinor)}</p>
                  <Badge tone={review.vsBaselineMinor <= 0 ? 'good' : 'warn'}>
                    {review.vsBaselineMinor <= 0
                      ? `${money(-review.vsBaselineMinor)} under typical`
                      : `${money(review.vsBaselineMinor)} over typical`}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-ink-faint">
                  Typical month: {money(review.baselineMinor)} (median of the last {review.baselineMonths}{' '}
                  complete month{review.baselineMonths === 1 ? '' : 's'}). Bills, one-offs and project
                  spend are counted separately, so this is a like-for-like comparison.
                </p>
              </>
            )}
          </Card>

          {/* Overdraft + wealth movement */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardTitle>Overdraft</CardTitle>
              {!overdraft?.thisMonth ? (
                <p className="text-xs text-ink-faint">
                  No running balances for this month — import a statement to track it.
                </p>
              ) : (
                <>
                  <Stat
                    label="Days above £0"
                    value={`${overdraft.thisMonth.daysAboveZero} of ${overdraft.thisMonth.daysTracked}`}
                    tone={overdraft.thisMonth.daysOverdrawn === 0 ? 'good' : 'warn'}
                  />
                  {overdraft.prevMonth && (
                    <p className="mt-1 text-[11px] text-ink-muted">
                      {overdraft.thisMonth.daysAboveZero > overdraft.prevMonth.daysAboveZero
                        ? `Up from ${overdraft.prevMonth.daysAboveZero} last month — moving the right way.`
                        : overdraft.thisMonth.daysAboveZero < overdraft.prevMonth.daysAboveZero
                          ? `Down from ${overdraft.prevMonth.daysAboveZero} last month.`
                          : 'Same as last month.'}
                    </p>
                  )}
                  {overdraft.thisMonth.interestMinor > 0 && (
                    <p className="mt-1 text-[11px] text-bad">
                      Overdraft interest cost {money(overdraft.thisMonth.interestMinor)} this month.
                    </p>
                  )}
                  {overdraft.thisMonth.deepestMinor < 0 && (
                    <p className="mt-1 text-[11px] text-ink-faint">
                      Deepest point: {money(overdraft.thisMonth.deepestMinor, { showSign: true })}
                    </p>
                  )}
                </>
              )}
            </Card>
            <Card>
              <CardTitle>Debts & wealth</CardTitle>
              <div className="space-y-2">
                <Stat label="Paid towards debts" value={money(debtPaidMinor)} />
                {netWorthDelta !== null && (
                  <Stat
                    label="Net worth change"
                    value={money(netWorthDelta, { showSign: true })}
                    tone={netWorthDelta >= 0 ? 'good' : 'bad'}
                  />
                )}
              </div>
            </Card>
          </div>

          {/* Category movers */}
          {review.prevMonth && review.categoryDeltas.length > 0 && (
            <Card>
              <CardTitle>Biggest changes vs {monthLabel(review.prevMonth)}</CardTitle>
              <div className="space-y-1.5">
                {review.categoryDeltas.slice(0, 8).map((d) => (
                  <div key={d.categoryId ?? 'none'} className="flex items-center justify-between text-sm">
                    <span className="min-w-0 truncate">{categoryLabel(categories, d.categoryId)}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-ink-faint">
                        {money(d.prevMonthMinor)} → {money(d.thisMonthMinor)}
                      </span>
                      <Badge tone={d.deltaMinor > 0 ? 'warn' : 'good'}>
                        {d.deltaMinor > 0 ? '+' : '−'}
                        {money(Math.abs(d.deltaMinor))}
                      </Badge>
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-faint">
                Everyday and one-off spending only — bills are compared in their own bucket above.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
