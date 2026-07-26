// Typed data access. All mutations that matter financially also write an
// audit_events row; account balance history is captured by a DB trigger.
import { supabase } from '@/lib/supabase'
import { todayIso } from '@/lib/format'
import { computeNetWorth, type NetWorthItem } from '@/lib/engine/networth'
import { ruleMatches, type MatchType } from '@/lib/engine/rules'
import { detectRecurring, normaliseDescription } from '@/lib/engine/recurring'
import {
  LIABILITY_ACCOUNT_TYPES,
  LIQUID_ACCOUNT_TYPES,
  type Account,
  type AuditEvent,
  type BalanceSnapshot,
  type Budget,
  type BudgetLine,
  type Category,
  type CategorisationRule,
  type ChatConversation,
  type ChatMessage,
  type DebtPayment,
  type DocumentRow,
  type FinancialFact,
  type ImportBatch,
  type ImportedItem,
  type Insight,
  type Liability,
  type LoanScheduleRow,
  type Merchant,
  type MerchantAlias,
  type NetWorthSnapshot,
  type RecurringPayment,
  type SavingsGoal,
  type Transaction,
} from '@/types/domain'

function throwIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

/**
 * Reject if a request has not settled in time. A stalled connection — or a
 * Supabase auth lock held by another tab — otherwise leaves a button spinning
 * on "Saving…" forever with nothing to act on. Failing loudly is better than
 * waiting silently.
 */
