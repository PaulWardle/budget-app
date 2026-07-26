import { PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, Input, Label, PasswordInput, Select, Spinner, Textarea } from '@/components/ui/primitives'
import { useAuth, useUserId } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import {
  clearErrors,
  deleteFact,
  exportAllData,
  exportDiagnostics,
  fetchAuditEvents,
  fetchCategories,
  fetchErrors,
  fetchFacts,
  fetchProfile,
  logAppError,
  updateProfile,
  withTimeout,
} from '@/lib/api'
import { formatDate, formatDateTime } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'

export default function SettingsPage() {
  const userId = useUserId()
  const { session, signOut } = useAuth()
  const { theme, setTheme } = useTheme()
  const qc = useQueryClient()
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile })
  const { data: facts } = useQuery({ queryKey: ['facts'], queryFn: fetchFacts })
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchCategories })
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: () => fetchAuditEvents(50) })
  const { data: errors } = useQuery({ queryKey: ['errors'], queryFn: () => fetchErrors(100) })
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [newCatParent, setNewCatParent] = useState<string>('')
  const [notes, setNotes] = useState<string | null>(null)
  const [notesMsg, setNotesMsg] = useState<string | null>(null)
  const [notesErr, setNotesErr] = useState(false)

  const existingNotes = (facts ?? []).find(
    (f) => f.fact_type === 'context' && f.fact_key === 'user_notes',
  )
  const notesValue = notes ?? ((existingNotes?.value as { text?: string } | undefined)?.text ?? '')

  const saveNotes = useMutation({
    retry: false,
    mutationFn: async () => {
      const value = { text: (notes ?? '').slice(0, 6000) }
      const write = existingNotes
        ? supabase
            .from('financial_facts')
            .update({ value, last_confirmed_at: new Date().toISOString() })
            .eq('id', existingNotes.id)
        : supabase.from('financial_facts').insert({
            user_id: userId,
            fact_type: 'context',
            fact_key: 'user_notes',
            value,
            source: 'manual',
            confidence: 'confirmed',
          })
      const { error } = await withTimeout(Promise.resolve(write), 15_000, 'save')
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      setNotesErr(false)
      setNotesMsg('Saved — the AI will use this in every conversation.')
      qc.invalidateQueries({ queryKey: ['facts'] })
    },
    onError: (e: Error) => {
      setNotesErr(true)
      setNotesMsg(e.message)
      void logAppError(userId, 'app', `Financial memory save failed: ${e.message}`)
    },
  })

  const saveProfile = useMutation({
    mutationFn: (patch: Record<string, unknown>) => updateProfile(userId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  })

  const changePassword = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      setPasswordMsg('Password updated.')
      setNewPassword('')
    },
    onError: (e: Error) => setPasswordMsg(e.message),
  })

  const addCategory = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('categories').insert({
        user_id: userId,
        name: newCategory,
        parent_id: newCatParent || null,
        kind: 'expense',
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      setNewCategory('')
      qc.invalidateQueries({ queryKey: ['categories'] })
    },
  })

  const [editingCat, setEditingCat] = useState<{ id: string; name: string } | null>(null)
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [catMsg, setCatMsg] = useState<string | null>(null)

  const renameCategory = useMutation({
    mutationFn: async (p: { id: string; name: string }) => {
      const { error } = await supabase.from('categories').update({ name: p.name.trim() }).eq('id', p.id)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      setEditingCat(null)
      qc.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: (e: Error) => setCatMsg(e.message),
  })

  // Deleting a category releases its transactions: they become uncategorised
  // and flagged for review, so they surface in Data Quality and the bulk
  // categorise flow until reallocated. Every total recomputes from the ledger.
  const removeCategory = useMutation({
    mutationFn: async (id: string) => {
      const ids = [id, ...(categories ?? []).filter((c) => c.parent_id === id).map((c) => c.id)]
      const { data: released, error: tErr } = await supabase
        .from('transactions')
        .update({ category_id: null, needs_review: true })
        .in('category_id', ids)
        .select('id')
      if (tErr) throw new Error(tErr.message)
      const { error } = await supabase.from('categories').delete().in('id', ids)
      if (error) throw new Error(error.message)
      const n = released?.length ?? 0
      return n > 0
        ? `Deleted — ${n} transaction${n === 1 ? '' : 's'} flagged as uncategorised for you to reallocate`
        : 'Deleted'
    },
    onSuccess: (msg) => {
      setCatMsg(msg)
      qc.invalidateQueries({ queryKey: ['categories'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['budget'] })
    },
    onError: (e: Error) => setCatMsg(e.message),
  })

  const removeFact = useMutation({
    mutationFn: deleteFact,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['facts'] }),
  })

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  const doExport = useMutation({
    mutationFn: exportAllData,
    onSuccess: (blob) => download(blob, `my-money-export-${new Date().toISOString().slice(0, 10)}.json`),
  })

  const doDiagnostics = useMutation({
    mutationFn: exportDiagnostics,
    onSuccess: (blob) => download(blob, `my-money-diagnostics-${new Date().toISOString().slice(0, 10)}.json`),
  })

  const wipeErrors = useMutation({
    mutationFn: clearErrors,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['errors'] }),
  })

  if (!profile) return <Spinner />

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" sub={session?.user.email ?? ''} />

      <Card>
        <CardTitle>Preferences</CardTitle>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Theme</Label>
            <Select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </div>
          <div>
            <Label>Your name (as it appears on bank transfers)</Label>
            <Input
              defaultValue={(profile.display_name as string | null) ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== ((profile.display_name as string | null) ?? '')) {
                  saveProfile.mutate({ display_name: v || null })
                }
              }}
              placeholder="e.g. Paul Wardle"
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              Payments to or from this name are treated as moving your own money between accounts —
              excluded from income and spending stats. Transfers to other people still count.
            </p>
          </div>
          <div>
            <Label>Household contributor (name on their transfers)</Label>
            <Input
              defaultValue={(profile.household_contributor as string | null) ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== ((profile.household_contributor as string | null) ?? '')) {
                  saveProfile.mutate({ household_contributor: v || null })
                }
              }}
              placeholder="e.g. surname on the transfer"
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              Someone who regularly puts money in. Large payments from them are proposed as
              "Household contribution" income (flagged for a one-tap check); small ones are treated
              as repayments — transfers, not income.
            </p>
          </div>
          <div>
            <Label>"Large" threshold for those payments</Label>
            <Input
              inputMode="numeric"
              defaultValue={((profile.household_contribution_threshold_minor as number | null) ?? 50000) / 100}
              onBlur={(e) => {
                const v = Math.round(Number(e.target.value) * 100)
                if (v > 0 && v !== (profile.household_contribution_threshold_minor as number)) {
                  saveProfile.mutate({ household_contribution_threshold_minor: v })
                }
              }}
              placeholder="500"
            />
            <p className="mt-1 text-[11px] text-ink-faint">In pounds. Payments at or above this count as income.</p>
          </div>
          <div>
            <Label>Usual payday (day of month)</Label>
            <Input
              inputMode="numeric"
              defaultValue={(profile.payday_day as number | null) ?? ''}
              onBlur={(e) => {
                const v = Number(e.target.value)
                if (v >= 1 && v <= 31) saveProfile.mutate({ payday_day: v })
              }}
              placeholder="e.g. 28"
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              The whole app runs payday to payday: budgets, forecasts and reviews cover this day to
              the day before the next one. When it falls on a weekend, pay is treated as arriving
              the Friday before.
            </p>
          </div>
          <div className="col-span-2">
            <Label>Process expected bills automatically</Label>
            <Select
              value={(profile.auto_post_bills as boolean | undefined) === false ? 'off' : 'on'}
              onChange={(e) => saveProfile.mutate({ auto_post_bills: e.target.value === 'on' })}
            >
              <option value="on">On — post each bill on its due date</option>
              <option value="off">Off — wait for statements</option>
            </Select>
            <p className="mt-1 text-[11px] text-ink-faint">
              When on, each bill is charged against your balance on its due date as an
              &ldquo;expected&rdquo; transaction — like an estimated meter reading. Statement uploads
              replace estimates with actuals and true the balances up automatically.
            </p>
          </div>
          <div className="col-span-2">
            <Label>Uploaded documents after extraction</Label>
            <Select
              value={profile.document_retention as string}
              onChange={(e) => saveProfile.mutate({ document_retention: e.target.value })}
            >
              <option value="keep">Keep the document</option>
              <option value="delete">Delete after successful extraction</option>
              <option value="ask">Ask each time</option>
            </Select>
            <p className="mt-1 text-[11px] text-ink-faint">
              Deleting a source file never deletes the imported transactions.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Categories</CardTitle>
        <p className="mb-2 text-xs text-ink-muted">
          Pick a category to rename it, remove it or manage its subcategories. Removing one frees
          its transactions: they're flagged as uncategorised so you can reallocate them, and all
          stats recalculate once you do.
        </p>
        {catMsg && <p className="mb-2 text-xs text-accent">{catMsg}</p>}
        <Select
          className="mb-2"
          value={expandedCat ?? ''}
          onChange={(e) => {
            setExpandedCat(e.target.value || null)
            setEditingCat(null)
            setCatMsg(null)
          }}
        >
          <option value="">Choose a category to manage…</option>
          {(categories ?? [])
            .filter((c) => !c.parent_id)
            .map((p) => {
              const subs = (categories ?? []).filter((c) => c.parent_id === p.id)
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {subs.length > 0 ? ` (${subs.map((s) => s.name).join(', ')})` : ''}
                </option>
              )
            })}
        </Select>
        {expandedCat &&
          (() => {
            const parent = (categories ?? []).find((c) => c.id === expandedCat)
            if (!parent) return null
            const subs = (categories ?? []).filter((c) => c.parent_id === parent.id)
            const editRow = (c: { id: string; name: string }, isSub: boolean) => (
              <div key={c.id} className="flex items-center justify-between gap-2 py-1">
                {editingCat?.id === c.id ? (
                  <span className="flex flex-1 items-center gap-1.5">
                    <Input
                      autoFocus
                      className="h-8 text-sm"
                      value={editingCat.name}
                      onChange={(e) => setEditingCat({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editingCat.name.trim()) renameCategory.mutate(editingCat)
                        if (e.key === 'Escape') setEditingCat(null)
                      }}
                    />
                    <Button size="sm" variant="secondary" onClick={() => editingCat.name.trim() && renameCategory.mutate(editingCat)}>
                      <Check className="h-3.5 w-3.5" /> Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingCat(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                ) : (
                  <>
                    <span className={isSub ? 'text-sm text-ink-muted' : 'text-sm font-medium'}>
                      {isSub ? `↳ ${c.name}` : c.name}
                    </span>
                    <span className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditingCat({ id: c.id, name: c.name })}>
                        <Pencil className="h-3.5 w-3.5" /> Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-bad"
                        onClick={() => {
                          if (!isSub) setExpandedCat(null)
                          removeCategory.mutate(c.id)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </Button>
                    </span>
                  </>
                )}
              </div>
            )
            return (
              <div className="mb-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2">
                {editRow(parent, false)}
                {subs.map((s) => editRow(s, true))}
              </div>
            )
          })()}
        <div className="flex gap-2">
          <Input
            placeholder="New category or subcategory name"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <Select className="w-44" value={newCatParent} onChange={(e) => setNewCatParent(e.target.value)}>
            <option value="">Top level</option>
            {(categories ?? [])
              .filter((c) => !c.parent_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  under {c.name}
                </option>
              ))}
          </Select>
          <Button variant="secondary" onClick={() => addCategory.mutate()} disabled={!newCategory.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Financial memory — tell the AI about your situation</CardTitle>
        <p className="mb-2 text-xs text-ink-muted">
          Brain-dump anything the AI should always know: income and payday, your debts, goals,
          what's discretionary, quirks of your accounts. It's included in every AI conversation,
          and you can edit or clear it any time. The AI also adds structured facts below as you
          chat and import.
        </p>
        <Textarea
          rows={6}
          placeholder={'e.g. I get paid on the 28th. Car finance with £11k left at £297/month. My gym membership is £30/month. Eating out is my main discretionary spend. Saving for a £10k emergency fund.'}
          value={notesValue}
          onChange={(e) => {
            setNotes(e.target.value)
            setNotesMsg(null)
            setNotesErr(false)
          }}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" onClick={() => saveNotes.mutate()} disabled={saveNotes.isPending || notes === null}>
            {saveNotes.isPending ? 'Saving…' : 'Save memory'}
          </Button>
          {notesMsg && (
            <span className={`text-xs ${notesErr ? 'text-bad' : 'text-good'}`}>{notesMsg}</span>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Remembered financial facts</CardTitle>
        {(facts ?? []).length === 0 ? (
          <p className="text-xs text-ink-faint">
            Facts the AI learns ("payday is the 28th", "rent is £950 on the 1st") appear here for review.
          </p>
        ) : (
          <div className="space-y-1.5">
            {(facts ?? [])
              .filter((f) => !(f.fact_type === 'context' && f.fact_key === 'user_notes'))
              .map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <Badge className="mr-1.5">{f.fact_type}</Badge>
                  <span className="text-ink-muted">
                    {f.fact_key}: {JSON.stringify(f.value)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-ink-faint">
                    {f.confidence} · {formatDate(f.effective_date)}
                  </span>
                </span>
                <button className="text-xs text-bad cursor-pointer" onClick={() => removeFact.mutate(f.id)}>
                  forget
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Security</CardTitle>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>New password</Label>
            <PasswordInput
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <Button variant="secondary" disabled={newPassword.length < 8} onClick={() => changePassword.mutate()}>
            Update password
          </Button>
        </div>
        {passwordMsg && <p className="mt-1 text-xs text-ink-muted">{passwordMsg}</p>}
      </Card>

      <Card>
        <CardTitle>Errors &amp; diagnostics</CardTitle>
        <p className="mb-2 text-xs text-ink-muted">
          Problems are logged as they happen — including failed imports and AI actions — so they can
          be exported and fixed later rather than disappearing with the message that showed them.
        </p>
        <div className="mb-2 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => doDiagnostics.mutate()} disabled={doDiagnostics.isPending}>
            <Download className="h-4 w-4" /> Export diagnostics
          </Button>
          {(errors ?? []).length > 0 && (
            <Button variant="ghost" onClick={() => wipeErrors.mutate()} disabled={wipeErrors.isPending}>
              Clear log
            </Button>
          )}
        </div>
        {(errors ?? []).length === 0 ? (
          <p className="text-xs text-ink-faint">No errors logged.</p>
        ) : (
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {(errors ?? []).map((e) => (
              <div key={e.id} className="border-b border-border pb-1 text-xs">
                <Badge tone="warn" className="mr-1.5">{e.context}</Badge>
                {e.message}
                <span className="ml-1.5 text-[11px] text-ink-faint">
                  {formatDateTime(e.occurred_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Data</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => doExport.mutate()} disabled={doExport.isPending}>
            <Download className="h-4 w-4" /> Export all data (JSON)
          </Button>
          <Button variant="outline" onClick={signOut}>
            Sign out
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          To delete your account and all data, export first, then delete the user in the Supabase
          dashboard (Authentication → Users) — every table cascades on user deletion.
        </p>
      </Card>

      <Card>
        <CardTitle>Recent activity (audit trail)</CardTitle>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {(audit ?? []).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 border-b border-border py-1.5 text-xs last:border-0">
              <span className="min-w-0 truncate text-ink-muted">
                <Badge className="mr-1.5">{a.source}</Badge>
                {a.action} {a.record_type.replace(/_/g, ' ')}
              </span>
              <span className="shrink-0 text-ink-faint">{formatDateTime(a.created_at)}</span>
            </div>
          ))}
          {(audit ?? []).length === 0 && <p className="text-xs text-ink-faint">No activity yet.</p>}
        </div>
      </Card>
    </div>
  )
}
