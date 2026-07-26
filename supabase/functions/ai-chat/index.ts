// AI chat assistant. Interprets natural language and performs STRUCTURED,
// validated actions through explicit executors — never arbitrary SQL. All
// database work runs under the calling user's JWT (RLS enforced), every action
// is recorded in ai_actions + audit_events with undo data, and calculated
// numbers come from the ledger, not from the model.

import Anthropic from 'npm:@anthropic-ai/sdk@0.65.0'
import { z } from 'npm:zod@3.25.76'
import { corsHeaders, json, recordAudit, requireUser, type AuthedContext } from '../_shared/common.ts'

// Sonnet handles this structured tool-calling well at a fraction of Opus
// pricing; combined with prompt caching below, per-message cost drops ~10-20x.
const MODEL = 'claude-sonnet-5'

// ---------------------------------------------------------------- schemas
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const actionSchemas = {
  create_transaction: z.object({
    account_id: z.string().uuid(),
    date: isoDate,
    description: z.string().min(1).max(500),
    merchant_name: z.string().max(200).nullish(),
    category_id: z.string().uuid().nullish(),
    amount_minor: z.number().int(),
    notes: z.string().max(1000).nullish(),
  }),
  update_transaction: z.object({
    transaction_id: z.string().uuid(),
    patch: z.object({
      category_id: z.string().uuid().nullish(),
      merchant_name: z.string().max(200).nullish(),
      is_transfer: z.boolean().optional(),
      is_reimbursable: z.boolean().optional(),
      exclude_from_budget: z.boolean().optional(),
      notes: z.string().max(1000).nullish(),
    }),
  }),
  split_transaction: z.object({
    transaction_id: z.string().uuid(),
    parts: z
      .array(z.object({ category_id: z.string().uuid().nullable(), amount_minor: z.number().int() }))
      .min(2)
      .max(10),
  }),
  create_account: z.object({
    name: z.string().min(1).max(120),
    provider: z.string().max(120).nullish(),
    account_type: z.enum([
      'current', 'savings', 'credit_card', 'wallet', 'cash', 'loan', 'vehicle_finance',
      'mortgage', 'investment', 'pension', 'property', 'vehicle', 'other_asset', 'other_liability',
    ]),
    balance_minor: z.number().int(),
  }),
  update_account_balance: z.object({
    account_id: z.string().uuid(),
    balance_minor: z.number().int(),
  }),
  create_liability: z.object({
    name: z.string().min(1).max(120),
    provider: z.string().max(120).nullish(),
    liability_type: z.enum([
      'personal_loan', 'credit_card', 'paypal_credit', 'vehicle_finance', 'hire_purchase',
      'pcp', 'mortgage', 'informal', 'other',
    ]),
    current_balance_minor: z.number().int().nonnegative(),
    apr: z.number().min(0).max(200).nullish(),
    monthly_payment_minor: z.number().int().nullish(),
    effective_date: isoDate.nullish(),
  }),
  update_liability: z.object({
    liability_id: z.string().uuid(),
    patch: z.object({
      current_balance_minor: z.number().int().nonnegative().optional(),
      apr: z.number().min(0).max(200).nullish(),
      monthly_payment_minor: z.number().int().nullish(),
      settlement_quote_minor: z.number().int().nullish(),
      status: z.enum(['active', 'settled']).optional(),
    }),
    effective_date: isoDate.nullish(),
  }),
  record_debt_payment: z.object({
    liability_id: z.string().uuid(),
    amount_minor: z.number().int().positive(),
    date: isoDate,
    kind: z.enum(['scheduled', 'overpayment', 'fee', 'adjustment']),
  }),
  create_merchant_rule: z.object({
    merchant_name: z.string().min(1).max(120),
    alias_patterns: z.array(z.string().min(2).max(120)).min(1).max(5),
    category_name: z.string().max(120).nullish(),
    subcategory_name: z.string().max(120).nullish(),
    apply_to_past: z.boolean().default(true),
  }),
  create_category: z.object({
    name: z.string().min(1).max(120),
    parent_name: z.string().max(120).nullish(),
  }),
  update_category: z.object({
    category_name: z.string().min(1).max(120),
    new_name: z.string().max(120).nullish(),
    new_parent_name: z.string().max(120).nullish(),
    make_top_level: z.boolean().default(false),
  }),
  create_recurring_payment: z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(['bill', 'subscription', 'income', 'debt_payment', 'savings']),
    amount_minor: z.number().int(),
    frequency: z.enum([
      'weekly', 'fortnightly', 'monthly', 'four_weekly', 'quarterly', 'six_monthly', 'annual',
    ]),
    next_due_date: isoDate,
    is_essential: z.boolean().default(true),
  }),
  update_budget: z.object({
    month: isoDate,
    category_name: z.string().max(120).nullish(),
    kind: z.enum(['fixed', 'variable', 'discretionary', 'debt', 'savings', 'one_off']).default('variable'),
    planned_minor: z.number().int().nonnegative(),
    expected_income_minor: z.number().int().nonnegative().nullish(),
  }),
  create_savings_goal: z.object({
    name: z.string().min(1).max(120),
    target_minor: z.number().int().positive(),
    current_minor: z.number().int().nonnegative().default(0),
    target_date: isoDate.nullish(),
    kind: z.enum(['general', 'emergency_fund', 'goal', 'sinking_fund', 'purchase', 'debt_pot']).default('goal'),
  }),
  create_financial_fact: z.object({
    fact_type: z.string().min(1).max(60),
    fact_key: z.string().min(1).max(120),
    value: z.record(z.unknown()),
    confidence: z.enum(['confirmed', 'likely']).default('confirmed'),
    affects_calculations: z.boolean().default(false),
  }),
  find_transactions: z.object({
    search: z.string().max(200).nullish(),
    merchant: z.string().max(200).nullish(),
    category_name: z.string().max(120).nullish(),
    from: isoDate.nullish(),
    to: isoDate.nullish(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
} as const

type ActionType = keyof typeof actionSchemas

// ------------------------------------------------------------- tool defs
const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'create_transaction',
    description:
      'Record a transaction the user explicitly describes. amount_minor is pence, negative for money out. Use when the user states a payment or income directly.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'UUID of the account (from context)' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        description: { type: 'string' },
        merchant_name: { type: 'string' },
        category_id: { type: 'string', description: 'Category UUID from context, if clear' },
        amount_minor: { type: 'integer', description: 'Pence. Negative = money out.' },
        notes: { type: 'string' },
      },
      required: ['account_id', 'date', 'description', 'amount_minor'],
    },
  },
  {
    name: 'update_transaction',
    description:
      'Update a transaction: recategorise, mark as transfer/reimbursable, exclude from budget, or add notes. Find the id with find_transactions first.',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            category_id: { type: 'string' },
            merchant_name: { type: 'string' },
            is_transfer: { type: 'boolean' },
            is_reimbursable: { type: 'boolean' },
            exclude_from_budget: { type: 'boolean' },
            notes: { type: 'string' },
          },
        },
      },
      required: ['transaction_id', 'patch'],
    },
  },
  {
    name: 'split_transaction',
    description:
      'Split a transaction into category parts, e.g. "£60 groceries and £20 household". Parts must sum to the transaction amount (negative for spending).',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category_id: { type: ['string', 'null'] },
              amount_minor: { type: 'integer' },
            },
            required: ['category_id', 'amount_minor'],
          },
        },
      },
      required: ['transaction_id', 'parts'],
    },
  },
  {
    name: 'create_account',
    description: 'Create a new account or asset when the user asks to track one.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        provider: { type: 'string' },
        account_type: { type: 'string', description: 'current|savings|credit_card|wallet|cash|loan|vehicle_finance|mortgage|investment|pension|property|vehicle|other_asset|other_liability' },
        balance_minor: { type: 'integer' },
      },
      required: ['name', 'account_type', 'balance_minor'],
    },
  },
  {
    name: 'update_account_balance',
    description: 'Record a new balance for an account when the user states it.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        balance_minor: { type: 'integer' },
      },
      required: ['account_id', 'balance_minor'],
    },
  },
  {
    name: 'create_liability',
    description:
      'Create a structured debt record when the user states a debt, e.g. "I still owe £500 on PayPal". Always create the record — do not leave it as conversation only.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        provider: { type: 'string' },
        liability_type: { type: 'string', description: 'personal_loan|credit_card|paypal_credit|vehicle_finance|hire_purchase|pcp|mortgage|informal|other' },
        current_balance_minor: { type: 'integer', description: 'Amount owed in pence (positive)' },
        apr: { type: 'number' },
        monthly_payment_minor: { type: 'integer' },
        effective_date: { type: 'string' },
      },
      required: ['name', 'liability_type', 'current_balance_minor'],
    },
  },
  {
    name: 'update_liability',
    description: 'Update an existing debt (new user-stated balance, APR, settlement quote, settled).',
    input_schema: {
      type: 'object',
      properties: {
        liability_id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            current_balance_minor: { type: 'integer' },
            apr: { type: 'number' },
            monthly_payment_minor: { type: 'integer' },
            settlement_quote_minor: { type: 'integer' },
            status: { type: 'string' },
          },
        },
        effective_date: { type: 'string' },
      },
      required: ['liability_id', 'patch'],
    },
  },
  {
    name: 'record_debt_payment',
    description:
      'Record a payment against a debt, e.g. "I paid an extra £100 off my loan today" → kind overpayment. Reduces the calculated balance.',
    input_schema: {
      type: 'object',
      properties: {
        liability_id: { type: 'string' },
        amount_minor: { type: 'integer', description: 'Positive pence paid' },
        date: { type: 'string' },
        kind: { type: 'string', description: 'scheduled|overpayment|fee|adjustment' },
      },
      required: ['liability_id', 'amount_minor', 'date', 'kind'],
    },
  },
  {
    name: 'create_merchant_rule',
    description:
      'Learn a merchant categorisation, e.g. "Acme Gym is my monthly gym membership" → merchant Acme Gym, category Health, subcategory Fitness, alias patterns like ACME GYM. Applies to future imports and optionally past transactions. Also THE tool for fixing miscategorisations in bulk.',
    input_schema: {
      type: 'object',
      properties: {
        merchant_name: { type: 'string' },
        alias_patterns: { type: 'array', items: { type: 'string' }, description: 'Uppercase substrings that match bank descriptions, e.g. ["ACME GYM"]' },
        category_name: { type: 'string' },
        subcategory_name: { type: 'string' },
        apply_to_past: { type: 'boolean' },
      },
      required: ['merchant_name', 'alias_patterns'],
    },
  },
  {
    name: 'create_category',
    description:
      'Create a new category, optionally under a parent (the parent is created too if missing). Use whenever the user wants a category that does not exist yet.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent_name: { type: 'string', description: 'Optional parent; omit for a top-level category' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_category',
    description:
      'Rename a category and/or move it under a different parent (or to top level). Transactions keep their categorisation and every stat recalculates automatically.',
    input_schema: {
      type: 'object',
      properties: {
        category_name: { type: 'string', description: 'The category to change, by name' },
        new_name: { type: 'string' },
        new_parent_name: { type: 'string', description: 'Move under this parent (created if missing)' },
        make_top_level: { type: 'boolean', description: 'Move to top level instead' },
      },
      required: ['category_name'],
    },
  },
  {
    name: 'create_recurring_payment',
    description: 'Create a recurring bill/subscription/income the user describes or confirms.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', description: 'bill|subscription|income|debt_payment|savings' },
        amount_minor: { type: 'integer', description: 'Negative for outgoings' },
        frequency: { type: 'string', description: 'weekly|fortnightly|monthly|four_weekly|quarterly|six_monthly|annual' },
        next_due_date: { type: 'string' },
        is_essential: { type: 'boolean' },
      },
      required: ['name', 'kind', 'amount_minor', 'frequency', 'next_due_date'],
    },
  },
  {
    name: 'update_budget',
    description: 'Set a budget line for a month (creates the month budget if needed).',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'First of month YYYY-MM-01' },
        category_name: { type: 'string' },
        kind: { type: 'string', description: 'fixed|variable|discretionary|debt|savings|one_off' },
        planned_minor: { type: 'integer' },
        expected_income_minor: { type: 'integer' },
      },
      required: ['month', 'planned_minor'],
    },
  },
  {
    name: 'create_savings_goal',
    description: 'Create a savings goal, e.g. "I want a £10,000 emergency fund".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        target_minor: { type: 'integer' },
        current_minor: { type: 'integer' },
        target_date: { type: 'string' },
        kind: { type: 'string', description: 'general|emergency_fund|goal|sinking_fund|purchase|debt_pot' },
      },
      required: ['name', 'target_minor'],
    },
  },
  {
    name: 'create_financial_fact',
    description:
      'Remember a structured financial fact (payday day, merchant meanings, preferences). Use alongside other actions when the user states something durable.',
    input_schema: {
      type: 'object',
      properties: {
        fact_type: { type: 'string', description: 'e.g. payday, merchant_meaning, preference, debt_balance' },
        fact_key: { type: 'string' },
        value: { type: 'object' },
        confidence: { type: 'string', description: 'confirmed if user stated it directly, likely if inferred' },
        affects_calculations: { type: 'boolean' },
      },
      required: ['fact_type', 'fact_key', 'value'],
    },
  },
  {
    name: 'find_transactions',
    description:
      'Query the ledger for transactions. Use this to ANSWER spending questions with real calculated numbers — never estimate totals yourself. Returns matching transactions with a computed total.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Matches description/merchant, e.g. STARBUCKS' },
        merchant: { type: 'string' },
        category_name: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
]

