// Deterministic budget calculations. Transfers, excluded transactions and
// splits are respected everywhere. Spending is negative in the ledger; budget
// figures are reported as positive "spent" numbers for display.

import type { Minor } from './money'

export interface EngineTxn {
  id: string
  date: string // ISO
  amountMinor: Minor // negative = out
  categoryId: string | null
  isTransfer: boolean
  excludeFromBudget: boolean
  isReimbursable?: boolean
  splits?: { categoryId: string | null; amountMinor: Minor }[]
}

export interface BudgetLineInput {
  categoryId: string | null
  kind: 'income' | 'fixed' | 'variable' | 'discretionary' | 'debt' | 'savings' | 'one_off'
  plannedMinor: Minor
  rolloverFromMinor?: Minor
}

export type BudgetStatus = 'on_track' | 'warning' | 'over'

export interface CategoryActual {
  categoryId: string | null
  spentMinor: Minor // positive
  incomeMinor: Minor // positive
}

/** Sum actual spend/income per category, applying splits and exclusions. */
export function categoryActuals(txns: EngineTxn[]): Map<string | null, CategoryActual> {
  const map = new Map<string | null, CategoryActual>()
  const add = (categoryId: string | null, amountMinor: Minor) => {
    const entry = map.get(categoryId) ?? { categoryId, spentMinor: 0, incomeMinor: 0 }
    if (amountMinor < 0) entry.spentMinor += -amountMinor
    else entry.incomeMinor += amountMinor
    map.set(categoryId, entry)
  }
  for (const t of txns) {
    if (t.isTransfer || t.excludeFromBudget || t.isReimbursable) continue
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) add(s.categoryId, s.amountMinor)
    } else {
      add(t.categoryId, t.amountMinor)
    }
  }
  return map
}

export interface LineStatus {
  categoryId: string | null
  kind: BudgetLineInput['kind']
  plannedMinor: Minor
  actualMinor: Minor
  remainingMinor: Minor
  percentUsed: number
  forecastMinor: Minor
  status: BudgetStatus
}

/**
 * Budget vs actual per line with a stated forecast method: linear run-rate of
 * spending so far, projected over the days of the month. Fixed/debt/savings
 * lines forecast at max(planned, actual) since they are commitments.
 */
export function lineStatuses(
  lines: BudgetLineInput[],
  actuals: Map<string | null, CategoryActual>,
  daysElapsed: number,
  daysInMonth: number,
): LineStatus[] {
  const safeElapsed = Math.max(1, Math.min(daysElapsed, daysInMonth))
  return lines
    .filter((l) => l.kind !== 'income')
    .map((l) => {
      const planned = l.plannedMinor + (l.rolloverFromMinor ?? 0)
      const actual = actuals.get(l.categoryId)?.spentMinor ?? 0
      const isCommitment = l.kind === 'fixed' || l.kind === 'debt' || l.kind === 'savings'
      const forecast = isCommitment
        ? Math.max(planned, actual)
        : Math.round((actual / safeElapsed) * daysInMonth)
      const pct = planned === 0 ? (actual > 0 ? Infinity : 0) : (actual / planned) * 100
      const forecastPct = planned === 0 ? (forecast > 0 ? Infinity : 0) : (forecast / planned) * 100
      let status: BudgetStatus = 'on_track'
      if (pct >= 100) status = 'over'
      else if (forecastPct > 100) status = 'warning'
      else if (!isCommitment && pct > (safeElapsed / daysInMonth) * 100 + 15) {
        // Ahead-of-pace heuristic only applies to variable spending — fixed
        // commitments legitimately land early in the month.
        status = 'warning'
      }
      return {
        categoryId: l.categoryId,
        kind: l.kind,
        plannedMinor: planned,
        actualMinor: actual,
        remainingMinor: planned - actual,
        percentUsed: pct,
        forecastMinor: forecast,
        status,
      }
    })
}

export interface BudgetSummary {
  plannedSpendMinor: Minor
  actualSpendMinor: Minor
  remainingMinor: Minor
  expectedIncomeMinor: Minor
  actualIncomeMinor: Minor
  forecastSpendMinor: Minor
}

export function budgetSummary(
  expectedIncomeMinor: Minor,
  lines: LineStatus[],
  actuals: Map<string | null, CategoryActual>,
): BudgetSummary {
  const plannedSpend = lines.reduce((a, l) => a + l.plannedMinor, 0)
  const actualSpend = lines.reduce((a, l) => a + l.actualMinor, 0)
  const forecastSpend = lines.reduce((a, l) => a + l.forecastMinor, 0)
  let actualIncome = 0
  for (const a of actuals.values()) actualIncome += a.incomeMinor
  return {
    plannedSpendMinor: plannedSpend,
    actualSpendMinor: actualSpend,
    remainingMinor: plannedSpend - actualSpend,
    expectedIncomeMinor,
    actualIncomeMinor: actualIncome,
    forecastSpendMinor: forecastSpend,
  }
}
