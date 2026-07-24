import { describe, expect, it } from 'vitest'
import { allocateMinor, formatMinor, parseToMinor, percentUsed, sumMinor } from '../money'

describe('parseToMinor', () => {
  it('parses plain and formatted amounts', () => {
    expect(parseToMinor('12.34')).toBe(1234)
    expect(parseToMinor('£1,234.56')).toBe(123456)
    expect(parseToMinor('12')).toBe(1200)
    expect(parseToMinor('12.5')).toBe(1250)
    expect(parseToMinor('-£3.20')).toBe(-320)
    expect(parseToMinor('0.01')).toBe(1)
  })
  it('rejects invalid input', () => {
    expect(parseToMinor('12.345')).toBeNull()
    expect(parseToMinor('abc')).toBeNull()
    expect(parseToMinor('')).toBeNull()
  })
})

describe('formatMinor', () => {
  it('formats GBP with sign handling', () => {
    expect(formatMinor(123456)).toBe('£1,234.56')
    expect(formatMinor(-320)).toBe('-£3.20')
    expect(formatMinor(500, { showSign: true })).toBe('+£5.00')
  })
})

describe('sumMinor', () => {
  it('sums and rejects non-integers', () => {
    expect(sumMinor([100, -30, 5])).toBe(75)
    expect(() => sumMinor([10.5])).toThrow()
  })
})

describe('allocateMinor', () => {
  it('splits without losing pence', () => {
    const parts = allocateMinor(10000, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000)
    expect(parts).toEqual([3334, 3333, 3333])
  })
  it('handles negative totals (refund splits)', () => {
    const parts = allocateMinor(-10001, [3, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-10001)
  })
  it('is exact for a £100 Tesco split 75/15/10', () => {
    expect(allocateMinor(10000, [75, 15, 10])).toEqual([7500, 1500, 1000])
  })
})

describe('percentUsed', () => {
  it('is safe for zero budgets', () => {
    expect(percentUsed(0, 0)).toBe(0)
    expect(percentUsed(500, 0)).toBe(Infinity)
    expect(percentUsed(5000, 10000)).toBe(50)
  })
})
