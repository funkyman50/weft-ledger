import { isCombinedScope, type AccountScope } from '../../lib/accountScope'
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '../../components/Button'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { DialogHeader } from '../../components/DialogHeader'
import { STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { apiClient, ApiError } from '../../api/client'
import type { AllowedAction, Account, LedgerBulkChanges, LedgerHistoryPreview, LedgerRow, LedgerTarget } from '../../api/types'
import { money } from '../../lib/money'
import { matchReviewMode } from './rowPermissions'

type Dialog = 'move' | 'delete' | 'exclude' | 'restore' | null

const busyLabels: Record<NonNullable<Dialog>, string> = { move: 'Moving…', delete: 'Deleting…', exclude: 'Excluding…', restore: 'Restoring…' }

function targets(rows: LedgerRow[]): LedgerTarget[] { return rows.map((row) => ({ id: row.id, edit_token: row.edit_token })) }
function label(rows: LedgerRow[], accounts: Account[]): string {
  if (rows.length !== 1) {
    const account = accounts.find((candidate) => rows.every((row) => row.account_id === candidate.id))
    return account ? `${rows.length} transactions in ${account.name}` : `${rows.length} transactions`
  }
  const row = rows[0]
  return `${new Date(`${row.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${row.payee_name?.trim() || row.description.trim() || 'Untitled transaction'} · ${money(row.amount_cents)}`
}

function BalancePreview({ rows, accounts, restoring }: { rows: LedgerRow[]; accounts: Account[]; restoring: boolean }) {
  const direction = restoring ? 1 : -1
  const rowsByAccount = new Map<number, LedgerRow[]>()
  for (const row of rows) rowsByAccount.set(row.account_id, [...(rowsByAccount.get(row.account_id) ?? []), row])
  return <>{[...rowsByAccount].flatMap(([accountId, accountRows]) => {
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account || account.cleared_balance_cents === null || account.working_balance_cents === null) return []
    const workingDelta = direction * accountRows.reduce((sum, row) => sum + row.amount_cents, 0)
    const clearedDelta = direction * accountRows.filter((row) => row.status === 'cleared' || row.status === 'reconciled').reduce((sum, row) => sum + row.amount_cents, 0)
    const clearedAfter = account.cleared_balance_cents + clearedDelta
    const workingAfter = account.working_balance_cents + workingDelta
    const reported = account.plaid_current_balance_cents
    const difference = reported === null ? null : clearedAfter - reported
    const currentDifference = reported === null ? null : account.cleared_balance_cents - reported
    return <Fragment key={account.id}><p className="bp-dialog-copy">{rowsByAccount.size > 1 ? `${account.name} · ` : ''}Cleared: {money(account.cleared_balance_cents)} → {money(clearedAfter)} · Working: {money(account.working_balance_cents)} → {money(workingAfter)}</p>
      {difference === 0 ? <p className="bp-note">This will bring Cleared in line with the bank-reported balance.</p> : difference !== null ? currentDifference !== null && Math.abs(difference) > Math.abs(currentDifference) ? <div className="bp-callout bp-callout--warning">Bank-reported balance {money(reported ?? 0)}; resulting Cleared difference {money(difference)}.</div> : <p className="bp-note">Bank-reported balance {money(reported ?? 0)}; resulting Cleared difference {money(difference)}.</p> : null}</Fragment>
  })}</>
}

export function LedgerContextMenu({
  rows, accounts, accountId, anchor, changes, expandedSelection, onDismiss, onFocusRow, onDuplicate, onMakeRecurring, onStage, onMove, onDelete, onExclude, onRestore, onClearance, onReview, onManualClearance, stateCommandsBlocked, relationshipCommandsBlocked, onOpenMatch, onResolveLifecycle, onInspectConnections, onFindMatch, onMatchPair, onFindTransfer, onGoToTransfer, onError,
}: {
  rows: LedgerRow[]
  accounts: Account[]
  accountId: AccountScope
  anchor: { left: number; top: number }
  changes: LedgerBulkChanges
  expandedSelection: boolean
  onDismiss: () => void
  onFocusRow: () => void
  onDuplicate: (row: LedgerRow) => void
  onMakeRecurring: (row: LedgerRow) => void
  onStage: (field: 'approved' | 'clearance' | 'manual_clearance', value: boolean | 'cleared' | 'uncleared') => void
  onMove: (targets: LedgerTarget[], destinationAccountId: number) => Promise<unknown>
  onDelete: (targets: LedgerTarget[]) => Promise<unknown>
  onExclude: (target: LedgerTarget) => Promise<unknown>
  onRestore: (targets: LedgerTarget[]) => Promise<unknown>
  onClearance: (row: LedgerRow) => Promise<void>
  onReview: (id: number, approved: boolean) => Promise<void>
  onManualClearance: (row: LedgerRow, intent: 'clear' | 'undo') => Promise<void>
  stateCommandsBlocked: boolean
  relationshipCommandsBlocked: boolean
  onOpenMatch: (row: LedgerRow) => void
  onResolveLifecycle: (row: LedgerRow) => void
  onInspectConnections: (row: LedgerRow) => void
  onFindMatch: (row: LedgerRow) => void
  onMatchPair: (rows: LedgerRow[]) => void
  onFindTransfer: (rows: LedgerRow[]) => void
  onGoToTransfer: (row: LedgerRow) => void
  onError: (message: string) => void
}) {
  const menuId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(true)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [destinationId, setDestinationId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<{ pending: boolean; warning: string | null; error: string | null }>({ pending: false, warning: null, error: null })
  const single = rows.length === 1 ? rows[0] : null
  const matchPair = rows.length === 2 && rows.some((row) => row.match_role === 'feed') && rows.some((row) => row.match_role === 'history') && rows[0].account_id === rows[1].account_id && rows[0].amount_cents === rows[1].amount_cents && rows.every((row) => row.allowed_actions.includes('find_match'))
  const allAllow = (action: AllowedAction) => rows.length > 0 && rows.every((row) => row.allowed_actions.includes(action))
  const applicable = (action: AllowedAction) => rows.some((row) => row.allowed_actions.includes(action) || row.disabled_actions[action])
  const destinations = useMemo(() => accounts.filter((account) => !account.closed && !rows.some((row) => row.account_id === account.id)), [accounts, rows])
  const pureExcluded = rows.length > 0 && rows.every((row) => row.excluded)
  const mixedExcluded = rows.some((row) => row.excluded) && rows.some((row) => !row.excluded)
  const staged = Object.keys(changes).length > 0
  const stageState = rows.length > 1 || staged
  const allManualClearanceTrue = rows.length > 0 && rows.every((row) => (changes.manual_clearance ?? row.manually_cleared) === true)
  const allManualClearanceFalse = rows.length > 0 && rows.every((row) => (changes.manual_clearance ?? row.manually_cleared) === false)
  const allApprovedTrue = rows.length > 0 && rows.every((row) => (changes.approved ?? row.approved) === true)
  const allApprovedFalse = rows.length > 0 && rows.every((row) => (changes.approved ?? row.approved) === false)
  const allCleared = rows.length > 0 && rows.every((row) => (changes.clearance ?? row.status) === 'cleared')
  const allUncleared = rows.length > 0 && rows.every((row) => (changes.clearance ?? row.status) === 'uncleared')
  const workflowBlocked = staged ? STAGED_CHANGES_NOTICE : undefined
  const dialogBlocked = workflowBlocked ?? (stateCommandsBlocked ? 'Finish or cancel the active ledger work first.' : undefined)
  const unavailableReason = (action: AllowedAction, name: string) => {
    if (mixedExcluded) return "Active and excluded transactions can't be changed together"
    if (allAllow(action)) return undefined
    const blocked = rows.filter((row) => !row.allowed_actions.includes(action))
    const reason = blocked[0]?.disabled_actions[action]
    if (reason && blocked.every((row) => row.disabled_actions[action] === reason)) return reason
    return `${name} is unavailable for ${single ? 'this transaction.' : 'one or more selected transactions.'}`
  }
  const commandReason = (action: AllowedAction, name: string) => dialogBlocked ?? unavailableReason(action, name)
  const stateCommandReason = (action: AllowedAction, noOp: boolean, noOpReason: string, name: string) => {
    return unavailableReason(action, name) ?? (stateCommandsBlocked ? 'Finish or cancel the active ledger work first.' : undefined) ?? (noOp ? noOpReason : undefined)
  }
  const closeMenu = (fn: () => void) => { onFocusRow(); onDismiss(); fn() }
  const openDialog = (next: Dialog) => { onFocusRow(); setMenuOpen(false); setDialog(next) }
  const run = async (fn: () => Promise<unknown>) => {
    if (pending || dialogBlocked) return
    setPending(true)
    try { await fn(); onDismiss() } catch (error) { onError(error instanceof Error ? error.message : 'The transaction action could not be completed.') } finally { setPending(false) }
  }
  const total = rows.reduce((sum, row) => sum + row.amount_cents, 0)
  const splitParents = rows.filter((row) => row.allocations.length > 0).length
  const linkedTransfers = rows.filter((row) => row.transfer?.state === 'linked').length
  const reviewItems = <><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('review') || allApprovedTrue} title={stateCommandReason('review', allApprovedTrue, changes.approved !== undefined ? 'All selected transactions are already staged as reviewed.' : 'All selected transactions are already reviewed.', 'Review')} onClick={() => closeMenu(() => onStage('approved', true))}>Mark selected reviewed</ActionMenuItem><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('review') || allApprovedFalse} title={stateCommandReason('review', allApprovedFalse, changes.approved !== undefined ? 'All selected transactions are already staged as needing review.' : 'All selected transactions already need review.', 'Review')} onClick={() => closeMenu(() => onStage('approved', false))}>Mark selected needs review</ActionMenuItem></>
  const clearanceItems = <><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('clearance') || allCleared} title={stateCommandReason('clearance', allCleared, changes.clearance !== undefined ? 'All selected transactions are already staged as cleared.' : 'All selected transactions are already cleared.', 'Clearance')} onClick={() => closeMenu(() => onStage('clearance', 'cleared'))}>Mark selected cleared</ActionMenuItem><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('clearance') || allUncleared} title={stateCommandReason('clearance', allUncleared, changes.clearance !== undefined ? 'All selected transactions are already staged as uncleared.' : 'All selected transactions are already uncleared.', 'Clearance')} onClick={() => closeMenu(() => onStage('clearance', 'uncleared'))}>Mark selected uncleared</ActionMenuItem></>

  useEffect(() => { setDestinationId((current) => current ?? destinations[0]?.id ?? null) }, [destinations])
  useEffect(() => {
    if (!expandedSelection || (dialog !== 'move' && dialog !== 'delete')) {
      setPreview({ pending: false, warning: null, error: null })
      return
    }
    const controller = new AbortController()
    setPreview({ pending: true, warning: null, error: null })
    void apiClient.postQuery<LedgerHistoryPreview>('/api/transactions/history-preview', { targets: targets(rows) }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPreview({ pending: false, warning: result.warning, error: null }) })
      .catch((error) => { if (!controller.signal.aborted) setPreview({ pending: false, warning: null, error: error instanceof ApiError ? error.message : 'The action could not be prepared.' }) })
    return () => controller.abort()
  }, [dialog, expandedSelection, rows])

  const changeState = (action: () => Promise<void>, message: string) => closeMenu(() => { void action().catch((error) => onError(error instanceof Error ? error.message : message)) })
  const commandItem = (action: AllowedAction, name: string, text: string, onClick: () => void, extraReason?: string, danger = false) => {
    const reason = commandReason(action, name) ?? extraReason
    return <ActionMenuItem disabled={Boolean(reason)} title={reason} danger={danger} onClick={onClick}>{text}</ActionMenuItem>
  }
  const matchMode = single ? matchReviewMode(single) : null
  const relationshipReason = dialogBlocked ?? (relationshipCommandsBlocked ? 'Finish or cancel the active ledger work first.' : undefined)
  const menuGroups = [
    [
      !pureExcluded && stageState && (applicable('review') || changes.approved !== undefined) && reviewItems,
      !stageState && single && applicable('review') && commandItem('review', 'Review', single.approved ? 'Mark needs review' : 'Mark reviewed', () => changeState(() => onReview(single.id, !single.approved), 'Transaction review state could not be changed.')),
      !pureExcluded && stageState && (applicable('clearance') || changes.clearance !== undefined) && clearanceItems,
      !stageState && single && applicable('clearance') && commandItem('clearance', 'Clearance', single.status === 'cleared' || single.status === 'reconciled' ? 'Mark uncleared' : 'Mark cleared', () => changeState(() => onClearance(single), 'Transaction clearance could not be changed.')),
      !pureExcluded && stageState && (applicable('manual_clearance') || changes.manual_clearance !== undefined) && <><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('manual_clearance') || allManualClearanceTrue} title={stateCommandReason('manual_clearance', allManualClearanceTrue, changes.manual_clearance !== undefined ? 'All selected transactions are already staged as manually cleared.' : 'All selected transactions are already manually cleared.', 'Manual clearance')} onClick={() => closeMenu(() => onStage('manual_clearance', true))}>Mark selected cleared manually</ActionMenuItem><ActionMenuItem disabled={stateCommandsBlocked || !allAllow('manual_clearance') || allManualClearanceFalse} title={stateCommandReason('manual_clearance', allManualClearanceFalse, changes.manual_clearance !== undefined ? 'All selected transactions are already staged to undo manual clear.' : 'None of the selected transactions are manually cleared.', 'Manual clearance')} onClick={() => closeMenu(() => onStage('manual_clearance', false))}>Undo manual clear for selected</ActionMenuItem></>,
      !stageState && single && applicable('manual_clearance') && commandItem('manual_clearance', 'Manual clearance', single.manually_cleared ? 'Undo manual clear' : 'Mark cleared manually', () => changeState(() => onManualClearance(single, single.manually_cleared ? 'undo' : 'clear'), 'Manual clearance could not be saved.')),
    ],
    [
      single && applicable('pending_lifecycle') && commandItem('pending_lifecycle', 'Pending resolution', 'Resolve pending transaction…', () => closeMenu(() => onResolveLifecycle(single)), relationshipReason),
      single && matchMode === 'suggested' && <ActionMenuItem key="suggested-match" disabled={Boolean(relationshipReason)} title={relationshipReason} onClick={() => closeMenu(() => onOpenMatch(single))}>Review possible match…</ActionMenuItem>,
      single && applicable('inspect_connections') && commandItem('inspect_connections', 'Connection inspection', 'Inspect connections…', () => closeMenu(() => onInspectConnections(single)), relationshipReason),
      single && applicable('find_match') && commandItem('find_match', 'Find match', 'Find match…', () => closeMenu(() => onFindMatch(single))),
      matchPair && <ActionMenuItem key="match-pair" disabled={Boolean(dialogBlocked)} title={dialogBlocked} onClick={() => closeMenu(() => onMatchPair(rows))}>Match transactions…</ActionMenuItem>,
      applicable('find_transfer') && commandItem('find_transfer', 'Find transfer', 'Find transfer…', () => closeMenu(() => onFindTransfer(rows))),
      single && applicable('go_to_transfer') && commandItem('go_to_transfer', 'Transfer navigation', isCombinedScope(accountId) ? 'Go to linked transaction' : 'Go to other account', () => closeMenu(() => onGoToTransfer(single))),
    ],
    [
      single && applicable('duplicate') && commandItem('duplicate', 'Duplicate', 'Duplicate transaction', () => closeMenu(() => onDuplicate(single))),
      single && applicable('make_recurring') && commandItem('make_recurring', 'Make recurring', 'Make recurring…', () => closeMenu(() => onMakeRecurring(single))),
    ],
    [
      applicable('move') && commandItem('move', 'Move', 'Move to account…', () => openDialog('move'), destinations.length ? undefined : 'There are no other open accounts.'),
      applicable('delete') && commandItem('delete', 'Delete', rows.length === 1 ? 'Delete transaction…' : `Delete ${rows.length} transactions…`, () => openDialog('delete'), undefined, true),
      single && applicable('exclude') && commandItem('exclude', 'Exclude', 'Exclude transaction…', () => openDialog('exclude')),
      applicable('restore') && commandItem('restore', 'Restore', rows.length === 1 ? 'Restore transaction…' : `Restore ${rows.length} transactions…`, () => openDialog('restore')),
    ],
  ].map((group) => group.filter(Boolean)).filter((group) => group.length > 0)

  return <>
    <span ref={anchorRef} className="bp-context-anchor" style={{ left: anchor.left, top: anchor.top }} aria-hidden="true" />
    {menuOpen && <ActionMenu anchorRef={anchorRef} menuRef={menuRef} id={menuId} width={228} aria-label="Transaction actions" onDismiss={(reason) => {
      if (reason !== 'outside') onFocusRow()
      onDismiss()
    }}>
      {menuGroups.length ? menuGroups.map((group, groupIndex) => <Fragment key={groupIndex}>{groupIndex > 0 && <div role="separator" />}{group.map((item, itemIndex) => <Fragment key={itemIndex}>{item}</Fragment>)}</Fragment>) : <ActionMenuItem disabled title={rows.length === 1 ? "This transaction has no available context-menu actions." : "These transactions have no available context-menu actions."} onClick={() => undefined}>No actions available</ActionMenuItem>}
    </ActionMenu>}
    {dialog && <Modal size="sm" role={dialog === 'delete' ? 'alertdialog' : 'dialog'} labelledBy="context-action-title" onRequestClose={() => { if (!pending) onDismiss() }}>
      <DialogHeader titleId="context-action-title" title={dialog === 'move' ? `Move ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}?` : dialog === 'delete' ? `Delete ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}?` : dialog === 'exclude' ? 'Exclude transaction?' : `Restore ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}?`} subtitle={label(rows, accounts)} closeDisabled={pending} onClose={onDismiss} />
      <div className="bp-dialog-body">{dialog === 'move' ? <label className="bp-field">Destination account<FilterSelect ariaLabel="Destination account" autoFocus={false} value={destinationId === null ? '' : String(destinationId)} disabled={pending || preview.pending} options={destinations.map((candidate) => ({ value: String(candidate.id), label: candidate.name }))} onChange={(value) => setDestinationId(Number(value))} /></label> : <>{dialog === 'delete' && <div className="bp-callout bp-callout--warning">{rows.length} transaction{rows.length === 1 ? '' : 's'} totaling {money(total)} will be deleted. {preview.warning ? preview.warning : 'You can Undo while this page\'s history remains available.'} {splitParents ? `${splitParents} complete split breakdown${splitParents === 1 ? ' is' : 's are'} included. ` : ''}{linkedTransfers ? `${linkedTransfers} transfer link${linkedTransfers === 1 ? '' : 's'} will be removed; ` : ''}opposite transactions remain.</div>}{dialog === 'exclude' && <><p className="bp-dialog-copy">This transaction keeps its bank identity, stops affecting Cleared and Working balances, and can be restored.</p><BalancePreview rows={rows} accounts={accounts} restoring={false} /></>}{dialog === 'restore' && <><p className="bp-dialog-copy">This restores {rows.length} transaction{rows.length === 1 ? '' : 's'} to active history and balances.</p><BalancePreview rows={rows} accounts={accounts} restoring /></>}</>}{dialogBlocked && <p className="bp-note" role="status">{dialogBlocked}</p>}{preview.pending && <p className="bp-note">Checking Undo availability…</p>}{preview.error && <div className="bp-callout bp-callout--error" role="alert">{preview.error}</div>}{dialog === 'move' && preview.warning && <div className="bp-callout bp-callout--warning">{preview.warning}</div>}</div>
      <div className="bp-dialog-footer"><Button size="lg" disabled={pending} onClick={onDismiss}>Cancel</Button><Button size="lg" variant={dialog === 'delete' ? 'danger' : 'primary'} busy={pending} disabled={Boolean(dialogBlocked) || (dialog === 'move' && destinationId === null) || preview.pending || preview.error !== null} onClick={() => void run(() => dialog === 'move' ? onMove(targets(rows), destinationId!) : dialog === 'delete' ? onDelete(targets(rows)) : dialog === 'exclude' ? onExclude(targets(rows)[0]) : onRestore(targets(rows)))}>{pending ? busyLabels[dialog] : dialog === 'move' ? `Move ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}` : dialog === 'delete' ? `Delete ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}` : dialog === 'exclude' ? 'Exclude transaction' : `Restore ${rows.length === 1 ? 'transaction' : `${rows.length} transactions`}`}</Button></div>
    </Modal>}
  </>
}