// ------------------------------------------------------------- executors
interface ActionResult {
  summary: string
  result?: unknown
  undoData?: { table: string; id?: string; previous?: Record<string, unknown> } | null
  undoable: boolean
}

async function executeAction(
  ctx: AuthedContext,
  type: ActionType,
  rawInput: unknown,
): Promise<ActionResult> {
  const input = actionSchemas[type].parse(rawInput) as never
  const { supabase, userId } = ctx
  const fmt = (m: number) =>
    `£${(Math.abs(m) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`

  switch (type) {
    case 'create_transaction': {
      const i = input as z.infer<(typeof actionSchemas)['create_transaction']>
      const { data, error } = await supabase
        .from('transactions')
        .insert({ ...i, user_id: userId, source: 'ai_chat' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Saved ${fmt(i.amount_minor)} ${i.amount_minor < 0 ? 'payment' : 'income'} "${i.description}" on ${i.date}`,
        undoData: { table: 'transactions', id: data.id },
        undoable: true,
      }
    }
    case 'update_transaction': {
      const i = input as z.infer<(typeof actionSchemas)['update_transaction']>
      const { data: prev } = await supabase.from('transactions').select('*').eq('id', i.transaction_id).single()
      if (!prev) throw new Error('Transaction not found')
      const { error } = await supabase.from('transactions').update(i.patch).eq('id', i.transaction_id)
      if (error) throw new Error(error.message)
      const previous: Record<string, unknown> = {}
      for (const k of Object.keys(i.patch)) previous[k] = (prev as Record<string, unknown>)[k]
      return {
        summary: `Updated transaction "${(prev as { description: string }).description}"`,
        undoData: { table: 'transactions', id: i.transaction_id, previous },
        undoable: true,
      }
    }
    case 'split_transaction': {
      const i = input as z.infer<(typeof actionSchemas)['split_transaction']>
      const { data: txn } = await supabase.from('transactions').select('*').eq('id', i.transaction_id).single()
      if (!txn) throw new Error('Transaction not found')
      const sum = i.parts.reduce((a, p) => a + p.amount_minor, 0)
      if (sum !== (txn as { amount_minor: number }).amount_minor) {
        throw new Error(
          `Split parts total ${fmt(sum)} but the transaction is ${fmt((txn as { amount_minor: number }).amount_minor)} — they must match exactly`,
        )
      }
      await supabase.from('transaction_splits').delete().eq('transaction_id', i.transaction_id)
      const { error } = await supabase.from('transaction_splits').insert(
        i.parts.map((p) => ({ ...p, user_id: userId, transaction_id: i.transaction_id })),
      )
      if (error) throw new Error(error.message)
      return {
        summary: `Split "${(txn as { description: string }).description}" into ${i.parts.length} parts`,
        undoData: { table: 'transaction_splits', id: i.transaction_id },
        undoable: false, // splits can be edited again; row-level undo not meaningful
      }
    }
    case 'create_account': {
      const i = input as z.infer<(typeof actionSchemas)['create_account']>
      const { data, error } = await supabase
        .from('accounts')
        .insert({ ...i, user_id: userId, balance_source: 'ai_chat' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Created account "${i.name}" with balance ${fmt(i.balance_minor)}`,
        undoData: { table: 'accounts', id: data.id },
        undoable: true,
      }
    }
    case 'update_account_balance': {
      const i = input as z.infer<(typeof actionSchemas)['update_account_balance']>
      const { data: prev } = await supabase.from('accounts').select('*').eq('id', i.account_id).single()
      if (!prev) throw new Error('Account not found')
      const { error } = await supabase
        .from('accounts')
        .update({ balance_minor: i.balance_minor, balance_source: 'ai_chat' })
        .eq('id', i.account_id)
      if (error) throw new Error(error.message)
      return {
        summary: `Updated ${(prev as { name: string }).name} balance to ${fmt(i.balance_minor)} (was ${fmt((prev as { balance_minor: number }).balance_minor)})`,
        undoData: {
          table: 'accounts',
          id: i.account_id,
          previous: { balance_minor: (prev as { balance_minor: number }).balance_minor },
        },
        undoable: true,
      }
    }
    case 'create_liability': {
      const i = input as z.infer<(typeof actionSchemas)['create_liability']>
      // Update instead of duplicating when a similarly-named active debt exists
      const { data: existing } = await supabase
        .from('liabilities')
        .select('*')
        .eq('status', 'active')
        .ilike('name', `%${i.name}%`)
        .maybeSingle()
      if (existing) {
        const prev = existing as { id: string; current_balance_minor: number; name: string }
        await supabase
          .from('liabilities')
          .update({
            current_balance_minor: i.current_balance_minor,
            balance_source: 'user_stated',
            balance_effective_date: i.effective_date ?? new Date().toISOString().slice(0, 10),
          })
          .eq('id', prev.id)
        return {
          summary: `Updated ${prev.name} balance to ${fmt(i.current_balance_minor)} (user-stated, was ${fmt(prev.current_balance_minor)})`,
          undoData: { table: 'liabilities', id: prev.id, previous: { current_balance_minor: prev.current_balance_minor } },
          undoable: true,
        }
      }
      const { data, error } = await supabase
        .from('liabilities')
        .insert({
          ...i,
          effective_date: undefined,
          user_id: userId,
          balance_source: 'user_stated',
          balance_effective_date: i.effective_date ?? new Date().toISOString().slice(0, 10),
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Created debt "${i.name}" — ${fmt(i.current_balance_minor)} owed (user-stated). Net worth updated.`,
        undoData: { table: 'liabilities', id: data.id },
        undoable: true,
      }
    }
    case 'update_liability': {
      const i = input as z.infer<(typeof actionSchemas)['update_liability']>
      const { data: prev } = await supabase.from('liabilities').select('*').eq('id', i.liability_id).single()
      if (!prev) throw new Error('Debt not found')
      const patch: Record<string, unknown> = { ...i.patch }
      if (i.patch.current_balance_minor !== undefined) {
        patch.balance_source = 'user_stated'
        patch.balance_effective_date = i.effective_date ?? new Date().toISOString().slice(0, 10)
      }
      const { error } = await supabase.from('liabilities').update(patch).eq('id', i.liability_id)
      if (error) throw new Error(error.message)
      const previous: Record<string, unknown> = {}
      for (const k of Object.keys(i.patch)) previous[k] = (prev as Record<string, unknown>)[k]
      return {
        summary: `Updated ${(prev as { name: string }).name}`,
        undoData: { table: 'liabilities', id: i.liability_id, previous },
        undoable: true,
      }
    }
    case 'record_debt_payment': {
      const i = input as z.infer<(typeof actionSchemas)['record_debt_payment']>
      const { data: liab } = await supabase.from('liabilities').select('*').eq('id', i.liability_id).single()
      if (!liab) throw new Error('Debt not found')
      const prev = liab as { id: string; name: string; current_balance_minor: number }
      const { data: payment, error } = await supabase
        .from('debt_payments')
        .insert({ ...i, user_id: userId, source: 'ai_chat' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      const newBalance = Math.max(0, prev.current_balance_minor - i.amount_minor)
      await supabase
        .from('liabilities')
        .update({
          current_balance_minor: newBalance,
          balance_source: 'calculated',
          balance_effective_date: i.date,
          ...(newBalance === 0 ? { status: 'settled' } : {}),
        })
        .eq('id', i.liability_id)
      return {
        summary: `Recorded ${fmt(i.amount_minor)} ${i.kind} against ${prev.name}. Calculated balance is now ${fmt(newBalance)}${newBalance === 0 ? ' — settled 🎉' : ''}.`,
        result: { new_balance_minor: newBalance },
        undoData: {
          table: 'debt_payments',
          id: payment.id,
          // Undo also needs the balance restored — handled via liabilities previous
        },
        undoable: true,
      }
    }
    case 'create_category': {
      const i = input as z.infer<(typeof actionSchemas)['create_category']>
      const { data: cats } = await supabase.from('categories').select('id,name,parent_id').eq('is_archived', false)
      const all = (cats ?? []) as { id: string; name: string; parent_id: string | null }[]
      let parentId: string | null = null
      let parentName: string | null = null
      if (i.parent_name) {
        let parent = all.find((c) => !c.parent_id && c.name.toLowerCase() === i.parent_name!.toLowerCase())
        if (!parent) {
          const { data: created, error } = await supabase
            .from('categories')
            .insert({ user_id: userId, name: i.parent_name, kind: 'expense' })
            .select('id,name,parent_id')
            .single()
          if (error) throw new Error(error.message)
          parent = created as typeof parent
        }
        parentId = parent!.id
        parentName = parent!.name
      }
      const existing = all.find(
        (c) => c.name.toLowerCase() === i.name.toLowerCase() && (c.parent_id ?? null) === parentId,
      )
      if (existing) {
        return {
          summary: `Category ${parentName ? `${parentName} → ` : ''}${existing.name} already exists`,
          undoData: null,
          undoable: false,
        }
      }
      const { data, error } = await supabase
        .from('categories')
        .insert({ user_id: userId, name: i.name, parent_id: parentId, kind: 'expense' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Created category ${parentName ? `${parentName} → ` : ''}${i.name}`,
        undoData: { table: 'categories', id: data.id },
        undoable: true,
      }
    }
    case 'update_category': {
      const i = input as z.infer<(typeof actionSchemas)['update_category']>
      const { data: cats } = await supabase.from('categories').select('id,name,parent_id').eq('is_archived', false)
      const all = (cats ?? []) as { id: string; name: string; parent_id: string | null }[]
      const matches = all.filter((c) => c.name.toLowerCase() === i.category_name.toLowerCase())
      // Prefer a top-level match when the name is ambiguous
      const target = matches.find((c) => !c.parent_id) ?? matches[0]
      if (!target) throw new Error(`Category "${i.category_name}" not found`)
      const patch: Record<string, unknown> = {}
      if (i.new_name) patch.name = i.new_name
      if (i.make_top_level) patch.parent_id = null
      else if (i.new_parent_name) {
        let parent = all.find((c) => !c.parent_id && c.name.toLowerCase() === i.new_parent_name!.toLowerCase())
        if (!parent) {
          const { data: created, error } = await supabase
            .from('categories')
            .insert({ user_id: userId, name: i.new_parent_name, kind: 'expense' })
            .select('id,name,parent_id')
            .single()
          if (error) throw new Error(error.message)
          parent = created as typeof parent
        }
        if (parent!.id === target.id) throw new Error('A category cannot be its own parent')
        patch.parent_id = parent!.id
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change — give a new name or a new parent')
      const { error } = await supabase.from('categories').update(patch).eq('id', target.id)
      if (error) throw new Error(error.message)
      return {
        summary: `Updated category ${target.name}${i.new_name ? ` → renamed to ${i.new_name}` : ''}${i.new_parent_name && !i.make_top_level ? `, now under ${i.new_parent_name}` : ''}${i.make_top_level ? ', now top-level' : ''}`,
        undoData: { table: 'categories', id: target.id, previous: { name: target.name, parent_id: target.parent_id } },
        undoable: true,
      }
    }
    case 'create_merchant_rule': {
      const i = input as z.infer<(typeof actionSchemas)['create_merchant_rule']>
      // Resolve category by name (and optional subcategory)
      let categoryId: string | null = null
      if (i.category_name) {
        const { data: cats } = await supabase.from('categories').select('*').eq('is_archived', false)
        const all = (cats ?? []) as { id: string; name: string; parent_id: string | null }[]
        let parent = all.find(
          (c) => !c.parent_id && c.name.toLowerCase() === i.category_name!.toLowerCase(),
        )
        // The named category not existing is not a reason to fail — create it.
        if (!parent) {
          const { data: created } = await supabase
            .from('categories')
            .insert({ user_id: userId, name: i.category_name, kind: 'expense' })
            .select('id,name,parent_id')
            .single()
          parent = (created as typeof parent) ?? undefined
        }
        if (i.subcategory_name) {
          let sub = all.find(
            (c) =>
              c.name.toLowerCase() === i.subcategory_name!.toLowerCase() &&
              (!parent || c.parent_id === parent.id),
          )
          if (!sub && parent) {
            const { data: created } = await supabase
              .from('categories')
              .insert({ user_id: userId, name: i.subcategory_name, parent_id: parent.id })
              .select('id,name,parent_id')
              .single()
            sub = created as typeof sub
          }
          categoryId = sub?.id ?? parent?.id ?? null
        } else {
          categoryId = parent?.id ?? null
        }
      }
      // Merchant
      const { data: existingMerchant } = await supabase
        .from('merchants')
        .select('id,name')
        .ilike('name', i.merchant_name)
        .maybeSingle()
      let merchantId = (existingMerchant as { id: string } | null)?.id
      if (!merchantId) {
        const { data: m, error } = await supabase
          .from('merchants')
          .insert({ user_id: userId, name: i.merchant_name, default_category_id: categoryId })
          .select('id')
          .single()
        if (error) throw new Error(error.message)
        merchantId = m.id
      }
      // Aliases + rules
      let ruleId: string | undefined
      for (const pattern of i.alias_patterns) {
        await supabase
          .from('merchant_aliases')
          .upsert(
            { user_id: userId, merchant_id: merchantId, alias: pattern.toUpperCase() },
            { onConflict: 'user_id,alias' },
          )
        const { data: rule } = await supabase
          .from('categorisation_rules')
          .insert({
            user_id: userId,
            matcher: pattern.toUpperCase(),
            match_type: 'contains',
            merchant_id: merchantId,
            category_id: categoryId,
            source: 'ai_chat',
          })
          .select('id')
          .single()
        ruleId = ruleId ?? (rule as { id: string } | null)?.id
      }
      // Apply to past — matches either the raw description or the stored
      // merchant name, so bulk fixes work on already-categorised rows too.
      let updated = 0
      if (i.apply_to_past) {
        for (const pattern of i.alias_patterns) {
          const { data: rows } = await supabase
            .from('transactions')
            .update({ merchant_id: merchantId, merchant_name: i.merchant_name, ...(categoryId ? { category_id: categoryId } : {}) })
            .or(`description.ilike.%${pattern}%,merchant_name.ilike.%${pattern}%`)
            .select('id')
          updated += rows?.length ?? 0
        }
      }
      const catLabel = i.subcategory_name
        ? `${i.category_name} → ${i.subcategory_name}`
        : (i.category_name ?? 'no category')
      return {
        summary: `Future ${i.merchant_name} payments will be categorised as ${catLabel}${updated > 0 ? `; ${updated} past transaction(s) updated` : ''}`,
        undoData: { table: 'categorisation_rules', id: ruleId },
        undoable: true,
      }
    }
    case 'create_recurring_payment': {
      const i = input as z.infer<(typeof actionSchemas)['create_recurring_payment']>
      const { data, error } = await supabase
        .from('recurring_payments')
        .insert({ ...i, user_id: userId, source: 'ai_chat' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Added ${i.frequency.replace('_', '-')} ${i.kind} "${i.name}" at ${fmt(i.amount_minor)}, next due ${i.next_due_date}`,
        undoData: { table: 'recurring_payments', id: data.id },
        undoable: true,
      }
    }
    case 'update_budget': {
      const i = input as z.infer<(typeof actionSchemas)['update_budget']>
      const month = `${i.month.slice(0, 7)}-01`
      let { data: budget } = await supabase.from('budgets').select('id').eq('month', month).maybeSingle()
      if (!budget) {
        const { data: created, error } = await supabase
          .from('budgets')
          .insert({ user_id: userId, month, expected_income_minor: i.expected_income_minor ?? 0 })
          .select('id')
          .single()
        if (error) throw new Error(error.message)
        budget = created
      } else if (i.expected_income_minor != null) {
        await supabase.from('budgets').update({ expected_income_minor: i.expected_income_minor }).eq('id', budget.id)
      }
      let categoryId: string | null = null
      if (i.category_name) {
        const { data: cat } = await supabase
          .from('categories')
          .select('id')
          .ilike('name', i.category_name)
          .limit(1)
          .maybeSingle()
        categoryId = (cat as { id: string } | null)?.id ?? null
        if (!categoryId) throw new Error(`Category "${i.category_name}" not found`)
      }
      const { error } = await supabase.from('budget_lines').upsert(
        {
          user_id: userId,
          budget_id: budget.id,
          category_id: categoryId,
          kind: i.kind,
          label: categoryId ? null : (i.category_name ?? 'One-off'),
          planned_minor: i.planned_minor,
        },
        { onConflict: 'budget_id,category_id,kind,label' },
      )
      if (error) throw new Error(error.message)
      return {
        summary: `Budget for ${i.category_name ?? 'income'} in ${i.month.slice(0, 7)} set to ${fmt(i.planned_minor)}`,
        undoData: { table: 'budgets', id: budget.id },
        undoable: false,
      }
    }
    case 'create_savings_goal': {
      const i = input as z.infer<(typeof actionSchemas)['create_savings_goal']>
      const { data, error } = await supabase
        .from('savings_goals')
        .insert({ ...i, user_id: userId })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Created savings goal "${i.name}" — target ${fmt(i.target_minor)}`,
        undoData: { table: 'savings_goals', id: data.id },
        undoable: true,
      }
    }
    case 'create_financial_fact': {
      const i = input as z.infer<(typeof actionSchemas)['create_financial_fact']>
      const { data, error } = await supabase
        .from('financial_facts')
        .insert({ ...i, user_id: userId, source: 'user_chat' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return {
        summary: `Remembered: ${i.fact_key} = ${JSON.stringify(i.value)}`,
        undoData: { table: 'financial_facts', id: data.id },
        undoable: true,
      }
    }
    case 'find_transactions': {
      const i = input as z.infer<(typeof actionSchemas)['find_transactions']>
      // Aggregates must cover EVERY matching row, not just the page shown —
      // a total computed over a truncated page is a confidently wrong answer.
      // Page through the full match set (bounded), aggregate over all of it,
      // and return only `limit` rows of detail.
      let categoryIds: string[] | null = null
      if (i.category_name) {
        const { data: cats } = await supabase.from('categories').select('id,name,parent_id')
        const all = (cats ?? []) as { id: string; name: string; parent_id: string | null }[]
        const hit = all.find((c) => c.name.toLowerCase() === i.category_name!.toLowerCase())
          ?? all.find((c) => c.name.toLowerCase().includes(i.category_name!.toLowerCase()))
        if (hit) {
          // A parent category includes all its subcategories.
          categoryIds = [hit.id, ...all.filter((c) => c.parent_id === hit.id).map((c) => c.id)]
        }
      }
      type Row = {
        id: string; date: string; description: string; merchant_name: string | null
        amount_minor: number; category_id: string | null; is_transfer: boolean
      }
      const rows: Row[] = []
      const PAGE = 1000
      const MAX_ROWS = 8000
      for (let fromIdx = 0; fromIdx < MAX_ROWS; fromIdx += PAGE) {
        let q = supabase
          .from('transactions')
          .select('id,date,description,merchant_name,amount_minor,category_id,is_transfer')
          .order('date', { ascending: false })
          .range(fromIdx, fromIdx + PAGE - 1)
        if (i.from) q = q.gte('date', i.from)
        if (i.to) q = q.lte('date', i.to)
        const term = i.search ?? i.merchant
        if (term) q = q.or(`description.ilike.%${term}%,merchant_name.ilike.%${term}%`)
        if (categoryIds) q = q.in('category_id', categoryIds)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        const page = (data ?? []) as Row[]
        rows.push(...page)
        if (page.length < PAGE) break
      }
      const truncated = rows.length >= MAX_ROWS
      const spend = rows.filter((r) => r.amount_minor < 0 && !r.is_transfer)
      const income = rows.filter((r) => r.amount_minor > 0 && !r.is_transfer)
      const totalSpent = spend.reduce((a, r) => a + -r.amount_minor, 0)
      const byMonth = new Map<string, { spent: number; count: number }>()
      for (const r of spend) {
        const m = r.date.slice(0, 7)
        const cur = byMonth.get(m) ?? { spent: 0, count: 0 }
        cur.spent += -r.amount_minor
        cur.count += 1
        byMonth.set(m, cur)
      }
      return {
        summary: `Found ${rows.length} transactions`,
        result: {
          transactions: rows.slice(0, i.limit),
          detail_rows_shown: Math.min(rows.length, i.limit),
          // Aggregates below cover ALL matching transactions, not just the
          // detail rows above.
          match_count: rows.length,
          spend_count: spend.length,
          total_spent_minor: totalSpent,
          total_income_minor: income.reduce((a, r) => a + r.amount_minor, 0),
          average_spend_minor: spend.length ? Math.round(totalSpent / spend.length) : 0,
          monthly_spend: [...byMonth.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([month, v]) => ({ month, spent_minor: v.spent, transactions: v.count })),
          ...(truncated
            ? { warning: 'Match set exceeded 8000 rows; aggregates cover only the newest 8000. Narrow the date range for exact totals.' }
            : {}),
        },
        undoData: null,
        undoable: false,
      }
    }
  }
}

// ----------------------------------------------------------- pay periods
// The user's real month runs payday to payday (profiles.payday_day, rolled
// back to the Friday before when it lands on a weekend). Mirrors
// src/lib/engine/payperiod.ts.
function actualPayday(year: number, month1: number, paydayDay: number): string {
  const dim = new Date(Date.UTC(year, month1, 0)).getUTCDate()
  const d = new Date(Date.UTC(year, month1 - 1, Math.min(paydayDay, dim)))
  const dow = d.getUTCDay()
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1)
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2)
  return d.toISOString().slice(0, 10)
}

function payPeriodFor(dateIso: string, paydayDay: number | null): { start: string; end: string; nextPayday: string; days: number } {
  if (!paydayDay) {
    const y = Number(dateIso.slice(0, 4))
    const m = Number(dateIso.slice(5, 7))
    const start = `${dateIso.slice(0, 7)}-01`
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    const end = new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    return { start, end, nextPayday: next, days: Math.round((Date.parse(next) - Date.parse(start)) / 86_400_000) }
  }
  const y = Number(dateIso.slice(0, 4))
  const m = Number(dateIso.slice(5, 7))
  const candidates: string[] = []
  for (const delta of [-2, -1, 0, 1]) {
    const total = y * 12 + (m - 1) + delta
    candidates.push(actualPayday(Math.floor(total / 12), (total % 12) + 1, paydayDay))
  }
  const start = candidates.filter((c) => c <= dateIso).sort().pop()!
  const nextPayday = candidates.find((c) => c > start)!
  const end = new Date(Date.parse(`${nextPayday}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  return { start, end, nextPayday, days: Math.round((Date.parse(nextPayday) - Date.parse(start)) / 86_400_000) }
}

// --------------------------------------------------------------- context
async function buildContext(ctx: AuthedContext): Promise<string> {
  const { supabase } = ctx
  const today = new Date().toISOString().slice(0, 10)
  const historyFrom = (() => {
    const d = new Date()
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 4, 1)).toISOString().slice(0, 10)
  })()

  const [accounts, categories, liabilities, recurring, facts, goals, profileRow, nwSnap, history] = await Promise.all([
    supabase.from('accounts').select('id,name,provider,account_type,balance_minor,balance_updated_at').is('archived_at', null),
    supabase.from('categories').select('id,name,parent_id').eq('is_archived', false),
    supabase.from('liabilities').select('id,name,provider,liability_type,current_balance_minor,apr,monthly_payment_minor,balance_source,balance_effective_date').neq('status', 'archived'),
    supabase.from('recurring_payments').select('id,name,kind,amount_minor,frequency,next_due_date,status,is_essential,liability_id'),
    supabase.from('financial_facts').select('fact_type,fact_key,value,confidence').eq('is_active', true).limit(50),
    supabase.from('savings_goals').select('id,name,target_minor,current_minor').neq('status', 'archived'),
    supabase.from('profiles').select('payday_day').maybeSingle(),
    supabase.from('net_worth_snapshots').select('date,assets_minor,liabilities_minor,net_worth_minor').order('date', { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from('transactions')
      .select('account_id,date,amount_minor,is_transfer,exclude_from_budget,is_reimbursable,recurring_payment_id,is_one_off,running_balance_minor,description')
      .gte('date', historyFrom)
      .limit(6000),
  ])

  const paydayDay = ((profileRow.data as { payday_day: number | null } | null)?.payday_day) ?? null
  const period = payPeriodFor(today, paydayDay)
  // The budget row is keyed to the month the period pays for (period ending
  // 24 Aug → the August budget).
  const budgetMonth = `${period.end.slice(0, 7)}-01`
  const budget = await supabase.from('budgets').select('*, budget_lines(*)').eq('month', budgetMonth).maybeSingle()

  const cats = (categories.data ?? []) as { id: string; name: string; parent_id: string | null }[]
  const catLines = cats
    .filter((c) => !c.parent_id)
    .map((p) => {
      const children = cats.filter((c) => c.parent_id === p.id)
      return `- ${p.name} (${p.id})${children.length ? ': ' + children.map((c) => `${c.name} (${c.id})`).join(', ') : ''}`
    })
    .join('\n')

  // ---- Engine-computed pay-period position + forecast (deterministic, same
  // definitions as the app: everyday spend excludes transfers, bills,
  // reimbursable, excluded and one-off rows; baseline = median of the last
  // three COMPLETE pay periods).
  type H = {
    account_id: string; date: string; amount_minor: number; is_transfer: boolean
    exclude_from_budget: boolean; is_reimbursable: boolean
    recurring_payment_id: string | null; is_one_off: boolean
    running_balance_minor: number | null; description: string
  }
  const hist = (history.data ?? []) as H[]
  const isEveryday = (t: H) =>
    t.amount_minor < 0 && !t.is_transfer && !t.exclude_from_budget && !t.is_reimbursable &&
    !t.recurring_payment_id && !t.is_one_off
  // Prior three complete pay periods, walked back from the current one.
  const priorPeriods: { start: string; end: string; days: number }[] = []
  let cursor = period
  for (let i = 0; i < 3; i++) {
    const prevEnd = new Date(Date.parse(`${cursor.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    cursor = payPeriodFor(prevEnd, paydayDay)
    priorPeriods.push(cursor)
  }
  const periodTotals = priorPeriods
    .map((p) => hist.filter((t) => isEveryday(t) && t.date >= p.start && t.date <= p.end).reduce((s, t) => s + -t.amount_minor, 0))
    .filter((v) => v > 0)
  const sortedTotals = [...periodTotals].sort((a, b) => a - b)
  const baselinePeriodMinor = sortedTotals.length === 0 ? 0
    : sortedTotals.length % 2 === 1 ? sortedTotals[Math.floor(sortedTotals.length / 2)]
    : Math.round((sortedTotals[sortedTotals.length / 2 - 1] + sortedTotals[sortedTotals.length / 2]) / 2)
  const avgPriorDays = priorPeriods.reduce((s, p) => s + p.days, 0) / Math.max(1, priorPeriods.length)
  const baselinePerDay = Math.round(baselinePeriodMinor / Math.max(1, avgPriorDays))

  let incomePeriod = 0, everydayPeriod = 0, billsPeriod = 0
  for (const t of hist) {
    if (t.date < period.start || t.is_transfer || t.exclude_from_budget || t.is_reimbursable) continue
    if (t.amount_minor > 0) incomePeriod += t.amount_minor
    else if (t.recurring_payment_id) billsPeriod += -t.amount_minor
    else everydayPeriod += -t.amount_minor
  }
  const dayOfPeriod = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000) + 1
  const daysRemaining = Math.max(0, period.days - dayOfPeriod)
  const rps = (recurring.data ?? []) as { name: string; kind: string; amount_minor: number; frequency: string; next_due_date: string; status: string; is_essential: boolean }[]
  const billsRemaining = rps
    .filter((r) => r.status === 'active' && r.amount_minor < 0 && r.next_due_date > today && r.next_due_date <= period.end)
    .reduce((s, r) => s + -r.amount_minor, 0)
  const cash = ((accounts.data ?? []) as { account_type: string; balance_minor: number }[])
    .filter((a) => ['current', 'cash', 'wallet'].includes(a.account_type))
    .reduce((s, a) => s + a.balance_minor, 0)
  const projectedEnd = cash - baselinePerDay * daysRemaining - billsRemaining

  // ---- Overdraft state from the busiest current account's running balances
  const currentIds = ((accounts.data ?? []) as { id: string; account_type: string }[])
    .filter((a) => a.account_type === 'current').map((a) => a.id)
  const byAccount = new Map<string, H[]>()
  for (const t of hist) {
    if (!currentIds.includes(t.account_id) || t.running_balance_minor === null) continue
    byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t])
  }
  const odTxns = [...byAccount.values()].sort((a, b) => b.length - a.length)[0] ?? []
  const odThisPeriod = odTxns.filter((t) => t.date >= period.start)
  const overdrawnNow = odThisPeriod.length > 0 &&
    odThisPeriod.sort((a, b) => a.date.localeCompare(b.date))[odThisPeriod.length - 1].running_balance_minor! < 0
  const odInterestYtd = hist
    .filter((t) => t.amount_minor < 0 && /\bOD\s*INT|OVERDRAFT\s*INT/i.test(t.description))
    .reduce((s, t) => s + -t.amount_minor, 0)

  // ---- Commitments (monthly equivalents)
  const perMonthFactor: Record<string, number> = {
    weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, four_weekly: 13 / 12,
    quarterly: 1 / 3, six_monthly: 1 / 6, annual: 1 / 12, custom: 1,
  }
  const activeOut = rps.filter((r) => r.status === 'active' && r.amount_minor < 0)
  const commitTotal = activeOut.reduce((s, r) => s + Math.abs(r.amount_minor) * (perMonthFactor[r.frequency] ?? 1), 0)
  const cuttable = activeOut.filter((r) => !r.is_essential)
  const cuttableTotal = cuttable.reduce((s, r) => s + Math.abs(r.amount_minor) * (perMonthFactor[r.frequency] ?? 1), 0)

  const b = budget.data as { expected_income_minor: number; budget_lines: { category_id: string | null; kind: string; planned_minor: number }[] } | null

  return [
    `Today's date: ${today}`,
    `\nACCOUNTS:\n${JSON.stringify(accounts.data ?? [], null, 0)}`,
    `\nDEBTS:\n${JSON.stringify(liabilities.data ?? [], null, 0)}`,
    `\nNET WORTH (latest snapshot): ${JSON.stringify(nwSnap.data ?? null)}`,
    `\nRECURRING PAYMENTS:\n${JSON.stringify(recurring.data ?? [], null, 0)}`,
    `\nCOMMITMENTS SUMMARY: total ~${Math.round(commitTotal)} minor/month across ${activeOut.length} active outgoings; non-essential (cuttable) ~${Math.round(cuttableTotal)} minor/month: ${cuttable.map((r) => r.name).join(', ') || 'none marked'}`,
    `\nPAY PERIOD POSITION (engine-computed; the user's "month" runs PAYDAY TO PAYDAY — nominal payday day ${paydayDay ?? 'not set, calendar month used'}, rolled to the Friday before when it falls on a weekend): current period ${period.start} to ${period.end}, day ${dayOfPeriod} of ${period.days}; NEXT PAYDAY ${period.nextPayday}; income received this period ${incomePeriod}; bills paid ${billsPeriod}; everyday spend so far ${everydayPeriod}; bills still due before payday ${billsRemaining}; typical everyday spend ${baselinePeriodMinor}/period (~${baselinePerDay}/day, median of last ${periodTotals.length} complete pay periods); cash across current accounts ${cash}; PROJECTED cash at next payday ${projectedEnd} (cash − remaining everyday at typical rate − bills still due). Use these for affordability, "will I run short before payday", and pace questions — do not recompute from partial data, and never frame answers around the calendar month end.`,
    `\nOVERDRAFT: currently ${overdrawnNow ? 'BELOW zero' : 'above zero'} on the main current account; overdraft interest paid since ${historyFrom}: ${odInterestYtd} minor.`,
    `\nBUDGET THIS PERIOD (stored as the ${budgetMonth.slice(0, 7)} budget): ${b ? JSON.stringify({ expected_income_minor: b.expected_income_minor, lines: b.budget_lines }) : 'none set'}`,
    `\nSAVINGS GOALS:\n${JSON.stringify(goals.data ?? [], null, 0)}`,
    `\nREMEMBERED FACTS:\n${JSON.stringify(facts.data ?? [], null, 0)}`,
    `\nCATEGORIES (name (uuid)):\n${catLines}`,
  ].join('\n')
}

const SYSTEM_PROMPT = `You are the financial assistant inside My Money, a private personal finance app. All amounts are integer pence ("minor units"); £49 = 4900.

Core rules:
- NEVER invent financial numbers. To answer spending questions, ALWAYS call find_transactions and use its computed totals. The app's deterministic engine owns all calculations.
- For direct, explicit user statements ("that payment is my monthly gym membership", "I still owe £500 on PayPal", "I paid an extra £100 off my loan"), perform the action immediately, then confirm what was saved, where, and any assumptions made. Undo is available for your actions.
- For inferred conclusions (you suspect something is recurring, you're unsure which account/debt is meant), ask for confirmation first instead of acting.
- When the user states a debt balance, create or update a structured liability record — never leave it as conversation only. Balances you record this way are "user-stated"; calculated balances are estimates, and lender settlement figures may differ — say so when relevant.
- When the user teaches you a merchant meaning, use create_merchant_rule AND create_financial_fact.
- When the user reports a miscategorisation ("Tesco Bank was marked as groceries but it's my loan"), fix it yourself: create_merchant_rule with the right category and apply_to_past=true recategorises the history AND prevents it recurring. Confirm how many transactions were fixed. Never just explain how to do it manually.
- You can create, rename and reorganise categories yourself (create_category, update_category), and create_merchant_rule creates any category it names that doesn't exist. Never send the user to Settings to manage categories — do it, then verify with find_transactions if the user doubts a change stuck.
- When the user attaches a photo, screenshot or PDF, READ IT and work from what it actually shows. Record exactly the items on the document — never pad the list with things you inferred from the ledger, and never treat a document as a bank statement unless it plainly is one. A list of forthcoming direct debits is a list of BILLS to set up with create_recurring_payment; it is not spending that has happened, so never record those as transactions.
- Only propose a recurring payment when the user asked for it or the evidence is strong (a document that lists it, or a clear repeating pattern). One-off or variable card payments to a company are not a direct debit. When unsure, ask — do not list speculative bills as if they were facts.
- When an amount is mentioned without currency, assume GBP.
- Transfers between the user's own accounts are not spending.
- The user's financial month runs PAYDAY TO PAYDAY, not 1st to 31st. The PAY PERIOD POSITION, NET WORTH, OVERDRAFT and COMMITMENTS blocks in your context are engine-computed over the full ledger. Use them directly for affordability questions ("can I afford X?", "will I run short before payday?", "what's my net worth?") instead of estimating, and always talk in terms of the next payday, never the calendar month end. find_transactions aggregates (totals, counts, monthly breakdown) cover EVERY matching row even when the detail list is shorter — quote the aggregates. If its result carries a warning, repeat that caveat.
- A debt whose balance_source is "estimated" with balance 0 has not had its real balance entered yet — say so when it affects an answer, and suggest setting the balance or uploading the agreement.
- You give factual information and options with their maths — never a personal recommendation of a specific financial product, and never individualised instructions to settle a specific credit agreement. If arrears or unaffordable debt come up, mention that free guidance exists (MoneyHelper, StepChange).
- Be concise and factual. Use British English and £. Never moralise about ordinary spending — deliberate spending on things the user values is a choice, not a failure. The only spending concern worth raising is funding: whether it deepens the overdraft or is covered.
- If data is missing (no matching account, no transactions), say so plainly rather than guessing.`

// ------------------------------------------------------------------ main
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const auth = await requireUser(req)
  if (auth instanceof Response) return auth
  const ctx = auth

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 503)

  let body: { conversation_id?: string; message?: string; document_ids?: string[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const conversationId = body.conversation_id
  const userMessage = (body.message ?? '').trim().slice(0, 4000)
  if (!conversationId || !userMessage) {
    return json({ error: 'conversation_id and message are required' }, 400)
  }

  // Persist the user message first so nothing is lost on failure
  const { data: userMsg, error: umErr } = await ctx.supabase
    .from('chat_messages')
    .insert({ user_id: ctx.userId, conversation_id: conversationId, role: 'user', content: userMessage })
    .select('id')
    .single()
  if (umErr) return json({ error: umErr.message }, 400)

  // Conversation history (last 12 messages — enough for continuity, bounded cost)
  const { data: history } = await ctx.supabase
    .from('chat_messages')
    .select('role,content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(12)

  const anthropic = new Anthropic({ apiKey })
  const contextBlock = await buildContext(ctx)

  // Attached photos/PDFs are given to the assistant directly so it can read
  // what the document actually says instead of inferring from the ledger.
  const attachments: Anthropic.Beta.BetaContentBlockParam[] = []
  for (const docId of (body.document_ids ?? []).slice(0, 4)) {
    const { data: doc } = await ctx.supabase
      .from('documents')
      .select('storage_path,mime_type')
      .eq('id', docId)
      .single()
    if (!doc) continue
    const { data: file } = await ctx.supabase.storage
      .from('documents')
      .download((doc as { storage_path: string }).storage_path)
    if (!file) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > 8 * 1024 * 1024) continue
    let b64 = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    b64 = btoa(b64)
    const mime = (doc as { mime_type: string }).mime_type
    attachments.push(
      mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: mime as 'image/png' | 'image/jpeg', data: b64 } },
    )
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...((history ?? []) as { role: 'user' | 'assistant'; content: string }[])
      .reverse()
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      // Cache breakpoint: iterations 2-8 of the tool loop reuse this whole
      // prefix (system + tools + context) at ~10% of the input price.
      content: [
        ...attachments,
        {
          type: 'text',
          text: `${contextBlock}\n\nUSER MESSAGE:\n${userMessage}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ]

  const executedActions: {
    action_type: string
    summary: string
    ai_action_id?: string
    undoable?: boolean
  }[] = []
  let finalText = ''

  try {
    // Manual tool loop, max 8 iterations. Prompt caching keeps the repeated
    // system + tools + context prefix cheap across iterations.
    for (let iteration = 0; iteration < 8; iteration++) {
      const response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 4096,
        // Medium effort: enough reasoning to pick the right action and read
        // ledger numbers correctly, without paying for deep deliberation.
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS.map((t, idx) =>
          idx === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t,
        ),
        messages,
      } as Anthropic.Beta.MessageCreateParamsNonStreaming)

      if (response.stop_reason === 'refusal') {
        finalText = 'I can’t help with that request.'
        break
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      )
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text',
      )
      if (textBlocks.length > 0) finalText = textBlocks.map((b) => b.text).join('\n')

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') break

      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const tu of toolUses) {
        try {
          const result = await executeAction(ctx, tu.name as ActionType, tu.input)
          // Record the action + audit trail
          const { data: actionRow } = await ctx.supabase
            .from('ai_actions')
            .insert({
              user_id: ctx.userId,
              chat_message_id: userMsg.id,
              action_type: tu.name,
              payload: tu.input,
              result: { summary: result.summary, ...(result.result ? { data: result.result } : {}) },
              status: 'executed',
              undo_data: result.undoData,
            })
            .select('id')
            .single()
          if (tu.name !== 'find_transactions') {
            await recordAudit(ctx, {
              recordType: result.undoData?.table ?? tu.name,
              recordId: result.undoData?.id ?? null,
              action: 'insert',
              next: tu.input,
              aiActionId: actionRow?.id,
              chatMessageId: userMsg.id,
              undoable: result.undoable,
            })
            executedActions.push({
              action_type: tu.name,
              summary: result.summary,
              ai_action_id: actionRow?.id,
              undoable: result.undoable,
            })
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ ok: true, summary: result.summary, ...(result.result ? { data: result.result } : {}) }),
          })
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Action failed'
          await ctx.supabase.from('ai_actions').insert({
            user_id: ctx.userId,
            chat_message_id: userMsg.id,
            action_type: tu.name,
            payload: tu.input,
            result: { error: message },
            status: 'failed',
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ ok: false, error: message }),
            is_error: true,
          })
        }
      }
      messages.push({ role: 'user', content: toolResults })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'AI request failed'
    finalText = finalText || `Sorry — the AI request failed (${message}). Your message was saved; try again.`
  }

  if (!finalText) finalText = 'Done.'

  const { data: assistantMsg } = await ctx.supabase
    .from('chat_messages')
    .insert({
      user_id: ctx.userId,
      conversation_id: conversationId,
      role: 'assistant',
      content: finalText,
      actions: executedActions,
    })
    .select('id')
    .single()

  await ctx.supabase
    .from('chat_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  return json({
    message_id: assistantMsg?.id,
    content: finalText,
    actions: executedActions,
  })
})
