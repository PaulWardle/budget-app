import { describe, expect, it } from 'vitest'
import { ruleMatches } from '../rules'

describe('ruleMatches', () => {
  it('matches whole words, not fragments inside them', () => {
    // The bug this exists to prevent: "EE" matching a LEEK mortgage payment
    expect(ruleMatches('LEEK MTG', 'EE')).toBe(false)
    expect(ruleMatches('EE LIMITED', 'EE')).toBe(true)
    expect(ruleMatches('DD EE FINANCE GLOW', 'EE')).toBe(true)
    expect(ruleMatches('BPAY TRANSFER', 'BP')).toBe(false)
    expect(ruleMatches('BP CONNECT 4471', 'BP')).toBe(true)
  })

  it('still matches merchants with trailing store numbers and punctuation', () => {
    expect(ruleMatches('TESCO STORES 3021', 'TESCO')).toBe(true)
    expect(ruleMatches('B&Q 1234 LEEDS', 'B&Q')).toBe(true)
    expect(ruleMatches('CARD PAYMENT TO ASDA', 'ASDA')).toBe(true)
    expect(ruleMatches('SAINSBURYS S/MKT', "SAINSBURY'S")).toBe(false)
  })

  it('does not match a longer word that merely starts with the matcher', () => {
    expect(ruleMatches('TESCOS EXTRA', 'TESCO')).toBe(false)
    expect(ruleMatches('ALDIS', 'ALDI')).toBe(false)
  })

  it('honours exact and starts_with', () => {
    expect(ruleMatches('NETFLIX', 'NETFLIX', 'exact')).toBe(true)
    expect(ruleMatches('NETFLIX.COM', 'NETFLIX', 'exact')).toBe(false)
    expect(ruleMatches('NETFLIX.COM SUB', 'NETFLIX', 'starts_with')).toBe(true)
    expect(ruleMatches('NETFLIXX SUB', 'NETFLIX', 'starts_with')).toBe(false)
  })

  it('is case-insensitive and ignores surrounding whitespace in the matcher', () => {
    expect(ruleMatches('costa coffee leeds', ' COSTA ')).toBe(true)
  })
})
