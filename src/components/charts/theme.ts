// Chart color system, validated with the dataviz palette validator for both
// surfaces (all six checks pass: lightness band, chroma floor, CVD separation,
// normal-vision floor, contrast). Categorical hues are assigned in FIXED order
// by entity, never cycled or reassigned when filters change series count.

export const CATEGORICAL_LIGHT = ['#2557d6', '#0e9488', '#d97706', '#db2777', '#7c3aed', '#4d7c0f']
export const CATEGORICAL_DARK = ['#4f7df9', '#0d9488', '#d97706', '#ec4899', '#8b5cf6', '#65a30d']

export function categorical(index: number, dark: boolean): string {
  const p = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT
  return p[index % p.length]
}

export function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

/** Stable color assignment for a fixed, sorted list of entity keys. Entities
 * beyond the palette fold into "Other" upstream — never generate hues. */
export function assignColors(keys: string[], dark: boolean): Map<string, string> {
  const map = new Map<string, string>()
  keys.forEach((k, i) => map.set(k, categorical(i, dark)))
  return map
}

export const chartAxis = {
  stroke: 'var(--app-ink-faint)',
  fontSize: 11,
} as const

export const gridStroke = 'color-mix(in srgb, var(--app-border) 60%, transparent)'

export const tooltipStyle = {
  backgroundColor: 'var(--app-surface)',
  border: '1px solid var(--app-border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--app-ink)',
} as const

// Loosely-typed tooltip helpers compatible with Recharts' strict formatter
// generics. Chart values are pounds (minor/100); these format back to GBP.
import { formatMinor } from '@/lib/engine/money'
import { formatDateShort } from '@/lib/format'

export const gbpTooltip = (value: unknown, name?: unknown): [string, string] => [
  formatMinor(Math.round(Number(value ?? 0) * 100)),
  String(name ?? ''),
]

export const dateTooltipLabel = (label: unknown): string => formatDateShort(String(label ?? ''))
