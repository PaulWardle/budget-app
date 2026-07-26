import { describe, expect, it } from 'vitest'
import { monthlyReview, prevMonthOf, reviewableMonths, type ReviewTxn } from '../review'

const base: Omit<ReviewTxn, 'date' | 'amountMinor'> = {
  categoryId: null,
  merchantName: null,
  description: 'x',
  isTransfer: false,
  excludeFromBudget: false,
  isReimbursable: false,
  recurringPaymentId: null,
  isOneOff: false,
  projectId: null,
}

const t = (date: string, amountMinor: number, extra: Partial<ReviewTxn> = {}): ReviewTxn => ({
  ...base,
  date,
  amountMinor,
  ...extra,
})

describe('monthlyReview', () => {
  it('buckets income, bills, everyday, one-offs and projects', () => {
    const r = monthlyReview(
      [
        t('2026-06-01', 200_000), // income
        t('2026-06-02', -50_000, { recurringPaymentId: 'rp1' }), // bill
        t('2026-06-03', -30_000), // everyday
        t('2026-06-04', -20_000, { isOneOff: true }), // one-off
        t('2026-06-05', -10_000, { projectId: 'p1', isOneOff: true }), // project
        t('2026-06-06', -99_999, { isTransfer: true }), // ignored
        t('2026-06-07', -5_000, { isReimbursable: true }), // ignored
      ],
      '2026-06',
    )
    expect(r.incomeMinor).toBe(200_000)
    expect(r.billsMinor).toBe(50_000)
    expect(r.everydayMinor).toBe(30_000)
    expect(r.oneOffMinor).toBe(20_000)
    expect(r.projectMinor).toBe(10_000)
    expect(r.totalOutMinor).toBe(110_000)
    expect(r.netMinor).toBe(90_000)
    expect(r.savingsRatePct).toBe(45)
  })

  it('computes the baseline as the median of up to three prior complete months', () => {
    const txns = [
      t('2026-03-10', -10_000),
      t('2026-04-10', -30_000),
      t('2026-05-10', -20_000),
      t('2026-06-10', -25_000),
    ]
    const r = monthlyReview(txns, '2026-06')
    expect(r.baselineMonths).toBe(3)
    expect(r.baselineMinor).toBe(20_000) // median of 10k/30k/20k
    expect(r.vsBaselineMinor).toBe(5_000)
  })

  it('ignores months at or after the reviewed month for the baseline', () => {
    const r = monthlyReview([t('2026-06-10', -25_000), t('2026-07-10', -90_000)], '2026-06')
    expect(r.baselineMonths).toBe(0)
    expect(r.baselineMinor).toBe(0)
  })

  it('ranks category movers vs the previous month, refunds netted', () => {
    const r = monthlyReview(
      [
        t('2026-05-05', -10_000, { categoryId: 'food' }),
        t('2026-06-05', -18_000, { categoryId: 'food' }),
        t('2026-06-06', 2_000, { categoryId: 'food' }), // refund is income, not netted into spend
        t('2026-05-07', -40_000, { categoryId: 'fuel' }),
        t('2026-06-07', -41_000, { categoryId: 'fuel' }),
      ],
      '2026-06',
    )
    expect(r.prevMonth).toBe('2026-05')
    expect(r.categoryDeltas[0]).toMatchObject({ categoryId: 'food', deltaMinor: 8_000 })
    expect(r.categoryDeltas[1]).toMatchObject({ categoryId: 'fuel', deltaMinor: 1_000 })
  })

  it('reports no previous month when there is no data for it', () => {
    const r = monthlyReview([t('2026-06-05', -1_000)], '2026-06')
    expect(r.prevMonth).toBeNull()
  })

  it('handles a month with no income', () => {
    const r = monthlyReview([t('2026-06-05', -1_000)], '2026-06')
    expect(r.savingsRatePct).toBeNull()
    expect(r.netMinor).toBe(-1_000)
  })
})

describe('prevMonthOf', () => {
  it('handles year boundaries', () => {
    expect(prevMonthOf('2026-01')).toBe('2025-12')
    expect(prevMonthOf('2026-07')).toBe('2026-06')
  })
})

describe('reviewableMonths', () => {
  it('lists complete months with data, newest first', () => {
    const months = reviewableMonths(
      [{ date: '2026-04-10' }, { date: '2026-06-01' }, { date: '2026-07-05' }],
      '2026-07-26',
    )
    expect(months).toEqual(['2026-06', '2026-04'])
  })
})
