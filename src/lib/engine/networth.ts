// Deterministic net-worth calculations. Adjusted views never overwrite the
// true figure — both are always computed and returned side by side.

import type { Minor } from './money'

export interface NetWorthItem {
  id: string
  name: string
  class: 'asset' | 'liability'
  balanceMinor: Minor // assets positive; liabilities stored as positive owed
  isLiquid: boolean
  includeInNetWorth: boolean
}

export interface NetWorthResult {
  assetsMinor: Minor
  liabilitiesMinor: Minor
  netWorthMinor: Minor
  liquidAssetsMinor: Minor
  liquidLiabilitiesMinor: Minor
  liquidPositionMinor: Minor
}

export function computeNetWorth(items: NetWorthItem[]): NetWorthResult {
  let assets = 0
  let liabilities = 0
  let liquidAssets = 0
  let liquidLiabilities = 0
  for (const item of items) {
    if (!item.includeInNetWorth) continue
    const abs = Math.abs(item.balanceMinor)
    if (item.class === 'asset') {
      // A negative "asset" balance (overdrawn current account) counts against assets.
      assets += item.balanceMinor
      if (item.isLiquid) liquidAssets += item.balanceMinor
    } else {
      liabilities += abs
      if (item.isLiquid) liquidLiabilities += abs
    }
  }
  return {
    assetsMinor: assets,
    liabilitiesMinor: liabilities,
    netWorthMinor: assets - liabilities,
    liquidAssetsMinor: liquidAssets,
    liquidLiabilitiesMinor: liquidLiabilities,
    liquidPositionMinor: liquidAssets - liquidLiabilities,
  }
}

export interface AdjustedNetWorth {
  full: NetWorthResult
  adjusted: NetWorthResult
  excluded: NetWorthItem[]
}

/** Compute both the true figure and a what-if view with items excluded. */
export function adjustedNetWorth(items: NetWorthItem[], excludedIds: Set<string>): AdjustedNetWorth {
  const excluded = items.filter((i) => excludedIds.has(i.id) && i.includeInNetWorth)
  return {
    full: computeNetWorth(items),
    adjusted: computeNetWorth(items.filter((i) => !excludedIds.has(i.id))),
    excluded,
  }
}