export async function withTimeout<T>(work: Promise<T>, ms = 15_000, what = 'request'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The ${what} timed out after ${Math.round(ms / 1000)}s. Check your connection and try again.`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function recordAudit(input: {
  userId: string
  recordType: string
  recordId?: string | null
  action: AuditEvent['action']
  previous?: unknown
  next?: unknown
  source?: string
  undoable?: boolean
  importBatchId?: string | null
}): Promise<void> {
  const { error } = await supabase.from('audit_events').insert({
    user_id: input.userId,
    record_type: input.recordType,
    record_id: input.recordId ?? null,
    action: input.action,
    previous_value: input.previous ?? null,
    new_value: input.next ?? null,
    source: input.source ?? 'manual',
    import_batch_id: input.importBatchId ?? null,
    undo_status: input.undoable ? 'undoable' : 'not_undoable',
  })
  if (error) console.error('audit write failed') // never block the user action
}

// ------------------------------------------------------------------ accounts
export async function fetchAccounts(): Promise<Account[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .is('archived_at', null)
    .order('sort')
    .order('created_at')
  throwIf(error)
  return (data ?? []) as Account[]
}

export function accountClass(a: Account): 'asset' | 'liability' {
  return LIABILITY_ACCOUNT_TYPES.includes(a.account_type) ? 'liability' : 'asset'
}

export function toNetWorthItem(a: Account): NetWorthItem {
  return {
    id: a.id,
    name: a.name,
    class: accountClass(a),
    balanceMinor:
      accountClass(a) === 'liability' ? Math.abs(a.balance_minor) : a.balance_minor,
    isLiquid: a.is_liquid && LIQUID_ACCOUNT_TYPES.includes(a.account_type),
    includeInNetWorth: a.include_in_net_worth,
  }
}

export async function createAccount(
  userId: string,
  input: Partial<Account> & { name: string; account_type: Account['account_type'] },
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({ ...input, user_id: userId })
    .select()
    .single()
  throwIf(error)
  await recordAudit({ userId, recordType: 'account', recordId: data!.id, action: 'insert', next: input })
  await writeNetWorthSnapshot(userId)
  return data as Account
}

export async function updateAccount(
  userId: string,
  id: string,
  patch: Partial<Account>,
  source: 'manual' | 'import' | 'ai_chat' | 'calculated' = 'manual',
): Promise<Account> {
  const { data: prev } = await supabase.from('accounts').select('*').eq('id', id).single()
  const { data, error } = await supabase
    .from('accounts')
    .update({ ...patch, ...(patch.balance_minor !== undefined ? { balance_source: source } : {}) })
    .eq('id', id)
    .select()
    .single()
  throwIf(error)
  await recordAudit({
    userId,
    recordType: 'account',
    recordId: id,
    action: 'update',
    previous: prev,
    next: patch,
    source,
    undoable: patch.balance_minor !== undefined,
  })
  if (patch.balance_minor !== undefined || patch.include_in_net_worth !== undefined) {
    await writeNetWorthSnapshot(userId)
  }
  return data as Account
}

export async function fetchBalanceHistory(accountId: string): Promise<BalanceSnapshot[]> {
  const { data, error } = await supabase
    .from('account_balance_snapshots')
    .select('*')
    .eq('account_id', accountId)
    .order('recorded_at', { ascending: false })
    .limit(200)
  throwIf(error)
  return (data ?? []) as BalanceSnapshot[]
}

// ------------------------------------------------------------ net worth
export async function writeNetWorthSnapshot(userId: string): Promise<void> {
  const [accounts, liabilities] = await Promise.all([fetchAccounts(), fetchLiabilities()])
  const items = buildNetWorthItems(accounts, liabilities)
  const r = computeNetWorth(items)
  await supabase.from('net_worth_snapshots').upsert(
    {
      user_id: userId,
      date: todayIso(),
      assets_minor: r.assetsMinor,
      liabilities_minor: r.liabilitiesMinor,
      net_worth_minor: r.netWorthMinor,
      liquid_assets_minor: r.liquidAssetsMinor,
      liquid_liabilities_minor: r.liquidLiabilitiesMinor,
      breakdown: Object.fromEntries(items.map((i) => [i.name, i.balanceMinor * (i.class === 'liability' ? -1 : 1)])),
    },
    { onConflict: 'user_id,date' },
  )
}

/** Liabilities tracked in `liabilities` win over their linked account rows to
 * avoid double counting; unlinked liability-type accounts still count. */
export function buildNetWorthItems(accounts: Account[], liabilities: Liability[]): NetWorthItem[] {
  const linkedAccountIds = new Set(liabilities.filter((l) => l.account_id).map((l) => l.account_id))
  const items: NetWorthItem[] = accounts
    .filter((a) => !linkedAccountIds.has(a.id))
    .map(toNetWorthItem)
  for (const l of liabilities) {
    if (l.status !== 'active') continue
    items.push({
      id: `liability:${l.id}`,
      name: l.name,
      class: 'liability',
      balanceMinor: Math.abs(l.current_balance_minor),
      isLiquid: l.liability_type === 'credit_card' || l.liability_type === 'paypal_credit',
      includeInNetWorth: true,
    })
  }
  return items
}

export async function fetchNetWorthHistory(): Promise<NetWorthSnapshot[]> {
  const { data, error } = await supabase
    .from('net_worth_snapshots')
    .select('*')
    .order('date')
  throwIf(error)
  return (data ?? []) as NetWorthSnapshot[]
}

// ---------------------------------------------------------------- categories
export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('is_archived', false)
    .order('sort')
  throwIf(error)
  return (data ?? []) as Category[]
}

export async function fetchMerchants(): Promise<Merchant[]> {
  const { data, error } = await supabase.from('merchants').select('*').order('name')
  throwIf(error)
  return (data ?? []) as Merchant[]
}

export async function fetchAliases(): Promise<MerchantAlias[]> {
  const { data, error } = await supabase.from('merchant_aliases').select('*')
  throwIf(error)
  return (data ?? []) as MerchantAlias[]
}

export async function fetchRules(): Promise<CategorisationRule[]> {
  const { data, error } = await supabase
    .from('categorisation_rules')
    .select('*')
    .eq('is_active', true)
    .order('priority')
  throwIf(error)
  return (data ?? []) as CategorisationRule[]
}

/** Apply learned rules to a raw bank description. Longer matchers win, so a
 * specific rule beats a generic one regardless of insertion order. */
export function applyRules(
  description: string,
  rules: CategorisationRule[],
): { merchantId: string | null; categoryId: string | null } | null {
  const ordered = [...rules].sort((a, b) => b.matcher.length - a.matcher.length)
  for (const r of ordered) {
    if (ruleMatches(description, r.matcher, r.match_type as MatchType)) {
      return { merchantId: r.merchant_id, categoryId: r.category_id }
    }
  }
  return null
}

/** Create/find a merchant, alias, rule and optional recurring flag in one go —
 * the "this payment is my monthly gym membership" learning primitive. Returns undo information. */
export async function learnMerchant(
  userId: string,
  input: {
    merchantName: string
    aliasPatterns: string[]
    categoryId: string | null
    source?: 'manual' | 'ai_chat' | 'import_confirmation'
    applyToPast?: boolean
  },
): Promise<{ merchant: Merchant; ruleIds: string[]; updatedPastCount: number }> {
  const source = input.source ?? 'manual'
  const { data: existing } = await supabase
    .from('merchants')
    .select('*')
    .ilike('name', input.merchantName)
    .maybeSingle()
  let merchant = existing as Merchant | null
  if (!merchant) {
    const { data, error } = await supabase
      .from('merchants')
      .insert({ user_id: userId, name: input.merchantName, default_category_id: input.categoryId })
      .select()
      .single()
    throwIf(error)
    merchant = data as Merchant
  } else if (input.categoryId) {
    await supabase.from('merchants').update({ default_category_id: input.categoryId }).eq('id', merchant.id)
  }

  const ruleIds: string[] = []
  for (const pattern of input.aliasPatterns) {
    await supabase
      .from('merchant_aliases')
      .upsert({ user_id: userId, merchant_id: merchant.id, alias: pattern.toUpperCase() }, { onConflict: 'user_id,alias' })
    // Re-teaching the same merchant must not stack duplicate rules.
    const { data: existingRule } = await supabase
      .from('categorisation_rules')
      .select('id')
      .eq('matcher', pattern.toUpperCase())
      .eq('match_type', 'contains')
      .maybeSingle()
    if (existingRule) {
      await supabase
        .from('categorisation_rules')
        .update({ merchant_id: merchant.id, category_id: input.categoryId, is_active: true })
        .eq('id', (existingRule as { id: string }).id)
      ruleIds.push((existingRule as { id: string }).id)
      continue
    }
    const { data: rule, error } = await supabase
      .from('categorisation_rules')
      .insert({
        user_id: userId,
        matcher: pattern.toUpperCase(),
        match_type: 'contains',
        merchant_id: merchant.id,
        category_id: input.categoryId,
        source,
      })
      .select()
      .single()
    throwIf(error)
    ruleIds.push((rule as CategorisationRule).id)
  }

  let updatedPastCount = 0
  if (input.applyToPast) {
    // Fetch candidates, then filter with the word-boundary matcher so a short
    // pattern can't recategorise unrelated transactions.
    for (const pattern of input.aliasPatterns) {
      const { data: candidates } = await supabase
        .from('transactions')
        .select('id,description,merchant_name')
        .or(`description.ilike.%${pattern}%,merchant_name.ilike.%${pattern}%`)
        .is('category_id', null)
      const ids = ((candidates ?? []) as { id: string; description: string; merchant_name: string | null }[])
        .filter((t) => ruleMatches(`${t.merchant_name ?? ''} ${t.description}`, pattern))
        .map((t) => t.id)
      if (ids.length === 0) continue
      const { data: updated } = await supabase
        .from('transactions')
        .update({ merchant_id: merchant.id, merchant_name: merchant.name, category_id: input.categoryId })
        .in('id', ids)
        .select('id')
      updatedPastCount += updated?.length ?? 0
    }
  }

  await recordAudit({
    userId,
    recordType: 'categorisation_rule',
    recordId: ruleIds[0] ?? merchant.id,
    action: 'insert',
    next: input,
    source: source === 'manual' ? 'manual' : 'ai_chat',
    undoable: true,
  })
  return { merchant, ruleIds, updatedPastCount }
}

// -------------------------------------------------------------- transactions
export interface TxnFilters {
  accountId?: string
  categoryId?: string
  merchantId?: string
  merchantName?: string
  search?: string
  from?: string
  to?: string
  minAmountMinor?: number
  maxAmountMinor?: number
  uncategorised?: boolean
  needsReview?: boolean
  importBatchId?: string
  recurringOnly?: boolean
  limit?: number
}

export async function fetchTransactions(filters: TxnFilters = {}): Promise<Transaction[]> {
  let q = supabase
    .from('transactions')
    .select('*, transaction_splits(*)')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 500)
  if (filters.accountId) q = q.eq('account_id', filters.accountId)
  if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
  if (filters.merchantId) q = q.eq('merchant_id', filters.merchantId)
  if (filters.merchantName) {
    const safe = filters.merchantName.replace(/[,()]/g, ' ').trim()
    q = q.or(`merchant_name.ilike.%${safe}%,description.ilike.%${safe}%`)
  }
  if (filters.from) q = q.gte('date', filters.from)
  if (filters.to) q = q.lte('date', filters.to)
  if (filters.uncategorised) q = q.is('category_id', null).eq('is_transfer', false)
  if (filters.needsReview) q = q.eq('needs_review', true)
  if (filters.importBatchId) q = q.eq('import_batch_id', filters.importBatchId)
  if (filters.recurringOnly) q = q.not('recurring_payment_id', 'is', null)
  if (filters.search) q = q.or(`description.ilike.%${filters.search}%,merchant_name.ilike.%${filters.search}%,notes.ilike.%${filters.search}%`)
  const { data, error } = await q
  throwIf(error)
  let rows = (data ?? []) as Transaction[]
  if (filters.minAmountMinor !== undefined) {
    rows = rows.filter((t) => Math.abs(t.amount_minor) >= filters.minAmountMinor!)
  }
  if (filters.maxAmountMinor !== undefined) {
    rows = rows.filter((t) => Math.abs(t.amount_minor) <= filters.maxAmountMinor!)
  }
  return rows
}

export async function createTransaction(
  userId: string,
  input: Partial<Transaction> & { account_id: string; date: string; description: string; amount_minor: number },
  source: 'manual' | 'import' | 'ai_chat' = 'manual',
): Promise<Transaction> {
  const { data, error } = await supabase
    .from('transactions')
    .insert({ ...input, user_id: userId, source })
    .select()
    .single()
  throwIf(error)
  await recordAudit({
    userId, recordType: 'transaction', recordId: data!.id, action: 'insert', next: input, source, undoable: true,
  })
  return data as Transaction
}

export async function updateTransaction(
  userId: string,
  id: string,
  patch: Partial<Transaction>,
  source: 'manual' | 'import' | 'ai_chat' = 'manual',
): Promise<void> {
  const { data: prev } = await supabase.from('transactions').select('*').eq('id', id).single()
  const { error } = await supabase.from('transactions').update(patch).eq('id', id)
  throwIf(error)
  await recordAudit({
    userId, recordType: 'transaction', recordId: id, action: 'update', previous: prev, next: patch, source, undoable: true,
  })
}

export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const { data: prev } = await supabase.from('transactions').select('*').eq('id', id).single()
  const { error } = await supabase.from('transactions').delete().eq('id', id)
  throwIf(error)
  await recordAudit({ userId, recordType: 'transaction', recordId: id, action: 'delete', previous: prev })
}

/** Replace the splits of a transaction. Parts must sum to the transaction amount. */
export async function setTransactionSplits(
  userId: string,
  transactionId: string,
  parts: { category_id: string | null; amount_minor: number; note?: string }[],
): Promise<void> {
  const { data: txn } = await supabase.from('transactions').select('*').eq('id', transactionId).single()
  if (!txn) throw new Error('Transaction not found')
  if (parts.length > 0) {
    const sum = parts.reduce((a, p) => a + p.amount_minor, 0)
    if (sum !== (txn as Transaction).amount_minor) {
      throw new Error('Split amounts must add up to the transaction amount')
    }
  }
  await supabase.from('transaction_splits').delete().eq('transaction_id', transactionId)
  if (parts.length > 0) {
    const { error } = await supabase.from('transaction_splits').insert(
      parts.map((p) => ({ ...p, user_id: userId, transaction_id: transactionId })),
    )
    throwIf(error)
  }
  await recordAudit({
    userId, recordType: 'transaction_split', recordId: transactionId, action: 'update', next: parts, undoable: true,
  })
}

// ------------------------------------------------------------------- budgets
export async function fetchBudget(month: string): Promise<(Budget & { budget_lines: BudgetLine[] }) | null> {
  const { data, error } = await supabase
    .from('budgets')
    .select('*, budget_lines(*)')
    .eq('month', month)
    .maybeSingle()
  throwIf(error)
  return data as (Budget & { budget_lines: BudgetLine[] }) | null
}

export async function createBudget(
  userId: string,
  month: string,
  input: { expected_income_minor?: number; notes?: string },
): Promise<Budget> {
  const { data, error } = await supabase
    .from('budgets')
    .insert({ user_id: userId, month, ...input })
    .select()
    .single()
  throwIf(error)
  return data as Budget
}

export async function upsertBudgetLine(
  userId: string,
  budgetId: string,
  line: { category_id: string | null; kind: BudgetLine['kind']; planned_minor: number; label?: string | null },
): Promise<void> {
  const { error } = await supabase.from('budget_lines').upsert(
    { user_id: userId, budget_id: budgetId, label: line.label ?? null, ...line },
    { onConflict: 'budget_id,category_id,kind,label' },
  )
  throwIf(error)
}

export async function deleteBudgetLine(id: string): Promise<void> {
  const { error } = await supabase.from('budget_lines').delete().eq('id', id)
  throwIf(error)
}

export async function copyBudgetFrom(
  userId: string,
  fromMonth: string,
  toMonth: string,
): Promise<Budget | null> {
  const prev = await fetchBudget(fromMonth)
  if (!prev) return null
  const budget = await createBudget(userId, toMonth, {
    expected_income_minor: prev.expected_income_minor,
    notes: prev.notes ?? undefined,
  })
  if (prev.budget_lines.length > 0) {
    const { error } = await supabase.from('budget_lines').insert(
      prev.budget_lines
        .filter((l) => l.kind !== 'one_off') // one-offs don't repeat by default
        .map((l) => ({
          user_id: userId,
          budget_id: budget.id,
          category_id: l.category_id,
          kind: l.kind,
          label: l.label,
          planned_minor: l.planned_minor,
        })),
    )
    throwIf(error)
  }
  await recordAudit({ userId, recordType: 'budget', recordId: budget.id, action: 'insert', next: { copied_from: fromMonth } })
  return budget
}

// ---------------------------------------------------------------- recurring
export async function fetchRecurring(): Promise<RecurringPayment[]> {
  const { data, error } = await supabase
    .from('recurring_payments')
    .select('*')
    .order('next_due_date')
  throwIf(error)
  return (data ?? []) as RecurringPayment[]
}

/** Mark a transaction as unusual so it stops shaping the spending forecast. */
export async function setTransactionOneOff(id: string, isOneOff: boolean): Promise<void> {
  const { error } = await supabase.from('transactions').update({ is_one_off: isOneOff }).eq('id', id)
  throwIf(error)
}

export interface DismissedRecurring {
  id: string
  match_key: string
  label: string
  created_at: string
}

/** Candidates the user has said are not bills. Detection re-runs over the whole
 * ledger each time, so a rejection has to be remembered or it comes straight
 * back. */
export async function fetchDismissedRecurring(): Promise<DismissedRecurring[]> {
  const { data, error } = await supabase
    .from('dismissed_recurring')
    .select('*')
    .order('created_at', { ascending: false })
  throwIf(error)
  return (data ?? []) as DismissedRecurring[]
}

export async function dismissRecurring(userId: string, matchKey: string, label: string): Promise<void> {
  const { error } = await supabase
    .from('dismissed_recurring')
    .upsert({ user_id: userId, match_key: matchKey, label }, { onConflict: 'user_id,match_key' })
  throwIf(error)
}

export async function restoreRecurring(id: string): Promise<void> {
  const { error } = await supabase.from('dismissed_recurring').delete().eq('id', id)
  throwIf(error)
}

export async function upsertRecurring(
  userId: string,
  input: Partial<RecurringPayment> & { name: string; amount_minor: number; frequency: RecurringPayment['frequency']; next_due_date: string },
  id?: string,
): Promise<RecurringPayment> {
  if (id) {
    const { data, error } = await supabase
      .from('recurring_payments').update(input).eq('id', id).select().single()
    throwIf(error)
    return data as RecurringPayment
  }
  const { data, error } = await supabase
    .from('recurring_payments')
    .insert({ ...input, user_id: userId })
    .select()
    .single()
  throwIf(error)
  await recordAudit({ userId, recordType: 'recurring_payment', recordId: data!.id, action: 'insert', next: input, undoable: true })
  return data as RecurringPayment
}

/** Detect recurring bills from the saved ledger and record them, linking the
 * transactions that belong to each one. Detected entries are flagged
 * `needs_confirmation` so the user can confirm or dismiss them in Bills — but
 * they populate Home, Cashflow and the bills list straight after an import
 * instead of leaving those screens empty until someone confirms by hand. */
export async function syncRecurringFromLedger(userId: string): Promise<number> {
  const from = new Date()
  from.setMonth(from.getMonth() - 8)
  const [txns, existing, dismissed] = await Promise.all([
    fetchTransactions({ from: from.toISOString().slice(0, 10), limit: 3000 }),
    fetchRecurring(),
    fetchDismissedRecurring().catch(() => [] as DismissedRecurring[]),
  ])
  const known = new Set(
    existing.flatMap((r) => [r.name.toUpperCase(), (r.notes ?? '').toUpperCase()]).filter(Boolean),
  )
  const rejected = new Set(dismissed.map((d) => d.match_key))
  const candidates = detectRecurring(
    txns
      .filter((t) => !t.is_transfer && !t.recurring_payment_id)
      .map((t) => ({ date: t.date, amountMinor: t.amount_minor, description: t.description })),
  ).filter((c) => c.confidence >= 0.7 && !known.has(c.key) && !rejected.has(c.key))

  let created = 0
  for (const c of candidates) {
    const row = await upsertRecurring(userId, {
      name: c.key
        .toLowerCase()
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      kind: c.averageAmountMinor > 0 ? 'income' : 'bill',
      amount_minor: c.averageAmountMinor,
      frequency: c.frequency,
      next_due_date: c.nextExpectedDate,
      source: 'detected',
      confidence: c.confidence,
      needs_confirmation: true,
      notes: c.key,
    }).catch(() => null)
    if (!row) continue
    created++
    // Link the transactions this bill is made of, so "bills paid" is real.
    const ids = txns
      .filter((t) => !t.recurring_payment_id && normaliseDescription(t.description) === c.key)
      .map((t) => t.id)
    if (ids.length > 0) {
      await supabase.from('transactions').update({ recurring_payment_id: row.id }).in('id', ids)
    }
  }
  return created
}

// ------------------------------------------------------------------- debts
export async function fetchLiabilities(): Promise<Liability[]> {
  const { data, error } = await supabase
    .from('liabilities')
    .select('*')
    .neq('status', 'archived')
    .order('created_at')
  throwIf(error)
  return (data ?? []) as Liability[]
}

export async function upsertLiability(
  userId: string,
  input: Partial<Liability> & { name: string; liability_type: Liability['liability_type'] },
  id?: string,
  source: 'manual' | 'ai_chat' | 'import' = 'manual',
): Promise<Liability> {
  let row: Liability
  if (id) {
    const { data: prev } = await supabase.from('liabilities').select('*').eq('id', id).single()
    const { data, error } = await supabase.from('liabilities').update(input).eq('id', id).select().single()
    throwIf(error)
    row = data as Liability
    await recordAudit({
      userId, recordType: 'liability', recordId: id, action: 'update', previous: prev, next: input,
      source: source === 'manual' ? 'manual' : 'ai_chat', undoable: true,
    })
  } else {
    const { data, error } = await supabase
      .from('liabilities')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    throwIf(error)
    row = data as Liability
    await recordAudit({
      userId, recordType: 'liability', recordId: row.id, action: 'insert', next: input,
      source: source === 'manual' ? 'manual' : 'ai_chat', undoable: true,
    })
  }
  await writeNetWorthSnapshot(userId)
  return row
}

/**
 * Link ledger transactions to debts and log them as payments, so paying a
 * debt actually moves its record. Matching runs through recurring payments
 * (bill → liability), which the detector maintains — no fuzzy matching here.
 * Backfilled history never adjusts balances; only payments dated after the
 * liability's stated balance date reduce it, so a user-stated balance stays
 * the source of truth for everything before it.
 */
export async function syncDebtLinks(userId: string): Promise<number> {
  const { data: rps } = await supabase
    .from('recurring_payments')
    .select('id,liability_id')
    .not('liability_id', 'is', null)
  const map = new Map((rps ?? []).map((r) => [r.id as string, r.liability_id as string]))
  if (map.size === 0) return 0

  const { data: unlinked } = await supabase
    .from('transactions')
    .select('id,date,amount_minor,recurring_payment_id')
    .is('liability_id', null)
    .not('recurring_payment_id', 'is', null)
    .lt('amount_minor', 0)
  const candidates = (unlinked ?? []).filter((t) => map.has(t.recurring_payment_id as string))
  let linked = 0
  for (const t of candidates) {
    const liabilityId = map.get(t.recurring_payment_id as string)!
    await supabase.from('transactions').update({ liability_id: liabilityId }).eq('id', t.id)
    const { data: liab } = await supabase
      .from('liabilities')
      .select('current_balance_minor,balance_effective_date')
      .eq('id', liabilityId)
      .single()
    const { error } = await supabase.from('debt_payments').insert({
      user_id: userId,
      liability_id: liabilityId,
      transaction_id: t.id,
      date: t.date,
      amount_minor: -(t.amount_minor as number),
      kind: 'scheduled',
      source: 'matched',
    })
    if (error) continue
    linked++
    if (liab && t.date > (liab.balance_effective_date as string)) {
      const newBalance = Math.max(
        0,
        (liab.current_balance_minor as number) - -(t.amount_minor as number),
      )
      await supabase
        .from('liabilities')
        .update({
          current_balance_minor: newBalance,
          balance_source: 'calculated',
          balance_effective_date: t.date,
        })
        .eq('id', liabilityId)
    }
  }
  if (linked > 0) await writeNetWorthSnapshot(userId)
  return linked
}

export interface PendingContract {
  id: string
  document_id: string | null
  extracted: Record<string, unknown>
  confidence: number | null
  status: string
  created_at: string
}

export async function fetchPendingContracts(): Promise<PendingContract[]> {
  const { data, error } = await supabase
    .from('loan_contracts')
    .select('*')
    .eq('status', 'proposed')
    .order('created_at', { ascending: false })
  throwIf(error)
  return (data ?? []) as PendingContract[]
}

/**
 * Apply an extracted agreement's terms to a liability. Extracted terms
 * override what's on the record (the agreement is the better source), but
 * only fields the extraction actually found — nulls never blank real data.
 */
export async function applyContract(
  userId: string,
  contract: PendingContract,
  liabilityId: string | null,
): Promise<Liability> {
  const x = contract.extracted as Record<string, unknown>
  const val = <T>(k: string): T | undefined => (x[k] === null || x[k] === undefined ? undefined : (x[k] as T))
  const patch: Partial<Liability> = {}
  const balance = val<number>('current_balance_minor')
  if (val<number>('original_amount_minor') !== undefined) patch.original_balance_minor = val<number>('original_amount_minor')!
  if (balance !== undefined) {
    patch.current_balance_minor = balance
    patch.balance_source = 'imported'
    patch.balance_effective_date = new Date().toISOString().slice(0, 10)
  }
  if (val<number>('apr') !== undefined) patch.apr = val<number>('apr')!
  if (val<string>('rate_type') !== undefined) patch.rate_type = val<string>('rate_type') as Liability['rate_type']
  if (val<string>('start_date') !== undefined) patch.start_date = val<string>('start_date')!
  if (val<number>('term_months') !== undefined) patch.term_months = val<number>('term_months')!
  if (val<number>('monthly_payment_minor') !== undefined) patch.monthly_payment_minor = val<number>('monthly_payment_minor')!
  if (val<number>('payment_day') !== undefined) patch.payment_day = val<number>('payment_day')!
  if (val<number>('fees_minor') !== undefined) patch.fees_minor = val<number>('fees_minor')!
  if (val<number>('final_payment_minor') !== undefined) patch.final_payment_minor = val<number>('final_payment_minor')!
  if (val<number>('balloon_minor') !== undefined) patch.balloon_minor = val<number>('balloon_minor')!
  if (val<number>('settlement_quote_minor') !== undefined) patch.settlement_quote_minor = val<number>('settlement_quote_minor')!
  if (val<string>('settlement_quote_expiry') !== undefined) patch.settlement_quote_expiry = val<string>('settlement_quote_expiry')!
  if (val<string>('early_repayment_terms') !== undefined) patch.early_repayment_terms = val<string>('early_repayment_terms')!
  if (val<string>('overpayment_rule') !== undefined) patch.overpayment_rule = val<string>('overpayment_rule') as Liability['overpayment_rule']
  if (val<string>('agreement_ref') !== undefined) patch.agreement_ref = val<string>('agreement_ref')!

  let row: Liability
  if (liabilityId) {
    row = await upsertLiability(userId, patch as Partial<Liability> & { name: string; liability_type: Liability['liability_type'] }, liabilityId, 'import')
  } else {
    row = await upsertLiability(
      userId,
      {
        name: val<string>('lender') ?? 'New agreement',
        provider: val<string>('lender') ?? null,
        liability_type: (val<string>('liability_type') as Liability['liability_type']) ?? 'other',
        current_balance_minor: balance ?? 0,
        ...patch,
      } as Partial<Liability> & { name: string; liability_type: Liability['liability_type'] },
      undefined,
      'import',
    )
  }
  await supabase
    .from('loan_contracts')
    .update({ status: 'confirmed', liability_id: row.id, confirmed_at: new Date().toISOString() })
    .eq('id', contract.id)
  return row
}

export async function dismissContract(id: string): Promise<void> {
  const { error } = await supabase.from('loan_contracts').update({ status: 'rejected' }).eq('id', id)
  throwIf(error)
}

export async function fetchDebtPayments(liabilityId: string): Promise<DebtPayment[]> {
  const { data, error } = await supabase
    .from('debt_payments')
    .select('*')
    .eq('liability_id', liabilityId)
    .order('date', { ascending: false })
  throwIf(error)
  return (data ?? []) as DebtPayment[]
}

export async function recordDebtPayment(
  userId: string,
  input: { liability_id: string; date: string; amount_minor: number; kind: DebtPayment['kind']; note?: string; transaction_id?: string },
  source: 'manual' | 'ai_chat' | 'matched' = 'manual',
): Promise<DebtPayment> {
  const { data, error } = await supabase
    .from('debt_payments')
    .insert({ ...input, user_id: userId, source })
    .select()
    .single()
  throwIf(error)
  // Reduce the liability's calculated balance by the principal effect of the
  // payment (interest is captured in the schedule; a simple payment reduces
  // the stated balance — labelled 'calculated', never lender-confirmed).
  const { data: liab } = await supabase.from('liabilities').select('*').eq('id', input.liability_id).single()
  if (liab) {
    const newBalance = Math.max(0, (liab as Liability).current_balance_minor - input.amount_minor)
    await supabase
      .from('liabilities')
      .update({
        current_balance_minor: newBalance,
        balance_source: 'calculated',
        balance_effective_date: input.date,
        ...(newBalance === 0 ? { status: 'settled' } : {}),
      })
      .eq('id', input.liability_id)
  }
  await recordAudit({
    userId, recordType: 'debt_payment', recordId: data!.id, action: 'insert', next: input,
    source: source === 'matched' ? 'system' : source === 'manual' ? 'manual' : 'ai_chat', undoable: true,
  })
  await writeNetWorthSnapshot(userId)
  return data as DebtPayment
}

export async function saveSchedule(
  userId: string,
  liabilityId: string,
  scheduleType: 'original' | 'revised',
  rows: { paymentNumber: number; dueDate: string; paymentMinor: number; principalMinor: number; interestMinor: number; balanceAfterMinor: number }[],
): Promise<void> {
  await supabase
    .from('loan_payment_schedules')
    .delete()
    .eq('liability_id', liabilityId)
    .eq('schedule_type', scheduleType)
  if (rows.length === 0) return
  const { error } = await supabase.from('loan_payment_schedules').insert(
    rows.map((r) => ({
      user_id: userId,
      liability_id: liabilityId,
      schedule_type: scheduleType,
      payment_number: r.paymentNumber,
      due_date: r.dueDate,
      payment_minor: r.paymentMinor,
      principal_minor: r.principalMinor,
      interest_minor: r.interestMinor,
      balance_after_minor: r.balanceAfterMinor,
    })),
  )
  throwIf(error)
}

export async function fetchSchedule(liabilityId: string): Promise<LoanScheduleRow[]> {
  const { data, error } = await supabase
    .from('loan_payment_schedules')
    .select('*')
    .eq('liability_id', liabilityId)
    .order('schedule_type')
    .order('payment_number')
  throwIf(error)
  return (data ?? []) as LoanScheduleRow[]
}

// ------------------------------------------------------------------ savings
export async function fetchSavingsGoals(): Promise<SavingsGoal[]> {
  const { data, error } = await supabase
    .from('savings_goals')
    .select('*')
    .neq('status', 'archived')
    .order('priority')
  throwIf(error)
  return (data ?? []) as SavingsGoal[]
}

export async function upsertSavingsGoal(
  userId: string,
  input: Partial<SavingsGoal> & { name: string; target_minor: number },
  id?: string,
): Promise<SavingsGoal> {
  if (id) {
    const { data, error } = await supabase.from('savings_goals').update(input).eq('id', id).select().single()
    throwIf(error)
    return data as SavingsGoal
  }
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({ ...input, user_id: userId })
    .select()
    .single()
  throwIf(error)
  await recordAudit({ userId, recordType: 'savings_goal', recordId: data!.id, action: 'insert', next: input, undoable: true })
  return data as SavingsGoal
}

// -------------------------------------------------------------------- facts
export async function fetchFacts(): Promise<FinancialFact[]> {
  const { data, error } = await supabase
    .from('financial_facts')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
  throwIf(error)
  return (data ?? []) as FinancialFact[]
}

export async function deleteFact(id: string): Promise<void> {
  const { error } = await supabase.from('financial_facts').update({ is_active: false }).eq('id', id)
  throwIf(error)
}

// ----------------------------------------------------------------- insights
export async function fetchInsights(status: Insight['status'] = 'active'): Promise<Insight[]> {
  const { data, error } = await supabase
    .from('insights')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(50)
  throwIf(error)
  return (data ?? []) as Insight[]
}

export async function setInsightStatus(
  userId: string,
  id: string,
  status: Insight['status'],
  feedback?: 'dismissed' | 'muted_merchant' | 'muted_type' | 'useful' | 'converted',
): Promise<void> {
  const { error } = await supabase.from('insights').update({ status }).eq('id', id)
  throwIf(error)
  if (feedback) {
    await supabase.from('insight_feedback').insert({ user_id: userId, insight_id: id, action: feedback })
  }
}

// ---------------------------------------------------------------- documents
export async function uploadDocument(
  userId: string,
  file: File,
  kind: DocumentRow['kind'],
): Promise<DocumentRow> {
  const allowed = ['image/png', 'image/jpeg', 'application/pdf', 'text/csv', 'application/vnd.ms-excel']
  if (!allowed.includes(file.type)) throw new Error(`Unsupported file type: ${file.type || 'unknown'}`)
  if (file.size > 15 * 1024 * 1024) throw new Error('File exceeds the 15 MB limit')
  const path = `${userId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file)
  if (upErr) throw new Error(upErr.message)
  const { data, error } = await supabase
    .from('documents')
    .insert({
      user_id: userId,
      storage_path: path,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      kind,
    })
    .select()
    .single()
  throwIf(error)
  return data as DocumentRow
}

