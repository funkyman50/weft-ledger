import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Lock, Pencil, X } from 'lucide-react'
import { usePlaidLink } from 'react-plaid-link'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { Switch } from '../../components/Switch'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import type { Account, AccountDeletionPreview, AccountClosePreview, AccountType, PlaidStatus } from '../../api/types'
import { accountTypeLabel, ACCOUNT_TYPES } from './accountTypes'
import { AccountIcon } from './AccountIcon'
import { AccountLogoPicker } from './AccountLogoPicker'
import { recordDiagnostic, recordPlaidLinkExit } from '../../lib/diagnostics'
import { isComposingKey } from '../../lib/keyboard'

function LockHint({ message }: { message: string }) {
  return <span className="bp-account-lock-hint" role="note" tabIndex={0} aria-label={message} data-tooltip={message}><Lock aria-hidden="true" /></span>
}

function AccountAction({ title, detail, danger = false, disabled, onClick }: { title: string; detail: string; danger?: boolean; disabled: boolean; onClick: () => void }) {
  return <button type="button" className={`bp-list-row${danger ? ' is-danger' : ''}`} disabled={disabled} onClick={onClick}><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight aria-hidden="true" /></button>
}

interface AccountDialogProps {
  account?: Account
  accounts: Account[]
  plaidStatus?: PlaidStatus
  onClose: () => void
  onCreated: (account: Account) => void
  onClosed: (account: Account) => void
  onReopened: (account: Account) => void
  onDeleted: (accountId: number) => void
  onLoanDetails: () => void
  onStartingBalance: () => void
  onConnectBank: () => void
}

