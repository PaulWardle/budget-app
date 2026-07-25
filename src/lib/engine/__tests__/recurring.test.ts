import { describe, expect, it } from 'vitest'
import { detectRecurring, normaliseDescription } from '../recurring'

describe('normaliseDescription', () => {
  it('strips references and punctuation', () => {
    expect(normaliseDescription('ACME GYM *8842 REF 0091')).toBe('ACME GYM REF')
    expect(normaliseDescription('TESCO STORES 2841')).toBe('TESCO STORES')
  })
})

describe('detectRecurring', () => {
  it('detects a monthly subscription with slight date drift', () => {
    const txns = [
      { date: '2026-03-03', amountMinor: -4900, description: 'ACME GYM' },
      { date: '2026-04-03', amountMinor: -4900, description: 'ACME GYM' },
      { date: '2026-05-04', amountMinor: -4900, description: 'ACME GYM' },
      { date: '2026-06-03', amountMinor: -4900, description: 'ACME GYM' },
    ]
    const [c] = detectRecurring(txns)
    expect(c).toBeDefined()
    expect(c.frequency).toBe('monthly')
    expect(c.averageAmountMinor).toBe(-4900)
    expect(c.occurrences).toBe(4)
    expect(c.confidence).toBeGreaterThan(0.6)
  })

  it('detects four-weekly payments as four_weekly, not monthly', () => {
    const txns = [
      { date: '2026-01-05', amountMinor: -12000, description: 'GYM MEMBERSHIP' },
      { date: '2026-02-02', amountMinor: -12000, description: 'GYM MEMBERSHIP' },
      { date: '2026-03-02', amountMinor: -12000, description: 'GYM MEMBERSHIP' },
      { date: '2026-03-30', amountMinor: -12000, description: 'GYM MEMBERSHIP' },
    ]
    const [c] = detectRecurring(txns)
    expect(c.frequency).toBe('four_weekly')
    expect(c.nextExpectedDate).toBe('2026-04-27')
  })

  it('files a bill taken on the 1st of each month as monthly, not four-weekly', () => {
    // ~30.4-day mean also sits inside four-weekly's 28±2 window, so the
    // closest fit has to win rather than whichever frequency is checked first.
    const txns = [
      { date: '2026-01-02', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-02-02', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-03-02', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-04-01', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-05-01', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-06-01', amountMinor: -163279, description: 'LEEK MTG' },
      { date: '2026-07-01', amountMinor: -163279, description: 'LEEK MTG' },
    ]
    const [c] = detectRecurring(txns)
    expect(c.frequency).toBe('monthly')
  })

  it('prefers monthly when the dates drift but still land near the same date', () => {
    // 29–31 day gaps read as monthly even though the mean brushes four-weekly's
    // window — monthly is far and away the common case for a bill.
    const txns = [
      { date: '2026-01-05', amountMinor: -962, description: 'INSURANCE DD' },
      { date: '2026-02-03', amountMinor: -962, description: 'INSURANCE DD' },
      { date: '2026-03-04', amountMinor: -962, description: 'INSURANCE DD' },
      { date: '2026-04-02', amountMinor: -962, description: 'INSURANCE DD' },
    ]
    const [c] = detectRecurring(txns)
    expect(c.frequency).toBe('monthly')
  })

  it('detects annual subscriptions', () => {
    const txns = [
      { date: '2024-06-10', amountMinor: -7999, description: 'AMAZON PRIME' },
      { date: '2025-06-10', amountMinor: -7999, description: 'AMAZON PRIME' },
      { date: '2026-06-11', amountMinor: -8499, description: 'AMAZON PRIME' },
    ]
    const [c] = detectRecurring(txns)
    expect(c.frequency).toBe('annual')
    expect(c.priceIncreased).toBe(true)
  })

  it('ignores irregular spending at the same merchant', () => {
    const txns = [
      { date: '2026-06-01', amountMinor: -450, description: 'TESCO STORES' },
      { date: '2026-06-04', amountMinor: -3210, description: 'TESCO STORES' },
      { date: '2026-06-19', amountMinor: -890, description: 'TESCO STORES' },
      { date: '2026-06-28', amountMinor: -1520, description: 'TESCO STORES' },
    ]
    expect(detectRecurring(txns)).toEqual([])
  })

  it('requires at least three occurrences', () => {
    const txns = [
      { date: '2026-05-01', amountMinor: -999, description: 'NETFLIX' },
      { date: '2026-06-01', amountMinor: -999, description: 'NETFLIX' },
    ]
    expect(detectRecurring(txns)).toEqual([])
  })

  it('ignores income (handled separately)', () => {
    const txns = [
      { date: '2026-04-28', amountMinor: 250000, description: 'ACME PAYROLL' },
      { date: '2026-05-28', amountMinor: 250000, description: 'ACME PAYROLL' },
      { date: '2026-06-28', amountMinor: 250000, description: 'ACME PAYROLL' },
    ]
    expect(detectRecurring(txns)).toEqual([])
  })
})
