// Deterministic money maths. All values are integer minor units (pence).
// Floating point is never used to represent an amount — only transiently for
// rate maths, with explicit rounding back to integers.

export type Minor = number

export function assertMinor(value: number): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount must be an integer number of minor units, got ${value}`)
  }
  return value
}

export function sumMinor(values: Iterable<Minor>): Minor {
  let total = 0
  for (const v of values) total += assertMinor(v)
  return total
}

/** Round half away from zero — matches how banks round pence. */
export function roundHalfAwayFromZero(value: number): Minor {
  const sign = value < 0 ? -1 : 1
  return sign * Math.round(Math.abs(value))
}

/** Parse user input like "1,234.56", "£12", "-£3.20", "12.5" into minor units. */
export function parseToMinor(input: string): Minor | null {
  const cleaned = input.replace(/[£$€,\s]/g, '')
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '-') return null
  const negative = cleaned.startsWith('-')
  const [whole, frac = ''] = cleaned.replace('-', '').split('.')
  const minor = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(minor)) return null
  return negative ? -minor : minor
}

export function formatMinor(
  minor: Minor,
  opts: { currency?: string; showSign?: boolean; compact?: boolean } = {},
): string {
  const { currency = 'GBP', showSign = false, compact = false } = opts
  const abs = Math.abs(minor) / 100
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: compact && abs >= 1000 ? 0 : 2,
    maximumFractionDigits: compact && abs >= 1000 ? 0 : 2,
  }).format(abs)
  if (minor < 0) return `-${formatted}`
  if (showSign && minor > 0) return `+${formatted}`
  return formatted
}

/**
 * Split `total` proportionally to `weights` without losing pence
 * (largest-remainder method). Guarantees the parts sum exactly to `total`.
 */
export function allocateMinor(total: Minor, weights: number[]): Minor[] {
  assertMinor(total)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  if (weightSum <= 0) throw new Error('allocateMinor requires positive weights')
  const raw = weights.map((w) => (total * w) / weightSum)
  const floors = raw.map((r) => (total >= 0 ? Math.floor(r) : Math.ceil(r)))
  let remainder = total - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - floors[i]) }))
    .sort((a, b) => b.frac - a.frac)
  const result = [...floors]
  const step = total >= 0 ? 1 : -1
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    result[order[k].i] += step
    remainder -= step
  }
  return result
}

/** Percentage (0–100+) of used vs budget, safe for zero budgets. */
export function percentUsed(actual: Minor, budget: Minor): number {
  if (budget === 0) return actual === 0 ? 0 : Infinity
  return (Math.abs(actual) / Math.abs(budget)) * 100
}
