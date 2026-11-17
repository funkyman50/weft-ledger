import type { Account } from '../../api/types'

export function accountBankDifference(account: Account): number | null {
  if (account.starting_balance_initialized_at === null || account.cleared_balance_cents === null || account.plaid_current_balance_cents === null) return null
  const difference = account.cleared_balance_cents - account.plaid_current_balance_cents
  return difference === 0 ? null : difference
}
