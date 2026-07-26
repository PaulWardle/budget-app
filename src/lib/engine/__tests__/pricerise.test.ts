import { describe, expect, it } from 'vitest'
import { detectPriceChange } from '../pricerise'

const t = (date: string, amountMinor: number) => ({ date, amountMinor })

describe('detectPriceChange', () => {
  it('reports a rise once two consecutive payments agree at the new price', () => {
    const change = detectPriceChange(-3015, [
      t('2026-04-25', -3015),
      t('2026-05-25', -3015),
      t('2026-06-25', -3300),
      t('2026-07-24', -3300),
    ])
    expect(change).toEqual({ fromMinor: 3015, toMinor: 3300, since: '2026-06-25', occurrences: 2 })
  })

  it('waits for a second payment before believing a single deviation', () => {
    expect(
      detectPriceChange(-3015, [t('2026-06-25', -3015), t('2026-07-24', -3300)]),
    ).toBeNull()
  })

  it('accepts the only payment ever seen as the true price', () => {
    const change = detectPriceChange(-999, [t('2026-07-01', -1299)])
    expect(change?.toMinor).toBe(1299)
    expect(change?.occurrences).toBe(1)
  })

  it('ignores sub-threshold differences (under 1% or 50p)', () => {
    expect(
      detectPriceChange(-10000, [t('2026-06-25', -10050), t('2026-07-24', -10050)]),
    ).toBeNull()
  })

  it('detects price drops too', () => {
    const change = detectPriceChange(-4500, [
      t('2026-06-01', -3900),
      t('2026-07-01', -3900),
    ])
    expect(change?.toMinor).toBe(3900)
  })

  it('ignores refunds and returns null with no charges', () => {
    expect(detectPriceChange(-3000, [t('2026-07-01', 3000)])).toBeNull()
  })

  it('does not report unstable, bouncing amounts', () => {
    expect(
      detectPriceChange(-5000, [t('2026-05-25', -6100), t('2026-06-25', -4400), t('2026-07-24', -7200)]),
    ).toBeNull()
  })
})