export async function deleteDocumentFile(doc: DocumentRow): Promise<void> {
  await supabase.storage.from('documents').remove([doc.storage_path])
  await supabase
    .from('documents')
    .update({ status: 'deleted', deleted_at: new Date().toISOString() })
    .eq('id', doc.id)
}

export async function signedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(path, 300)
  if (error) throw new Error(error.message)
  return data.signedUrl
}

// ------------------------------------------------------------------ imports
export async function fetchBatches(): Promise<ImportBatch[]> {
  const { data, error } = await supabase
    .from('import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  throwIf(error)
  return (data ?? []) as ImportBatch[]
}

export async function fetchBatchItems(batchId: string): Promise<ImportedItem[]> {
  const { data, error } = await supabase
    .from('imported_items')
    .select('*')
    .eq('batch_id', batchId)
    .order('proposed_date')
  throwIf(error)
  return (data ?? []) as ImportedItem[]
}

/** Undo a completed import batch: delete its transactions, mark it undone. */
export async function undoImportBatch(userId: string, batchId: string): Promise<number> {
  const { data: txns } = await supabase.from('transactions').select('id').eq('import_batch_id', batchId)
  const count = txns?.length ?? 0
  await supabase.from('transactions').delete().eq('import_batch_id', batchId)
  await supabase.from('import_batches').update({ status: 'undone' }).eq('id', batchId)
  await recordAudit({
    userId, recordType: 'import_batch', recordId: batchId, action: 'undo',
    next: { deleted_transactions: count }, source: 'undo',
  })
  return count
}

// --------------------------------------------------------------------- chat
export async function fetchConversations(): Promise<ChatConversation[]> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(30)
  throwIf(error)
  return (data ?? []) as ChatConversation[]
}

