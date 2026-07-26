// Pay periods: the app's real month runs payday to payday, not 1st to 31st.
//
// The user is paid on a nominal day of the month (profiles.payday_day, e.g.
// 25). When that date lands on a weekend the money arrives on the Friday
// before — so the ACTUAL payday for July 2026 (25th = Saturday) is Friday the
// 24th, and the period that starts there runs until the day before the next
// actual payday. Every "how is the month going / what's left / will I run
// short" question should be asked over this window.
//
// With no payday configured everything falls back to calendar months, so the
// app degrades gracefully rather than guessing a payday.

export interface PayPeriod {
  /** Actual payday that opens the period (inclusive). */
  start: string
  /** Day before the next actual payday (inclusive). */
  end: string
  /** The next actual payday — the day the period's money runs out or resets. */
  nextPayday: string
  days: number
  /** e.g. "24 Jul – 24 Aug". */
  label: string
  /** Month this period pays for (YYYY-MM-01) — the budget row it maps to.
   * Convention: the month containing the period END, which the period mostly
   * covers for typical late-month paydays. */
  budgetMonth: string
}

const DAY_MS = 86_400_000

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function isoAddDays(dateIso: string, days: number): string {
  return iso(new Date(toUtc(dateIso).getTime() + days * DAY_MS))
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso).getTime() - toUtc(fromIso).getTime()) / DAY_MS)
}

/**
 * The date pay actually arrives for a nominal (year, month, day-of-month):
 * clamped to the month's length (31st → 30 Apr), then rolled back to the
 * Friday before when it lands on a weekend.
 */
export function actualPayday(year: number, month1: number, paydayDay: number): string {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate()
  const d = new Date(Date.UTC(year, month1 - 1, Math.min(paydayDay, daysInMonth)))
  const dow = d.getUTCDay() // 0 = Sunday, 6 = Saturday
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1)
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2)
  return iso(d)
}

function shortDate(dateIso: string): string {
  return toUtc(dateIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function build(start: string, nextPayday: string): PayPeriod {
  const end = isoAddDays(nextPayday, -1)
  const endMonth = end.slice(0, 7)
  return {
    start,
    end,
    nextPayday,
    days: daysBetween(start, nextPayday),
    label: `${shortDate(start)} – ${shortDate(end)}`,
    budgetMonth: `${endMonth}-01`,
  }
}

function calendarMonthPeriod(dateIso: string): PayPeriod {
  const y = Number(dateIso.slice(0, 4))
  const m = Number(dateIso.slice(5, 7))
  const start = `${dateIso.slice(0, 7)}-01`
  const nextStart = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const p = build(start, nextStart)
  // A calendar month maps to its own budget row and reads as a month name.
  return {
    ...p,
    budgetMonth: start,
    label: toUtc(start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  }
}

/** The pay period containing `dateIso`. */
export function payPeriodFor(dateIso: string, paydayDay: number | null | undefined): PayPeriod {
  if (!paydayDay) return calendarMonthPeriod(dateIso)
  const y = Number(dateIso.slice(0, 4))
  const m = Number(dateIso.slice(5, 7))
  // Actual paydays can drift a couple of days before the nominal date, so
  // consider the surrounding months and pick the latest payday <= date.
  const candidates: string[] = []
  for (const delta of [-2, -1, 0, 1]) {
    const total = y * 12 + (m - 1) + delta
    candidates.push(actualPayday(Math.floor(total / 12), (total % 12) + 1, paydayDay))
  }
  const start = [...candidates].filter((c) => c <= dateIso).sort().pop()!
  const next = candidates.find((c) => c > start)!
  return build(start, next)
}

/** Up to `count` complete periods strictly before the one containing `todayIso`, newest first. */
export function previousPayPeriods(
  todayIso: string,
  paydayDay: number | null | undefined,
  count: number,
): PayPeriod[] {
  const out: PayPeriod[] = []
  let cursor = payPeriodFor(todayIso, paydayDay)
  for (let i = 0; i < count; i++) {
    cursor = payPeriodFor(isoAddDays(cursor.start, -1), paydayDay)
    out.push(cursor)
  }
  return out
}

/** The period after the given one. */
export function nextPayPeriod(period: PayPeriod, paydayDay: number | null | undefined): PayPeriod {
  return payPeriodFor(period.nextPayday, paydayDay)
}
