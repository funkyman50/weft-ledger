import type { TransactionFlag } from '../../api/types'

export const TRANSACTION_FLAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet'] as const

export function transactionFlagLabel(value: TransactionFlag): string {
  return value === null ? 'No flag' : `${value.charAt(0).toUpperCase()}${value.slice(1)} flag`
}
