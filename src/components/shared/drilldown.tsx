// Drill-down sheet: shows exactly which rows make up a headline number.
// Every figure on a summary card should be able to answer "where's that from?"
// The rows passed in must be the same ones the figure was summed from, so the
// total shown here always reconciles with the stat that opened it.

import { Dialog, EmptyState } from '@/components/ui/primitives'
import { formatDateShort, money } from '@/lib/format'
import { Link } from 'react-router-dom'

export interface DrillRow {
  id: string
  date?: string | null
  label: string
  sub?: string | null
  amountMinor: number
}

export function DrillDown({
  open,
  onClose,
  title,
  rows,
  note,
  linkTo,
  linkLabel = 'Open in Transactions',
  emptyHint,
}: {
  open: boolean
  onClose: () => void
  title: string
  rows: DrillRow[]
  note?: string
  linkTo?: string
  linkLabel?: string
  emptyHint?: string
}) {
  const total = rows.reduce((s, r) => s + r.amountMinor, 0)
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to show" hint={emptyHint} />
      ) : (
        <>
          <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2">
            <span className="text-xs text-ink-muted">
              {rows.length} {rows.length === 1 ? 'item' : 'items'}
            </span>
            <span className="tnum text-lg font-semibold">{money(Math.abs(total))}</span>
          </div>
          <div className="-mx-1 max-h-[55dvh] overflow-y-auto px-1">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-sm">{r.label}</p>
                  <p className="text-[11px] text-ink-faint">
                    {r.date && <span className="tnum mr-2">{formatDateShort(r.date)}</span>}
                    {r.sub}
                  </p>
                </div>
                <span className={`tnum shrink-0 text-sm font-medium ${r.amountMinor > 0 ? 'text-good' : ''}`}>
                  {money(r.amountMinor, { showSign: true })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {note && <p className="mt-3 border-t border-border pt-2 text-[11px] text-ink-faint">{note}</p>}
      {linkTo && (
        <Link to={linkTo} onClick={onClose} className="mt-3 block text-xs text-accent hover:underline">
          {linkLabel} →
        </Link>
      )}
    </Dialog>
  )
}
