import { assignColors, chartAxis, gbpTooltip, gridStroke, isDarkMode, tooltipStyle } from '@/components/charts/theme'
import { PageHeader, categoryLabel } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, Select, Spinner } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import {
  fetchAccounts,
  fetchCategories,
  fetchInsights,
  fetchLiabilities,
  fetchRecurring,
  fetchTransactions,
  setInsightStatus,
} from '@/lib/api'
import { generateInsights } from '@/lib/insights'
import { formatDate, money, todayIso } from '@/lib/format'
import type { Insight } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const RANGES = [
  { key: 'month', label: 'Current month', months: 0 },
  { key: 'prev', label: 'Previous month', months: -1 },
  { key: '3m', label: 'Last 3 months', months: 3 },
  { key: '6m', label: 'Last 6 months', months: 6 },
  { key: 'ytd', label: 'Year to date', months: 12 },
  { key: '12m', label: 'Last 12 months', months: 12 },
]

function rangeDates(key: string): { from: string; to: string } {
  const now = new Date()
  const to = todayIso()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  switch (key) {
    case 'month':
      return { from: start.toISOString().slice(0, 10), to }
    case 'prev': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const e = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) }
    }
    case '3m':
      return { from: new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10), to }
    case '6m':
      return { from: new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10), to }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to }
    default:
      return { from: new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString().slice(0, 10), to }
  }
}

