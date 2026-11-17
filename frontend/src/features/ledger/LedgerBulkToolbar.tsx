import { isCombinedScope, type AccountScope } from '../../lib/accountScope'
import { useEffect, useRef } from 'react'
import { Link2, RefreshCw, Save, X } from 'lucide-react'

import type { Account, CategoryTree, Payee } from '../../api/types'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { ledgerPayeeOptions } from './payeeCategory'
import { LedgerTransferPicker } from './LedgerEditors'
import { BulkMetadataFields, BulkResetButton, LedgerBulkControls, STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { TransactionFlagPicker } from './TransactionFlagPicker'
import { type useBulkApply } from './useBulkApply'

type BulkState = ReturnType<typeof useBulkApply>

const labels: Record<string, string> = {
  payee_id: 'Payee',
  transfer_account_id: 'Transfer',
  category_id: 'Category',
  memo: 'Memo',
  flag: 'Flag',
  approved: 'Review',
  clearance: 'Clearance',
  manual_clearance: 'Manual clearance',
}

export function LedgerBulkToolbar({
  bulk,
  payees,
  accounts,
  categories,
  selectedCount,
  accountId,
  openTransferAccountIds,
  canMatch,
  onMatch,
  onClose,
  onExpandSelection,
  canExpandSelection,
  selectionPhase,
  matchingCount,
  onRetrySelection,
  onStartTransferQueue,
  usesPlaidWorkflow,
}: {
  bulk: BulkState
  payees: Payee[]
  accounts: Account[]
  categories: CategoryTree[]
  selectedCount: number
  accountId: AccountScope
  openTransferAccountIds: number[]
  canMatch: boolean
  onMatch: () => void
  onClose: () => void
  onExpandSelection: () => void
  canExpandSelection: boolean
  selectionPhase: 'idle' | 'expanding' | 'reconciling' | 'failed'
  matchingCount: number
  onRetrySelection: () => void
  onStartTransferQueue: () => void
  usesPlaidWorkflow: boolean
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const wasConfirmingRef = useRef(false)
  useEffect(() => {
    if (wasConfirmingRef.current && !bulk.confirmation) saveRef.current?.focus()
    wasConfirmingRef.current = bulk.confirmation !== null
  }, [bulk.confirmation])
  const unchanged = (field: keyof typeof bulk.changes) => ({
    unchanged: !(field in bulk.changes),
    unchangedLabel: 'Leave unchanged',
    triggerLabel: labels[field],
    onReset: () => bulk.reset(field),
  })
  const disabled = bulk.frozen || bulk.outcomeUnknown
  const transferMode = bulk.transferMode
  const reset = (field: keyof typeof bulk.changes) => (
    <BulkResetButton label={labels[field]} staged={field in bulk.changes} disabled={disabled} onReset={() => bulk.reset(field)} />
  )
  const approved = bulk.changes.approved
  const clearance = bulk.changes.clearance
  const clearanceEligible = bulk.selectionReady && bulk.fieldEligible('clearance')
  const showClearance = isCombinedScope(accountId) || !usesPlaidWorkflow || clearanceEligible || clearance !== undefined
  const manualClearance = bulk.changes.manual_clearance
  const manualClearanceEligible = bulk.selectionReady && bulk.fieldEligible('manual_clearance')
  const showManualClearance = usesPlaidWorkflow && (manualClearanceEligible || manualClearance !== undefined)
  const manuallyCleared = manualClearance ?? bulk.allManuallyCleared
  const manualClearanceAction = manuallyCleared ? 'Undo manual clear for selected' : 'Mark selected cleared manually'
  const nextReview = approved === undefined ? true : approved ? false : undefined
  const reviewLabel = approved === undefined ? 'Review unchanged' : approved ? 'Reviewed' : 'Needs review'
  const reviewControl = transferMode
    ? <button className="bp-review-button is-reviewed" type="button" disabled aria-label="Review: Reviewed on transfer confirmation" title="Each confirmed transfer item is marked Reviewed.">R</button>
    : <button className={`bp-review-button ${approved === true ? 'is-reviewed' : approved === false ? 'needs-review' : 'is-unchanged'}`} type="button" disabled={disabled || !bulk.fieldEligible('approved')} aria-label={`Stage review: ${reviewLabel}; next ${nextReview === undefined ? 'leave unchanged' : nextReview ? 'reviewed' : 'needs review'}`} title={!bulk.fieldEligible('approved') ? 'Review is unavailable for one or more selected transactions.' : disabled ? STAGED_CHANGES_NOTICE : 'Stage review state'} onClick={() => nextReview === undefined ? bulk.reset('approved') : bulk.stage('approved', nextReview)}>R</button>
  const clearanceControl = <button className={`bp-clearance-button${clearance === 'cleared' ? ' is-cleared' : ''}`} type="button" disabled={disabled || !clearanceEligible || transferMode} aria-label={`Stage clearance: ${clearance ?? 'unchanged'}`} title={transferMode ? 'Clearance is unavailable during transfer review.' : !clearanceEligible ? 'Clearance is unavailable for one or more selected transactions.' : disabled ? STAGED_CHANGES_NOTICE : 'Stage clearance state'} onClick={() => clearance === undefined ? bulk.stage('clearance', 'cleared') : clearance === 'cleared' ? bulk.stage('clearance', 'uncleared') : bulk.reset('clearance')}>C</button>

  return (
    <LedgerBulkControls count={selectedCount} totalCount={matchingCount} label={selectedCount < 2 ? 'Selected transaction actions' : transferMode ? 'Review transfers for selected transactions' : 'Apply changes to selected transactions'}>
      {selectedCount > 1 && <div className="bp-bulk-fields">
        <span className="bp-bulk-field" title={'flag' in bulk.changes && bulk.changes.flag === null ? 'Clear flag staged' : undefined}>
          <TransactionFlagPicker
            value={bulk.changes.flag ?? null}
            disabled={disabled || !bulk.fieldEligible('flag')}
            staging={unchanged('flag')}
            onChange={(flag) => bulk.stage('flag', flag)}
          />
          {reset('flag')}
        </span>
        <BulkMetadataFields changes={bulk.changes} payeeOptions={ledgerPayeeOptions(payees, null)} categories={categories} sessionId="bulk" disabled={disabled} fieldEligible={bulk.fieldEligible}
          onPayeeChange={(value) => bulk.stage('payee_id', value)}
          onCategoryChange={(value) => bulk.stage('category_id', value)}
          onMemoChange={(value) => bulk.stage('memo', value)}
          onReset={bulk.reset}
          payeeCompanion={<LedgerTransferPicker ariaLabel="Bulk transfer" sessionId="bulk" value={bulk.changes.transfer_account_id ?? null} accounts={accounts.filter((account) => openTransferAccountIds.includes(account.id))} disabled={disabled || !bulk.fieldEligible('transfer_account_id')} staging={unchanged('transfer_account_id')} onChange={(value) => bulk.stage('transfer_account_id', value)} />}
        />
        <span className="bp-bulk-field">
          {showClearance && clearanceControl}
          {reviewControl}
        </span>
        {showManualClearance && <span className="bp-bulk-field">
          <button className={`bp-review-button ${manuallyCleared ? 'is-reviewed' : 'is-unchanged'}`} type="button" disabled={disabled || !manualClearanceEligible || transferMode} aria-label="Manually clear selected transactions" aria-pressed={manuallyCleared} title={transferMode ? 'Manual clearance is unavailable during transfer review.' : !manualClearanceEligible ? 'Manual clearance is unavailable for one or more selected transactions. Remove them or reset Manual clearance.' : `${manualClearanceAction}. Save applies the staged changes.`} onClick={() => bulk.stage('manual_clearance', !manuallyCleared)}><span>C<span className="bp-manual-clear-asterisk">*</span></span></button>
          {reset('manual_clearance')}
        </span>}
      </div>}
      <div className="bp-button-group bp-bulk-actions">
        {(selectedCount > 1 || bulk.hasStagedChanges || bulk.outcomeUnknown) && <Button ref={saveRef} size="md" variant="primary" title={transferMode ? 'Review and save selected transfers' : 'Save changes to every selected transaction'} disabled={disabled || !bulk.selectionReady || !bulk.hasStagedChanges || bulk.blockedFields.length > 0 || (transferMode && !bulk.transferEligible)} onClick={() => void (transferMode ? onStartTransferQueue() : bulk.save())}><Save aria-hidden="true" />{transferMode ? 'Review transfers' : 'Save'}</Button>}
        {canMatch && <Button size="md" disabled={bulk.hasStagedChanges || disabled} title="Compare the selected pair for matching" onClick={onMatch}><Link2 aria-hidden="true" />Match</Button>}
        {bulk.outcomeUnknown && <Button size="md" onClick={() => void bulk.refreshUnknown()}><RefreshCw aria-hidden="true" />Refresh</Button>}
        {selectionPhase === 'failed' && <Button size="md" onClick={onRetrySelection}><RefreshCw aria-hidden="true" />Refresh selection</Button>}
        {canExpandSelection && <Button size="md" disabled={selectionPhase !== 'idle'} busy={selectionPhase === 'expanding'} onClick={onExpandSelection}>{selectionPhase === 'expanding' ? 'Selecting all…' : `Select All ${matchingCount}`}</Button>}
        <Button size="md" disabled={bulk.phase === 'submitting'} title="Discard staged changes and clear the selection" onClick={onClose}><X aria-hidden="true" />Cancel</Button>
      </div>
      {bulk.blockedFields.length > 0 && <p className="bp-bulk-message">Remove an ineligible row or reset {bulk.blockedFields.map((field) => labels[field]).join(', ')} before saving.</p>}
      {bulk.error && <p className="bp-bulk-message" role="alert">{bulk.error}</p>}
      {bulk.confirmation && <Modal size="sm" role="alertdialog" labelledBy="bulk-memo-confirm-title" initialFocusRef={cancelRef} onRequestClose={() => { if (bulk.phase !== 'submitting') bulk.cancelConfirmation() }}>
        <DialogHeader titleId="bulk-memo-confirm-title" title={bulk.confirmation.overwriteCount > 0 ? 'Replace existing memos?' : 'Confirm bulk changes'} subtitle={bulk.confirmation.overwriteCount > 0 ? `${bulk.confirmation.overwriteCount} of ${bulk.confirmation.payload.targets.length} selected transaction${bulk.confirmation.payload.targets.length === 1 ? '' : 's'} already have memos.` : `${bulk.confirmation.payload.targets.length} selected transactions will change.`} closeDisabled={bulk.phase === 'submitting'} onClose={bulk.cancelConfirmation} />
        <div className="bp-dialog-body">{bulk.error ? <div className="bp-callout bp-callout--error" role="alert">{bulk.error}</div> : <>{bulk.confirmation.overwriteCount > 0 && <p className="bp-dialog-copy">Applying will overwrite them.</p>}{bulk.confirmation.historyWarning && <div className="bp-callout bp-callout--warning">{bulk.confirmation.historyWarning}</div>}</>}</div>
        <div className="bp-dialog-footer"><Button ref={cancelRef} size="lg" disabled={bulk.phase === 'submitting'} onClick={bulk.cancelConfirmation}>Cancel</Button><Button size="lg" variant="danger" busy={bulk.phase === 'submitting'} onClick={() => void bulk.confirm()}>{bulk.phase === 'submitting' ? 'Applying…' : bulk.confirmation.overwriteCount > 0 ? 'Replace and apply' : 'Apply changes'}</Button></div>
      </Modal>}
    </LedgerBulkControls>
  )
}
