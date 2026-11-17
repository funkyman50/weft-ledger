import { useState } from 'react'
import { Banknote, CreditCard, Landmark, PiggyBank } from 'lucide-react'
import type { Account } from '../../api/types'
import { accountLogoUrl } from './accountLogos'

function FallbackIcon({ type }: { type: string }) {
  if (type === 'credit') return <CreditCard aria-hidden="true" />
  if (type === 'savings') return <PiggyBank aria-hidden="true" />
  if (type === 'cash') return <Banknote aria-hidden="true" />
  return <Landmark aria-hidden="true" />
}

export function AccountIcon({ account }: { account: Pick<Account, 'name' | 'type' | 'plaid_connection' | 'logo_id'> }) {
  const [failedId, setFailedId] = useState<string | null>(null)
  const seed = (account.plaid_connection?.institution.trim() || account.name).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const initial = seed.charAt(0).toUpperCase()
  let hash = 0
  for (const character of seed) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0
  const automatic = /^[A-Z]$/.test(initial)
    ? <svg className={`bp-account-initial is-color-${hash % 6}`} viewBox="0 0 32 32" aria-hidden="true"><text x="16" y="16" dy=".35em" textAnchor="middle">{initial}</text></svg>
    : <FallbackIcon type={account.type} />

  return (
    <span className="bp-account-icon" aria-hidden="true">
      {account.logo_id && failedId !== account.logo_id
        ? <img key={account.logo_id} src={accountLogoUrl(account.logo_id)} alt="" draggable={false} onError={() => setFailedId(account.logo_id)} />
        : automatic}
    </span>
  )
}
