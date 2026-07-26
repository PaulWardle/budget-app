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
  fetchProfile,
  fetchRecurring,
  fetchSavingsGoals,
  fetchTransactions,
  upsertBudgetLine,
} from '@/lib/api'
import { budgetSummary, categoryActuals, lineStatuses, type BudgetStatus } from '@/lib/engine/budget'
import { expandRecurring } from '@/lib/engine/cashflow'
import { everydayBaseline } from '@/lib/engine/forecast'
import { daysBetween, isoAddDays, payPeriodFor, previousPayPeriods } from '@/lib/engine/payperiod'
import { paydayPlan } from '@/lib/engine/plan'
import { formatDateShort, money, monthLabel, todayIso } from '@/lib/format'
import type { BudgetLineKind } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { chartAxis, gbpTooltip, gridStroke, tooltipStyle } from '@/components/charts/theme'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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
  const today = todayIso()
  // Budgets run payday to payday. A period is identified by any date inside
  // it; the stored budget row is keyed to the month the period pays for
  // (period 24 Jul – 24 Aug → the August budget).
  const [anchor, setAnchor] = useState(today)
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile })
  const paydayDay = (profile?.payday_day as number | null) ?? null
  const period = payPeriodFor(anchor, paydayDay)
  const month = period.budgetMonth
  const monthEnd = period.end

  const { data: budget, isLoading } = useQuery({
    queryKey: ['budget', month],
    queryFn: () => fetchBudget(month),
    enabled: profile !== undefined,
  })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'range', period.start, monthEnd],
    queryFn: () => fetchTransactions({ from: period.start, to: monthEnd, limit: 1000 }),
  })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: goals } = useQuery({ queryKey: ['savings-goals'], queryFn: fetchSavingsGoals })
  const historyFrom = (() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 4)
    return d.toISOString().slice(0, 10)
  })()
  const { data: history } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
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

  if (isLoading || !categories || profile === undefined) return <Spinner />

  const daysInMonth = period.days
  const daysElapsed =
    today > period.end ? daysInMonth : today < period.start ? 0 : daysBetween(period.start, today) + 1

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

  // ---- Payday plan (current period only): allocate the period's money on
  // day one. The everyday pot must fund EVERYTHING that isn't a bill —
  // including one-offs and project spend — so all non-bill spend counts here.
  const isCurrentPeriod = today >= period.start && today <= period.end
  const plan = (() => {
    if (!isCurrentPeriod || !txns || !recurring) return null
    const real = txns.filter((t) => !t.is_transfer && !t.exclude_from_budget && !t.is_reimbursable)
    const incomeReceived = real.filter((t) => t.amount_minor > 0).reduce((s, t) => s + t.amount_minor, 0)
    const billsPaid = real
      .filter((t) => t.amount_minor < 0 && t.recurring_payment_id)
      .reduce((s, t) => s + -t.amount_minor, 0)
    const billsDue = recurring
      .filter((r) => r.status === 'active')
      .flatMap((r) =>
        expandRecurring(
          {
            name: r.name,
            amountMinor: r.amount_minor,
            frequency: r.frequency,
            nextDueDate: r.next_due_date,
            intervalDays: r.interval_days,
          },
          today,
          period.end,
        ),
      )
      .filter((i) => i.date > today && i.amountMinor < 0)
      .reduce((s, i) => s + -i.amountMinor, 0)
    const everydaySpent = real
      .filter((t) => t.amount_minor < 0 && !t.recurring_payment_id)
      .reduce((s, t) => s + -t.amount_minor, 0)
    const goalsPlanned = (goals ?? [])
      .filter((g) => g.status === 'active')
      .reduce((s, g) => s + (g.monthly_planned_minor ?? 0), 0)
    const baseline = history
      ? everydayBaseline(
          history.map((t) => ({
            date: t.date,
            amountMinor: t.amount_minor,
            categoryId: t.category_id,
            isTransfer: t.is_transfer,
            excludeFromBudget: t.exclude_from_budget,
            isReimbursable: t.is_reimbursable,
            recurringPaymentId: t.recurring_payment_id,
            isOneOff: t.is_one_off,
          })),
          today,
          3,
          previousPayPeriods(today, paydayDay, 3),
        )
      : null
    return paydayPlan({
      incomeExpectedMinor: budget?.expected_income_minor ?? 0,
      incomeReceivedMinor: incomeReceived,
      billsPaidMinor: billsPaid,
      billsDueMinor: billsDue,
      goalsPlannedMinor: goalsPlanned,
      everydaySpentMinor: everydaySpent,
      daysRemaining: Math.max(0, daysInMonth - daysElapsed),
      baselinePerDayMinor: baseline?.perDayMinor ?? 0,
    })
  })()

  return (
    <div>
      <PageHeader
        title="Budget"
        sub={paydayDay ? `Pay period ${period.label} — payday to payday` : undefined}
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setAnchor(isoAddDays(period.start, -1))} aria-label="Previous period">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="w-32 text-center text-sm font-semibold">{monthLabel(month)}</span>
            <Button variant="ghost" size="icon" onClick={() => setAnchor(period.nextPayday)} aria-label="Next period">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {plan && (
        <Card className="mb-4">
          <CardTitle>Payday plan — where this period's money goes</CardTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Money in{plan.incomeIsExpected ? ' (expected)' : ''}
              </p>
              <p className="tnum text-base font-semibold">{money(plan.incomeMinor)}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Bills & debts</p>
              <p className="tnum text-base font-semibold">−{money(plan.billsTotalMinor)}</p>
              <p className="text-[11px] text-ink-faint">paid + still due before payday</p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Savings goals</p>
              <p className="tnum text-base font-semibold">−{money(plan.goalsPlannedMinor)}</p>
              <p className="text-[11px] text-ink-faint">
                {plan.goalsPlannedMinor > 0 ? 'planned contributions' : 'no monthly amounts set on goals'}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Everyday pot</p>
              <p className={`tnum text-base font-semibold ${plan.everydayPotMinor < 0 ? 'text-bad' : ''}`}>
                {money(plan.everydayPotMinor)}
              </p>
              <p className="text-[11px] text-ink-faint">{money(plan.everydaySpentMinor)} spent so far</p>
            </div>
          </div>
          {plan.shortfallMinor > 0 ? (
            <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
              Bills and planned savings exceed the money coming in by {money(plan.shortfallMinor)} —
              something has to give before everyday spending starts.
            </p>
          ) : (
            <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2.5">
              <p className="text-sm">
                <strong className="tnum">{money(Math.max(0, plan.everydayLeftMinor))}</strong> left for
                everyday spending — that's{' '}
                <strong className="tnum">{money(Math.max(0, plan.perDayMinor))}/day</strong> until payday
                on {formatDateShort(period.nextPayday)}.
              </p>
              {plan.baselinePerDayMinor > 0 && (
                <p className={`mt-0.5 text-[11px] ${plan.perDayVsTypicalMinor < 0 ? 'text-warn' : 'text-ink-muted'}`}>
                  {plan.perDayVsTypicalMinor >= 0
                    ? `Comfortably above your typical ${money(plan.baselinePerDayMinor)}/day.`
                    : `Tighter than your typical ${money(plan.baselinePerDayMinor)}/day — at your usual rate the pot runs out in ${plan.daysAtTypicalRate} days.`}
                </p>
              )}
            </div>
          )}
        </Card>
      )}

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
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{paydayDay ? 'Forecast by payday' : 'Forecast month-end'}</p>
                  <p className={`tnum text-base font-semibold ${summary.forecastSpendMinor > summary.plannedSpendMinor ? 'text-warn' : ''}`}>
                    {money(summary.forecastSpendMinor)}
                  </p>
                  <p className="text-[11px] text-ink-faint" title="Variable categories: spend so far ÷ days elapsed × days in the period. Fixed, debt and savings: the larger of planned or actual.">
                    run-rate + commitments ⓘ
                  </p>
                </div>
              </div>
            </Card>
          )}

          {lines.length > 0 && (
            <Card className="mb-4">
              <CardTitle>Budget vs actual by category</CardTitle>
              <p className="mb-2 text-xs text-ink-muted">
                Pale bar = budget, solid bar = spent so far. Overspent categories show in red.
              </p>
              <div style={{ height: Math.max(160, Math.min(lines.length, 8) * 44) }}>
                <ResponsiveContainer>
                  <BarChart
                    layout="vertical"
                    data={[...lines]
                      .sort((a, b) => b.plannedMinor - a.plannedMinor)
                      .slice(0, 8)
                      .map((l) => ({
                        name: (budget.budget_lines.find((bl) => bl.category_id === l.categoryId && bl.kind === l.kind)?.label) ?? categoryLabel(categories, l.categoryId),
                        Budget: l.plannedMinor / 100,
                        Spent: l.actualMinor / 100,
                        over: l.actualMinor > l.plannedMinor,
                      }))}
                    margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
                    barGap={-14}
                  >
                    <XAxis type="number" tickFormatter={(v: number) => `£${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} />
                    <YAxis type="category" dataKey="name" width={120} tick={{ ...chartAxis, fill: 'var(--app-ink-muted)' }} stroke={gridStroke} />
                    <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} cursor={{ fill: 'color-mix(in srgb, var(--app-border) 40%, transparent)' }} />
                    <Bar dataKey="Budget" fill="color-mix(in srgb, var(--app-accent) 22%, transparent)" radius={[0, 4, 4, 0]} barSize={14} />
                    <Bar dataKey="Spent" radius={[0, 4, 4, 0]} barSize={14}>
                      {[...lines]
                        .sort((a, b) => b.plannedMinor - a.plannedMinor)
                        .slice(0, 8)
                        .map((l) => (
                          <Cell key={`${l.categoryId}-${l.kind}`} fill={l.actualMinor > l.plannedMinor ? 'var(--app-bad)' : 'var(--app-accent)'} />
                        ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
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
                              to={`/transactions?category=${l.category_id ?? ''}&from=${period.start}&to=${monthEnd}`}
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
