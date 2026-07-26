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

export interface MonthlyReview {
  month: string // YYYY-MM
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
  categoryDeltas: CategoryDelta[] // biggest movers vs previous month, desc |delta|
  prevMonth: string | null // YYYY-MM actually used for the comparison
}

const monthOf = (date: string) => date.slice(0, 7)

const isReal = (t: ReviewTxn) => !t.isTransfer && !t.excludeFromBudget && !t.isReimbursable

const isEveryday = (t: ReviewTxn) =>
  t.amountMinor < 0 && isReal(t) && !t.recurringPaymentId && !t.isOneOff && !t.projectId

/**
 * Compute the review for `month` (YYYY-MM). `txns` should span the target
 * month plus enough history for the baseline (three complete months) and the
 * previous-month category comparison; anything outside is ignored where
 * irrelevant.
 */
export function monthlyReview(txns: ReviewTxn[], month: string): MonthlyReview {
  let incomeMinor = 0
  let billsMinor = 0
  let everydayMinor = 0
  let oneOffMinor = 0
  let projectMinor = 0

  for (const t of txns) {
    if (monthOf(t.date) !== month || !isReal(t)) continue
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

  // Baseline: median everyday spend of the last up-to-3 complete months
  // strictly before the reviewed month.
  const everydayByMonth = new Map<string, number>()
  for (const t of txns) {
    const m = monthOf(t.date)
    if (m >= month || !isEveryday(t)) continue
    everydayByMonth.set(m, (everydayByMonth.get(m) ?? 0) + -t.amountMinor)
  }
  const totals = [...everydayByMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-3)
    .map(([, v]) => v)
    .sort((a, b) => a - b)
  const baselineMinor =
    totals.length === 0
      ? 0
      : totals.length % 2 === 1
        ? totals[Math.floor(totals.length / 2)]
        : Math.round((totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2)

  // Category movers vs the immediately previous calendar month (everyday +
  // one-off + project spend; bills move rarely and would drown the signal).
  const prevMonth = prevMonthOf(month)
  const spendByCat = (m: string) => {
    const out = new Map<string | null, number>()
    for (const t of txns) {
      if (monthOf(t.date) !== m || t.amountMinor >= 0 || !isReal(t) || t.recurringPaymentId) continue
      out.set(t.categoryId, (out.get(t.categoryId) ?? 0) + -t.amountMinor)
    }
    return out
  }
  const cur = spendByCat(month)
  const prev = spendByCat(prevMonth)
  const catIds = new Set([...cur.keys(), ...prev.keys()])
  const categoryDeltas: CategoryDelta[] = [...catIds]
    .map((id) => {
      const thisMonthMinor = cur.get(id) ?? 0
      const prevMonthMinor = prev.get(id) ?? 0
      return { categoryId: id, thisMonthMinor, prevMonthMinor, deltaMinor: thisMonthMinor - prevMonthMinor }
    })
    .filter((d) => d.deltaMinor !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))

  const hasPrevData = txns.some((t) => monthOf(t.date) === prevMonth)

  return {
    month,
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
    prevMonth: hasPrevData ? prevMonth : null,
  }
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
