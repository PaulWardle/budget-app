// "What's in this number?" for the spending baseline.
//
// The forecast is only trustworthy if the spending behind it can be seen and
// corrected. This lists every transaction the baseline was measured from,
// largest first, and lets a one-off — a tattoo, a sofa, a car repair — be taken
// out with one tap. The transaction itself is untouched: it still counts in the
// month it happened, it just stops setting expectations for future months.

import { categoryLabel } from '@/components/shared/common'
import { Badge, Button, Dialog, Spinner } from '@/components/ui/primitives'
import { setTransactionOneOff } from '@/lib/api'
import type { ForecastTxn } from '@/lib/engine/forecast'
import { formatDateShort, money } from '@/lib/format'
import type { Category } from '@/types/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

export function BaselineInspector({
  open,
  onClose,
  contributors,
  excluded,
  categories,
  perMonthMinor,
  monthsUsed,
}: {
  open: boolean
  onClose: () => void
  /** Everything currently feeding the baseline, largest first. */
  contributors: ForecastTxn[]
  /** Everything already marked one-off, so it can be put back. */
  excluded: ForecastTxn[]
  categories: Category[]
  perMonthMinor: number
  monthsUsed: number
}) {
  const qc = useQueryClient()
  const [showExcluded, setShowExcluded] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  const toggle = useMutation({
    mutationFn: async (p: { id: string; isOneOff: boolean }) => {
      setPending(p.id)
      await setTransactionOneOff(p.id, p.isOneOff)
    },
    onSettled: () => {
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['insights'] })
    },
  })

  // A row worth a second look: several times the typical spend for a single
  // transaction. Flagged, never auto-removed — that call is the user's.
  const median = medianOf(contributors.map((c) => Math.abs(c.amountMinor)))
  const isUnusual = (t: ForecastTxn) => median > 0 && Math.abs(t.amountMinor) > median * 6

  const rows = showExcluded ? excluded : contributors
  const total = contributors.reduce((s, c) => s + -c.amountMinor, 0)

  return (
    <Dialog open={open} onClose={onClose} title="What's in your typical spend" wide>
      <p className="text-xs text-ink-muted">
        {money(perMonthMinor)} a month is the middle of your last {monthsUsed} complete month
        {monthsUsed === 1 ? '' : 's'}, measured from {contributors.length} transactions totalling{' '}
        {money(total)}. Bills, transfers and reimbursable items are already excluded.
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Anything that isn't part of your normal pattern — a tattoo, a sofa, a car repair — can be
        marked one-off. It stays in your transactions and in that month's totals; it just stops
        shaping the forecast.
      </p>

      <div className="mt-3 flex gap-2 border-b border-border pb-2">
        <Button
          size="sm"
          variant={showExcluded ? 'ghost' : 'secondary'}
          onClick={() => setShowExcluded(false)}
        >
          Counted ({contributors.length})
        </Button>
        <Button
          size="sm"
          variant={showExcluded ? 'secondary' : 'ghost'}
          onClick={() => setShowExcluded(true)}
        >
          One-offs ({excluded.length})
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-muted">
          {showExcluded ? 'Nothing marked as a one-off yet.' : 'Nothing measured yet.'}
        </p>
      ) : (
        <div className="-mx-1 max-h-[50dvh] overflow-y-auto px-1">
          {rows.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {t.merchant ?? 'Transaction'}
                  {!showExcluded && isUnusual(t) && (
                    <Badge tone="warn" className="ml-1.5">
                      unusually large
                    </Badge>
                  )}
                </p>
                <p className="text-[11px] text-ink-faint">
                  <span className="tnum mr-2">{formatDateShort(t.date)}</span>
                  {categoryLabel(categories, t.categoryId)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tnum text-sm font-medium">{money(t.amountMinor)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className={showExcluded ? '' : 'text-ink-faint'}
                  disabled={pending === t.id || !t.id}
                  onClick={() => toggle.mutate({ id: t.id!, isOneOff: !showExcluded })}
                >
                  {pending === t.id ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : showExcluded ? (
                    'Count it'
                  ) : (
                    'One-off'
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
