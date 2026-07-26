// Payday plan: decide where the period's money goes on day one, instead of
// finding out where it went on day thirty-two.
//
// The allocation is simple arithmetic over engine-supplied figures: income
// for the period, minus every bill the period must cover (paid and still
// due), minus planned savings-goal contributions, leaves the everyday pot.
// What's left of that pot divided by the days remaining is the per-day
// allowance — and comparing it with the measured typical per-day rate says
// whether the plan is comfortable or a squeeze BEFORE the period is lived.

import type { Minor } from './money'

export interface PaydayPlanInput {
  /** Income expected for the period (budget figure) — used when more than received. */
  incomeExpectedMinor: Minor
  /** Income actually received so far this period. */
  incomeReceivedMinor: Minor
  billsPaidMinor: Minor
  billsDueMinor: Minor
  /** Sum of monthly_planned on active savings goals. */
  goalsPlannedMinor: Minor
  everydaySpentMinor: Minor
  daysRemaining: number
  /** Measured typical everyday spend per day (0 = no history). */
  baselinePerDayMinor: Minor
}

export interface PaydayPlan {
  incomeMinor: Minor
  /** True when the plan is running on expected rather than received income. */
  incomeIsExpected: boolean
  billsTotalMinor: Minor
  goalsPlannedMinor: Minor
  /** The whole-period everyday pot after commitments and savings. */
  everydayPotMinor: Minor
  everydaySpentMinor: Minor
  everydayLeftMinor: Minor
  perDayMinor: Minor
  baselinePerDayMinor: Minor
  /** perDay − baselinePerDay; negative = tighter than the typical rate. */
  perDayVsTypicalMinor: Minor
  /** Days the remaining pot lasts at the typical rate (Infinity if baseline 0). */
  daysAtTypicalRate: number
  /** Pot is negative — commitments and spending already exceed income. */
  shortfallMinor: Minor
}

export function paydayPlan(input: PaydayPlanInput): PaydayPlan {
  const incomeIsExpected = input.incomeExpectedMinor > input.incomeReceivedMinor
  const incomeMinor = Math.max(input.incomeExpectedMinor, input.incomeReceivedMinor)
  const billsTotalMinor = input.billsPaidMinor + input.billsDueMinor
  const everydayPotMinor = incomeMinor - billsTotalMinor - input.goalsPlannedMinor
  const everydayLeftMinor = everydayPotMinor - input.everydaySpentMinor
  const perDayMinor =
    input.daysRemaining > 0 ? Math.floor(everydayLeftMinor / input.daysRemaining) : everydayLeftMinor
  return {
    incomeMinor,
    incomeIsExpected,
    billsTotalMinor,
    goalsPlannedMinor: input.goalsPlannedMinor,
    everydayPotMinor,
    everydaySpentMinor: input.everydaySpentMinor,
    everydayLeftMinor,
    perDayMinor,
    baselinePerDayMinor: input.baselinePerDayMinor,
    perDayVsTypicalMinor: perDayMinor - input.baselinePerDayMinor,
    daysAtTypicalRate:
      input.baselinePerDayMinor > 0
        ? Math.floor(Math.max(0, everydayLeftMinor) / input.baselinePerDayMinor)
        : Infinity,
    shortfallMinor: everydayPotMinor < 0 ? -everydayPotMinor : 0,
  }
}
