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
  Textarea,
} from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import { fetchProjectSpend, fetchProjects, upsertProject } from '@/lib/api'
import { formatDate, money } from '@/lib/format'
import type { Project } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

const STATUS_TONE = { active: 'accent', complete: 'good', paused: undefined, abandoned: undefined } as const

export default function ProjectsPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const { data: spend } = useQuery({ queryKey: ['projects', 'spend'], queryFn: fetchProjectSpend })
  const [editing, setEditing] = useState<Project | null>(null)
  const [adding, setAdding] = useState(false)

  if (!projects) return <Spinner />

  const active = projects.filter((p) => p.status === 'active' || p.status === 'paused')
  const done = projects.filter((p) => p.status === 'complete')
  const totalActive = active.reduce((s, p) => s + (spend?.get(p.id)?.spentMinor ?? 0), 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Projects"
        sub={
          active.length > 0
            ? `${active.length} active · ${money(totalActive)} spent so far`
            : 'Group one-off spending under a named pot with its own budget'
        }
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        }
      />

      {projects.length === 0 && (
        <>
          <EmptyState
            title="No projects yet"
            hint="A project is a named pot of one-off spending — a bike build, a holiday, work on the house — with an optional budget. Assign transactions to it from the transaction editor and the total builds itself."
          />
          <Card>
            <p className="text-xs text-ink-muted">
              Project spending is automatically marked one-off, so it never inflates your
              &ldquo;typical month&rdquo; baseline — the forecast and monthly review keep treating it
              as separate from everyday running costs.
            </p>
          </Card>
        </>
      )}

      {[...active, ...done].map((p) => {
        const s = spend?.get(p.id)
        const spent = s?.spentMinor ?? 0
        const pct = p.budget_minor ? (spent / p.budget_minor) * 100 : null
        return (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{p.name}</h3>
                  <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                </div>
                {p.notes && <p className="mt-0.5 text-xs text-ink-muted">{p.notes}</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                Edit
              </Button>
            </div>

            <div className="mt-2 flex items-baseline justify-between">
              <p className="tnum text-lg font-semibold">
                {money(spent)}
                {p.budget_minor && (
                  <span className="ml-1 text-xs font-normal text-ink-muted">
                    of {money(p.budget_minor)} budget
                  </span>
                )}
              </p>
              {pct !== null && (
                <span className={`text-xs font-medium ${pct > 100 ? 'text-bad' : 'text-ink-muted'}`}>
                  {Math.round(pct)}%
                </span>
              )}
            </div>
            {pct !== null && (
              <ProgressBar
                className="mt-1.5"
                value={Math.min(pct, 100)}
                tone={pct > 100 ? 'bad' : pct > 85 ? 'warn' : 'accent'}
              />
            )}
            {pct !== null && pct > 100 && (
              <p className="mt-1 text-[11px] text-bad">
                {money(spent - p.budget_minor!)} over budget
              </p>
            )}

            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
              <span>
                {s?.count ?? 0} transaction{(s?.count ?? 0) === 1 ? '' : 's'}
                {s?.lastDate ? ` · last ${formatDate(s.lastDate)}` : ''}
                {p.target_date ? ` · target ${formatDate(p.target_date)}` : ''}
              </span>
              <Link className="font-medium text-accent hover:underline" to={`/transactions?project=${p.id}`}>
                View transactions →
              </Link>
            </div>
          </Card>
        )
      })}

      {(adding || editing) && (
        <ProjectDialog
          project={editing}
          userId={userId}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => qc.invalidateQueries({ queryKey: ['projects'] })}
        />
      )}
    </div>
  )
}

function ProjectDialog({
  project,
  userId,
  onClose,
  onSaved,
}: {
  project: Project | null
  userId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: project?.name ?? '',
    status: project?.status ?? ('active' as Project['status']),
    budget_minor: project?.budget_minor ?? null,
    started_on: project?.started_on ?? '',
    target_date: project?.target_date ?? '',
    notes: project?.notes ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      upsertProject(
        userId,
        {
          name: form.name.trim(),
          status: form.status,
          budget_minor: form.budget_minor,
          started_on: form.started_on || null,
          target_date: form.target_date || null,
          notes: form.notes.trim() || null,
        },
        project?.id,
      ),
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  // "Abandon" keeps the history but drops the project from every list.
  const abandon = useMutation({
    mutationFn: () => upsertProject(userId, { name: project!.name, status: 'abandoned' }, project!.id),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  return (
    <Dialog open onClose={onClose} title={project ? 'Edit project' : 'New project'}>
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
            placeholder="e.g. Bike build, Bathroom, Holiday 2027"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Budget (optional)</Label>
            <MoneyInput
              valueMinor={form.budget_minor}
              onChangeMinor={(m) => setForm({ ...form, budget_minor: m })}
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Project['status'] })}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="complete">Complete</option>
            </Select>
          </div>
          <div>
            <Label>Started</Label>
            <Input
              type="date"
              value={form.started_on}
              onChange={(e) => setForm({ ...form, started_on: e.target.value })}
            />
          </div>
          <div>
            <Label>Target date (optional)</Label>
            <Input
              type="date"
              value={form.target_date}
              onChange={(e) => setForm({ ...form, target_date: e.target.value })}
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-between">
          {project ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={() => abandon.mutate()}>
              Abandon
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={save.isPending || !form.name.trim()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
