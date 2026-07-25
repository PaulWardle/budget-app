// Deterministic CSV statement parsing — no AI involved. Handles quoted fields,
// common UK bank column layouts (single signed amount, or debit/credit pairs),
// and several date formats.

import { parseToMinor } from '@/lib/engine/money'

export interface CsvTxn {
  date: string // ISO
  description: string
  merchant: string | null
  amountMinor: number
  balanceMinor: number | null
  reference: string | null
  raw: string
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

const DATE_FORMATS: { re: RegExp; toIso: (m: RegExpMatchArray) => string }[] = [
  { re: /^(\d{4})-(\d{2})-(\d{2})/, toIso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, toIso: (m) => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, toIso: (m) => `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, toIso: (m) => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
  {
    re: /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/,
    toIso: (m) => {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      const mi = months.indexOf(m[2].toLowerCase().slice(0, 3)) + 1
      return `${m[3]}-${String(mi).padStart(2, '0')}-${m[1].padStart(2, '0')}`
    },
  },
]

export function parseDateCell(cell: string): string | null {
  const trimmed = cell.trim()
  for (const f of DATE_FORMATS) {
    const m = trimmed.match(f.re)
    if (m) {
      const iso = f.toIso(m)
      if (!Number.isNaN(Date.parse(iso))) return iso
    }
  }
  return null
}

interface ColumnMap {
  date: number
  description: number
  merchant?: number
  amount?: number
  debit?: number
  credit?: number
  balance?: number
  reference?: number
}

function detectColumns(header: string[], sample: string[][]): ColumnMap | null {
  const h = header.map((c) => c.trim().toLowerCase())
  const find = (...names: string[]) => h.findIndex((c) => names.some((n) => c.includes(n)))
  let date = find('date')
  const description = find('description', 'narrative', 'details', 'merchant', 'transaction')
  const amount = find('amount', 'value')
  const debit = find('debit', 'paid out', 'money out', 'out')
  const credit = find('credit', 'paid in', 'money in', 'in')
  const balance = find('balance')
  const reference = find('reference', 'ref')
  // Monzo exports carry the clean merchant in a "Name" column
  const merchantIdx = h.findIndex((c) => c === 'name' || c === 'merchant' || c === 'merchant name')
  const merchant = merchantIdx === description ? -1 : merchantIdx

  if (date === -1) {
    // Headerless file? Detect the date column from data.
    date = sample[0]?.findIndex((c) => parseDateCell(c) !== null) ?? -1
    if (date === -1) return null
    const descIdx = sample[0].findIndex((c, i) => i !== date && Number.isNaN(Number(c.replace(/[£,]/g, ''))))
    const amtIdx = sample[0].findIndex((c, i) => i !== date && i !== descIdx && parseToMinor(c) !== null)
    if (descIdx === -1 || amtIdx === -1) return null
    return { date, description: descIdx, amount: amtIdx }
  }
  if (description === -1) return null
  if (amount !== -1 && amount !== debit && amount !== credit) {
    return {
      date, description, amount,
      merchant: merchant === -1 ? undefined : merchant,
      balance: balance === -1 ? undefined : balance,
      reference: reference === -1 ? undefined : reference,
    }
  }
  if (debit !== -1 || credit !== -1) {
    return {
      date,
      description,
      merchant: merchant === -1 ? undefined : merchant,
      debit: debit === -1 ? undefined : debit,
      credit: credit === -1 ? undefined : credit,
      balance: balance === -1 ? undefined : balance,
      reference: reference === -1 ? undefined : reference,
    }
  }
  return null
}

export interface CsvParseResult {
  transactions: CsvTxn[]
  skipped: number
  error?: string
}

export function parseStatementCsv(text: string): CsvParseResult {
  const rows = parseCsv(text)
  if (rows.length === 0) return { transactions: [], skipped: 0, error: 'Empty file' }
  const headerLooksLikeData = parseDateCell(rows[0][0] ?? '') !== null
  const header = headerLooksLikeData ? rows[0].map((_, i) => `col${i}`) : rows[0]
  const dataRows = headerLooksLikeData ? rows : rows.slice(1)
  const cols = detectColumns(header, dataRows.slice(0, 5))
  if (!cols) {
    return {
      transactions: [],
      skipped: rows.length,
      error: 'Could not identify date, description and amount columns. Check the CSV has headers like Date, Description, Amount (or Debit/Credit).',
    }
  }
  const out: CsvTxn[] = []
  let skipped = 0
  for (const r of dataRows) {
    const date = parseDateCell(r[cols.date] ?? '')
    const merchantCell = cols.merchant !== undefined ? (r[cols.merchant] ?? '').trim() : ''
    let description = (r[cols.description] ?? '').trim()
    // Monzo often leaves Description blank and puts everything in Name
    if (!description && merchantCell) description = merchantCell
    let amountMinor: number | null = null
    if (cols.amount !== undefined) {
      amountMinor = parseToMinor(r[cols.amount] ?? '')
    } else {
      const debit = cols.debit !== undefined ? parseToMinor(r[cols.debit] ?? '') : null
      const credit = cols.credit !== undefined ? parseToMinor(r[cols.credit] ?? '') : null
      if (debit && debit !== 0) amountMinor = -Math.abs(debit)
      else if (credit && credit !== 0) amountMinor = Math.abs(credit)
    }
    if (!date || !description || amountMinor === null || amountMinor === 0) {
      skipped++
      continue
    }
    out.push({
      date,
      description,
      merchant: merchantCell || null,
      amountMinor,
      balanceMinor: cols.balance !== undefined ? parseToMinor(r[cols.balance] ?? '') : null,
      reference: cols.reference !== undefined ? (r[cols.reference] ?? '').trim() || null : null,
      raw: r.join(','),
    })
  }
  return { transactions: out, skipped }
}
