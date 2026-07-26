// Reconciling presumed bill postings against actuals. The app posts an
// "expected" transaction when a bill falls due (like an energy estimate);
// when a statement upload brings the real ledger, each presumption is
// resolved: replaced by its real payment, expired if the statement covers
// the due date but the bill never went out, or kept if the statement
// doesn't reach that far yet.

export interface PresumedTxn {
  id: string
  accountId: string
  date: string // ISO
  amountMinor: number // negative
  recurringPaymentId: string | null
}

export interface ActualTxn {
  id: string
  accountId: string
  date: string
  amountMinor: number
  recurringPaymentId: string | null
}

export interface Reconciliation {
  /** presumption → the real transaction that supersedes it */
  matched: { presumedId: string; actualId: string }[]
  /** statement covered the due date, bill never appeared — remove + flag */
  expired: PresumedTxn[]
  /** statement doesn't reach this far yet — presumption stands */
  kept: PresumedTxn[]
}

const DAY = 86_400_000
const daysBetween = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY)

/** Same bill, or close enough in amount and date to be the same payment. */
function isMatch(p: PresumedTxn, t: ActualTxn): boolean {
  if (t.amountMinor >= 0) return false
  if (p.recurringPaymentId && t.recurringPaymentId === p.recurringPaymentId)
    return daysBetween(p.date, t.date) <= 7
  const tolerance = Math.max(200, Math.round(Math.abs(p.amountMinor) * 0.1))
  return (
    Math.abs(t.amountMinor - p.amountMinor) <= tolerance &&
    daysBetween(p.date, t.date) <= 5
  )
}

/**
 * @param coverageEnd newest REAL transaction date per account — how far the
 *   statements go. A presumption safely inside that window (3-day grace for
 *   late direct debits) with no matching actual means the charge never
 *   happened.
 */
export function reconcilePresumptions(
  presumed: PresumedTxn[],
  actuals: ActualTxn[],
  coverageEnd: Map<string, string>,
): Reconciliation {
  const out: Reconciliation = { matched: [], expired: [], kept: [] }
  const taken = new Set<string>()
  for (const p of [...presumed].sort((a, b) => a.date.localeCompare(b.date))) {
    const real = actuals
      .filter((t) => !taken.has(t.id) && isMatch(p, t))
      .sort((a, b) => daysBetween(p.date, a.date) - daysBetween(p.date, b.date))[0]
    if (real) {
      taken.add(real.id)
      out.matched.push({ presumedId: p.id, actualId: real.id })
      continue
    }
    const end = coverageEnd.get(p.accountId)
    if (end && daysBetween(p.date, end) >= 3 && p.date < end) out.expired.push(p)
    else out.kept.push(p)
  }
  return out
}

/**
 * The balance an account should show: the last statement-confirmed balance,
 * minus any presumptions dated after the statement ends. Used after every
 * import so corrections land in one deterministic place.
 */
export function presumedAdjustedBalance(
  statementBalanceMinor: number,
  statementEndDate: string,
  remainingPresumed: PresumedTxn[],
): number {
  return remainingPresumed
    .filter((p) => p.date > statementEndDate)
    .reduce((sum, p) => sum + p.amountMinor, statementBalanceMinor)
}
