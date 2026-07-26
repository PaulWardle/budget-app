import { MoneyInput, PageHeader } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  ProgressBar,
  Select,
  Spinner,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  applyContract,
  dismissContract,
  fetchLiabilities,
  fetchPendingContracts,
  upsertLiability,
  type PendingContract,
} from '@/lib/api'
import { processContractUpload } from '@/lib/importFlow'
import { formatDate, money } from '@/lib/format'
import type { Liability, LiabilityType } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

export const LIABILITY_LABELS: Record<LiabilityType, string> = {
  personal_loan: 'Personal loan',
  credit_card: 'Credit card',
  paypal_credit: 'PayPal Credit',
  vehicle_finance: 'Vehicle finance',
  hire_purchase: 'Hire purchase',
  pcp: 'PCP',
  mortgage: 'Mortgage',
  informal: 'Informal debt',
  other: 'Other',
}

const BALANCE_SOURCE_LABELS: Record<Liability['balance_source'], string> = {
  user_stated: 'your last update',
  calculated: 'calculated from payments',
  lender_confirmed: 'lender confirmed',
  imported: 'imported statement',
  estimated: 'estimated',
}

export default function DebtsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: liabilities, isLoading } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: pendingContracts } = useQuery({
    queryKey: ['loan-contracts'],
    queryFn: fetchPendingContracts,
    refetchInterval: (q) => ((q.state.data ?? []).length > 0 || uploadingRef.current ? 5000 : false),
  })
  const [adding, setAdding] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)

  const upload = useMutation({
    mutationFn: async (file: File) => {
      uploadingRef.current = true
      return processContractUpload(userId, file)
    },
    onSuccess: (r) => {
      setUploadMsg(
        r.status === 'failed'
          ? (r.error ?? 'Extraction failed')
          : 'Reading the agreement — terms will appear below shortly.',
      )
      void qc.invalidateQueries({ queryKey: ['loan-contracts'] })
    },
    onError: (e: Error) => setUploadMsg(e.message),
    onSettled: () => {
      setTimeout(() => {
        uploadingRef.current = false
      }, 60_000)
    },
  })

  if (isLoading) return <Spinner />
  const active = (liabilities ?? []).filter((l) => l.status === 'active')
  const total = active.reduce((s, l) => s + l.current_balance_minor, 0)
  const needsBalance = active.filter(
    (l) => l.current_balance_minor === 0 && l.balance_source === 'estimated',
  )

  return (
    <div>
      <PageHeader
        title="Debts"
        sub={`Total owed: ${money(total)} across ${active.length} ${active.length === 1 ? 'debt' : 'debts'}`}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) upload.mutate(f)
                e.target.value = ''
              }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Spinner className="h-4 w-4" /> : <FileUp className="h-4 w-4" />} Upload agreement
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add debt
            </Button>
          </>
        }
      />
      {uploadMsg && <p className="mb-3 text-xs text-ink-muted">{uploadMsg}</p>}

      {needsBalance.length > 0 && (
        <Card className="mb-3 border-warn/40">
          <p className="text-sm">
            <Badge tone="warn" className="mr-1.5">action needed</Badge>
            {needsBalance.length === 1 ? 'One debt needs its' : `${needsBalance.length} debts need their`} real
            balance. Payments are tracked, but payoff dates and net worth stay wrong until the balance is set —
            tap a debt and enter what's owed, or upload its agreement and it'll be read for you.
          </p>
        </Card>
      )}

      {(pendingContracts ?? []).map((c) => (
        <ContractReviewCard
          key={c.id}
          contract={c}
          liabilities={active}
          userId={userId}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['loan-contracts'] })
            void qc.invalidateQueries({ queryKey: ['liabilities'] })
            void qc.invalidateQueries({ queryKey: ['networth'] })
          }}
        />
      ))}

      {active.length === 0 && (
        <EmptyState
          title="No debts tracked"
          hint='Add one manually, upload a loan agreement above, or tell the AI chat e.g. "I still owe £500 on PayPal".'
        />
      )}
      <div className="space-y-2">
        {active.map((l) => {
          const progress =
            l.original_balance_minor && l.original_balance_minor > 0
              ? ((l.original_balance_minor - l.current_balance_minor) / l.original_balance_minor) * 100
              : null
          return (
            <Link key={l.id} to={`/debts/${l.id}`} className="block">
              <Card className="hover:border-accent/50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {l.name}
                      <span className="ml-1.5 font-normal text-ink-faint">
                        {LIABILITY_LABELS[l.liability_type]}
                      </span>
                    </p>
                    <p className="text-[11px] text-ink-faint">
                      {l.apr !== null ? `${l.apr}% APR · ` : ''}
                      {l.monthly_payment_minor ? `${money(l.monthly_payment_minor)}/month · ` : ''}
                      balance from {BALANCE_SOURCE_LABELS[l.balance_source]} on{' '}
                      {formatDate(l.balance_effective_date)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum text-base font-bold">{money(l.current_balance_minor)}</p>
                    {l.original_balance_minor !== null && (
                      <p className="text-[11px] text-ink-faint">of {money(l.original_balance_minor)}</p>
                    )}
                  </div>
                </div>
                {progress !== null && (
                  <div className="mt-2 flex items-center gap-2">
                    <ProgressBar value={progress} tone="good" className="flex-1" />
                    <span className="text-[11px] text-ink-faint">{Math.round(progress)}% repaid</span>
                  </div>
                )}
              </Card>
            </Link>
          )
        })}
      </div>

      {(liabilities ?? []).some((l) => l.status === 'settled') && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-ink-faint">Settled debts</summary>
          <div className="mt-2 space-y-2">
            {(liabilities ?? [])
              .filter((l) => l.status === 'settled')
              .map((l) => (
                <Card key={l.id} className="flex justify-between py-3 opacity-60">
                  <span className="text-sm">{l.name}</span>
                  <Badge tone="good">settled</Badge>
                </Card>
              ))}
          </div>
        </details>
      )}

      {adding && (
        <AddDebtDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['liabilities'] })
            qc.invalidateQueries({ queryKey: ['networth'] })
            setAdding(false)
          }}
          userId={userId}
        />
      )}
    </div>
  )
}

