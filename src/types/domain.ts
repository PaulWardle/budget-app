// Hand-written row types mirroring supabase/migrations. Regenerate richer
// types once a project is linked: `supabase gen types typescript --linked`.

export type AccountType =
  | 'current' | 'savings' | 'credit_card' | 'wallet' | 'cash'
  | 'loan' | 'vehicle_finance' | 'mortgage'
  | 'investment' | 'pension' | 'property' | 'vehicle'
  | 'other_asset' | 'other_liability'

export const LIABILITY_ACCOUNT_TYPES: AccountType[] = [
  'credit_card', 'loan', 'vehicle_finance', 'mortgage', 'other_liability',
]
export const LIQUID_ACCOUNT_TYPES: AccountType[] = [
  'current', 'savings', 'cash', 'wallet', 'credit_card',
]

export interface Profile {
  id: string
  display_name: string | null
  currency: string
  payday_day: number | null
  document_retention: 'keep' | 'delete' | 'ask'
  theme: 'light' | 'dark' | 'system'
}

export interface Account {
  id: string
  user_id: string
  name: string
  provider: string | null
  account_type: AccountType
  balance_minor: number
  currency: string
  credit_limit_minor: number | null
  include_in_cashflow: boolean
  include_in_net_worth: boolean
  is_liquid: boolean
  archived_at: string | null
  balance_updated_at: string
  balance_source: 'manual' | 'import' | 'ai_chat' | 'calculated'
  notes: string | null
  sort: number
}

export interface BalanceSnapshot {
  id: string
  account_id: string
  balance_minor: number
  recorded_at: string
  source: string
}

export interface Category {
  id: string
  parent_id: string | null
  name: string
  kind: 'expense' | 'income' | 'transfer'
  icon: string | null
  is_archived: boolean
  sort: number
}

export interface Merchant {
  id: string
  name: string
  default_category_id: string | null
  notes: string | null
}

export interface MerchantAlias {
  id: string
  merchant_id: string
  alias: string
}

export interface CategorisationRule {
  id: string
  matcher: string
  match_type: 'contains' | 'exact' | 'starts_with'
  merchant_id: string | null
  category_id: string | null
  priority: number
  is_active: boolean
  source: string
}

export interface TransactionSplit {
  id: string
  transaction_id: string
  category_id: string | null
  amount_minor: number
  note: string | null
}

export interface Transaction {
  id: string
  account_id: string
  date: string
  posted_time: string | null
  description: string
  merchant_id: string | null
  merchant_name: string | null
  category_id: string | null
  amount_minor: number
  currency: string
  running_balance_minor: number | null
  reference: string | null
  payment_method: string | null
  is_transfer: boolean
  transfer_pair_id: string | null
  is_reimbursable: boolean
  exclude_from_budget: boolean
  exclude_from_analytics: boolean
  notes: string | null
  tags: string[]
  import_batch_id: string | null
  recurring_payment_id: string | null
  liability_id: string | null
  confidence: number | null
  needs_review: boolean
  dedupe_ignored: boolean
  /** Unusual spend: counted in the month, but ignored when measuring what's typical. */
  is_one_off: boolean
  source: string
  transaction_splits?: TransactionSplit[]
}

export interface Budget {
  id: string
  month: string
  expected_income_minor: number
  rollover_enabled: boolean
  notes: string | null
}

export type BudgetLineKind =
  | 'income' | 'fixed' | 'variable' | 'discretionary' | 'debt' | 'savings' | 'one_off'

export interface BudgetLine {
  id: string
  budget_id: string
  category_id: string | null
  kind: BudgetLineKind
  label: string | null
  planned_minor: number
  rollover_from_minor: number
  note: string | null
}

export type Frequency =
  | 'weekly' | 'fortnightly' | 'monthly' | 'four_weekly' | 'quarterly'
  | 'six_monthly' | 'annual' | 'custom'

export interface RecurringPayment {
  id: string
  name: string
  kind: 'bill' | 'subscription' | 'income' | 'debt_payment' | 'savings' | 'transfer'
  merchant_id: string | null
  category_id: string | null
  account_id: string | null
  liability_id: string | null
  amount_minor: number
  frequency: Frequency
  interval_days: number | null
  next_due_date: string
  day_of_month: number | null
  start_date: string | null
  renewal_date: string | null
  contract_end_date: string | null
  status: 'active' | 'paused' | 'cancelled'
  is_essential: boolean
  price_history: { date: string; amount_minor: number }[]
  needs_confirmation: boolean
  confidence: number | null
  source: string
  notes: string | null
}

export type LiabilityType =
  | 'personal_loan' | 'credit_card' | 'paypal_credit' | 'vehicle_finance'
  | 'hire_purchase' | 'pcp' | 'mortgage' | 'informal' | 'other'

