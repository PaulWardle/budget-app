// Deterministic loan amortisation engine.
//
// Assumptions (documented, per architecture):
// - Interest accrues monthly on the outstanding balance.
// - By default the monthly rate is APR/12 (nominal). UK regulated agreements
//   quote an *effective* APR; callers can pass aprType: 'effective' to use
//   (1+APR)^(1/12)-1 instead. All outputs are labelled estimates unless they
//   come from a lender document.
// - All money values are integer minor units (pence).

import { roundHalfAwayFromZero, type Minor } from './money'

export interface ScheduleRow {
  paymentNumber: number
  dueDate: string // ISO date
  paymentMinor: Minor
  principalMinor: Minor
  interestMinor: Minor
  balanceAfterMinor: Minor
}

export interface ScheduleInput {
  principalMinor: Minor
  apr: number // e.g. 6.9 for 6.9%
  aprType?: 'nominal' | 'effective'
  termMonths: number
  startDate: string // ISO date of first payment
  paymentMinor?: Minor // if known from the contract; otherwise derived
  balloonMinor?: Minor // final balloon (PCP) payable with the last instalment
}

export function monthlyRate(apr: number, aprType: 'nominal' | 'effective' = 'nominal'): number {
  const r = apr / 100
  return aprType === 'effective' ? Math.pow(1 + r, 1 / 12) - 1 : r / 12
}

/** Standard annuity payment for principal P over n months at monthly rate i,
 * optionally leaving a balloon B outstanding at the end. */
