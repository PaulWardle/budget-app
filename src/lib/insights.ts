// Deterministic insight generation. Every figure comes from the ledger; the
// engine only writes an insight when there is sufficient evidence, with a
// dedupe_key so re-running never duplicates. Language stays factual — no
// moralising about ordinary spending.

import { supabase } from '@/lib/supabase'
import { expandRecurring } from '@/lib/engine/cashflow'
import { daysInMonth, everydayBaseline, forecastMonthEnd } from '@/lib/engine/forecast'
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
  opts: { cashMinor?: number } = {},
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

  // --- Where the month is heading -----------------------------------------
  // Forward-looking, and the reason it exists: a month can look fine on bills
  // alone right up until ordinary spending finishes the account off.
  const today = now.toISOString().slice(0, 10)
  const forecastTxns = txns.map((t) => ({
    date: t.date,
    amountMinor: t.amount_minor,
    categoryId: t.category_id,
    isTransfer: t.is_transfer,
    excludeFromBudget: t.exclude_from_budget,
    isReimbursable: t.is_reimbursable,
    recurringPaymentId: t.recurring_payment_id,
  }))
  const baseline = everydayBaseline(forecastTxns, today)
  if (baseline.monthsUsed >= 2) {
    const dim = daysInMonth(thisMonth)
    const monthEnd = `${thisMonth}-${String(dim).padStart(2, '0')}`
    const remainingScheduled = recurring
      .filter((r) => r.status === 'active')
      .flatMap((r) =>
        expandRecurring(
          {
            name: r.name,
            amountMinor: r.amount_minor,
            frequency: r.frequency,
            nextDueDate: r.next_due_date,
            intervalDays: r.interval_days,
          },
          today,
          monthEnd,
        ),
      )
      .filter((i) => i.date > today)
    const forecast = forecastMonthEnd({
      today,
      currentBalanceMinor: opts.cashMinor ?? 0,
      monthTxns: forecastTxns.filter((t) => monthKey(t.date) === thisMonth),
      baseline,
      remainingScheduled,
    })

    if (opts.cashMinor !== undefined && forecast.forecastEndBalanceMinor < 0) {
      drafts.push({
        insight_type: 'projected_shortfall',
        headline: `On your usual spending you're about ${fmt(forecast.forecastEndBalanceMinor)} short by month end`,
        body: `You have ${fmt(opts.cashMinor)} available with ${forecast.daysRemaining} days left. Your typical everyday spending of ${fmt(baseline.perMonthMinor)}/month works out at about ${fmt(baseline.perDayMinor)}/day (${fmt(forecast.everydayRemainingMinor)} for the days remaining), and ${fmt(forecast.billsRemainingMinor)} of bills are still due. That lands at roughly ${fmt(forecast.forecastEndBalanceMinor)} below zero before anything unexpected.`,
        figures: {
          cash: opts.cashMinor,
          everyday_remaining: forecast.everydayRemainingMinor,
          bills_remaining: forecast.billsRemainingMinor,
          projected_end: forecast.forecastEndBalanceMinor,
        },
        comparison_period: `${baseline.monthsUsed}-month spending baseline`,
        confidence: baseline.confidence,
        suggested_action: 'Check the Cashflow projection for the day it turns, and what could move.',
        impact_minor: Math.abs(forecast.forecastEndBalanceMinor),
        severity: 'warning',
        dedupe_key: `projected_shortfall:${thisMonth}:${Math.round(forecast.forecastEndBalanceMinor / 5000)}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }

    if (forecast.paceRatio >= 1.3 && forecast.dayOfMonth >= 7) {
      const overMinor = Math.round(forecast.forecastSpendMinor - forecast.billsPaidMinor - forecast.billsRemainingMinor - baseline.perMonthMinor)
      drafts.push({
        insight_type: 'spending_pace',
        headline: `Everyday spending is running ${Math.round((forecast.paceRatio - 1) * 100)}% above your usual pace`,
        body: `You're ${fmt(forecast.everydaySpentMinor)} into everyday spending on day ${forecast.dayOfMonth} of ${forecast.daysInMonth}. At your normal rate you'd be around ${fmt(Math.round((baseline.perMonthMinor * forecast.dayOfMonth) / forecast.daysInMonth))} by now. Carrying on at this rate the month lands about ${fmt(overMinor)} above a typical ${fmt(baseline.perMonthMinor)}.`,
        figures: { pace_ratio: Number(forecast.paceRatio.toFixed(2)), spent: forecast.everydaySpentMinor, typical: baseline.perMonthMinor },
        comparison_period: `${baseline.monthsUsed}-month spending baseline`,
        confidence: baseline.confidence,
        suggested_action: null,
        impact_minor: overMinor > 0 ? overMinor : null,
        severity: 'warning',
        dedupe_key: `spending_pace:${thisMonth}:${Math.round(forecast.paceRatio * 10)}`,
        period_start: periodStart,
        period_end: periodEnd,
      })
    }

    // Categories on course to finish the month well above their usual level.
    for (const c of baseline.byCategory.slice(0, 12)) {
      if (c.perMonthMinor < 2000) continue
      const spent = forecastTxns
        .filter(
          (t) =>
            monthKey(t.date) === thisMonth &&
            t.categoryId === c.categoryId &&
            t.amountMinor < 0 &&
            !t.isTransfer &&
            !t.excludeFromBudget &&
            !t.isReimbursable &&
            !t.recurringPaymentId,
        )
        .reduce((s, t) => s + -t.amountMinor, 0)
      const projected = Math.round(
        spent + (c.perMonthMinor / daysInMonth(thisMonth)) * forecast.daysRemaining,
      )
      if (spent > c.perMonthMinor && spent - c.perMonthMinor > 3000 && forecast.daysRemaining > 2) {
        drafts.push({
          insight_type: 'category_pace',
          headline: `${catName(c.categoryId)} has already passed a typical month with ${forecast.daysRemaining} days to go`,
          body: `${catName(c.categoryId)} is at ${fmt(spent)} against a typical ${fmt(c.perMonthMinor)} for a full month. On current behaviour it finishes around ${fmt(projected)}.`,
          figures: { spent, typical: c.perMonthMinor, projected },
          comparison_period: `${baseline.monthsUsed}-month median`,
          confidence: baseline.confidence,
          suggested_action: null,
          impact_minor: spent - c.perMonthMinor,
          severity: 'warning',
          dedupe_key: `category_pace:${c.categoryId ?? 'none'}:${thisMonth}`,
          period_start: periodStart,
          period_end: periodEnd,
        })
      }
    }
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