export async function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at')
  throwIf(error)
  return (data ?? []) as ChatMessage[]
}

// -------------------------------------------------------------------- audit
export async function fetchAuditEvents(limit = 100): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('audit_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  throwIf(error)
  return (data ?? []) as AuditEvent[]
}

// ------------------------------------------------------------------ profile
export async function fetchProfile(): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from('profiles').select('*').maybeSingle()
  return data
}

export async function updateProfile(userId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId)
  throwIf(error)
}

/** Full data export as a JSON blob (Settings → Export). */
export async function exportAllData(): Promise<Blob> {
  const tables = [
    'accounts', 'account_balance_snapshots', 'transactions', 'transaction_splits',
    'merchants', 'merchant_aliases', 'categories', 'categorisation_rules',
    'budgets', 'budget_lines', 'recurring_payments', 'liabilities',
    'loan_payment_schedules', 'debt_payments', 'net_worth_snapshots',
    'savings_goals', 'financial_facts', 'documents', 'import_batches',
    'imported_items', 'insights', 'audit_events',
    'chat_conversations', 'chat_messages', 'ai_actions', 'error_log',
  ]
  const out: Record<string, unknown[]> = {}
  for (const t of tables) {
    const { data } = await supabase.from(t).select('*')
    out[t] = data ?? []
  }
  return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
}

