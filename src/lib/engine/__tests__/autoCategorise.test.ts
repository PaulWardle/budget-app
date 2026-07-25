import { describe, expect, it } from 'vitest'
import { resolveCategoryId, suggestFromDescription } from '../../autoCategorise'
import type { Category } from '@/types/domain'

describe('suggestFromDescription', () => {
  it('recognises unmistakable merchants', () => {
    expect(suggestFromDescription('STARBUCKS 2841 LEEDS')?.path).toEqual(['Coffee'])
    expect(suggestFromDescription('TESCO STORES 3021')?.path).toEqual(['Groceries'])
    expect(suggestFromDescription('NETFLIX.COM')?.path).toEqual(['Subscriptions'])
    expect(suggestFromDescription('TRAINLINE LONDON')?.path).toEqual(['Transport', 'Public transport'])
  })

  it('prefers specific matches over broad ones', () => {
    expect(suggestFromDescription('TESCO MOBILE PAYG')?.path).toEqual(['Utilities', 'Mobile'])
    expect(suggestFromDescription('UBER EATS DELIVERY')?.path).toEqual(['Eating out'])
    expect(suggestFromDescription('UBER *TRIP')?.path).toEqual(['Transport'])
    expect(suggestFromDescription('AMAZON PRIME MEMBER')?.path).toEqual(['Subscriptions'])
    expect(suggestFromDescription('AMZN MKTP UK')?.path).toEqual(['Shopping'])
  })

  it('returns null when in doubt — never guesses', () => {
    expect(suggestFromDescription('J SMITH LTD 4471')).toBeNull()
    expect(suggestFromDescription('BANK TRANSFER REF 8871')).toBeNull()
    expect(suggestFromDescription('')).toBeNull()
  })

  it('never claims retailer bank arms for the retailer category', () => {
    expect(suggestFromDescription('TESCO BANK PERSONAL LOAN')).toBeNull()
    expect(suggestFromDescription("SAINSBURY'S BANK")).toBeNull()
    expect(suggestFromDescription('M&S BANK CARD PAYMENT')).toBeNull()
  })
})

describe('resolveCategoryId', () => {
  const cats = [
    { id: 'p1', parent_id: null, name: 'Transport' },
    { id: 'c1', parent_id: 'p1', name: 'Fuel' },
    { id: 'p2', parent_id: null, name: 'Coffee' },
  ] as Category[]

  it('resolves parent and subcategory paths', () => {
    expect(resolveCategoryId(cats, ['Coffee'])).toBe('p2')
    expect(resolveCategoryId(cats, ['Transport', 'Fuel'])).toBe('c1')
  })
  it('falls back to the parent when the subcategory is missing', () => {
    expect(resolveCategoryId(cats, ['Transport', 'Parking'])).toBe('p1')
  })
  it('returns null for unknown categories', () => {
    expect(resolveCategoryId(cats, ['Nonexistent'])).toBeNull()
  })
})
