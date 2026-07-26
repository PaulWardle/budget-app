import { assignColors, chartAxis, dateTooltipLabel, gbpTooltip, gridStroke, isDarkMode, tooltipStyle } from '@/components/charts/theme'
import { AccountSelect, MoneyInput, PageHeader, Stat } from '@/components/shared/common'
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  Input,
  Label,
  ProgressBar,
  Select,
  Spinner,
  Switch,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  buildNetWorthItems,
  deleteSavingsGoal,
  fetchAccounts,
  fetchLiabilities,
  fetchNetWorthHistory,
  fetchSavingsGoals,
  upsertSavingsGoal,
} from '@/lib/api'
import { adjustedNetWorth } from '@/lib/engine/networth'
import { formatDate, formatDateShort, formatDateTime, money } from '@/lib/format'
import type { Account, SavingsGoal } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export default function WealthPage() {
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const { data: liabilities } = useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })
  const { data: history } = useQuery({ queryKey: ['networth', 'history'], queryFn: fetchNetWorthHistory })
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const items = useMemo(
    () => (accounts && liabilities ? buildNetWorthItems(accounts, liabilities) : []),
    [accounts, liabilities],
  )
  const result = useMemo(() => adjustedNetWorth(items, excluded), [items, excluded])

  if (!accounts || !liabilities) return <Spinner />

  const lastUpdated = accounts.reduce<string | null>(
    (max, a) => (max === null || a.balance_updated_at > max ? a.balance_updated_at : max),
    null,
  )
  const dark = isDarkMode()
  const assets = items.filter((i) => i.class === 'asset' && i.includeInNetWorth)
  const debts = items.filter((i) => i.class === 'liability' && i.includeInNetWorth)

  const donutData = (rows: typeof items) => {
    const sorted = [...rows].sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor))
    const top = sorted.slice(0, 5)
    const rest = sorted.slice(5)
    const data = top.map((i) => ({ name: i.name, value: Math.abs(i.balanceMinor) / 100 }))
    if (rest.length > 0) {
      data.push({ name: 'Other', value: rest.reduce((s, i) => s + Math.abs(i.balanceMinor), 0) / 100 })
    }
    return data
  }
  const assetDonut = donutData(assets)
  const debtDonut = donutData(debts)
  const assetColors = assignColors(assetDonut.map((d) => d.name), dark)
  const debtColors = assignColors(debtDonut.map((d) => d.name), dark)

  const trendData = (history ?? []).map((s) => ({
    date: s.date,
    netWorth: s.net_worth_minor / 100,
    assets: s.assets_minor / 100,
    liabilities: s.liabilities_minor / 100,
  }))

  const changes = computeChanges(history ?? [])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Total wealth"
        sub={lastUpdated ? `Position last updated: ${formatDateTime(lastUpdated)}` : undefined}
      />

      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat large label="Net worth" value={money(result.full.netWorthMinor)} tone={result.full.netWorthMinor >= 0 ? undefined : 'bad'} />
          <Stat label="Total assets" value={money(result.full.assetsMinor)} />
          <Stat label="Total liabilities" value={money(result.full.liabilitiesMinor)} />
          <Stat
            label="Liquid position"
            value={money(result.full.liquidPositionMinor)}
            sub={`${money(result.full.liquidAssetsMinor)} liquid − ${money(result.full.liquidLiabilitiesMinor)} short-term debt`}
          />
        </div>
        {changes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {changes.map((c) => (
              <Badge key={c.label} tone={c.deltaMinor >= 0 ? 'good' : 'bad'}>
                {c.label}: {money(c.deltaMinor, { showSign: true })}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      <GoalsSection accounts={accounts} />

      {/* Adjusted view */}
      <Card>
        <CardTitle>Adjusted view</CardTitle>
        <p className="mb-2 text-xs text-ink-muted">
          Temporarily exclude items to see a what-if position. The official net worth above never
          changes.
        </p>
        <div className="space-y-1.5">
          {items
            .filter((i) => i.includeInNetWorth)
            .map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {i.name}
                  <span className="ml-1.5 text-[11px] text-ink-faint">{i.class}</span>
                </span>
                <div className="flex items-center gap-2">
                  <span className={`tnum text-xs ${i.class === 'liability' ? 'text-bad' : 'text-ink-muted'}`}>
                    {i.class === 'liability' ? '−' : ''}
                    {money(Math.abs(i.balanceMinor))}
                  </span>
                  <Switch
                    checked={!excluded.has(i.id)}
                    onChange={(on) => {
                      const next = new Set(excluded)
                      if (on) next.delete(i.id)
                      else next.add(i.id)
                      setExcluded(next)
                    }}
                  />
                </div>
              </div>
            ))}
        </div>
        {excluded.size > 0 && (
          <div className="mt-3 rounded-lg bg-accent/10 px-3 py-2">
            <p className="text-sm">
              Adjusted net worth: <strong className="tnum">{money(result.adjusted.netWorthMinor)}</strong>{' '}
              <span className="text-xs text-ink-muted">
                (full figure: {money(result.full.netWorthMinor)})
              </span>
            </p>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Excluded: {result.excluded.map((e) => e.name).join(', ')}
            </p>
          </div>
        )}
      </Card>

      {/* Trend */}
      <Card>
        <CardTitle>Net-worth trend</CardTitle>
        {trendData.length < 2 ? (
          <p className="text-xs text-ink-faint">
            Snapshots are recorded whenever balances change — the trend appears once there are a few
            days of history.
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-muted">
              {trendData.length} snapshots · latest {money(Math.round(trendData[trendData.length - 1].netWorth * 100))}
            </p>
            <div className="h-52">
              <ResponsiveContainer>
                <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  <XAxis dataKey="date" tickFormatter={formatDateShort} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} />
                  <YAxis tickFormatter={(v: number) => `£${Math.round(v / 1000)}k`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} width={48} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={gbpTooltip}
                    labelFormatter={dateTooltipLabel}
                  />
                  <Line type="monotone" dataKey="netWorth" name="Net worth" stroke="var(--app-accent)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="assets" name="Assets" stroke="var(--app-good)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="liabilities" name="Liabilities" stroke="var(--app-bad)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex gap-3 text-[11px] text-ink-muted">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />Net worth</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-good" />Assets</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-bad" />Liabilities</span>
            </div>
          </>
        )}
      </Card>

      {/* Allocation donuts */}
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ['Asset allocation', assetDonut, assetColors, result.full.assetsMinor],
            ['Liability allocation', debtDonut, debtColors, result.full.liabilitiesMinor],
          ] as const
        ).map(([title, data, colors, total]) => (
          <Card key={title}>
            <CardTitle>{title}</CardTitle>
            {data.length === 0 ? (
              <p className="text-xs text-ink-faint">Nothing recorded yet.</p>
            ) : (
              <>
                <p className="mb-1 text-xs text-ink-muted">Total {money(total)}</p>
                <div className="h-44">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2} stroke="var(--app-surface)" strokeWidth={2}>
                        {data.map((d) => (
                          <Cell key={d.name} fill={colors.get(d.name)} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 space-y-0.5">
                  {data.map((d) => (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: colors.get(d.name) }} />
                        {d.name}
                      </span>
                      <span className="tnum text-ink-muted">{money(Math.round(d.value * 100))}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- goals
const GOAL_KINDS: { value: SavingsGoal['kind']; label: string }[] = [
  { value: 'emergency_fund', label: 'Emergency fund' },
  { value: 'goal', label: 'Goal' },
  { value: 'sinking_fund', label: 'Sinking fund' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'debt_pot', label: 'Debt pot' },
  { value: 'general', label: 'General' },
]

function monthsUntil(dateIso: string): number {
  const now = new Date()
  const target = new Date(dateIso)
  return Math.max(
    0,
    (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth(),
  )
}

function GoalsSection({ accounts }: { accounts: Account[] }) {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: goals } = useQuery({ queryKey: ['savings-goals'], queryFn: fetchSavingsGoals })
  const [editing, setEditing] = useState<SavingsGoal | null>(null)
  const [adding, setAdding] = useState(false)
  const [contributing, setContributing] = useState<SavingsGoal | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['savings-goals'] })

  // A goal linked to an account tracks that account's live balance — the
  // stored current_minor is only used for unlinked goals.
  const currentOf = (g: SavingsGoal): number => {
    if (g.linked_account_id) {
      const acc = accounts.find((a) => a.id === g.linked_account_id)
      if (acc) return acc.balance_minor
    }
    return g.current_minor
  }

  const list = goals ?? []

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <CardTitle className="mb-0">Savings goals</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> New goal
        </Button>
      </div>

      {list.length === 0 && (
        <p className="text-xs text-ink-faint">
          Set a target — an emergency fund, a purchase, a pot for annual bills — and watch it fill.
          Link a goal to a savings account and it tracks that account's balance automatically.
        </p>
      )}

      <div className="space-y-3">
        {list.map((g) => {
          const current = currentOf(g)
          const pct = g.target_minor > 0 ? (current / g.target_minor) * 100 : 0
          const done = g.status === 'achieved' || current >= g.target_minor
          const remaining = Math.max(0, g.target_minor - current)
          const months = g.target_date ? monthsUntil(g.target_date) : null
          const neededPerMonth = months && months > 0 ? Math.ceil(remaining / months) : null
          const linkedName = g.linked_account_id
            ? accounts.find((a) => a.id === g.linked_account_id)?.name
            : null
          return (
            <div key={g.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{g.name}</p>
                    {done && <Badge tone="good">achieved 🎉</Badge>}
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {GOAL_KINDS.find((k) => k.value === g.kind)?.label ?? g.kind}
                    {linkedName ? ` · tracks ${linkedName}` : ''}
                    {g.target_date ? ` · by ${formatDate(g.target_date)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {!g.linked_account_id && !done && (
                    <Button size="sm" variant="secondary" onClick={() => setContributing(g)}>
                      + Add
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                    Edit
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <p className="tnum text-sm font-semibold">
                  {money(current)} <span className="font-normal text-ink-muted">of {money(g.target_minor)}</span>
                </p>
                <span className="text-xs text-ink-muted">{Math.min(100, Math.round(pct))}%</span>
              </div>
              <ProgressBar className="mt-1.5" value={Math.min(pct, 100)} tone={done ? 'good' : 'accent'} />
              {!done && neededPerMonth !== null && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  {money(remaining)} to go · needs {money(neededPerMonth)}/month to hit{' '}
                  {formatDate(g.target_date!)}
                </p>
              )}
              {!done && neededPerMonth === null && remaining > 0 && g.monthly_planned_minor > 0 && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  {money(remaining)} to go · at {money(g.monthly_planned_minor)}/month that's ~
                  {Math.ceil(remaining / g.monthly_planned_minor)} months
                </p>
              )}
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <GoalDialog
          goal={editing}
          accounts={accounts}
          userId={userId}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={invalidate}
        />
      )}
      {contributing && (
        <ContributeDialog
          goal={contributing}
          userId={userId}
          onClose={() => setContributing(null)}
          onSaved={invalidate}
        />
      )}
    </Card>
  )
}

function GoalDialog({
  goal,
  accounts,
  userId,
  onClose,
  onSaved,
}: {
  goal: SavingsGoal | null
  accounts: Account[]
  userId: string
  onClose: () => void
  onSaved: () => void
}) {
  const savingsAccounts = accounts.filter((a) =>
    ['savings', 'current', 'investment', 'cash', 'wallet'].includes(a.account_type),
  )
  const [form, setForm] = useState({
    name: goal?.name ?? '',
    kind: goal?.kind ?? ('goal' as SavingsGoal['kind']),
    target_minor: goal?.target_minor ?? null,
    current_minor: goal?.current_minor ?? 0,
    target_date: goal?.target_date ?? '',
    monthly_planned_minor: goal?.monthly_planned_minor ?? null,
    linked_account_id: goal?.linked_account_id ?? null,
  })
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      upsertSavingsGoal(
        userId,
        {
          name: form.name.trim(),
          kind: form.kind,
          target_minor: form.target_minor ?? 0,
          current_minor: form.linked_account_id ? 0 : form.current_minor,
          target_date: form.target_date || null,
          monthly_planned_minor: form.monthly_planned_minor ?? 0,
          linked_account_id: form.linked_account_id,
        },
        goal?.id,
      ),
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteSavingsGoal(goal!.id),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  return (
    <Dialog open onClose={onClose} title={goal ? 'Edit goal' : 'New savings goal'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div>
          <Label>Name</Label>
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Emergency fund"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Target</Label>
            <MoneyInput
              valueMinor={form.target_minor}
              onChangeMinor={(m) => setForm({ ...form, target_minor: m })}
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as SavingsGoal['kind'] })}
            >
              {GOAL_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Target date (optional)</Label>
            <Input
              type="date"
              value={form.target_date}
              onChange={(e) => setForm({ ...form, target_date: e.target.value })}
            />
          </div>
          <div>
            <Label>Planned per month (optional)</Label>
            <MoneyInput
              valueMinor={form.monthly_planned_minor}
              onChangeMinor={(m) => setForm({ ...form, monthly_planned_minor: m })}
            />
          </div>
        </div>
        <div>
          <Label>Track an account's balance (optional)</Label>
          <AccountSelect
            accounts={savingsAccounts}
            value={form.linked_account_id}
            onChange={(v) => setForm({ ...form, linked_account_id: v })}
            allowNone
          />
          <p className="mt-1 text-[11px] text-ink-faint">
            Linked goals read the account balance automatically; unlinked goals are topped up by hand.
          </p>
        </div>
        {!form.linked_account_id && (
          <div>
            <Label>Saved so far</Label>
            <MoneyInput
              valueMinor={form.current_minor}
              onChangeMinor={(m) => setForm({ ...form, current_minor: m ?? 0 })}
            />
          </div>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-between">
          {goal ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={() => remove.mutate()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={save.isPending || !form.name.trim() || !form.target_minor}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ContributeDialog({
  goal,
  userId,
  onClose,
  onSaved,
}: {
  goal: SavingsGoal
  userId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState<number | null>(null)
  const save = useMutation({
    mutationFn: () => {
      const next = goal.current_minor + (amount ?? 0)
      return upsertSavingsGoal(
        userId,
        {
          name: goal.name,
          target_minor: goal.target_minor,
          current_minor: next,
          ...(next >= goal.target_minor ? { status: 'achieved' as const } : {}),
        },
        goal.id,
      )
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const next = goal.current_minor + (amount ?? 0)
  return (
    <Dialog open onClose={onClose} title={`Add to ${goal.name}`}>
      <div className="space-y-3">
        <div>
          <Label>Amount added</Label>
          <MoneyInput valueMinor={amount} onChangeMinor={setAmount} />
        </div>
        <p className="text-xs text-ink-muted">
          {money(goal.current_minor)} → <strong className="tnum">{money(next)}</strong> of{' '}
          {money(goal.target_minor)}
          {next >= goal.target_minor && ' — goal achieved 🎉'}
        </p>
        <div className="flex justify-end">
          <Button disabled={!amount || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Add'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function computeChanges(history: { date: string; net_worth_minor: number }[]) {
  if (history.length === 0) return []
  const latest = history[history.length - 1]
  const periods = [
    { label: '1 month', days: 30 },
    { label: '3 months', days: 91 },
    { label: '6 months', days: 182 },
    { label: '12 months', days: 365 },
  ]
  const out: { label: string; deltaMinor: number }[] = []
  for (const p of periods) {
    const cutoff = new Date(Date.now() - p.days * 86_400_000).toISOString().slice(0, 10)
    const base = [...history].reverse().find((s) => s.date <= cutoff)
    if (base && base.date !== latest.date) {
      out.push({ label: p.label, deltaMinor: latest.net_worth_minor - base.net_worth_minor })
    }
  }
  return out
}
