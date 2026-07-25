import { describe, expect, it } from 'vitest'
import { splitRegularSpend } from '../regular'
import type { RegularTxn } from '../regular'

let seq = 0
const txn = (
  date: string,
  merchant: string,
  amountMinor: number,
  extra: Partial<RegularTxn> = {},
): RegularTxn => ({
  id: `t${seq++}`,
  date,
  merchant,
  amountMinor,
  categoryId: extra.categoryId ?? 'food',
  isTransfer: extra.isTransfer ?? false,
  excludeFromBudget: extra.excludeFromBudget ?? false,
  isReimbursable: extra.isReimbursable ?? false,
  recurringPaymentId: extra.recurringPaymentId ?? null,
})

/** Six months: Tesco every month, one tattoo in March. */
const ytd: RegularTxn[] = [
  ...['01', '02', '03', '04', '05', '06'].map((m) => txn(`2026-${m}-08`, 'TESCO STORES', -12000)),
  ...['01', '03', '05', '06'].map((m) => txn(`2026-${m}-14`, 'SHELL', -6000, { categoryId: 'fuel' })),
  txn('2026-03-20', 'M KIRKE TATTOO', -45000, { categoryId: 'personal' }),
  txn('2026-04-02', 'DFS SOFAS', -80000, { categoryId: 'home' }),
]

describe('splitRegularSpend', () => {
  it('keeps monthly merchants and sets one-offs aside', () => {
    const s = splitRegularSpend(ytd)
    expect(s.monthsInRange).toBe(6)
    expect(s.threshold).toBe(3)
    expect(s.regular.map((r) => r.merchant)).toEqual(['TESCO STORES', 'SHELL'])
    expect(s.adHoc.map((r) => r.merchant)).toEqual(['DFS SOFAS', 'M KIRKE TATTOO'])
  })

  it('totals the two sides separately', () => {
    const s = splitRegularSpend(ytd)
    expect(s.regularTotalMinor).toBe(6 * 12000 + 4 * 6000)
    expect(s.adHocTotalMinor).toBe(45000 + 80000)
    expect(s.regularPerMonthMinor).toBe(Math.round((6 * 12000 + 4 * 6000) / 6))
  })

  it('counts distinct months, so a burst of visits is still a one-off', () => {
    const burst = [
      ...['01', '02', '03', '04', '05', '06'].map((m) => txn(`2026-${m}-08`, 'TESCO STORES', -12000)),
      txn('2026-02-01', 'FESTIVAL BAR', -3000),
      txn('2026-02-02', 'FESTIVAL BAR', -3000),
      txn('2026-02-03', 'FESTIVAL BAR', -3000),
      txn('2026-02-04', 'FESTIVAL BAR', -3000),
    ]
    const s = splitRegularSpend(burst)
    expect(s.adHoc.map((r) => r.merchant)).toEqual(['FESTIVAL BAR'])
    expect(s.adHoc[0].txnCount).toBe(4)
    expect(s.adHoc[0].monthsSeen).toBe(1)
  })

  it('excludes bills, transfers, refunds and excluded rows', () => {
    const s = splitRegularSpend([
      ...['01', '02', '03'].map((m) => txn(`2026-${m}-08`, 'TESCO STORES', -12000)),
      ...['01', '02', '03'].map((m) => txn(`2026-${m}-01`, 'LEEK MTG', -163279, { recurringPaymentId: 'm' })),
      ...['01', '02', '03'].map((m) => txn(`2026-${m}-02`, 'SAVINGS', -20000, { isTransfer: true })),
      txn('2026-01-05', 'WORK EXPENSES', -5000, { isReimbursable: true }),
      txn('2026-01-06', 'IGNORED', -5000, { excludeFromBudget: true }),
    ])
    expect(s.regular.map((r) => r.merchant)).toEqual(['TESCO STORES'])
    expect(s.adHoc).toEqual([])
  })

  it('rolls regular merchants up by category', () => {
    const s = splitRegularSpend(ytd)
    const food = s.byCategory.find((c) => c.categoryId === 'food')
    expect(food?.regularMinor).toBe(6 * 12000)
    expect(food?.perMonthMinor).toBe(12000)
    expect(food?.merchants).toBe(1)
    expect(s.byCategory.some((c) => c.categoryId === 'personal')).toBe(false)
  })

  it('files a merchant under wherever most of its money went', () => {
    const s = splitRegularSpend([
      txn('2026-01-08', 'TESCO STORES', -2000, { categoryId: 'household' }),
      txn('2026-02-08', 'TESCO STORES', -30000, { categoryId: 'food' }),
      txn('2026-03-08', 'TESCO STORES', -30000, { categoryId: 'food' }),
    ])
    expect(s.regular[0].categoryId).toBe('food')
  })

  it('reports the largest single hit so a spike inside a regular shop is visible', () => {
    const s = splitRegularSpend([
      ...['01', '02', '03'].map((m) => txn(`2026-${m}-08`, 'TESCO STORES', -12000)),
      txn('2026-03-09', 'TESCO STORES', -90000),
    ])
    expect(s.regular[0].largestMinor).toBe(90000)
  })
})
