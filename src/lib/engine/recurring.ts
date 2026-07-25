// Deterministic recurring-payment detection. Groups transactions by
// normalised description and looks for consistent intervals and amounts.
// Detection produces *candidates for user confirmation* — nothing is saved
// automatically, and a missing payment never auto-cancels anything.

import type { Minor } from './money'

export interface RecurringCandidate {
  key: string
  description: string
  frequency:
    | 'weekly'
    | 'fortnightly'
    | 'monthly'
    | 'four_weekly'
    | 'quarterly'
    | 'six_monthly'
    | 'annual'
  averageAmountMinor: Minor
  lastAmountMinor: Minor
  lastDate: string
  nextExpectedDate: string
  occurrences: number
  amountVariancePct: number
  confidence: number // 0–1
  priceIncreased: boolean
}

interface TxnLike {
  date: string
  amountMinor: Minor
  description: string
}

export function normaliseDescription(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\d{2,}/g, '') // strip long digit runs (references, card numbers)
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const FREQUENCIES: { name: RecurringCandidate['frequency']; days: number; tolerance: number }[] = [
  { name: 'weekly', days: 7, tolerance: 1 },
  { name: 'fortnightly', days: 14, tolerance: 2 },
  { name: 'four_weekly', days: 28, tolerance: 2 },
  { name: 'monthly', days: 30.44, tolerance: 4 },
  { name: 'quarterly', days: 91.3, tolerance: 7 },
  { name: 'six_monthly', days: 182.6, tolerance: 10 },
  { name: 'annual', days: 365.25, tolerance: 15 },
]

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  )
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

/**
 * Detect recurring outgoing payments. Requires ≥3 occurrences with a
 * consistent interval and amounts within 35% of the median.
 */
export function detectRecurring(txns: TxnLike[]): RecurringCandidate[] {
  const groups = new Map<string, TxnLike[]>()
  for (const t of txns) {
    if (t.amountMinor >= 0) continue // outgoings only; income handled separately
    const key = normaliseDescription(t.description)
    if (key.length < 3) continue
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }

  const results: RecurringCandidate[] = []
  for (const [key, list] of groups) {
    if (list.length < 3) continue
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    const intervals: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date))
    }
    const meanInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length

    // Take the closest-fitting frequency, not the first one whose tolerance
    // window happens to contain the mean. Monthly bills average ~30.4 days,
    // which also falls inside four-weekly's 28±2 window — first-match order
    // would file every monthly bill as four-weekly and over-count it by one
    // payment a year.
    const fits = FREQUENCIES.filter(
      (f) =>
        Math.abs(meanInterval - f.days) <= f.tolerance &&
        intervals.every((iv) => Math.abs(iv - f.days) <= f.tolerance * 2),
    ).map((f) => ({ f, error: Math.abs(meanInterval - f.days) / f.days }))
    if (fits.length === 0) continue

    let best = fits.reduce((a, b) => (b.error < a.error ? b : a))
    // Monthly is overwhelmingly the common case, and the two windows overlap.
    // Where monthly is a plausible reading, prefer it unless four-weekly fits
    // more than twice as well — i.e. the dates really do walk backwards
    // through the month rather than landing on the same date each time.
    const monthly = fits.find((x) => x.f.name === 'monthly')
    if (monthly && best.f.name === 'four_weekly' && best.error > monthly.error / 2) {
      best = monthly
    }

    const amounts = sorted.map((t) => Math.abs(t.amountMinor))
    const median = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)]
    const maxDeviation = Math.max(...amounts.map((a) => Math.abs(a - median) / median))
    if (maxDeviation > 0.35) continue

    const last = sorted[sorted.length - 1]
    const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length)
    const intervalConsistency =
      1 -
      Math.min(
        1,
        intervals.reduce((a, iv) => a + Math.abs(iv - best.f.days), 0) / (intervals.length * best.f.days),
      )
    const confidence = Math.min(
      0.99,
      0.4 + 0.1 * Math.min(5, sorted.length) + 0.3 * intervalConsistency - 0.2 * maxDeviation,
    )
    const prevAmount = amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[0]
    results.push({
      key,
      description: last.description,
      frequency: best.f.name,
      averageAmountMinor: -avg,
      lastAmountMinor: -amounts[amounts.length - 1],
      lastDate: last.date,
      nextExpectedDate: isoAddDays(last.date, best.f.days),
      occurrences: sorted.length,
      amountVariancePct: Math.round(maxDeviation * 100),
      confidence: Math.max(0, Math.min(1, confidence)),
      priceIncreased: amounts[amounts.length - 1] > prevAmount * 1.02,
    })
  }
  return results.sort((a, b) => b.confidence - a.confidence)
}
