import { describe, expect, it } from 'vitest'
import {
  actualPayday,
  daysBetween,
  isoAddDays,
  nextPayPeriod,
  payPeriodFor,
  previousPayPeriods,
} from '../payperiod'

describe('actualPayday', () => {
  it('keeps weekday paydays as-is', () => {
    // 25 June 2026 is a Thursday
    expect(actualPayday(2026, 6, 25)).toBe('2026-06-25')
  })
  it('rolls a Saturday payday back to Friday', () => {
    // 25 July 2026 is a Saturday → Friday 24th
    expect(actualPayday(2026, 7, 25)).toBe('2026-07-24')
  })
  it('rolls a Sunday payday back to Friday', () => {
    // 25 October 2026 is a Sunday → Friday 23rd
    expect(actualPayday(2026, 10, 25)).toBe('2026-10-23')
  })
  it('clamps day 31 to shorter months before applying the weekend rule', () => {
    // 30 April 2027 is a Friday
    expect(actualPayday(2027, 4, 31)).toBe('2027-04-30')
    // 28 Feb 2027 is a Sunday → Friday 26th
    expect(actualPayday(2027, 2, 31)).toBe('2027-02-26')
  })
})

describe('payPeriodFor', () => {
  it('finds the period just after a rolled-forward payday', () => {
    // Paid Friday 24 Jul (25th is Saturday); today Sunday 26 Jul.
    const p = payPeriodFor('2026-07-26', 25)
    expect(p.start).toBe('2026-07-24')
    expect(p.nextPayday).toBe('2026-08-25') // 25 Aug 2026 is a Tuesday
    expect(p.end).toBe('2026-08-24')
    expect(p.days).toBe(daysBetween('2026-07-24', '2026-08-25'))
    expect(p.budgetMonth).toBe('2026-08-01')
  })
  it('puts the day before payday in the previous period', () => {
    const p = payPeriodFor('2026-07-23', 25)
    expect(p.start).toBe('2026-06-25')
    expect(p.end).toBe('2026-07-23')
  })
  it('starts the period on payday itself', () => {
    const p = payPeriodFor('2026-07-24', 25)
    expect(p.start).toBe('2026-07-24')
  })
  it('falls back to calendar months without a payday', () => {
    const p = payPeriodFor('2026-07-26', null)
    expect(p.start).toBe('2026-07-01')
    expect(p.end).toBe('2026-07-31')
    expect(p.nextPayday).toBe('2026-08-01')
    expect(p.budgetMonth).toBe('2026-07-01')
  })
  it('handles paydays early in the month across year ends', () => {
    // 1 Jan 2027 is a Friday
    const p = payPeriodFor('2026-12-31', 1)
    expect(p.start).toBe('2026-12-01')
    expect(p.nextPayday).toBe('2027-01-01')
  })
})

describe('previousPayPeriods', () => {
  it('walks back through complete periods, newest first', () => {
    const prev = previousPayPeriods('2026-07-26', 25, 2)
    expect(prev[0].start).toBe('2026-06-25')
    expect(prev[0].end).toBe('2026-07-23')
    expect(prev[1].start).toBe('2026-05-25')
    expect(prev[1].end).toBe('2026-06-24')
  })
})

describe('nextPayPeriod', () => {
  it('is contiguous with the current one', () => {
    const cur = payPeriodFor('2026-07-26', 25)
    const next = nextPayPeriod(cur, 25)
    expect(next.start).toBe(cur.nextPayday)
    expect(isoAddDays(next.start, -1)).toBe(cur.end)
  })
})
