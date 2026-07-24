import { CategorySelect, MoneyInput, PageHeader, categoryLabel } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  Label,
  ProgressBar,
  Select,
  Spinner,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  copyBudgetFrom,
  createBudget,
  deleteBudgetLine,
  fetchBudget,
  fetchCategories,
  fetchTransactions,
  upsertBudgetLine,
} from '@/lib/api'
import { budgetSummary, categoryActuals, lineStatuses, type BudgetStatus } from '@/lib/engine/budget'
import { daysInMonthOf, money, monthLabel, monthStartIso, todayIso } from '@/lib/format'
import type { BudgetLineKind } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

const KIND_LABELS: Record<BudgetLineKind, string> = {
  income: 'Expected income',
  fixed: 'Fixed costs',
  variable: 'Variable essentials',
  discretionary: 'Discretionary',
  debt: 'Debt payments',
  savings: 'Savings targets',
  one_off: 'One-off expenses',
}

function shiftMonth(monthIso: string, delta: number): string {
  const [y, m] = monthIso.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

const statusTone: Record<BudgetStatus, 'good' | 'warn' | 'bad'> = {
  on_track: 'good',
  warning: 'warn',
  over: 'bad',
}

export default function BudgetPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const [month, setMonth] = useState(monthStartIso())
  const monthEnd = `${month.slice(0, 8)}${String(daysInMonthOf(month)).padStart(2, '0')}`

  const { data: budget, isLoading } = useQuery({
    queryKey: ['budget', month],
    queryFn: () => fetchBudget(month),
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'range', month, monthEnd],
    queryFn: () => fetchTransactions({ from: month, to: monthEnd, limit: 1000 }),
  })

  const [addLine, setAddLine] = useState(false)
  const invalidate = () => qc.invalidateQueries({ queryKey: ['budget', month] })

  const create = useMutation({
    mutationFn: () => createBudget(userId, month, {}),
    onSuccess: invalidate,
  })
  const copy = useMutation({
    mutationFn: () => copyBudgetFrom(userId, shiftMonth(month, -1), month),
    onSuccess: invalidate,
  })
  const setIncome = useMutation({
    mutationFn: async (minor: number) => {
      const { supabase } = await import('@/lib/supabase')
      await supabase.from('budgets').update({ expected_income_minor: minor }).eq('id', budget!.id)
    },
    onSuccess: invalidate,
  })

  if (isLoading || !categories) return <Spinner />

  const today = todayIso()
  const isCurrentMonth = month === monthStartIso()
  const daysInMonth = daysInMonthOf(month)
  const daysElapsed = isCurrentMonth
    ? Number(today.slice(8, 10))
    : month < monthStartIso()
      ? daysInMonth
      : 0

  const engineTxns = (txns ?? []).map((t) => ({
    id: t.id,
    date: t.date,
    amountMinor: t.amount_minor,
    categoryId: t.category_id,
    isTransfer: t.is_transfer,
    excludeFromBudget: t.exclude_from_budget,
    isReimbursable: t.is_reimbursable,
    splits: t.transaction_splits?.map((s) => ({ categoryId: s.category_id, amountMinor: s.amount_minor })),
  }))
  const actuals = categoryActuals(engineTxns)
  const lines = budget
    ? lineStatuses(
        budget.budget_lines.map((l) => ({
          categoryId: l.category_id,
          kind: l.kind,
          plannedMinor: l.planned_minor,
          rolloverFromMinor: l.rollover_from_minor,
        })),
        actuals,
        Math.max(1, daysElapsed),
        daysInMonth,
      )
    : []
  const summary = budget ? budgetSummary(budget.expected_income_minor, lines, actuals) : null

  return (
    <div>
      <PageHeader
        title="Budget"
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="w-32 text-center text-sm font-semibold">{monthLabel(month)}</span>
            <Button variant="ghost" size="icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {!budget ? (
        <Card className="space-y-3 p-6 text-center">
          <p className="text-sm text-ink-muted">No budget for {monthLabel(month)} yet.</p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => copy.mutate()} disabled={copy.isPending}>
              Copy {monthLabel(shiftMonth(month, -1))}
            </Button>
            <Button variant="outline" onClick={() => create.mutate()} disabled={create.isPending}>
              Start empty
            </Button>
          </div>
          {copy.data === null && (
            <p className="text-xs text-warn">No previous budget to copy — start empty instead.</p>
          )}
        </Card>
      ) : (
        <>
          {summary && (
            <Card className="mb-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <Label htmlFor="exp-income">Expected income</Label>
                  <MoneyInput
                    id="exp-income"
                    valueMinor={budget.expected_income_minor}
                    onChangeMinor={(m) => m !== null && setIncome.mutate(m)}
                  />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Planned spend</p>
                  <p className="tnum text-base font-semibold">{money(summary.plannedSpendMinor)}</p>
                  <p className="text-[11px] text-ink-faint">
                    leaves {money(budget.expected_income_minor - summary.plannedSpendMinor)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Actual so far</p>
                  <p className="tnum text-base font-semibold">{money(summary.actualSpendMinor)}</p>
                  <p className="text-[11px] text-ink-faint">income in: {money(summary.actualIncomeMinor)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Forecast month-end</p>
                  <p className={`tnum text-base font-semibold ${summary.forecastSpendMinor > summary.plannedSpendMinor ? 'text-warn' : ''}`}>
                    {money(summary.forecastSpendMinor)}
                  </p>
                  <p className="text-[11px] text-ink-faint" title="Variable categories: spend so far ÷ days elapsed × days in month. Fixed, debt and savings: the larger of planned or actual.">
                    run-rate + commitments ⓘ
                  </p>
                </div>
              </div>
            </Card>
          )}

          {(Object.keys(KIND_LABELS) as BudgetLineKind[])
            .filter((k) => k !== 'income')
            .map((kind) => {
              const kindLines = budget.budget_lines.filter((l) => l.kind === kind)
              if (kindLines.length === 0) return null
              return (
                <Card key={kind} className="mb-3">
                  <CardTitle>{KIND_LABELS[kind]}</CardTitle>
                  <div className="space-y-3">
                    {kindLines.map((l) => {
                      const status = lines.find(
                        (s) => s.categoryId === l.category_id && s.kind === l.kind,
                      )
                      if (!status) return null
                      const label = l.label ?? categoryLabel(categories, l.category_id)
                      return (
                        <div key={l.id}>
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <Link
                              to={`/transactions?category=${l.category_id ?? ''}&from=${month}&to=${monthEnd}`}
                              className="truncate text-sm font-medium hover:text-accent"
                            >
                              {label}
                            </Link>
                            <div className="flex items-center gap-2">
                              <span className="tnum text-xs text-ink-muted">
                                {money(status.actualMinor)} / {money(status.plannedMinor)}
                              </span>
                              <Badge tone={statusTone[status.status]}>
                                {status.status === 'on_track'
                                  ? 'on track'
                                  : status.status === 'warning'
                                    ? `forecast ${money(status.forecastMinor)}`
                                    : `${money(-status.remainingMinor)} over`}
                              </Badge>
                              <button
                                className="text-xs text-ink-faint hover:text-bad cursor-pointer"
                                onClick={() => deleteBudgetLine(l.id).then(invalidate)}
                                aria-label={`Remove ${label} budget line`}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                          <ProgressBar value={status.percentUsed} tone={statusTone[status.status]} />
                        </div>
                      )
                    })}
                  </div>
                </Card>
              )
            })}

          {budget.budget_lines.length === 0 && (
            <EmptyState title="No budget lines yet" hint="Add category budgets below." />
          )}

          <Button variant="outline" onClick={() => setAddLine(true)}>
            <Plus className="h-4 w-4" /> Add budget line
          </Button>

          {addLine && (
            <AddLineDialog
              onClose={() => setAddLine(false)}
              onSave={async (line) => {
                await upsertBudgetLine(userId, budget.id, line)
                invalidate()
                setAddLine(false)
              }}
              categories={categories}
            />
          )}
        </>
      )}
    </div>
  )
}

