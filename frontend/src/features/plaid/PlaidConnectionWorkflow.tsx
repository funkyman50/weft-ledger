import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlaidLinkLauncher, type PlaidLinkHandlers } from './PlaidLinkLauncher'
import { ApiError, apiClient } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import type { Account, AccountType, PlaidConnectionFreshness, PlaidStatus } from '../../api/types'
import { ACCOUNT_TYPES, accountTypeLabel } from '../accounts/accountTypes'
import { recordDiagnostic, recordPlaidLinkExit } from '../../lib/diagnostics'

interface PlaidAccount {
  id: string
  name: string
  mask: string
  type: string
  subtype: string
}

function localAccountType(plaidType: string, plaidSubtype: string): AccountType {
  if (plaidType === 'credit') return 'credit'
  if (plaidType === 'loan') return 'loan'
  if (plaidSubtype === 'savings') return 'savings'
  if (plaidSubtype === 'checking') return 'checking'
  return 'cash'
}

interface PlaidConnectorProps {
  compact?: boolean
  onError: (message: string) => void
}

function usePlaidSync(onError: (message: string) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.providerCommand<PlaidStatus>('/api/plaid/sync'),
    onSuccess: async (result) => {
      queryClient.setQueryData<PlaidStatus>(['plaid-status'], result)
      void queryClient.invalidateQueries({ queryKey: ['plaid-status'] })
      await invalidateAccountAndTransactionQueries(queryClient)
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ['plaid-status'] })
      onError(error instanceof ApiError ? error.message : 'Plaid sync failed.')
    },
  })
}

