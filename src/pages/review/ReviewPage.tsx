import { PageHeader, Stat, categoryLabel } from '@/components/shared/common'
import { Badge, Card, CardTitle, EmptyState, Select, Spinner } from '@/components/ui/primitives'
import {
  fetchAccounts,
  fetchCategories,
  fetchNetWorthHistory,
  fetchProfile,
  fetchTransactions,
} from '@/lib/api'
import { dailyBalances, isOverdraftInterest } from '@/lib/engine/overdraft'
import {
  isoAddDays,
  payPeriodFor,
  previousPayPeriods,
  type PayPeriod,
} from '@/lib/engine/payperiod'
import { periodReview } from '@/lib/engine/review'
import { formatDateShort, money, todayIso } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

/** "24 Jul – 24 Aug" for pay periods; "July 2026" for calendar fallback. */
const periodTitle = (p: PayPeriod) => p.label

export default function ReviewPage() {
  const today = todayIso()
  const [params, setParams] = useSearchParams()
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile })
  const paydayDay = (profile?.payday_day as number | null) ?? null

  // Complete periods only — the current one is still being lived.
  const candidates = useMemo(
    () => (profile === undefined ? [] : previousPayPeriods(today, paydayDay, 14)),
    [profile, paydayDay, today],
  )

  // A light, wide query so the picker can offer every period with data.
  const { data: allTxns } = useQuery({
    queryKey: ['transactions', 'review-window'],
    queryFn: () => fetchTransactions({ from: isoAddDays(today, -430), limit: 6000 }),
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: nwHistory } = useQuery({ queryKey: ['networth', 'history'], queryFn: fetchNetWorthHistory })

  const periods = useMemo(
    () =>
      candidates.filter((p) => (allTxns ?? []).some((t) => t.date >= p.start && t.date <= p.end)),
    [candidates, allTxns],
  )

  const selectedStart = params.get('start')
  const period = periods.find((p) => p.start === selectedStart) ?? periods[0]

  const review = useMemo(() => {
    if (!allTxns || !period) return null
    const mapped = allTxns.map((t) => ({
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
    }))
    const priors = previousPayPeriods(period.start, paydayDay, 4)
    return periodReview(
      mapped,
      { key: period.start, start: period.start, end: period.end },
      priors.map((p) => ({ key: p.start, start: p.start, end: p.end })),
    )
  }, [allTxns, period, paydayDay])

  // Overdraft days within the period, from the busiest current account's
  // running balances.
  const overdraft = useMemo(() => {
    if (!allTxns || !accounts || !period) return null
    const currentIds = accounts.filter((a) => a.account_type === 'current').map((a) => a.id)
    const byAccount = new Map<string, typeof allTxns>()
    for (const t of allTxns) {
      if (!currentIds.includes(t.account_id) || t.running_balance_minor === null) continue
      byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t])
    }
    const rows = [...byAccount.values()].sort((a, b) => b.length - a.length)[0]
    if (!rows || rows.length === 0) return null
    const odTxns = rows.map((t) => ({
      date: t.date,
      amountMinor: t.amount_minor,
      runningBalanceMinor: t.running_balance_minor,
      description: t.description,
    }))
    const daily = dailyBalances(odTxns, period.end < today ? period.end : today)
    const stats = (p: PayPeriod) => {
      const days = daily.filter((d) => d.date >= p.start && d.date <= p.end)
      if (days.length === 0) return null
      return {
        tracked: days.length,
        above: days.filter((d) => d.balanceMinor >= 0).length,
        deepest: Math.min(0, ...days.map((d) => d.balanceMinor)),
        interest: odTxns
          .filter(
            (t) =>
              t.date >= p.start && t.date <= p.end && t.amountMinor < 0 && isOverdraftInterest(t.description),
          )
          .reduce((s, t) => s + -t.amountMinor, 0),
      }
    }
    const prev = previousPayPeriods(period.start, paydayDay, 1)[0]
    return { thisPeriod: stats(period), prevPeriod: prev ? stats(prev) : null }
  }, [allTxns, accounts, period, paydayDay, today])

  const debtPaidMinor = useMemo(
    () =>
      period
        ? (allTxns ?? [])
            .filter(
              (t) =>
                t.date >= period.start && t.date <= period.end && t.liability_id && t.amount_minor < 0 && !t.is_transfer,
            )
            .reduce((s, t) => s + -t.amount_minor, 0)
        : 0,
    [allTxns, period],
  )

  const netWorthDelta = useMemo(() => {
    if (!period) return null
    const snaps = nwHistory ?? []
    const end = [...snaps].reverse().find((s) => s.date <= period.end)
    const start = [...snaps].reverse().find((s) => s.date < period.start)
    if (!end || !start || end.date === start.date) return null
    return end.net_worth_minor - start.net_worth_minor
  }, [nwHistory, period])

  if (!allTxns || !categories || profile === undefined) return <Spinner />

  if (!review || !period) {
    return (
      <div>
        <PageHeader title={paydayDay ? 'Pay period review' : 'Monthly review'} />
        <EmptyState
          title="Nothing to review yet"
          hint="Reviews cover complete pay periods — once a full payday-to-payday cycle of transactions is in, it appears here."
        />
      </div>
    )
  }

  const kept = review.netMinor >= 0
  const shareOf = (v: number) => (review.totalOutMinor > 0 ? Math.round((v / review.totalOutMinor) * 100) : 0)
  const buckets = [
    { label: 'Bills & debts', value: review.billsMinor, hint: 'regular commitments' },
    { label: 'Everyday spending', value: review.everydayMinor, hint: 'shops, fuel, food, days out' },
    { label: 'One-offs', value: review.oneOffMinor, hint: 'unusual purchases' },
    { label: 'Projects', value: review.projectMinor, hint: 'assigned to a project' },
  ].filter((b) => b.value > 0)
  const prevPeriod = review.prevMonth ? payPeriodFor(review.prevMonth, paydayDay) : null

  return (
    <div className="space-y-4">
      <PageHeader
        title={paydayDay ? 'Pay period review' : 'Monthly review'}
        sub={
          paydayDay
            ? `Payday to payday: ${periodTitle(period)}`
            : `How ${periodTitle(period)} actually went`
        }
        actions={
          <Select
            className="w-44"
            value={period.start}
            onChange={(e) => setParams({ start: e.target.value })}
          >
            {periods.map((p) => (
              <option key={p.start} value={p.start}>
                {periodTitle(p)}
              </option>
            ))}
          </Select>
        }
      />

      {/* Verdict */}
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            large
            label={kept ? 'Kept this period' : 'Overspent by'}
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
            to={`/transactions?from=${period.start}&to=${period.end}`}
          >
            All transactions for this period →
          </Link>
        </p>
      </Card>

      {/* Everyday vs typical */}
      <Card>
        <CardTitle>Everyday spending vs typical</CardTitle>
        {review.baselineMonths === 0 ? (
          <p className="text-xs text-ink-faint">
            No complete earlier pay periods yet — the comparison appears once there's history.
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
              Typical period: {money(review.baselineMinor)} (median of the last {review.baselineMonths}{' '}
              complete pay period{review.baselineMonths === 1 ? '' : 's'}). Bills, one-offs and project
              spend are counted separately, so this is a like-for-like comparison.
            </p>
          </>
        )}
      </Card>

      {/* Overdraft + wealth movement */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Overdraft</CardTitle>
          {!overdraft?.thisPeriod ? (
            <p className="text-xs text-ink-faint">
              No running balances for this period — import a statement to track it.
            </p>
          ) : (
            <>
              <Stat
                label="Days above £0"
                value={`${overdraft.thisPeriod.above} of ${overdraft.thisPeriod.tracked}`}
                tone={overdraft.thisPeriod.above === overdraft.thisPeriod.tracked ? 'good' : 'warn'}
              />
              {overdraft.prevPeriod && (
                <p className="mt-1 text-[11px] text-ink-muted">
                  {overdraft.thisPeriod.above > overdraft.prevPeriod.above
                    ? `Up from ${overdraft.prevPeriod.above} last period — moving the right way.`
                    : overdraft.thisPeriod.above < overdraft.prevPeriod.above
                      ? `Down from ${overdraft.prevPeriod.above} last period.`
                      : 'Same as last period.'}
                </p>
              )}
              {overdraft.thisPeriod.interest > 0 && (
                <p className="mt-1 text-[11px] text-bad">
                  Overdraft interest cost {money(overdraft.thisPeriod.interest)} this period.
                </p>
              )}
              {overdraft.thisPeriod.deepest < 0 && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  Deepest point: {money(overdraft.thisPeriod.deepest, { showSign: true })}
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
      {prevPeriod && review.categoryDeltas.length > 0 && (
        <Card>
          <CardTitle>Biggest changes vs {periodTitle(prevPeriod)}</CardTitle>
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

      {paydayDay && (
        <p className="text-center text-[11px] text-ink-faint">
          Periods run payday to payday (the {paydayDay}
          {ordinal(paydayDay)}, or the Friday before when it falls on a weekend). Next payday:{' '}
          {formatDateShort(payPeriodFor(today, paydayDay).nextPayday)}.
        </p>
      )}
    </div>
  )
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th'
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
}
