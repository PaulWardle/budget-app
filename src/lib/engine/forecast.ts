// Forward-looking projection from actual behaviour.
//
// The cashflow projection on its own only knows about scheduled bills, so it
// reports a comfortable balance right up until everyday spending empties the
// account. This module measures what everyday (non-bill) spending has actually
// been over recent complete months and projects it forward, so the forecast
// reflects how the month is likely to end rather than only what is diarised.
//
// Everything here is deterministic and derived from the ledger. Where evidence
// is thin the result says so via `basis` and `confidence` rather than guessing
// quietly.

import type { ProjectedItem } from './cashflow'
import type { Minor } from './money'

export interface ForecastTxn {
  id?: string
  date: string // ISO
  amountMinor: Minor // negative = out
  categoryId: string | null
  merchant?: string
  isTransfer: boolean
  excludeFromBudget: boolean
  isReimbursable?: boolean
  /** Set when the transaction is one of the user's bills — projected separately. */
  recurringPaymentId?: string | null
  /** Marked unusual by the user: it happened, but it shouldn't set expectations. */
  isOneOff?: boolean
}

export interface BaselineMonth {
  month: string // YYYY-MM
  totalMinor: Minor // positive
}

export interface EverydayBaseline {
  /** Complete months the baseline was measured over. */
  monthsUsed: number
  months: BaselineMonth[]
  /** Median monthly everyday spend — median resists a single unusual month. */
  perMonthMinor: Minor
  perDayMinor: Minor
  lowMinor: Minor
  highMinor: Minor
  byCategory: { categoryId: string | null; perMonthMinor: Minor }[]
  confidence: 'high' | 'medium' | 'low'
  /**
   * Every transaction the baseline was measured from, largest first. A forecast
   * nobody can inspect is a forecast nobody can correct — this is what backs
   * the "what's in this number?" view, where a one-off can be taken out.
   */
  contributors: ForecastTxn[]
}

const monthOf = (iso: string): string => iso.slice(0, 7)