export function PlaidConnectionWorkflow({ compact = false, onError }: PlaidConnectorProps) {
  const queryClient = useQueryClient()
  const [configurationIdentity, setConfigurationIdentity] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [publicToken, setPublicToken] = useState<string | null>(null)
  const [institution, setInstitution] = useState('')
  const [institutionId, setInstitutionId] = useState<string | null>(null)
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccount[] | null>(null)
  const [localAccounts, setLocalAccounts] = useState<Record<string, { name: string; type: AccountType }>>({})
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, boolean>>({})

  const dismissMapping = () => {
    setPlaidAccounts(null)
    setPublicToken(null)
    setSelectedAccounts({})
    setLocalAccounts({})
  }

  const createLinkToken = useMutation({
    mutationFn: () => apiClient.providerCommand<{ link_token: string; configuration_identity: string }>('/api/plaid/link-token'),
    onSuccess: ({ link_token, configuration_identity }) => { setConfigurationIdentity(configuration_identity); setLinkToken(link_token) },
    onError: (error) =>
      onError(error instanceof ApiError ? error.message : 'Could not start Plaid Link.'),
  })

  const plaidLinkHandlers: PlaidLinkHandlers = {
    onSuccess: (token, metadata) => {
      recordDiagnostic('plaid.link_succeeded', 'info', { account_count: metadata.accounts.length })
      // Unmount Plaid's full-screen frame before showing our account-mapping dialog.
      setLinkToken(null)
      setPublicToken(token)
      setInstitution(metadata.institution?.name ?? '')
      setInstitutionId(metadata.institution?.institution_id ?? null)
      setPlaidAccounts(metadata.accounts)
      setLocalAccounts(Object.fromEntries(metadata.accounts.map((account) => [account.id, {
        name: account.name,
        type: localAccountType(account.type, account.subtype),
      }])))
      setSelectedAccounts(Object.fromEntries(metadata.accounts.map((account) => [account.id, true])))
    },
    onExit: (error) => {
      recordPlaidLinkExit(error)
      if (error) onError(error.display_message || error.error_message || 'Plaid Link closed with an error.')
      setLinkToken(null)
    },
  }

  const initialSync = usePlaidSync(onError)

  const connect = useMutation({
    mutationFn: async () => {
      if (!publicToken || !plaidAccounts) throw new Error('Plaid connection is incomplete.')
      const connectedAccounts = Object.fromEntries(
        plaidAccounts.filter((plaidAccount) => selectedAccounts[plaidAccount.id]).map((plaidAccount) => {
          const localAccount = localAccounts[plaidAccount.id]
          return [plaidAccount.id, { name: localAccount.name.trim(), type: localAccount.type }]
        }),
      )
      return apiClient.providerCommand('/api/plaid/exchange', {
        public_token: publicToken,
        configuration_identity: configurationIdentity,
        accounts: connectedAccounts,
        institution,
        institution_id: institutionId,
      })
    },
    onSuccess: () => {
      setLinkToken(null)
      setPublicToken(null)
      setInstitution('')
      setPlaidAccounts(null)
      setSelectedAccounts({})
      setLocalAccounts({})
      setInstitutionId(null)
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
      void queryClient.invalidateQueries({ queryKey: ['transfer-context'] })
      void queryClient.invalidateQueries({ queryKey: ['plaid-status'] })
      initialSync.mutate()
    },
    onError: (error) =>
      onError(error instanceof ApiError ? error.message : 'Could not finish connecting the bank.'),
  })

  const selectedCount = plaidAccounts?.filter((account) => selectedAccounts[account.id]).length ?? 0
  const accountDetailsComplete = plaidAccounts !== null && selectedCount > 0 &&
    plaidAccounts.every((account) => !selectedAccounts[account.id] || Boolean(localAccounts[account.id]?.name.trim()))

  return (
    <>
      {linkToken && <PlaidLinkLauncher token={linkToken} {...plaidLinkHandlers} />}
      <Button
        size="lg"
        variant={compact ? 'default' : 'primary'}
        disabled={createLinkToken.isPending}
        onClick={() => createLinkToken.mutate()}
      >
        {createLinkToken.isPending ? 'Opening Plaid…' : compact ? 'Connect bank' : 'Connect with Plaid'}
      </Button>

      {plaidAccounts && (
        <Modal size="lg" labelledBy="plaid-map-title" onRequestClose={() => { if (!connect.isPending) dismissMapping() }}>
          <DialogHeader titleId="plaid-map-title" title="Add connected accounts" subtitle="Choose which accounts to add to Weft. This does not change what you authorized in Plaid." closeDisabled={connect.isPending} onClose={dismissMapping} />
          <div className="bp-dialog-body">
            <p className="bp-dialog-copy">Uncheck any account already present in Weft; unchecked accounts will not be created here.</p>
            <p className="bp-note">{selectedCount} of {plaidAccounts.length} accounts selected for local creation.</p>
            <div className="bp-list">
              {plaidAccounts.map((plaidAccount) => (
                <div className={`bp-list-row bp-mapping-row${selectedAccounts[plaidAccount.id] ? '' : ' is-unselected'}`} key={plaidAccount.id}>
                  <label className="bp-check">
                    <input type="checkbox" aria-label={`Add ${plaidAccount.name} to Weft`} checked={Boolean(selectedAccounts[plaidAccount.id])} onChange={(event) => setSelectedAccounts((current) => ({ ...current, [plaidAccount.id]: event.target.checked }))} />
                    <span><strong>{plaidAccount.name}</strong><small>{institution || 'Connected bank'} · ••••{plaidAccount.mask}</small></span>
                  </label>
                  <div className="bp-field-grid">
                    <label className="bp-field">Local name<input className="bp-control" disabled={!selectedAccounts[plaidAccount.id]} aria-label={`Local name for ${plaidAccount.name}`} value={localAccounts[plaidAccount.id]?.name ?? ''} onChange={(event) => setLocalAccounts((current) => ({ ...current, [plaidAccount.id]: { ...current[plaidAccount.id], name: event.target.value } }))} /></label>
                    <label className="bp-field">Type<FilterSelect ariaLabel={`Type for ${plaidAccount.name}`} autoFocus={false} disabled={!selectedAccounts[plaidAccount.id]} value={localAccounts[plaidAccount.id]?.type ?? 'checking'} options={ACCOUNT_TYPES.map((type) => ({ value: type, label: accountTypeLabel(type) }))} onChange={(value) => setLocalAccounts((current) => ({ ...current, [plaidAccount.id]: { ...current[plaidAccount.id], type: value as AccountType } }))} /></label>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bp-dialog-footer">
            <Button size="lg" disabled={connect.isPending} onClick={dismissMapping}>Cancel</Button>
            <Button
              size="lg"
              variant="primary"
              busy={connect.isPending}
              disabled={!accountDetailsComplete}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? 'Connecting and syncing…' : 'Create accounts and sync'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

const BANK_STALE_MS = 24 * 60 * 60 * 1000

function syncTime(value: string | null) {
  return value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
}

function oldest(connections: PlaidConnectionFreshness[], field: 'bank_updated_at' | 'synced_at') {
  return connections.reduce<string | null | undefined>((found, connection) => {
    const value = connection[field]
    if (found === undefined) return value
    if (found === null || value === null) return null
    return new Date(value) < new Date(found) ? value : found
  }, undefined) ?? null
}

function SyncFreshness({ status, scopeAccountIds }: { status: PlaidStatus; scopeAccountIds: number[] }) {
  const inScope = status.connections.filter((connection) => connection.account_ids.some((id) => scopeAccountIds.includes(id)))
  const shown = inScope.length ? inScope : status.connections
  if (!shown.length) return <span className="bp-sync-time">Not synced yet</span>
  const bank = oldest(shown, 'bank_updated_at')
  const stale = bank !== null && Date.now() - new Date(bank).getTime() > BANK_STALE_MS
  const detail = status.connections.map((connection) => `${connection.institution}: Bank to Plaid sync ${syncTime(connection.bank_updated_at)}, Plaid to Weft sync ${syncTime(connection.synced_at)}${connection.health === 'needs_sign_in' ? '. Needs sign-in' : connection.health === 'failing' ? `. Plaid's last attempt failed ${syncTime(connection.bank_failed_at)}` : ''}`).join('\n')
  const staleClass = stale ? 'bp-sync-time-stale' : undefined
  return (
    <span className="bp-sync-time bp-sync-time--stacked" title={detail}>
      <span className={staleClass}>Bank to Plaid sync:</span><span className={staleClass}>{syncTime(bank)}</span>
      <span>Plaid to Weft sync:</span><span>{syncTime(oldest(shown, 'synced_at'))}</span>
    </span>
  )
}

export function PlaidSyncAction({ hasConnections, status, scopeAccountIds, onNotice }: { hasConnections: boolean; status?: PlaidStatus; scopeAccountIds: number[]; onNotice: (message: string) => void }) {
  const sync = usePlaidSync(onNotice)
  if (!hasConnections && !status?.bank_sync_paused) return null
  return <>{status?.bank_sync_paused ? <span className="bp-sync-time bp-sync-time--paused">Bank sync paused after restore — press Sync Plaid to resume.</span> : status ? <SyncFreshness status={status} scopeAccountIds={scopeAccountIds} /> : <span className="bp-sync-time">Not synced yet</span>}<Button size="md" variant="primary" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? 'Syncing…' : 'Sync Plaid'}</Button></>
}

export function RefreshBankDialog({ account, accounts, status, onClose, onNotice }: { account: Account; accounts: Account[]; status?: PlaidStatus; onClose: () => void; onNotice: (message: string) => void }) {
  const queryClient = useQueryClient()
  // Each confirmation may be billed, so it sends at most one request even on a fast double click.
  const sent = useRef(false)
  const connection = status?.connections.find((candidate) => candidate.account_ids.includes(account.id))
  const institution = connection?.institution ?? account.plaid_connection?.institution ?? 'this bank'
  const names = accounts.filter((candidate) => candidate.plaid_connection?.item_id === account.plaid_connection?.item_id).map((candidate) => candidate.name)
  const refresh = useMutation({
    mutationFn: () => apiClient.providerCommand<{ message: string }>(`/api/plaid/accounts/${account.id}/refresh`),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['plaid-status'] }) },
    onSuccess: (result) => { onNotice(result.message); onClose() },
    // Without a Weft answer the request may still have reached Plaid and counted toward usage.
    onError: (error) => { onNotice(error instanceof ApiError && (error.status < 500 || error.code.startsWith('plaid_refresh_')) ? error.message : `${institution}: Weft lost the answer to this refresh. It may still have reached Plaid and counted toward your plan's usage, so wait for the next sync instead of trying again.`); onClose() },
  })
  return <Modal size="sm" role="alertdialog" labelledBy="plaid-refresh-title" onRequestClose={() => { if (!refresh.isPending) onClose() }}>
    <DialogHeader titleId="plaid-refresh-title" title={`Refresh ${institution} from the bank?`} subtitle={`Updates ${names.join(', ')}.`} closeDisabled={refresh.isPending} onClose={onClose} />
    <div className="bp-dialog-body"><p className="bp-dialog-copy">Plaid contacts the bank now instead of waiting for its regular update. Refresh may count toward your Plaid plan's usage. Weft syncs again about 2 and 6 minutes later.</p></div>
    <div className="bp-dialog-footer"><Button size="lg" disabled={refresh.isPending} onClick={onClose}>Cancel</Button><Button size="lg" variant="primary" busy={refresh.isPending} disabled={refresh.isPending} onClick={() => { if (sent.current) return; sent.current = true; refresh.mutate() }}>{refresh.isPending ? 'Refreshing…' : 'Refresh'}</Button></div>
  </Modal>
}
