import { MoneyInput, PageHeader } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import { accountClass, createAccount, fetchAccounts, fetchBalanceHistory, updateAccount } from '@/lib/api'
import { formatDateTime, money, relativeDays } from '@/lib/format'
import type { Account, AccountType } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'

const TYPE_LABELS: Record<AccountType, string> = {
  current: 'Current account',
  savings: 'Savings account',
  credit_card: 'Credit card',
  wallet: 'PayPal / digital wallet',
  cash: 'Cash',
  loan: 'Loan',
  vehicle_finance: 'Vehicle finance',
  mortgage: 'Mortgage',
  investment: 'Investment',
  pension: 'Pension',
  property: 'Property',
  vehicle: 'Vehicle',
  other_asset: 'Other asset',
  other_liability: 'Other liability',
}

interface FormState {
  id?: string
  name: string
  provider: string
  account_type: AccountType
  balance_minor: number | null
  credit_limit_minor: number | null
  include_in_cashflow: boolean
  include_in_net_worth: boolean
  notes: string
}

const blank: FormState = {
  name: '',
  provider: '',
  account_type: 'current',
  balance_minor: 0,
  credit_limit_minor: null,
  include_in_cashflow: true,
  include_in_net_worth: true,
  notes: '',
}

export default function AccountsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: accounts, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const [form, setForm] = useState<FormState | null>(null)
  const [historyFor, setHistoryFor] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (f: FormState) => {
      const payload = {
        name: f.name,
        provider: f.provider || null,
        account_type: f.account_type,
        balance_minor: f.balance_minor ?? 0,
        credit_limit_minor: f.credit_limit_minor,
        include_in_cashflow: f.include_in_cashflow,
        include_in_net_worth: f.include_in_net_worth,
        notes: f.notes || null,
      }
      if (f.id) await updateAccount(userId, f.id, payload)
      else await createAccount(userId, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['networth'] })
      setForm(null)
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  const archive = useMutation({
    mutationFn: (id: string) =>
      updateAccount(userId, id, { archived_at: new Date().toISOString() } as Partial<Account>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setForm(null)
    },
  })

  const assets = (accounts ?? []).filter((a) => accountClass(a) === 'asset')
  const liabilities = (accounts ?? []).filter((a) => accountClass(a) === 'liability')

  return (
    <div>
      <PageHeader
        title="Accounts"
        sub="Balances update manually, from imports, from AI chat, or from debt calculations. Every change is kept in history."
        actions={
          <Button onClick={() => setForm(blank)}>
            <Plus className="h-4 w-4" /> Add account
          </Button>
        }
      />
      {isLoading && <Spinner />}
      {accounts && accounts.length === 0 && (
        <EmptyState
          title="No accounts yet"
          hint="Add your current account, savings, credit cards and any assets or debts."
        />
      )}
      {[
        { title: 'Assets', rows: assets },
        { title: 'Liabilities', rows: liabilities },
      ].map(
        ({ title, rows }) =>
          rows.length > 0 && (
            <section key={title} className="mb-5">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                {title}
              </h2>
              <div className="space-y-2">
                {rows.map((a) => (
                  <Card
                    key={a.id}
                    className="flex cursor-pointer items-center justify-between gap-3 py-3 hover:border-accent/50"
                    onClick={() =>
                      setForm({
                        id: a.id,
                        name: a.name,
                        provider: a.provider ?? '',
                        account_type: a.account_type,
                        balance_minor: a.balance_minor,
                        credit_limit_minor: a.credit_limit_minor,
                        include_in_cashflow: a.include_in_cashflow,
                        include_in_net_worth: a.include_in_net_worth,
                        notes: a.notes ?? '',
                      })
                    }
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {a.name}
                        {a.provider && (
                          <span className="ml-1.5 font-normal text-ink-faint">{a.provider}</span>
                        )}
                      </p>
                      <p className="text-[11px] text-ink-faint">
                        {TYPE_LABELS[a.account_type]} · updated {relativeDays(a.balance_updated_at)} ·{' '}
                        {a.balance_source}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!a.include_in_net_worth && <Badge>excluded</Badge>}
                      <button
                        className="text-xs text-accent underline-offset-2 hover:underline cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          setHistoryFor(a)
                        }}
                      >
                        history
                      </button>
                      <span className="tnum text-sm font-semibold">{money(a.balance_minor)}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ),
      )}

      <Dialog
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit account' : 'Add account'}
      >
        {form && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate(form)
            }}
          >
            <div>
              <Label htmlFor="acc-name">Account name</Label>
              <Input
                id="acc-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Halifax Reward"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="acc-provider">Provider</Label>
                <Input
                  id="acc-provider"
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                  placeholder="e.g. Halifax"
                />
              </div>
              <div>
                <Label htmlFor="acc-type">Type</Label>
                <Select
                  id="acc-type"
                  value={form.account_type}
                  onChange={(e) => setForm({ ...form, account_type: e.target.value as AccountType })}
                >
                  {Object.entries(TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="acc-balance">Current balance</Label>
                <MoneyInput
                  id="acc-balance"
                  valueMinor={form.balance_minor}
                  onChangeMinor={(m) => setForm({ ...form, balance_minor: m })}
                  allowNegative
                />
              </div>
              {form.account_type === 'credit_card' && (
                <div>
                  <Label htmlFor="acc-limit">Credit limit</Label>
                  <MoneyInput
                    id="acc-limit"
                    valueMinor={form.credit_limit_minor}
                    onChangeMinor={(m) => setForm({ ...form, credit_limit_minor: m })}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
              <span className="text-xs font-medium">Include in cashflow</span>
              <Switch
                checked={form.include_in_cashflow}
                onChange={(v) => setForm({ ...form, include_in_cashflow: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
              <span className="text-xs font-medium">Include in net worth</span>
              <Switch
                checked={form.include_in_net_worth}
                onChange={(v) => setForm({ ...form, include_in_net_worth: v })}
              />
            </div>
            <div>
              <Label htmlFor="acc-notes">Notes</Label>
              <Input
                id="acc-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex justify-between pt-1">
              {form.id ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-bad"
                  onClick={() => archive.mutate(form.id!)}
                >
                  Archive
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={historyFor !== null}
        onClose={() => setHistoryFor(null)}
        title={`${historyFor?.name ?? ''} — balance history`}
      >
        {historyFor && <BalanceHistory account={historyFor} />}
      </Dialog>
    </div>
  )
}

function BalanceHistory({ account }: { account: Account }) {
  const { data, isLoading } = useQuery({
    queryKey: ['balance-history', account.id],
    queryFn: () => fetchBalanceHistory(account.id),
  })
  if (isLoading) return <Spinner />
  return (
    <div className="max-h-80 space-y-1 overflow-y-auto">
      {(data ?? []).map((s) => (
        <div key={s.id} className="flex justify-between border-b border-border py-1.5 text-sm">
          <span className="text-ink-muted">
            {formatDateTime(s.recorded_at)} <Badge className="ml-1">{s.source}</Badge>
          </span>
          <span className="tnum font-medium">{money(s.balance_minor)}</span>
        </div>
      ))}
      {data?.length === 0 && <p className="text-xs text-ink-faint">No history yet.</p>}
    </div>
  )
}
