import { describe, expect, it } from 'vitest'
import { analyseOverdraft, dailyBalances, isOverdraftInterest } from '../overdraft'
import type { OverdraftTxn } from '../overdraft'

const txn = (
  date: string,
  amountMinor: number,
  runningBalanceMinor: number | null,
  description = 'CARD PAYMENT',
): OverdraftTxn => ({ date, amountMinor, runningBalanceMinor, description })

describe('dailyBalances', () => {
  it('carries the last known balance across quiet days', () => {
    const series = dailyBalances(
      [txn('2026-07-01', -1000, 5000), txn('2026-07-04', -2000, 3000)],
      '2026-07-05',
    )
    expect(series.map((d) => d.balanceMinor)).toEqual([5000, 5000, 5000, 3000, 3000])
  })

  it('uses the final row of a multi-transaction day as the close', () => {
    const series = dailyBalances(
      [txn('2026-07-01', -1000, 4000), txn('2026-07-01', -3000, 1000)],
      '2026-07-01',
    )
    expect(series).toEqual([{ date: '2026-07-01', balanceMinor: 1000 }])
  })

  it('ignores rows with no running balance and starts from the first known one', () => {
    const series = dailyBalances(
      [txn('2026-06-28', -500, null), txn('2026-07-01', -1000, -2000)],
      '2026-07-02',
    )
    expect(series[0]).toEqual({ date: '2026-07-01', balanceMinor: -2000 })
  })
})

describe('analyseOverdraft', () => {
  const july: OverdraftTxn[] = [
    txn('2026-07-01', 100000, 50000), // payday: −£500 → +£500
    txn('2026-07-10', -80000, -30000), // big spend: −£300
    txn('2026-07-15', -25, -30025, 'DAILY OD INT'),
    txn('2026-07-20', 60000, 29975), // top-up back above zero
  ]

  it('counts days overdrawn, days above zero, and the deepest point', () => {
    const s = analyseOverdraft(july, '2026-07-25')
    const m = s.currentMonth!
    expect(m.daysTracked).toBe(25)
    expect(m.daysOverdrawn).toBe(10) // 10th–19th inclusive
    expect(m.daysAboveZero).toBe(15)
    expect(m.deepestMinor).toBe(-30025)
  })

  it('totals overdraft interest from bank charge lines only', () => {
    const s = analyseOverdraft(july, '2026-07-25')
    expect(s.currentMonth!.interestMinor).toBe(25)
    expect(s.totalInterestMinor).toBe(25)
  })

  it('measures how much of a lump was absorbed by a negative balance', () => {
    const s = analyseOverdraft(july, '2026-07-25')
    // Payday lump: balance before = 50000 − 100000 = −50000 → £500 absorbed.
    // Top-up: before = 29975 − 60000 = −30025 → £300.25 absorbed.
    expect(s.lumps).toHaveLength(2)
    expect(s.lumps[0].absorbedMinor).toBe(50000)
    expect(s.lumps[1].absorbedMinor).toBe(30025)
    expect(s.totalAbsorbedMinor).toBe(80025)
  })

  it('reports zero absorption when the balance was already positive', () => {
    const s = analyseOverdraft([txn('2026-07-01', 170000, 200000)], '2026-07-01')
    expect(s.lumps[0].balanceBeforeMinor).toBe(30000)
    expect(s.lumps[0].absorbedMinor).toBe(0)
  })
})

describe('isOverdraftInterest', () => {
  it('matches bank overdraft interest lines and not ordinary spending', () => {
    expect(isOverdraftInterest('DAILY OD INT')).toBe(true)
    expect(isOverdraftInterest('Overdraft Interest')).toBe(true)
    expect(isOverdraftInterest('ODEON CINEMA')).toBe(false)
    expect(isOverdraftInterest('PODIATRY INTERNATIONAL')).toBe(false)
  })
})