function AddLineDialog({
  onClose,
  onSave,
  categories,
}: {
  onClose: () => void
  onSave: (line: { category_id: string | null; kind: BudgetLineKind; planned_minor: number; label?: string | null }) => Promise<void>
  categories: Parameters<typeof CategorySelect>[0]['categories']
}) {
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [kind, setKind] = useState<BudgetLineKind>('variable')
  const [planned, setPlanned] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  return (
    <Dialog open onClose={onClose} title="Add budget line">
      <div className="space-y-3">
        <div>
          <Label>Type</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as BudgetLineKind)}>
            {Object.entries(KIND_LABELS)
              .filter(([k]) => k !== 'income')
              .map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
          </Select>
        </div>
        {kind === 'one_off' ? (
          <div>
            <Label>Label</Label>
            <input
              className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Car MOT"
            />
          </div>
        ) : (
          <div>
            <Label>Category</Label>
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} allowNone={false} />
          </div>
        )}
        <div>
          <Label>Planned amount</Label>
          <MoneyInput valueMinor={planned} onChangeMinor={setPlanned} allowNegative={false} />
        </div>
        <Button
          className="w-full"
          disabled={planned === null || (kind !== 'one_off' && !categoryId)}
          onClick={() =>
            onSave({
              category_id: kind === 'one_off' ? null : categoryId,
              kind,
              planned_minor: planned ?? 0,
              label: kind === 'one_off' ? label || 'One-off' : null,
            })
          }
        >
          Add
        </Button>
      </div>
    </Dialog>
  )
}
