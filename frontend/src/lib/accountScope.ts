import type { Account } from '../api/types'

export type AccountScope = number | 'all' | `group:${string}`

export function isCombinedScope(scope: AccountScope | null): scope is 'all' | `group:${string}` {
  return typeof scope === 'string'
}

export function scopeGroupName(scope: AccountScope | null): string | null {
  return isCombinedScope(scope) && scope !== 'all' ? scope.slice(6) : null
}

export function accountInScope(account: Account | undefined, scope: AccountScope | null): boolean {
  if (!account || scope === null) return false
  if (typeof scope === 'number') return account.id === scope
  return scope === 'all' || !account.closed && account.group_name === scopeGroupName(scope)
}

export function appendAccountScope(params: URLSearchParams, scope: AccountScope | null): void {
  if (typeof scope === 'number') params.set('account_id', String(scope))
  const group = scopeGroupName(scope)
  if (group !== null) params.set('group_name', group)
}
