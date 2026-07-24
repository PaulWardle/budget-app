import { describe, expect, it } from 'vitest'
import {
  expandRecurring,
  projectDailyBalances,
  safeToSpend,
  type ProjectedItem,
} from '../cashflow'

describe('expandRecurring', () => {
  it('expands monthly commitments and clamps month-end dates', () => {
    const dates = expandRecurring(
      { name: 'Rent', amountMinor: -80000, frequency: 'monthly', nextDueDate: '2026-01-31' },
      '2026-01-01',
      '2026-04-30',
    ).map((x) => x.date)
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('expands four-weekly and weekly frequencies', () => {
    const fourWeekly = expandRecurring(
      { name: 'Gym', amountMinor: -3000, frequency: 'four_weekly', nextDueDate: '2026-07-01' },
      '2026-07-01',
      '2026-08-31',
    )
    expect(fourWeekly.map((x) => x.date)).toEqual(['2026-07-01', '2026-07-29', '2026-08-26'])
  })
})

describe('projectDailyBalances + safeToSpend', () => {
  it('projects balances, finds negative days and payday-aware availability', () => {
    const items: ProjectedItem[] = [
      { date: '2026-07-25', name: 'Car finance', amountMinor: -30000, source: 'recurring' },
      { date: '2026-07-27', name: 'Energy', amountMinor: -15000, source: 'recurring' },
      { date: '2026-07-28', name: 'Salary', amountMinor: 250000, source: 'recurring' },
      { date: '2026-07-30', name: 'Rent', amountMinor: -80000, source: 'recurring' },
    ]
    const projection = projectDailyBalances(40000, items, '2026-07-24', 10)
    // 25th: 40000-30000=10000; 27th: -5000 (negative day); 28th: +245000
    const day27 = projection.find((d) => d.date === '2026-07-27')!
    expect(day27.balanceMinor).toBe(-5000)

    const sts = safeToSpend(40000, projection)
    expect(sts.nextPaydayDate).toBe('2026-07-28')
    expect(sts.committedBeforePaydayMinor).toBe(45000)
    expect(sts.availableMinor).toBe(-5000) // cannot safely spend before payday
    expect(sts.negativeDays).toEqual(['2026-07-27'])
    expect(sts.minProjectedBalanceMinor).toBe(-5000)
  })

  it('with no payday in horizon, counts all committed outgoings', () => {
    const items: ProjectedItem[] = [
      { date: '2026-07-26', name: 'Bill', amountMinor: -10000, source: 'recurring' },
    ]
    const projection = projectDailyBalances(50000, items, '2026-07-24', 7)
    const sts = safeToSpend(50000, projection)
    expect(sts.nextPaydayDate).toBeNull()
    expect(sts.availableMinor).toBe(40000)
  })
})
