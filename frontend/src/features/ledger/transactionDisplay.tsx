import type { ReactNode } from 'react'

import type { LedgerRow, TransactionFlag } from '../../api/types'
import { TransactionFlagMarker } from './TransactionFlagPicker'
import { transactionFlagLabel } from './transactionFlags'
import { ManualClearStatus } from './LedgerRowControls'

export const emptyCell = <span className="bp-cell-stub" aria-label="Not assigned">—</span>

export function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type StatusRow = Pick<LedgerRow, 'status' | 'manually_cleared' | 'missing_pending'>

export function ledgerDisplayGroup(transaction: Pick<LedgerRow, 'source' | 'status'> & { pinned?: boolean }): number {
  if (transaction.pinned) return 2
  return transaction.source === 'plaid' && transaction.status === 'pending' ? 1 : 0
}

type ChronologyRow = Pick<LedgerRow, 'id' | 'date' | 'amount_cents' | 'source'>

type DisplayOrderRow = ChronologyRow & Pick<LedgerRow, 'status'> & { pinned?: boolean }

export function chronologyRank(row: Pick<LedgerRow, 'amount_cents' | 'source'>): number {
  return row.source === 'starting_balance' ? 0 : row.amount_cents > 0 ? 1 : row.amount_cents === 0 ? 2 : 3
}

export function compareChronology(left: ChronologyRow, right: ChronologyRow): number {
  return left.date.localeCompare(right.date) || chronologyRank(left) - chronologyRank(right) || left.id - right.id
}

export function compareDefaultLedgerRows(left: DisplayOrderRow, right: DisplayOrderRow): number {
  return ledgerDisplayGroup(left) - ledgerDisplayGroup(right) || compareChronology(left, right)
}

export function defaultBalanceCutoff(rows: readonly LedgerRow[]): (ChronologyRow & { boundaryId: number }) | null {
  const contributing = rows.filter((row) => row.running_balance_cents !== null).sort(compareDefaultLedgerRows)
  let latest: LedgerRow | null = null
  let cutoff: LedgerRow | null = null
  for (const row of contributing) {
    if (latest && compareChronology(row, latest) < 0 && (!cutoff || compareChronology(row, cutoff) < 0)) cutoff = row
    if (!latest || compareChronology(row, latest) > 0) latest = row
  }
  if (!cutoff) return null
  const boundary = contributing.find((row) => compareChronology(row, cutoff) >= 0)!
  return { date: cutoff.date, id: cutoff.id, amount_cents: cutoff.amount_cents, source: cutoff.source, boundaryId: boundary.id }
}

export function statusLabel(transaction: StatusRow): string {
  if (transaction.missing_pending) return 'Pending?'
  if (transaction.manually_cleared) return 'Cleared*'
  return transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)
}

export function statusDisplay(transaction: StatusRow): ReactNode {
  return transaction.manually_cleared && !transaction.missing_pending ? <ManualClearStatus /> : statusLabel(transaction)
}

export function transferDirection(amountCents: number): string {
  return amountCents < 0 ? 'Transfer to' : amountCents > 0 ? 'Transfer from' : 'Transfer'
}

export function valueLabel(value: string | null | undefined): string {
  return value?.trim() ? value : '—'
}

export function categoryValue(transaction: LedgerRow): string {
  if (transaction.allocations.length) return 'Split'
  if (!transaction.category_name) return ''
  return transaction.subcategory_name
    ? `${transaction.category_name}: ${transaction.subcategory_name}`
    : transaction.category_name
}

export function categoryLabel(transaction: LedgerRow, empty = '—'): string {
  return categoryValue(transaction) || empty
}

export function flagDisplay(value: TransactionFlag): ReactNode {
  return value === null
    ? '—'
    : <span className="bp-match-flag"><TransactionFlagMarker value={value} label={false} />{transactionFlagLabel(value)}</span>
}
