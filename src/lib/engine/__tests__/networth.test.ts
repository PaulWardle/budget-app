import { describe, expect, it } from 'vitest'
import { adjustedNetWorth, computeNetWorth, type NetWorthItem } from '../networth'

const items: NetWorthItem[] = [
  { id: 'halifax', name: 'Halifax', class: 'asset', balanceMinor: 150000, isLiquid: true, includeInNetWorth: true },
  { id: 'monzo', name: 'Monzo', class: 'asset', balanceMinor: -5000, isLiquid: true, includeInNetWorth: true }, // overdrawn
  { id: 'house', name: 'House', class: 'asset', balanceMinor: 25000000, isLiquid: false, includeInNetWorth: true },
  { id: 'card', name: 'Credit card', class: 'liability', balanceMinor: 80000, isLiquid: true, includeInNetWorth: true },
  { id: 'carloan', name: 'Car loan', class: 'liability', balanceMinor: 750000, isLiquid: false, includeInNetWorth: true },
  { id: 'excluded', name: 'Not counted', class: 'asset', balanceMinor: 999999, isLiquid: true, includeInNetWorth: false },
]

describe('computeNetWorth', () => {
  it('computes totals, handles overdrawn accounts and exclusion flags', () => {
    const r = computeNetWorth(items)
    expect(r.assetsMinor).toBe(150000 - 5000 + 25000000)
    expect(r.liabilitiesMinor).toBe(80000 + 750000)
    expect(r.netWorthMinor).toBe(r.assetsMinor - r.liabilitiesMinor)
    expect(r.liquidAssetsMinor).toBe(145000)
    expect(r.liquidLiabilitiesMinor).toBe(80000)
    expect(r.liquidPositionMinor).toBe(65000)
  })
})

describe('adjustedNetWorth', () => {
  it('excluding a loan changes the adjusted view but never the full figure', () => {
    const r = adjustedNetWorth(items, new Set(['carloan']))
    expect(r.full.netWorthMinor).toBe(computeNetWorth(items).netWorthMinor)
    expect(r.adjusted.netWorthMinor).toBe(r.full.netWorthMinor + 750000)
    expect(r.excluded.map((e) => e.id)).toEqual(['carloan'])
  })
  it('empty exclusion set means adjusted equals full', () => {
    const r = adjustedNetWorth(items, new Set())
    expect(r.adjusted).toEqual(r.full)
    expect(r.excluded).toEqual([])
  })
})
