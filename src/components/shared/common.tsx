import { Badge, Button, Input, Select } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import { money } from '@/lib/format'
import { parseToMinor } from '@/lib/engine/money'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import type { Account, Category } from '@/types/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone,
  large,
  onClick,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'bad' | 'warn'
  large?: boolean
  /** When set, the stat becomes a button that opens a breakdown of the figure. */
  onClick?: () => void
}) {
  const body = (
    <>
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
        {onClick && <span aria-hidden className="ml-1 text-ink-faint/70">›</span>}
      </p>
      <p
        className={cn(
          'tnum font-semibold',
          large ? 'text-2xl' : 'text-base',
          tone === 'good' && 'text-good',
          tone === 'bad' && 'text-bad',
          tone === 'warn' && 'text-warn',
          onClick && 'underline decoration-border decoration-dotted underline-offset-4',
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-ink-faint">{sub}</p>}
    </>
  )
  if (!onClick) return <div className="min-w-0">{body}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 rounded-lg text-left transition-colors hover:bg-app focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={`${label} — show breakdown`}
    >
      {body}
    </button>
  )
}

export function MoneyValue({ minor, signed }: { minor: number; signed?: boolean }) {
  return (
    <span className={cn('tnum', signed && minor > 0 && 'text-good', signed && minor < 0 && 'text-ink')}>
      {money(minor, { showSign: signed })}
    </span>
  )
}

/** Text input that edits pounds and reports integer minor units. */
export function MoneyInput({
  valueMinor,
  onChangeMinor,
  placeholder,
  allowNegative,
  id,
  className,
}: {
  valueMinor: number | null
  onChangeMinor: (minor: number | null) => void
  placeholder?: string
  allowNegative?: boolean
  id?: string
  className?: string
}) {
  const [text, setText] = useState(valueMinor === null ? '' : (valueMinor / 100).toFixed(2))
  useEffect(() => {
    // Keep local text in sync when the outside value changes materially
    const current = parseToMinor(text)
    if (current !== valueMinor) setText(valueMinor === null ? '' : (valueMinor / 100).toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueMinor])
  return (
    <Input
      id={id}
      inputMode="decimal"
      className={cn('tnum', className)}
      placeholder={placeholder ?? '0.00'}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const minor = parseToMinor(e.target.value)
        if (minor === null) onChangeMinor(e.target.value === '' ? null : valueMinor)
        else onChangeMinor(allowNegative === false ? Math.abs(minor) : minor)
      }}
    />
  )
}

export function CategorySelect({
  categories,
  value,
  onChange,
  allowNone = true,
  allowCreate = true,
  id,
}: {
  categories: Category[]
  value: string | null
  onChange: (id: string | null) => void
  allowNone?: boolean
  allowCreate?: boolean
  id?: string
}) {
  const userId = useUserId()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState('')
  const [saving, setSaving] = useState(false)
  const parents = categories.filter((c) => !c.parent_id)

  const create = async () => {
    if (!newName.trim() || saving) return
    setSaving(true)
    const { data, error } = await supabase
      .from('categories')
      .insert({ user_id: userId, name: newName.trim(), parent_id: newParent || null, kind: 'expense' })
      .select('id')
      .single()
    setSaving(false)
    if (!error && data) {
      qc.invalidateQueries({ queryKey: ['categories'] })
      onChange(data.id as string)
      setCreating(false)
      setNewName('')
      setNewParent('')
    }
  }

  if (creating) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          autoFocus
          className="h-9 w-36"
          placeholder="New category name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
            if (e.key === 'Escape') setCreating(false)
          }}
        />
        <Select className="h-9 w-32" value={newParent} onChange={(e) => setNewParent(e.target.value)}>
          <option value="">Top level</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              under {p.name}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" disabled={!newName.trim() || saving} onClick={() => void create()}>
          {saving ? '…' : 'Add'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <Select
      id={id}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__create__') {
          setCreating(true)
          return
        }
        onChange(e.target.value || null)
      }}
    >
      {allowNone && <option value="">Uncategorised</option>}
      {parents.map((p) => {
        const children = categories.filter((c) => c.parent_id === p.id)
        return (
          <optgroup key={p.id} label={p.name}>
            <option value={p.id}>{p.name}</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {p.name} → {c.name}
              </option>
            ))}
          </optgroup>
        )
      })}
      {allowCreate && <option value="__create__">＋ Create new category…</option>}
    </Select>
  )
}

export function categoryLabel(categories: Category[], id: string | null): string {
  if (!id) return 'Uncategorised'
  const c = categories.find((x) => x.id === id)
  if (!c) return 'Uncategorised'
  if (c.parent_id) {
    const p = categories.find((x) => x.id === c.parent_id)
    return p ? `${p.name} → ${c.name}` : c.name
  }
  return c.name
}

export function AccountSelect({
  accounts,
  value,
  onChange,
  allowNone,
  id,
}: {
  accounts: Account[]
  value: string | null
  onChange: (id: string | null) => void
  allowNone?: boolean
  id?: string
}) {
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">Any account</option>}
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.provider ? ` (${a.provider})` : ''}
        </option>
      ))}
    </Select>
  )
}

export function ConfidenceBadge({ value }: { value: number | null }) {
  if (value === null) return null
  const pct = Math.round(value * 100)
  const tone = value >= 0.85 ? 'good' : value >= 0.6 ? 'warn' : 'bad'
  return <Badge tone={tone}>{pct}% confident</Badge>
}

/** Data-freshness warning shown on dashboards when balances are stale. */
export function StalenessNote({ accounts }: { accounts: Account[] }) {
  const stale = accounts.filter((a) => {
    const days = (Date.now() - new Date(a.balance_updated_at).getTime()) / 86_400_000
    return days > 14 && ['current', 'savings', 'credit_card', 'wallet'].includes(a.account_type)
  })
  if (stale.length === 0) return null
  const worst = stale.reduce((a, b) =>
    a.balance_updated_at < b.balance_updated_at ? a : b,
  )
  const days = Math.floor((Date.now() - new Date(worst.balance_updated_at).getTime()) / 86_400_000)
  return (
    <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
      {worst.name} data was last updated {days} days ago. Current cash and net-worth figures may
      be out of date.
    </p>
  )
}
