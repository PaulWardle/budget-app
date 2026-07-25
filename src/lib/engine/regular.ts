// Separating habitual spending from one-offs.
//
// A year-to-date total mixes two different things: the shops you go back to
// every month (food, fuel, coffee) and one-off events (a tattoo, a sofa, a
// holiday). Averaging them together produces a "monthly spend" that describes
// no actual month. This splits them so the recurring side can be reviewed as a
// running cost, and the one-offs listed separately as what they are.
//
// Classification is by *merchant*, not category, because one-offs usually hide
// inside otherwise ordinary categories. Recurrence is measured in distinct
// months, so twelve visits in one week is still a one-off event.

import type { Minor } from './money'

export interface RegularTxn {
  id: string
  date: string // ISO
  merchant: string
  amountMinor: Minor // negative = out
  categoryId: string | null
  isTransfer: boolean
  excludeFromBudget: boolean
  isReimbursable?: boolean
  recurringPaymentId?: string | null
}

export interface SpendRow {
  merchant: string
  categoryId: string | null
  monthsSeen: number
  txnCount: number
  totalMinor: Minor // positive
  perMonthMinor: Minor // total spread over the months in range
  largestMinor: Minor
  lastDate: string
}

export interface RegularSplit {
  monthsInRange: number
  /** Merchants seen in enough separate months to count as a running cost. */
  regular: SpendRow[]
  adHoc: SpendRow[]
  regularTotalMinor: Minor
  adHocTotalMinor: Minor
  regularPerMonthMinor: Minor
  byCategory: {
    categoryId: string | null
    regularMinor: Minor
    perMonthMinor: Minor
    merchants: number
  }[]
  /** Months required before a merchant counts as regular, for display. */
  threshold: number
}

const monthOf = (iso: string): string => iso.slice(0, 7)

function isEveryday(t: RegularTxn): boolean {
  return (
    t.amountMinor < 0 &&
    !t.isTransfer &&
    !t.excludeFromBudget &&
    !t.isReimbursable &&
    !t.recurringPaymentId
  )
}

/**
 * Split everyday spending into recurring merchants and one-offs.
 *
 * A merchant is regular when it appears in at least half the months covered,
 * and never on fewer than three separate months — one repeat visit is a
 * coincidence, not a habit. Bills are already excluded; they are tracked as
 * recurring payments in their own right.
 */
export function splitRegularSpend(txns: RegularTxn[]): RegularSplit {
  const everyday = txns.filter(isEveryday)
  const monthsPresent = new Set(everyday.map((t) => monthOf(t.date)))
  const monthsInRange = Math.max(1, monthsPresent.size)
  const threshold = Math.max(3, Math.ceil(monthsInRange * 0.5))

  const byMerchant = new Map<
    string,
    {
      months: Set<string>
      txnCount: number
      totalMinor: number
      largestMinor: number
      lastDate: string
      categories: Map<string | null, number>
    }
  >()

  for (const t of everyday) {
    const key = t.merchant.trim().toUpperCase()
    if (!key) continue
    const entry = byMerchant.get(key) ?? {
      months: new Set<string>(),
      txnCount: 0,
      totalMinor: 0,
      largestMinor: 0,
      lastDate: t.date,
      categories: new Map<string | null, number>(),
    }
    const amount = -t.amountMinor
    entry.months.add(monthOf(t.date))
    entry.txnCount += 1
    entry.totalMinor += amount
    entry.largestMinor = Math.max(entry.largestMinor, amount)
    if (t.date > entry.lastDate) entry.lastDate = t.date
    entry.categories.set(t.categoryId, (entry.categories.get(t.categoryId) ?? 0) + amount)
    byMerchant.set(key, entry)
  }

  const rows: SpendRow[] = [...byMerchant.entries()].map(([merchant, e]) => {
    // Attribute the merchant to wherever most of its money was filed.
    const categoryId = [...e.categories.entries()].sort((a, b) => b[1] - a[1])[0][0]
    return {
      merchant,
      categoryId,
      monthsSeen: e.months.size,
      txnCount: e.txnCount,
      totalMinor: e.totalMinor,
      perMonthMinor: Math.round(e.totalMinor / monthsInRange),
      largestMinor: e.largestMinor,
      lastDate: e.lastDate,
    }
  })

  const regular = rows
    .filter((r) => r.monthsSeen >= threshold)
    .sort((a, b) => b.totalMinor - a.totalMinor)
  const adHoc = rows
    .filter((r) => r.monthsSeen < threshold)
    .sort((a, b) => b.totalMinor - a.totalMinor)

  const regularTotalMinor = regular.reduce((s, r) => s + r.totalMinor, 0)
  const adHocTotalMinor = adHoc.reduce((s, r) => s + r.totalMinor, 0)

  const catMap = new Map<string | null, { total: number; merchants: number }>()
  for (const r of regular) {
    const cur = catMap.get(r.categoryId) ?? { total: 0, merchants: 0 }
    cur.total += r.totalMinor
    cur.merchants += 1
    catMap.set(r.categoryId, cur)
  }
  const byCategory = [...catMap.entries()]
    .map(([categoryId, v]) => ({
      categoryId,
      regularMinor: v.total,
      perMonthMinor: Math.round(v.total / monthsInRange),
      merchants: v.merchants,
    }))
    .sort((a, b) => b.regularMinor - a.regularMinor)

  return {
    monthsInRange,
    regular,
    adHoc,
    regularTotalMinor,
    adHocTotalMinor,
    regularPerMonthMinor: Math.round(regularTotalMinor / monthsInRange),
    byCategory,
    threshold,
  }
}
