// Deterministic matching for learned categorisation rules.
//
// Matching is WORD-BOUNDARY aware, not naive substring: a short matcher like
// "EE" must not fire inside "LEEK MTG" (a mortgage) and "BP" must not fire
// inside "BPAY". Boundaries are any character that is not a letter or digit,
// so "TESCO" still matches "TESCO STORES 3021" and "B&Q" still matches
// "B&Q 1234" — but never mid-word.

export type MatchType = 'contains' | 'exact' | 'starts_with'

const isAlnum = (ch: string | undefined): boolean => !!ch && /[A-Z0-9]/.test(ch)

/** Does `matcher` match `haystack` under `matchType`? Both are compared
 * case-insensitively; `contains` and `starts_with` respect word boundaries. */
export function ruleMatches(haystack: string, matcher: string, matchType: MatchType = 'contains'): boolean {
  const hay = haystack.toUpperCase()
  const needle = matcher.trim().toUpperCase()
  if (!needle) return false
  if (matchType === 'exact') return hay === needle
  if (matchType === 'starts_with') {
    if (!hay.startsWith(needle)) return false
    return !isAlnum(hay[needle.length])
  }
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? undefined : hay[at - 1]
    const after = hay[at + needle.length]
    if (!isAlnum(before) && !isAlnum(after)) return true
    from = at + 1
  }
}
