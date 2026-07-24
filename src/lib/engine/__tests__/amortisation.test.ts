import { describe, expect, it } from 'vitest'
import {
  applyOverpayments,
  buildSchedule,
  derivePaymentMinor,
  estimateSettlement,
  expectedBalanceAt,
  monthlyRate,
  totalInterest,
  totalPaid,
} from '../amortisation'

const LOAN = {
  principalMinor: 1_000_000, // £10,000
  apr: 6.9,
  termMonths: 60,
  startDate: '2026-01-15',
}

describe('monthlyRate', () => {
  it('supports nominal and effective APR', () => {
    expect(monthlyRate(12, 'nominal')).toBeCloseTo(0.01)
    expect(monthlyRate(12.6825, 'effective')).toBeCloseTo(0.01, 4)
  })
})

describe('derivePaymentMinor', () => {
  it('derives the annuity payment', () => {
    // £10,000 at 6.9% nominal over 60 months ≈ £197.57
    const p = derivePaymentMinor(1_000_000, 6.9, 60)
    expect(p).toBeGreaterThan(19_600)
    expect(p).toBeLessThan(19_900)
  })
  it('handles a zero-interest loan', () => {
    expect(derivePaymentMinor(120_000, 0, 12)) .toBe(10_000)
  })
})

describe('buildSchedule', () => {
  it('amortises exactly to zero with an adjusted final payment', () => {
    const rows = buildSchedule(LOAN)
    expect(rows.length).toBe(60)
    expect(rows[rows.length - 1].balanceAfterMinor).toBe(0)
    const principalSum = rows.reduce((a, r) => a + r.principalMinor, 0)
    expect(principalSum).toBe(LOAN.principalMinor)
    expect(totalPaid(rows)).toBe(LOAN.principalMinor + totalInterest(rows))
  })

  it('supports a final balloon payment (PCP)', () => {
    const rows = buildSchedule({
      principalMinor: 2_000_000,
      apr: 8.9,
      termMonths: 36,
      startDate: '2026-02-01',
      balloonMinor: 800_000,
    })
    const last = rows[rows.length - 1]
    expect(last.balanceAfterMinor).toBe(0)
    // Monthly payment far below a non-balloon deal, final payment includes balloon
    expect(last.paymentMinor).toBeGreaterThan(800_000)
    const nonBalloon = derivePaymentMinor(2_000_000, 8.9, 36)
    expect(rows[0].paymentMinor).toBeLessThan(nonBalloon)
  })

  it('handles month-end payment dates (31st)', () => {
    const rows = buildSchedule({
      principalMinor: 100_000,
      apr: 5,
      termMonths: 3,
      startDate: '2026-01-31',
    })
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })
})

describe('expectedBalanceAt', () => {
  it('returns the contractual position on a date', () => {
    const rows = buildSchedule(LOAN)
    expect(expectedBalanceAt(rows, '2025-12-01')).toBe(LOAN.principalMinor)
    expect(expectedBalanceAt(rows, rows[11].dueDate)).toBe(rows[11].balanceAfterMinor)
    expect(expectedBalanceAt(rows, '2032-01-01')).toBe(0)
  })
})

describe('applyOverpayments — reduce term', () => {
  it('an extra £150/month shortens the term and saves interest', () => {
    const result = applyOverpayments(LOAN, [], {
      mode: 'reduce_term',
      extraMonthlyMinor: 15_000,
    })
    expect(result.monthsSaved).toBeGreaterThan(20)
    expect(result.interestSavedMinor).toBeGreaterThan(50_000) // > £500 saved
    expect(result.rows[result.rows.length - 1].balanceAfterMinor).toBe(0)
  })

  it('a one-off £250 overpayment saves months and interest', () => {
    const result = applyOverpayments(LOAN, [{ monthIndex: 6, amountMinor: 25_000 }], {
      mode: 'reduce_term',
    })
    expect(result.monthsSaved).toBeGreaterThanOrEqual(1)
    expect(result.interestSavedMinor).toBeGreaterThan(0)
  })

  it('an overpayment larger than the remaining balance settles the loan', () => {
    const result = applyOverpayments(LOAN, [{ monthIndex: 2, amountMinor: 2_000_000 }], {
      mode: 'reduce_term',
    })
    expect(result.months).toBe(2)
    expect(result.rows[1].balanceAfterMinor).toBe(0)
    // Never pays more than owed + that month's interest
    const paid = totalPaid(result.rows)
    expect(paid).toBeLessThan(LOAN.principalMinor + 20_000)
  })
})

describe('applyOverpayments — reduce payment', () => {
  it('keeps the contractual term but lowers the payment', () => {
    const result = applyOverpayments(LOAN, [{ monthIndex: 6, amountMinor: 100_000 }], {
      mode: 'reduce_payment',
    })
    expect(result.months).toBe(LOAN.termMonths)
    expect(result.newPaymentMinor).toBeDefined()
    const original = derivePaymentMinor(LOAN.principalMinor, LOAN.apr, LOAN.termMonths)
    expect(result.newPaymentMinor!).toBeLessThan(original)
    expect(result.interestSavedMinor).toBeGreaterThan(0)
    // reduce_term saves more interest than reduce_payment for the same overpayment
    const reduceTerm = applyOverpayments(LOAN, [{ monthIndex: 6, amountMinor: 100_000 }], {
      mode: 'reduce_term',
    })
    expect(reduceTerm.interestSavedMinor).toBeGreaterThan(result.interestSavedMinor)
  })
})

describe('estimateSettlement', () => {
  it('adds accrued daily interest to the balance', () => {
    const est = estimateSettlement(500_000, 6.9, 15)
    expect(est).toBeGreaterThan(500_000)
    expect(est - 500_000).toBeLessThan(3_000) // ~£14 for 15 days at 6.9%
    expect(estimateSettlement(500_000, 6.9, 0)).toBe(500_000)
  })
})