export function derivePaymentMinor(
  principalMinor: Minor,
  apr: number,
  termMonths: number,
  opts: { aprType?: 'nominal' | 'effective'; balloonMinor?: Minor } = {},
): Minor {
  const i = monthlyRate(apr, opts.aprType)
  const B = opts.balloonMinor ?? 0
  if (termMonths <= 0) return principalMinor + B
  if (i === 0) return roundHalfAwayFromZero((principalMinor - B) / termMonths)
  const pow = Math.pow(1 + i, termMonths)
  const payment = ((principalMinor - B / pow) * i * pow) / (pow - 1)
  return roundHalfAwayFromZero(payment)
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = (m - 1) + months
  const year = y + Math.floor(total / 12)
  const month = (total % 12) + 1
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(d, daysInMonth)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Build a full amortisation schedule. The final instalment is adjusted so the
 * balance lands exactly on zero (or on the balloon, which is then cleared).
 */
export function buildSchedule(input: ScheduleInput): ScheduleRow[] {
  const { principalMinor, apr, termMonths, startDate } = input
  const i = monthlyRate(apr, input.aprType)
  const balloon = input.balloonMinor ?? 0
  const payment =
    input.paymentMinor ??
    derivePaymentMinor(principalMinor, apr, termMonths, {
      aprType: input.aprType,
      balloonMinor: balloon,
    })

  const rows: ScheduleRow[] = []
  let balance = principalMinor
  for (let n = 1; n <= termMonths && balance > 0; n++) {
    const interest = roundHalfAwayFromZero(balance * i)
    const isLast = n === termMonths
    let pay: Minor
    if (isLast) {
      pay = balance + interest + balloon
    } else {
      pay = Math.min(payment, balance + interest)
    }
    const principal = pay - interest - (isLast ? balloon : 0)
    balance -= principal
    rows.push({
      paymentNumber: n,
      dueDate: addMonths(startDate, n - 1),
      paymentMinor: pay,
      principalMinor: principal,
      interestMinor: interest,
      balanceAfterMinor: balance,
    })
    if (balance <= 0) break
  }
  // Balloon due at the end clears the remaining balloon balance
  if (balloon > 0 && rows.length > 0) {
    const last = rows[rows.length - 1]
    last.balanceAfterMinor = 0
  }
  return rows
}

export function totalInterest(rows: ScheduleRow[]): Minor {
  return rows.reduce((a, r) => a + r.interestMinor, 0)
}

export function totalPaid(rows: ScheduleRow[]): Minor {
  return rows.reduce((a, r) => a + r.paymentMinor, 0)
}

/** Expected balance according to a schedule as of a date (contractual position). */
export function expectedBalanceAt(rows: ScheduleRow[], asOfIso: string): Minor {
  let balance = rows.length > 0 ? rows[0].balanceAfterMinor + rows[0].principalMinor : 0
  for (const r of rows) {
    if (r.dueDate <= asOfIso) balance = r.balanceAfterMinor
    else break
  }
  return balance
}

export interface Overpayment {
  monthIndex: number // 1-based payment number the overpayment lands on (before that month's accrual is settled)
  amountMinor: Minor
}

export interface RevisedScheduleResult {
  rows: ScheduleRow[]
  interestMinor: Minor
  months: number
  interestSavedMinor: Minor
  monthsSaved: number
  newPaymentMinor?: Minor // for reduce-payment scenario
}

/**
 * Recalculate a schedule after overpayments and/or a recurring extra payment.
 * mode 'reduce_term' keeps the payment and finishes earlier;
 * mode 'reduce_payment' keeps the term and recalculates the payment after
 * each one-off overpayment.
 */
export function applyOverpayments(
  input: ScheduleInput,
  overpayments: Overpayment[],
  opts: { mode: 'reduce_term' | 'reduce_payment'; extraMonthlyMinor?: Minor } = {
    mode: 'reduce_term',
  },
): RevisedScheduleResult {
  const original = buildSchedule(input)
  const originalInterest = totalInterest(original)
  const i = monthlyRate(input.apr, input.aprType)
  const balloon = input.balloonMinor ?? 0
  const basePayment =
    input.paymentMinor ??
    derivePaymentMinor(input.principalMinor, input.apr, input.termMonths, {
      aprType: input.aprType,
      balloonMinor: balloon,
    })
  const extra = opts.extraMonthlyMinor ?? 0
  const opByMonth = new Map<number, Minor>()
  for (const op of overpayments) {
    opByMonth.set(op.monthIndex, (opByMonth.get(op.monthIndex) ?? 0) + op.amountMinor)
  }

  const rows: ScheduleRow[] = []
  let balance = input.principalMinor
  let payment = basePayment
  let newPayment: Minor | undefined
  const hardCap = input.termMonths + 600 // safety against non-amortising inputs
  for (let n = 1; balance > 0 && n <= hardCap; n++) {
    const interest = roundHalfAwayFromZero(balance * i)
    const oneOff = opByMonth.get(n) ?? 0
    let pay = payment + extra + oneOff
    const isContractEnd = opts.mode === 'reduce_payment' && n === input.termMonths
    if (pay >= balance + interest + (isContractEnd ? balloon : 0) || isContractEnd) {
      pay = balance + interest + balloon // settle in full (incl. any balloon)
      const principal = balance
      rows.push({
        paymentNumber: n,
        dueDate: addMonths(input.startDate, n - 1),
        paymentMinor: pay,
        principalMinor: principal,
        interestMinor: interest,
        balanceAfterMinor: 0,
      })
      balance = 0
      break
    }
    const principal = pay - interest
    balance -= principal
    rows.push({
      paymentNumber: n,
      dueDate: addMonths(input.startDate, n - 1),
      paymentMinor: pay,
      principalMinor: principal,
      interestMinor: interest,
      balanceAfterMinor: balance,
    })
    // reduce_payment: after a one-off overpayment, re-derive the payment over
    // the remaining contractual term
    if (opts.mode === 'reduce_payment' && oneOff > 0) {
      const remaining = input.termMonths - n
      if (remaining > 0) {
        payment = derivePaymentMinor(balance, input.apr, remaining, {
          aprType: input.aprType,
          balloonMinor: balloon,
        })
        newPayment = payment
      }
    }
  }

  const interest = totalInterest(rows)
  return {
    rows,
    interestMinor: interest,
    months: rows.length,
    interestSavedMinor: originalInterest - interest,
    monthsSaved: original.length - rows.length,
    newPaymentMinor: newPayment,
  }
}

/**
 * Estimated settlement today: outstanding balance plus interest accrued since
 * the last payment date. Clearly an ESTIMATE — lender figures may differ.
 */
export function estimateSettlement(
  balanceMinor: Minor,
  apr: number,
  daysSinceLastPayment: number,
  aprType: 'nominal' | 'effective' = 'nominal',
): Minor {
  const daily = monthlyRate(apr, aprType) * 12 / 365
  const accrued = roundHalfAwayFromZero(balanceMinor * daily * Math.max(0, daysSinceLastPayment))
  return balanceMinor + accrued
}
