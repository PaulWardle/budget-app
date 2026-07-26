// Overdraft analysis from running balances.
//
// The ledger carries a running balance per transaction (statement imports).
// Reconstructing a daily balance series from those makes the overdraft pattern
// measurable: how many days below £0, how deep, what it cost, and — the part
// that matters for someone funding big goals from lump contributions — how much
// of each lump was silently absorbed refilling a negative balance rather than
// funding anything.
//
// Balances are per-account statements, so callers should pass one account's
// transactions (the overdrawn current account), not a merged ledger.

import type { Minor } from './money'

export interface OverdraftTxn {
  date: string // ISO
  amountMinor: Minor
  runningBalanceMinor: Minor | null
  description: string
}

export interface MonthOverdraft {
  month: string // YYYY-MM
  daysTracked: number
  daysOverdrawn: number
  daysAboveZero: number
  deepestMinor: Minor // most negative balance seen (<= 0)
  interestMinor: Minor // overdraft interest charged that month (positive)
}

export interface LumpAbsorption {
  date: string
  description: string
  amountMinor: Minor // positive
  balanceBeforeMinor: Minor | null
  /** Portion that went to refilling a negative balance (positive, <= amount). */
  absorbedMinor: Minor
}

export interface OverdraftSummary {
  months: MonthOverdraft[]
  totalInterestMinor: Minor
  /** Current month's days above zero — the north-star metric. */
  currentMonth: MonthOverdraft | null
  lumps: LumpAbsorption[]
  totalAbsorbedMinor: Minor
}

const monthOf = (iso: string): string => iso.slice(0, 7)

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** True for bank-charged overdraft interest lines (Halifax: "DAILY OD INT"). */
export function isOverdraftInterest(description: string): boolean {
  return /\bOD\s*INT|OVERDRAFT\s*INT/i.test(description)
}

/**
 * Reconstruct a daily end-of-day balance series from transaction running
 * balances. Days with no transactions carry the previous day's balance
 * forward. Days before the first known balance are untracked, not assumed.
 */
export function dailyBalances(
  txns: OverdraftTxn[],
  upTo: string,
): { date: string; balanceMinor: Minor }[] {
  const withBalance = txns
    .filter((t) => t.runningBalanceMinor !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (withBalance.length === 0) return []

  // Last known balance per day. Within a day, statement order is not
  // recoverable, so the final row's balance stands for the day's close.
  const endOfDay = new Map<string, Minor>()
  for (const t of withBalance) endOfDay.set(t.date, t.runningBalanceMinor!)

  const out: { date: string; balanceMinor: Minor }[] = []
  let date = withBalance[0].date
  let balance = withBalance[0].runningBalanceMinor!
  let guard = 0
  while (date <= upTo && guard++ < 800) {
    balance = endOfDay.get(date) ?? balance
    out.push({ date, balanceMinor: balance })
    date = isoAddDays(date, 1)
  }
  return out
}

/** Per-month overdraft stats plus lump-absorption analysis. */
export function analyseOverdraft(
  txns: OverdraftTxn[],
  today: string,
  opts: { lumpThresholdMinor?: Minor } = {},
): OverdraftSummary {
  const lumpThreshold = opts.lumpThresholdMinor ?? 50000
  const daily = dailyBalances(txns, today)

  const byMonth = new Map<string, MonthOverdraft>()
  for (const d of daily) {
    const m = monthOf(d.date)
    const entry =
      byMonth.get(m) ??
      ({ month: m, daysTracked: 0, daysOverdrawn: 0, daysAboveZero: 0, deepestMinor: 0, interestMinor: 0 } as MonthOverdraft)
    entry.daysTracked += 1
    if (d.balanceMinor < 0) {
      entry.daysOverdrawn += 1
      entry.deepestMinor = Math.min(entry.deepestMinor, d.balanceMinor)
    } else {
      entry.daysAboveZero += 1
    }
    byMonth.set(m, entry)
  }
  for (const t of txns) {
    if (t.amountMinor < 0 && isOverdraftInterest(t.description)) {
      const entry = byMonth.get(monthOf(t.date))
      if (entry) entry.interestMinor += -t.amountMinor
    }
  }

  // How much of each large incoming lump went to refilling a hole: the part
  // of the payment below £0. Balance before = running balance after − amount.
  const lumps: LumpAbsorption[] = txns
    .filter((t) => t.amountMinor >= lumpThreshold)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => {
      const before = t.runningBalanceMinor === null ? null : t.runningBalanceMinor - t.amountMinor
      const absorbed = before === null ? 0 : Math.min(t.amountMinor, Math.max(0, -before))
      return {
        date: t.date,
        description: t.description,
        amountMinor: t.amountMinor,
        balanceBeforeMinor: before,
        absorbedMinor: absorbed,
      }
    })

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  return {
    months,
    totalInterestMinor: months.reduce((s, m) => s + m.interestMinor, 0),
    currentMonth: months.find((m) => m.month === monthOf(today)) ?? null,
    lumps,
    totalAbsorbedMinor: lumps.reduce((s, l) => s + l.absorbedMinor, 0),
  }
}