export default function InsightsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const [range, setRange] = useState('month')
  const { from, to } = useMemo(() => rangeDates(range), [range])

  const { data: insights, isLoading } = useQuery({ queryKey: ['insights'], queryFn: () => fetchInsights() })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: recurring } = useQuery({ queryKey: ['recurring'], queryFn: fetchRecurring })
  const { data: txns } = useQuery({
    queryKey: ['transactions', 'analytics', from, to],
    queryFn: () => fetchTransactions({ from, to, limit: 3000 }),
  })
  // Wide history for generation
  const historyFrom = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 6)
    return d.toISOString().slice(0, 10)
  }, [])
  const { data: historyTxns } = useQuery({
    queryKey: ['transactions', 'history', historyFrom],
    queryFn: () => fetchTransactions({ from: historyFrom, limit: 3000 }),
  })
  useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  useQuery({ queryKey: ['liabilities'], queryFn: fetchLiabilities })

  const regen = useMutation({
    mutationFn: async () => {
      if (!historyTxns || !categories || !recurring) return 0
      return generateInsights(userId, historyTxns, categories, recurring)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  })

  const feedback = useMutation({
    mutationFn: (p: { id: string; status: Insight['status']; fb?: 'dismissed' | 'muted_type' | 'useful' }) =>
      setInsightStatus(userId, p.id, p.status, p.fb),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  })

  const analytics = useMemo(() => {
    const rows = (txns ?? []).filter(
      (t) => !t.is_transfer && !t.exclude_from_analytics && !t.is_reimbursable,
    )
    const spend = rows.filter((t) => t.amount_minor < 0)
    const byCat = new Map<string, number>()
    for (const t of spend) {
      // Respect splits in analytics
      if (t.transaction_splits && t.transaction_splits.length > 0) {
        for (const s of t.transaction_splits) {
          if (s.amount_minor < 0) byCat.set(s.category_id ?? 'none', (byCat.get(s.category_id ?? 'none') ?? 0) + -s.amount_minor)
        }
      } else {
        byCat.set(t.category_id ?? 'none', (byCat.get(t.category_id ?? 'none') ?? 0) + -t.amount_minor)
      }
    }
    const byMerchant = new Map<string, number>()
    for (const t of spend) {
      const m = (t.merchant_name ?? t.description).trim()
      byMerchant.set(m, (byMerchant.get(m) ?? 0) + -t.amount_minor)
    }
    const totalSpend = spend.reduce((s, t) => s + -t.amount_minor, 0)
    const totalIncome = rows.filter((t) => t.amount_minor > 0).reduce((s, t) => s + t.amount_minor, 0)
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1)
    return { byCat, byMerchant, totalSpend, totalIncome, days, count: spend.length }
  }, [txns, from, to])

  if (isLoading || !categories) return <Spinner />

  const dark = isDarkMode()
  const catData = [...analytics.byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, v]) => ({ id, name: categoryLabel(categories, id === 'none' ? null : id), value: v / 100 }))
  const restCat = [...analytics.byCat.entries()].sort((a, b) => b[1] - a[1]).slice(6)
  if (restCat.length > 0) {
    catData.push({ id: 'other', name: 'Other', value: restCat.reduce((s, [, v]) => s + v, 0) / 100 })
  }
  const catColors = assignColors(catData.map((d) => d.name), dark)
  const merchantData = [...analytics.byMerchant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, v]) => ({ name, value: v / 100 }))

  return (
    <div className="space-y-4">
      <PageHeader
        title="Insights & analytics"
        actions={
          <Button variant="outline" onClick={() => regen.mutate()} disabled={regen.isPending || !historyTxns}>
            <RefreshCw className={`h-4 w-4 ${regen.isPending ? 'animate-spin' : ''}`} />
            {regen.isPending ? 'Analysing…' : 'Refresh insights'}
          </Button>
        }
      />

      {/* Insight feed */}
      {(insights ?? []).length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">Nothing material needs your attention right now.</p>
          {regen.isSuccess && regen.data === 0 && (
            <p className="mt-1 text-xs text-ink-faint">
              Analysis ran across your history — no significant patterns found.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {(insights ?? []).map((ins) => (
            <Card key={ins.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {ins.severity === 'warning' && <Badge tone="warn" className="mr-1.5">attention</Badge>}
                    {ins.headline}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">{ins.body}</p>
                  {ins.suggested_action && (
                    <p className="mt-1 text-xs text-accent">{ins.suggested_action}</p>
                  )}
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {ins.comparison_period ? `vs ${ins.comparison_period} · ` : ''}
                    confidence {ins.confidence} · {formatDate(ins.created_at.slice(0, 10))}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'dismissed', fb: 'dismissed' })}>
                  Dismiss
                </Button>
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'muted', fb: 'muted_type' })}>
                  Mute this type
                </Button>
                <Button size="sm" variant="ghost" onClick={() => feedback.mutate({ id: ins.id, status: 'actioned', fb: 'useful' })}>
                  Useful
                </Button>
                <Link to="/chat">
                  <Button size="sm" variant="ghost">Ask AI</Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Analytics */}
      <div className="flex items-center gap-2">
        <Select className="w-48" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
        <span className="text-xs text-ink-faint">
          {formatDate(from)} – {formatDate(to)}
        </span>
      </div>

      <Card>
        <CardTitle>Headline numbers</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Spend</p>
            <p className="tnum text-base font-semibold">{money(analytics.totalSpend)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Income</p>
            <p className="tnum text-base font-semibold">{money(analytics.totalIncome)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Avg per day</p>
            <p className="tnum text-base font-semibold">{money(Math.round(analytics.totalSpend / analytics.days))}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">Avg per transaction</p>
            <p className="tnum text-base font-semibold">
              {money(analytics.count ? Math.round(analytics.totalSpend / analytics.count) : 0)}
            </p>
            <p className="text-[11px] text-ink-faint">{analytics.count} transactions</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Spending by category</CardTitle>
          {catData.length === 0 ? (
            <p className="text-xs text-ink-faint">No spending in this range.</p>
          ) : (
            <>
              <p className="mb-1 text-xs text-ink-muted">
                Largest: {catData[0]?.name} at {money(Math.round((catData[0]?.value ?? 0) * 100))}
              </p>
              <div className="h-44">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={catData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2} stroke="var(--app-surface)" strokeWidth={2}>
                      {catData.map((d) => (
                        <Cell key={d.name} fill={catColors.get(d.name)} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={gbpTooltip} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 space-y-0.5">
                {catData.map((d) => (
                  <Link
                    key={d.name}
                    to={d.id !== 'other' && d.id !== 'none' ? `/transactions?category=${d.id}&from=${from}&to=${to}` : `/transactions?from=${from}&to=${to}`}
                    className="flex items-center justify-between text-xs hover:text-accent"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: catColors.get(d.name) }} />
                      {d.name}
                    </span>
                    <span className="tnum text-ink-muted">{money(Math.round(d.value * 100))}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardTitle>Top merchants</CardTitle>
          {merchantData.length === 0 ? (
            <p className="text-xs text-ink-faint">No spending in this range.</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={merchantData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                  <XAxis type="number" tickFormatter={(v: number) => `£${Math.round(v)}`} tick={{ ...chartAxis, fill: 'var(--app-ink-faint)' }} stroke={gridStroke} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ ...chartAxis, fill: 'var(--app-ink-muted)' }} stroke={gridStroke} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => [money(Math.round(Number(v ?? 0) * 100)), 'Spend']} />
                  <Bar dataKey="value" fill="var(--app-accent)" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