const CONTRACT_FIELDS: { key: string; label: string; money?: boolean }[] = [
  { key: 'lender', label: 'Lender' },
  { key: 'original_amount_minor', label: 'Amount borrowed', money: true },
  { key: 'current_balance_minor', label: 'Balance', money: true },
  { key: 'apr', label: 'APR %' },
  { key: 'monthly_payment_minor', label: 'Monthly payment', money: true },
  { key: 'term_months', label: 'Term (months)' },
  { key: 'start_date', label: 'Start date' },
  { key: 'final_payment_minor', label: 'Final payment', money: true },
  { key: 'balloon_minor', label: 'Balloon', money: true },
  { key: 'overpayment_rule', label: 'Overpayments' },
]

function ContractReviewCard({
  contract,
  liabilities,
  userId,
  onDone,
}: {
  contract: PendingContract
  liabilities: Liability[]
  userId: string
  onDone: () => void
}) {
  const x = contract.extracted as Record<string, unknown>
  // Best guess at which debt this agreement belongs to, by lender name
  const lender = String(x.lender ?? '').toUpperCase()
  const guess = liabilities.find(
    (l) =>
      lender &&
      (l.provider?.toUpperCase().includes(lender.split(' ')[0]) ||
        lender.includes((l.provider ?? '¤').toUpperCase().split(' ')[0])),
  )
  const [target, setTarget] = useState<string>(guess?.id ?? 'new')
  const apply = useMutation({
    mutationFn: () => applyContract(userId, contract, target === 'new' ? null : target),
    onSuccess: onDone,
  })
  const dismiss = useMutation({
    mutationFn: () => dismissContract(contract.id),
    onSuccess: onDone,
  })
  const found = CONTRACT_FIELDS.filter((f) => x[f.key] !== null && x[f.key] !== undefined)
  return (
    <Card className="mb-3 border-accent/40">
      <p className="mb-2 text-sm font-semibold">
        Agreement read{x.lender ? ` — ${String(x.lender)}` : ''}
        <Badge tone="accent" className="ml-1.5">review</Badge>
      </p>
      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {found.map((f) => (
          <p key={f.key} className="text-xs">
            <span className="text-ink-faint">{f.label}: </span>
            <span className="tnum font-medium">
              {f.money ? money(Number(x[f.key])) : String(x[f.key])}
            </span>
          </p>
        ))}
        {found.length === 0 && (
          <p className="text-xs text-ink-faint">Nothing could be read from this document.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-56" value={target} onChange={(e) => setTarget(e.target.value)}>
          {liabilities.map((l) => (
            <option key={l.id} value={l.id}>
              Apply to: {l.name}
            </option>
          ))}
          <option value="new">Create a new debt</option>
        </Select>
        <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || found.length === 0}>
          {apply.isPending ? 'Applying…' : 'Apply terms'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()}>
          Discard
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        Terms from the agreement override what's on the debt — but only fields the document actually
        states. Everything stays editable afterwards.
      </p>
    </Card>
  )
}

function AddDebtDialog({
  onClose,
  onSaved,
  userId,
}: {
  onClose: () => void
  onSaved: () => void
  userId: string
}) {
  const [form, setForm] = useState({
    name: '',
    provider: '',
    liability_type: 'personal_loan' as LiabilityType,
    current_balance_minor: null as number | null,
    original_balance_minor: null as number | null,
    apr: '',
    monthly_payment_minor: null as number | null,
    term_months: '',
    start_date: '',
    payment_day: '',
  })
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      upsertLiability(userId, {
        name: form.name,
        provider: form.provider || null,
        liability_type: form.liability_type,
        current_balance_minor: form.current_balance_minor ?? 0,
        original_balance_minor: form.original_balance_minor,
        apr: form.apr ? Number(form.apr) : null,
        monthly_payment_minor: form.monthly_payment_minor,
        term_months: form.term_months ? Number(form.term_months) : null,
        start_date: form.start_date || null,
        payment_day: form.payment_day ? Number(form.payment_day) : null,
        balance_source: 'user_stated',
      }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  })
  return (
    <Dialog open onClose={onClose} title="Add debt" wide>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div>
          <Label>Name</Label>
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Car loan" />
        </div>
        <div>
          <Label>Provider</Label>
          <Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="e.g. Santander" />
        </div>
        <div>
          <Label>Type</Label>
          <Select
            value={form.liability_type}
            onChange={(e) => setForm({ ...form, liability_type: e.target.value as LiabilityType })}
          >
            {Object.entries(LIABILITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Current balance owed</Label>
          <MoneyInput
            valueMinor={form.current_balance_minor}
            onChangeMinor={(m) => setForm({ ...form, current_balance_minor: m })}
            allowNegative={false}
          />
        </div>
        <div>
          <Label>Original amount (optional)</Label>
          <MoneyInput
            valueMinor={form.original_balance_minor}
            onChangeMinor={(m) => setForm({ ...form, original_balance_minor: m })}
            allowNegative={false}
          />
        </div>
        <div>
          <Label>APR % (optional)</Label>
          <Input
            inputMode="decimal"
            value={form.apr}
            onChange={(e) => setForm({ ...form, apr: e.target.value })}
            placeholder="e.g. 6.9"
          />
        </div>
        <div>
          <Label>Monthly payment (optional)</Label>
          <MoneyInput
            valueMinor={form.monthly_payment_minor}
            onChangeMinor={(m) => setForm({ ...form, monthly_payment_minor: m })}
            allowNegative={false}
          />
        </div>
        <div>
          <Label>Term months (optional)</Label>
          <Input
            inputMode="numeric"
            value={form.term_months}
            onChange={(e) => setForm({ ...form, term_months: e.target.value })}
            placeholder="e.g. 60"
          />
        </div>
        <div>
          <Label>First payment date (optional)</Label>
          <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
        </div>
        <div>
          <Label>Payment day of month (optional)</Label>
          <Input
            inputMode="numeric"
            value={form.payment_day}
            onChange={(e) => setForm({ ...form, payment_day: e.target.value })}
            placeholder="e.g. 15"
          />
        </div>
        {error && <p className="col-span-2 text-xs text-bad">{error}</p>}
        <div className="col-span-2 flex justify-end">
          <Button type="submit" disabled={save.isPending || form.current_balance_minor === null}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
