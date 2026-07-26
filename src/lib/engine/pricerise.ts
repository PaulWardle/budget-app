// Ledger-driven bill price detection. The Bills page only records a price
// change when the user edits the amount by hand — but real rises arrive as
// bank charges. This compares what a bill's matched transactions actually
// cost against the stored amount and reports a change once it looks stable,
// so forecasts, commitments and insights track the price being charged, not
// the price that was true when the bill was set up.

import type { Minor } from './money'

export interface BillTxn {
  date: string
  amountMinor: Minor // negative for a charge
}

export interface PriceChange {
  /** The stored (old) price, positive. */
  fromMinor: Minor
  /** The newly observed price, positive. */
  toMinor: Minor
  /** Date of the first payment at the new price. */
  since: string
  /** How many consecutive payments have been at the new price. */
  occurrences: number
}

/**
 * Detect a changed price for one bill from its matched transactions.
 *
 * A change is reported when the most recent payment(s) differ from the stored
 * amount by more than 1% AND at least 50p, and the new amount is stable:
 * either the last two payments agree, or there is only one payment at the new
 * amount but it is the only payment seen (a fresh bill). Variable bills that
 * bounce around (differing consecutive amounts) are not reported.
 */
export function detectPriceChange(storedMinor: Minor, txns: BillTxn[]): PriceChange | null {
  const charges = txns
    .filter((t) => t.amountMinor < 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (charges.length === 0) return null
  const stored = Math.abs(storedMinor)
  const latest = Math.abs(charges[charges.length - 1].amountMinor)
  const differs = (a: number, b: number) => Math.abs(a - b) > Math.max(50, Math.round(b * 0.01))
  if (!differs(latest, stored)) return null

  // Stability: the run of most-recent payments at (exactly) the latest amount.
  let run = 0
  for (let i = charges.length - 1; i >= 0; i--) {
    if (Math.abs(charges[i].amountMinor) === latest) run++
    else break
  }
  // One differing payment on its own could be a partial charge or a one-off
  // adjustment — wait for a second at the same amount before believing it,
  // unless it's the only payment ever seen.
  if (run < 2 && charges.length > 1) return null

  return {
    fromMinor: stored,
    toMinor: latest,
    since: charges[charges.length - run].date,
    occurrences: run,
  }
}
