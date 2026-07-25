import { describe, expect, it } from 'vitest'
import { dedupeHash, findDuplicates, type ExistingTxn } from '../duplicates'

const existing: ExistingTxn[] = [
  {
    id: 'e1',
    accountId: 'halifax',
    date: '2026-07-10',
    amountMinor: -450,
    description: 'STARBUCKS 2841 LEEDS',
    runningBalanceMinor: 120000,
  },
]

describe('dedupeHash', () => {
  it('is stable across reference-number noise', () => {
    const a = dedupeHash({ accountId: 'x', date: '2026-07-10', amountMinor: -450, description: 'STARBUCKS 2841 LEEDS' })
    const b = dedupeHash({ accountId: 'x', date: '2026-07-10', amountMinor: -450, description: 'STARBUCKS 9917 LEEDS' })
    expect(a).toBe(b)
  })
})

describe('findDuplicates', () => {
  it('flags exact re-imports with score 1', () => {
    const [m] = findDuplicates(
      { accountId: 'halifax', date: '2026-07-10', amountMinor: -450, description: 'STARBUCKS 1234 LEEDS' },
      existing,
    )
    expect(m.score).toBe(1)
    expect(m.existingId).toBe('e1')
  })

  it('same merchant/amount/day with a DIFFERENT running balance scores low (two real coffees)', () => {
    const [m] = findDuplicates(
      {
        accountId: 'halifax',
        date: '2026-07-10',
        amountMinor: -450,
        description: 'STARBUCKS 7777 LEEDS',
        runningBalanceMinor: 119550,
      },
      existing,
    )
    expect(m.score).toBeLessThan(0.7)
    expect(m.reasons.join(' ')).toContain('running balance')
  })

  it('flags same-day same-amount rows as likely duplicates even when the wording differs (CSV vs PDF)', () => {
    const [m] = findDuplicates(
      { accountId: 'halifax', date: '2026-07-10', amountMinor: -450, description: 'Card payment to SB Coffee' },
      existing,
    )
    expect(m.score).toBeGreaterThanOrEqual(0.75)
  })

  it('does not match across accounts or amounts', () => {
    expect(
      findDuplicates(
        { accountId: 'monzo', date: '2026-07-10', amountMinor: -450, description: 'STARBUCKS LEEDS' },
        existing,
      ),
    ).toEqual([])
    expect(
      findDuplicates(
        { accountId: 'halifax', date: '2026-07-10', amountMinor: -451, description: 'STARBUCKS LEEDS' },
        existing,
      ),
    ).toEqual([])
  })

  it('matches within a ±3 day window but not beyond', () => {
    const near = findDuplicates(
      { accountId: 'halifax', date: '2026-07-12', amountMinor: -450, description: 'STARBUCKS LEEDS' },
      existing,
    )
    expect(near.length).toBe(1)
    const far = findDuplicates(
      { accountId: 'halifax', date: '2026-07-20', amountMinor: -450, description: 'STARBUCKS LEEDS' },
      existing,
    )
    expect(far).toEqual([])
  })
})