export interface Liability {
  id: string
  account_id: string | null
  name: string
  provider: string | null
  liability_type: LiabilityType
  original_balance_minor: number | null
  current_balance_minor: number
  balance_effective_date: string
  balance_source: 'user_stated' | 'calculated' | 'lender_confirmed' | 'imported' | 'estimated'
  apr: number | null
  rate_type: 'fixed' | 'variable' | 'unknown' | null
  monthly_payment_minor: number | null
  payment_day: number | null
  start_date: string | null
  term_months: number | null
  remaining_payments: number | null
  final_payment_minor: number | null
  balloon_minor: number | null
  fees_minor: number
  settlement_quote_minor: number | null
  settlement_quote_expiry: string | null
  overpayment_rule: 'reduce_term' | 'reduce_payment' | 'unknown'
  early_repayment_terms: string | null
  agreement_ref: string | null
  status: 'active' | 'settled' | 'archived'
  notes: string | null
}

export interface DebtPayment {
  id: string
  liability_id: string
  transaction_id: string | null
  date: string
  amount_minor: number
  kind: 'scheduled' | 'overpayment' | 'missed' | 'fee' | 'interest' | 'adjustment'
  note: string | null
  source: string
}

export interface LoanScheduleRow {
  id: string
  liability_id: string
  schedule_type: 'original' | 'revised'
  payment_number: number
  due_date: string
  payment_minor: number
  principal_minor: number
  interest_minor: number
  balance_after_minor: number
}

export interface NetWorthSnapshot {
  id: string
  date: string
  assets_minor: number
  liabilities_minor: number
  net_worth_minor: number
  liquid_assets_minor: number
  liquid_liabilities_minor: number
}

export interface SavingsGoal {
  id: string
  name: string
  kind: 'general' | 'emergency_fund' | 'goal' | 'sinking_fund' | 'purchase' | 'debt_pot'
  target_minor: number
  current_minor: number
  target_date: string | null
  monthly_planned_minor: number
  linked_account_id: string | null
  priority: number
  status: 'active' | 'achieved' | 'paused' | 'archived'
  notes: string | null
}

export interface FinancialFact {
  id: string
  fact_type: string
  fact_key: string
  value: Record<string, unknown>
  effective_date: string
  source: string
  confidence: 'confirmed' | 'likely' | 'uncertain'
  last_confirmed_at: string
  affects_calculations: boolean
  is_active: boolean
}

export interface DocumentRow {
  id: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  kind: 'statement' | 'contract' | 'receipt' | 'other'
  status: 'stored' | 'deleted'
  uploaded_at: string
}

export interface ImportBatch {
  id: string
  account_id: string | null
  document_id: string | null
  source_type: 'screenshot' | 'pdf' | 'csv' | 'manual'
  file_name: string | null
  status: 'pending' | 'processing' | 'review' | 'completed' | 'failed' | 'undone'
  error: string | null
  ai_model: string | null
  stats: Record<string, number>
  created_at: string
  completed_at: string | null
}

export interface ImportedItem {
  id: string
  batch_id: string
  raw_text: string | null
  extracted: Record<string, unknown>
  proposed_date: string | null
  proposed_description: string | null
  proposed_amount_minor: number | null
  proposed_merchant: string | null
  proposed_category_id: string | null
  running_balance_minor: number | null
  confidence: number | null
  duplicate_of: string | null
  duplicate_score: number | null
  status: 'proposed' | 'confirmed' | 'rejected' | 'duplicate'
  transaction_id: string | null
}

export interface Insight {
  id: string
  insight_type: string
  headline: string
  body: string
  figures: Record<string, unknown>
  comparison_period: string | null
  confidence: 'high' | 'medium' | 'low'
  suggested_action: string | null
  impact_minor: number | null
  severity: 'info' | 'warning' | 'positive'
  status: 'active' | 'dismissed' | 'muted' | 'actioned'
  period_start: string | null
  period_end: string | null
  created_at: string
}

export interface ChatConversation {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  actions: ChatActionSummary[]
  created_at: string
}

export interface ChatActionSummary {
  action_type: string
  summary: string
  ai_action_id?: string
  undoable?: boolean
}

export interface AiAction {
  id: string
  chat_message_id: string | null
  action_type: string
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  status: 'proposed' | 'executed' | 'failed' | 'undone'
  created_at: string
}

export interface AuditEvent {
  id: string
  record_type: string
  record_id: string | null
  action: 'insert' | 'update' | 'delete' | 'undo'
  previous_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  source: string
  undo_status: 'undoable' | 'undone' | 'not_undoable'
  created_at: string
}
