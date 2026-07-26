// Monthly review: one deterministic summary of a calendar month, computed
// from the ledger with the same definitions the rest of the app uses.
//
// Everyday spend excludes transfers, reimbursable, budget-excluded rows,
// bill payments (recurring_payment_id set) and one-offs — matching the
// forecast baseline — so "vs typical" comparisons are like-for-like.
// Everything else (bills, one-offs/projects, debt payments) is reported in
// its own bucket; together the buckets account for all money out.

import type { Minor } from './money'

export interface ReviewTxn {
  date: string // ISO
  amountMinor: Minor
  categoryId: string | null
  merchantName: string | null
  description: string
  isTransfer: boolean
  excludeFromBudget: boolean
  isReimbursable: boolean
  recurringPaymentId: string | null
  isOneOff: boolean
  projectId: string | null
}

export interface CategoryDelta {
  categoryId: string | null
  thisMonthMinor: Minor
  prevMonthMinor: Minor
  deltaMinor: Minor // positive = spent more this month
}

export interface ReviewRange {
  start: string // inclusive
  end: string // inclusive
}

export interface MonthlyReview {
  month: string // period key: YYYY-MM for months, start date for pay periods
  incomeMinor: Minor
  totalOutMinor: Minor // all real money out (bills + everyday + one-offs)
  billsMinor: Minor
  everydayMinor: Minor
  oneOffMinor: Minor // one-offs not assigned to a project
  projectMinor: Minor
  netMinor: Minor // income − total out
  savingsRatePct: number | null // null when no income
  /** Median everyday spend of up to three complete months before this one. */
  baselineMinor: Minor
  baselineMonths: number
  vsBaselineMinor: Minor // everyday − baseline; positive = over
  categoryDeltas: CategoryDelta[] // biggest movers vs previous period, desc |delta|
  prevMonth: string | null // key of the period actually used for the comparison
}

const monthOf = (date: string) => date.slice(0, 7)

const isReal = (t: ReviewTxn) => !t.isTransfer && !t.excludeFromBudget && !t.isReimbursable

const isEveryday = (t: ReviewTxn) =>
  t.amountMinor < 0 && isReal(t) && !t.recurringPaymentId && !t.isOneOff && !t.projectId

const inRange = (t: ReviewTxn, r: ReviewRange) => t.date >= r.start && t.date <= r.end

/**
 * Compute the review for one period (a calendar month or a pay period).
 * `priors` are the periods immediately before it, newest first — up to three
 * with data feed the everyday baseline, and the first with data is the
 * comparison period for category movers. `key` labels the result (and
 * `priorKey` labels the comparison); the caller decides how to display them.
 */
export function periodReview(
  txns: ReviewTxn[],
  current: ReviewRange & { key: string },
  priors: (ReviewRange & { key: string })[],
): MonthlyReview {
  let incomeMinor = 0
  let billsMinor = 0
  let everydayMinor = 0
  let oneOffMinor = 0
  let projectMinor = 0

  for (const t of txns) {
    if (!inRange(t, current) || !isReal(t)) continue
    if (t.amountMinor > 0) {
      incomeMinor += t.amountMinor
      continue
    }
    const out = -t.amountMinor
    if (t.recurringPaymentId) billsMinor += out
    else if (t.projectId) projectMinor += out
    else if (t.isOneOff) oneOffMinor += out
    else everydayMinor += out
  }
  const totalOutMinor = billsMinor + everydayMinor + oneOffMinor + projectMinor
  const netMinor = incomeMinor - totalOutMinor

  // Baseline: median everyday spend of up to three prior periods with data.
  const priorsWithData = priors.filter((p) => txns.some((t) => inRange(t, p)))
  const totals = priorsWithData
    .slice(0, 3)
    .map((p) => txns.filter((t) => isEveryday(t) && inRange(t, p)).reduce((s, t) => s + -t.amountMinor, 0))
    .sort((a, b) => a - b)
  const baselineMinor =
    totals.length === 0
      ? 0
      : totals.length % 2 === 1
        ? totals[Math.floor(totals.length / 2)]
        : Math.round((totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2)

  // Category movers vs the immediately previous period (everyday + one-off +
  // project spend; bills move rarely and would drown the signal).
  const prevPeriod = priorsWithData[0] ?? null
  const spendByCat = (r: ReviewRange | null) => {
    const out = new Map<string | null, number>()
    if (!r) return out
    for (const t of txns) {
      if (!inRange(t, r) || t.amountMinor >= 0 || !isReal(t) || t.recurringPaymentId) continue
      out.set(t.categoryId, (out.get(t.categoryId) ?? 0) + -t.amountMinor)
    }
    return out
  }
  const cur = spendByCat(current)
  const prev = spendByCat(prevPeriod)
  const catIds = new Set([...cur.keys(), ...prev.keys()])
  const categoryDeltas: CategoryDelta[] = [...catIds]
    .map((id) => {
      const thisMonthMinor = cur.get(id) ?? 0
      const prevMonthMinor = prev.get(id) ?? 0
      return { categoryId: id, thisMonthMinor, prevMonthMinor, deltaMinor: thisMonthMinor - prevMonthMinor }
    })
    .filter((d) => d.deltaMinor !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))

  return {
    month: current.key,
    incomeMinor,
    totalOutMinor,
    billsMinor,
    everydayMinor,
    oneOffMinor,
    projectMinor,
    netMinor,
    savingsRatePct: incomeMinor > 0 ? Math.round((netMinor / incomeMinor) * 100) : null,
    baselineMinor,
    baselineMonths: totals.length,
    vsBaselineMinor: everydayMinor - baselineMinor,
    categoryDeltas,
    prevMonth: prevPeriod?.key ?? null,
  }
}

/**
 * Calendar-month review — `periodReview` over month boundaries. `txns` should
 * span the target month plus enough history for the baseline and comparison.
 */
export function monthlyReview(txns: ReviewTxn[], month: string): MonthlyReview {
  const rangeOf = (m: string): ReviewRange & { key: string } => {
    const days = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate()
    return { key: m, start: `${m}-01`, end: `${m}-${String(days).padStart(2, '0')}` }
  }
  // Priors = every earlier month present in the data, newest first, so the
  // baseline can use up to three complete months even across gaps.
  const priorMonths = [...new Set(txns.map((t) => monthOf(t.date)))]
    .filter((m) => m < month)
    .sort((a, b) => b.localeCompare(a))
  return periodReview(txns, rangeOf(month), priorMonths.map(rangeOf))
}

export function prevMonthOf(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Months (YYYY-MM, newest first) that have at least one real transaction and
 * are complete (strictly before the current month). */
export function reviewableMonths(txns: { date: string }[], todayIso: string): string[] {
  const current = monthOf(todayIso)
  const months = new Set<string>()
  for (const t of txns) {
    const m = monthOf(t.date)
    if (m < current) months.add(m)
  }
  return [...months].sort((a, b) => b.localeCompare(a))
}
