import { describe, expect, it } from 'vitest'
import { everydayBaseline, forecastMonthEnd, typicalSpendItems } from '../forecast'
import type { ForecastTxn } from '../forecast'

const txn = (date: string, amountMinor: number, extra: Partial<ForecastTxn> = {}): ForecastTxn => ({
  date,
  amountMinor,
  categoryId: extra.categoryId ?? 'groceries',
  isTransfer: extra.isTransfer ?? false,
  excludeFromBudget: extra.excludeFromBudget ?? false,
  isReimbursable: extra.isReimbursable ?? false,
  recurringPaymentId: extra.recurringPaymentId ?? null,
})

/** Three complete months of everyday spending: £400, £600, £500. */
const threeMonths: ForecastTxn[] = [
  txn('2026-04-10', -40000),
  txn('2026-05-10', -60000),
  txn('2026-06-10', -50000),
]

describe('everydayBaseline', () => {
  it('takes the median of recent complete months', () => {
    const b = everydayBaseline(threeMonths, '2026-07-25')
    expect(b.monthsUsed).toBe(3)
    expect(b.perMonthMinor).toBe(50000)
    expect(b.lowMinor).toBe(40000)
    expect(b.highMinor).toBe(60000)
  })

  it('excludes the current month so a part-month does not drag it down', () => {
    const b = everydayBaseline([...threeMonths, txn('2026-07-02', -1000)], '2026-07-25')
    expect(b.monthsUsed).toBe(3)
    expect(b.months.map((m) => m.month)).toEqual(['2026-04', '2026-05', '2026-06'])
  })

  it('excludes bills, transfers, refunds and excluded rows', () => {
    const b = everydayBaseline(
      [
        txn('2026-06-01', -50000),
        txn('2026-06-02', -163279, { recurringPaymentId: 'mortgage' }),
        txn('2026-06-03', -20000, { isTransfer: true }),
        txn('2026-06-04', -20000, { excludeFromBudget: true }),
        txn('2026-06-05', -20000, { isReimbursable: true }),
        txn('2026-06-06', 250000),
      ],
      '2026-07-25',
      1,
    )
    expect(b.perMonthMinor).toBe(50000)
  })

  it('leaves out anything the user marked as a one-off', () => {
    const b = everydayBaseline(
      [...threeMonths, { ...txn('2026-05-20', -28000), isOneOff: true }],
      '2026-07-25',
    )
    expect(b.perMonthMinor).toBe(50000) // the £280 tattoo does not lift the median
    expect(b.contributors.some((c) => c.amountMinor === -28000)).toBe(false)
  })

  it('lists what it measured, largest first, so it can be checked', () => {
    const b = everydayBaseline(threeMonths, '2026-07-25')
    expect(b.contributors).toHaveLength(3)
    expect(b.contributors[0].amountMinor).toBe(-60000)
  })

  it('reports low confidence with no complete months', () => {
    const b = everydayBaseline([txn('2026-07-02', -1000)], '2026-07-25')
    expect(b.monthsUsed).toBe(0)
    expect(b.perDayMinor).toBe(0)
    expect(b.confidence).toBe('low')
  })
})

describe('forecastMonthEnd', () => {
  it('projects the rest of the month from the baseline, including a negative outcome', () => {
    const baseline = everydayBaseline(threeMonths, '2026-07-25') // £500/mo ≈ £16.44/day
    const f = forecastMonthEnd({
      today: '2026-07-25',
      currentBalanceMinor: 20000, // £200 in the account
      monthTxns: [txn('2026-07-05', -30000), txn('2026-07-06', -163279, { recurringPaymentId: 'm' })],
      baseline,
      remainingScheduled: [
        { date: '2026-07-29', name: 'Council tax', amountMinor: -20000, source: 'recurring' },
      ],
    })
    expect(f.daysRemaining).toBe(6)
    expect(f.everydaySpentMinor).toBe(30000)
    expect(f.billsPaidMinor).toBe(163279)
    expect(f.billsRemainingMinor).toBe(20000)
    expect(f.everydayRemainingMinor).toBe(baseline.perDayMinor * 6)
    // £200 − 6 days of everyday spend − £200 council tax lands below zero, and
    // the forecast is expected to say so rather than stopping at the bills.
    expect(f.forecastEndBalanceMinor).toBeLessThan(0)
    expect(f.basis).toBe('baseline')
    expect(f.confidence).toBe('high')
  })

  it('falls back to this month’s own pace when there is no history', () => {
    const baseline = everydayBaseline([], '2026-07-10')
    const f = forecastMonthEnd({
      today: '2026-07-10',
      currentBalanceMinor: 100000,
      monthTxns: [txn('2026-07-05', -10000)],
      baseline,
      remainingScheduled: [],
    })
    expect(f.basis).toBe('this_month')
    // £100/day so far over 10 days → £10/day for the 21 days remaining
    expect(f.everydayRemainingMinor).toBe(1000 * 21)
  })

  it('flags running hot against the baseline', () => {
    const baseline = everydayBaseline(threeMonths, '2026-07-15')
    const f = forecastMonthEnd({
      today: '2026-07-15',
      currentBalanceMinor: 100000,
      monthTxns: [txn('2026-07-05', -60000)],
      baseline,
      remainingScheduled: [],
    })
    expect(f.paceRatio).toBeGreaterThan(2)
  })

  it('counts income still expected before month end', () => {
    const f = forecastMonthEnd({
      today: '2026-07-25',
      currentBalanceMinor: 10000,
      monthTxns: [],
      baseline: everydayBaseline([], '2026-07-25'),
      remainingScheduled: [
        { date: '2026-07-28', name: 'Salary', amountMinor: 250000, source: 'recurring' },
      ],
    })
    expect(f.incomeRemainingMinor).toBe(250000)
    expect(f.forecastEndBalanceMinor).toBe(260000)
  })
})

describe('typicalSpendItems', () => {
  it('spreads the daily rate across the horizon', () => {
    const items = typicalSpendItems(1000, '2026-07-25', 3)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.date)).toEqual(['2026-07-25', '2026-07-26', '2026-07-27'])
    expect(items.every((i) => i.amountMinor === -1000 && i.source === 'typical')).toBe(true)
  })

  it('produces nothing when there is no measured rate', () => {
    expect(typicalSpendItems(0, '2026-07-25', 30)).toEqual([])
  })
})
