import { assignColors, chartAxis, dateTooltipLabel, gbpTooltip, gridStroke, isDarkMode, tooltipStyle } from '@/components/charts/theme'
import { PageHeader, Stat } from '@/components/shared/common'
import { Badge, Card, CardTitle, Spinner, Switch } from '@/components/ui/primitives'
import { buildNetWorthItems, fetchAccounts, fetchLiabilities, fetchNetWorthHistory } from '@/lib/api'
import { adjustedNetWorth } from '@/lib/engine/networth'
import { formatDateShort, formatDateTime, money } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
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