export function daysInMonth(monthIso: string): number {
  const [y, m] = monthIso.slice(0, 7).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Spending that is neither a bill nor excluded from budgeting — the part that
 * varies with behaviour rather than being diarised. */
function isEveryday(t: ForecastTxn): boolean {
  return (
    t.amountMinor < 0 &&
    !t.isTransfer &&
    !t.excludeFromBudget &&
    !t.isReimbursable &&
    !t.recurringPaymentId &&
    !t.isOneOff
  )
}

/**
 * Typical everyday spend per month, measured over recent **complete** months.
 * The current month is excluded because a part-month total would drag the
 * baseline down for no reason.
 */
export function everydayBaseline(
  txns: ForecastTxn[],
  today: string,
  monthsBack = 3,
): EverydayBaseline {
  const currentMonth = monthOf(today)
  const totals = new Map<string, number>()
  const catTotals = new Map<string | null, Map<string, number>>()

  for (const t of txns) {
    if (!isEveryday(t)) continue
    const m = monthOf(t.date)
    if (m >= currentMonth) continue // complete months only
    totals.set(m, (totals.get(m) ?? 0) + -t.amountMinor)
    const perCat = catTotals.get(t.categoryId) ?? new Map<string, number>()
    perCat.set(m, (perCat.get(m) ?? 0) + -t.amountMinor)
    catTotals.set(t.categoryId, perCat)
  }

  const months = [...totals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-monthsBack)
    .map(([month, totalMinor]) => ({ month, totalMinor }))

  if (months.length === 0) {
    return {
      monthsUsed: 0,
      months: [],
      perMonthMinor: 0,
      perDayMinor: 0,
      lowMinor: 0,
      highMinor: 0,
      byCategory: [],
      confidence: 'low',
      contributors: [],
    }
  }

  const values = months.map((m) => m.totalMinor)
  const perMonthMinor = median(values)
  const averageDays =
    months.reduce((s, m) => s + daysInMonth(m.month), 0) / months.length
  const keep = new Set(months.map((m) => m.month))

  const byCategory = [...catTotals.entries()]
    .map(([categoryId, perMonth]) => ({
      categoryId,
      perMonthMinor: median(
        [...perMonth.entries()].filter(([m]) => keep.has(m)).map(([, v]) => v),
      ),
    }))
    .filter((c) => c.perMonthMinor > 0)
    .sort((a, b) => b.perMonthMinor - a.perMonthMinor)

  return {
    monthsUsed: months.length,
    months,
    perMonthMinor,
    perDayMinor: Math.round(perMonthMinor / averageDays),
    lowMinor: Math.min(...values),
    highMinor: Math.max(...values),
    byCategory,
    confidence: months.length >= 3 ? 'high' : months.length === 2 ? 'medium' : 'low',
    contributors: txns
      .filter((t) => isEveryday(t) && keep.has(monthOf(t.date)))
      .sort((a, b) => a.amountMinor - b.amountMinor),
  }
}

export interface MonthEndForecast {
  month: string
  dayOfMonth: number
  daysInMonth: number
  daysRemaining: number
  /** What has actually happened so far. */
  everydaySpentMinor: Minor
  billsPaidMinor: Minor
  incomeReceivedMinor: Minor
  /** What is still expected. */
  everydayRemainingMinor: Minor
  billsRemainingMinor: Minor
  incomeRemainingMinor: Minor
  /** Totals for the month as a whole. */
  forecastSpendMinor: Minor
  forecastIncomeMinor: Minor
  forecastNetMinor: Minor
  /** Opening cash plus the net of everything still to come. */
  forecastEndBalanceMinor: Minor
  /** Everyday pace this month against the baseline, as a ratio (1 = on pace). */
  paceRatio: number
  basis: 'baseline' | 'this_month' | 'none'
  confidence: 'high' | 'medium' | 'low'
}

/**
 * Where the month is heading: actuals so far, plus expected everyday spending
 * for the days remaining, plus bills still scheduled.
 *
 * Falls back to this month's own run-rate when there is no history to measure
 * against, and reports `basis: 'none'` when there is neither.
 */
export function forecastMonthEnd(input: {
  today: string
  currentBalanceMinor: Minor
  monthTxns: ForecastTxn[]
  baseline: EverydayBaseline
  /** Remaining scheduled items between tomorrow and month end. */
  remainingScheduled: ProjectedItem[]
}): MonthEndForecast {
  const { today, currentBalanceMinor, monthTxns, baseline, remainingScheduled } = input
  const month = monthOf(today)
  const dim = daysInMonth(month)
  const dayOfMonth = Number(today.slice(8, 10))
  const daysRemaining = Math.max(0, dim - dayOfMonth)

  let everydaySpentMinor = 0
  let billsPaidMinor = 0
  let incomeReceivedMinor = 0
  for (const t of monthTxns) {
    if (t.isTransfer || t.excludeFromBudget || t.isReimbursable) continue
    if (t.amountMinor > 0) {
      incomeReceivedMinor += t.amountMinor
    } else if (t.recurringPaymentId) {
      billsPaidMinor += -t.amountMinor
    } else {
      everydaySpentMinor += -t.amountMinor
    }
  }

  // Prefer measured history; fall back to this month's own pace so a first-time
  // user still gets a forecast rather than a flat line.
  const thisMonthPerDay = dayOfMonth > 0 ? Math.round(everydaySpentMinor / dayOfMonth) : 0
  const basis: MonthEndForecast['basis'] =
    baseline.monthsUsed > 0 ? 'baseline' : everydaySpentMinor > 0 ? 'this_month' : 'none'
  const perDay = basis === 'baseline' ? baseline.perDayMinor : thisMonthPerDay

  const everydayRemainingMinor = perDay * daysRemaining
  let billsRemainingMinor = 0
  let incomeRemainingMinor = 0
  for (const item of remainingScheduled) {
    if (item.amountMinor < 0) billsRemainingMinor += -item.amountMinor
    else incomeRemainingMinor += item.amountMinor
  }

  const forecastSpendMinor =
    everydaySpentMinor + billsPaidMinor + everydayRemainingMinor + billsRemainingMinor
  const forecastIncomeMinor = incomeReceivedMinor + incomeRemainingMinor

  return {
    month,
    dayOfMonth,
    daysInMonth: dim,
    daysRemaining,
    everydaySpentMinor,
    billsPaidMinor,
    incomeReceivedMinor,
    everydayRemainingMinor,
    billsRemainingMinor,
    incomeRemainingMinor,
    forecastSpendMinor,
    forecastIncomeMinor,
    forecastNetMinor: forecastIncomeMinor - forecastSpendMinor,
    forecastEndBalanceMinor:
      currentBalanceMinor - everydayRemainingMinor - billsRemainingMinor + incomeRemainingMinor,
    paceRatio:
      basis === 'baseline' && baseline.perDayMinor > 0 ? thisMonthPerDay / baseline.perDayMinor : 1,
    basis,
    confidence: basis === 'baseline' ? baseline.confidence : basis === 'this_month' ? 'low' : 'low',
  }
}

/**
 * Everyday spending as daily items for the balance projection, so the line
 * reflects the drain that actually empties an account rather than only the
 * diarised bills. Spread evenly — the total is the meaningful part, and
 * pretending to know which day of the week money goes out would be false
 * precision.
 */
export function typicalSpendItems(
  perDayMinor: Minor,
  from: string,
  days: number,
): ProjectedItem[] {
  if (perDayMinor <= 0) return []
  const out: ProjectedItem[] = []
  const start = new Date(`${from}T00:00:00Z`)
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + i)
    out.push({
      date: d.toISOString().slice(0, 10),
      name: 'Typical everyday spending',
      amountMinor: -perDayMinor,
      source: 'typical',
    })
  }
  return out
}