// ------------------------------------------------------------ error log
/** Record an error so it survives the toast that showed it. Never throws —
 * a failure to log must not mask the original problem. */
export async function logAppError(
  userId: string,
  context: string,
  message: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from('error_log').insert({
      user_id: userId,
      context,
      message: message.slice(0, 2000),
      detail: { route: window.location.pathname, ...detail },
    })
  } catch {
    /* logging is best-effort */
  }
}

export interface AppError {
  id: string
  occurred_at: string
  context: string
  message: string
  detail: Record<string, unknown> | null
}

export async function fetchErrors(limit = 100): Promise<AppError[]> {
  const { data } = await supabase
    .from('error_log')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as AppError[]
}

export async function clearErrors(): Promise<void> {
  await supabase.from('error_log').delete().gte('occurred_at', '1970-01-01')
}

/** Diagnostics bundle: everything needed to debug a problem, without the
 * full financial history — errors, failed AI actions and failed imports. */
export async function exportDiagnostics(): Promise<Blob> {
  const [errors, aiActions, batches, messages] = await Promise.all([
    supabase.from('error_log').select('*').order('occurred_at', { ascending: false }).limit(500),
    supabase.from('ai_actions').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(100),
    supabase.from('chat_messages').select('*').order('created_at', { ascending: false }).limit(200),
  ])
  const bundle = {
    exported_at: new Date().toISOString(),
    app: { url: window.location.origin, user_agent: navigator.userAgent },
    error_log: errors.data ?? [],
    ai_actions: aiActions.data ?? [],
    import_batches: batches.data ?? [],
    chat_messages: messages.data ?? [],
  }
  return new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
}
