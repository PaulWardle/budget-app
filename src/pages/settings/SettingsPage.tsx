import { PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, CardTitle, Input, Label, PasswordInput, Select, Spinner, Textarea } from '@/components/ui/primitives'
import { useAuth, useUserId } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import {
  deleteFact,
  exportAllData,
  fetchAuditEvents,
  fetchCategories,
  fetchFacts,
  fetchProfile,
  updateProfile,
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
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [newCatParent, setNewCatParent] = useState<string>('')
  const [notes, setNotes] = useState<string | null>(null)
  const [notesMsg, setNotesMsg] = useState<string | null>(null)

  const existingNotes = (facts ?? []).find(
    (f) => f.fact_type === 'context' && f.fact_key === 'user_notes',
  )
  const notesValue = notes ?? ((existingNotes?.value as { text?: string } | undefined)?.text ?? '')

  const saveNotes = useMutation({
    mutationFn: async () => {
      const value = { text: (notes ?? '').slice(0, 6000) }
      if (existingNotes) {
        const { error } = await supabase
          .from('financial_facts')
          .update({ value, last_confirmed_at: new Date().toISOString() })
          .eq('id', existingNotes.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('financial_facts').insert({
          user_id: userId,
          fact_type: 'context',
          fact_key: 'user_notes',
          value,
          source: 'manual',
          confidence: 'confirmed',
        })
        if (error) throw new Error(error.message)
      }
    },
    onSuccess: () => {
      setNotesMsg('Saved — the AI will use this in every conversation.')
      qc.invalidateQueries({ queryKey: ['facts'] })
    },
    onError: (e: Error) => setNotesMsg(e.message),
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

  // Unused categories are deleted outright. A category with transactions is
  // archived instead — it disappears from pickers but history keeps its label.
  const removeCategory = useMutation({
    mutationFn: async (id: string) => {
      const ids = [id, ...(categories ?? []).filter((c) => c.parent_id === id).map((c) => c.id)]
      const { count } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .in('category_id', ids)
      if ((count ?? 0) > 0) {
        const { error } = await supabase.from('categories').update({ is_archived: true }).in('id', ids)
        if (error) throw new Error(error.message)
        return `Archived — ${count} transaction${count === 1 ? '' : 's'} keep the label but it's hidden from pickers`
      }
      const { error } = await supabase.from('categories').delete().in('id', ids)
      if (error) throw new Error(error.message)
      return 'Deleted'
    },
    onSuccess: (msg) => {
      setCatMsg(msg)
      qc.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: (e: Error) => setCatMsg(e.message),
  })

  const removeFact = useMutation({
    mutationFn: deleteFact,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['facts'] }),
  })

  const doExport = useMutation({
    mutationFn: exportAllData,
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `my-money-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    },
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
          Rename with the pencil, remove with the bin. Removing a category that's in use archives
          it (past transactions keep their label); an unused one is deleted outright.
        </p>
        {catMsg && <p className="mb-2 text-xs text-accent">{catMsg}</p>}
        <div className="mb-3 divide-y divide-border">
          {(categories ?? [])
            .filter((c) => !c.parent_id)
            .map((parent) => {
              const subs = (categories ?? []).filter((c) => c.parent_id === parent.id)
              const row = (c: { id: string; name: string }, isSub: boolean) =>
                editingCat?.id === c.id ? (
                  <span key={c.id} className="flex items-center gap-1">
                    <Input
                      autoFocus
                      className="h-7 w-40 text-xs"
                      value={editingCat.name}
                      onChange={(e) => setEditingCat({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editingCat.name.trim()) renameCategory.mutate(editingCat)
                        if (e.key === 'Escape') setEditingCat(null)
                      }}
                    />
                    <button
                      className="text-good"
                      onClick={() => editingCat.name.trim() && renameCategory.mutate(editingCat)}
                      aria-label="Save name"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button className="text-ink-faint" onClick={() => setEditingCat(null)} aria-label="Cancel">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : (
                  <span
                    key={c.id}
                    className={`group inline-flex items-center gap-1 ${isSub ? 'rounded-full border border-border px-2 py-0.5 text-[11px] text-ink-muted' : 'text-sm font-medium'}`}
                  >
                    {c.name}
                    <button
                      className="text-ink-faint hover:text-accent"
                      onClick={() => setEditingCat({ id: c.id, name: c.name })}
                      aria-label={`Rename ${c.name}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      className="text-ink-faint hover:text-bad"
                      onClick={() => removeCategory.mutate(c.id)}
                      aria-label={`Remove ${c.name}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                )
              return (
                <div key={parent.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  {row(parent, false)}
                  {subs.map((s) => row(s, true))}
                </div>
              )
            })}
        </div>
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
          }}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" onClick={() => saveNotes.mutate()} disabled={saveNotes.isPending || notes === null}>
            {saveNotes.isPending ? 'Saving…' : 'Save memory'}
          </Button>
          {notesMsg && <span className="text-xs text-good">{notesMsg}</span>}
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
