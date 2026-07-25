// Deterministic cashflow projection. Distinguishes confirmed transactions from
// known recurring commitments, user expectations and AI estimates — each
// projected item carries its provenance.

import type { Minor } from './money'

export type CommitmentSource =
  | 'confirmed'
  | 'recurring'
  | 'user_expected'
  | 'ai_estimated'
  /** Measured everyday spending projected forward — not a diarised commitment. */
  | 'typical'

export interface ProjectedItem {
  date: string // ISO
  name: string
  amountMinor: Minor // negative = out
  source: CommitmentSource
}

export interface DayProjection {
  date: string
  items: ProjectedItem[]
  netMinor: Minor
  balanceMinor: Minor
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const FREQUENCY_DAYS: Record<string, number> = {
  weekly: 7,
  fortnightly: 14,
  four_weekly: 28,
}

/** Expand a recurring commitment into occurrences within [from, to]. */
export function expandRecurring(
  item: {
    name: string
    amountMinor: Minor
    frequency: string
    nextDueDate: string
    intervalDays?: number | null
    source?: CommitmentSource
  },
  from: string,
  to: string,
): ProjectedItem[] {
  const out: ProjectedItem[] = []
  const src = item.source ?? 'recurring'
  const push = (date: string) => {
    if (date >= from && date <= to) {
      out.push({ date, name: item.name, amountMinor: item.amountMinor, source: src })
    }
  }
  // Month-based frequencies are computed from the anchor date each time so a
  // clamped short month (31st → Feb 28th) doesn't permanently drift the day.
  const monthSteps: Record<string, number> = {
    monthly: 1,
    quarterly: 3,
    six_monthly: 6,
    annual: 12,
  }
  if (item.frequency in monthSteps) {
    for (let n = 0; n < 400; n++) {
      const date = addMonthsIso(item.nextDueDate, n * monthSteps[item.frequency])
      if (date > to) break
      push(date)
    }
    return out
  }
  const stepDays =
    item.frequency === 'custom'
      ? Math.max(1, item.intervalDays ?? 30)
      : FREQUENCY_DAYS[item.frequency]
  if (!stepDays) return out
  let date = item.nextDueDate
  let guard = 0
  while (date <= to && guard++ < 400) {
    push(date)
    date = isoAddDays(date, stepDays)
  }
  return out
}

function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = (m - 1) + months
  const year = y + Math.floor(total / 12)
  const month = (total % 12) + 1
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`
}

/** Project the daily running balance from an opening balance and dated items. */
export function projectDailyBalances(
  openingBalanceMinor: Minor,
  items: ProjectedItem[],
  from: string,
  days: number,
): DayProjection[] {
  const byDate = new Map<string, ProjectedItem[]>()
  for (const item of items) {
    const list = byDate.get(item.date) ?? []
    list.push(item)
    byDate.set(item.date, list)
  }
  const out: DayProjection[] = []
  let balance = openingBalanceMinor
  for (let i = 0; i < days; i++) {
    const date = isoAddDays(from, i)
    const dayItems = byDate.get(date) ?? []
    const net = dayItems.reduce((a, x) => a + x.amountMinor, 0)
    balance += net
    out.push({ date, items: dayItems, netMinor: net, balanceMinor: balance })
  }
  return out
}

export interface SafeToSpendResult {
  nextPaydayDate: string | null
  committedBeforePaydayMinor: Minor // positive number of committed outgoings
  availableMinor: Minor
  minProjectedBalanceMinor: Minor
  negativeDays: string[]
}

/**
 * "Available to spend before next payday": current balance minus committed
 * outgoings before the next income event, floored by the worst projected day.
 */
export function safeToSpend(
  currentBalanceMinor: Minor,
  projection: DayProjection[],
): SafeToSpendResult {
  let paydayIdx = -1
  for (let i = 0; i < projection.length; i++) {
    if (projection[i].items.some((x) => x.amountMinor > 0 && x.source !== 'confirmed')) {
      paydayIdx = i
      break
    }
  }
  const horizon = paydayIdx === -1 ? projection : projection.slice(0, paydayIdx)
  let committed = 0
  for (const day of horizon) {
    for (const item of day.items) if (item.amountMinor < 0) committed += -item.amountMinor
  }
  const negativeDays = projection.filter((d) => d.balanceMinor < 0).map((d) => d.date)
  const minBalance = projection.reduce(
    (min, d) => Math.min(min, d.balanceMinor),
    currentBalanceMinor,
  )
  return {
    nextPaydayDate: paydayIdx === -1 ? null : projection[paydayIdx].date,
    committedBeforePaydayMinor: committed,
    availableMinor: currentBalanceMinor - committed,
    minProjectedBalanceMinor: minBalance,
    negativeDays,
  }
}