export function AccountDialog({ account, accounts, plaidStatus, onClose, onCreated, onClosed, onReopened, onDeleted, onLoanDetails, onStartingBalance, onConnectBank }: AccountDialogProps) {
  const isCreate = !account
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState(account?.type ?? 'checking')
  const [draftLogoId, setDraftLogoId] = useState(account?.logo_id ?? null)
  const [groupName, setGroupName] = useState(account?.group_name ?? '')
  const [cashFlowChoice, setCashFlowChoice] = useState<boolean | null>(account?.cash_flow_reporting ?? null)
  const cashFlowReporting = cashFlowChoice ?? (type !== 'loan')
  const [netWorthReporting, setNetWorthReporting] = useState(account?.net_worth_reporting ?? true)
  const [logoPickerOpen, setLogoPickerOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const renameRef = useRef<HTMLButtonElement>(null)
  const returnToRename = useRef(false)
  const logoButtonRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [repairStage, setRepairStage] = useState<'idle' | 'link' | 'checking'>('idle')
  const [repairOutcome, setRepairOutcome] = useState<{ kind: 'success' } | { kind: 'issue'; message: string; guidance: string } | { kind: 'uncertain' } | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [localOnlyAvailable, setLocalOnlyAvailable] = useState(false)
  const repairBaseline = useRef<string | null>(null)
  const repairLinkSucceeded = useRef(false)
  const [confirmation, setConfirmation] = useState<{ kind: 'close' } | { kind: 'disconnect' } | { kind: 'delete' } | null>(null)
  const [closeAction, setCloseAction] = useState<'stay-connected' | 'disconnect' | null>(null)
  const [closePreview, setClosePreview] = useState<AccountClosePreview | null>(null)
  const [deletionPreview, setDeletionPreview] = useState<AccountDeletionPreview | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const closeCancelRef = useRef<HTMLButtonElement>(null)
  const deletionWarningRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: () => isCreate
      ? apiClient.post<Account>('/api/accounts', { name: name.trim(), type, logo_id: draftLogoId, group_name: groupName || null, cash_flow_reporting: cashFlowReporting, net_worth_reporting: netWorthReporting })
      : apiClient.patch<Account>(`/api/accounts/${account.id}`, { name: name.trim(), type, group_name: groupName || null, cash_flow_reporting: cashFlowReporting, net_worth_reporting: netWorthReporting, ...(draftLogoId !== account.logo_id ? { logo_id: draftLogoId } : {}) }),
  })
  const lifecycle = useMutation({
    mutationFn: ({ closed, disconnectBank = false, previewToken }: { closed: boolean; disconnectBank?: boolean; previewToken?: string }) => closed
      ? (disconnectBank ? apiClient.providerCommand : apiClient.post)<Account>(`/api/accounts/${account!.id}/close`, { disconnect_bank: disconnectBank, preview_token: previewToken })
      : apiClient.post<Account>(`/api/accounts/${account!.id}/reopen`),
  })
  const previewClose = useMutation({
    mutationFn: () => apiClient.get<AccountClosePreview>(`/api/accounts/${account!.id}/close-preview`),
  })
  const disconnect = useMutation({
    mutationFn: () => apiClient.providerCommand(`/api/accounts/${account!.id}/disconnect-bank`, { freeze_pending: true }),
    onSuccess: () => setLocalOnlyAvailable(false),
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === 'plaid_local_token_unreadable') setLocalOnlyAvailable(sharedAccounts.length === 0)
    },
  })
  const repairToken = useMutation({
    mutationFn: () => apiClient.providerCommand<{ link_token: string }>(`/api/plaid/accounts/${account!.id}/repair-link-token`),
    onSuccess: ({ link_token }) => {
      setError(null)
      setLocalOnlyAvailable(false)
      setRepairOutcome(null)
      setLinkToken(link_token)
      setRepairStage('link')
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === 'plaid_local_token_unreadable' && sharedAccounts.length > 0) {
        setLocalOnlyAvailable(false)
        setError('Weft could not read its saved bank authorization. Restore the original encryption secret to repair this shared connection.')
      } else {
        if (caught instanceof ApiError && caught.code === 'plaid_local_token_unreadable') setLocalOnlyAvailable(true)
        setError(apiErrorMessage(caught, 'Could not start bank connection repair.'))
      }
    },
  })
  const syncAfterRepair = useMutation({
    mutationFn: () => apiClient.providerCommand<PlaidStatus>('/api/plaid/sync'),
    onSuccess: (status) => queryClient.setQueryData<PlaidStatus>(['plaid-status'], status),
  })
  const localOnlyDisconnect = useMutation({
    mutationFn: () => apiClient.providerCommand(`/api/accounts/${account!.id}/disconnect-bank-locally`, { freeze_pending: true }),
  })
  const remove = useMutation({
    mutationFn: (previewToken: string) => apiClient.providerCommand(`/api/accounts/${account!.id}/delete`, { preview_token: previewToken }),
  })
  const previewDeletion = useMutation({
    mutationFn: () => apiClient.get<AccountDeletionPreview>(`/api/accounts/${account!.id}/deletion-preview`),
  })

  const pending = save.isPending || previewClose.isPending || lifecycle.isPending || disconnect.isPending || remove.isPending || previewDeletion.isPending || repairToken.isPending || repairStage !== 'idle' || localOnlyDisconnect.isPending
  const trimmedName = name.trim()
  const duplicateName = useMemo(() => accounts.some((candidate) =>
    candidate.id !== account?.id && candidate.name.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
  ), [account?.id, accounts, trimmedName])
  const identityChanged = !isCreate && (trimmedName !== account.name || type !== account.type)
  const groupOptions = useMemo(() => {
    const names = new Map<string, string>()
    for (const candidate of accounts) {
      if (candidate.group_name) names.set(candidate.group_name.toLocaleLowerCase(), candidate.group_name)
    }
    if (groupName) names.set(groupName.toLocaleLowerCase(), groupName)
    return [{ value: '', label: 'No group' }, ...Array.from(names.values()).sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }))]
  }, [accounts, groupName])
  const fieldsChanged = identityChanged || draftLogoId !== (account?.logo_id ?? null)
    || groupName !== (account?.group_name ?? '') || cashFlowReporting !== account?.cash_flow_reporting
    || netWorthReporting !== account?.net_worth_reporting
  const canSave = Boolean(trimmedName) && !duplicateName && (isCreate || fieldsChanged) && !pending
  const connection = account?.plaid_connection
  const sharedAccounts = connection
    ? accounts.filter((candidate) => candidate.id !== account?.id && candidate.plaid_connection?.item_id === connection.item_id)
    : []
  const repairableIssue = account && plaidStatus?.errors.find((issue) =>
    (issue.kind === 'login_required' || issue.kind === 'missing_account') && issue.account_ids.includes(account.id))
  const typeLocked = !isCreate && account.type_change_locked
  const canRunLifecycle = !pending && !fieldsChanged && !confirmation
  const canSubmitClose = !pending && !fieldsChanged && (!confirmation || confirmation.kind === 'close')
  const confirmingDelete = confirmation?.kind === 'delete'
  const confirmingClose = confirmation?.kind === 'close'
  const showNameInput = isCreate || editingName || !trimmedName || duplicateName
  const repairOffered = Boolean(connection && repairableIssue)
  const sharedAccountNames = sharedAccounts.map((shared) => shared.name).join(', ')
  const accountStatus = isCreate
    ? { tone: 'manual', title: 'Manual account', detail: 'You can connect this account to a bank later from its settings without replacing its history.' }
    : repairOffered
      ? { tone: 'repair', title: 'Bank connection needs repair', detail: `${sharedAccounts.length ? `Also affects ${sharedAccountNames}.` : 'No other Weft accounts share this connection.'} Existing account history stays in place.` }
      : account.closed
        ? { tone: 'closed', title: 'Closed account', detail: `${connection ? `Still connected to ${connection.institution || 'Plaid'}. ` : ''}Reopen returns it to the active account rail.` }
        : connection
          ? { tone: 'connected', title: `Connected to ${connection.institution || 'Plaid'}`, detail: `Connection …${connection.plaid_account_id.slice(-6)}${account.plaid_balance_updated_at ? ` · Balance updated ${new Date(account.plaid_balance_updated_at).toLocaleString()}` : ''}` }
          : { tone: 'manual', title: 'Manual account', detail: 'No bank connection.' }

  useEffect(() => {
    if (editingName) {
      nameRef.current?.focus()
      nameRef.current?.select()
    } else if (returnToRename.current) {
      returnToRename.current = false
      renameRef.current?.focus()
    }
  }, [editingName])

  const beginRepair = () => {
    if (!account || !canRunLifecycle || !connection || !repairableIssue) return
    repairLinkSucceeded.current = false
    repairBaseline.current = account.plaid_balance_updated_at
    setError(null)
    setLocalOnlyAvailable(false)
    setRepairOutcome(null)
    repairToken.mutate()
  }

  const cancelRepairOpening = () => {
    if (repairStage !== 'link') return
    repairLinkSucceeded.current = false
    setLinkToken(null)
    setRepairStage('idle')
  }

  const checkRepair = async () => {
    if (!account) return
    try {
      const status = await syncAfterRepair.mutateAsync()
      await Promise.all([
        invalidateAccounts(),
        queryClient.invalidateQueries({ queryKey: ['plaid-status'] }),
      ])
      const issue = status.errors.find((candidate) => candidate.kind !== 'transaction_warning' && candidate.account_ids.includes(account.id))
      if (issue) {
        const missingAccountNames = issue.missing_account_ids
          .map((missingId) => accounts.find((candidate) => candidate.id === missingId)?.name)
          .filter((missingName): missingName is string => Boolean(missingName))
        const missingAccounts = missingAccountNames.length ? missingAccountNames.join(', ') : 'the missing account(s) named above'
        const guidance = issue.kind === 'rule_evaluation'
          ? 'Open Payees and correct the rule described above, then retry sync.'
          : issue.kind === 'login_required'
          ? 'Restore this bank’s access in Plaid, then retry. Other Weft accounts sharing this connection also pause until access is restored.'
          : issue.kind === 'missing_account'
            ? issue.missing_account_ids.includes(account.id)
              ? `Restore access for ${missingAccounts} in Plaid. If ${account.name} cannot be restored, you can disconnect this account; any other missing accounts must also be restored or disconnected before the shared connection can resume.`
              : `Restore access for ${missingAccounts} in Plaid. ${account.name} is not one of the missing accounts; this account and its other Weft siblings pause until access is restored for the missing account(s).`
            : issue.kind === 'temporary'
              ? 'The bank or Plaid service may be temporarily unavailable. Retry when service is available.'
              : 'This connection may not be repairable in place. Review the message above before taking action.'
        setRepairOutcome({ kind: 'issue', message: issue.message, guidance })
      } else {
        const refreshedAccount = queryClient.getQueryData<Account[]>(['accounts'])?.find((candidate) => candidate.id === account.id)
        if (refreshedAccount?.plaid_balance_updated_at && refreshedAccount.plaid_balance_updated_at !== repairBaseline.current) {
          setRepairOutcome({ kind: 'success' })
        } else {
          setRepairOutcome({ kind: 'uncertain' })
        }
      }
    } catch {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['plaid-status'] }),
      ])
      setRepairOutcome({ kind: 'uncertain' })
    } finally {
      setRepairStage('idle')
    }
  }

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => {
      recordDiagnostic('plaid.link_repair_succeeded', 'info')
      repairLinkSucceeded.current = true
      setLinkToken(null)
      setRepairStage('checking')
      void checkRepair()
    },
    onExit: (plaidError) => {
      if (repairLinkSucceeded.current) return
      recordPlaidLinkExit(plaidError)
      setLinkToken(null)
      setRepairStage('idle')
      if (plaidError) setError(plaidError.display_message || plaidError.error_message || 'Plaid Link closed with an error.')
    },
  })

  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, open, ready])

  const recoverLocalOnly = async () => {
    if (!account || pending || fieldsChanged) return
    setError(null)
    try {
      await localOnlyDisconnect.mutateAsync()
      await invalidateAccounts(true)
      setLocalOnlyAvailable(false)
      setConfirmation(null)
    } catch (caught) {
      setError(apiErrorMessage(caught, 'Could not remove the local bank connection.'))
    }
  }

  const invalidateAccounts = async (includePlaid = false) => {
    await Promise.all([
      invalidateAccountAndTransactionQueries(queryClient),
      ...(includePlaid ? [queryClient.invalidateQueries({ queryKey: ['plaid-status'] })] : []),
    ])
  }

  const submit = async () => {
    if (!trimmedName) {
      setError('Account name is required.')
      return
    }
    if (duplicateName) {
      setError('An account with this name already exists.')
      return
    }
    setError(null)
    try {
      const updated = await save.mutateAsync()
      await invalidateAccounts()
      if (isCreate) onCreated(updated)
      onClose()
    } catch (saveError) {
      setError(apiErrorMessage(saveError, 'Could not save the account.'))
    }
  }

  const changeClosed = async (closed: boolean, disconnectBank = false, previewToken = closePreview?.preview_token) => {
    if (!account || (closed ? !canSubmitClose : !canRunLifecycle)) return
    setError(null)
    try {
      const updated = await lifecycle.mutateAsync({ closed, disconnectBank, previewToken })
      await invalidateAccounts(disconnectBank)
      if (closed) onClosed(updated)
      else onReopened(updated)
      onClose()
    } catch (lifecycleError) {
      if (disconnectBank && lifecycleError instanceof ApiError && lifecycleError.code === 'plaid_local_token_unreadable' && sharedAccounts.length === 0) {
        setConfirmation(null)
        setError('Weft could not read its saved bank authorization. Remove the local connection only, then close this account.')
        setLocalOnlyAvailable(true)
      } else {
        setError(apiErrorMessage(lifecycleError, 'Could not update the account.'))
      }
    }
  }

  const beginClose = async () => {
    setError(null)
    try {
      const preview = await previewClose.mutateAsync()
      if (!connection && preview.schedules.length === 0) {
        await changeClosed(true, false, preview.preview_token)
      } else {
        setClosePreview(preview)
        setConfirmation({ kind: 'close' })
      }
    } catch (caught) { setError(apiErrorMessage(caught, 'Could not load the close preview.')) }
  }

  const confirmClose = async (disconnectBank: boolean) => {
    setCloseAction(disconnectBank ? 'disconnect' : 'stay-connected')
    try {
      await changeClosed(true, disconnectBank)
    } finally {
      setCloseAction(null)
    }
  }

  const confirmDisconnect = async () => {
    setError(null)
    setLocalOnlyAvailable(false)
    try {
      await disconnect.mutateAsync()
      await invalidateAccounts(true)
      setConfirmation(null)
    } catch (disconnectError) {
      setError(apiErrorMessage(disconnectError, 'Could not disconnect this bank account.'))
    }
  }

  const loadDeletionPreview = async () => {
    setError(null)
    setDeletionPreview(null)
    setConfirmation({ kind: 'delete' })
    try {
      setDeletionPreview(await previewDeletion.mutateAsync())
    } catch (previewError) {
      setConfirmation(null)
      setError(apiErrorMessage(previewError, 'Could not prepare account deletion.'))
    }
  }

  const confirmDelete = async () => {
    if (!deletionPreview) return
    setError(null)
    try {
      await remove.mutateAsync(deletionPreview.preview_token)
      await invalidateAccounts(true)
      onDeleted(account!.id)
      onClose()
    } catch (deleteError) {
      if (deleteError instanceof ApiError && deleteError.code === 'account_deletion_preview_stale') {
        setError('This account changed. Review the refreshed deletion consequences before confirming.')
        try {
          setDeletionPreview(await previewDeletion.mutateAsync())
        } catch (previewError) {
          setDeletionPreview(null)
          setError(apiErrorMessage(previewError, 'Could not refresh the deletion preview.'))
        }
        return
      }
      setError(apiErrorMessage(deleteError, 'Could not delete the account.'))
    }
  }

  const closeSafely = () => {
    if (!pending && !confirmation) onClose()
  }

  const cancelDelete = () => {
    setConfirmation(null)
    setDeletionPreview(null)
  }

  const deletionConsequences = deletionPreview && <>
    {deletionPreview.rules.length > 0 && <><p>These account-specific rules will be deleted:</p><ul>{deletionPreview.rules.map((rule) => <li key={rule.id}>Rule {rule.position} · {rule.payee_name}</li>)}</ul></>}
    {deletionPreview.schedules.length > 0 && <><p>These schedules will be deleted:</p><ul>{deletionPreview.schedules.map((schedule) => <li key={schedule.id}>{schedule.account_name} · {schedule.payee_name ?? (schedule.memo || 'Scheduled transaction')} · {schedule.next_date}</li>)}</ul></>}
    <p>This permanently removes {deletionPreview.removed_transaction_count} {deletionPreview.removed_transaction_count === 1 ? 'transaction' : 'transactions'} from this account, including any imported history.</p>
    {deletionPreview.surviving_transfer_transaction_count > 0 && <p>{deletionPreview.surviving_transfer_transaction_count} {deletionPreview.surviving_transfer_transaction_count === 1 ? 'transaction' : 'transactions'} in other accounts will remain and use the external transfer payee and keep their categories.</p>}
    {deletionPreview.plaid_item_effect === 'revoked' && <p>This is the last local account on its bank connection, so Weft will revoke that bank connection.</p>}
    {deletionPreview.plaid_item_effect === 'kept_shared' && <p>Other local accounts still use this bank connection, so their bank feed will continue.</p>}
    {deletionPreview.plaid_item_effect === 'none' && <p>This account has no active bank connection to revoke.</p>}
  </>

  const errorCallout = error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>

  return (
    <>
    <Modal inactive={logoPickerOpen} size="md" role={confirmingDelete || confirmingClose ? 'alertdialog' : 'dialog'} labelledBy={confirmingDelete ? 'account-delete-title' : confirmingClose ? 'account-close-title' : 'account-dialog-title'} initialFocusRef={confirmingDelete ? deletionWarningRef : confirmingClose ? closeCancelRef : isCreate ? nameRef : renameRef} onRequestClose={closeSafely}>
      {confirmingClose || confirmingDelete ? <DialogHeader
        titleId={confirmingClose ? 'account-close-title' : 'account-dialog-title'}
        title={confirmingClose ? `Close ${account!.name}?` : account!.name}
        subtitle={confirmingClose ? connection ? 'Choose what happens to this account’s bank connection.' : 'Review schedules that will pause.' : 'Focused changes for one account at a time.'}
        closeDisabled={pending || Boolean(confirmation)}
        onClose={closeSafely}
      /> : <div className="bp-dialog-header bp-account-dialog-header">
        <button ref={logoButtonRef} type="button" className="bp-account-logo-button" aria-label="Choose logo" title="Choose logo" disabled={pending || Boolean(confirmation)} onClick={() => setLogoPickerOpen(true)}>
          <AccountIcon account={{ name, type, plaid_connection: account?.plaid_connection ?? null, logo_id: draftLogoId }} />
          <span className="bp-account-logo-badge" aria-hidden="true"><Pencil /></span>
        </button>
        <div className="bp-dialog-heading bp-account-dialog-name">
          <h2 id="account-dialog-title" className={showNameInput ? 'bp-visually-hidden' : 'bp-dialog-title'}>{isCreate ? 'Create an account' : trimmedName}</h2>
          {showNameInput
            ? <input ref={nameRef} className="bp-control bp-account-name-input" type="text" aria-label="Account name" placeholder="Account name" value={name} disabled={pending} onChange={(event) => { setName(event.target.value); setError(null) }} onBlur={() => setEditingName(false)} onKeyDown={(event) => {
              if (event.key !== 'Enter' || isCreate || !trimmedName || duplicateName || isComposingKey(event.nativeEvent) || event.repeat) return
              event.preventDefault()
              returnToRename.current = true
              setEditingName(false)
            }} />
            : <Button ref={renameRef} size="md" variant="quiet" iconOnly aria-label="Rename account" disabled={pending || Boolean(confirmation)} onClick={() => setEditingName(true)}><Pencil aria-hidden="true" /></Button>}
        </div>
        <div className="bp-dialog-header-actions">
          <Button size="lg" variant="quiet" iconOnly aria-label="Close" disabled={pending || Boolean(confirmation)} onClick={closeSafely}><X aria-hidden="true" /></Button>
        </div>
      </div>}

      {confirmingClose ? (
        <>
          <div className="bp-dialog-body">
            <p className="bp-dialog-copy">Closing keeps this account and its transaction history available in the closed-account rail.</p>
            {closePreview && closePreview.schedules.length > 0 && <div className="bp-callout bp-callout--warning"><strong>These schedules will pause</strong><ul>{closePreview.schedules.map((schedule) => <li key={schedule.id}>{schedule.account_name} · {schedule.payee_name ?? (schedule.memo || 'Scheduled transaction')} · {schedule.next_date}</li>)}</ul><p>Reopening skips missed occurrences.</p></div>}
            {connection && <div className="bp-callout bp-callout--info">
              <strong>Close and stay connected</strong>
              <p>Future bank refreshes, balances, and pending activity continue for this closed account.</p>
            </div>}
            {connection && <div className="bp-callout bp-callout--danger">
              <strong>Close and disconnect</strong>
              <p>Future bank imports stop. Pending bank activity freezes locally as Uncleared, or Cleared when you had manually cleared it.{sharedAccounts.length ? ` Other local accounts sharing this connection will keep bank access: ${sharedAccounts.map((shared) => shared.name).join(', ')}.` : ''}</p>
            </div>}
            {errorCallout}
          </div>
          <div className="bp-dialog-footer">
            <Button ref={closeCancelRef} size="lg" disabled={pending} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button size="lg" busy={closeAction === 'stay-connected' && lifecycle.isPending} disabled={pending} onClick={() => void confirmClose(false)}>{closeAction === 'stay-connected' && lifecycle.isPending ? 'Closing and staying connected…' : connection ? 'Close and stay connected' : 'Close account'}</Button>
            {connection && <Button size="lg" variant="danger" busy={closeAction === 'disconnect' && lifecycle.isPending} disabled={pending} onClick={() => void confirmClose(true)}>{closeAction === 'disconnect' && lifecycle.isPending ? 'Closing and disconnecting…' : 'Close and disconnect'}</Button>}
          </div>
        </>
      ) : confirmingDelete ? (
        <>
          <div className="bp-dialog-body">
            <div ref={deletionWarningRef} className="bp-callout bp-callout--danger" role="alert" tabIndex={-1}>
              <strong id="account-delete-title">Delete {account!.name}?</strong>
              {previewDeletion.isPending ? <p>Reviewing deletion consequences…</p> : deletionConsequences}
            </div>
            {errorCallout}
          </div>
          <div className="bp-dialog-footer">
            <Button size="lg" disabled={pending} onClick={cancelDelete}>Cancel</Button>
            <Button size="lg" variant="danger" busy={remove.isPending} disabled={pending || !deletionPreview} onClick={confirmDelete}>{remove.isPending ? 'Deleting…' : 'Delete account'}</Button>
          </div>
        </>
      ) : (
        <>
          <div className="bp-dialog-body">
            <div className={`bp-account-status is-${accountStatus.tone}`}>
              <div><strong>{accountStatus.title}</strong><small>{accountStatus.detail}</small></div>
              {repairOffered
                ? <Button size="lg" disabled={pending || !canRunLifecycle} onClick={beginRepair}>{repairToken.isPending ? 'Opening Plaid…' : repairStage === 'checking' ? 'Checking…' : 'Repair connection'}</Button>
                : account?.closed && <Button size="lg" disabled={!canRunLifecycle} onClick={() => void changeClosed(false)}>Reopen account</Button>}
            </div>
            {repairStage === 'link' && <div className="bp-account-settings-row"><small>Plaid is opening. Repairing this connection updates access for the accounts named above.</small><Button size="md" variant="quiet" onClick={cancelRepairOpening}>Cancel opening</Button></div>}
            {repairStage === 'checking' && <div className="bp-callout bp-callout--info" role="status">Checking your connection…</div>}
            {repairOutcome?.kind === 'success' && <div className="bp-callout bp-callout--info" role="status">Connection repaired. This account’s bank balance was refreshed successfully.</div>}
            {repairOutcome?.kind === 'issue' && <div className="bp-callout bp-callout--warning" role="alert"><strong>{repairOutcome.message}</strong><p>{repairOutcome.guidance}</p>{repairableIssue && <div className="bp-callout-actions"><Button size="md" disabled={pending || !canRunLifecycle} onClick={beginRepair}>Retry repair</Button></div>}</div>}
            {repairOutcome?.kind === 'uncertain' && <div className="bp-callout bp-callout--warning" role="status"><strong>Could not confirm this account’s connection.</strong><p>The sync did not update this account’s bank balance, and no issue specific to this account was reported. Check the next refresh for a connection issue.</p></div>}

            <div className="bp-field-grid bp-field-grid--even">
              <label className="bp-field">Account group
                <FilterSelect ariaLabel="Account group" autoFocus={false} searchable allowCreate value={groupName} options={groupOptions} disabled={pending} onChange={(value) => { setGroupName(value); setError(null) }} />
              </label>
              <label className="bp-field">Account type
                <div className="bp-account-type-control">
                  <FilterSelect ariaLabel="Account type" autoFocus={false} value={type} disabled={pending || typeLocked} options={ACCOUNT_TYPES.map((option) => ({ value: option, label: accountTypeLabel(option) }))} onChange={(value) => { setType(value as AccountType); setError(null) }} />
                  {typeLocked && <LockHint message="Type cannot change while this account has history, a bank connection or loan details." />}
                </div>
              </label>
            </div>

            <div className="bp-dialog-section">
              <div className="bp-dialog-section-heading"><strong>Reports</strong><small>Defaults for future reports. Reporting is not available yet.</small></div>
              <div className="bp-account-reporting-defaults">
                <Switch label="Cash flow reporting" showLabel checked={cashFlowReporting} disabled={pending} onChange={setCashFlowChoice} />
                <Switch label="Net worth reporting" showLabel checked={netWorthReporting} disabled={pending} onChange={setNetWorthReporting} />
              </div>
            </div>

            {!isCreate && <div className="bp-dialog-section">
              <div className="bp-dialog-section-heading"><strong>Account actions</strong></div>
              <div className="bp-list bp-account-actions">
                {account.type === 'loan' && <AccountAction title="Loan details" detail="Set the loan kind and escrow used to resolve bank differences." disabled={!canRunLifecycle} onClick={onLoanDetails} />}
                {!connection && !account.closed && <AccountAction title="Connect this account" detail="Download bank history into a review before attaching an active feed." disabled={!canRunLifecycle} onClick={onConnectBank} />}
                {connection && account.starting_balance_initialized_at !== null && <AccountAction title="Re-init starting balance" detail="Correct the opening balance only when the saved baseline is wrong." disabled={!canRunLifecycle} onClick={onStartingBalance} />}
                {connection && <AccountAction title="Disconnect bank" detail="Stop future imports. Account history stays in place." disabled={!canRunLifecycle} onClick={() => setConfirmation({ kind: 'disconnect' })} />}
                {!account.closed && <AccountAction title="Close account" detail="Remove it from the active rail while preserving its history." disabled={!canRunLifecycle} onClick={() => void beginClose()} />}
                {account.closed && repairOffered && <AccountAction title="Reopen account" detail="Return it to the active account rail." disabled={!canRunLifecycle} onClick={() => void changeClosed(false)} />}
                <AccountAction title="Delete account" detail="Review what will be removed before you confirm." danger disabled={!canRunLifecycle} onClick={() => void loadDeletionPreview()} />
              </div>
              {confirmation?.kind === 'disconnect' && (
                <div className="bp-callout bp-callout--danger" role="alert">
                  <strong>Disconnect this bank account?</strong>
                  <p>Imported transactions keep their Plaid source and bank identity. Future imports stop and live bank balances disappear. An automatic icon uses the account name; a selected icon stays. Pending bank activity freezes locally as Uncleared, or Cleared when you had manually cleared it. Standalone frozen rows can be cleared locally or excluded and restored; they cannot be deleted.{sharedAccounts.length ? ` Other local accounts sharing this connection will keep bank access: ${sharedAccountNames}.` : ''}</p>
                  <div className="bp-callout-actions">
                    <Button size="md" disabled={pending} onClick={() => setConfirmation(null)}>Cancel</Button>
                    <Button size="md" variant="danger" busy={disconnect.isPending} disabled={pending} onClick={() => confirmDisconnect()}>{disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}</Button>
                  </div>
                </div>
              )}
              {localOnlyAvailable && sharedAccounts.length === 0 && <div className="bp-callout bp-callout--warning" role="alert">
                <strong>Weft could not read its saved bank authorization.</strong>
                <p>Removing the local connection will preserve this account’s history, but it will not revoke access at your bank. Revoke the connection with your bank first, then remove the local connection and close this account.</p>
                <div className="bp-callout-actions"><Button size="md" variant="danger" busy={localOnlyDisconnect.isPending} disabled={pending || fieldsChanged} onClick={() => void recoverLocalOnly()}>{localOnlyDisconnect.isPending ? 'Removing local connection…' : 'Remove local connection only'}</Button></div>
              </div>}
            </div>}
            {errorCallout}
          </div>
          <div className="bp-dialog-footer">
            <Button size="lg" disabled={pending || Boolean(confirmation)} onClick={closeSafely}>Cancel</Button>
            <Button size="lg" variant="primary" busy={save.isPending} disabled={!canSave || Boolean(confirmation)} onClick={submit}>{save.isPending ? 'Saving…' : isCreate ? 'Create account' : 'Save changes'}</Button>
          </div>
        </>
      )}
    </Modal>
    {logoPickerOpen && <AccountLogoPicker account={{ name, type, plaid_connection: account?.plaid_connection ?? null, logo_id: draftLogoId }} selectedId={draftLogoId} onRemoved={(id) => { if (draftLogoId === id) setDraftLogoId(null) }} returnFocusRef={logoButtonRef} onClose={() => setLogoPickerOpen(false)} onSelect={(id) => { setDraftLogoId(id); setLogoPickerOpen(false) }} />}
    </>
  )
}
