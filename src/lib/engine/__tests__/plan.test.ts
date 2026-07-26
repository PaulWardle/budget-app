import { describe, expect, it } from 'vitest'
import { paydayPlan } from '../plan'

describe('paydayPlan', () => {
  it('allocates income across bills, goals and the everyday pot', () => {
    const p = paydayPlan({
      incomeExpectedMinor: 250_000,
      incomeReceivedMinor: 250_000,
      billsPaidMinor: 30_000,
      billsDueMinor: 70_000,
      goalsPlannedMinor: 20_000,
      everydaySpentMinor: 10_000,
      daysRemaining: 30,
      baselinePerDayMinor: 5_000,
    })
    expect(p.billsTotalMinor).toBe(100_000)
    expect(p.everydayPotMinor).toBe(130_000)
    expect(p.everydayLeftMinor).toBe(120_000)
    expect(p.perDayMinor).toBe(4_000)
    expect(p.perDayVsTypicalMinor).toBe(-1_000) // £10/day tighter than typical
    expect(p.daysAtTypicalRate).toBe(24)
    expect(p.shortfallMinor).toBe(0)
  })

  it('uses expected income when pay has not landed yet', () => {
    const p = paydayPlan({
      incomeExpectedMinor: 250_000,
      incomeReceivedMinor: 0,
      billsPaidMinor: 0,
      billsDueMinor: 100_000,
      goalsPlannedMinor: 0,
      everydaySpentMinor: 0,
      daysRemaining: 31,
      baselinePerDayMinor: 5_000,
    })
    expect(p.incomeIsExpected).toBe(true)
    expect(p.incomeMinor).toBe(250_000)
  })

  it('prefers received income when it exceeds the expectation', () => {
    const p = paydayPlan({
      incomeExpectedMinor: 200_000,
      incomeReceivedMinor: 260_000,
      billsPaidMinor: 0,
      billsDueMinor: 0,
      goalsPlannedMinor: 0,
      everydaySpentMinor: 0,
      daysRemaining: 10,
      baselinePerDayMinor: 0,
    })
    expect(p.incomeIsExpected).toBe(false)
    expect(p.incomeMinor).toBe(260_000)
    expect(p.daysAtTypicalRate).toBe(Infinity)
  })

  it('reports a shortfall when commitments exceed income', () => {
    const p = paydayPlan({
      incomeExpectedMinor: 100_000,
      incomeReceivedMinor: 100_000,
      billsPaidMinor: 80_000,
      billsDueMinor: 40_000,
      goalsPlannedMinor: 0,
      everydaySpentMinor: 0,
      daysRemaining: 20,
      baselinePerDayMinor: 3_000,
    })
    expect(p.everydayPotMinor).toBe(-20_000)
    expect(p.shortfallMinor).toBe(20_000)
    expect(p.perDayMinor).toBeLessThan(0)
  })

  it('handles the last day of the period without dividing by zero', () => {
    const p = paydayPlan({
      incomeExpectedMinor: 100_000,
      incomeReceivedMinor: 100_000,
      billsPaidMinor: 50_000,
      billsDueMinor: 0,
      goalsPlannedMinor: 0,
      everydaySpentMinor: 30_000,
      daysRemaining: 0,
      baselinePerDayMinor: 3_000,
    })
    expect(p.perDayMinor).toBe(20_000)
  })
})
