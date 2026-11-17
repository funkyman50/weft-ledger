import { TriangleAlert } from 'lucide-react'
import type { Account } from '../../api/types'
import { money } from '../../lib/money'

export function LoanDifferenceButton({
  account,
  difference,
  combined,
  onOpen,
}: {
  account: Account
  difference: number
  combined: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="bp-cleared-discrepancy"
      title={`Bank-reported balance ${money(account.plaid_current_balance_cents!)}; Weft Cleared ${money(account.cleared_balance_cents!)}; difference ${money(difference, true)}; updated ${account.plaid_balance_updated_at ? new Date(account.plaid_balance_updated_at).toLocaleString() : 'time unavailable'}. Resolve difference.`}
      onClick={onOpen}
    >
      <TriangleAlert aria-hidden="true" />
      {combined ? `${account.name} · ` : ''}Bank difference {money(difference, true)}
    </button>
  )
}
