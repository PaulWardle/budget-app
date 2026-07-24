import { describe, expect, it } from 'vitest'
import { budgetSummary, categoryActuals, lineStatuses, type EngineTxn } from '../budget'

const base = { isTransfer: false, excludeFromBudget: false }

describe('categoryActuals', () => {
  it('sums spending per category, respecting splits', () => {
    const txns: EngineTxn[] = [
      { id: '1', date: '2026-07-02', amountMinor: -5000, categoryId: 'groceries', ...base },
      {
        id: '2',
        date: '2026-07-03',
        amountMinor: -10000,
        categoryId: 'groceries',
        ...base,
        splits: [
          { categoryId: 'groceries', amountMinor: -7500 },
          { categoryId: 'household', amountMinor: -1500 },
          { categoryId: 'alcohol', amountMinor: -1000 },
        ],
      },
    ]
    const actuals = categoryActuals(txns)
    expect(actuals.get('groceries')?.spentMinor).toBe(12500)
    expect(actuals.get('household')?.spentMinor).toBe(1500)
    expect(actuals.get('alcohol')?.spentMinor).toBe(1000)
  })

  it('excludes transfers, excluded and reimbursable transactions', () => {
    const txns: EngineTxn[] = [
      { id: '1', date: '2026-07-02', amountMinor: -5000, categoryId: 'transfers', isTransfer: true, excludeFromBudget: false },
      { id: '2', date: '2026-07-02', amountMinor: -5000, categoryId: 'groceries', isTransfer: false, excludeFromBudget: true },
      { id: '3', date: '2026-07-02', amountMinor: -5000, categoryId: 'travel', ...base, isReimbursable: true },
      { id: '4', date: '2026-07-02', amountMinor: -1000, categoryId: 'coffee', ...base },
    ]
    const actuals = categoryActuals(txns)
    expect(actuals.get('transfers')).toBeUndefined()
    expect(actuals.get('groceries')).toBeUndefined()
    expect(actuals.get('travel')).toBeUndefined()
    expect(actuals.get('coffee')?.spentMinor).toBe(1000)
  })

  it('separates refunds as income within a category', () => {
    const txns: EngineTxn[] = [
      { id: '1', date: '2026-07-02', amountMinor: -8000, categoryId: 'shopping', ...base },
      { id: '2', date: '2026-07-05', amountMinor: 3000, categoryId: 'shopping', ...base },
    ]
    const a = categoryActuals(txns).get('shopping')!
    expect(a.spentMinor).toBe(8000)
    expect(a.incomeMinor).toBe(3000)
  })
})

describe('lineStatuses', () => {
  it('forecasts variable spend by run-rate and flags warnings', () => {
    const actuals = categoryActuals([
      { id: '1', date: '2026-07-10', amountMinor: -20000, categoryId: 'eating_out', ...base },
    ])
    // £200 spent in 10 of 30 days on a £300 budget → forecast £600 → warning
    const [line] = lineStatuses(
      [{ categoryId: 'eating_out', kind: 'discretionary', plannedMinor: 30000 }],
      actuals,
      10,
      30,
    )
    expect(line.forecastMinor).toBe(60000)
    expect(line.status).toBe('warning')
  })

  it('marks over-budget lines and treats fixed lines as commitments', () => {
    const actuals = categoryActuals([
      { id: '1', date: '2026-07-10', amountMinor: -35000, categoryId: 'eating_out', ...base },
      { id: '2', date: '2026-07-01', amountMinor: -50000, categoryId: 'rent', ...base },
    ])
    const lines = lineStatuses(
      [
        { categoryId: 'eating_out', kind: 'discretionary', plannedMinor: 30000 },
        { categoryId: 'rent', kind: 'fixed', plannedMinor: 80000 },
      ],
      actuals,
      10,
      30,
    )
    expect(lines[0].status).toBe('over')
    // Fixed: forecast = planned, not run-rate (rent isn't paid pro-rata)
    expect(lines[1].forecastMinor).toBe(80000)
    expect(lines[1].status).toBe('on_track')
  })

  it('applies rollover to the planned amount', () => {
    const actuals = categoryActuals([])
    const [line] = lineStatuses(
      [{ categoryId: 'fun', kind: 'discretionary', plannedMinor: 10000, rolloverFromMinor: 2500 }],
      actuals,
      1,
      31,
    )
    expect(line.plannedMinor).toBe(12500)
  })
})

describe('budgetSummary', () => {
  it('totals planned, actual and forecast across lines', () => {
    const txns: EngineTxn[] = [
      { id: '1', date: '2026-07-15', amountMinor: -15000, categoryId: 'a', ...base },
      { id: '2', date: '2026-07-01', amountMinor: 250000, categoryId: 'salary', ...base },
    ]
    const actuals = categoryActuals(txns)
    const lines = lineStatuses(
      [{ categoryId: 'a', kind: 'variable', plannedMinor: 40000 }],
      actuals,
      15,
      30,
    )
    const s = budgetSummary(250000, lines, actuals)
    expect(s.actualSpendMinor).toBe(15000)
    expect(s.remainingMinor).toBe(25000)
    expect(s.actualIncomeMinor).toBe(250000)
    expect(s.forecastSpendMinor).toBe(30000)
  })
})
