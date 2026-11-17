import { Anchor, Landmark, UserRound } from 'lucide-react'

export type LedgerSource = 'plaid' | 'manual' | 'balance'

export function LedgerSourceIcon({ source, excluded = false }: { source: LedgerSource; excluded?: boolean }) {
  const label = {
    plaid: 'Plaid import',
    manual: 'Manual entry',
    balance: 'Starting balance',
  }[source]

  const accessibleLabel = excluded ? 'Excluded Plaid transaction' : label
  return (
    <span className={`bp-source-icon is-${source}${excluded ? ' is-excluded' : ''}`} role="img" aria-label={accessibleLabel} title={accessibleLabel}>
      {source === 'plaid' && <Landmark aria-hidden="true" />}
      {source === 'manual' && <UserRound aria-hidden="true" />}
      {source === 'balance' && <Anchor aria-hidden="true" />}
      {excluded && <span className="bp-source-excluded-mark" aria-hidden="true">×</span>}
    </span>
  )
}
