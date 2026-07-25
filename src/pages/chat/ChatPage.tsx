import { AccountSelect, PageHeader } from '@/components/shared/common'
import { Badge, Button, Card, Spinner, Textarea } from '@/components/ui/primitives'
import { useUserId } from '@/context/AuthContext'
import { fetchAccounts, fetchConversations, fetchMessages, logAppError, recordAudit, uploadDocument } from '@/lib/api'
import { isSupportedUpload, processUpload } from '@/lib/importFlow'
import { supabase } from '@/lib/supabase'
import type { ChatActionSummary, ChatMessage } from '@/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Paperclip, Send, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const SUGGESTIONS = [
  'What bills are due this week?',
  'What are my biggest spending themes this month?',
  'How does this month compare to last month?',
  'How much did I spend eating out last month?',
  'What subscriptions am I paying for?',
  'How much can I safely spend this weekend?',
  'Where could I cut back?',
]

export default function ChatPage() {
  const userId = useUserId()
  const qc = useQueryClient()
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attached, setAttached] = useState<File | null>(null)
  const [attachAccountId, setAttachAccountId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const { data: conversations } = useQuery({ queryKey: ['conversations'], queryFn: fetchConversations })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  useEffect(() => {
    if (conversations && conversations.length > 0 && !conversationId) {
      setConversationId(conversations[0].id)
    }
  }, [conversations, conversationId])

  const { data: messages } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => fetchMessages(conversationId!),
    enabled: !!conversationId,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pending])

  async function ensureConversation(title: string): Promise<string> {
    if (conversationId) return conversationId
    const { data, error: cErr } = await supabase
      .from('chat_conversations')
      .insert({ user_id: userId, title: title.slice(0, 60) })
      .select()
      .single()
    if (cErr) throw new Error(cErr.message)
    setConversationId(data.id as string)
    return data.id as string
  }

  function onFilePicked(file: File | null) {
    if (!file) return
    if (!isSupportedUpload(file)) {
      setError('That file type isn’t supported — use a photo, screenshot, PDF or CSV.')
      return
    }
    setError(null)
    setAttached(file)
    if (!attachAccountId && accounts && accounts.length > 0) setAttachAccountId(accounts[0].id)
  }

  const importAttachment = useMutation({
    mutationFn: async () => {
      if (!attached) return
      const file = attached
      const convId = await ensureConversation(`Import: ${file.name}`)
      await supabase.from('chat_messages').insert({
        user_id: userId,
        conversation_id: convId,
        role: 'user',
        content: `📎 Uploaded ${file.name}`,
      })
      const outcome = await processUpload(userId, file, attachAccountId)
      const reply =
        outcome.status === 'review'
          ? `I’ve read ${outcome.extracted} transaction${outcome.extracted === 1 ? '' : 's'} from ${file.name}. Nothing is saved yet — I’m taking you to the review screen to check and confirm them.`
          : outcome.status === 'processing'
            ? `I’m reading ${file.name} now — long statements can take a few minutes. Nothing is saved without your review; I’m taking you to the review screen, which fills in as soon as I’m done.`
            : `I couldn’t read ${file.name}: ${outcome.error ?? 'unknown error'}. Try a clearer photo or a CSV export from your bank.`
      await supabase.from('chat_messages').insert({
        user_id: userId,
        conversation_id: convId,
        role: 'assistant',
        content: reply,
      })
      return outcome
    },
    onSettled: () => {
      setAttached(null)
      qc.invalidateQueries({ queryKey: ['messages'] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['batches'] })
    },
    onSuccess: (outcome) => {
      if (outcome && (outcome.status === 'review' || outcome.status === 'processing')) navigate(`/imports/${outcome.batchId}`)
    },
    onError: (e: Error) => {
      setError(e.message)
      void logAppError(userId, 'ai_chat', e.message, { stack: e.stack })
    },
  })

  const send = useMutation({
    mutationFn: async (text: string) => {
      setPending(text)
      setError(null)
      const convId = await ensureConversation(text)
      // An attached photo goes to the assistant itself so it can read the
      // document and act on what it actually says — not through the
      // statement-import pipeline.
      let documentIds: string[] | undefined
      if (attached) {
        const doc = await uploadDocument(userId, attached, 'other')
        documentIds = [doc.id]
        setAttached(null)
      }
      const { data: session } = await supabase.auth.getSession()
      const { data, error: fnErr } = await supabase.functions.invoke('ai-chat', {
        body: { conversation_id: convId, message: text, document_ids: documentIds },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      })
      if (fnErr) {
        // Persist the user's message anyway so nothing is lost
        await supabase.from('chat_messages').insert({
          user_id: userId, conversation_id: convId, role: 'user', content: text,
        })
        await supabase.from('chat_messages').insert({
          user_id: userId,
          conversation_id: convId,
          role: 'assistant',
          content:
            'The AI assistant is not available yet. Deploy the ai-chat edge function and set the ANTHROPIC_API_KEY secret (see README). Everything else in the app works without it.',
        })
        return
      }
      return data
    },
    onSettled: () => {
      setPending(null)
      qc.invalidateQueries({ queryKey: ['messages'] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      // AI actions may have changed financial data
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['liabilities'] })
      qc.invalidateQueries({ queryKey: ['recurring'] })
      qc.invalidateQueries({ queryKey: ['facts'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      void logAppError(userId, 'ai_chat', e.message, { stack: e.stack })
    },
  })

  const undo = useMutation({
    mutationFn: async (actionId: string) => {
      const { data: action, error: aErr } = await supabase
        .from('ai_actions')
        .select('*')
        .eq('id', actionId)
        .single()
      if (aErr) throw new Error(aErr.message)
      const undoData = action.undo_data as { table?: string; id?: string; previous?: Record<string, unknown> } | null
      if (!undoData?.table) throw new Error('This action cannot be undone automatically')
      if (undoData.previous) {
        await supabase.from(undoData.table).update(undoData.previous).eq('id', undoData.id!)
      } else if (undoData.id) {
        await supabase.from(undoData.table).delete().eq('id', undoData.id)
      }
      await supabase.from('ai_actions').update({ status: 'undone', undone_at: new Date().toISOString() }).eq('id', actionId)
      await recordAudit({
        userId, recordType: undoData.table, recordId: undoData.id, action: 'undo', source: 'undo',
      })
    },
    onSuccess: () => {
      qc.invalidateQueries()
    },
    onError: (e: Error) => {
      setError(e.message)
      void logAppError(userId, 'ai_chat', e.message, { stack: e.stack })
    },
  })

  const submit = () => {
    const text = input.trim()
    if (!text || send.isPending) return
    setInput('')
    send.mutate(text)
  }

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] flex-col lg:h-[calc(100dvh-4rem)]">
      <PageHeader
        title="AI Chat"
        sub="Ask about your money or give instructions — structured changes are validated, audited and undoable"
      />
      <div className="flex-1 space-y-3 overflow-y-auto pb-3">
        {(messages ?? []).length === 0 && !pending && (
          <Card>
            <p className="mb-2 text-sm text-ink-muted">Try one of these:</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent cursor-pointer"
                  onClick={() => send.mutate(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </Card>
        )}
        {(messages ?? []).map((m) => (
          <MessageBubble key={m.id} message={m} onUndo={(id) => undo.mutate(id)} />
        ))}
        {pending && (
          <>
            <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-accent-ink">
              {pending}
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-faint">
              <Spinner /> Thinking…
            </div>
          </>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div ref={bottomRef} />
      </div>
      {attached && (
        <div className="mb-2 rounded-xl border border-border bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Paperclip className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{attached.name}</span>
            <Button size="sm" variant="ghost" onClick={() => setAttached(null)}>
              Remove
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Say what this is and I'll read it — e.g. “these are my regular direct debits”. Nothing
            is added to your transactions unless you import it as a statement.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink-muted">It's a bank statement?</span>
            <div className="w-40">
              <AccountSelect
                accounts={accounts ?? []}
                value={attachAccountId}
                onChange={setAttachAccountId}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => importAttachment.mutate()}
              disabled={importAttachment.isPending || !attachAccountId}
            >
              {importAttachment.isPending ? 'Reading…' : 'Import transactions'}
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-end gap-2 border-t border-border pt-3">
        <input
          ref={fileRef}
          type="file"
          accept=".png,.jpg,.jpeg,.pdf,.csv,image/png,image/jpeg,application/pdf,text/csv"
          className="hidden"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a photo or file"
          disabled={(accounts ?? []).length === 0}
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => cameraRef.current?.click()}
          aria-label="Take a photo"
          disabled={(accounts ?? []).length === 0}
        >
          <Camera className="h-4 w-4" />
        </Button>
        <Textarea
          rows={1}
          placeholder="Ask anything about your money…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="max-h-32 min-h-10 resize-none"
        />
        <Button size="icon" onClick={submit} disabled={send.isPending || !input.trim()} aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onUndo,
}: {
  message: ChatMessage
  onUndo: (actionId: string) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-accent-ink">
        {message.content}
      </div>
    )
  }
  const actions = (message.actions ?? []) as ChatActionSummary[]
  return (
    <div className="max-w-[92%] space-y-2">
      <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-surface px-3.5 py-2 text-sm border border-border">
        {message.content}
      </div>
      {actions.length > 0 && (
        <div className="space-y-1">
          {actions.map((a, i) => (
            <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-1.5">
              <span className="text-xs">
                <Badge tone="accent" className="mr-1.5">{a.action_type.replace(/_/g, ' ')}</Badge>
                {a.summary}
              </span>
              {a.undoable && a.ai_action_id && (
                <Button size="sm" variant="ghost" onClick={() => onUndo(a.ai_action_id!)}>
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
