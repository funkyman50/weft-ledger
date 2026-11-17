import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlaidLinkLauncher, type PlaidLinkHandlers } from './PlaidLinkLauncher'
import { ApiError, apiClient } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import type { AccountType, PlaidStatus } from '../../api/types'
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

export function PlaidSyncAction({ hasConnections, status, onNotice }: { hasConnections: boolean; status?: PlaidStatus; onNotice: (message: string) => void }) {
  const sync = usePlaidSync(onNotice)
  if (!hasConnections && !status?.bank_sync_paused) return null
  return <><span className={`bp-sync-time${status?.bank_sync_paused ? ' bp-sync-time--paused' : ''}`}>{status?.bank_sync_paused ? 'Bank sync paused after restore — press Sync Plaid to resume.' : status?.last_sync ? `Last synced ${new Date(status.last_sync).toLocaleString()}` : 'Not synced yet'}</span><Button size="md" variant="primary" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? 'Syncing…' : 'Sync Plaid'}</Button></>
}
