// Deterministic duplicate detection for imports. Produces a score in [0,1];
// high scores are flagged for review, never silently deleted. Legitimate
// same-day same-amount purchases are distinguished by running balance and
// description differences where available.

import type { Minor } from './money'
import { normaliseDescription } from './recurring'

export interface DedupeCandidate {
  date: string
  amountMinor: Minor
  description: string
  accountId: string
  runningBalanceMinor?: Minor | null
}

export interface ExistingTxn extends DedupeCandidate {
  id: string
}

/** Stable hash key for exact-duplicate lookup (account+date+amount+normalised description). */
export function dedupeHash(t: DedupeCandidate): string {
  return [t.accountId, t.date, t.amountMinor, normaliseDescription(t.description)].join('|')
}

export interface DuplicateMatch {
  existingId: string
  score: number // 0–1
  reasons: string[]
}

/**
 * Score a proposed import against existing transactions within ±3 days.
 * Exact hash match → 1.0. Same account/amount within window scores by
 * description similarity and running-balance agreement.
 */
export function findDuplicates(
  candidate: DedupeCandidate,
  existing: ExistingTxn[],
): DuplicateMatch[] {
  const candHash = dedupeHash(candidate)
  const candNorm = normaliseDescription(candidate.description)
  const matches: DuplicateMatch[] = []
  for (const e of existing) {
    if (e.accountId !== candidate.accountId) continue
    if (e.amountMinor !== candidate.amountMinor) continue
    const dayDiff = Math.abs(
      (Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${candidate.date}T00:00:00Z`)) / 86_400_000,
    )
    if (dayDiff > 3) continue

    const balancesDisagree =
      candidate.runningBalanceMinor != null &&
      e.runningBalanceMinor != null &&
      candidate.runningBalanceMinor !== e.runningBalanceMinor
    if (dedupeHash(e) === candHash && !balancesDisagree) {
      matches.push({ existingId: e.id, score: 1, reasons: ['exact match'] })
      continue
    }

    let score = 0.5
    const reasons = ['same account, amount and date window']
    const sim = tokenSimilarity(candNorm, normaliseDescription(e.description))
    score += sim * 0.3
    if (sim > 0.6) reasons.push('similar description')
    if (dayDiff === 0) {
      score += 0.1
      reasons.push('same day')
    }
    if (
      candidate.runningBalanceMinor != null &&
      e.runningBalanceMinor != null
    ) {
      if (candidate.runningBalanceMinor === e.runningBalanceMinor) {
        score += 0.1
        reasons.push('matching running balance')
      } else {
        // Different running balances on the same day strongly suggest two
        // genuine transactions (e.g. two identical coffees).
        score -= 0.35
        reasons.push('different running balance — may be a separate purchase')
      }
    }
    matches.push({ existingId: e.id, score: Math.max(0, Math.min(1, score)), reasons })
  }
  return matches.sort((a, b) => b.score - a.score)
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const ta = new Set(a.split(' ').filter(Boolean))
  const tb = new Set(b.split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return common / Math.max(ta.size, tb.size)
}
