import { describe, expect, it } from 'vitest'
import {
  presumedAdjustedBalance,
  reconcilePresumptions,
  type ActualTxn,
  type PresumedTxn,
} from '../presume'

const presumed = (over: Partial<PresumedTxn> = {}): PresumedTxn => ({
  id: 'p1',
  accountId: 'acc1',
  date: '2026-08-01',
  amountMinor: -3300,
  recurringPaymentId: 'rp1',
  ...over,
})

const actual = (over: Partial<ActualTxn> = {}): ActualTxn => ({
  id: 't1',
  accountId: 'acc1',
  date: '2026-08-01',
  amountMinor: -3300,
  recurringPaymentId: null,
  ...over,
})

describe('reconcilePresumptions', () => {
  it('replaces a presumption with its linked real payment', () => {
    const r = reconcilePresumptions(
      [presumed()],
      [actual({ recurringPaymentId: 'rp1', date: '2026-08-03' })],
      new Map([['acc1', '2026-08-10']]),
    )
    expect(r.matched).toEqual([{ presumedId: 'p1', actualId: 't1' }])
    expect(r.expired).toHaveLength(0)
    expect(r.kept).toHaveLength(0)
  })

  it('matches by amount+date when the real txn is not linked to the bill', () => {
    const r = reconcilePresumptions(
      [presumed()],
      [actual({ date: '2026-08-02', amountMinor: -3350 })], // within 10%/£2
      new Map([['acc1', '2026-08-20']]),
    )
    expect(r.matched).toHaveLength(1)
  })

  it('expires a presumption the statement disproves', () => {
    const r = reconcilePresumptions(
      [presumed()],
      [actual({ amountMinor: -9999, date: '2026-08-15' })], // unrelated spend
      new Map([['acc1', '2026-08-15']]),
    )
    expect(r.expired.map((p) => p.id)).toEqual(['p1'])
  })

  it('keeps a presumption the statement has not reached', () => {
    const r = reconcilePresumptions(
      [presumed({ date: '2026-08-20' })],
      [],
      new Map([['acc1', '2026-08-10']]),
    )
    expect(r.kept.map((p) => p.id)).toEqual(['p1'])
  })

  it('keeps a presumption inside the 3-day grace window for late debits', () => {
    const r = reconcilePresumptions(
      [presumed({ date: '2026-08-09' })],
      [],
      new Map([['acc1', '2026-08-10']]),
    )
    expect(r.kept).toHaveLength(1)
    expect(r.expired).toHaveLength(0)
  })

  it('does not let one real payment satisfy two presumptions', () => {
    const r = reconcilePresumptions(
      [presumed(), presumed({ id: 'p2', date: '2026-08-02' })],
      [actual({ recurringPaymentId: 'rp1' })],
      new Map([['acc1', '2026-08-20']]),
    )
    expect(r.matched).toHaveLength(1)
    expect(r.expired).toHaveLength(1)
  })

  it('never matches against money in', () => {
    const r = reconcilePresumptions(
      [presumed()],
      [actual({ amountMinor: 3300 })],
      new Map(),
    )
    expect(r.matched).toHaveLength(0)
    expect(r.kept).toHaveLength(1)
  })
})

describe('presumedAdjustedBalance', () => {
  it('subtracts only presumptions after the statement end', () => {
    expect(
      presumedAdjustedBalance(100_000, '2026-08-10', [
        presumed({ date: '2026-08-15', amountMinor: -5000 }),
        presumed({ id: 'p2', date: '2026-08-05', amountMinor: -9000 }), // already in statement window
      ]),
    ).toBe(95_000)
  })

  it('returns the statement balance when nothing is pending', () => {
    expect(presumedAdjustedBalance(42, '2026-08-10', [])).toBe(42)
  })
})
