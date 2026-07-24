import { MoneyInput, PageHeader, Stat } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  fetchDebtPayments,
  fetchLiabilities,
  recordDebtPayment,
  saveSchedule,
  upsertLiability,
} from '@/lib/api'
import {
  applyOverpayments,
  buildSchedule,
  derivePaymentMinor,
  expectedBalanceAt,
  totalInterest,
  type ScheduleInput,
} from '@/lib/engine/amortisation'
import { formatDate, money, todayIso } from '@/lib/format'
import type { DebtPayment } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { LIABILITY_LABELS } from './DebtsPage'

export default function DebtDetailPage() {
  const { id } = useParams<{ id: string }>()
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: payments } = useQuery({
    queryKey: ['debt-payments', id],
    queryFn: () => fetchDebtPayments(id!),
    enabled: !!id,
  })
  const [recording, setRecording] = useState(false)
  const [balanceEdit, setBalanceEdit] = useState<number | null>(null)
  const [extraMonthly, setExtraMonthly] = useState<number | null>(null)
  const [oneOff, setOneOff] = useState<number | null>(null)

  const liability = liabilities?.find((l) => l.id === id)

  const scheduleInput: ScheduleInput | null = useMemo(() => {
    if (!liability?.original_balance_minor || !liability.apr || !liability.term_months || !liability.start_date) {
      return null
    }
    return {
      principalMinor: liability.original_balance_minor,
      apr: liability.apr,
      termMonths: liability.term_months,
      startDate: liability.start_date,
      paymentMinor: liability.monthly_payment_minor ?? undefined,
      balloonMinor: liability.balloon_minor ?? undefined,
    }
  }, [liability])

  const schedule = useMemo(() => (scheduleInput ? buildSchedule(scheduleInput) : null), [scheduleInput])

  const scenario = useMemo(() => {
    if (!scheduleInput || (!extraMonthly && !oneOff)) return null
    const ops = oneOff ? [{ monthIndex: nextPaymentIndex(schedule ?? [], todayIso()), amountMinor: oneOff }] : []
    const known = liability?.overpayment_rule
    return {
      reduceTerm: applyOverpayments(scheduleInput, ops, { mode: 'reduce_term', extraMonthlyMinor: extraMonthly ?? 0 }),
      reducePayment: applyOverpayments(scheduleInput, ops, { mode: 'reduce_payment', extraMonthlyMinor: extraMonthly ?? 0 }),
      rule: known,
    }
  }, [scheduleInput, schedule, extraMonthly, oneOff, liability])

  const recordPayment = useMutation({
    mutationFn: (p: { amount_minor: number; kind: DebtPayment['kind']; date: string }) =>
      recordDebtPayment(userId, { liability_id: id!, ...p }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['debt-payments', id] })
      qc.invalidateQueries({ queryKey: ['liabilities'] })
      setRecording(false)
    },
  })

  const updateBalance = useMutation({
    mutationFn: (minor: number) =>
      upsertLiability(
        userId,
        { name: liability!.name, liability_type: liability!.liability_type, current_balance_minor: minor, balance_source: 'user_stated', balance_effective_date: todayIso() },
        id,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liabilities'] })
      setBalanceEdit(null)
    },
  })

  const persistRevised = useMutation({
    mutationFn: async () => {
      if (!schedule || !scenario) return
      await saveSchedule(userId, id!, 'original', schedule)
      const chosen = liability?.overpayment_rule === 'reduce_payment' ? scenario.reducePayment : scenario.reduceTerm
      await saveSchedule(userId, id!, 'revised', chosen.rows)
    },
  })

  if (!liabilities || !payments) return <Spinner />
  if (!liability) {
    return (
      <p className="text-sm text-ink-muted">
        Debt not found. <Link to="/debts" className="text-accent">Back to debts</Link>
      </p>
    )
  }

  const contractualBalance = schedule ? expectedBalanceAt(schedule, todayIso()) : null
  const overpaid = payments.filter((p) => p.kind === 'overpayment').reduce((s, p) => s + p.amount_minor, 0)
  const remainingInterest =
    schedule && contractualBalance !== null
      ? schedule.filter((r) => r.dueDate > todayIso()).reduce((s, r) => s + r.interestMinor, 0)
      : null
  const payoffDate = schedule?.[schedule.length - 1]?.dueDate ?? null

  return (
    <div className="space-y-4">
      <PageHeader
        title={liability.name}
        sub={
          <>
            {LIABILITY_LABELS[liability.liability_type]}
            {liability.provider ? ` · ${liability.provider}` : ''}
            {liability.agreement_ref ? ` · ref ${liability.agreement_ref}` : ''}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setBalanceEdit(liability.current_balance_minor)}>
              Update balance
            </Button>
            <Button onClick={() => setRecording(true)}>Record payment</Button>
          </>
        }
      />

      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            large
            label="Current balance"
            value={money(liability.current_balance_minor)}
            sub={
              <>
                <Badge tone={liability.balance_source === 'lender_confirmed' ? 'good' : 'neutral'}>
                  {liability.balance_source.replace('_', ' ')}
                </Badge>{' '}
                as of {formatDate(liability.balance_effective_date)}
              </>
            }
          />
          {liability.original_balance_minor !== null && (
            <Stat label="Original balance" value={money(liability.original_balance_minor)} />
          )}
          {liability.apr !== null && <Stat label="APR" value={`${liability.apr}%`} sub={liability.rate_type ?? undefined} />}
          {liability.monthly_payment_minor !== null && (
            <Stat label="Monthly payment" value={money(liability.monthly_payment_minor)} sub={liability.payment_day ? `day ${liability.payment_day}` : undefined} />
          )}
          {contractualBalance !== null && (
            <Stat
              label="Contractual balance today"
              value={money(contractualBalance)}
              sub="per original schedule (calculated)"
            />
          )}
          {remainingInterest !== null && (
            <Stat label="Interest remaining" value={money(remainingInterest)} sub="estimated" />
          )}
          {payoffDate && <Stat label="Estimated payoff" value={formatDate(payoffDate)} />}
          {overpaid > 0 && <Stat label="Overpayments made" value={money(overpaid)} tone="good" />}
        </div>
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-ink-muted">
          Your lender's settlement figure may include additional interest, fees or contract-specific
          adjustments. Use the lender's figure for an exact early settlement amount.
          {liability.settlement_quote_minor !== null && (
            <>
              {' '}
              Lender quote on file: <strong>{money(liability.settlement_quote_minor)}</strong>
              {liability.settlement_quote_expiry ? ` (valid until ${formatDate(liability.settlement_quote_expiry)})` : ''}.
            </>
          )}
        </p>
      </Card>

      {/* Overpayment calculator */}
      {scheduleInput ? (
        <Card>
          <CardTitle>Overpayment calculator</CardTitle>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Extra per month</Label>
              <MoneyInput valueMinor={extraMonthly} onChangeMinor={setExtraMonthly} allowNegative={false} placeholder="e.g. 150.00" />
            </div>
            <div>
              <Label>One-off overpayment now</Label>
              <MoneyInput valueMinor={oneOff} onChangeMinor={setOneOff} allowNegative={false} placeholder="e.g. 500.00" />
            </div>
          </div>
          {scenario && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['If overpayments reduce the term', scenario.reduceTerm, 'reduce_term'],
                  ['If overpayments reduce the payment', scenario.reducePayment, 'reduce_payment'],
                ] as const
              ).map(([title, r, mode]) => (
                <div
                  key={mode}
                  className={`rounded-lg border p-3 ${scenario.rule === mode ? 'border-accent' : 'border-border'}`}
                >
                  <p className="mb-1 text-xs font-semibold">
                    {title}
                    {scenario.rule === mode && <Badge tone="accent" className="ml-1.5">your contract</Badge>}
                    {scenario.rule === 'unknown' && <Badge className="ml-1.5">scenario</Badge>}
                  </p>
                  <p className="text-sm">
                    Interest saved: <strong className="tnum text-good">{money(r.interestSavedMinor)}</strong>
                  </p>
                  <p className="text-sm">
                    {mode === 'reduce_term' ? (
                      <>
                        Months saved: <strong className="tnum">{r.monthsSaved}</strong> — finishes{' '}
                        {r.rows.length > 0 ? formatDate(r.rows[r.rows.length - 1].dueDate) : '—'}
                      </>
                    ) : (
                      <>
                        New payment:{' '}
                        <strong className="tnum">
                          {r.newPaymentMinor ? money(r.newPaymentMinor) : money(scheduleInput.paymentMinor ?? derivePaymentMinor(scheduleInput.principalMinor, scheduleInput.apr, scheduleInput.termMonths))}
                        </strong>{' '}
                        over the same term
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Estimated from the amortisation model — not a lender quotation.
                  </p>
                </div>
              ))}
            </div>
          )}
          {scenario && liability.overpayment_rule === 'unknown' && (
            <p className="mt-2 text-[11px] text-ink-muted">
              Your contract doesn't specify whether overpayments reduce the term or the payment, so
              both scenarios are shown.
            </p>
          )}
          {scenario && (
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => persistRevised.mutate()}
              disabled={persistRevised.isPending}
            >
              {persistRevised.isSuccess ? 'Saved as revised schedule' : 'Save revised schedule'}
            </Button>
          )}
        </Card>
      ) : (
        <Card>
          <CardTitle>Overpayment calculator</CardTitle>
          <p className="text-xs text-ink-muted">
            To model overpayments, this debt needs an original amount, APR, term and first payment
            date. Edit them via “Update balance” on the Debts page or upload the loan contract on
            the Imports page for AI extraction.
          </p>
        </Card>
      )}

      {/* Schedule */}
      {schedule && (
        <Card>
          <CardTitle>Repayment schedule (original, calculated)</CardTitle>
          <p className="mb-2 text-xs text-ink-muted">
            Total interest over the loan: <strong className="tnum">{money(totalInterest(schedule))}</strong>
          </p>
          <div className="max-h-72 overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-ink-faint">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Due</th>
                  <th className="py-1 pr-3 text-right">Payment</th>
                  <th className="py-1 pr-3 text-right">Interest</th>
                  <th className="py-1 pr-3 text-right">Principal</th>
                  <th className="py-1 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {schedule.map((r) => (
                  <tr key={r.paymentNumber} className={r.dueDate <= todayIso() ? 'text-ink-faint' : ''}>
                    <td className="py-1 pr-3">{r.paymentNumber}</td>
                    <td className="py-1 pr-3">{formatDate(r.dueDate)}</td>
                    <td className="py-1 pr-3 text-right">{money(r.paymentMinor)}</td>
                    <td className="py-1 pr-3 text-right">{money(r.interestMinor)}</td>
                    <td className="py-1 pr-3 text-right">{money(r.principalMinor)}</td>
                    <td className="py-1 text-right">{money(r.balanceAfterMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Payment history */}
      <Card>
        <CardTitle>Payment history</CardTitle>
        {payments.length === 0 ? (
          <p className="text-xs text-ink-faint">No payments recorded yet.</p>
        ) : (
          <div className="space-y-1">
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between border-b border-border py-1.5 text-sm last:border-0">
                <span className="text-ink-muted">
                  {formatDate(p.date)}{' '}
                  <Badge tone={p.kind === 'overpayment' ? 'good' : p.kind === 'missed' ? 'bad' : 'neutral'}>
                    {p.kind}
                  </Badge>
                </span>
                <span className="tnum font-medium">{money(p.amount_minor)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Dialogs */}
      <Dialog open={recording} onClose={() => setRecording(false)} title="Record a payment">
        <RecordPaymentForm
          defaultAmount={liability.monthly_payment_minor}
          onSave={(p) => recordPayment.mutate(p)}
          busy={recordPayment.isPending}
        />
      </Dialog>

      <Dialog open={balanceEdit !== null} onClose={() => setBalanceEdit(null)} title="Update balance">
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">
            Enter the balance from your lender's app or statement. It will be recorded as
            user-stated with today's date.
          </p>
          <MoneyInput valueMinor={balanceEdit} onChangeMinor={setBalanceEdit} allowNegative={false} />
          <Button
            className="w-full"
            onClick={() => balanceEdit !== null && updateBalance.mutate(balanceEdit)}
            disabled={updateBalance.isPending}
          >
            Save balance
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

function RecordPaymentForm({
  defaultAmount,
  onSave,
  busy,
}: {
  defaultAmount: number | null
  onSave: (p: { amount_minor: number; kind: DebtPayment['kind']; date: string }) => void
  busy: boolean
}) {
  const [amount, setAmount] = useState<number | null>(defaultAmount)
  const [kind, setKind] = useState<DebtPayment['kind']>('scheduled')
  const [date, setDate] = useState(todayIso())
  return (
    <div className="space-y-3">
      <div>
        <Label>Amount paid</Label>
        <MoneyInput valueMinor={amount} onChangeMinor={setAmount} allowNegative={false} />
      </div>
      <div>
        <Label>Type</Label>
        <Select value={kind} onChange={(e) => setKind(e.target.value as DebtPayment['kind'])}>
          <option value="scheduled">Scheduled payment</option>
          <option value="overpayment">Overpayment</option>
          <option value="fee">Fee</option>
          <option value="adjustment">Adjustment</option>
        </Select>
      </div>
      <div>
        <Label>Date</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <p className="text-[11px] text-ink-faint">
        The balance will be reduced by this amount and marked “calculated”. Check against your
        lender's figure periodically.
      </p>
      <Button className="w-full" disabled={amount === null || busy} onClick={() => onSave({ amount_minor: amount!, kind, date })}>
        Record payment
      </Button>
    </div>
  )
}

function nextPaymentIndex(schedule: { dueDate: string; paymentNumber: number }[], today: string): number {
  for (const r of schedule) if (r.dueDate > today) return r.paymentNumber
  return Math.max(1, schedule.length)
}
