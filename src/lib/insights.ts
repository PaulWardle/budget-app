// Deterministic insight generation. Every figure comes from the ledger; the
// engine only writes an insight when there is sufficient evidence, with a
// dedupe_key so re-running never duplicates. Language stays factual — no
// moralising about ordinary spending.

import { supabase } from '@/lib/supabase'
import { formatMinor } from '@/lib/engine/money'
import type { Category, RecurringPayment, Transaction } from '@/types/domain'

interface Draft {
  insight_type: string
  headline: string
  body: string
  figures: Record<string, unknown>
  comparison_period: string | null
  confidence: 'high' | 'medium' | 'low'
  suggested_action: string | null
  impact_minor: number | null
  severity: 'info' | 'warning' | 'positive'
  dedupe_key: string
  period_start: string
  period_end: string
}

const fmt = (m: number) => formatMinor(Math.abs(m))

function monthKey(iso: string): string {
  return iso.slice(0, 7)
}

/** Generate and persist insights. Returns how many new ones were written. */
export async function generateInsights(
  userId: string,
  txns: Transaction[],
  categories: Category[],
  recurring: RecurringPayment[],
): Promise<number> {
  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const spendTxns = txns.filter(
    (t) => !t.is_transfer && !t.exclude_from_analytics && !t.is_reimbursable && t.amount_minor < 0,
  )
  const drafts: Draft[] = []
  const periodStart = `${thisMonth}-01`
  const periodEnd = now.toISOString().slice(0, 10)

  // --- Merchant spending vs 3-month average -------------------------------
  const byMerchantMonth = new Map<string, Map<string, { total: number; count: number }>>()
  for (const t of spendTxns) {
    const merchant = (t.merchant_name ?? t.description).trim()
    if (!merchant) continue
    const months = byMerchantMonth.get(merchant) ?? new Map()
    const mk = monthKey(t.date)
    const cur = months.get(mk) ?? { total: 0, count: 0 }
    cur.total += -t.amount_minor
    cur.count += 1
    months.set(mk, cur)
    byMerchantMonth.set(merchant, months)
  }
  for (const [merchant, months] of byMerchantMonth) {
    const current = months.get(thisMonth)
    if (!current || current.count < 3) continue
    const prior = [...months.entries()].filter(([k]) => k !== thisMonth).slice(-3)
    if (prior.length < 2) continue
    const avg = prior.reduce((s, [, v]) => s + v.total, 0) / prior.length
    if (current.total > avg * 1.3 && current.total - avg > 2000) {
      drafts.push({
        insight_type: 'merchant_spending',
        headline: `${merchant}: ${fmt(current.total)} this month, ${fmt(current.total - avg)} above your recent average`,
        body: `You spent ${fmt(current.total)} at ${merchant} across ${current.count} transactions this month, compared with a ${prior.length}-month average of ${fmt(Math.round(avg))}.`,
        figures: { current: current.total, average: Math.round(avg), visits: current.count },
        comparison_period: `${prior.length}-month average`,
        confidence: 'high',
        suggested_action: null,
        impact_minor: Math.round(current.total - avg),
        severity: 'info',
        dedupe_key: `merchant_spending:${merchant}:${thisMonth}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }
  }

  // --- Frequent small purchases -------------------------------------------
  for (const [merchant, months] of byMerchantMonth) {
    const current = months.get(thisMonth)
    if (!current) continue
    if (current.count >= 8 && current.total / current.count < 2000) {
      drafts.push({
        insight_type: 'spending_frequency',
        headline: `${current.count} visits to ${merchant} this month`,
        body: `You made ${current.count} separate purchases at ${merchant} this month, averaging ${fmt(Math.round(current.total / current.count))} each (${fmt(current.total)} total). Consolidating trips may reduce convenience purchases, although that isn't guaranteed.`,
        figures: { visits: current.count, total: current.total },
        comparison_period: null,
        confidence: 'medium',
        suggested_action: null,
        impact_minor: null,
        severity: 'info',
        dedupe_key: `spending_frequency:${merchant}:${thisMonth}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }
  }

  // --- Category month-over-month movement ---------------------------------
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorised'
  const byCatMonth = new Map<string, Map<string, number>>()
  for (const t of spendTxns) {
    const key = t.category_id ?? 'none'
    const months = byCatMonth.get(key) ?? new Map()
    const mk = monthKey(t.date)
    months.set(mk, (months.get(mk) ?? 0) + -t.amount_minor)
    byCatMonth.set(key, months)
  }
  for (const [catId, months] of byCatMonth) {
    if (catId === 'none') continue
    const current = months.get(thisMonth) ?? 0
    const prior = [...months.entries()].filter(([k]) => k !== thisMonth).slice(-3)
    if (prior.length < 2 || current === 0) continue
    const avg = prior.reduce((s, [, v]) => s + v, 0) / prior.length
    if (current > avg * 1.4 && current - avg > 3000) {
      drafts.push({
        insight_type: 'category_spending',
        headline: `${catName(catId)} spending is ${fmt(current - avg)} above your recent average`,
        body: `${catName(catId)} is at ${fmt(current)} this month vs a ${prior.length}-month average of ${fmt(Math.round(avg))}.`,
        figures: { current, average: Math.round(avg) },
        comparison_period: `${prior.length}-month average`,
        confidence: 'high',
        suggested_action: 'Review the transactions behind this or adjust the budget line.',
        impact_minor: Math.round(current - avg),
        severity: 'warning',
        dedupe_key: `category_spending:${catId}:${thisMonth}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }
  }

  // --- Subscription price rises -------------------------------------------
  for (const r of recurring) {
    const h = r.price_history
    if (h.length >= 2) {
      const prev = Math.abs(h[h.length - 2].amount_minor)
      const cur = Math.abs(h[h.length - 1].amount_minor)
      if (cur > prev) {
        drafts.push({
          insight_type: 'subscription_change',
          headline: `${r.name} increased from ${fmt(prev)} to ${fmt(cur)}`,
          body: `The recorded price of ${r.name} rose by ${fmt(cur - prev)} (${Math.round(((cur - prev) / prev) * 100)}%).`,
          figures: { previous: prev, current: cur },
          comparison_period: null,
          confidence: 'high',
          suggested_action: 'Check whether the new price is still worth it or renegotiate.',
          impact_minor: cur - prev,
          severity: 'warning',
          dedupe_key: `subscription_change:${r.id}:${h[h.length - 1].date}`,
          period_start: periodStart,
          period_end: periodEnd,
        })
      }
    }
    // Payment after cancellation
    if (r.status === 'cancelled') {
      const after = spendTxns.find(
        (t) => t.recurring_payment_id === r.id && t.date > (r.price_history.at(-1)?.date ?? '0000'),
      )
      if (after) {
        drafts.push({
          insight_type: 'cancelled_still_charging',
          headline: `${r.name} charged after being marked cancelled`,
          body: `A payment of ${fmt(after.amount_minor)} on ${after.date} matches ${r.name}, which you marked as cancelled.`,
          figures: { amount: Math.abs(after.amount_minor), date: after.date },
          comparison_period: null,
          confidence: 'high',
          suggested_action: 'Contact the provider or dispute the charge.',
          impact_minor: Math.abs(after.amount_minor),
          severity: 'warning',
          dedupe_key: `cancelled_still_charging:${r.id}:${after.date}`,
          period_start: periodStart,
          period_end: periodEnd,
        })
      }
    }
  }

  // --- Duplicate same-day payments ----------------------------------------
  const seen = new Map<string, Transaction>()
  for (const t of spendTxns.filter((t) => monthKey(t.date) === thisMonth)) {
    const key = `${t.date}|${t.amount_minor}|${(t.merchant_name ?? t.description).toUpperCase()}`
    const prev = seen.get(key)
    if (prev && Math.abs(t.amount_minor) > 1000 && prev.id !== t.id) {
      drafts.push({
        insight_type: 'duplicate_payment',
        headline: `Possible duplicate: two ${fmt(t.amount_minor)} payments to ${t.merchant_name ?? t.description} on ${t.date}`,
        body: `Two identical payments were recorded on the same day. If this wasn't intentional, check with the merchant.`,
        figures: { amount: Math.abs(t.amount_minor), date: t.date },
        comparison_period: null,
        confidence: 'medium',
        suggested_action: 'Verify with the merchant or your bank.',
        impact_minor: Math.abs(t.amount_minor),
        severity: 'warning',
        dedupe_key: `duplicate_payment:${key}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }
    seen.set(key, t)
  }

  // --- Fixed costs share of income ----------------------------------------
  const incomeThisMonth = txns
    .filter((t) => !t.is_transfer && t.amount_minor > 0 && monthKey(t.date) === thisMonth)
    .reduce((s, t) => s + t.amount_minor, 0)
  const fixedMonthly = recurring
    .filter((r) => r.status === 'active' && r.amount_minor < 0 && r.is_essential)
    .reduce((s, r) => {
      const perMonth: Record<string, number> = {
        weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, four_weekly: 13 / 12,
        quarterly: 1 / 3, six_monthly: 1 / 6, annual: 1 / 12, custom: 1,
      }
      return s + Math.abs(r.amount_minor) * (perMonth[r.frequency] ?? 1)
    }, 0)
  if (incomeThisMonth > 0 && fixedMonthly / incomeThisMonth > 0.5) {
    drafts.push({
      insight_type: 'cashflow_risk',
      headline: `Fixed bills are ${Math.round((fixedMonthly / incomeThisMonth) * 100)}% of this month's income`,
      body: `Essential recurring commitments total ${fmt(Math.round(fixedMonthly))}/month against ${fmt(incomeThisMonth)} of income received this month.`,
      figures: { fixed: Math.round(fixedMonthly), income: incomeThisMonth },
      comparison_period: null,
      confidence: 'medium',
      suggested_action: null,
      impact_minor: null,
      severity: 'warning',
      dedupe_key: `cashflow_risk:fixed_share:${thisMonth}`,
      period_start: periodStart,
      period_end: periodEnd,
    })
  }

  if (drafts.length === 0) return 0
  // Skip anything previously dismissed/muted; insert new ones idempotently.
  const { data: existing } = await supabase
    .from('insights')
    .select('dedupe_key,status')
    .in('dedupe_key', drafts.map((d) => d.dedupe_key))
  const known = new Set((existing ?? []).map((e: { dedupe_key: string }) => e.dedupe_key))
  const fresh = drafts.filter((d) => !known.has(d.dedupe_key))
  if (fresh.length === 0) return 0
  const { error } = await supabase
    .from('insights')
    .insert(fresh.map((d) => ({ ...d, user_id: userId })))
  if (error) throw new Error(error.message)
  return fresh.length
}
